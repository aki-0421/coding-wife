import { unicodeScalarCount } from "@/lib/public-text"

export const workspaceContextSchemaVersion = 1 as const

export type CharacterTone = "concise" | "warm" | "neutral"
export type SpeechDensity = "quiet" | "key_events" | "detailed"

export interface ProjectContext {
  readonly goal: string
  readonly constraints: string
  readonly definitionOfDone: readonly string[]
  readonly technicalReferences: readonly string[]
  readonly userNotes: string
}

export interface CharacterContext {
  readonly displayName: string
  readonly tone: CharacterTone
  readonly toneNotes: string
  readonly speechDensity: SpeechDensity
  readonly behavior: string
  readonly prohibitedExpressions: readonly string[]
}

export interface VersionedProjectContext {
  readonly schemaVersion: typeof workspaceContextSchemaVersion
  readonly projectId: string
  readonly version: number
  readonly contentHash: string
  readonly updatedAt: string
  readonly context: ProjectContext
}

export interface VersionedCharacterContext {
  readonly schemaVersion: typeof workspaceContextSchemaVersion
  readonly version: number
  readonly contentHash: string
  readonly updatedAt: string
  readonly context: CharacterContext
}

export interface WorkspaceEditableContext {
  readonly schemaVersion: typeof workspaceContextSchemaVersion
  readonly workspaceId: string
  readonly project: VersionedProjectContext
  readonly character: VersionedCharacterContext
}

export interface WorkspaceLoadEditableContextRequest {
  readonly workspaceId: string
}

export interface ProjectGetContextRequest {
  readonly projectId: string
}

export interface ProjectSaveContextRequest {
  readonly projectId: string
  readonly expectedVersion: number
  readonly context: ProjectContext
}

export interface AppSaveCharacterContextRequest {
  readonly expectedVersion: number
  readonly context: CharacterContext
}

export interface WorkspaceTurnContextSnapshot {
  readonly schemaVersion: typeof workspaceContextSchemaVersion
  readonly workspaceId: string
  readonly projectVersion: number
  readonly projectHash: string
  readonly characterVersion: number
  readonly characterHash: string
  readonly snapshotHash: string
  readonly capturedAt: string
  readonly project: ProjectContext
  readonly character: CharacterContext
}

export type WorkspaceContextValidationReason =
  | "required"
  | "text"
  | "items"
  | "technicalReference"
  | "policy"
  | "total"

export interface WorkspaceContextValidationIssue<Field extends string> {
  readonly field: Field
  readonly reason: WorkspaceContextValidationReason
}

export class WorkspaceContextContractError extends Error {
  constructor() {
    super("The value did not match the workspace context contract.")
    this.name = "WorkspaceContextContractError"
  }
}

const workspaceIdPattern = /^[A-Za-z0-9-]{1,128}$/u
const hashPattern = /^[0-9a-f]{64}$/u
const policyPresentationPatterns = [
  /\b(?:while|when)\s+(?:the\s+)?tools?\s+(?:(?:are|remain)\s+)?(?:run|runs|running|active|working|executing)\b/giu,
  /\b(?:say|quote|mention)\s+(?:the\s+)?(?:phrase\s+|words?\s+)?(?:permissions?|approvals?|verification|checks?|safety|privacy|models?|tools?|git)(?:\s+(?:denied|granted|allowed|required|optional))?\b/giu,
  /\buse\s+(?:the\s+)?(?:phrase|wording|words?)\s+(?:permissions?|approvals?|verification|checks?|safety|privacy|models?|tools?|git)(?:\s+(?:denied|granted|allowed|required|optional))?\b/giu,
  /\b(?:permissions?|approvals?|verification|checks?|safety|privacy|models?|tools?|git)(?:\s+(?:requests?|prompts?|calls?|checks?|policy|observer|skill|capability))?\s+(?:errors?|results?|outputs?|messages?|wording|language|jargon|terms?|terminology|tone|phrasing|summaries?|explanations?|descriptions?|labels?|notifications?)\b/giu,
  /(?:プライバシー確認|チェックポイント|コミットスキル|安全確認|動作確認|権限|許可|承認|検証|確認|ツール|モデル)(?:要求|確認|呼び出し|方針|ポリシー)?(?:エラー|結果|出力|メッセージ|文言|言語|用語|専門用語|表現|口調|語調|言い回し|要約|説明|ラベル|通知)/gu,
] as const
const policyDomainPatterns = [
  /\b(?:permissions?|approvals?|verification|checks?|safety|privacy|models?|tools?|git)\b/iu,
  /\b(?:permission|approval)\s+(?:requests?|prompts?|checks?)\b/iu,
  /\b(?:tool\s+calls?|git\s+observer|commit\s+skill|support\s+capability|checkpoint\s+policy)\b/iu,
  /(?:プライバシー確認|チェックポイント(?:方針|ポリシー)?|コミットスキル|安全確認|動作確認|権限(?:要求|確認)?|許可(?:要求|確認)?|承認(?:要求|確認)?|検証|確認|ツール(?:呼び出し)?|モデル)/u,
] as const

function violation(): never {
  throw new WorkspaceContextContractError()
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return (
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => keys.includes(key))
  )
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 1
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    value.includes("T") &&
    Number.isFinite(Date.parse(value))
  )
}

function isContextText(
  value: unknown,
  maximum: number,
  allowEmpty = true,
): value is string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    unicodeScalarCount(value) > maximum
  ) {
    return false
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code === 9 || code === 10) continue
    if (code === 13 || code < 32 || (code >= 127 && code <= 159)) return false
  }
  return true
}

function parseItems(
  value: unknown,
  maximumItems: number,
  maximumItem: number,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximumItems ||
    !value.every(
      (item) => isContextText(item, maximumItem, false) && item === item.trim(),
    )
  ) {
    return violation()
  }
  const items: unknown[] = value
  return items.map((item) => {
    if (typeof item !== "string") return violation()
    return item
  })
}

export function normalizeTechnicalReference(value: string): string | null {
  const managedDocument = value.startsWith("doc:")
  const candidate = managedDocument ? value.slice(4) : value
  if (
    candidate.length === 0 ||
    candidate.startsWith("/") ||
    candidate.includes("\\") ||
    (!managedDocument && candidate.includes(":")) ||
    (managedDocument && !/^[A-Za-z0-9._/-]+$/u.test(candidate))
  ) {
    return null
  }
  const parts: string[] = []
  for (const part of candidate.split("/")) {
    if (part.length === 0 || part === ".") continue
    if (part === "..") return null
    parts.push(part)
  }
  if (parts.length === 0) return null
  const normalized = parts.join("/")
  return managedDocument ? `doc:${normalized}` : normalized
}

function validTechnicalReference(value: string): boolean {
  return normalizeTechnicalReference(value) === value
}

function normalizePolicyText(value: string): string {
  let normalized = ""
  for (const character of value.normalize("NFKC").toLowerCase()) {
    normalized += /[\p{L}\p{N}]/u.test(character) ? character : " "
  }
  return normalized.replaceAll(/\s+/gu, " ").trim()
}

function containsNonPresentationPolicyDomain(value: string): boolean {
  let policyScope = normalizePolicyText(value)
  for (const pattern of policyPresentationPatterns) {
    policyScope = policyScope.replaceAll(pattern, " ")
  }
  return policyDomainPatterns.some((pattern) => pattern.test(policyScope))
}

function validItems(
  value: readonly string[],
  maximumItems: number,
  maximumItem: number,
): boolean {
  return (
    value.length <= maximumItems &&
    value.every(
      (item) => isContextText(item, maximumItem, false) && item === item.trim(),
    )
  )
}

export function firstInvalidProjectContextField(
  value: ProjectContext,
): keyof ProjectContext | null {
  return projectContextValidationIssue(value)?.field ?? null
}

export function projectContextValidationIssue(
  value: ProjectContext,
): WorkspaceContextValidationIssue<keyof ProjectContext> | null {
  if (!isContextText(value.goal, 8_000)) {
    return { field: "goal", reason: "text" }
  }
  if (!isContextText(value.constraints, 8_000)) {
    return { field: "constraints", reason: "text" }
  }
  if (!validItems(value.definitionOfDone, 20, 500)) {
    return { field: "definitionOfDone", reason: "items" }
  }
  if (!validItems(value.technicalReferences, 20, 500)) {
    return { field: "technicalReferences", reason: "items" }
  }
  if (!value.technicalReferences.every(validTechnicalReference)) {
    return { field: "technicalReferences", reason: "technicalReference" }
  }
  if (!isContextText(value.userNotes, 8_000)) {
    return { field: "userNotes", reason: "text" }
  }
  const total =
    unicodeScalarCount(value.goal) +
    unicodeScalarCount(value.constraints) +
    unicodeScalarCount(value.userNotes) +
    value.definitionOfDone.reduce(
      (sum, item) => sum + unicodeScalarCount(item),
      0,
    ) +
    value.technicalReferences.reduce(
      (sum, item) => sum + unicodeScalarCount(item),
      0,
    )
  return total > 32_000 ? { field: "userNotes", reason: "total" } : null
}

export function firstInvalidCharacterContextField(
  value: CharacterContext,
): keyof CharacterContext | null {
  return characterContextValidationIssue(value)?.field ?? null
}

export function characterContextValidationIssue(
  value: CharacterContext,
): WorkspaceContextValidationIssue<keyof CharacterContext> | null {
  if (
    !isContextText(value.displayName, 40, false) ||
    value.displayName !== value.displayName.trim()
  ) {
    return {
      field: "displayName",
      reason: value.displayName.trim().length === 0 ? "required" : "text",
    }
  }
  if (containsNonPresentationPolicyDomain(value.displayName)) {
    return { field: "displayName", reason: "policy" }
  }
  if (!isContextText(value.toneNotes, 1_000)) {
    return { field: "toneNotes", reason: "text" }
  }
  if (containsNonPresentationPolicyDomain(value.toneNotes)) {
    return { field: "toneNotes", reason: "policy" }
  }
  if (!isContextText(value.behavior, 4_000)) {
    return { field: "behavior", reason: "text" }
  }
  if (containsNonPresentationPolicyDomain(value.behavior)) {
    return { field: "behavior", reason: "policy" }
  }
  if (!validItems(value.prohibitedExpressions, 20, 200)) {
    return { field: "prohibitedExpressions", reason: "items" }
  }
  if (value.prohibitedExpressions.some(containsNonPresentationPolicyDomain)) {
    return { field: "prohibitedExpressions", reason: "policy" }
  }
  const policyValues = [
    value.displayName,
    value.toneNotes,
    value.behavior,
    ...value.prohibitedExpressions,
  ]
  const total =
    policyValues.reduce((sum, item) => sum + unicodeScalarCount(item), 0) +
    unicodeScalarCount(value.tone) +
    unicodeScalarCount(value.speechDensity)
  return total > 12_000 ? { field: "behavior", reason: "total" } : null
}

export function parseProjectContext(value: unknown): ProjectContext {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "goal",
      "constraints",
      "definitionOfDone",
      "technicalReferences",
      "userNotes",
    ]) ||
    !isContextText(value.goal, 8_000) ||
    !isContextText(value.constraints, 8_000) ||
    !isContextText(value.userNotes, 8_000)
  ) {
    return violation()
  }
  const definitionOfDone = parseItems(value.definitionOfDone, 20, 500)
  const technicalReferences = parseItems(value.technicalReferences, 20, 500)
  if (!technicalReferences.every(validTechnicalReference)) return violation()
  const total =
    unicodeScalarCount(value.goal) +
    unicodeScalarCount(value.constraints) +
    unicodeScalarCount(value.userNotes) +
    definitionOfDone.reduce((sum, item) => sum + unicodeScalarCount(item), 0) +
    technicalReferences.reduce((sum, item) => sum + unicodeScalarCount(item), 0)
  if (total > 32_000) return violation()
  return {
    goal: value.goal,
    constraints: value.constraints,
    definitionOfDone,
    technicalReferences,
    userNotes: value.userNotes,
  }
}

export function normalizeProjectContextForSave(
  value: ProjectContext,
): ProjectContext {
  const technicalReferences = value.technicalReferences.map((reference) => {
    const normalized = normalizeTechnicalReference(reference)
    if (normalized === null) return violation()
    return normalized
  })
  return parseProjectContext({ ...value, technicalReferences })
}

export function parseCharacterContext(value: unknown): CharacterContext {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "displayName",
      "tone",
      "toneNotes",
      "speechDensity",
      "behavior",
      "prohibitedExpressions",
    ]) ||
    !isContextText(value.displayName, 40, false) ||
    value.displayName !== value.displayName.trim() ||
    !["concise", "warm", "neutral"].includes(String(value.tone)) ||
    !isContextText(value.toneNotes, 1_000) ||
    !["quiet", "key_events", "detailed"].includes(
      String(value.speechDensity),
    ) ||
    !isContextText(value.behavior, 4_000)
  ) {
    return violation()
  }
  const prohibitedExpressions = parseItems(value.prohibitedExpressions, 20, 200)
  const policyValues = [
    value.displayName,
    value.toneNotes,
    value.behavior,
    ...prohibitedExpressions,
  ]
  if (policyValues.some(containsNonPresentationPolicyDomain)) return violation()
  const total =
    policyValues.reduce((sum, item) => sum + unicodeScalarCount(item), 0) +
    unicodeScalarCount(String(value.tone)) +
    unicodeScalarCount(String(value.speechDensity))
  if (total > 12_000) return violation()
  return {
    displayName: value.displayName,
    tone: value.tone as CharacterTone,
    toneNotes: value.toneNotes,
    speechDensity: value.speechDensity as SpeechDensity,
    behavior: value.behavior,
    prohibitedExpressions,
  }
}

function parseVersionedProject(value: unknown): VersionedProjectContext {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "projectId",
      "version",
      "contentHash",
      "updatedAt",
      "context",
    ]) ||
    value.schemaVersion !== workspaceContextSchemaVersion ||
    typeof value.projectId !== "string" ||
    !workspaceIdPattern.test(value.projectId) ||
    !isSafePositiveInteger(value.version) ||
    typeof value.contentHash !== "string" ||
    !hashPattern.test(value.contentHash) ||
    !isTimestamp(value.updatedAt)
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    projectId: value.projectId,
    version: value.version,
    contentHash: value.contentHash,
    updatedAt: value.updatedAt,
    context: parseProjectContext(value.context),
  }
}

function parseVersionedCharacter(value: unknown): VersionedCharacterContext {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "version",
      "contentHash",
      "updatedAt",
      "context",
    ]) ||
    value.schemaVersion !== workspaceContextSchemaVersion ||
    !isSafePositiveInteger(value.version) ||
    typeof value.contentHash !== "string" ||
    !hashPattern.test(value.contentHash) ||
    !isTimestamp(value.updatedAt)
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    version: value.version,
    contentHash: value.contentHash,
    updatedAt: value.updatedAt,
    context: parseCharacterContext(value.context),
  }
}

export function parseWorkspaceEditableContext(
  value: unknown,
): WorkspaceEditableContext {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "workspaceId",
      "project",
      "character",
    ]) ||
    value.schemaVersion !== workspaceContextSchemaVersion ||
    typeof value.workspaceId !== "string" ||
    !workspaceIdPattern.test(value.workspaceId)
  ) {
    return violation()
  }
  const project = parseVersionedProject(value.project)
  const character = parseVersionedCharacter(value.character)
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    project,
    character,
  }
}

export function parseVersionedProjectContext(
  value: unknown,
): VersionedProjectContext {
  return parseVersionedProject(value)
}

export function parseVersionedCharacterContext(
  value: unknown,
): VersionedCharacterContext {
  return parseVersionedCharacter(value)
}

export function parseWorkspaceTurnContextSnapshot(
  value: unknown,
): WorkspaceTurnContextSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "workspaceId",
      "projectVersion",
      "projectHash",
      "characterVersion",
      "characterHash",
      "snapshotHash",
      "capturedAt",
      "project",
      "character",
    ]) ||
    value.schemaVersion !== workspaceContextSchemaVersion ||
    typeof value.workspaceId !== "string" ||
    !workspaceIdPattern.test(value.workspaceId) ||
    !isSafePositiveInteger(value.projectVersion) ||
    typeof value.projectHash !== "string" ||
    !hashPattern.test(value.projectHash) ||
    !isSafePositiveInteger(value.characterVersion) ||
    typeof value.characterHash !== "string" ||
    !hashPattern.test(value.characterHash) ||
    typeof value.snapshotHash !== "string" ||
    !hashPattern.test(value.snapshotHash) ||
    !isTimestamp(value.capturedAt)
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    projectVersion: value.projectVersion,
    projectHash: value.projectHash,
    characterVersion: value.characterVersion,
    characterHash: value.characterHash,
    snapshotHash: value.snapshotHash,
    capturedAt: value.capturedAt,
    project: parseProjectContext(value.project),
    character: parseCharacterContext(value.character),
  }
}
