import type { CharacterPackManifest } from "@/features/character/model"
import { isCharacterCueId } from "@/features/character/cue-id"
import {
  expectedCharacterResourceContentType,
  maxCharacterPackFiles,
  parseCharacterPackManifest,
} from "@/features/character/runtime/character-pack-client"

export const characterLibrarySchemaVersion = 1 as const
export const builtinHiyoriPackId = "builtin:hiyori_pro" as const
export const characterLibraryScopeId = "__app_character__" as const

export const characterLibraryCommands = {
  get: "character_library_get",
  pickImport: "character_import_pick",
  readAsset: "character_read_asset",
  attestPreview: "character_attest_preview",
  confirmImport: "character_confirm_import",
  cancelImport: "character_cancel_import",
  selectPack: "character_select_pack",
  saveSemanticMapping: "character_semantic_mapping_save",
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
  readonly thumbnailSha256: string
  readonly thumbnailPng: readonly number[]
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

export const semanticStates = [
  "neutral",
  "thinking",
  "working",
  "asking",
  "success",
  "warning",
  "error",
] as const

export type SemanticState = (typeof semanticStates)[number]

export type SemanticCueSelection =
  | Readonly<{ kind: "neutral" }>
  | Readonly<{ kind: "motion"; cueId: string }>
  | Readonly<{ kind: "expression"; cueId: string }>

export type SemanticAssignmentsV1 = Readonly<
  Record<SemanticState, SemanticCueSelection>
>

export interface SemanticMappingV1 {
  readonly schemaVersion: 1
  readonly packId: string
  readonly manifestHash: string
  readonly mappingVersion: number
  readonly assignments: SemanticAssignmentsV1
}

export interface CharacterSemanticMappingSaveRequest {
  readonly workspaceId: string
  readonly packId: string
  readonly manifestHash: string
  readonly expectedMappingVersion: number
  readonly assignments: SemanticAssignmentsV1
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
  readonly selectedProjectCount: number
  readonly deletable: boolean
  readonly manifest: CharacterPackManifest | null
  readonly thumbnailSha256: string | null
  readonly cueInventory: Readonly<{
    motions: readonly string[]
    expressions: readonly string[]
  }>
}

export interface CharacterLibrarySnapshot {
  readonly schemaVersion: typeof characterLibrarySchemaVersion
  readonly workspaceId: string
  readonly projectId: string
  readonly selectedPackId: string
  readonly fallbackApplied: boolean
  readonly diagnostics: readonly string[]
  readonly packs: readonly CharacterPackView[]
  readonly semanticMapping: SemanticMappingV1
  readonly semanticMappingStatus: "default" | "saved" | "invalid"
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
const projectPattern = /^[A-Za-z0-9_-]{1,160}$/
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

function projectId(value: unknown): value is string {
  return typeof value === "string" && projectPattern.test(value)
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

function parseCueSelection(value: unknown): SemanticCueSelection {
  if (!isRecord(value) || typeof value.kind !== "string") return violation()
  if (value.kind === "neutral" && exact(value, ["kind"])) {
    return { kind: "neutral" }
  }
  if (
    (value.kind === "motion" || value.kind === "expression") &&
    exact(value, ["kind", "cueId"]) &&
    typeof value.cueId === "string" &&
    isCharacterCueId(value.cueId)
  ) {
    return { kind: value.kind, cueId: value.cueId }
  }
  return violation()
}

function parseSemanticAssignments(value: unknown): SemanticAssignmentsV1 {
  if (!isRecord(value) || !exact(value, semanticStates)) return violation()
  return Object.fromEntries(
    semanticStates.map((state) => [state, parseCueSelection(value[state])]),
  ) as unknown as SemanticAssignmentsV1
}

export function parseSemanticMapping(value: unknown): SemanticMappingV1 {
  if (
    !isRecord(value) ||
    !exact(value, [
      "schemaVersion",
      "packId",
      "manifestHash",
      "mappingVersion",
      "assignments",
    ]) ||
    value.schemaVersion !== 1 ||
    !packId(value.packId) ||
    !sha256(value.manifestHash) ||
    !integer(value.mappingVersion, 0)
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    packId: value.packId,
    manifestHash: value.manifestHash,
    mappingVersion: value.mappingVersion,
    assignments: parseSemanticAssignments(value.assignments),
  }
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
      "thumbnailPng",
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
    !integer(value.textureDecodeCount, 1, maxCharacterPackFiles) ||
    value.stateCueObserved !== true ||
    value.webglError !== 0 ||
    !integer(value.parameterCount, 1, 1_000_000) ||
    !integer(value.partCount, 1, 1_000_000) ||
    !integer(value.drawableCount, 1, 1_000_000) ||
    !sha256(value.thumbnailSha256) ||
    !Array.isArray(value.thumbnailPng) ||
    value.thumbnailPng.length === 0 ||
    value.thumbnailPng.length > 2 * 1024 * 1024 ||
    !value.thumbnailPng.every((byte) => integer(byte, 0, 255))
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

export function parseCharacterSemanticMappingSaveRequest(
  value: unknown,
): CharacterSemanticMappingSaveRequest {
  if (
    !isRecord(value) ||
    !exact(value, [
      "workspaceId",
      "packId",
      "manifestHash",
      "expectedMappingVersion",
      "assignments",
    ]) ||
    !workspaceId(value.workspaceId) ||
    !packId(value.packId) ||
    !sha256(value.manifestHash) ||
    !integer(value.expectedMappingVersion, 0)
  ) {
    return violation()
  }
  return {
    workspaceId: value.workspaceId,
    packId: value.packId,
    manifestHash: value.manifestHash,
    expectedMappingVersion: value.expectedMappingVersion,
    assignments: parseSemanticAssignments(value.assignments),
  }
}

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
      "selectedProjectCount",
      "deletable",
      "manifest",
      "thumbnailSha256",
      "cueInventory",
    ]) ||
    value.schemaVersion !== characterLibrarySchemaVersion ||
    !packId(value.packId) ||
    !string(value.displayName, 80) ||
    !sha256(value.manifestHash) ||
    !string(value.provenanceLabel, 80) ||
    !integer(value.runtimeFileCount, 1, maxCharacterPackFiles) ||
    !integer(value.totalBytes, 1, 100 * 1024 * 1024) ||
    !integer(value.textureCount, 1, maxCharacterPackFiles) ||
    !integer(value.motionCount, 0, maxCharacterPackFiles) ||
    !integer(value.expressionCount, 0, maxCharacterPackFiles) ||
    !integer(value.selectedProjectCount, 0) ||
    typeof value.deletable !== "boolean" ||
    (value.thumbnailSha256 !== null && !sha256(value.thumbnailSha256))
  ) {
    return violation()
  }
  if (
    !isRecord(value.cueInventory) ||
    !exact(value.cueInventory, ["motions", "expressions"]) ||
    !Array.isArray(value.cueInventory.motions) ||
    !Array.isArray(value.cueInventory.expressions) ||
    !value.cueInventory.motions.every((cue) => isCharacterCueId(cue)) ||
    !value.cueInventory.expressions.every((cue) => isCharacterCueId(cue)) ||
    new Set(value.cueInventory.motions).size !==
      value.cueInventory.motions.length ||
    new Set(value.cueInventory.expressions).size !==
      value.cueInventory.expressions.length ||
    value.cueInventory.motions.length !== value.motionCount ||
    value.cueInventory.expressions.length > value.expressionCount
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
    !isRecord(value.manifest) ||
    !value.deletable
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
    (manifest.trustedFrame?.sha256 ?? null) !== value.thumbnailSha256 ||
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
      "projectId",
      "selectedPackId",
      "fallbackApplied",
      "diagnostics",
      "packs",
      "semanticMapping",
      "semanticMappingStatus",
    ]) ||
    value.schemaVersion !== characterLibrarySchemaVersion ||
    !workspaceId(value.workspaceId) ||
    !projectId(value.projectId) ||
    !packId(value.selectedPackId) ||
    typeof value.fallbackApplied !== "boolean" ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > 128 ||
    !value.diagnostics.every(
      (code) => typeof code === "string" && allowedDiagnostics.has(code),
    ) ||
    !Array.isArray(value.packs) ||
    value.packs.length === 0 ||
    value.packs.length > 2
  ) {
    return violation()
  }
  const packs = value.packs.map(parseCharacterPackView)
  const semanticMapping = parseSemanticMapping(value.semanticMapping)
  const ids = packs.map((pack) => pack.packId)
  if (
    new Set(ids).size !== ids.length ||
    ids.filter((id) => id === builtinHiyoriPackId).length !== 1 ||
    packs.filter((pack) => pack.kind === "custom").length > 1 ||
    !ids.includes(value.selectedPackId)
  ) {
    return violation()
  }
  const selectedPack = packs.find(
    (pack) => pack.packId === value.selectedPackId,
  )!
  const mappingCuesValid = Object.values(semanticMapping.assignments).every(
    (cue) =>
      cue.kind === "neutral" ||
      (cue.kind === "motion"
        ? selectedPack.cueInventory.motions.includes(cue.cueId)
        : selectedPack.cueInventory.expressions.includes(cue.cueId)),
  )
  if (
    semanticMapping.packId !== selectedPack.packId ||
    semanticMapping.manifestHash !== selectedPack.manifestHash ||
    !["default", "saved", "invalid"].includes(
      value.semanticMappingStatus as string,
    ) ||
    (value.semanticMappingStatus !== "saved" &&
      semanticMapping.mappingVersion !== 0) ||
    !mappingCuesValid
  ) {
    return violation()
  }
  return {
    schemaVersion: characterLibrarySchemaVersion,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    selectedPackId: value.selectedPackId,
    fallbackApplied: value.fallbackApplied,
    diagnostics: [...(value.diagnostics as string[])],
    packs,
    semanticMapping,
    semanticMappingStatus: value.semanticMappingStatus as
      | "default"
      | "saved"
      | "invalid",
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
    manifest.compatibility.expectedDrawables !== null ||
    manifest.trustedFrame !== undefined
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
