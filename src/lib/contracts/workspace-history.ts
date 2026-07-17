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
    | "code.session.status.changed"
    | "live.renderer.status.changed"
    | "hist.writer.status.changed"
    | "git.checkpoint.status.changed"
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

function containsPrivateMaterial(value: string): boolean {
  const lower = value.toLocaleLowerCase()
  return (
    /(?:^|[\s"'])\/(?:users|volumes|library|applications)\//i.test(value) ||
    /(?:bearer\s+[a-z0-9._~+/=-]{6,}|(?:api[_-]?key|auth[_-]?cookie|sessionid|set-cookie)\s*[:=])/i.test(
      value,
    ) ||
    lower.includes("chain-of-thought")
  )
}

function validatePublicString(value: unknown, maximum = 512): value is string {
  return isString(value, maximum) && !containsPrivateMaterial(value)
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
    typeof value.text !== "string" ||
    value.text.length > 128_000 ||
    value.text.includes("\0") ||
    containsPrivateMaterial(value.text) ||
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

function parseEventPayload(
  producer: unknown,
  kind: unknown,
  payload: unknown,
): {
  readonly producer: PersistedTimelineEvent["producer"]
  readonly kind: PersistedTimelineEvent["kind"]
  readonly payload: Readonly<Record<string, unknown>>
} {
  if (!isRecord(payload)) return violation()
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
    producer === "code" &&
    kind === "code.session.status.changed" &&
    hasExactKeys(payload, ["status"]) &&
    oneOf(payload.status, [
      "idle",
      "running",
      "waiting",
      "interrupted",
      "failed",
      "completed",
    ] as const)
  ) {
    return { producer, kind, payload: { status: payload.status } }
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
    value.schemaVersion !== workspaceHistorySchemaVersion ||
    !validatePublicString(value.eventId, 128) ||
    !validatePublicString(value.workspaceId, 128) ||
    !(value.sessionId === null || validatePublicString(value.sessionId, 128)) ||
    !isSafeUnsignedInteger(value.sequence) ||
    !isTimestamp(value.occurredAt)
  ) {
    return violation()
  }
  const event = parseEventPayload(value.producer, value.kind, value.payload)
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
