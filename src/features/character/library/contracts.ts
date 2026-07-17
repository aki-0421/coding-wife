import type { CharacterPackManifest } from "@/features/character/model"
import {
  expectedCharacterResourceContentType,
  parseCharacterPackManifest,
} from "@/features/character/runtime/character-pack-client"

export const characterLibrarySchemaVersion = 1 as const
export const builtinHiyoriPackId = "builtin:hiyori_pro" as const

export const characterLibraryCommands = {
  get: "character_library_get",
  pickImport: "character_import_pick",
  readAsset: "character_read_asset",
  attestPreview: "character_attest_preview",
  confirmImport: "character_confirm_import",
  cancelImport: "character_cancel_import",
  selectPack: "character_select_pack",
  deletePack: "character_delete_pack",
} as const

export type CharacterLibraryCommand =
  (typeof characterLibraryCommands)[keyof typeof characterLibraryCommands]

export interface CharacterLibraryRequest {
  readonly workspaceId: string
}

export interface CharacterAssetRequest {
  readonly packId: string
  readonly assetId: string
  readonly manifestHash: string
  readonly expectedMime: string
  readonly previewToken: string | null
}

export interface CharacterPreviewAttestationRequest {
  readonly previewToken: string
  readonly previewNonce: string
  readonly rendererNonce: string
  readonly generation: number
  readonly manifestHash: string
  readonly frameCount: number
  readonly nonTransparentSamples: number
  readonly signature: string
  readonly textureDecodeCount: number
  readonly stateCueObserved: boolean
  readonly webglError: number
  readonly parameterCount: number
  readonly partCount: number
  readonly drawableCount: number
  readonly thumbnailSha256: string | null
}

export interface CharacterPreviewAttestationResponse {
  readonly schemaVersion: typeof characterLibrarySchemaVersion
  readonly attested: true
  readonly rendererNonce: string
}

export interface CharacterConfirmImportRequest {
  readonly workspaceId: string
  readonly previewToken: string
  readonly previewNonce: string
  readonly rendererNonce: string
  readonly generation: number
  readonly manifestHash: string
  readonly displayName: string
}

export interface CharacterCancelImportRequest {
  readonly previewToken: string
  readonly previewNonce: string
  readonly generation: number
}

export interface CharacterSelectRequest {
  readonly workspaceId: string
  readonly packId: string
}

export interface CharacterDeleteRequest {
  readonly workspaceId: string
  readonly packId: string
}

export interface CharacterPackView {
  readonly schemaVersion: typeof characterLibrarySchemaVersion
  readonly packId: string
  readonly displayName: string
  readonly kind: "builtin" | "custom"
  readonly manifestHash: string
  readonly provenanceLabel: string
  readonly importedAt: string | null
  readonly runtimeFileCount: number
  readonly totalBytes: number
  readonly textureCount: number
  readonly motionCount: number
  readonly expressionCount: number
  readonly selectedWorkspaceCount: number
  readonly deletable: boolean
  readonly manifest: CharacterPackManifest | null
  readonly thumbnailSha256: string | null
}

export interface CharacterLibrarySnapshot {
  readonly schemaVersion: typeof characterLibrarySchemaVersion
  readonly workspaceId: string
  readonly selectedPackId: string
  readonly fallbackApplied: boolean
  readonly diagnostics: readonly string[]
  readonly packs: readonly CharacterPackView[]
}

export interface CharacterPreviewSession {
  readonly schemaVersion: typeof characterLibrarySchemaVersion
  readonly previewToken: string
  readonly previewNonce: string
  readonly generation: number
  readonly packId: string
  readonly manifestHash: string
  readonly expiresAt: string
  readonly manifest: CharacterPackManifest
}

export interface CharacterImportResponse {
  readonly schemaVersion: typeof characterLibrarySchemaVersion
  readonly outcome: "selected" | "canceled"
  readonly preview: CharacterPreviewSession | null
}

export interface CharacterCommandErrorEnvelope {
  readonly code: string
  readonly operation: CharacterLibraryCommand
  readonly recoverable: boolean
  readonly userMessageKey: "character.error.generic"
  readonly detailRef: "character-library-v1"
}

export class CharacterLibraryContractError extends Error {
  public constructor() {
    super("The value did not match the character library contract.")
    this.name = "CharacterLibraryContractError"
  }
}

const sha256Pattern = /^[a-f0-9]{64}$/
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const customPackIdPattern = new RegExp(
  `^custom:${uuidPattern.source.slice(1, -1)}$`,
)
const workspacePattern = /^[A-Za-z0-9_:][A-Za-z0-9_:-]{0,159}$/
const allowedDiagnostics = new Set([
  "CHARACTER-PACK-QUARANTINED",
  "CHARACTER-SELECTION-FALLBACK",
])

function violation(): never {
  throw new CharacterLibraryContractError()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  return (
    Object.keys(value).length === required.length &&
    required.every((key) => Object.hasOwn(value, key))
  )
}

function string(value: unknown, maximum = 512): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    [...value].length <= maximum
  )
}

function integer(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  )
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  )
}

function workspaceId(value: unknown): value is string {
  return typeof value === "string" && workspacePattern.test(value)
}

function packId(value: unknown): value is string {
  return (
    value === builtinHiyoriPackId ||
    (typeof value === "string" && customPackIdPattern.test(value))
  )
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value)
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && sha256Pattern.test(value)
}

export function parseCharacterLibraryRequest(
  value: unknown,
): CharacterLibraryRequest {
  if (
    !isRecord(value) ||
    !exact(value, ["workspaceId"]) ||
    !workspaceId(value.workspaceId)
  ) {
    return violation()
  }
  return { workspaceId: value.workspaceId }
}

export function parseCharacterAssetRequest(
  value: unknown,
): CharacterAssetRequest {
  if (
    !isRecord(value) ||
    !exact(value, [
      "packId",
      "assetId",
      "manifestHash",
      "expectedMime",
      "previewToken",
    ]) ||
    !packId(value.packId) ||
    !string(value.assetId) ||
    !sha256(value.manifestHash) ||
    !["application/json", "application/octet-stream", "image/png"].includes(
      value.expectedMime as string,
    ) ||
    (value.previewToken !== null && !uuid(value.previewToken))
  ) {
    return violation()
  }
  return value as unknown as CharacterAssetRequest
}

export function parseCharacterPreviewAttestationRequest(
  value: unknown,
): CharacterPreviewAttestationRequest {
  if (
    !isRecord(value) ||
    !exact(value, [
      "previewToken",
      "previewNonce",
      "rendererNonce",
      "generation",
      "manifestHash",
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
    ]) ||
    !uuid(value.previewToken) ||
    !uuid(value.previewNonce) ||
    !uuid(value.rendererNonce) ||
    !integer(value.generation, 1) ||
    !sha256(value.manifestHash) ||
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
    (value.thumbnailSha256 !== null && !sha256(value.thumbnailSha256))
  ) {
    return violation()
  }
  return value as unknown as CharacterPreviewAttestationRequest
}

export function parseCharacterConfirmImportRequest(
  value: unknown,
): CharacterConfirmImportRequest {
  if (
    !isRecord(value) ||
    !exact(value, [
      "workspaceId",
      "previewToken",
      "previewNonce",
      "rendererNonce",
      "generation",
      "manifestHash",
      "displayName",
    ]) ||
    !workspaceId(value.workspaceId) ||
    !uuid(value.previewToken) ||
    !uuid(value.previewNonce) ||
    !uuid(value.rendererNonce) ||
    !integer(value.generation, 1) ||
    !sha256(value.manifestHash) ||
    !string(value.displayName, 80)
  ) {
    return violation()
  }
  return value as unknown as CharacterConfirmImportRequest
}

export function parseCharacterCancelImportRequest(
  value: unknown,
): CharacterCancelImportRequest {
  if (
    !isRecord(value) ||
    !exact(value, ["previewToken", "previewNonce", "generation"]) ||
    !uuid(value.previewToken) ||
    !uuid(value.previewNonce) ||
    !integer(value.generation, 1)
  ) {
    return violation()
  }
  return value as unknown as CharacterCancelImportRequest
}

function parsePackMutationRequest<T extends CharacterSelectRequest>(
  value: unknown,
): T {
  if (
    !isRecord(value) ||
    !exact(value, ["workspaceId", "packId"]) ||
    !workspaceId(value.workspaceId) ||
    !packId(value.packId)
  ) {
    return violation()
  }
  return value as unknown as T
}

export const parseCharacterSelectRequest = (value: unknown) =>
  parsePackMutationRequest<CharacterSelectRequest>(value)

export const parseCharacterDeleteRequest = (value: unknown) =>
  parsePackMutationRequest<CharacterDeleteRequest>(value)

function parseCharacterPackView(value: unknown): CharacterPackView {
  if (
    !isRecord(value) ||
    !exact(value, [
      "schemaVersion",
      "packId",
      "displayName",
      "kind",
      "manifestHash",
      "provenanceLabel",
      "importedAt",
      "runtimeFileCount",
      "totalBytes",
      "textureCount",
      "motionCount",
      "expressionCount",
      "selectedWorkspaceCount",
      "deletable",
      "manifest",
      "thumbnailSha256",
    ]) ||
    value.schemaVersion !== characterLibrarySchemaVersion ||
    !packId(value.packId) ||
    !string(value.displayName, 80) ||
    !sha256(value.manifestHash) ||
    !string(value.provenanceLabel, 80) ||
    !integer(value.runtimeFileCount, 1, 128) ||
    !integer(value.totalBytes, 1, 100 * 1024 * 1024) ||
    !integer(value.textureCount, 1, 128) ||
    !integer(value.motionCount, 0, 128) ||
    !integer(value.expressionCount, 0, 128) ||
    !integer(value.selectedWorkspaceCount, 0) ||
    typeof value.deletable !== "boolean" ||
    (value.thumbnailSha256 !== null && !sha256(value.thumbnailSha256))
  ) {
    return violation()
  }
  if (value.kind === "builtin") {
    if (
      value.packId !== builtinHiyoriPackId ||
      value.importedAt !== null ||
      value.manifest !== null ||
      value.thumbnailSha256 !== null ||
      value.deletable
    ) {
      return violation()
    }
    return value as unknown as CharacterPackView
  }
  if (
    value.kind !== "custom" ||
    value.packId === builtinHiyoriPackId ||
    !timestamp(value.importedAt) ||
    !isRecord(value.manifest)
  ) {
    return violation()
  }
  const manifest = parseCharacterPackManifest(value.manifest)
  if (
    manifest.packId !== value.packId ||
    manifest.importedAt !== value.importedAt ||
    manifest.inventory.runtimeFileCount !== value.runtimeFileCount ||
    manifest.inventory.totalBytes !== value.totalBytes ||
    manifest.inventory.textureCount !== value.textureCount ||
    manifest.inventory.motionCount !== value.motionCount ||
    manifest.inventory.expressionCount !== value.expressionCount ||
    (manifest.thumbnailSha256 ?? null) !== value.thumbnailSha256 ||
    manifest.compatibility.expectedDrawables === null
  ) {
    return violation()
  }
  return { ...(value as unknown as CharacterPackView), manifest }
}

export function parseCharacterLibrarySnapshot(
  value: unknown,
): CharacterLibrarySnapshot {
  if (
    !isRecord(value) ||
    !exact(value, [
      "schemaVersion",
      "workspaceId",
      "selectedPackId",
      "fallbackApplied",
      "diagnostics",
      "packs",
    ]) ||
    value.schemaVersion !== characterLibrarySchemaVersion ||
    !workspaceId(value.workspaceId) ||
    !packId(value.selectedPackId) ||
    typeof value.fallbackApplied !== "boolean" ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > 128 ||
    !value.diagnostics.every(
      (code) => typeof code === "string" && allowedDiagnostics.has(code),
    ) ||
    !Array.isArray(value.packs) ||
    value.packs.length === 0 ||
    value.packs.length > 129
  ) {
    return violation()
  }
  const packs = value.packs.map(parseCharacterPackView)
  const ids = packs.map((pack) => pack.packId)
  if (
    new Set(ids).size !== ids.length ||
    ids.filter((id) => id === builtinHiyoriPackId).length !== 1 ||
    !ids.includes(value.selectedPackId)
  ) {
    return violation()
  }
  return {
    schemaVersion: characterLibrarySchemaVersion,
    workspaceId: value.workspaceId,
    selectedPackId: value.selectedPackId,
    fallbackApplied: value.fallbackApplied,
    diagnostics: [...(value.diagnostics as string[])],
    packs,
  }
}

function parsePreviewSession(value: unknown): CharacterPreviewSession {
  if (
    !isRecord(value) ||
    !exact(value, [
      "schemaVersion",
      "previewToken",
      "previewNonce",
      "generation",
      "packId",
      "manifestHash",
      "expiresAt",
      "manifest",
    ]) ||
    value.schemaVersion !== characterLibrarySchemaVersion ||
    !uuid(value.previewToken) ||
    !uuid(value.previewNonce) ||
    !integer(value.generation, 1) ||
    typeof value.packId !== "string" ||
    !customPackIdPattern.test(value.packId) ||
    !sha256(value.manifestHash) ||
    !timestamp(value.expiresAt) ||
    !isRecord(value.manifest)
  ) {
    return violation()
  }
  const manifest = parseCharacterPackManifest(value.manifest)
  if (
    manifest.packId !== value.packId ||
    manifest.compatibility.expectedParameters !== null ||
    manifest.compatibility.expectedParts !== null ||
    manifest.compatibility.expectedDrawables !== null
  ) {
    return violation()
  }
  return { ...(value as unknown as CharacterPreviewSession), manifest }
}

export function parseCharacterImportResponse(
  value: unknown,
): CharacterImportResponse {
  if (
    !isRecord(value) ||
    !exact(value, ["schemaVersion", "outcome", "preview"]) ||
    value.schemaVersion !== characterLibrarySchemaVersion
  ) {
    return violation()
  }
  if (value.outcome === "canceled" && value.preview === null) {
    return {
      schemaVersion: characterLibrarySchemaVersion,
      outcome: "canceled",
      preview: null,
    }
  }
  if (value.outcome !== "selected") return violation()
  return {
    schemaVersion: characterLibrarySchemaVersion,
    outcome: "selected",
    preview: parsePreviewSession(value.preview),
  }
}

export function parseCharacterPreviewAttestationResponse(
  value: unknown,
): CharacterPreviewAttestationResponse {
  if (
    !isRecord(value) ||
    !exact(value, ["schemaVersion", "attested", "rendererNonce"]) ||
    value.schemaVersion !== characterLibrarySchemaVersion ||
    value.attested !== true ||
    !uuid(value.rendererNonce)
  ) {
    return violation()
  }
  return value as unknown as CharacterPreviewAttestationResponse
}

export function parseCharacterCommandError(
  value: unknown,
): CharacterCommandErrorEnvelope | null {
  if (
    !isRecord(value) ||
    !exact(value, [
      "code",
      "operation",
      "recoverable",
      "userMessageKey",
      "detailRef",
    ]) ||
    typeof value.code !== "string" ||
    !/^CHARACTER-[A-Z0-9-]{1,96}$/.test(value.code) ||
    !Object.values(characterLibraryCommands).includes(
      value.operation as CharacterLibraryCommand,
    ) ||
    typeof value.recoverable !== "boolean" ||
    value.userMessageKey !== "character.error.generic" ||
    value.detailRef !== "character-library-v1"
  ) {
    return null
  }
  return value as unknown as CharacterCommandErrorEnvelope
}

export function expectedMimeForAsset(
  manifest: CharacterPackManifest,
  assetId: string,
): string {
  const asset = manifest.files.find(
    (candidate) => candidate.assetId === assetId,
  )
  if (asset === undefined) return violation()
  return expectedCharacterResourceContentType(asset.role)
}
