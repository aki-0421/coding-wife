import {
  CharacterError,
  type CharacterPackFile,
  type CharacterPackManifest,
  type CharacterPackRef,
} from "@/features/character/model"

const sha256Pattern = /^[a-f0-9]{64}$/
const assetRoles = new Set<CharacterPackFile["role"]>([
  "model",
  "moc",
  "texture",
  "motion",
  "physics",
  "pose",
  "display_info",
])
const assetSuffixByRole: Readonly<Record<CharacterPackFile["role"], string>> = {
  model: ".model3.json",
  moc: ".moc3",
  texture: ".png",
  motion: ".motion3.json",
  physics: ".physics3.json",
  pose: ".pose3.json",
  display_info: ".cdi3.json",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function isSafeCharacterAssetId(assetId: string): boolean {
  if (
    assetId === "" ||
    assetId.startsWith("/") ||
    assetId.includes("\\") ||
    assetId.includes("\0") ||
    /^[a-z][a-z0-9+.-]*:/i.test(assetId)
  ) {
    return false
  }

  return !assetId
    .split("/")
    .some((part) => part === "" || part === "." || part === "..")
}

function parsePackFile(value: unknown): CharacterPackFile {
  if (!isRecord(value)) {
    throw new CharacterError("manifest_invalid", "Pack file entry is invalid")
  }

  const { assetId, role, bytes, sha256, dimensions } = value
  if (
    typeof assetId !== "string" ||
    !isSafeCharacterAssetId(assetId) ||
    typeof role !== "string" ||
    !assetRoles.has(role as CharacterPackFile["role"]) ||
    !assetId.endsWith(
      assetSuffixByRole[role as CharacterPackFile["role"]] ?? "\0",
    ) ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    typeof sha256 !== "string" ||
    !sha256Pattern.test(sha256)
  ) {
    throw new CharacterError(
      "manifest_invalid",
      "Pack file metadata is outside the reviewed schema",
    )
  }

  if (dimensions !== undefined) {
    if (
      !isRecord(dimensions) ||
      typeof dimensions.width !== "number" ||
      typeof dimensions.height !== "number" ||
      !Number.isSafeInteger(dimensions.width) ||
      !Number.isSafeInteger(dimensions.height) ||
      dimensions.width <= 0 ||
      dimensions.height <= 0
    ) {
      throw new CharacterError(
        "manifest_invalid",
        "Pack texture dimensions are invalid",
      )
    }
    return {
      assetId,
      role: role as CharacterPackFile["role"],
      bytes,
      sha256,
      dimensions: {
        width: dimensions.width,
        height: dimensions.height,
      },
    }
  }

  return {
    assetId,
    role: role as CharacterPackFile["role"],
    bytes,
    sha256,
  }
}

export function parseCharacterPackManifest(
  value: unknown,
): CharacterPackManifest {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    throw new CharacterError("manifest_invalid", "Pack manifest is invalid")
  }

  const files = value.files.map(parsePackFile)
  const assetIds = files.map((file) => file.assetId)
  if (new Set(assetIds).size !== assetIds.length) {
    throw new CharacterError(
      "manifest_invalid",
      "Pack manifest contains duplicate asset IDs",
    )
  }

  const filesByAssetId = new Map(files.map((file) => [file.assetId, file]))
  const roleCounts = new Map<CharacterPackFile["role"], number>()
  for (const file of files) {
    roleCounts.set(file.role, (roleCounts.get(file.role) ?? 0) + 1)
    if (
      (file.role === "texture" && file.dimensions === undefined) ||
      (file.role !== "texture" && file.dimensions !== undefined)
    ) {
      throw new CharacterError(
        "manifest_invalid",
        "Pack file dimensions do not match the asset role",
      )
    }
  }

  const provenance = value.provenance
  const inventory = value.inventory
  const compatibility = value.compatibility

  if (
    value.schemaVersion !== 1 ||
    value.packId !== "builtin:hiyori_pro" ||
    !isNonEmptyString(value.displayName) ||
    !isNonEmptyString(value.bundledVersion) ||
    typeof value.entrypoint !== "string" ||
    !isSafeCharacterAssetId(value.entrypoint) ||
    value.immutable !== true ||
    !isRecord(provenance) ||
    provenance.sourceKind !== "developer-provided" ||
    typeof provenance.sourceNotice !== "string" ||
    !isSafeCharacterAssetId(provenance.sourceNotice) ||
    !isNonEmptyString(provenance.sourceRuntime) ||
    !isNonEmptyString(provenance.illustration) ||
    !isNonEmptyString(provenance.modeling) ||
    provenance.sdkSampleSubstitution !== false ||
    typeof provenance.noticeSha256 !== "string" ||
    !sha256Pattern.test(provenance.noticeSha256) ||
    !isRecord(inventory) ||
    inventory.runtimeFileCount !== 17 ||
    inventory.totalBytes !==
      files.reduce((total, file) => total + file.bytes, 0) ||
    inventory.textureCount !== 2 ||
    inventory.motionCount !== 10 ||
    inventory.expressionCount !== 0 ||
    !isRecord(inventory.motionGroups) ||
    !isRecord(compatibility) ||
    compatibility.modelSchemaVersion !== 3 ||
    compatibility.mocVersion !== 3 ||
    compatibility.expectedParameters !== 70 ||
    compatibility.expectedParts !== 24 ||
    compatibility.expectedDrawables !== 134 ||
    files.length !== 17 ||
    filesByAssetId.get(value.entrypoint)?.role !== "model" ||
    roleCounts.get("model") !== 1 ||
    roleCounts.get("moc") !== 1 ||
    roleCounts.get("texture") !== 2 ||
    roleCounts.get("motion") !== 10 ||
    roleCounts.get("physics") !== 1 ||
    roleCounts.get("pose") !== 1 ||
    roleCounts.get("display_info") !== 1
  ) {
    throw new CharacterError(
      "manifest_invalid",
      "Pack manifest does not match the reviewed Hiyori contract",
    )
  }

  let motionCueCount = 0
  const referencedMotionAssets = new Set<string>()
  let hasReviewedIdleCue = false
  for (const [group, rawCues] of Object.entries(inventory.motionGroups)) {
    if (!isNonEmptyString(group) || !Array.isArray(rawCues)) {
      throw new CharacterError(
        "manifest_invalid",
        "Pack motion groups are invalid",
      )
    }
    for (const rawCue of rawCues) {
      if (
        !isRecord(rawCue) ||
        !isNonEmptyString(rawCue.cueId) ||
        !isNonEmptyString(rawCue.assetId) ||
        filesByAssetId.get(rawCue.assetId)?.role !== "motion" ||
        referencedMotionAssets.has(rawCue.assetId)
      ) {
        throw new CharacterError(
          "manifest_invalid",
          "Pack motion cue is outside the reviewed schema",
        )
      }
      motionCueCount++
      referencedMotionAssets.add(rawCue.assetId)
      if (group === "Idle" && rawCue.cueId === "Idle[0]") {
        hasReviewedIdleCue = true
      }
    }
  }
  if (
    motionCueCount !== inventory.motionCount ||
    referencedMotionAssets.size !== roleCounts.get("motion") ||
    !hasReviewedIdleCue
  ) {
    throw new CharacterError(
      "manifest_invalid",
      "Pack motion inventory does not match the reviewed Hiyori contract",
    )
  }

  return value as unknown as CharacterPackManifest
}

function expectedContentType(asset: CharacterPackFile): string {
  if (asset.role === "texture") return "image/png"
  if (asset.role === "moc") return "application/octet-stream"
  return "application/json"
}

function hasAcceptedContentType(
  asset: CharacterPackFile,
  receivedContentType: string | null,
): boolean {
  const receivedType =
    receivedContentType?.split(";", 1)[0]?.trim().toLocaleLowerCase() ?? ""
  if (asset.role === "moc" && receivedType === "") return true
  return receivedType === expectedContentType(asset)
}

async function computeSha256(buffer: ArrayBuffer): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) {
    throw new CharacterError(
      "asset_fetch_failed",
      "Character asset integrity verification is unavailable",
      false,
    )
  }

  let digest: ArrayBuffer
  try {
    digest = await globalThis.crypto.subtle.digest("SHA-256", buffer)
  } catch (error) {
    throw new CharacterError(
      "asset_fetch_failed",
      "Character asset integrity verification failed",
      false,
      { cause: error },
    )
  }

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
}

export class CharacterPackClient {
  readonly #assetBaseUrl: URL
  readonly #assets: ReadonlyMap<string, CharacterPackFile>
  public readonly manifest: CharacterPackManifest

  private constructor(manifestUrl: URL, manifest: CharacterPackManifest) {
    this.manifest = manifest
    this.#assetBaseUrl = new URL("./", manifestUrl)
    this.#assets = new Map(manifest.files.map((file) => [file.assetId, file]))
  }

  public static async load(
    pack: CharacterPackRef,
    signal: AbortSignal,
  ): Promise<CharacterPackClient> {
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
        `Character manifest returned HTTP ${response.status}`,
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
    return new CharacterPackClient(
      manifestUrl,
      parseCharacterPackManifest(rawManifest),
    )
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

  private async fetchAssetResponse(
    assetId: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const asset = this.getAsset(assetId)
    const url = new URL(asset.assetId, this.#assetBaseUrl)
    if (url.origin !== this.#assetBaseUrl.origin) {
      throw new CharacterError(
        "asset_not_allowed",
        "Character asset escaped the same-origin boundary",
        false,
      )
    }

    let response: Response
    try {
      response = await fetch(url, {
        cache: "force-cache",
        credentials: "same-origin",
        signal,
      })
    } catch (error) {
      throw new CharacterError(
        "asset_fetch_failed",
        `Unable to load character asset ${asset.role}`,
        true,
        { cause: error },
      )
    }
    if (!response.ok) {
      throw new CharacterError(
        "asset_fetch_failed",
        `Character asset ${asset.role} returned HTTP ${response.status}`,
      )
    }

    if (!hasAcceptedContentType(asset, response.headers.get("content-type"))) {
      throw new CharacterError(
        "asset_type_mismatch",
        `Character asset ${asset.role} used an unexpected media type`,
        false,
      )
    }
    return response
  }

  public async arrayBuffer(
    assetId: string,
    signal: AbortSignal,
  ): Promise<ArrayBuffer> {
    const asset = this.getAsset(assetId)
    const response = await this.fetchAssetResponse(assetId, signal)
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength !== asset.bytes) {
      throw new CharacterError(
        "asset_fetch_failed",
        `Character asset ${asset.role} length did not match its manifest`,
        false,
      )
    }
    if ((await computeSha256(buffer)) !== asset.sha256) {
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
    return new Blob([buffer], { type: expectedContentType(asset) })
  }
}
