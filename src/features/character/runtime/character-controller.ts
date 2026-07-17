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
  #loadAbortController: AbortController | null = null
  #restoreAbortController: AbortController | null = null
  #frameRequest: number | null = null
  #lastFrameTimestamp: number | null = null
  #firstFrameResolve: (() => void) | null = null
  #firstFrameReject: ((error: CharacterError) => void) | null = null
  #firstFrameTimer: ReturnType<typeof setTimeout> | null = null
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
  #hasStaticPreview = false
  #frameCount = 0
  #nonTransparentSamples = 0
  #signature = "00000000"
  #signatureChanges = 0
  #lastDeltaMilliseconds = 0
  #cssWidth = 1
  #cssHeight = 1

  readonly #handleVisibilityChange = () => {
    this.#documentVisible = document.visibilityState === "visible"
    this.applyMotionPolicy()
  }

  readonly #handleContextLost = (event: Event) => {
    event.preventDefault()
    this.#contextLost = true
    this.stopFrameLoop()
    const error = new CharacterError(
      "context_lost",
      "The Live2D WebGL context was lost",
    )
    this.#error = error
    this.#phase = "recovering"
    this.#fallbackLevel = this.#hasStaticPreview ? "static" : "text_only"
    this.emitStatus()
  }

  readonly #handleContextRestored = () => {
    if (!this.#contextLost || this.#restoreInFlight || this.#disposed) return
    this.#restoreInFlight = true
    void this.rebuildAfterContextRestore().finally(() => {
      this.#restoreInFlight = false
    })
  }

  public constructor(options: CharacterControllerOptions = {}) {
    this.#callbacks = options.callbacks ?? {}
    this.#preserveDrawingBuffer = options.preserveDrawingBuffer ?? false
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
    this.#documentVisible = document.visibilityState === "visible"

    const bounds = canvas.getBoundingClientRect()
    this.resize(bounds.width, bounds.height, window.devicePixelRatio)
    await acquireCubismRuntime()
  }

  public async loadPack(
    pack: CharacterPackRef,
    signal: AbortSignal,
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

    this.#phase = "loading"
    this.#error = null
    this.#fallbackLevel = "text_only"
    this.emitStatus()

    try {
      await acquireCubismRuntime()
      const client = await CharacterPackClient.load(
        pack,
        loadAbortController.signal,
      )
      const { CubismCharacterModel } = await import("./cubism-character-model")
      const model = await CubismCharacterModel.create(
        client,
        this.#gl,
        this.#canvas.width,
        this.#canvas.height,
        loadAbortController.signal,
      )
      if (this.#disposed || loadAbortController.signal.aborted) {
        model.release()
        throw new CharacterError("disposed", "Character load was canceled")
      }

      this.#model?.release()
      this.#model = model
      this.#client = client
      this.resetFrameMetrics(true)
      this.#phase = "ready"
      this.#fallbackLevel =
        this.effectiveMotionPolicy === "animated"
          ? "animated"
          : this.effectiveMotionPolicy === "reduced"
            ? "reduced"
            : "text_only"
      this.emitStatus()
      this.applyMotionPolicy()

      if (this.effectiveMotionPolicy !== "hidden") {
        await this.waitForFirstFrame(loadAbortController.signal)
      }
    } catch (error) {
      if (loadAbortController.signal.aborted || this.#disposed) throw error
      const characterError = toCharacterError(error, "asset_fetch_failed")
      this.#phase = "error"
      this.#error = characterError
      this.#fallbackLevel = this.#hasStaticPreview ? "static" : "text_only"
      this.emitStatus()
      throw characterError
    } finally {
      signal.removeEventListener("abort", abortFromCaller)
      if (this.#loadAbortController === loadAbortController) {
        this.#loadAbortController = null
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
    }
    this.#gl?.viewport(0, 0, size.width, size.height)
    if (this.effectiveMotionPolicy === "reduced" && this.#model !== null) {
      this.drawFrame(null)
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
    this.stopFrameLoop()
    this.rejectFirstFrame(
      new CharacterError(
        "disposed",
        "Character controller was disposed",
        false,
      ),
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
    this.emitStatus()
  }

  private startFrameLoop(): void {
    if (
      this.#frameRequest !== null ||
      this.#model === null ||
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
      this.#disposed
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

    if (policy === "animated" && delta > 0) this.#model.update(delta)

    this.#gl.disable(this.#gl.SCISSOR_TEST)
    this.#gl.colorMask(true, true, true, true)
    this.#gl.clearColor(0, 0, 0, 0)
    this.#gl.clear(this.#gl.COLOR_BUFFER_BIT | this.#gl.STENCIL_BUFFER_BIT)
    this.#gl.viewport(0, 0, this.#canvas.width, this.#canvas.height)
    this.#model.draw(this.#canvas.width, this.#canvas.height)
    this.#gl.flush()
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
        this.resolveFirstFrame()
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

  private waitForFirstFrame(signal: AbortSignal): Promise<void> {
    if (this.#nonTransparentSamples > 0) return Promise.resolve()
    this.rejectFirstFrame(
      new CharacterError(
        "shader_load_failed",
        "A newer character load replaced the first-frame wait",
      ),
    )

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.rejectFirstFrame(
          new CharacterError(
            "disposed",
            "Character first-frame wait was canceled",
          ),
        )
      }
      signal.addEventListener("abort", onAbort, { once: true })
      this.#firstFrameResolve = () => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      }
      this.#firstFrameReject = (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
      this.#firstFrameTimer = setTimeout(() => {
        this.rejectFirstFrame(
          new CharacterError(
            "shader_load_failed",
            "Live2D did not produce a visible frame within 3 seconds",
          ),
        )
      }, FIRST_FRAME_TIMEOUT_MILLISECONDS)
    })
  }

  private resolveFirstFrame(): void {
    if (this.#firstFrameResolve === null) return
    if (this.#firstFrameTimer !== null) clearTimeout(this.#firstFrameTimer)
    const resolve = this.#firstFrameResolve
    this.#firstFrameResolve = null
    this.#firstFrameReject = null
    this.#firstFrameTimer = null
    resolve()
  }

  private rejectFirstFrame(error: CharacterError): void {
    if (this.#firstFrameReject === null) return
    if (this.#firstFrameTimer !== null) clearTimeout(this.#firstFrameTimer)
    const reject = this.#firstFrameReject
    this.#firstFrameResolve = null
    this.#firstFrameReject = null
    this.#firstFrameTimer = null
    reject(error)
  }

  private resetFrameMetrics(clearStaticPreview = false): void {
    this.#frameCount = 0
    this.#nonTransparentSamples = 0
    this.#signature = "00000000"
    this.#signatureChanges = 0
    this.#lastDeltaMilliseconds = 0
    if (clearStaticPreview) this.#hasStaticPreview = false
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
    if (
      this.#client === null ||
      this.#gl === null ||
      this.#canvas === null ||
      this.#disposed
    ) {
      return
    }

    this.#phase = "recovering"
    this.emitStatus()
    const controller = new AbortController()
    this.#restoreAbortController = controller
    try {
      this.#model?.release()
      this.#model = null
      const { CubismCharacterModel, resetCubismWebGlResources } =
        await import("./cubism-character-model")
      resetCubismWebGlResources(this.#gl)
      const model = await CubismCharacterModel.create(
        this.#client,
        this.#gl,
        this.#canvas.width,
        this.#canvas.height,
        controller.signal,
      )
      if (this.#disposed || controller.signal.aborted) {
        model.release()
        return
      }
      this.#model = model
      this.#contextLost = false
      this.#error = null
      this.#phase = "ready"
      this.resetFrameMetrics()
      this.applyMotionPolicy()
      if (this.effectiveMotionPolicy !== "hidden") {
        await this.waitForFirstFrame(controller.signal)
      }
      this.emitStatus()
    } catch (error) {
      if (this.#disposed || controller.signal.aborted) return
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
      if (this.#restoreAbortController === controller) {
        this.#restoreAbortController = null
      }
    }
  }
}
