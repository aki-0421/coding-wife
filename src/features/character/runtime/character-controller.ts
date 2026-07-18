import {
  CharacterError,
  type CharacterControllerStatus,
  type CharacterFallbackLevel,
  type CharacterFrameMetrics,
  type CharacterMotionPolicy,
  type CharacterPackRef,
  type CharacterRuntimeError,
  type CharacterState,
  toCharacterError,
} from "@/features/character/model"
import { CharacterPackClient } from "@/features/character/runtime/character-pack-client"
import { acquireCubismRuntime } from "@/features/character/runtime/cubism-runtime"
import {
  canConsumeCharacterFirstFrameDeadline,
  CharacterFirstFrameDeadline,
} from "@/features/character/runtime/first-frame-deadline"
import {
  resolveMotionPolicy,
  selectCharacterState,
  type CharacterStateCursor,
} from "@/features/character/runtime/motion-policy"

import type { CubismCharacterModel } from "./cubism-character-model"

const MAX_DEVICE_PIXEL_RATIO = 2
const MAX_FRAME_DELTA_SECONDS = 1 / 15
const FIRST_FRAME_TIMEOUT_MILLISECONDS = 3_000
const METRIC_SAMPLE_INTERVAL = 8

export interface CharacterControllerCallbacks {
  readonly onStatus?: (status: CharacterControllerStatus) => void
  readonly onMetrics?: (metrics: CharacterFrameMetrics) => void
  readonly onStaticPreview?: (dataUrl: string) => void
}

export interface CharacterControllerOptions {
  readonly callbacks?: CharacterControllerCallbacks
  readonly preserveDrawingBuffer?: boolean
}

export interface CharacterBackingSize {
  readonly width: number
  readonly height: number
  readonly devicePixelRatio: number
}

interface FirstFrameWait {
  generation: number
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: CharacterError) => void
  readonly signal: AbortSignal
  readonly onAbort: () => void
}

interface ContextRecoveryWait {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

interface CandidateRenderer {
  readonly generation: number
  readonly model: CubismCharacterModel
}

interface AcceptedCandidateFrame {
  readonly nonTransparentSamples: number
  readonly signature: string
  readonly webglError: number
  readonly capturedPreview: string | null
}

export function computeCharacterBackingSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): CharacterBackingSize {
  const safeRatio = Math.min(
    MAX_DEVICE_PIXEL_RATIO,
    Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1),
  )
  return {
    width: Math.max(1, Math.round(Math.max(0, cssWidth) * safeRatio)),
    height: Math.max(1, Math.round(Math.max(0, cssHeight) * safeRatio)),
    devicePixelRatio: safeRatio,
  }
}

function samplePixels(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  width: number,
  height: number,
): Readonly<{ nonTransparent: number; signature: string }> {
  const blockSize = Math.max(
    4,
    Math.min(32, Math.floor(Math.min(width, height) / 8)),
  )
  const points = [0.2, 0.5, 0.8]
  const pixels = new Uint8Array(blockSize * blockSize * 4)
  let nonTransparent = 0
  let hash = 2_166_136_261

  for (const normalizedY of points) {
    for (const normalizedX of points) {
      const x = Math.max(
        0,
        Math.min(
          width - blockSize,
          Math.round(width * normalizedX - blockSize / 2),
        ),
      )
      const y = Math.max(
        0,
        Math.min(
          height - blockSize,
          Math.round(height * normalizedY - blockSize / 2),
        ),
      )
      gl.readPixels(
        x,
        y,
        blockSize,
        blockSize,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      )
      for (let index = 0; index < pixels.length; index += 4) {
        if ((pixels[index + 3] ?? 0) > 0) nonTransparent++
        hash ^= pixels[index] ?? 0
        hash = Math.imul(hash, 16_777_619)
        hash ^= pixels[index + 1] ?? 0
        hash = Math.imul(hash, 16_777_619)
        hash ^= pixels[index + 2] ?? 0
        hash = Math.imul(hash, 16_777_619)
        hash ^= pixels[index + 3] ?? 0
        hash = Math.imul(hash, 16_777_619)
      }
    }
  }

  return {
    nonTransparent,
    signature: (hash >>> 0).toString(16).padStart(8, "0"),
  }
}

export class CharacterController {
  readonly #callbacks: CharacterControllerCallbacks
  readonly #preserveDrawingBuffer: boolean
  #canvas: HTMLCanvasElement | null = null
  #gl: WebGLRenderingContext | WebGL2RenderingContext | null = null
  #contextLossExtension: WEBGL_lose_context | null = null
  #model: CubismCharacterModel | null = null
  #client: CharacterPackClient | null = null
  #candidateRenderer: CandidateRenderer | null = null
  #loadAbortController: AbortController | null = null
  #restoreAbortController: AbortController | null = null
  #contextRecoveryWait: ContextRecoveryWait | null = null
  #frameRequest: number | null = null
  #lastFrameTimestamp: number | null = null
  readonly #firstFrameDeadline: CharacterFirstFrameDeadline
  #firstFrameWait: FirstFrameWait | null = null
  #rendererGeneration = 0
  #phase: CharacterControllerStatus["phase"] = "idle"
  #stateCursor: CharacterStateCursor = { state: "idle", generation: 0 }
  #requestedPolicy: CharacterMotionPolicy = "animated"
  #systemPrefersReducedMotion = false
  #documentVisible = true
  #fallbackLevel: CharacterFallbackLevel = "text_only"
  #error: CharacterRuntimeError | null = null
  #disposed = false
  #contextLost = false
  #restoreInFlight = false
  #restoreRequested = false
  #hasStaticPreview = false
  #frameCount = 0
  #nonTransparentSamples = 0
  #signature = "00000000"
  #signatureChanges = 0
  #lastDeltaMilliseconds = 0
  #webglError = 0
  #modelInventory: CharacterFrameMetrics["modelInventory"] = null
  #cssWidth = 1
  #cssHeight = 1

  readonly #handleVisibilityChange = () => {
    this.syncDocumentVisibility()
  }

  readonly #handleContextLost = (event: Event) => {
    event.preventDefault()
    this.enterContextLostState()
  }

  readonly #handleContextRestored = () => {
    if (!this.#contextLost || this.#disposed) return
    if (this.#restoreInFlight) {
      this.#restoreRequested = true
      return
    }
    this.#restoreRequested = false
    this.#restoreInFlight = true
    void this.rebuildAfterContextRestore().finally(() => {
      this.#restoreInFlight = false
      if (!this.#contextLost) {
        this.#restoreRequested = false
        this.completeContextRecovery()
      } else if (this.#restoreRequested) {
        this.#handleContextRestored()
      }
    })
  }

  public constructor(options: CharacterControllerOptions = {}) {
    this.#callbacks = options.callbacks ?? {}
    this.#preserveDrawingBuffer = options.preserveDrawingBuffer ?? false
    this.#firstFrameDeadline = new CharacterFirstFrameDeadline({
      timeoutMilliseconds: FIRST_FRAME_TIMEOUT_MILLISECONDS,
      onExpire: (generation) => {
        this.rejectFirstFrame(
          new CharacterError(
            "shader_load_failed",
            "Live2D did not produce a visible frame within 3 seconds of renderable desktop time",
          ),
          generation,
        )
      },
    })
  }

  public async mount(canvas: HTMLCanvasElement): Promise<void> {
    if (this.#disposed) {
      throw new CharacterError(
        "disposed",
        "Character controller is disposed",
        false,
      )
    }
    if (this.#canvas !== null && this.#canvas !== canvas) {
      throw new CharacterError(
        "webgl_unavailable",
        "A character controller can only own one canvas",
        false,
      )
    }

    this.#canvas = canvas
    const attributes: WebGLContextAttributes = {
      alpha: true,
      antialias: true,
      depth: false,
      failIfMajorPerformanceCaveat: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: this.#preserveDrawingBuffer,
      stencil: true,
    }
    this.#gl =
      canvas.getContext("webgl2", attributes) ??
      canvas.getContext("webgl", attributes)
    if (this.#gl === null) {
      this.#phase = "error"
      const error = new CharacterError(
        "webgl_unavailable",
        "This device could not create a WebGL context for Live2D",
        false,
      )
      this.#error = error
      this.emitStatus()
      throw error
    }
    this.#contextLossExtension = this.#gl.getExtension("WEBGL_lose_context")

    canvas.addEventListener("webglcontextlost", this.#handleContextLost)
    canvas.addEventListener("webglcontextrestored", this.#handleContextRestored)
    document.addEventListener("visibilitychange", this.#handleVisibilityChange)
    this.syncDocumentVisibility()

    const bounds = canvas.getBoundingClientRect()
    this.resize(bounds.width, bounds.height, window.devicePixelRatio)
    await acquireCubismRuntime()
  }

  public async loadPack(
    pack: CharacterPackRef,
    signal: AbortSignal,
    hasTrustedStaticPreview = false,
  ): Promise<void> {
    if (this.#canvas === null || this.#gl === null) {
      throw new CharacterError(
        "webgl_unavailable",
        "Mount the Live2D canvas before loading a pack",
        false,
      )
    }

    this.#loadAbortController?.abort()
    const loadAbortController = new AbortController()
    this.#loadAbortController = loadAbortController
    const abortFromCaller = () => loadAbortController.abort(signal.reason)
    signal.addEventListener("abort", abortFromCaller, { once: true })
    if (signal.aborted) abortFromCaller()

    const hadCommittedPack = this.#client !== null
    let committedModel: CubismCharacterModel | null = null

    let candidateModel: CubismCharacterModel | null = null

    try {
      await this.waitForContextRecovery(loadAbortController.signal)
      if (this.#contextLost) {
        throw new CharacterError(
          "context_restore_failed",
          "The Live2D WebGL context is not renderable",
          true,
        )
      }
      committedModel = this.#model
      this.stopFrameLoop()
      if (!hadCommittedPack) {
        this.#phase = "loading"
        this.#error = null
        this.emitStatus()
      }
      await acquireCubismRuntime()
      const client = await CharacterPackClient.load(
        pack,
        loadAbortController.signal,
      )
      const { CubismCharacterModel } = await import("./cubism-character-model")
      candidateModel = await CubismCharacterModel.create(
        client,
        this.#gl,
        this.#canvas.width,
        this.#canvas.height,
        loadAbortController.signal,
      )
      if (this.#disposed || loadAbortController.signal.aborted) {
        throw new CharacterError("disposed", "Character load was canceled")
      }

      const rendererGeneration = this.#rendererGeneration + 1
      candidateModel.resize(this.#canvas.width, this.#canvas.height)
      this.#candidateRenderer = {
        generation: rendererGeneration,
        model: candidateModel,
      }
      const acceptedFrame = await this.stageCandidateFirstFrame(
        candidateModel,
        committedModel,
        loadAbortController.signal,
        rendererGeneration,
        hasTrustedStaticPreview,
      )
      if (
        this.#disposed ||
        loadAbortController.signal.aborted ||
        this.#loadAbortController !== loadAbortController
      ) {
        throw new CharacterError("disposed", "Character load was canceled")
      }

      const previousModel = this.#model
      const committedCandidate = candidateModel
      candidateModel = null
      this.#candidateRenderer = null
      this.#rendererGeneration = rendererGeneration
      this.#model = committedCandidate
      this.#client = client
      this.#modelInventory = committedCandidate.inventory
      this.resetFrameMetrics()
      this.#frameCount = 1
      this.#nonTransparentSamples = acceptedFrame.nonTransparentSamples
      this.#signature = acceptedFrame.signature
      this.#webglError = acceptedFrame.webglError
      this.#hasStaticPreview =
        hasTrustedStaticPreview || acceptedFrame.capturedPreview !== null
      this.#phase = "ready"
      this.#error = null
      previousModel?.release()
      this.applyMotionPolicy()
      this.#callbacks.onMetrics?.(this.metrics)
      if (acceptedFrame.capturedPreview !== null) {
        this.#callbacks.onStaticPreview?.(acceptedFrame.capturedPreview)
      }
    } catch (error) {
      if (loadAbortController.signal.aborted || this.#disposed) throw error
      const characterError = toCharacterError(error, "asset_fetch_failed")
      if (!hadCommittedPack) {
        this.#hasStaticPreview = hasTrustedStaticPreview
        this.#phase = "error"
        this.#error = characterError
        this.#fallbackLevel = this.#hasStaticPreview ? "static" : "text_only"
        this.emitStatus()
      }
      throw characterError
    } finally {
      candidateModel?.release()
      if (this.#candidateRenderer?.model === candidateModel) {
        this.#candidateRenderer = null
      }
      signal.removeEventListener("abort", abortFromCaller)
      if (this.#loadAbortController === loadAbortController) {
        this.#loadAbortController = null
        if (
          hadCommittedPack &&
          this.#model === committedModel &&
          !this.#disposed &&
          !this.#contextLost &&
          this.effectiveMotionPolicy === "animated"
        ) {
          this.startFrameLoop()
        }
      }
    }
  }

  public setState(state: CharacterState, generation: number): void {
    this.#stateCursor = selectCharacterState(this.#stateCursor, {
      state,
      generation,
    })
    this.emitStatus()
  }

  public setMotionPolicy(policy: CharacterMotionPolicy): void {
    this.#requestedPolicy = policy
    this.applyMotionPolicy()
  }

  public setSystemPrefersReducedMotion(prefersReducedMotion: boolean): void {
    this.#systemPrefersReducedMotion = prefersReducedMotion
    this.applyMotionPolicy()
  }

  public syncDocumentVisibility(): void {
    const documentVisible = document.visibilityState === "visible"
    if (this.#documentVisible === documentVisible) return
    this.#documentVisible = documentVisible
    this.applyMotionPolicy()
  }

  public resize(
    cssWidth: number,
    cssHeight: number,
    devicePixelRatio: number,
  ): void {
    if (this.#canvas === null || this.#disposed) return
    this.#cssWidth = Math.max(0, cssWidth)
    this.#cssHeight = Math.max(0, cssHeight)
    const size = computeCharacterBackingSize(
      cssWidth,
      cssHeight,
      devicePixelRatio,
    )
    if (
      this.#canvas.width !== size.width ||
      this.#canvas.height !== size.height
    ) {
      this.#canvas.width = size.width
      this.#canvas.height = size.height
      this.#model?.resize(size.width, size.height)
      this.#candidateRenderer?.model.resize(size.width, size.height)
    }
    this.#gl?.viewport(0, 0, size.width, size.height)
    this.syncFirstFrameDeadline()
    if (this.#cssWidth <= 0 || this.#cssHeight <= 0) {
      this.stopFrameLoop()
      return
    }

    if (this.effectiveMotionPolicy === "reduced" && this.#model !== null) {
      this.drawFrame(null)
    } else if (this.effectiveMotionPolicy === "animated") {
      this.startFrameLoop()
    }
  }

  public get metrics(): CharacterFrameMetrics {
    return {
      frameCount: this.#frameCount,
      nonTransparentSamples: this.#nonTransparentSamples,
      signature: this.#signature,
      signatureChanges: this.#signatureChanges,
      backingWidth: this.#canvas?.width ?? 0,
      backingHeight: this.#canvas?.height ?? 0,
      lastDeltaMilliseconds: this.#lastDeltaMilliseconds,
      webglError: this.#webglError,
      modelInventory: this.#modelInventory,
    }
  }

  public loseContextForDiagnostics(): boolean {
    if (this.#contextLossExtension === null) return false
    this.#contextLossExtension.loseContext()
    return true
  }

  public restoreContextForDiagnostics(): boolean {
    if (this.#contextLossExtension === null) return false
    this.#contextLossExtension.restoreContext()
    return true
  }

  public dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#phase = "disposed"
    this.#loadAbortController?.abort()
    this.#loadAbortController = null
    this.#restoreAbortController?.abort()
    this.#restoreAbortController = null
    this.#restoreRequested = false
    this.completeContextRecovery()
    this.#candidateRenderer = null
    this.stopFrameLoop()
    this.rejectFirstFrame(
      new CharacterError(
        "disposed",
        "Character controller was disposed",
        false,
      ),
      this.#firstFrameWait?.generation,
    )
    document.removeEventListener(
      "visibilitychange",
      this.#handleVisibilityChange,
    )
    if (this.#canvas !== null) {
      this.#canvas.removeEventListener(
        "webglcontextlost",
        this.#handleContextLost,
      )
      this.#canvas.removeEventListener(
        "webglcontextrestored",
        this.#handleContextRestored,
      )
    }
    this.#model?.release()
    this.#model = null
    this.#modelInventory = null
    this.#client = null
    this.emitStatus()
    this.#canvas = null
    this.#gl = null
    this.#contextLossExtension = null
  }

  private get effectiveMotionPolicy(): CharacterMotionPolicy {
    return resolveMotionPolicy(
      this.#requestedPolicy,
      this.#systemPrefersReducedMotion,
      this.#documentVisible,
    )
  }

  private applyMotionPolicy(): void {
    if (this.#canvas === null || this.#disposed) return
    const policy = this.effectiveMotionPolicy
    if (policy === "hidden") {
      this.#canvas.hidden = true
      this.stopFrameLoop()
      this.#fallbackLevel = "text_only"
    } else if (policy === "reduced") {
      this.#canvas.hidden = false
      this.stopFrameLoop()
      this.#lastFrameTimestamp = null
      this.#model?.resetToNeutral()
      this.#fallbackLevel = "reduced"
      if (this.#model !== null) this.startFrameLoop()
    } else {
      this.#canvas.hidden = false
      this.#fallbackLevel = "animated"
      this.startFrameLoop()
    }
    this.syncFirstFrameDeadline()
    this.emitStatus()
  }

  private startFrameLoop(): void {
    if (
      this.#frameRequest !== null ||
      this.#model === null ||
      this.#candidateRenderer !== null ||
      this.#contextLost ||
      this.#disposed ||
      this.#cssWidth <= 0 ||
      this.#cssHeight <= 0
    ) {
      return
    }
    this.#lastFrameTimestamp = null
    this.#frameRequest = requestAnimationFrame(this.drawFrame)
  }

  private stopFrameLoop(): void {
    if (this.#frameRequest !== null) cancelAnimationFrame(this.#frameRequest)
    this.#frameRequest = null
    this.#lastFrameTimestamp = null
  }

  readonly drawFrame = (timestamp: number | null) => {
    this.#frameRequest = null
    if (
      this.#model === null ||
      this.#gl === null ||
      this.#canvas === null ||
      this.#contextLost ||
      this.#disposed ||
      this.#cssWidth <= 0 ||
      this.#cssHeight <= 0
    ) {
      return
    }

    const policy = this.effectiveMotionPolicy
    const rawDelta =
      timestamp === null || this.#lastFrameTimestamp === null
        ? 0
        : Math.max(0, (timestamp - this.#lastFrameTimestamp) / 1_000)
    const delta = Math.min(MAX_FRAME_DELTA_SECONDS, rawDelta)
    this.#lastDeltaMilliseconds = delta * 1_000
    this.#lastFrameTimestamp = timestamp

    try {
      this.#webglError = this.drawModelFrame(
        this.#model,
        policy === "animated" ? delta : 0,
      )
    } catch (error) {
      if (this.#gl.isContextLost()) {
        this.enterContextLostState()
        return
      }
      const characterError = toCharacterError(error, "shader_load_failed")
      this.stopFrameLoop()
      this.#error = characterError
      this.#phase = "error"
      this.#fallbackLevel = this.#hasStaticPreview ? "static" : "text_only"
      this.rejectFirstFrame(characterError, this.#rendererGeneration)
      this.emitStatus()
      return
    }
    this.#frameCount++

    const shouldSample =
      this.#nonTransparentSamples === 0 ||
      this.#frameCount % METRIC_SAMPLE_INTERVAL === 0
    if (shouldSample) {
      const sample = samplePixels(
        this.#gl,
        this.#canvas.width,
        this.#canvas.height,
      )
      if (
        this.#nonTransparentSamples > 0 &&
        sample.nonTransparent > 0 &&
        sample.signature !== this.#signature
      ) {
        this.#signatureChanges++
      }
      this.#nonTransparentSamples = sample.nonTransparent
      this.#signature = sample.signature
      this.#callbacks.onMetrics?.(this.metrics)

      if (sample.nonTransparent > 0) {
        this.resolveFirstFrame(this.#rendererGeneration)
        if (!this.#hasStaticPreview) {
          try {
            const dataUrl = this.#canvas.toDataURL("image/png")
            if (dataUrl.startsWith("data:image/png")) {
              this.#hasStaticPreview = true
              this.#callbacks.onStaticPreview?.(dataUrl)
            }
          } catch {
            // A captured frame is an optional fallback; text remains authoritative.
          }
        }
      }
    }

    if (policy === "animated" || this.#nonTransparentSamples === 0) {
      this.#frameRequest = requestAnimationFrame(this.drawFrame)
    } else {
      this.#lastFrameTimestamp = null
    }
  }

  private drawModelFrame(
    model: CubismCharacterModel,
    deltaSeconds: number,
  ): number {
    if (this.#gl === null || this.#canvas === null) {
      throw new CharacterError(
        "webgl_unavailable",
        "The character render surface is unavailable",
        false,
      )
    }
    if (deltaSeconds > 0) model.update(deltaSeconds)
    this.#gl.disable(this.#gl.SCISSOR_TEST)
    this.#gl.colorMask(true, true, true, true)
    this.#gl.clearColor(0, 0, 0, 0)
    this.#gl.clear(this.#gl.COLOR_BUFFER_BIT | this.#gl.STENCIL_BUFFER_BIT)
    this.#gl.viewport(0, 0, this.#canvas.width, this.#canvas.height)
    model.draw(this.#canvas.width, this.#canvas.height)
    this.#gl.flush()
    return this.#gl.getError()
  }

  private async stageCandidateFirstFrame(
    candidateModel: CubismCharacterModel,
    committedModel: CubismCharacterModel | null,
    signal: AbortSignal,
    generation: number,
    hasTrustedStaticPreview: boolean,
  ): Promise<AcceptedCandidateFrame> {
    const firstFrame = this.waitForFirstFrame(signal, generation)
    let frameRequest: number | null
    let lastTimestamp: number | null = null
    let accepted: AcceptedCandidateFrame | null = null

    const restoreCommittedFrame = (): void => {
      if (committedModel !== null) this.drawModelFrame(committedModel, 0)
    }
    const rejectCandidate = (error: unknown): void => {
      let characterError = toCharacterError(error, "shader_load_failed")
      try {
        restoreCommittedFrame()
      } catch (restoreError) {
        characterError = toCharacterError(restoreError, "shader_load_failed")
      }
      this.rejectFirstFrame(characterError, generation)
    }
    const drawCandidate = (timestamp: number) => {
      frameRequest = null
      if (
        signal.aborted ||
        this.#disposed ||
        this.#firstFrameWait?.generation !== generation
      ) {
        return
      }
      const policy = this.effectiveMotionPolicy
      const gl = this.#gl
      const canvas = this.#canvas
      const renderable =
        policy !== "hidden" &&
        this.#documentVisible &&
        !this.#contextLost &&
        this.#cssWidth > 0 &&
        this.#cssHeight > 0 &&
        gl !== null &&
        canvas !== null
      if (renderable) {
        const rawDelta =
          lastTimestamp === null
            ? 0
            : Math.max(0, (timestamp - lastTimestamp) / 1_000)
        const delta = Math.min(MAX_FRAME_DELTA_SECONDS, rawDelta)
        lastTimestamp = timestamp
        try {
          const webglError = this.drawModelFrame(
            candidateModel,
            policy === "animated" ? delta : 0,
          )
          if (webglError !== 0) {
            throw new CharacterError(
              "shader_load_failed",
              "The candidate renderer reported a WebGL error before its first frame",
            )
          }
          const sample = samplePixels(gl, canvas.width, canvas.height)
          if (sample.nonTransparent > 0) {
            let capturedPreview: string | null = null
            if (!hasTrustedStaticPreview) {
              try {
                const dataUrl = canvas.toDataURL("image/png")
                if (dataUrl.startsWith("data:image/png")) {
                  capturedPreview = dataUrl
                }
              } catch {
                // The accepted renderer remains authoritative without a capture.
              }
            }
            accepted = {
              nonTransparentSamples: sample.nonTransparent,
              signature: sample.signature,
              webglError,
              capturedPreview,
            }
            this.resolveFirstFrame(generation)
            return
          }
          restoreCommittedFrame()
        } catch (error) {
          rejectCandidate(error)
          return
        }
      }
      frameRequest = requestAnimationFrame(drawCandidate)
    }

    frameRequest = requestAnimationFrame(drawCandidate)
    try {
      await firstFrame
      if (accepted === null) {
        throw new CharacterError(
          "shader_load_failed",
          "The candidate first-frame result was not retained",
        )
      }
      return accepted
    } finally {
      if (frameRequest !== null) cancelAnimationFrame(frameRequest)
    }
  }

  private waitForFirstFrame(
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    const existingWait = this.#firstFrameWait
    if (existingWait?.generation === generation) {
      this.syncFirstFrameDeadline()
      return existingWait.promise
    }
    this.rejectFirstFrame(
      new CharacterError(
        "shader_load_failed",
        "A newer character load replaced the first-frame wait",
      ),
      existingWait?.generation,
    )

    let resolvePromise: () => void = () => undefined
    let rejectPromise: (error: CharacterError) => void = () => undefined
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const onAbort = () => {
      const activeWait = this.#firstFrameWait
      if (activeWait?.promise === promise) {
        this.rejectFirstFrame(
          new CharacterError(
            "disposed",
            "Character first-frame wait was canceled",
          ),
          activeWait.generation,
        )
      }
    }
    this.#firstFrameWait = {
      generation,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      signal,
      onAbort,
    }
    signal.addEventListener("abort", onAbort, { once: true })
    this.#firstFrameDeadline.begin(generation)
    if (signal.aborted) onAbort()
    else this.syncFirstFrameDeadline()
    return promise
  }

  private resolveFirstFrame(generation: number): void {
    const wait = this.#firstFrameWait
    if (wait === null || wait.generation !== generation) return
    this.#firstFrameWait = null
    wait.signal.removeEventListener("abort", wait.onAbort)
    this.#firstFrameDeadline.complete(generation)
    wait.resolve()
  }

  private rejectFirstFrame(
    error: CharacterError,
    generation: number | undefined,
  ): void {
    const wait = this.#firstFrameWait
    if (
      wait === null ||
      generation === undefined ||
      wait.generation !== generation
    ) {
      return
    }
    this.#firstFrameWait = null
    wait.signal.removeEventListener("abort", wait.onAbort)
    this.#firstFrameDeadline.cancel(generation)
    wait.reject(error)
  }

  private syncFirstFrameDeadline(): void {
    const wait = this.#firstFrameWait
    if (wait === null) return
    const activeRendererGeneration =
      this.#candidateRenderer?.generation === wait.generation
        ? wait.generation
        : this.#rendererGeneration
    this.#firstFrameDeadline.setEligible(
      wait.generation,
      canConsumeCharacterFirstFrameDeadline({
        expectedGeneration: wait.generation,
        rendererGeneration: activeRendererGeneration,
        motionPolicy: this.effectiveMotionPolicy,
        documentVisible: this.#documentVisible,
        contextLost: this.#contextLost,
        cssWidth: this.#cssWidth,
        cssHeight: this.#cssHeight,
      }),
    )
  }

  private resetFrameMetrics(): void {
    this.#frameCount = 0
    this.#nonTransparentSamples = 0
    this.#signature = "00000000"
    this.#signatureChanges = 0
    this.#lastDeltaMilliseconds = 0
    this.#webglError = 0
  }

  private enterContextLostState(): void {
    const error = new CharacterError(
      "context_lost",
      "The Live2D WebGL context was lost",
    )
    this.#loadAbortController?.abort(error)
    this.#restoreAbortController?.abort(error)
    this.#contextLost = true
    this.beginContextRecovery()
    this.syncFirstFrameDeadline()
    this.stopFrameLoop()
    this.#error = error
    this.#phase = "recovering"
    this.#fallbackLevel = this.#hasStaticPreview ? "static" : "text_only"
    this.emitStatus()
  }

  private emitStatus(): void {
    this.#callbacks.onStatus?.({
      phase: this.#phase,
      state: this.#stateCursor.state,
      motionPolicy: this.effectiveMotionPolicy,
      fallbackLevel: this.#fallbackLevel,
      error: this.#error,
      pack: this.#client?.manifest ?? null,
    })
  }

  private async rebuildAfterContextRestore(): Promise<void> {
    if (this.#gl === null || this.#canvas === null || this.#disposed) {
      return
    }
    if (this.#client === null) {
      this.#contextLost = this.#gl.isContextLost()
      if (!this.#contextLost) {
        this.#phase = "idle"
        this.#error = null
        this.#fallbackLevel = "text_only"
        this.emitStatus()
      }
      return
    }

    this.#phase = "recovering"
    this.emitStatus()
    const controller = new AbortController()
    this.#restoreAbortController = controller
    const client = this.#client
    const previousModel = this.#model
    let restoredModel: CubismCharacterModel | null = null
    try {
      previousModel?.release()
      this.#model = null
      const { CubismCharacterModel, resetCubismWebGlResources } =
        await import("./cubism-character-model")
      resetCubismWebGlResources(this.#gl)
      this.#contextLost = false
      restoredModel = await CubismCharacterModel.create(
        client,
        this.#gl,
        this.#canvas.width,
        this.#canvas.height,
        controller.signal,
      )
      if (this.#disposed || controller.signal.aborted) {
        return
      }
      const rendererGeneration = this.#rendererGeneration + 1
      restoredModel.resize(this.#canvas.width, this.#canvas.height)
      this.#candidateRenderer = {
        generation: rendererGeneration,
        model: restoredModel,
      }
      const acceptedFrame = await this.stageCandidateFirstFrame(
        restoredModel,
        null,
        controller.signal,
        rendererGeneration,
        this.#hasStaticPreview,
      )
      if (
        this.#disposed ||
        controller.signal.aborted ||
        this.#restoreAbortController !== controller ||
        this.#client !== client
      ) {
        return
      }

      const committedRestore = restoredModel
      restoredModel = null
      this.#candidateRenderer = null
      this.#rendererGeneration = rendererGeneration
      this.#model = committedRestore
      this.#modelInventory = committedRestore.inventory
      this.resetFrameMetrics()
      this.#frameCount = 1
      this.#nonTransparentSamples = acceptedFrame.nonTransparentSamples
      this.#signature = acceptedFrame.signature
      this.#webglError = acceptedFrame.webglError
      this.#hasStaticPreview =
        this.#hasStaticPreview || acceptedFrame.capturedPreview !== null
      this.#error = null
      this.#phase = "ready"
      this.applyMotionPolicy()
      this.#callbacks.onMetrics?.(this.metrics)
      if (acceptedFrame.capturedPreview !== null) {
        this.#callbacks.onStaticPreview?.(acceptedFrame.capturedPreview)
      }
    } catch (error) {
      if (this.#disposed || controller.signal.aborted) return
      this.#contextLost = this.#gl.isContextLost()
      const characterError = toCharacterError(error, "context_restore_failed")
      this.#error = new CharacterError(
        "context_restore_failed",
        characterError.message,
        true,
        { cause: error },
      )
      this.#phase = "error"
      this.#fallbackLevel = this.#hasStaticPreview ? "static" : "text_only"
      this.emitStatus()
    } finally {
      restoredModel?.release()
      if (this.#candidateRenderer?.model === restoredModel) {
        this.#candidateRenderer = null
      }
      if (this.#restoreAbortController === controller) {
        this.#restoreAbortController = null
      }
    }
  }

  private beginContextRecovery(): ContextRecoveryWait {
    if (this.#contextRecoveryWait !== null) return this.#contextRecoveryWait
    let resolvePromise: () => void = () => undefined
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve
    })
    this.#contextRecoveryWait = { promise, resolve: resolvePromise }
    return this.#contextRecoveryWait
  }

  private completeContextRecovery(): void {
    const wait = this.#contextRecoveryWait
    if (wait === null) return
    this.#contextRecoveryWait = null
    wait.resolve()
  }

  private async waitForContextRecovery(signal: AbortSignal): Promise<void> {
    const wait = this.#contextRecoveryWait
    if (wait === null && !this.#contextLost && !this.#restoreInFlight) return
    const recovery = wait ?? this.beginContextRecovery()
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort)
        reject(
          new CharacterError("disposed", "Character load was canceled", false),
        )
      }
      void recovery.promise.then(() => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      })
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }
}
