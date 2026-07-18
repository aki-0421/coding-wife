export const characterStates = [
  "idle",
  "thinking",
  "acting",
  "waiting_for_user",
  "reviewing",
  "error",
  "completed",
  "disconnected",
] as const

export type CharacterState = (typeof characterStates)[number]
export type CharacterMotionPolicy = "animated" | "reduced" | "hidden"
export type CharacterFallbackLevel =
  "animated" | "reduced" | "static" | "text_only"

export type CharacterErrorCode =
  | "core_load_failed"
  | "core_version_mismatch"
  | "framework_initialize_failed"
  | "manifest_invalid"
  | "asset_not_allowed"
  | "asset_fetch_failed"
  | "asset_type_mismatch"
  | "moc_invalid"
  | "model_inventory_mismatch"
  | "texture_decode_failed"
  | "webgl_unavailable"
  | "shader_load_failed"
  | "context_lost"
  | "context_restore_failed"
  | "disposed"

export interface CharacterRuntimeError {
  readonly code: CharacterErrorCode
  readonly message: string
  readonly recoverable: boolean
}

export type CharacterAssetRole =
  | "model"
  | "moc"
  | "texture"
  | "motion"
  | "expression"
  | "physics"
  | "pose"
  | "display_info"
  | "user_data"

export interface CharacterPackFile {
  readonly assetId: string
  readonly role: CharacterAssetRole
  readonly bytes: number
  readonly sha256: string
  readonly dimensions?: Readonly<{
    width: number
    height: number
  }>
}

export interface CharacterTrustedFrame {
  readonly assetId: "__coding-wife/trusted-frame.png"
  readonly bytes: number
  readonly sha256: string
  readonly dimensions: Readonly<{
    width: number
    height: number
  }>
}

export interface CharacterDeveloperProvenance {
  readonly sourceKind: "developer-provided"
  readonly sourceNotice: string
  readonly sourceRuntime: string
  readonly illustration: string
  readonly modeling: string
  readonly sdkSampleSubstitution: false
  readonly noticeSha256: string
}

export interface CharacterUserImportedProvenance {
  readonly sourceKind: "user_imported"
  readonly sourceLabel: "Local folder"
  readonly importedAt: string
}

export interface CharacterPackManifest {
  readonly schemaVersion: 1
  readonly packId: string
  readonly displayName: string
  readonly bundledVersion: string
  readonly entrypoint: string
  readonly immutable: true
  readonly provenance:
    | Readonly<CharacterDeveloperProvenance>
    | Readonly<CharacterUserImportedProvenance>
  readonly inventory: Readonly<{
    runtimeFileCount: number
    totalBytes: number
    textureCount: number
    motionCount: number
    expressionCount: number
    motionGroups: Readonly<
      Record<
        string,
        readonly Readonly<{
          cueId: string
          assetId: string
        }>[]
      >
    >
    expressionCues?: readonly Readonly<{
      cueId: string
      assetId: string
    }>[]
  }>
  readonly compatibility: Readonly<{
    modelSchemaVersion: number
    mocVersion: number
    expectedParameters: number | null
    expectedParts: number | null
    expectedDrawables: number | null
  }>
  readonly files: readonly CharacterPackFile[]
  readonly importedAt?: string
  readonly trustedFrame?: CharacterTrustedFrame
}

export interface CharacterUrlPackRef {
  readonly kind: "url"
  readonly manifestUrl: string
}

export interface CharacterNativePackRef {
  readonly kind: "native"
  readonly manifest: CharacterPackManifest
  readonly manifestHash: string
  readonly previewToken: string | null
  readonly readAsset: (
    assetId: string,
    expectedMime: string,
    signal: AbortSignal,
  ) => Promise<ArrayBuffer>
}

export interface CharacterMemoryPackRef {
  readonly kind: "memory"
  readonly manifest: CharacterPackManifest
  readonly assets: ReadonlyMap<string, ArrayBuffer>
}

export type CharacterPackRef =
  CharacterUrlPackRef | CharacterNativePackRef | CharacterMemoryPackRef

export interface CharacterModelInventory {
  readonly parameterCount: number
  readonly partCount: number
  readonly drawableCount: number
  readonly textureDecodeCount: number
}

export interface CharacterFrameMetrics {
  readonly frameCount: number
  readonly nonTransparentSamples: number
  readonly signature: string
  readonly signatureChanges: number
  readonly backingWidth: number
  readonly backingHeight: number
  readonly lastDeltaMilliseconds: number
  readonly webglError: number
  readonly modelInventory: CharacterModelInventory | null
}

export interface CharacterControllerStatus {
  readonly phase:
    "idle" | "loading" | "ready" | "recovering" | "error" | "disposed"
  readonly state: CharacterState
  readonly motionPolicy: CharacterMotionPolicy
  readonly fallbackLevel: CharacterFallbackLevel
  readonly error: CharacterRuntimeError | null
  readonly pack: CharacterPackManifest | null
}

export class CharacterError extends Error implements CharacterRuntimeError {
  public readonly code: CharacterErrorCode
  public readonly recoverable: boolean

  public constructor(
    code: CharacterErrorCode,
    message: string,
    recoverable = true,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "CharacterError"
    this.code = code
    this.recoverable = recoverable
  }
}

export function toCharacterError(
  error: unknown,
  fallbackCode: CharacterErrorCode,
): CharacterError {
  if (error instanceof CharacterError) return error
  const message = error instanceof Error ? error.message : "Unknown failure"
  return new CharacterError(fallbackCode, message, true, {
    cause: error,
  })
}
