import type {
  CharacterFrameMetrics,
  CharacterPackManifest,
} from "@/features/character/model"
import { parseCharacterPackManifest } from "@/features/character/runtime/character-pack-client"

export const characterPreviewProtocol = "character-preview-v1" as const
export const maxTrustedFrameBytes = 2 * 1024 * 1024

export interface CharacterPreviewLoadMessage {
  readonly protocol: typeof characterPreviewProtocol
  readonly type: "load"
  readonly channelNonce: string
  readonly previewNonce: string
  readonly generation: number
  readonly manifest: CharacterPackManifest
  readonly assets: readonly Readonly<{
    assetId: string
    bytes: ArrayBuffer
  }>[]
}

export interface CharacterPreviewSuccessMessage {
  readonly protocol: typeof characterPreviewProtocol
  readonly type: "success"
  readonly channelNonce: string
  readonly previewNonce: string
  readonly generation: number
  readonly rendererNonce: string
  readonly frameCount: number
  readonly nonTransparentSamples: number
  readonly signature: string
  readonly textureDecodeCount: number
  readonly stateCueObserved: true
  readonly webglError: 0
  readonly parameterCount: number
  readonly partCount: number
  readonly drawableCount: number
  readonly thumbnailSha256: string
  readonly thumbnailPng: ArrayBuffer
}

export interface CharacterPreviewFailureMessage {
  readonly protocol: typeof characterPreviewProtocol
  readonly type: "failure"
  readonly channelNonce: string
  readonly previewNonce: string
  readonly generation: number
  readonly errorCode: string
}

export type CharacterPreviewResultMessage =
  | CharacterPreviewSuccessMessage
  | CharacterPreviewFailureMessage

const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const sha256Pattern = /^[a-f0-9]{64}$/

function invalid(): never {
  throw new Error("CHARACTER-PREVIEW-PROTOCOL")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value)
}

function integer(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  )
}

export function createCharacterPreviewLoadMessage(
  channelNonce: string,
  previewNonce: string,
  generation: number,
  manifest: CharacterPackManifest,
  assets: ReadonlyMap<string, ArrayBuffer>,
): CharacterPreviewLoadMessage {
  return parseCharacterPreviewLoadMessage({
    protocol: characterPreviewProtocol,
    type: "load",
    channelNonce,
    previewNonce,
    generation,
    manifest,
    assets: [...assets].map(([assetId, bytes]) => ({ assetId, bytes })),
  })
}

export function parseCharacterPreviewLoadMessage(
  value: unknown,
): CharacterPreviewLoadMessage {
  if (
    !record(value) ||
    !exact(value, [
      "protocol",
      "type",
      "channelNonce",
      "previewNonce",
      "generation",
      "manifest",
      "assets",
    ]) ||
    value.protocol !== characterPreviewProtocol ||
    value.type !== "load" ||
    !uuid(value.channelNonce) ||
    !uuid(value.previewNonce) ||
    !integer(value.generation, 1) ||
    !Array.isArray(value.assets) ||
    value.assets.length === 0 ||
    value.assets.length > 128
  ) {
    return invalid()
  }
  const manifest = parseCharacterPackManifest(value.manifest)
  const files = new Map(manifest.files.map((file) => [file.assetId, file]))
  const assetIds = new Set<string>()
  const assets = value.assets.map((asset) => {
    if (
      !record(asset) ||
      !exact(asset, ["assetId", "bytes"]) ||
      typeof asset.assetId !== "string" ||
      !(asset.bytes instanceof ArrayBuffer) ||
      files.get(asset.assetId)?.bytes !== asset.bytes.byteLength ||
      assetIds.has(asset.assetId)
    ) {
      return invalid()
    }
    assetIds.add(asset.assetId)
    return { assetId: asset.assetId, bytes: asset.bytes }
  })
  if (assetIds.size !== files.size) return invalid()
  return {
    protocol: characterPreviewProtocol,
    type: "load",
    channelNonce: value.channelNonce,
    previewNonce: value.previewNonce,
    generation: value.generation,
    manifest,
    assets,
  }
}

export function createCharacterPreviewSuccessMessage(
  identity: Readonly<{
    channelNonce: string
    previewNonce: string
    generation: number
    rendererNonce: string
  }>,
  metrics: CharacterFrameMetrics,
  stateCueObserved: boolean,
  thumbnailSha256: string,
  thumbnailPng: ArrayBuffer,
): CharacterPreviewSuccessMessage {
  const inventory = metrics.modelInventory
  return parseCharacterPreviewResultMessage({
    protocol: characterPreviewProtocol,
    type: "success",
    ...identity,
    frameCount: metrics.frameCount,
    nonTransparentSamples: metrics.nonTransparentSamples,
    signature: metrics.signature,
    textureDecodeCount: inventory?.textureDecodeCount ?? 0,
    stateCueObserved,
    webglError: metrics.webglError,
    parameterCount: inventory?.parameterCount ?? 0,
    partCount: inventory?.partCount ?? 0,
    drawableCount: inventory?.drawableCount ?? 0,
    thumbnailSha256,
    thumbnailPng,
  }) as CharacterPreviewSuccessMessage
}

export function parseCharacterPreviewResultMessage(
  value: unknown,
): CharacterPreviewResultMessage {
  if (
    !record(value) ||
    value.protocol !== characterPreviewProtocol ||
    !uuid(value.channelNonce) ||
    !uuid(value.previewNonce) ||
    !integer(value.generation, 1)
  ) {
    return invalid()
  }
  if (value.type === "failure") {
    if (
      !exact(value, [
        "protocol",
        "type",
        "channelNonce",
        "previewNonce",
        "generation",
        "errorCode",
      ]) ||
      typeof value.errorCode !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(value.errorCode)
    ) {
      return invalid()
    }
    return value as unknown as CharacterPreviewFailureMessage
  }
  if (
    value.type !== "success" ||
    !exact(value, [
      "protocol",
      "type",
      "channelNonce",
      "previewNonce",
      "generation",
      "rendererNonce",
      "frameCount",
      "nonTransparentSamples",
      "signature",
      "textureDecodeCount",
      "stateCueObserved",
      "webglError",
      "parameterCount",
      "partCount",
      "drawableCount",
      "thumbnailSha256",
      "thumbnailPng",
    ]) ||
    !uuid(value.rendererNonce) ||
    !integer(value.frameCount, 1) ||
    !integer(value.nonTransparentSamples, 1) ||
    typeof value.signature !== "string" ||
    !/^[a-f0-9]{8}$/.test(value.signature) ||
    !integer(value.textureDecodeCount, 1, 128) ||
    value.stateCueObserved !== true ||
    value.webglError !== 0 ||
    !integer(value.parameterCount, 1, 1_000_000) ||
    !integer(value.partCount, 1, 1_000_000) ||
    !integer(value.drawableCount, 1, 1_000_000) ||
    typeof value.thumbnailSha256 !== "string" ||
    !sha256Pattern.test(value.thumbnailSha256) ||
    !(value.thumbnailPng instanceof ArrayBuffer) ||
    value.thumbnailPng.byteLength === 0 ||
    value.thumbnailPng.byteLength > maxTrustedFrameBytes ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) =>
        new Uint8Array(value.thumbnailPng as ArrayBuffer)[index] === byte,
    )
  ) {
    return invalid()
  }
  return value as unknown as CharacterPreviewSuccessMessage
}

export function createCharacterPreviewFailureMessage(
  identity: Readonly<{
    channelNonce: string
    previewNonce: string
    generation: number
  }>,
  errorCode: string,
): CharacterPreviewFailureMessage {
  const value = {
    protocol: characterPreviewProtocol,
    type: "failure",
    ...identity,
    errorCode,
  } as const
  const parsed = parseCharacterPreviewResultMessage(value)
  if (parsed.type !== "failure") return invalid()
  return parsed
}
