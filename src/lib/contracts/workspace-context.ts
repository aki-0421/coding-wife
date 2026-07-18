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
  readonly workspaceId: string
  readonly version: number
  readonly contentHash: string
  readonly updatedAt: string
  readonly context: ProjectContext
}

export interface VersionedCharacterContext {
  readonly schemaVersion: typeof workspaceContextSchemaVersion
  readonly workspaceId: string
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

export interface WorkspaceSaveProjectContextRequest {
  readonly workspaceId: string
  readonly expectedVersion: number
  readonly context: ProjectContext
}

export interface WorkspaceSaveCharacterContextRequest {
  readonly workspaceId: string
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

export class WorkspaceContextContractError extends Error {
  constructor() {
    super("The value did not match the workspace context contract.")
    this.name = "WorkspaceContextContractError"
  }
}

const workspaceIdPattern = /^[A-Za-z0-9-]{1,128}$/u
const hashPattern = /^[0-9a-f]{64}$/u
const policyKeys = [
  "permission",
  "permissions",
  "approval",
  "approvals",
  "model",
  "models",
  "tool",
  "tools",
  "git",
  "git_observer",
  "commit_skill",
  "verification",
  "privacy",
  "support_capability",
  "checkpoint_policy",
] as const
const policyActions = ["override", "bypass", "disable", "ignore"] as const

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
  return [...value]
}

function validTechnicalReference(value: string): boolean {
  if (value.startsWith("doc:")) {
    const documentId = value.slice(4)
    return (
      documentId.length > 0 &&
      !documentId.startsWith("/") &&
      documentId.split("/").every((part) => part.length > 0 && part !== "..") &&
      /^[A-Za-z0-9._/-]+$/u.test(documentId)
    )
  }
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes(":") &&
    value.split("/").every((part) => part.length > 0 && part !== "..")
  )
}

function normalizePolicyText(value: string): string {
  return value.toLocaleLowerCase().replaceAll(/[ -]/gu, "_")
}

function containsPolicyOverride(value: string): boolean {
  const normalized = normalizePolicyText(value)
  if (
    policyActions.some((action) => normalized.includes(action)) &&
    policyKeys.some((key) => normalized.includes(key))
  ) {
    return true
  }
  return normalized.split("\n").some((line) => {
    const candidate = line.replace(/^[\s{}\[\]*"'-]+/u, "")
    return policyKeys.some((key) => {
      if (!candidate.startsWith(key)) return false
      return /^["' ]*[:=]/u.test(candidate.slice(key.length))
    })
  })
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
  if (policyValues.some(containsPolicyOverride)) return violation()
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
      "workspaceId",
      "version",
      "contentHash",
      "updatedAt",
      "context",
    ]) ||
    value.schemaVersion !== workspaceContextSchemaVersion ||
    typeof value.workspaceId !== "string" ||
    !workspaceIdPattern.test(value.workspaceId) ||
    !isSafePositiveInteger(value.version) ||
    typeof value.contentHash !== "string" ||
    !hashPattern.test(value.contentHash) ||
    !isTimestamp(value.updatedAt)
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
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
      "workspaceId",
      "version",
      "contentHash",
      "updatedAt",
      "context",
    ]) ||
    value.schemaVersion !== workspaceContextSchemaVersion ||
    typeof value.workspaceId !== "string" ||
    !workspaceIdPattern.test(value.workspaceId) ||
    !isSafePositiveInteger(value.version) ||
    typeof value.contentHash !== "string" ||
    !hashPattern.test(value.contentHash) ||
    !isTimestamp(value.updatedAt)
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
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
  if (
    project.workspaceId !== value.workspaceId ||
    character.workspaceId !== value.workspaceId
  ) {
    return violation()
  }
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
