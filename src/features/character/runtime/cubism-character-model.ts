import { CubismDefaultParameterId } from "@cubism/cubismdefaultparameterid"
import { CubismModelSettingJson } from "@cubism/cubismmodelsettingjson"
import { BreathParameterData, CubismBreath } from "@cubism/effect/cubismbreath"
import { CubismEyeBlink } from "@cubism/effect/cubismeyeblink"
import type { CubismIdHandle } from "@cubism/id/cubismid"
import { CubismFramework } from "@cubism/live2dcubismframework"
import { CubismMatrix44 } from "@cubism/math/cubismmatrix44"
import { CubismMoc } from "@cubism/model/cubismmoc"
import { CubismUserModel } from "@cubism/model/cubismusermodel"
import { ACubismMotion } from "@cubism/motion/acubismmotion"
import type { CubismMotion } from "@cubism/motion/cubismmotion"
import { CubismWebGLOffscreenManager } from "@cubism/rendering/cubismoffscreenmanager"
import { CubismShaderManager_WebGL } from "@cubism/rendering/cubismshader_webgl"

import {
  CharacterError,
  type CharacterModelInventory,
} from "@/features/character/model"
import type { SemanticCueSelection } from "@/features/character/library/contracts"
import type { CharacterPackClient } from "@/features/character/runtime/character-pack-client"
import { verifyCubismShaderSources } from "@/features/character/runtime/shader-source-preflight"

const SHADER_PATH = "/vendor/live2d/shaders/webgl/"
const IDLE_PRIORITY = 1
const SEMANTIC_CUE_PRIORITY = 3

export function resetCubismWebGlResources(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
): void {
  CubismWebGLOffscreenManager.getInstance().removeContext(gl)
  CubismShaderManager_WebGL.deleteInstance()
}

interface TextureResource {
  readonly texture: WebGLTexture
  readonly close: () => void
}

interface MotionDefinition {
  readonly assetId: string
  readonly group: string
  readonly index: number
}

function signalAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new CharacterError("disposed", "Character texture load was canceled")
}

async function decodeTexture(
  blob: Blob,
  signal: AbortSignal,
): Promise<Readonly<{ source: TexImageSource; close: () => void }>> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, {
        colorSpaceConversion: "default",
        imageOrientation: "none",
        premultiplyAlpha: "premultiply",
      })
      if (signal.aborted) {
        bitmap.close()
        throw signalAbortError(signal)
      }
      return {
        source: bitmap,
        close: () => bitmap.close(),
      }
    } catch (error) {
      if (signal.aborted) throw error
    }
  }

  const objectUrl = URL.createObjectURL(blob)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      const onAbort = () => reject(signalAbortError(signal))
      signal.addEventListener("abort", onAbort, { once: true })
      element.addEventListener(
        "load",
        () => {
          signal.removeEventListener("abort", onAbort)
          resolve(element)
        },
        { once: true },
      )
      element.addEventListener(
        "error",
        () => {
          signal.removeEventListener("abort", onAbort)
          reject(new Error("Image decoder rejected the texture"))
        },
        { once: true },
      )
      element.src = objectUrl
    })
    return { source: image, close: () => undefined }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function createTexture(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  source: TexImageSource,
): WebGLTexture {
  const texture = gl.createTexture()
  if (texture === null) {
    throw new CharacterError(
      "texture_decode_failed",
      "WebGL could not allocate a character texture",
    )
  }

  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  )
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.bindTexture(gl.TEXTURE_2D, null)
  return texture
}

export class CubismCharacterModel extends CubismUserModel {
  readonly #client: CharacterPackClient
  readonly #gl: WebGLRenderingContext | WebGL2RenderingContext
  readonly #textures: TextureResource[] = []
  readonly #eyeBlinkIds: CubismIdHandle[] = []
  readonly #lipSyncIds: CubismIdHandle[] = []
  readonly #motions = new Map<string, CubismMotion>()
  readonly #expressions = new Map<string, ACubismMotion>()
  readonly #motionDefinitions = new Map<string, MotionDefinition>()
  readonly #expressionDefinitions = new Map<string, string>()
  readonly #cueLoadAbortController = new AbortController()
  #setting: CubismModelSettingJson | null = null
  #cueGeneration = 0
  #idleMotion: CubismMotion | null = null
  #released = false

  private constructor(
    client: CharacterPackClient,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ) {
    super()
    this.#client = client
    this.#gl = gl
  }

  public static async create(
    client: CharacterPackClient,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    width: number,
    height: number,
    signal: AbortSignal,
  ): Promise<CubismCharacterModel> {
    const instance = new CubismCharacterModel(client, gl)
    try {
      await instance.initialize(width, height, signal)
      return instance
    } catch (error) {
      instance.release()
      throw error
    }
  }

  async initialize(
    width: number,
    height: number,
    signal: AbortSignal,
  ): Promise<void> {
    const entrypoint = this.#client.manifest.entrypoint
    const settingBytes = await this.#client.arrayBuffer(entrypoint, signal)
    const setting = new CubismModelSettingJson(
      settingBytes,
      settingBytes.byteLength,
    )
    this.#setting = setting

    const mocAsset = this.#client.resolveFromEntrypoint(
      setting.getModelFileName(),
    )
    const mocBytes = await this.#client.arrayBuffer(mocAsset, signal)
    if (!CubismMoc.hasMocConsistency(mocBytes)) {
      throw new CharacterError(
        "moc_invalid",
        "The selected Live2D MOC is invalid",
        false,
      )
    }
    const mocVersion = CubismMoc.getMocVersionFromBuffer(mocBytes)
    if (mocVersion !== this.#client.manifest.compatibility.mocVersion) {
      throw new CharacterError(
        "moc_invalid",
        "The selected Live2D MOC version differs from its manifest",
        false,
      )
    }
    this.loadModel(mocBytes, true)
    if (this._model === null) {
      throw new CharacterError(
        "moc_invalid",
        "Cubism could not create the selected model",
      )
    }

    const compatibility = this.#client.manifest.compatibility
    const expectedInventory = [
      compatibility.expectedParameters,
      compatibility.expectedParts,
      compatibility.expectedDrawables,
    ]
    if (
      expectedInventory.every((value) => value !== null) &&
      (this._model.getParameterCount() !== compatibility.expectedParameters ||
        this._model.getPartCount() !== compatibility.expectedParts ||
        this._model.getDrawableCount() !== compatibility.expectedDrawables)
    ) {
      throw new CharacterError(
        "model_inventory_mismatch",
        "The selected model inventory differs from its preview attestation",
        false,
      )
    }

    const physicsFile = setting.getPhysicsFileName()
    if (physicsFile !== "") {
      const bytes = await this.#client.arrayBuffer(
        this.#client.resolveFromEntrypoint(physicsFile),
        signal,
      )
      this.loadPhysics(bytes, bytes.byteLength)
    }

    const poseFile = setting.getPoseFileName()
    if (poseFile !== "") {
      const bytes = await this.#client.arrayBuffer(
        this.#client.resolveFromEntrypoint(poseFile),
        signal,
      )
      this.loadPose(bytes, bytes.byteLength)
    }

    for (let index = 0; index < setting.getEyeBlinkParameterCount(); index++) {
      this.#eyeBlinkIds.push(setting.getEyeBlinkParameterId(index))
    }
    for (let index = 0; index < setting.getLipSyncParameterCount(); index++) {
      this.#lipSyncIds.push(setting.getLipSyncParameterId(index))
    }
    if (this.#eyeBlinkIds.length > 0) {
      this._eyeBlink = CubismEyeBlink.create(setting)
    }

    this._breath = CubismBreath.create()
    const angleXId = CubismDefaultParameterId.ParamAngleX
    const bodyAngleXId = CubismDefaultParameterId.ParamBodyAngleX
    const breathId = CubismDefaultParameterId.ParamBreath
    if (
      angleXId === undefined ||
      bodyAngleXId === undefined ||
      breathId === undefined
    ) {
      throw new CharacterError(
        "framework_initialize_failed",
        "Cubism default parameter IDs are unavailable",
        false,
      )
    }
    this._breath.setParameters([
      new BreathParameterData(
        CubismFramework.getIdManager().getId(angleXId),
        0,
        12,
        6.5,
        0.35,
      ),
      new BreathParameterData(
        CubismFramework.getIdManager().getId(bodyAngleXId),
        0,
        3,
        12,
        0.3,
      ),
      new BreathParameterData(
        CubismFramework.getIdManager().getId(breathId),
        0.5,
        0.5,
        3.2,
        0.8,
      ),
    ])

    const layout = new Map<string, number>()
    setting.getLayoutMap(layout)
    this._modelMatrix.setupFromLayout(layout)
    this._modelMatrix.setHeight(2)

    for (const [group, cues] of Object.entries(
      this.#client.manifest.inventory.motionGroups,
    )) {
      for (const [index, cue] of cues.entries()) {
        const motionFile = setting.getMotionFileName(group, index)
        if (
          motionFile === "" ||
          this.#client.resolveFromEntrypoint(motionFile) !== cue.assetId
        ) {
          throw new CharacterError(
            "model_inventory_mismatch",
            "The model motion references differ from its manifest",
            false,
          )
        }
        this.#motionDefinitions.set(cue.cueId, {
          assetId: cue.assetId,
          group,
          index,
        })
      }
    }
    const idleDefinition = this.#motionDefinitions.get("Idle[0]")
    if (idleDefinition !== undefined) {
      await this.loadMotionCue("Idle[0]", idleDefinition, signal)
    }
    this.#idleMotion = this.#motions.get("Idle[0]") ?? null
    for (const cue of this.#client.manifest.inventory.expressionCues ?? []) {
      this.#expressionDefinitions.set(cue.cueId, cue.assetId)
    }

    await verifyCubismShaderSources(SHADER_PATH, signal)

    this.createRenderer(width, height)
    const renderer = this.getRenderer()
    renderer.startUp(this.#gl)
    renderer.setIsPremultipliedAlpha(true)

    if (
      setting.getTextureCount() !== this.#client.manifest.inventory.textureCount
    ) {
      throw new CharacterError(
        "model_inventory_mismatch",
        "The model texture references differ from its manifest",
        false,
      )
    }
    const textureAssetIds = new Set<string>()
    for (let index = 0; index < setting.getTextureCount(); index++) {
      const relative = setting.getTextureFileName(index)
      const assetId = this.#client.resolveFromEntrypoint(relative)
      if (textureAssetIds.has(assetId)) {
        throw new CharacterError(
          "model_inventory_mismatch",
          "The model references a texture more than once",
          false,
        )
      }
      textureAssetIds.add(assetId)
      const blob = await this.#client.blob(assetId, signal)

      let decoded: Awaited<ReturnType<typeof decodeTexture>>
      try {
        decoded = await decodeTexture(blob, signal)
      } catch (error) {
        throw new CharacterError(
          "texture_decode_failed",
          "Unable to decode a texture for the selected model",
          true,
          { cause: error },
        )
      }
      try {
        const texture = createTexture(this.#gl, decoded.source)
        this.#textures.push({ texture, close: decoded.close })
        renderer.bindTexture(index, texture)
      } catch (error) {
        decoded.close()
        throw error
      }
    }

    this.resetToNeutral()
    renderer.loadShaders(SHADER_PATH)
  }

  public get inventory(): CharacterModelInventory {
    return {
      parameterCount: this._model.getParameterCount(),
      partCount: this._model.getPartCount(),
      drawableCount: this._model.getDrawableCount(),
      textureDecodeCount: this.#textures.length,
    }
  }

  public resize(width: number, height: number): void {
    this.setRenderTargetSize(width, height)
  }

  public resetToNeutral(): void {
    this._motionManager.stopAllMotions()
    this._expressionManager.stopAllMotions()
    for (let index = 0; index < this._model.getParameterCount(); index++) {
      this._model.setParameterValueByIndex(
        index,
        this._model.getParameterDefaultValue(index),
      )
    }
    this._pose?.updateParameters(this._model, 0)
    this._model.saveParameters()
    this._model.update()
  }

  public playSemanticCue(cue: SemanticCueSelection): void {
    const generation = ++this.#cueGeneration
    if (cue.kind === "neutral") {
      this.resetToNeutral()
      return
    }
    const selected =
      cue.kind === "motion"
        ? this.#motions.get(cue.cueId)
        : this.#expressions.get(cue.cueId)
    if (selected === undefined) {
      void this.loadAndPlaySemanticCue(cue, generation)
      return
    }
    if (cue.kind === "motion") {
      this._motionManager.startMotionPriority(
        selected,
        false,
        SEMANTIC_CUE_PRIORITY,
      )
    } else {
      this._expressionManager.startMotion(selected, false)
    }
  }

  private async loadAndPlaySemanticCue(
    cue: Exclude<SemanticCueSelection, { kind: "neutral" }>,
    generation: number,
  ): Promise<void> {
    try {
      if (cue.kind === "motion") {
        const definition = this.#motionDefinitions.get(cue.cueId)
        if (definition === undefined) throw new Error("unknown motion cue")
        await this.loadMotionCue(
          cue.cueId,
          definition,
          this.#cueLoadAbortController.signal,
        )
      } else {
        const assetId = this.#expressionDefinitions.get(cue.cueId)
        if (assetId === undefined) throw new Error("unknown expression cue")
        const bytes = await this.#client.arrayBuffer(
          assetId,
          this.#cueLoadAbortController.signal,
        )
        if (!this.#expressions.has(cue.cueId)) {
          const expression = this.loadExpression(
            bytes,
            bytes.byteLength,
            cue.cueId,
          )
          if (expression === null) throw new Error("invalid expression cue")
          this.#expressions.set(cue.cueId, expression)
        }
      }
      if (this.#released || generation !== this.#cueGeneration) return
      this.playSemanticCue(cue)
    } catch {
      if (!this.#released && generation === this.#cueGeneration) {
        this.resetToNeutral()
      }
    }
  }

  private async loadMotionCue(
    cueId: string,
    definition: MotionDefinition,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#motions.has(cueId)) return
    const setting = this.#setting
    if (setting === null) throw new Error("model setting unavailable")
    const bytes = await this.#client.arrayBuffer(definition.assetId, signal)
    if (this.#motions.has(cueId)) return
    const motion = this.loadMotion(
      bytes,
      bytes.byteLength,
      cueId,
      undefined,
      undefined,
      setting,
      definition.group,
      definition.index,
      true,
    )
    if (motion === null) throw new Error("invalid motion cue")
    motion.setEffectIds(this.#eyeBlinkIds, this.#lipSyncIds)
    this.#motions.set(cueId, motion)
  }

  public startIdleMotion(): void {
    if (this.#idleMotion === null || !this._motionManager.isFinished()) return
    this._motionManager.startMotionPriority(
      this.#idleMotion,
      false,
      IDLE_PRIORITY,
    )
  }

  public update(deltaSeconds: number): void {
    this._model.loadParameters()
    this.startIdleMotion()
    const motionUpdated = this._motionManager.updateMotion(
      this._model,
      deltaSeconds,
    )
    this._expressionManager.updateMotion(this._model, deltaSeconds)
    this._model.saveParameters()

    if (!motionUpdated) {
      this._eyeBlink?.updateParameters(this._model, deltaSeconds)
    }
    this._breath?.updateParameters(this._model, deltaSeconds)
    this._physics?.evaluate(this._model, deltaSeconds)
    this._pose?.updateParameters(this._model, deltaSeconds)
    this._model.update()
  }

  public draw(width: number, height: number): void {
    const projection = new CubismMatrix44()
    projection.scale(height / width, 1)
    projection.multiplyByMatrix(this._modelMatrix)

    const renderer = this.getRenderer()
    renderer.setMvpMatrix(projection)
    renderer.setRenderState(null as unknown as WebGLFramebuffer, [
      0,
      0,
      width,
      height,
    ])

    const offscreenManager = CubismWebGLOffscreenManager.getInstance()
    offscreenManager.beginFrameProcess(this.#gl)
    renderer.drawModel(SHADER_PATH)
    offscreenManager.endFrameProcess(this.#gl)
    offscreenManager.releaseStaleRenderTextures(this.#gl)
  }

  public override release(): void {
    if (this.#released) return
    this.#released = true
    this.#cueLoadAbortController.abort()
    this._motionManager?.stopAllMotions()
    for (const motion of this.#motions.values()) ACubismMotion.delete(motion)
    this.#motions.clear()
    this.#idleMotion = null
    for (const expression of this.#expressions.values()) {
      ACubismMotion.delete(expression)
    }
    this.#expressions.clear()
    for (const resource of this.#textures) {
      this.#gl.deleteTexture(resource.texture)
      resource.close()
    }
    this.#textures.length = 0
    super.release()
  }
}
