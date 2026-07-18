import {
  containsPrivateMaterial,
  isPublicMultilineText,
  isPublicSingleLineText,
} from "@/lib/public-text"
import { parsePendingRequest, type PendingRequestView } from "./codex"

export const workspaceHistorySchemaVersion = 1 as const

export const workspaceHistoryCommands = {
  list: "workspace_list",
  pickRegister: "workspace_pick_register",
  createSession: "workspace_create_session",
  select: "workspace_select",
  updateLifecycle: "workspace_update_lifecycle",
  saveDraft: "workspace_save_draft",
  saveContextSnapshot: "workspace_save_context_snapshot",
  listTimeline: "workspace_list_timeline",
  issueDeleteChallenge: "workspace_issue_delete_challenge",
  delete: "workspace_delete",
  appendDomainEvent: "history_append_domain_event",
} as const

export type WorkspaceHistoryMode =
  "ready" | "ephemeral" | "read_only" | "recovery_required"
export type WorkspaceLifecycle =
  "backlog" | "in_progress" | "in_review" | "done" | "canceled"
export type WorkspaceAttention =
  "needs_answer" | "approval_required" | "test_failed" | "high_risk"
export type WorkspaceHealth =
  "ready" | "missing" | "changed" | "unreadable" | "read_only"
export type WorkspaceReasoningEffort = "fast" | "max"
export type WorkspaceContextSource = "files" | "git_diff" | "terminal_output"

export interface WorkspaceHistoryStatus {
  readonly schemaVersion: typeof workspaceHistorySchemaVersion
  readonly mode: WorkspaceHistoryMode
  readonly errorCode: string | null
  readonly backupName: string | null
}

export interface PersistedWorkspaceSummary {
  readonly schemaVersion: typeof workspaceHistorySchemaVersion
  readonly workspaceId: string
  readonly projectId: string
  readonly repository: string
  readonly name: string
  readonly branch: string
  readonly head: string
  readonly detached: boolean
  readonly lifecycle: WorkspaceLifecycle
  readonly attention: WorkspaceAttention | null
  readonly health: WorkspaceHealth
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastSelectedAt: string | null
}

export interface PersistedWorkspaceDraft {
  readonly schemaVersion: typeof workspaceHistorySchemaVersion
  readonly workspaceId: string
  readonly text: string
  readonly effort: WorkspaceReasoningEffort
  readonly revision: number
  readonly updatedAt: string
}

export interface PersistedContextSnapshot {
  readonly schemaVersion: typeof workspaceHistorySchemaVersion
  readonly snapshotId: string
  readonly workspaceId: string
  readonly source: WorkspaceContextSource
  readonly label: string
  readonly capturedAt: string
  readonly byteCount: number
  readonly contentHash: string
}

export interface PersistedTimelineEvent {
  readonly schemaVersion: typeof workspaceHistorySchemaVersion
  readonly eventId: string
  readonly workspaceId: string
  readonly sessionId: string | null
  readonly sequence: number
  readonly producer: "app" | "work" | "code" | "live" | "hist" | "git"
  readonly kind:
    | "app.runtime.changed"
    | "work.workspace.lifecycle.changed"
    | "code.thread.status.changed"
    | "code.session.status.changed"
    | "code.user.instruction.accepted"
    | "code.item.status.changed"
    | "code.message.completed"
    | "code.plan.updated"
    | "code.diff.updated"
    | "code.tool.output"
    | "code.file_change.updated"
    | "code.decision.requested"
    | "code.approval.requested"
    | "code.pending.resolved"
    | "code.session.diagnostic"
    | "code.model.violation"
    | "code.protocol.unsupported"
    | "code.unsupported"
    | "live.renderer.status.changed"
    | "hist.writer.status.changed"
    | "git.checkpoint.status.changed"
    | "git.checkpoint.operation.changed"
    | "git.review_pack.recorded"
  readonly occurredAt: string
  readonly payload: Readonly<Record<string, unknown>>
}

export interface PersistedTimelinePage {
  readonly schemaVersion: typeof workspaceHistorySchemaVersion
  readonly items: readonly PersistedTimelineEvent[]
  readonly nextBeforeSequence: number | null
}

export interface WorkspaceStateSnapshot {
  readonly schemaVersion: typeof workspaceHistorySchemaVersion
  readonly history: WorkspaceHistoryStatus
  readonly workspaces: readonly PersistedWorkspaceSummary[]
  readonly activeWorkspaceId: string | null
  readonly draft: PersistedWorkspaceDraft | null
  readonly contextSnapshots: readonly PersistedContextSnapshot[]
  readonly timeline: PersistedTimelinePage
}

export interface WorkspacePickResponse {
  readonly schemaVersion: typeof workspaceHistorySchemaVersion
  readonly outcome: "selected" | "canceled"
  readonly state: WorkspaceStateSnapshot
}

export interface WorkspaceCreateSessionRequest {
  readonly fromWorkspaceId: string
  readonly name: string
  readonly goal: string
  readonly clientRequestId: string
}

export interface WorkspaceSelectRequest {
  readonly workspaceId: string
}

export interface WorkspaceUpdateLifecycleRequest {
  readonly workspaceId: string
  readonly lifecycle: WorkspaceLifecycle
  readonly expectedUpdatedAt: string
}

export interface WorkspaceSaveDraftRequest {
  readonly workspaceId: string
  readonly text: string
  readonly effort: WorkspaceReasoningEffort
  readonly expectedRevision: number
}

export interface WorkspaceSaveContextRequest {
  readonly workspaceId: string
  readonly source: WorkspaceContextSource
}

export interface WorkspaceTimelineRequest {
  readonly workspaceId: string
  readonly beforeSequence: number | null
  readonly limit: number
  readonly search: string | null
}

export interface WorkspaceDeleteChallengeRequest {
  readonly workspaceId: string
}

export interface WorkspaceDeleteChallenge {
  readonly schemaVersion: typeof workspaceHistorySchemaVersion
  readonly workspaceId: string
  readonly token: string
  readonly expiresAt: string
}

export interface WorkspaceDeleteRequest {
  readonly workspaceId: string
  readonly token: string
}

export interface AppendDomainEventRequest {
  readonly schemaVersion: typeof workspaceHistorySchemaVersion
  readonly eventId: string
  readonly workspaceId: string
  readonly sessionId: string | null
  readonly producer: string
  readonly kind: string
  readonly occurredAt: string
  readonly payload: Readonly<Record<string, unknown>>
}

export interface AppendDomainEventResponse {
  readonly schemaVersion: typeof workspaceHistorySchemaVersion
  readonly sequence: number
  readonly inserted: boolean
}

export interface WorkspaceCommandErrorEnvelope {
  readonly code: string
  readonly operation: WorkspaceHistoryCommand
  readonly recoverable: boolean
  readonly userMessageKey: string
  readonly detailRef?: string
}

export interface WorkspaceHistoryRequestMap {
  workspace_list: undefined
  workspace_pick_register: undefined
  workspace_create_session: WorkspaceCreateSessionRequest
  workspace_select: WorkspaceSelectRequest
  workspace_update_lifecycle: WorkspaceUpdateLifecycleRequest
  workspace_save_draft: WorkspaceSaveDraftRequest
  workspace_save_context_snapshot: WorkspaceSaveContextRequest
  workspace_list_timeline: WorkspaceTimelineRequest
  workspace_issue_delete_challenge: WorkspaceDeleteChallengeRequest
  workspace_delete: WorkspaceDeleteRequest
  history_append_domain_event: AppendDomainEventRequest
}

export interface WorkspaceHistoryResponseMap {
  workspace_list: WorkspaceStateSnapshot
  workspace_pick_register: WorkspacePickResponse
  workspace_create_session: WorkspaceStateSnapshot
  workspace_select: WorkspaceStateSnapshot
  workspace_update_lifecycle: PersistedWorkspaceSummary
  workspace_save_draft: PersistedWorkspaceDraft
  workspace_save_context_snapshot: PersistedContextSnapshot
  workspace_list_timeline: PersistedTimelinePage
  workspace_issue_delete_challenge: WorkspaceDeleteChallenge
  workspace_delete: WorkspaceStateSnapshot
  history_append_domain_event: AppendDomainEventResponse
}

export type WorkspaceHistoryCommand = keyof WorkspaceHistoryRequestMap &
  keyof WorkspaceHistoryResponseMap

export class WorkspaceHistoryContractError extends Error {
  constructor() {
    super("The value did not match the workspace history contract.")
    this.name = "WorkspaceHistoryContractError"
  }
}

const workspaceKeys = [
  "schemaVersion",
  "workspaceId",
  "projectId",
  "repository",
  "name",
  "branch",
  "head",
  "detached",
  "lifecycle",
  "attention",
  "health",
  "createdAt",
  "updatedAt",
  "lastSelectedAt",
] as const

function violation(): never {
  throw new WorkspaceHistoryContractError()
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  )
}

function isString(value: unknown, maximum = 512): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  )
}

function isNullableString(
  value: unknown,
  maximum = 512,
): value is string | null {
  return value === null || isString(value, maximum)
}

function isTimestamp(value: unknown): value is string {
  return (
    isString(value, 64) &&
    value.includes("T") &&
    Number.isFinite(Date.parse(value))
  )
}

function isSafeUnsignedInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && allowed.some((item) => item === value)
}

function validatePublicString(value: unknown, maximum = 512): value is string {
  return isPublicSingleLineText(value, maximum)
}

function parseHistoryStatus(value: unknown): WorkspaceHistoryStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "mode",
      "errorCode",
      "backupName",
    ]) ||
    value.schemaVersion !== workspaceHistorySchemaVersion ||
    !oneOf(value.mode, [
      "ready",
      "ephemeral",
      "read_only",
      "recovery_required",
    ] as const) ||
    !isNullableString(value.errorCode, 128) ||
    !isNullableString(value.backupName, 255) ||
    (typeof value.backupName === "string" && /[\\/]/.test(value.backupName)) ||
    (value.mode === "ephemeral" &&
      (value.errorCode !== null || value.backupName !== null))
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    mode: value.mode,
    errorCode: value.errorCode,
    backupName: value.backupName,
  }
}

export function parsePersistedWorkspaceSummary(
  value: unknown,
): PersistedWorkspaceSummary {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, workspaceKeys) ||
    value.schemaVersion !== workspaceHistorySchemaVersion ||
    !validatePublicString(value.workspaceId, 128) ||
    !validatePublicString(value.projectId, 128) ||
    !validatePublicString(value.repository, 80) ||
    !validatePublicString(value.name, 80) ||
    !validatePublicString(value.branch, 240) ||
    !validatePublicString(value.head, 64) ||
    typeof value.detached !== "boolean" ||
    !oneOf(value.lifecycle, [
      "backlog",
      "in_progress",
      "in_review",
      "done",
      "canceled",
    ] as const) ||
    !(
      value.attention === null ||
      oneOf(value.attention, [
        "needs_answer",
        "approval_required",
        "test_failed",
        "high_risk",
      ] as const)
    ) ||
    !oneOf(value.health, [
      "ready",
      "missing",
      "changed",
      "unreadable",
      "read_only",
    ] as const) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !(value.lastSelectedAt === null || isTimestamp(value.lastSelectedAt))
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    repository: value.repository,
    name: value.name,
    branch: value.branch,
    head: value.head,
    detached: value.detached,
    lifecycle: value.lifecycle,
    attention: value.attention,
    health: value.health,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastSelectedAt: value.lastSelectedAt,
  }
}

export function parsePersistedWorkspaceDraft(
  value: unknown,
): PersistedWorkspaceDraft {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "workspaceId",
      "text",
      "effort",
      "revision",
      "updatedAt",
    ]) ||
    value.schemaVersion !== workspaceHistorySchemaVersion ||
    !validatePublicString(value.workspaceId, 128) ||
    !isPublicMultilineText(value.text, 128_000, true) ||
    !oneOf(value.effort, ["fast", "max"] as const) ||
    !isSafeUnsignedInteger(value.revision) ||
    !isTimestamp(value.updatedAt)
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    text: value.text,
    effort: value.effort,
    revision: value.revision,
    updatedAt: value.updatedAt,
  }
}

export function parsePersistedContextSnapshot(
  value: unknown,
): PersistedContextSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "snapshotId",
      "workspaceId",
      "source",
      "label",
      "capturedAt",
      "byteCount",
      "contentHash",
    ]) ||
    value.schemaVersion !== workspaceHistorySchemaVersion ||
    !validatePublicString(value.snapshotId, 128) ||
    !validatePublicString(value.workspaceId, 128) ||
    !oneOf(value.source, ["files", "git_diff", "terminal_output"] as const) ||
    !validatePublicString(value.label, 512) ||
    !isTimestamp(value.capturedAt) ||
    !isSafeUnsignedInteger(value.byteCount) ||
    typeof value.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.contentHash)
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    snapshotId: value.snapshotId,
    workspaceId: value.workspaceId,
    source: value.source,
    label: value.label,
    capturedAt: value.capturedAt,
    byteCount: value.byteCount,
    contentHash: value.contentHash,
  }
}

const codexHistoryBaseKeys = [
  "semanticVersion",
  "generation",
  "sourceSequence",
] as const

function isPublicText(value: unknown, maximum: number): value is string {
  return isPublicMultilineText(value, maximum, true)
}

function hasCodexHistoryShape(
  payload: Readonly<Record<string, unknown>>,
  required: readonly string[],
): boolean {
  return (
    hasExactKeys(payload, [...codexHistoryBaseKeys, ...required]) &&
    payload.semanticVersion === 1 &&
    isSafeUnsignedInteger(payload.generation) &&
    payload.generation > 0 &&
    isSafeUnsignedInteger(payload.sourceSequence)
  )
}

function isPersistedPendingRequestPublic(request: PendingRequestView): boolean {
  if (
    !isPublicSingleLineText(request.pendingId, 128) ||
    !isPublicSingleLineText(request.operation, 128) ||
    !isPublicSingleLineText(request.targetAlias, 256) ||
    (request.reason !== null &&
      !isPublicMultilineText(request.reason, 4_096, true))
  ) {
    return false
  }
  for (const question of request.questions) {
    if (
      !isPublicSingleLineText(question.id, 128) ||
      !isPublicSingleLineText(question.header, 256) ||
      !isPublicMultilineText(question.question, 4_096)
    ) {
      return false
    }
    for (const option of question.options) {
      if (
        !isPublicSingleLineText(option.id, 128) ||
        !isPublicSingleLineText(option.label, 256) ||
        !isPublicMultilineText(option.description, 1_024, true)
      ) {
        return false
      }
    }
  }
  const context = request.decisionContext
  return (
    isPublicSingleLineText(context.targetAlias, 256) &&
    (context.recommendation === null ||
      isPublicSingleLineText(context.recommendation, 256)) &&
    context.evidence.length >= 1 &&
    context.evidence.length <= 8 &&
    context.evidence.every((item) => isPublicMultilineText(item, 512))
  )
}

function parseCodexHistoryPayload(
  kind: unknown,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  if (
    kind === "code.thread.status.changed" &&
    hasCodexHistoryShape(payload, ["threadHandle", "status"]) &&
    validatePublicString(payload.threadHandle, 128) &&
    oneOf(payload.status, [
      "active",
      "idle",
      "systemError",
      "notLoaded",
    ] as const)
  ) {
    return { ...payload }
  }
  if (
    kind === "code.session.status.changed" &&
    hasCodexHistoryShape(payload, ["threadHandle", "turnHandle", "status"]) &&
    validatePublicString(payload.threadHandle, 128) &&
    validatePublicString(payload.turnHandle, 128) &&
    oneOf(payload.status, [
      "running",
      "inProgress",
      "waiting",
      "interrupted",
      "failed",
      "completed",
      "canceled",
    ] as const)
  ) {
    return { ...payload }
  }
  if (
    kind === "code.user.instruction.accepted" &&
    hasCodexHistoryShape(payload, ["text", "effort", "attachmentCount"]) &&
    isPublicText(payload.text, 64 * 1024) &&
    oneOf(payload.effort, ["low", "max"] as const) &&
    isSafeUnsignedInteger(payload.attachmentCount) &&
    payload.attachmentCount <= 10
  ) {
    return { ...payload }
  }
  if (
    kind === "code.item.status.changed" &&
    hasCodexHistoryShape(payload, ["itemHandle", "itemType", "status"]) &&
    validatePublicString(payload.itemHandle, 128) &&
    oneOf(payload.itemType, [
      "agentMessage",
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "webSearch",
      "plan",
      "userMessage",
      "enteredReviewMode",
      "exitedReviewMode",
      "contextCompaction",
    ] as const) &&
    oneOf(payload.status, ["running", "completed"] as const)
  ) {
    return { ...payload }
  }
  if (
    kind === "code.message.completed" &&
    hasCodexHistoryShape(payload, ["itemHandle", "text"]) &&
    validatePublicString(payload.itemHandle, 128) &&
    isPublicText(payload.text, 64 * 1024)
  ) {
    return { ...payload }
  }
  if (
    kind === "code.plan.updated" &&
    hasCodexHistoryShape(payload, ["stepCount"]) &&
    isSafeUnsignedInteger(payload.stepCount) &&
    payload.stepCount <= 1_000
  ) {
    return { ...payload }
  }
  if (
    kind === "code.diff.updated" &&
    hasCodexHistoryShape(payload, ["byteCount", "detailRef"]) &&
    isSafeUnsignedInteger(payload.byteCount) &&
    payload.byteCount <= 1024 * 1024 &&
    validatePublicString(payload.detailRef, 128)
  ) {
    return { ...payload }
  }
  if (
    kind === "code.tool.output" &&
    hasCodexHistoryShape(payload, ["itemHandle", "excerpt"]) &&
    validatePublicString(payload.itemHandle, 128) &&
    isPublicText(payload.excerpt, 16 * 1024)
  ) {
    return { ...payload }
  }
  if (
    kind === "code.file_change.updated" &&
    hasCodexHistoryShape(payload, ["itemHandle", "pathAlias", "changeKind"]) &&
    validatePublicString(payload.itemHandle, 128) &&
    validatePublicString(payload.pathAlias, 512) &&
    oneOf(payload.changeKind, [
      "create",
      "update",
      "delete",
      "unknown",
    ] as const)
  ) {
    return { ...payload }
  }
  if (
    (kind === "code.decision.requested" ||
      kind === "code.approval.requested") &&
    hasCodexHistoryShape(payload, ["request"])
  ) {
    let request: PendingRequestView
    try {
      request = parsePendingRequest(payload.request)
    } catch {
      return null
    }
    if (!isPersistedPendingRequestPublic(request)) return null
    const approval = request.kind !== "user_input"
    if (
      (kind === "code.approval.requested" && !approval) ||
      (kind === "code.decision.requested" && approval)
    ) {
      return null
    }
    return { ...payload, request }
  }
  if (
    kind === "code.pending.resolved" &&
    hasCodexHistoryShape(payload, ["pendingId", "status"]) &&
    validatePublicString(payload.pendingId, 128) &&
    oneOf(payload.status, ["accepted", "expired", "failed"] as const)
  ) {
    return { ...payload }
  }
  if (
    kind === "code.session.diagnostic" &&
    hasCodexHistoryShape(payload, ["code", "willRetry", "detailRef"]) &&
    validatePublicString(payload.code, 128) &&
    typeof payload.willRetry === "boolean" &&
    validatePublicString(payload.detailRef, 128)
  ) {
    return { ...payload }
  }
  if (
    kind === "code.model.violation" &&
    hasCodexHistoryShape(payload, ["fromModel", "toModel"]) &&
    validatePublicString(payload.fromModel, 128) &&
    validatePublicString(payload.toModel, 128)
  ) {
    return { ...payload }
  }
  if (
    kind === "code.protocol.unsupported" &&
    hasCodexHistoryShape(payload, ["methodHash", "byteCount", "detailRef"]) &&
    validatePublicString(payload.methodHash, 128) &&
    isSafeUnsignedInteger(payload.byteCount) &&
    payload.byteCount <= 1024 * 1024 &&
    validatePublicString(payload.detailRef, 128)
  ) {
    return { ...payload }
  }
  return null
}

const gitOperationStates = [
  "prepared",
  "objects_ready",
  "ref_updated",
  "history_complete",
  "failed",
] as const

function isGitText(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.trim().length > 0) &&
    value.length <= maximum &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) ?? 0
      return (
        (code >= 32 && code !== 127) ||
        character === "\n" ||
        character === "\r" ||
        character === "\t"
      )
    }) &&
    !containsPrivateMaterial(value)
  )
}

function isGitId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 160 &&
    /^[A-Za-z0-9._-]+$/u.test(value)
  )
}

function isGitObjectId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/u.test(value)
  )
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-fA-F0-9]{64}$/u.test(value)
}

function isGitTargetReference(value: unknown): value is string {
  if (value === "HEAD") return true
  if (
    typeof value !== "string" ||
    !value.startsWith("refs/heads/") ||
    value.length > 251 ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".") ||
    value.endsWith("/") ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 32 || code === 127 || "~^:?*[\\".includes(character)
    })
  ) {
    return false
  }
  return value
    .split("/")
    .every(
      (component) =>
        component.length > 0 &&
        component !== "." &&
        !component.endsWith(".lock"),
    )
}

function isGitRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.startsWith("/") ||
    value.startsWith("-") ||
    value.includes("\\") ||
    value.includes(",") ||
    containsPrivateMaterial(value)
  ) {
    return false
  }
  const components = value.split("/")
  return components.every(
    (component) =>
      component.length > 0 &&
      component !== "." &&
      component !== ".." &&
      component.toLocaleLowerCase() !== ".git",
  )
}

function isBoundedUnsigned(value: unknown, maximum: number): value is number {
  return isSafeUnsignedInteger(value) && value <= maximum
}

function isGitGate(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "gate",
      "outcome",
      "reasonCodes",
      "observedRepositoryFingerprint",
    ]) &&
    oneOf(value.gate, [
      "scope",
      "ownership",
      "verification",
      "risk",
    ] as const) &&
    value.outcome === "pass" &&
    Array.isArray(value.reasonCodes) &&
    value.reasonCodes.length <= 20 &&
    value.reasonCodes.every((code) => isGitText(code, 256)) &&
    isSha256(value.observedRepositoryFingerprint)
  )
}

function isGitManifestEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "fileId",
      "relativePath",
      "changeKind",
      "ownership",
      "beforeHash",
      "afterHash",
      "additions",
      "deletions",
      "reasonCode",
    ]) &&
    isGitId(value.fileId) &&
    isGitRelativePath(value.relativePath) &&
    oneOf(value.changeKind, [
      "added",
      "modified",
      "deleted",
      "type_changed",
    ] as const) &&
    oneOf(value.ownership, [
      "owned",
      "pre_existing",
      "external",
      "overlap",
      "unowned",
    ] as const) &&
    (value.beforeHash === null || isSha256(value.beforeHash)) &&
    (value.afterHash === null || isSha256(value.afterHash)) &&
    isBoundedUnsigned(value.additions, 50_000) &&
    isBoundedUnsigned(value.deletions, 50_000) &&
    (value.reasonCode === null || isGitText(value.reasonCode, 256))
  )
}

function isGitVerification(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "evidenceId",
      "check",
      "result",
      "durationMs",
      "summary",
      "observedRepositoryFingerprint",
    ]) &&
    isGitId(value.evidenceId) &&
    isGitText(value.check, 512) &&
    value.result === "passed" &&
    isBoundedUnsigned(value.durationMs, 24 * 60 * 60 * 1000) &&
    isGitText(value.summary, 4096, true) &&
    isSha256(value.observedRepositoryFingerprint)
  )
}

function isGitDecision(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "decisionId",
      "summary",
      "answer",
      "rationale",
      "reversible",
    ]) &&
    isGitId(value.decisionId) &&
    isGitText(value.summary, 2048) &&
    isGitText(value.answer, 2048) &&
    isGitText(value.rationale, 4096, true) &&
    typeof value.reversible === "boolean"
  )
}

function isGitFailedAttempt(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["attemptId", "approach", "outcome", "learning"]) &&
    isGitId(value.attemptId) &&
    isGitText(value.approach, 2048) &&
    isGitText(value.outcome, 1024) &&
    isGitText(value.learning, 2048, true)
  )
}

function isGitRisk(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "riskId",
      "category",
      "level",
      "summary",
      "mitigation",
      "resolved",
    ]) &&
    isGitId(value.riskId) &&
    isGitText(value.category, 256) &&
    oneOf(value.level, ["low", "medium", "high", "critical"] as const) &&
    isGitText(value.summary, 2048) &&
    isGitText(value.mitigation, 2048, true) &&
    typeof value.resolved === "boolean"
  )
}

function isGitCheckpoint(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "checkpointId",
      "commitSha",
      "parentSha",
      "targetReference",
      "message",
      "authorName",
      "authorEmail",
      "createdAt",
    ]) &&
    isGitId(value.checkpointId) &&
    isGitObjectId(value.commitSha) &&
    isGitObjectId(value.parentSha) &&
    value.commitSha !== value.parentSha &&
    isGitTargetReference(value.targetReference) &&
    isGitText(value.message, 8 * 1024) &&
    isGitText(value.authorName, 256) &&
    isGitText(value.authorEmail, 512) &&
    isTimestamp(value.createdAt)
  )
}

function isGitDiffSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "filesChanged",
      "additions",
      "deletions",
      "binaryFiles",
      "totalBytes",
    ]) &&
    isBoundedUnsigned(value.filesChanged, 500) &&
    isBoundedUnsigned(value.additions, 50_000) &&
    isBoundedUnsigned(value.deletions, 50_000) &&
    value.additions + value.deletions <= 50_000 &&
    isBoundedUnsigned(value.binaryFiles, value.filesChanged) &&
    isBoundedUnsigned(value.totalBytes, 50 * 1024 * 1024)
  )
}

function isGitOperationPayload(
  payload: Readonly<Record<string, unknown>>,
  workspaceId: string,
): boolean {
  if (
    !hasExactKeys(
      payload,
      [
        "schemaVersion",
        "operationId",
        "clientRequestId",
        "workspaceId",
        "workUnitId",
        "baselineId",
        "state",
        "expectedHeadSha",
        "targetReference",
        "observedAt",
      ],
      ["commitSha", "packDigest", "errorCode"],
    ) ||
    payload.schemaVersion !== 1 ||
    payload.workspaceId !== workspaceId ||
    !isGitId(payload.operationId) ||
    !isGitId(payload.clientRequestId) ||
    !isGitId(payload.workspaceId) ||
    !isGitId(payload.workUnitId) ||
    !isGitId(payload.baselineId) ||
    !oneOf(payload.state, gitOperationStates) ||
    !isGitObjectId(payload.expectedHeadSha) ||
    !isGitTargetReference(payload.targetReference) ||
    !(
      payload.commitSha === undefined ||
      payload.commitSha === null ||
      isGitObjectId(payload.commitSha)
    ) ||
    !(
      payload.packDigest === undefined ||
      payload.packDigest === null ||
      isSha256(payload.packDigest)
    ) ||
    !(
      payload.errorCode === undefined ||
      payload.errorCode === null ||
      isGitText(payload.errorCode, 160)
    ) ||
    !isTimestamp(payload.observedAt) ||
    (payload.packDigest !== undefined &&
      payload.packDigest !== null &&
      (payload.commitSha === undefined || payload.commitSha === null))
  ) {
    return false
  }
  if (payload.state === "history_complete") {
    return (
      typeof payload.commitSha === "string" &&
      typeof payload.packDigest === "string" &&
      (payload.errorCode === undefined || payload.errorCode === null)
    )
  }
  if (payload.state === "failed") {
    return typeof payload.errorCode === "string"
  }
  return payload.errorCode === undefined || payload.errorCode === null
}

function isGitReviewPackPayload(
  payload: Readonly<Record<string, unknown>>,
  workspaceId: string,
): boolean {
  if (
    !hasExactKeys(
      payload,
      [
        "schemaVersion",
        "checkpoint",
        "workspaceId",
        "workUnitId",
        "objective",
        "acceptance",
        "gates",
        "manifest",
        "diffSummary",
        "verification",
        "decisions",
        "failedAttempts",
        "risks",
        "restoreGuidance",
        "operationState",
        "packDigest",
      ],
      ["historySequence"],
    ) ||
    payload.schemaVersion !== 1 ||
    payload.workspaceId !== workspaceId ||
    !isGitId(payload.workspaceId) ||
    !isGitId(payload.workUnitId) ||
    !isGitCheckpoint(payload.checkpoint) ||
    !isGitText(payload.objective, 500) ||
    !Array.isArray(payload.acceptance) ||
    payload.acceptance.length < 1 ||
    payload.acceptance.length > 20 ||
    !payload.acceptance.every((item) => isGitText(item, 1024)) ||
    !Array.isArray(payload.gates) ||
    payload.gates.length !== 4 ||
    !payload.gates.every(isGitGate) ||
    new Set(
      payload.gates.map((gate) =>
        isRecord(gate) && typeof gate.gate === "string" ? gate.gate : "",
      ),
    ).size !== 4 ||
    !Array.isArray(payload.manifest) ||
    payload.manifest.length < 1 ||
    payload.manifest.length > 500 ||
    !payload.manifest.every(isGitManifestEntry) ||
    !isGitDiffSummary(payload.diffSummary) ||
    !Array.isArray(payload.verification) ||
    payload.verification.length < 1 ||
    payload.verification.length > 100 ||
    !payload.verification.every(isGitVerification) ||
    !Array.isArray(payload.decisions) ||
    payload.decisions.length > 100 ||
    !payload.decisions.every(isGitDecision) ||
    !Array.isArray(payload.failedAttempts) ||
    payload.failedAttempts.length > 100 ||
    !payload.failedAttempts.every(isGitFailedAttempt) ||
    !Array.isArray(payload.risks) ||
    payload.risks.length > 100 ||
    !payload.risks.every(isGitRisk) ||
    !Array.isArray(payload.restoreGuidance) ||
    payload.restoreGuidance.length < 1 ||
    payload.restoreGuidance.length > 10 ||
    !payload.restoreGuidance.every((item) => isGitText(item, 4096)) ||
    payload.operationState !== "history_complete" ||
    !isSha256(payload.packDigest) ||
    !(payload.historySequence === undefined || payload.historySequence === null)
  ) {
    return false
  }
  return true
}

function parseGitHistoryPayload(
  kind: unknown,
  payload: Readonly<Record<string, unknown>>,
  workspaceId: string,
  sessionId: string | null,
): Readonly<Record<string, unknown>> | null {
  if (sessionId !== null) return null
  if (
    kind === "git.checkpoint.operation.changed" &&
    isGitOperationPayload(payload, workspaceId)
  ) {
    return payload
  }
  if (
    kind === "git.review_pack.recorded" &&
    isGitReviewPackPayload(payload, workspaceId)
  ) {
    return payload
  }
  return null
}

function parseEventPayload(
  producer: unknown,
  kind: unknown,
  payload: unknown,
  workspaceId: string,
  sessionId: string | null,
): {
  readonly producer: PersistedTimelineEvent["producer"]
  readonly kind: PersistedTimelineEvent["kind"]
  readonly payload: Readonly<Record<string, unknown>>
} {
  if (!isRecord(payload)) return violation()
  if (producer === "code") {
    const codexPayload = parseCodexHistoryPayload(kind, payload)
    if (codexPayload !== null) {
      return {
        producer,
        kind: kind as PersistedTimelineEvent["kind"],
        payload: codexPayload,
      }
    }
    return {
      producer,
      kind: "code.unsupported",
      payload: {
        status: "blocked",
        errorCode: "CODEX-HISTORY-UNSUPPORTED",
      },
    }
  }
  if (producer === "git") {
    const gitPayload = parseGitHistoryPayload(
      kind,
      payload,
      workspaceId,
      sessionId,
    )
    if (gitPayload !== null) {
      return {
        producer,
        kind: kind as PersistedTimelineEvent["kind"],
        payload: gitPayload,
      }
    }
  }
  if (
    producer === "app" &&
    kind === "app.runtime.changed" &&
    hasExactKeys(payload, ["mode", "state"]) &&
    oneOf(payload.mode, ["tauri", "demo"] as const) &&
    oneOf(payload.state, ["ready", "demo_only", "unavailable"] as const)
  ) {
    return {
      producer,
      kind,
      payload: { mode: payload.mode, state: payload.state },
    }
  }
  if (
    producer === "work" &&
    kind === "work.workspace.lifecycle.changed" &&
    hasExactKeys(payload, ["lifecycle"]) &&
    oneOf(payload.lifecycle, [
      "backlog",
      "in_progress",
      "in_review",
      "done",
      "canceled",
    ] as const)
  ) {
    return { producer, kind, payload: { lifecycle: payload.lifecycle } }
  }
  if (
    producer === "live" &&
    kind === "live.renderer.status.changed" &&
    hasExactKeys(payload, ["level"], ["errorCode"]) &&
    oneOf(payload.level, [
      "animated",
      "reduced",
      "static",
      "text_only",
    ] as const) &&
    (payload.errorCode === undefined ||
      validatePublicString(payload.errorCode, 128))
  ) {
    return {
      producer,
      kind,
      payload: {
        level: payload.level,
        ...(payload.errorCode === undefined
          ? {}
          : { errorCode: payload.errorCode }),
      },
    }
  }
  if (
    producer === "hist" &&
    kind === "hist.writer.status.changed" &&
    hasExactKeys(payload, ["status"], ["errorCode"]) &&
    oneOf(payload.status, ["ready", "read_only", "blocked"] as const) &&
    (payload.errorCode === undefined ||
      validatePublicString(payload.errorCode, 128))
  ) {
    return {
      producer,
      kind,
      payload: {
        status: payload.status,
        ...(payload.errorCode === undefined
          ? {}
          : { errorCode: payload.errorCode }),
      },
    }
  }
  if (
    producer === "git" &&
    kind === "git.checkpoint.status.changed" &&
    hasExactKeys(payload, ["status"], ["checkpointId"]) &&
    oneOf(payload.status, [
      "pending",
      "blocked",
      "review_ready",
      "failed",
    ] as const) &&
    (payload.checkpointId === undefined ||
      validatePublicString(payload.checkpointId, 128))
  ) {
    return {
      producer,
      kind,
      payload: {
        status: payload.status,
        ...(payload.checkpointId === undefined
          ? {}
          : { checkpointId: payload.checkpointId }),
      },
    }
  }
  return violation()
}

export function parsePersistedTimelineEvent(
  value: unknown,
): PersistedTimelineEvent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "eventId",
      "workspaceId",
      "sessionId",
      "sequence",
      "producer",
      "kind",
      "occurredAt",
      "payload",
    ]) ||
    !validatePublicString(value.eventId, 128) ||
    !validatePublicString(value.workspaceId, 128) ||
    !(value.sessionId === null || validatePublicString(value.sessionId, 128)) ||
    !isSafeUnsignedInteger(value.sequence) ||
    !isTimestamp(value.occurredAt)
  ) {
    return violation()
  }
  if (value.schemaVersion !== workspaceHistorySchemaVersion) {
    if (
      value.producer !== "code" ||
      !isSafeUnsignedInteger(value.schemaVersion) ||
      value.schemaVersion <= workspaceHistorySchemaVersion
    ) {
      return violation()
    }
    return {
      schemaVersion: 1,
      eventId: value.eventId,
      workspaceId: value.workspaceId,
      sessionId: value.sessionId,
      sequence: value.sequence,
      producer: "code",
      kind: "code.unsupported",
      occurredAt: value.occurredAt,
      payload: {
        status: "blocked",
        errorCode: "CODEX-HISTORY-UNSUPPORTED",
      },
    }
  }
  const event = parseEventPayload(
    value.producer,
    value.kind,
    value.payload,
    value.workspaceId,
    value.sessionId,
  )
  return {
    schemaVersion: 1,
    eventId: value.eventId,
    workspaceId: value.workspaceId,
    sessionId: value.sessionId,
    sequence: value.sequence,
    producer: event.producer,
    kind: event.kind,
    occurredAt: value.occurredAt,
    payload: event.payload,
  }
}

export function parsePersistedTimelinePage(
  value: unknown,
): PersistedTimelinePage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "items", "nextBeforeSequence"]) ||
    value.schemaVersion !== workspaceHistorySchemaVersion ||
    !Array.isArray(value.items) ||
    value.items.length > 200 ||
    !(
      value.nextBeforeSequence === null ||
      isSafeUnsignedInteger(value.nextBeforeSequence)
    )
  ) {
    return violation()
  }
  const items = value.items.map(parsePersistedTimelineEvent)
  if (
    items.some(
      (event, index) =>
        index > 0 && event.sequence <= items[index - 1]!.sequence,
    )
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    items,
    nextBeforeSequence: value.nextBeforeSequence,
  }
}

export function parseWorkspaceStateSnapshot(
  value: unknown,
): WorkspaceStateSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "history",
      "workspaces",
      "activeWorkspaceId",
      "draft",
      "contextSnapshots",
      "timeline",
    ]) ||
    value.schemaVersion !== workspaceHistorySchemaVersion ||
    !Array.isArray(value.workspaces) ||
    value.workspaces.length > 200 ||
    !Array.isArray(value.contextSnapshots) ||
    value.contextSnapshots.length > 10 ||
    !(
      value.activeWorkspaceId === null || isString(value.activeWorkspaceId, 128)
    )
  ) {
    return violation()
  }
  const workspaces = value.workspaces.map(parsePersistedWorkspaceSummary)
  const activeWorkspaceId = value.activeWorkspaceId
  if (
    activeWorkspaceId !== null &&
    !workspaces.some((workspace) => workspace.workspaceId === activeWorkspaceId)
  ) {
    return violation()
  }
  const draft =
    value.draft === null ? null : parsePersistedWorkspaceDraft(value.draft)
  const contextSnapshots = value.contextSnapshots.map(
    parsePersistedContextSnapshot,
  )
  if (
    (draft !== null && draft.workspaceId !== activeWorkspaceId) ||
    contextSnapshots.some(
      (snapshot) => snapshot.workspaceId !== activeWorkspaceId,
    )
  ) {
    return violation()
  }
  const timeline = parsePersistedTimelinePage(value.timeline)
  if (timeline.items.some((event) => event.workspaceId !== activeWorkspaceId)) {
    return violation()
  }
  return {
    schemaVersion: 1,
    history: parseHistoryStatus(value.history),
    workspaces,
    activeWorkspaceId,
    draft,
    contextSnapshots,
    timeline,
  }
}

export function parseWorkspacePickResponse(
  value: unknown,
): WorkspacePickResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "outcome", "state"]) ||
    value.schemaVersion !== workspaceHistorySchemaVersion ||
    !oneOf(value.outcome, ["selected", "canceled"] as const)
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    outcome: value.outcome,
    state: parseWorkspaceStateSnapshot(value.state),
  }
}

export function parseWorkspaceDeleteChallenge(
  value: unknown,
): WorkspaceDeleteChallenge {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "workspaceId",
      "token",
      "expiresAt",
    ]) ||
    value.schemaVersion !== workspaceHistorySchemaVersion ||
    !validatePublicString(value.workspaceId, 128) ||
    !validatePublicString(value.token, 128) ||
    !isTimestamp(value.expiresAt)
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    token: value.token,
    expiresAt: value.expiresAt,
  }
}

export function parseAppendDomainEventResponse(
  value: unknown,
): AppendDomainEventResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "sequence", "inserted"]) ||
    value.schemaVersion !== workspaceHistorySchemaVersion ||
    !isSafeUnsignedInteger(value.sequence) ||
    typeof value.inserted !== "boolean"
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    sequence: value.sequence,
    inserted: value.inserted,
  }
}

export function parseWorkspaceCommandError(
  value: unknown,
): WorkspaceCommandErrorEnvelope | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["code", "operation", "recoverable", "userMessageKey"],
      ["detailRef"],
    ) ||
    !validatePublicString(value.code, 128) ||
    !isWorkspaceHistoryCommand(value.operation) ||
    typeof value.recoverable !== "boolean" ||
    !validatePublicString(value.userMessageKey, 128) ||
    (value.detailRef !== undefined &&
      !validatePublicString(value.detailRef, 128))
  ) {
    return null
  }
  return {
    code: value.code,
    operation: value.operation,
    recoverable: value.recoverable,
    userMessageKey: value.userMessageKey,
    ...(value.detailRef === undefined ? {} : { detailRef: value.detailRef }),
  }
}

export function parseWorkspaceHistoryResponse<
  K extends WorkspaceHistoryCommand,
>(command: K, value: unknown): WorkspaceHistoryResponseMap[K] {
  switch (command) {
    case workspaceHistoryCommands.list:
    case workspaceHistoryCommands.createSession:
    case workspaceHistoryCommands.select:
    case workspaceHistoryCommands.delete:
      return parseWorkspaceStateSnapshot(
        value,
      ) as WorkspaceHistoryResponseMap[K]
    case workspaceHistoryCommands.pickRegister:
      return parseWorkspacePickResponse(value) as WorkspaceHistoryResponseMap[K]
    case workspaceHistoryCommands.updateLifecycle:
      return parsePersistedWorkspaceSummary(
        value,
      ) as WorkspaceHistoryResponseMap[K]
    case workspaceHistoryCommands.saveDraft:
      return parsePersistedWorkspaceDraft(
        value,
      ) as WorkspaceHistoryResponseMap[K]
    case workspaceHistoryCommands.saveContextSnapshot:
      return parsePersistedContextSnapshot(
        value,
      ) as WorkspaceHistoryResponseMap[K]
    case workspaceHistoryCommands.listTimeline:
      return parsePersistedTimelinePage(value) as WorkspaceHistoryResponseMap[K]
    case workspaceHistoryCommands.issueDeleteChallenge:
      return parseWorkspaceDeleteChallenge(
        value,
      ) as WorkspaceHistoryResponseMap[K]
    case workspaceHistoryCommands.appendDomainEvent:
      return parseAppendDomainEventResponse(
        value,
      ) as WorkspaceHistoryResponseMap[K]
  }
}

function isWorkspaceHistoryCommand(
  value: unknown,
): value is WorkspaceHistoryCommand {
  return Object.values(workspaceHistoryCommands).some(
    (command) => command === value,
  )
}
