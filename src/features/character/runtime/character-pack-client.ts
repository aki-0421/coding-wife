import {
  CharacterError,
  type CharacterAssetRole,
  type CharacterPackFile,
  type CharacterPackManifest,
  type CharacterPackRef,
  type CharacterTrustedFrame,
} from "@/features/character/model"
import {
  characterMotionCueId,
  isCharacterCueId,
} from "@/features/character/cue-id"

export const maxCharacterPackFiles = 4096
const MAX_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_TEXTURE_DIMENSION = 8192
const MAX_MODEL_ITEMS = 1_000_000
const MAX_TRUSTED_FRAME_BYTES = 2 * 1024 * 1024
const MAX_TRUSTED_FRAME_DIMENSION = 2048
const TRUSTED_FRAME_ASSET_ID = "__coding-wife/trusted-frame.png" as const
const sha256Pattern = /^[a-f0-9]{64}$/
const customPackIdPattern =
  /^custom:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

const assetRoles = new Set<CharacterAssetRole>([
  "model",
  "moc",
  "texture",
  "motion",
  "expression",
  "physics",
  "pose",
  "display_info",
  "user_data",
])

const assetSuffixByRole: Readonly<Record<CharacterAssetRole, string>> = {
  model: ".model3.json",
  moc: ".moc3",
  texture: ".png",
  motion: ".motion3.json",
  expression: ".exp3.json",
  physics: ".physics3.json",
  pose: ".pose3.json",
  display_info: ".cdi3.json",
  user_data: ".userdata3.json",
}

export type CharacterResourceMediaKind =
  | CharacterAssetRole
  | "manifest"
  | "shader"

const expectedContentTypeByKind: Readonly<
  Record<CharacterResourceMediaKind, string>
> = {
  manifest: "application/json",
  model: "application/json",
  moc: "application/octet-stream",
  texture: "image/png",
  motion: "application/json",
  expression: "application/json",
  physics: "application/json",
  pose: "application/json",
  display_info: "application/json",
  user_data: "application/json",
  shader: "text/plain",
}

const manifestKeys = [
  "schemaVersion",
  "packId",
  "displayName",
  "bundledVersion",
  "entrypoint",
  "immutable",
  "provenance",
  "inventory",
  "compatibility",
  "files",
] as const

const inventoryKeys = [
  "runtimeFileCount",
  "totalBytes",
  "textureCount",
  "motionCount",
  "expressionCount",
  "motionGroups",
] as const
const inventoryWithExpressionCuesKeys = [
  ...inventoryKeys,
  "expressionCues",
] as const

const compatibilityKeys = [
  "modelSchemaVersion",
  "mocVersion",
  "expectedParameters",
  "expectedParts",
  "expectedDrawables",
] as const

export function expectedCharacterResourceContentType(
  kind: CharacterResourceMediaKind,
): string {
  return expectedContentTypeByKind[kind]
}

export function isAcceptedCharacterResourceContentType(
  kind: CharacterResourceMediaKind,
  receivedContentType: string | null,
): boolean {
  const receivedType =
    receivedContentType?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if ((kind === "moc" || kind === "shader") && receivedType === "") {
    return true
  }
  return receivedType === expectedContentTypeByKind[kind]
}

function violation(message: string): never {
  throw new CharacterError("manifest_invalid", message, false)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  )
}

function isNonEmptyString(value: unknown, maxLength = 512): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    [...value].length <= maxLength
  )
}

function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  )
}

function isRfc3339(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  )
}

export function isSafeCharacterAssetId(assetId: string): boolean {
  if (
    assetId === "" ||
    assetId.length > 512 ||
    assetId.startsWith("/") ||
    assetId.includes("\\") ||
    assetId.includes("\0") ||
    assetId.includes("%") ||
    assetId.includes(":")
  ) {
    return false
  }

  return !assetId
    .split("/")
    .some((part) => part === "" || part === "." || part === "..")
}

function parsePackFile(value: unknown): CharacterPackFile {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["assetId", "role", "bytes", "sha256"], ["dimensions"])
  ) {
    return violation("Pack file entry is invalid")
  }

  const { assetId, role, bytes, sha256, dimensions } = value
  if (
    typeof assetId !== "string" ||
    !isSafeCharacterAssetId(assetId) ||
    typeof role !== "string" ||
    !assetRoles.has(role as CharacterAssetRole) ||
    !assetId.endsWith(assetSuffixByRole[role as CharacterAssetRole] ?? "\0") ||
    !isBoundedInteger(bytes, 1, MAX_FILE_BYTES) ||
    typeof sha256 !== "string" ||
    !sha256Pattern.test(sha256)
  ) {
    return violation("Pack file metadata is outside the reviewed schema")
  }

  const typedRole = role as CharacterAssetRole
  if (typedRole === "texture") {
    if (
      !isRecord(dimensions) ||
      !hasExactKeys(dimensions, ["width", "height"]) ||
      !isBoundedInteger(dimensions.width, 1, MAX_TEXTURE_DIMENSION) ||
      !isBoundedInteger(dimensions.height, 1, MAX_TEXTURE_DIMENSION)
    ) {
      return violation("Pack texture dimensions are invalid")
    }
    return {
      assetId,
      role: typedRole,
      bytes,
      sha256,
      dimensions: { width: dimensions.width, height: dimensions.height },
    }
  }

  if (dimensions !== undefined) {
    return violation("Pack file dimensions do not match the asset role")
  }
  return { assetId, role: typedRole, bytes, sha256 }
}

function parseFiles(value: unknown): readonly CharacterPackFile[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maxCharacterPackFiles
  ) {
    return violation("Pack file inventory is outside the resource bounds")
  }
  const files = value.map(parsePackFile)
  const assetIds = files.map((file) => file.assetId)
  if (new Set(assetIds).size !== assetIds.length) {
    return violation("Pack manifest contains duplicate asset IDs")
  }
  return files
}

function parseTrustedFrame(value: unknown): CharacterTrustedFrame {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["assetId", "bytes", "sha256", "dimensions"]) ||
    value.assetId !== TRUSTED_FRAME_ASSET_ID ||
    !isBoundedInteger(value.bytes, 1, MAX_TRUSTED_FRAME_BYTES) ||
    typeof value.sha256 !== "string" ||
    !sha256Pattern.test(value.sha256) ||
    !isRecord(value.dimensions) ||
    !hasExactKeys(value.dimensions, ["width", "height"]) ||
    !isBoundedInteger(value.dimensions.width, 1, MAX_TRUSTED_FRAME_DIMENSION) ||
    !isBoundedInteger(value.dimensions.height, 1, MAX_TRUSTED_FRAME_DIMENSION)
  ) {
    return violation("Trusted frame metadata is outside the reviewed schema")
  }
  return {
    assetId: TRUSTED_FRAME_ASSET_ID,
    bytes: value.bytes,
    sha256: value.sha256,
    dimensions: {
      width: value.dimensions.width,
      height: value.dimensions.height,
    },
  }
}

function parseMotionGroups(
  value: unknown,
  filesByAssetId: ReadonlyMap<string, CharacterPackFile>,
  motionCount: number,
): Readonly<
  Record<string, readonly Readonly<{ cueId: string; assetId: string }>[]>
> {
  if (!isRecord(value)) return violation("Pack motion groups are invalid")
  const parsed: Record<
    string,
    readonly Readonly<{ cueId: string; assetId: string }>[]
  > = {}
  const referenced = new Set<string>()
  for (const [group, rawCues] of Object.entries(value)) {
    if (characterMotionCueId(group, 0) === null || !Array.isArray(rawCues)) {
      return violation("Pack motion groups are invalid")
    }
    parsed[group] = rawCues.map((rawCue, index) => {
      const expectedCueId = characterMotionCueId(group, index)
      if (
        !isRecord(rawCue) ||
        !hasExactKeys(rawCue, ["cueId", "assetId"]) ||
        expectedCueId === null ||
        rawCue.cueId !== expectedCueId ||
        typeof rawCue.assetId !== "string" ||
        filesByAssetId.get(rawCue.assetId)?.role !== "motion" ||
        referenced.has(rawCue.assetId)
      ) {
        return violation("Pack motion cue is outside the reviewed schema")
      }
      referenced.add(rawCue.assetId)
      return { cueId: rawCue.cueId, assetId: rawCue.assetId }
    })
  }
  if (referenced.size !== motionCount) {
    return violation("Pack motion inventory does not match its files")
  }
  return parsed
}

function parseExpressionCues(
  value: unknown,
  filesByAssetId: ReadonlyMap<string, CharacterPackFile>,
  expressionCount: number,
): readonly Readonly<{ cueId: string; assetId: string }>[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    return violation("Pack expression cues are invalid")
  }
  const cueIds = new Set<string>()
  const assetIds = new Set<string>()
  const parsed = value.map((rawCue) => {
    if (
      !isRecord(rawCue) ||
      !hasExactKeys(rawCue, ["cueId", "assetId"]) ||
      !isCharacterCueId(rawCue.cueId) ||
      typeof rawCue.assetId !== "string" ||
      filesByAssetId.get(rawCue.assetId)?.role !== "expression" ||
      cueIds.has(rawCue.cueId) ||
      assetIds.has(rawCue.assetId)
    ) {
      return violation("Pack expression cue is outside the reviewed schema")
    }
    cueIds.add(rawCue.cueId)
    assetIds.add(rawCue.assetId)
    return { cueId: rawCue.cueId, assetId: rawCue.assetId }
  })
  if (parsed.length > 0 && assetIds.size !== expressionCount) {
    return violation("Pack expression inventory does not match its files")
  }
  return parsed
}

interface ParsedInventory {
  readonly runtimeFileCount: number
  readonly totalBytes: number
  readonly textureCount: number
  readonly motionCount: number
  readonly expressionCount: number
  readonly motionGroups: Readonly<
    Record<string, readonly Readonly<{ cueId: string; assetId: string }>[]>
  >
  readonly expressionCues?: readonly Readonly<{
    cueId: string
    assetId: string
  }>[]
}

function parseInventory(
  value: unknown,
  files: readonly CharacterPackFile[],
): ParsedInventory {
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, inventoryKeys) &&
      !hasExactKeys(value, inventoryWithExpressionCuesKeys))
  ) {
    return violation("Pack inventory is invalid")
  }
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0)
  const roleCount = (role: CharacterAssetRole) =>
    files.filter((file) => file.role === role).length
  if (
    value.runtimeFileCount !== files.length ||
    value.totalBytes !== totalBytes ||
    totalBytes > MAX_TOTAL_BYTES ||
    value.textureCount !== roleCount("texture") ||
    value.motionCount !== roleCount("motion") ||
    value.expressionCount !== roleCount("expression") ||
    !isBoundedInteger(value.textureCount, 1, maxCharacterPackFiles) ||
    !isBoundedInteger(value.motionCount, 0, maxCharacterPackFiles) ||
    !isBoundedInteger(value.expressionCount, 0, maxCharacterPackFiles)
  ) {
    return violation("Pack inventory does not match its files")
  }
  const filesByAssetId = new Map(files.map((file) => [file.assetId, file]))
  const motionGroups = parseMotionGroups(
    value.motionGroups,
    filesByAssetId,
    value.motionCount,
  )
  return {
    runtimeFileCount: files.length,
    totalBytes,
    textureCount: value.textureCount,
    motionCount: value.motionCount,
    expressionCount: value.expressionCount,
    motionGroups,
    ...(value.expressionCues === undefined
      ? {}
      : {
          expressionCues: parseExpressionCues(
            value.expressionCues,
            filesByAssetId,
            value.expressionCount,
          ),
        }),
  }
}

function parseCompatibility(
  value: unknown,
  builtin: boolean,
): CharacterPackManifest["compatibility"] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, compatibilityKeys) ||
    value.modelSchemaVersion !== 3 ||
    !isBoundedInteger(value.mocVersion, 1, 6)
  ) {
    return violation("Pack compatibility is invalid")
  }
  const expected = [
    value.expectedParameters,
    value.expectedParts,
    value.expectedDrawables,
  ]
  const allNull = expected.every((item) => item === null)
  const allPresent = expected.every((item) =>
    isBoundedInteger(item, 1, MAX_MODEL_ITEMS),
  )
  if ((!allNull && !allPresent) || (builtin && !allPresent)) {
    return violation("Pack model inventory attestation is invalid")
  }
  return {
    modelSchemaVersion: 3,
    mocVersion: value.mocVersion,
    expectedParameters: value.expectedParameters as number | null,
    expectedParts: value.expectedParts as number | null,
    expectedDrawables: value.expectedDrawables as number | null,
  }
}

function validateCoreManifest(
  value: Record<string, unknown>,
  files: readonly CharacterPackFile[],
): void {
  const filesByAssetId = new Map(files.map((file) => [file.assetId, file]))
  if (
    value.schemaVersion !== 1 ||
    !isNonEmptyString(value.displayName, 80) ||
    !isNonEmptyString(value.bundledVersion, 80) ||
    typeof value.entrypoint !== "string" ||
    !isSafeCharacterAssetId(value.entrypoint) ||
    filesByAssetId.get(value.entrypoint)?.role !== "model" ||
    files.filter((file) => file.role === "model").length !== 1 ||
    files.filter((file) => file.role === "moc").length !== 1 ||
    value.immutable !== true
  ) {
    return violation("Pack manifest core fields are invalid")
  }
}

function parseBuiltinManifest(
  value: Record<string, unknown>,
): CharacterPackManifest {
  if (
    !hasExactKeys(value, manifestKeys) ||
    value.packId !== "builtin:hiyori_pro"
  ) {
    return violation("Bundled Hiyori manifest shape is invalid")
  }
  const files = parseFiles(value.files)
  validateCoreManifest(value, files)
  const provenance = value.provenance
  if (
    !isRecord(provenance) ||
    !hasExactKeys(provenance, [
      "sourceKind",
      "sourceNotice",
      "sourceRuntime",
      "illustration",
      "modeling",
      "sdkSampleSubstitution",
      "noticeSha256",
    ]) ||
    provenance.sourceKind !== "developer-provided" ||
    typeof provenance.sourceNotice !== "string" ||
    !isSafeCharacterAssetId(provenance.sourceNotice) ||
    !isNonEmptyString(provenance.sourceRuntime) ||
    !isNonEmptyString(provenance.illustration, 80) ||
    !isNonEmptyString(provenance.modeling, 80) ||
    provenance.sdkSampleSubstitution !== false ||
    typeof provenance.noticeSha256 !== "string" ||
    !sha256Pattern.test(provenance.noticeSha256)
  ) {
    return violation("Bundled Hiyori provenance is invalid")
  }
  const inventory = parseInventory(value.inventory, files)
  const compatibility = parseCompatibility(value.compatibility, true)
  if (
    files.length !== 17 ||
    inventory.textureCount !== 2 ||
    inventory.motionCount !== 10 ||
    inventory.expressionCount !== 0 ||
    compatibility.mocVersion !== 3 ||
    compatibility.expectedParameters !== 70 ||
    compatibility.expectedParts !== 24 ||
    compatibility.expectedDrawables !== 134 ||
    !inventory.motionGroups.Idle?.some((cue) => cue.cueId === "Idle[0]")
  ) {
    return violation(
      "Pack manifest does not match the reviewed Hiyori contract",
    )
  }
  return {
    schemaVersion: 1,
    packId: "builtin:hiyori_pro",
    displayName: value.displayName as string,
    bundledVersion: value.bundledVersion as string,
    entrypoint: value.entrypoint as string,
    immutable: true,
    provenance: {
      sourceKind: "developer-provided",
      sourceNotice: provenance.sourceNotice,
      sourceRuntime: provenance.sourceRuntime,
      illustration: provenance.illustration,
      modeling: provenance.modeling,
      sdkSampleSubstitution: false,
      noticeSha256: provenance.noticeSha256,
    },
    inventory,
    compatibility,
    files,
  }
}

function parseCustomManifest(
  value: Record<string, unknown>,
): CharacterPackManifest {
  if (
    !hasExactKeys(value, [...manifestKeys, "importedAt"], ["trustedFrame"]) ||
    typeof value.packId !== "string" ||
    !customPackIdPattern.test(value.packId) ||
    value.bundledVersion !== "custom-import-v1" ||
    !isRfc3339(value.importedAt)
  ) {
    return violation("Custom pack manifest shape is invalid")
  }
  const files = parseFiles(value.files)
  validateCoreManifest(value, files)
  const provenance = value.provenance
  if (
    !isRecord(provenance) ||
    !hasExactKeys(provenance, ["sourceKind", "sourceLabel", "importedAt"]) ||
    provenance.sourceKind !== "user_imported" ||
    provenance.sourceLabel !== "Local folder" ||
    provenance.importedAt !== value.importedAt
  ) {
    return violation("Custom pack provenance is invalid")
  }
  const compatibility = parseCompatibility(value.compatibility, false)
  const trustedFrame =
    value.trustedFrame === undefined
      ? undefined
      : parseTrustedFrame(value.trustedFrame)
  const hasAttestedInventory = compatibility.expectedDrawables !== null
  if (
    hasAttestedInventory !== (trustedFrame !== undefined) ||
    (trustedFrame !== undefined &&
      files.some((file) => file.assetId === trustedFrame.assetId))
  ) {
    return violation("Custom pack trusted frame does not match attestation")
  }
  const manifest: CharacterPackManifest = {
    schemaVersion: 1,
    packId: value.packId,
    displayName: value.displayName as string,
    bundledVersion: "custom-import-v1",
    entrypoint: value.entrypoint as string,
    immutable: true,
    provenance: {
      sourceKind: "user_imported",
      sourceLabel: "Local folder",
      importedAt: value.importedAt,
    },
    inventory: parseInventory(value.inventory, files),
    compatibility,
    files,
    importedAt: value.importedAt,
  }
  return trustedFrame === undefined ? manifest : { ...manifest, trustedFrame }
}

export function parseCharacterPackManifest(
  value: unknown,
): CharacterPackManifest {
  if (!isRecord(value)) return violation("Pack manifest is invalid")
  return value.packId === "builtin:hiyori_pro"
    ? parseBuiltinManifest(value)
    : parseCustomManifest(value)
}

export async function computeCharacterSha256(
  buffer: ArrayBuffer,
): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) {
    throw new CharacterError(
      "asset_fetch_failed",
      "Character asset integrity verification is unavailable",
      false,
    )
  }
  try {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new Uint8Array(buffer),
    )
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")
  } catch (error) {
    throw new CharacterError(
      "asset_fetch_failed",
      "Character asset integrity verification failed",
      false,
      { cause: error },
    )
  }
}

export async function loadTrustedCharacterFrame(
  pack: CharacterPackRef,
  signal: AbortSignal,
): Promise<ArrayBuffer | null> {
  if (pack.kind !== "native") return null
  const manifest = parseCharacterPackManifest(pack.manifest)
  const frame = manifest.trustedFrame
  if (frame === undefined) return null
  abortIfNeeded(signal)
  const bytes = await pack.readAsset(frame.assetId, "image/png", signal)
  abortIfNeeded(signal)
  if (
    !(bytes instanceof ArrayBuffer) ||
    bytes.byteLength !== frame.bytes ||
    (await computeCharacterSha256(bytes)) !== frame.sha256
  ) {
    throw new CharacterError(
      "asset_fetch_failed",
      "Trusted character frame did not match its immutable manifest",
      false,
    )
  }
  return bytes
}

function abortIfNeeded(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new CharacterError("disposed", "Character asset load was canceled")
}

type AssetLoader = (
  asset: CharacterPackFile,
  signal: AbortSignal,
) => Promise<ArrayBuffer>

export class CharacterPackClient {
  readonly #assets: ReadonlyMap<string, CharacterPackFile>
  readonly #loadAsset: AssetLoader
  public readonly manifest: CharacterPackManifest

  private constructor(manifest: CharacterPackManifest, loadAsset: AssetLoader) {
    this.manifest = manifest
    this.#assets = new Map(manifest.files.map((file) => [file.assetId, file]))
    this.#loadAsset = loadAsset
  }

  public static async load(
    pack: CharacterPackRef,
    signal: AbortSignal,
  ): Promise<CharacterPackClient> {
    abortIfNeeded(signal)
    if (pack.kind === "native") {
      if (!sha256Pattern.test(pack.manifestHash)) {
        throw new CharacterError(
          "manifest_invalid",
          "Native manifest hash is invalid",
          false,
        )
      }
      const manifest = parseCharacterPackManifest(pack.manifest)
      return new CharacterPackClient(manifest, async (asset, assetSignal) => {
        abortIfNeeded(assetSignal)
        const bytes = await pack.readAsset(
          asset.assetId,
          expectedCharacterResourceContentType(asset.role),
          assetSignal,
        )
        abortIfNeeded(assetSignal)
        return bytes
      })
    }

    if (pack.kind === "memory") {
      const manifest = parseCharacterPackManifest(pack.manifest)
      return new CharacterPackClient(manifest, (asset, assetSignal) => {
        abortIfNeeded(assetSignal)
        const bytes = pack.assets.get(asset.assetId)
        if (bytes === undefined) {
          throw new CharacterError(
            "asset_not_allowed",
            "Character asset is absent from isolated preview memory",
            false,
          )
        }
        return Promise.resolve(bytes.slice(0))
      })
    }

    const manifestUrl = new URL(pack.manifestUrl, window.location.href)
    if (manifestUrl.origin !== window.location.origin) {
      throw new CharacterError(
        "asset_not_allowed",
        "Character manifests must be same-origin",
        false,
      )
    }
    let response: Response
    try {
      response = await fetch(manifestUrl, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      })
    } catch (error) {
      throw new CharacterError(
        "asset_fetch_failed",
        "Unable to load the character manifest",
        true,
        { cause: error },
      )
    }
    if (!response.ok) {
      throw new CharacterError(
        "asset_fetch_failed",
        `Character manifest returned HTTP ${String(response.status)}`,
      )
    }
    if (
      !isAcceptedCharacterResourceContentType(
        "manifest",
        response.headers.get("content-type"),
      )
    ) {
      throw new CharacterError(
        "asset_type_mismatch",
        "Character manifest used an unexpected media type",
        false,
      )
    }
    let rawManifest: unknown
    try {
      rawManifest = await response.json()
    } catch (error) {
      throw new CharacterError(
        "manifest_invalid",
        "Character manifest is not valid JSON",
        false,
        { cause: error },
      )
    }
    const manifest = parseCharacterPackManifest(rawManifest)
    const assetBaseUrl = new URL("./", manifestUrl)
    return new CharacterPackClient(manifest, async (asset, assetSignal) => {
      const url = new URL(asset.assetId, assetBaseUrl)
      if (url.origin !== assetBaseUrl.origin) {
        throw new CharacterError(
          "asset_not_allowed",
          "Character asset escaped the same-origin boundary",
          false,
        )
      }
      let assetResponse: Response
      try {
        assetResponse = await fetch(url, {
          cache: "force-cache",
          credentials: "same-origin",
          signal: assetSignal,
        })
      } catch (error) {
        throw new CharacterError(
          "asset_fetch_failed",
          `Unable to load character asset ${asset.role}`,
          true,
          { cause: error },
        )
      }
      if (!assetResponse.ok) {
        throw new CharacterError(
          "asset_fetch_failed",
          `Character asset ${asset.role} returned HTTP ${String(assetResponse.status)}`,
        )
      }
      if (
        !isAcceptedCharacterResourceContentType(
          asset.role,
          assetResponse.headers.get("content-type"),
        )
      ) {
        throw new CharacterError(
          "asset_type_mismatch",
          `Character asset ${asset.role} used an unexpected media type`,
          false,
        )
      }
      return assetResponse.arrayBuffer()
    })
  }

  public getAsset(assetId: string): CharacterPackFile {
    if (!isSafeCharacterAssetId(assetId)) {
      throw new CharacterError(
        "asset_not_allowed",
        "Character asset ID is unsafe",
        false,
      )
    }
    const asset = this.#assets.get(assetId)
    if (asset === undefined) {
      throw new CharacterError(
        "asset_not_allowed",
        "Character asset is not present in the immutable manifest",
        false,
      )
    }
    return asset
  }

  public resolveFromEntrypoint(relativeAssetId: string): string {
    const base = this.manifest.entrypoint.split("/").slice(0, -1).join("/")
    return base === "" ? relativeAssetId : `${base}/${relativeAssetId}`
  }

  public async arrayBuffer(
    assetId: string,
    signal: AbortSignal,
  ): Promise<ArrayBuffer> {
    const asset = this.getAsset(assetId)
    const buffer = await this.#loadAsset(asset, signal)
    abortIfNeeded(signal)
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== asset.bytes) {
      throw new CharacterError(
        "asset_fetch_failed",
        `Character asset ${asset.role} length did not match its manifest`,
        false,
      )
    }
    if ((await computeCharacterSha256(buffer)) !== asset.sha256) {
      throw new CharacterError(
        "asset_fetch_failed",
        `Character asset ${asset.role} hash did not match its manifest`,
        false,
      )
    }
    return buffer
  }

  public async blob(assetId: string, signal: AbortSignal): Promise<Blob> {
    const asset = this.getAsset(assetId)
    const buffer = await this.arrayBuffer(assetId, signal)
    return new Blob([buffer], {
      type: expectedCharacterResourceContentType(asset.role),
    })
  }
}

export interface MaterializedCharacterPack {
  readonly manifest: CharacterPackManifest
  readonly assets: ReadonlyMap<string, ArrayBuffer>
}

export async function materializeCharacterPack(
  pack: CharacterPackRef,
  signal: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
): Promise<MaterializedCharacterPack> {
  const client = await CharacterPackClient.load(pack, signal)
  const assets = new Map<string, ArrayBuffer>()
  for (const [index, asset] of client.manifest.files.entries()) {
    abortIfNeeded(signal)
    assets.set(asset.assetId, await client.arrayBuffer(asset.assetId, signal))
    onProgress?.(index + 1, client.manifest.files.length)
  }
  return { manifest: client.manifest, assets }
}
