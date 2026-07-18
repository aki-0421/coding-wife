export const codexAdapterVersion = 1 as const
export const codexEventSchemaVersion = 1 as const
export const codexModel = "gpt-5.6-sol" as const
export const codexEventChannel = "coding-wife://codex-event" as const

export const codexCommands = {
  pickWorkspace: "codex_pick_workspace",
  getDiagnostic: "codex_get_diagnostic",
  probe: "codex_probe",
  connect: "codex_connect",
  threadList: "codex_thread_list",
  threadStart: "codex_thread_start",
  threadResume: "codex_thread_resume",
  pickAttachments: "codex_pick_attachments",
  registerAttachmentPaths: "codex_register_attachment_paths",
  turnStart: "codex_turn_start",
  turnInterrupt: "codex_turn_interrupt",
  reviewStart: "codex_review_start",
  respondPending: "codex_respond_pending",
  answerFallbackDecision: "codex_answer_fallback_decision",
} as const

export type CapabilityState = "supported" | "unavailable" | "unverified"
export type CodexHealth =
  | "binary_missing"
  | "binary_untrusted"
  | "schema_unsupported"
  | "initializing"
  | "auth_required"
  | "model_unavailable"
  | "effort_unavailable"
  | "ready"
  | "disconnected"
  | "protocol_mismatch"
export type CodexChildState =
  | "stopped"
  | "probing"
  | "spawning"
  | "initializing"
  | "ready"
  | "restarting"
  | "stopping"
export type CodexBinarySource =
  "explicit" | "path" | "known_install" | "test_fixture"
export type ReasoningPreset = "low" | "max"
export type ApprovalDecision = "approve_once" | "reject" | "stop"
export type PendingKind =
  | "command_approval"
  | "file_change_approval"
  | "permissions_approval"
  | "user_input"

export interface CodexCapabilities {
  readonly coreLifecycle: CapabilityState
  readonly modelDiscovery: CapabilityState
  readonly nativeRequestUserInput: CapabilityState
  readonly dynamicTools: CapabilityState
  readonly permissionsApproval: CapabilityState
  readonly detachedReview: CapabilityState
  readonly ephemeralThread: CapabilityState
  readonly supportIsolation: CapabilityState
}

export interface CodexDiagnostic {
  readonly adapterVersion: typeof codexAdapterVersion
  readonly health: CodexHealth
  readonly checkedAt: string
  readonly operation: string
  readonly recoverable: boolean
  readonly cliVersion: string | null
  readonly binarySource: CodexBinarySource | null
  readonly binaryHashPrefix: string | null
  readonly schemaFingerprintPrefix: string | null
  readonly generatedBySameBinary: boolean
  readonly experimentalApiRequested: boolean
  readonly experimentalApiAccepted: boolean
  readonly accountPresent: boolean
  readonly authKind: string | null
  readonly requiresOpenaiAuth: boolean
  readonly modelAvailable: boolean
  readonly fastAvailable: boolean
  readonly maxAvailable: boolean
  readonly configModelPresent: boolean
  readonly childState: CodexChildState
  readonly lastSuccessfulHandshakeAt: string | null
  readonly capabilities: CodexCapabilities
  readonly errorCode: string | null
  readonly detailRef: string | null
}

export interface CodexConnectRequest {
  readonly workspaceId: string
}

export interface WorkspacePreflight {
  readonly gitRepository: true
  readonly ownedByCurrentUser: true
  readonly writable: true
}

export interface WorkspaceRegistration {
  readonly schemaVersion: 1
  readonly workspaceId: string
  readonly alias: string
  readonly preflight: WorkspacePreflight
}

export interface CodexThreadListRequest {
  readonly workspaceId: string
  readonly cursor: string | null
}

export interface CodexThreadStartRequest {
  readonly workspaceId: string
}

export interface CodexThreadResumeRequest {
  readonly workspaceId: string
  readonly threadHandle: string
}

export interface CodexTurnStartRequest {
  readonly workspaceId: string
  readonly threadHandle: string
  readonly clientUserMessageId: string
  readonly text: string
  readonly effort: ReasoningPreset
  readonly attachmentHandles: readonly string[]
}

export type AttachmentSource = "picker" | "drop" | "paste"
export type AttachmentKind = "image" | "file"

export interface AttachmentSelectionRequest {
  readonly workspaceId: string
  readonly existingHandles: readonly string[]
}

export interface AttachmentPathRegistrationRequest {
  readonly workspaceId: string
  readonly source: Exclude<AttachmentSource, "picker">
  readonly paths: readonly string[]
  readonly existingHandles: readonly string[]
}

export interface AttachmentView {
  readonly schemaVersion: 1
  readonly handle: string
  readonly name: string
  readonly relativePath: string
  readonly sizeBytes: number
  readonly kind: AttachmentKind
  readonly source: AttachmentSource
  readonly expiresAt: string
}

export interface AttachmentRejection {
  readonly candidateIndex: number
  readonly code: string
  readonly recoverable: boolean
}

export interface AttachmentRegistrationResponse {
  readonly items: readonly AttachmentView[]
  readonly rejections: readonly AttachmentRejection[]
}

export interface CodexTurnInterruptRequest {
  readonly workspaceId: string
  readonly threadHandle: string
  readonly turnHandle: string
}

export type ReviewTarget =
  | { readonly type: "uncommittedChanges" }
  | { readonly type: "baseBranch"; readonly branch: string }
  | {
      readonly type: "commit"
      readonly sha: string
      readonly title: string | null
    }
  | { readonly type: "custom"; readonly instructions: string }

export interface CodexReviewStartRequest {
  readonly workspaceId: string
  readonly threadHandle: string
  readonly target: ReviewTarget
}

export type PendingResponse =
  | { readonly type: "approval"; readonly decision: ApprovalDecision }
  | {
      readonly type: "user_input"
      readonly answers: Readonly<Record<string, readonly string[]>>
    }

export interface CodexPendingResponseRequest {
  readonly workspaceId: string
  readonly pendingId: string
  readonly response: PendingResponse
}

export interface CodexFallbackDecisionRequest {
  readonly workspaceId: string
  readonly decisionHandle: string
  readonly optionId: string
}

export interface ThreadSummary {
  readonly threadHandle: string
  readonly status: string
  readonly title: string | null
  readonly updatedAt: string | null
}

export interface ThreadListResponse {
  readonly data: readonly ThreadSummary[]
  readonly nextCursor: string | null
}

export interface ThreadResponse {
  readonly threadHandle: string
  readonly model: typeof codexModel
  readonly generation: number
}

export interface TurnResponse {
  readonly threadHandle: string
  readonly turnHandle: string
}

export interface ReviewResponse {
  readonly reviewThreadHandle: string
  readonly turnHandle: string
}

export interface AcceptedResponse {
  readonly accepted: boolean
}

export interface PendingOption {
  readonly id: string
  readonly label: string
  readonly description: string
}

export interface PendingQuestion {
  readonly id: string
  readonly header: string
  readonly question: string
  readonly options: readonly PendingOption[]
}

interface PendingRequestBase {
  readonly pendingId: string
  readonly responseKind: "native_server_request" | "fallback_decision"
  readonly operation: string
  readonly targetAlias: string
  readonly reason: string | null
  readonly decisionContext: DecisionContext
}

export interface DecisionContext {
  readonly schemaVersion: 1
  readonly category:
    | "command_execution"
    | "file_change"
    | "permissions"
    | "user_decision"
  readonly targetKind:
    | "network_host"
    | "workspace"
    | "workspace_path"
    | "active_turn"
  readonly targetAlias: string
  readonly effect:
    | "execute_command"
    | "apply_file_change"
    | "grant_permissions"
    | "continue_turn"
  readonly scope: "command" | "turn"
  readonly risk: "low" | "medium" | "high"
  readonly reversibility:
    "reversible" | "partially_reversible" | "not_reversible" | "unknown"
  readonly recommendation: string | null
  readonly evidence: readonly string[]
  readonly uncertainty: "none" | "limited_context" | "unknown_effects"
}

export interface ApprovalPendingRequest extends PendingRequestBase {
  readonly kind: Exclude<PendingKind, "user_input">
  readonly responseKind: "native_server_request"
  readonly questions: readonly []
  readonly allowedDecisions: readonly ApprovalDecision[]
}

export interface NativeUserInputPendingRequest extends PendingRequestBase {
  readonly kind: "user_input"
  readonly responseKind: "native_server_request"
  readonly questions: readonly PendingQuestion[]
  readonly allowedDecisions: readonly []
}

export interface FallbackDecisionPendingRequest extends PendingRequestBase {
  readonly kind: "user_input"
  readonly responseKind: "fallback_decision"
  readonly questions: readonly [PendingQuestion]
  readonly allowedDecisions: readonly []
}

export type PendingRequestView =
  | ApprovalPendingRequest
  | NativeUserInputPendingRequest
  | FallbackDecisionPendingRequest

interface CodexEventBase {
  readonly schemaVersion: typeof codexEventSchemaVersion
  readonly eventId: string
  readonly workspaceId: string
  readonly generation: number
  readonly sequence: number
  readonly occurredAt: string
}

export type CodexEvent = CodexEventBase &
  (
    | {
        readonly kind: "thread_status"
        readonly payload: {
          readonly threadHandle: string
          readonly status: string
        }
      }
    | {
        readonly kind: "turn_status"
        readonly payload: {
          readonly threadHandle: string
          readonly turnHandle: string
          readonly status: string
        }
      }
    | {
        readonly kind: "item_status"
        readonly payload: {
          readonly itemHandle: string
          readonly itemType: string
          readonly status: string
        }
      }
    | {
        readonly kind: "agent_message_delta"
        readonly payload: {
          readonly itemHandle: string
          readonly delta: string
        }
      }
    | {
        readonly kind: "agent_message_completed"
        readonly payload: { readonly itemHandle: string; readonly text: string }
      }
    | {
        readonly kind: "plan_updated"
        readonly payload: { readonly stepCount: number }
      }
    | {
        readonly kind: "diff_updated"
        readonly payload: {
          readonly byteCount: number
          readonly detailRef: string
        }
      }
    | {
        readonly kind: "tool_output"
        readonly payload: {
          readonly itemHandle: string
          readonly excerpt: string
        }
      }
    | {
        readonly kind: "file_change"
        readonly payload: {
          readonly itemHandle: string
          readonly pathAlias: string
          readonly changeKind: string
        }
      }
    | {
        readonly kind: "pending_request"
        readonly payload: { readonly request: PendingRequestView }
      }
    | {
        readonly kind: "pending_request_resolved"
        readonly payload: {
          readonly pendingId: string
          readonly status: "accepted" | "expired" | "failed"
        }
      }
    | {
        readonly kind: "diagnostic"
        readonly payload: {
          readonly code: string
          readonly willRetry: boolean
          readonly detailRef: string
        }
      }
    | {
        readonly kind: "model_violation"
        readonly payload: {
          readonly fromModel: string
          readonly toModel: string
        }
      }
    | {
        readonly kind: "protocol_unsupported"
        readonly payload: {
          readonly methodHash: string
          readonly byteCount: number
          readonly detailRef: string
        }
      }
  )

export interface CodexCommandErrorEnvelope {
  readonly code: string
  readonly operation: string
  readonly recoverable: boolean
  readonly userMessageKey: string
  readonly detailRef?: string
}

export interface CodexRequestMap {
  codex_pick_workspace: undefined
  codex_get_diagnostic: undefined
  codex_probe: undefined
  codex_connect: CodexConnectRequest
  codex_thread_list: CodexThreadListRequest
  codex_thread_start: CodexThreadStartRequest
  codex_thread_resume: CodexThreadResumeRequest
  codex_pick_attachments: AttachmentSelectionRequest
  codex_register_attachment_paths: AttachmentPathRegistrationRequest
  codex_turn_start: CodexTurnStartRequest
  codex_turn_interrupt: CodexTurnInterruptRequest
  codex_review_start: CodexReviewStartRequest
  codex_respond_pending: CodexPendingResponseRequest
  codex_answer_fallback_decision: CodexFallbackDecisionRequest
}

export interface CodexResponseMap {
  codex_pick_workspace: WorkspaceRegistration
  codex_get_diagnostic: CodexDiagnostic
  codex_probe: CodexDiagnostic
  codex_connect: CodexDiagnostic
  codex_thread_list: ThreadListResponse
  codex_thread_start: ThreadResponse
  codex_thread_resume: ThreadResponse
  codex_pick_attachments: AttachmentRegistrationResponse
  codex_register_attachment_paths: AttachmentRegistrationResponse
  codex_turn_start: TurnResponse
  codex_turn_interrupt: AcceptedResponse
  codex_review_start: ReviewResponse
  codex_respond_pending: AcceptedResponse
  codex_answer_fallback_decision: TurnResponse
}

export type CodexCommand = keyof CodexRequestMap & keyof CodexResponseMap

export class CodexContractError extends Error {
  constructor() {
    super("The native Codex value did not match the public contract.")
    this.name = "CodexContractError"
  }
}

type UnknownRecord = Readonly<Record<string, unknown>>

const privateValuePattern =
  /(?:\/(?:Users\/[^/\s]+|home\/[^/\s]+|Volumes|Library|Applications)(?:\/|\b)|[A-Za-z]:\\Users\\|\bBearer\s+[A-Za-z0-9._~+/-]+=*|\bsk-[A-Za-z0-9_-]{8,}|["']?(?:api[_-]?key|access[_-]?token|auth[_-]?cookie|session[_-]?id|set-cookie|authorization|cookie|token|password|secret)["']?\s*[:=]\s*["']?\S+)/iu
const attachmentHandlePattern =
  /^attachment-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const attachmentErrorCodePattern = /^CODEX-ATTACHMENT-[A-Z0-9-]{2,96}$/u

function violation(): never {
  throw new CodexContractError()
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exact(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  )
}

function safeString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 1_048_576 &&
    !privateValuePattern.test(value)
  )
}

function nonEmptyString(value: unknown): value is string {
  return safeString(value) && value.trim().length > 0
}

function nullableString(value: unknown): value is string | null {
  return value === null || safeString(value)
}

function nullableNonEmptyString(value: unknown): value is string | null {
  return value === null || nonEmptyString(value)
}

function timestamp(value: unknown): value is string {
  return (
    nonEmptyString(value) &&
    value.includes("T") &&
    Number.isFinite(Date.parse(value))
  )
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || timestamp(value)
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return (
    typeof value === "string" && values.some((candidate) => candidate === value)
  )
}

const capabilityStates = ["supported", "unavailable", "unverified"] as const
const healthStates = [
  "binary_missing",
  "binary_untrusted",
  "schema_unsupported",
  "initializing",
  "auth_required",
  "model_unavailable",
  "effort_unavailable",
  "ready",
  "disconnected",
  "protocol_mismatch",
] as const
const childStates = [
  "stopped",
  "probing",
  "spawning",
  "initializing",
  "ready",
  "restarting",
  "stopping",
] as const
const binarySources = [
  "explicit",
  "path",
  "known_install",
  "test_fixture",
] as const
const approvalDecisions = ["approve_once", "reject", "stop"] as const
const pendingKinds = [
  "command_approval",
  "file_change_approval",
  "permissions_approval",
  "user_input",
] as const

function parseCapabilities(value: unknown): CodexCapabilities {
  const keys = [
    "coreLifecycle",
    "modelDiscovery",
    "nativeRequestUserInput",
    "dynamicTools",
    "permissionsApproval",
    "detachedReview",
    "ephemeralThread",
    "supportIsolation",
  ] as const
  if (
    !isRecord(value) ||
    !exact(value, keys) ||
    !keys.every((key) => oneOf(value[key], capabilityStates))
  ) {
    return violation()
  }
  return {
    coreLifecycle: value.coreLifecycle as CapabilityState,
    modelDiscovery: value.modelDiscovery as CapabilityState,
    nativeRequestUserInput: value.nativeRequestUserInput as CapabilityState,
    dynamicTools: value.dynamicTools as CapabilityState,
    permissionsApproval: value.permissionsApproval as CapabilityState,
    detachedReview: value.detachedReview as CapabilityState,
    ephemeralThread: value.ephemeralThread as CapabilityState,
    supportIsolation: value.supportIsolation as CapabilityState,
  }
}

export function parseCodexDiagnostic(value: unknown): CodexDiagnostic {
  const keys = [
    "adapterVersion",
    "health",
    "checkedAt",
    "operation",
    "recoverable",
    "cliVersion",
    "binarySource",
    "binaryHashPrefix",
    "schemaFingerprintPrefix",
    "generatedBySameBinary",
    "experimentalApiRequested",
    "experimentalApiAccepted",
    "accountPresent",
    "authKind",
    "requiresOpenaiAuth",
    "modelAvailable",
    "fastAvailable",
    "maxAvailable",
    "configModelPresent",
    "childState",
    "lastSuccessfulHandshakeAt",
    "capabilities",
    "errorCode",
    "detailRef",
  ] as const
  if (
    !isRecord(value) ||
    !exact(value, keys) ||
    value.adapterVersion !== codexAdapterVersion ||
    !oneOf(value.health, healthStates) ||
    !timestamp(value.checkedAt) ||
    !nonEmptyString(value.operation) ||
    typeof value.recoverable !== "boolean" ||
    !nullableNonEmptyString(value.cliVersion) ||
    !(
      value.binarySource === null || oneOf(value.binarySource, binarySources)
    ) ||
    !nullableNonEmptyString(value.binaryHashPrefix) ||
    !nullableNonEmptyString(value.schemaFingerprintPrefix) ||
    typeof value.generatedBySameBinary !== "boolean" ||
    typeof value.experimentalApiRequested !== "boolean" ||
    typeof value.experimentalApiAccepted !== "boolean" ||
    typeof value.accountPresent !== "boolean" ||
    !nullableNonEmptyString(value.authKind) ||
    typeof value.requiresOpenaiAuth !== "boolean" ||
    typeof value.modelAvailable !== "boolean" ||
    typeof value.fastAvailable !== "boolean" ||
    typeof value.maxAvailable !== "boolean" ||
    typeof value.configModelPresent !== "boolean" ||
    !oneOf(value.childState, childStates) ||
    !nullableTimestamp(value.lastSuccessfulHandshakeAt) ||
    !nullableNonEmptyString(value.errorCode) ||
    !nullableNonEmptyString(value.detailRef)
  ) {
    return violation()
  }
  return {
    adapterVersion: codexAdapterVersion,
    health: value.health,
    checkedAt: value.checkedAt,
    operation: value.operation,
    recoverable: value.recoverable,
    cliVersion: value.cliVersion,
    binarySource: value.binarySource,
    binaryHashPrefix: value.binaryHashPrefix,
    schemaFingerprintPrefix: value.schemaFingerprintPrefix,
    generatedBySameBinary: value.generatedBySameBinary,
    experimentalApiRequested: value.experimentalApiRequested,
    experimentalApiAccepted: value.experimentalApiAccepted,
    accountPresent: value.accountPresent,
    authKind: value.authKind,
    requiresOpenaiAuth: value.requiresOpenaiAuth,
    modelAvailable: value.modelAvailable,
    fastAvailable: value.fastAvailable,
    maxAvailable: value.maxAvailable,
    configModelPresent: value.configModelPresent,
    childState: value.childState,
    lastSuccessfulHandshakeAt: value.lastSuccessfulHandshakeAt,
    capabilities: parseCapabilities(value.capabilities),
    errorCode: value.errorCode,
    detailRef: value.detailRef,
  }
}

function parseThreadSummary(value: unknown): ThreadSummary {
  if (
    !isRecord(value) ||
    !exact(value, ["threadHandle", "status", "title", "updatedAt"]) ||
    !nonEmptyString(value.threadHandle) ||
    !nonEmptyString(value.status) ||
    !nullableString(value.title) ||
    !nullableTimestamp(value.updatedAt)
  ) {
    return violation()
  }
  return {
    threadHandle: value.threadHandle,
    status: value.status,
    title: value.title,
    updatedAt: value.updatedAt,
  }
}

export function parseThreadListResponse(value: unknown): ThreadListResponse {
  if (
    !isRecord(value) ||
    !exact(value, ["data", "nextCursor"]) ||
    !Array.isArray(value.data) ||
    value.data.length > 100 ||
    !nullableNonEmptyString(value.nextCursor)
  ) {
    return violation()
  }
  return {
    data: value.data.map(parseThreadSummary),
    nextCursor: value.nextCursor,
  }
}

export function parseThreadResponse(value: unknown): ThreadResponse {
  if (
    !isRecord(value) ||
    !exact(value, ["threadHandle", "model", "generation"]) ||
    !nonEmptyString(value.threadHandle) ||
    value.model !== codexModel ||
    !safeInteger(value.generation) ||
    value.generation === 0
  ) {
    return violation()
  }
  return {
    threadHandle: value.threadHandle,
    model: codexModel,
    generation: value.generation,
  }
}

function parseAttachmentView(value: unknown): AttachmentView {
  if (
    !isRecord(value) ||
    !exact(value, [
      "schemaVersion",
      "handle",
      "name",
      "relativePath",
      "sizeBytes",
      "kind",
      "source",
      "expiresAt",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.handle !== "string" ||
    !attachmentHandlePattern.test(value.handle) ||
    !nonEmptyString(value.name) ||
    value.name.length > 255 ||
    /[\\/]/u.test(value.name) ||
    [...value.name].some((character) => /\p{Cc}/u.test(character)) ||
    !nonEmptyString(value.relativePath) ||
    value.relativePath.length > 4_096 ||
    value.relativePath.startsWith("/") ||
    value.relativePath.includes("\\") ||
    value.relativePath
      .split("/")
      .some(
        (component) =>
          component.length === 0 || component === "." || component === "..",
      ) ||
    !safeInteger(value.sizeBytes) ||
    value.sizeBytes > 25 * 1024 * 1024 ||
    !oneOf(value.kind, ["image", "file"] as const) ||
    !oneOf(value.source, ["picker", "drop", "paste"] as const) ||
    !timestamp(value.expiresAt)
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    handle: value.handle,
    name: value.name,
    relativePath: value.relativePath,
    sizeBytes: value.sizeBytes,
    kind: value.kind,
    source: value.source,
    expiresAt: value.expiresAt,
  }
}

function parseAttachmentRejection(value: unknown): AttachmentRejection {
  if (
    !isRecord(value) ||
    !exact(value, ["candidateIndex", "code", "recoverable"]) ||
    !safeInteger(value.candidateIndex) ||
    value.candidateIndex >= 64 ||
    typeof value.code !== "string" ||
    !attachmentErrorCodePattern.test(value.code) ||
    typeof value.recoverable !== "boolean"
  ) {
    return violation()
  }
  return {
    candidateIndex: value.candidateIndex,
    code: value.code,
    recoverable: value.recoverable,
  }
}

export function parseAttachmentRegistrationResponse(
  value: unknown,
): AttachmentRegistrationResponse {
  if (
    !isRecord(value) ||
    !exact(value, ["items", "rejections"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 10 ||
    !Array.isArray(value.rejections) ||
    value.rejections.length > 64
  ) {
    return violation()
  }
  const items = value.items.map(parseAttachmentView)
  if (
    items.reduce((total, item) => total + item.sizeBytes, 0) >
      50 * 1024 * 1024 ||
    new Set(items.map((item) => item.handle)).size !== items.length
  ) {
    return violation()
  }
  return {
    items,
    rejections: value.rejections.map(parseAttachmentRejection),
  }
}

export function parseTurnResponse(value: unknown): TurnResponse {
  if (
    !isRecord(value) ||
    !exact(value, ["threadHandle", "turnHandle"]) ||
    !nonEmptyString(value.threadHandle) ||
    !nonEmptyString(value.turnHandle)
  ) {
    return violation()
  }
  return { threadHandle: value.threadHandle, turnHandle: value.turnHandle }
}

export function parseReviewResponse(value: unknown): ReviewResponse {
  if (
    !isRecord(value) ||
    !exact(value, ["reviewThreadHandle", "turnHandle"]) ||
    !nonEmptyString(value.reviewThreadHandle) ||
    !nonEmptyString(value.turnHandle)
  ) {
    return violation()
  }
  return {
    reviewThreadHandle: value.reviewThreadHandle,
    turnHandle: value.turnHandle,
  }
}

export function parseAcceptedResponse(value: unknown): AcceptedResponse {
  if (
    !isRecord(value) ||
    !exact(value, ["accepted"]) ||
    typeof value.accepted !== "boolean"
  ) {
    return violation()
  }
  return { accepted: value.accepted }
}

export function parseWorkspaceRegistration(
  value: unknown,
): WorkspaceRegistration {
  if (
    !isRecord(value) ||
    !exact(value, ["schemaVersion", "workspaceId", "alias", "preflight"]) ||
    value.schemaVersion !== 1 ||
    !nonEmptyString(value.workspaceId) ||
    !/^workspace-[a-z0-9-]+$/iu.test(value.workspaceId) ||
    !nonEmptyString(value.alias) ||
    value.alias.length > 80 ||
    value.alias.includes("/") ||
    value.alias.includes("\\") ||
    !isRecord(value.preflight) ||
    !exact(value.preflight, [
      "gitRepository",
      "ownedByCurrentUser",
      "writable",
    ]) ||
    value.preflight.gitRepository !== true ||
    value.preflight.ownedByCurrentUser !== true ||
    value.preflight.writable !== true
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    workspaceId: value.workspaceId,
    alias: value.alias,
    preflight: {
      gitRepository: true,
      ownedByCurrentUser: true,
      writable: true,
    },
  }
}

function parsePendingOption(value: unknown): PendingOption {
  if (
    !isRecord(value) ||
    !exact(value, ["id", "label", "description"]) ||
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.label) ||
    !safeString(value.description)
  ) {
    return violation()
  }
  return { id: value.id, label: value.label, description: value.description }
}

function parsePendingQuestion(value: unknown): PendingQuestion {
  if (
    !isRecord(value) ||
    !exact(value, ["id", "header", "question", "options"]) ||
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.header) ||
    !nonEmptyString(value.question) ||
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > 3
  ) {
    return violation()
  }
  const options = value.options.map(parsePendingOption)
  if (
    new Set(options.map((option) => option.id)).size !== options.length ||
    new Set(options.map((option) => option.label)).size !== options.length
  ) {
    return violation()
  }
  return {
    id: value.id,
    header: value.header,
    question: value.question,
    options,
  }
}

const approvalCategories = [
  "command_execution",
  "file_change",
  "permissions",
  "user_decision",
] as const
const approvalTargetKinds = [
  "network_host",
  "workspace",
  "workspace_path",
  "active_turn",
] as const
const decisionEffects = [
  "execute_command",
  "apply_file_change",
  "grant_permissions",
  "continue_turn",
] as const
const approvalScopes = ["command", "turn"] as const
const approvalRisks = ["low", "medium", "high"] as const
const approvalReversibility = [
  "reversible",
  "partially_reversible",
  "not_reversible",
  "unknown",
] as const
const decisionUncertainty = [
  "none",
  "limited_context",
  "unknown_effects",
] as const

function parseDecisionContext(value: unknown): DecisionContext {
  if (
    !isRecord(value) ||
    !exact(value, [
      "schemaVersion",
      "category",
      "targetKind",
      "targetAlias",
      "effect",
      "scope",
      "risk",
      "reversibility",
      "recommendation",
      "evidence",
      "uncertainty",
    ]) ||
    value.schemaVersion !== 1 ||
    !oneOf(value.category, approvalCategories) ||
    !oneOf(value.targetKind, approvalTargetKinds) ||
    !isPublicSingleLineText(value.targetAlias, 256) ||
    !oneOf(value.effect, decisionEffects) ||
    !oneOf(value.scope, approvalScopes) ||
    !oneOf(value.risk, approvalRisks) ||
    !oneOf(value.reversibility, approvalReversibility) ||
    !(value.recommendation === null ||
      isPublicSingleLineText(value.recommendation, 256)) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length < 1 ||
    value.evidence.length > 8 ||
    !value.evidence.every((item) => isPublicMultilineText(item, 512)) ||
    new Set(value.evidence).size !== value.evidence.length ||
    !oneOf(value.uncertainty, decisionUncertainty)
  ) {
    return violation()
  }
  return {
    schemaVersion: 1,
    category: value.category,
    targetKind: value.targetKind,
    targetAlias: value.targetAlias,
    effect: value.effect,
    scope: value.scope,
    risk: value.risk,
    reversibility: value.reversibility,
    recommendation: value.recommendation,
    evidence: value.evidence,
    uncertainty: value.uncertainty,
  }
}

export function parsePendingRequest(value: unknown): PendingRequestView {
  if (
    !isRecord(value) ||
    !exact(value, [
      "pendingId",
      "kind",
      "responseKind",
      "operation",
      "targetAlias",
      "reason",
      "questions",
      "allowedDecisions",
      "decisionContext",
    ]) ||
    !nonEmptyString(value.pendingId) ||
    !oneOf(value.kind, pendingKinds) ||
    !oneOf(value.responseKind, [
      "native_server_request",
      "fallback_decision",
    ] as const) ||
    !nonEmptyString(value.operation) ||
    !nonEmptyString(value.targetAlias) ||
    !nullableString(value.reason) ||
    !Array.isArray(value.questions) ||
    !Array.isArray(value.allowedDecisions) ||
    !value.allowedDecisions.every((decision) =>
      oneOf(decision, approvalDecisions),
    )
  ) {
    return violation()
  }
  const common = {
    pendingId: value.pendingId,
    responseKind: value.responseKind,
    operation: value.operation,
    targetAlias: value.targetAlias,
    reason: value.reason,
    decisionContext: parseDecisionContext(value.decisionContext),
  }
  if (value.kind === "user_input") {
    if (
      value.questions.length < 1 ||
      value.questions.length > 3 ||
      value.allowedDecisions.length !== 0
    ) {
      return violation()
    }
    const questions = value.questions.map(parsePendingQuestion)
    if (
      new Set(questions.map((question) => question.id)).size !==
      questions.length
    )
      return violation()
    const decisionContext = common.decisionContext
    const optionIds = new Set(
      questions.flatMap((question) =>
        question.options.map((option) => option.id),
      ),
    )
    if (
      decisionContext.category !== "user_decision" ||
      decisionContext.targetKind !== "active_turn" ||
      decisionContext.targetAlias !== value.targetAlias ||
      decisionContext.effect !== "continue_turn" ||
      decisionContext.scope !== "turn" ||
      (decisionContext.recommendation !== null &&
        !optionIds.has(decisionContext.recommendation))
    ) {
      return violation()
    }
    if (value.responseKind === "fallback_decision") {
      if (value.operation !== "decision_fallback" || questions.length !== 1)
        return violation()
      const question = questions[0]
      if (question === undefined) return violation()
      return {
        ...common,
        kind: "user_input",
        responseKind: "fallback_decision",
        questions: [question],
        allowedDecisions: [],
      }
    }
    return {
      ...common,
      kind: "user_input",
      responseKind: "native_server_request",
      questions,
      allowedDecisions: [],
    }
  }

  if (
    value.responseKind !== "native_server_request" ||
    value.questions.length !== 0 ||
    value.allowedDecisions.length < 1 ||
    value.allowedDecisions.length > 3 ||
    new Set(value.allowedDecisions).size !== value.allowedDecisions.length
  ) {
    return violation()
  }
  const decisionContext = common.decisionContext
  const expectedCategory = {
    command_approval: "command_execution",
    file_change_approval: "file_change",
    permissions_approval: "permissions",
  } as const
  const expectedEffect = {
    command_approval: "execute_command",
    file_change_approval: "apply_file_change",
    permissions_approval: "grant_permissions",
  } as const
  if (
    decisionContext.category !== expectedCategory[value.kind] ||
    decisionContext.targetAlias !== value.targetAlias ||
    decisionContext.effect !== expectedEffect[value.kind] ||
    decisionContext.recommendation === null ||
    !oneOf(decisionContext.recommendation, approvalDecisions) ||
    !value.allowedDecisions.includes(decisionContext.recommendation)
  ) {
    return violation()
  }
  return {
    ...common,
    kind: value.kind,
    responseKind: "native_server_request",
    questions: [],
    allowedDecisions: value.allowedDecisions,
  }
}

function parseEventBase(value: UnknownRecord): CodexEventBase {
  if (
    value.schemaVersion !== codexEventSchemaVersion ||
    !nonEmptyString(value.eventId) ||
    !nonEmptyString(value.workspaceId) ||
    !safeInteger(value.generation) ||
    !safeInteger(value.sequence) ||
    !timestamp(value.occurredAt)
  ) {
    return violation()
  }
  return {
    schemaVersion: codexEventSchemaVersion,
    eventId: value.eventId,
    workspaceId: value.workspaceId,
    generation: value.generation,
    sequence: value.sequence,
    occurredAt: value.occurredAt,
  }
}

function parseSimplePayload(
  payload: unknown,
  keys: readonly string[],
): UnknownRecord {
  if (!isRecord(payload) || !exact(payload, keys)) {
    return violation()
  }
  return payload
}

export function parseCodexEvent(value: unknown): CodexEvent {
  const baseKeys = [
    "schemaVersion",
    "eventId",
    "workspaceId",
    "generation",
    "sequence",
    "occurredAt",
    "kind",
    "payload",
  ] as const
  if (
    !isRecord(value) ||
    !exact(value, baseKeys) ||
    !nonEmptyString(value.kind)
  ) {
    return violation()
  }
  const base = parseEventBase(value)

  switch (value.kind) {
    case "thread_status": {
      const payload = parseSimplePayload(value.payload, [
        "threadHandle",
        "status",
      ])
      if (
        !nonEmptyString(payload.threadHandle) ||
        !nonEmptyString(payload.status)
      ) {
        return violation()
      }
      return {
        ...base,
        kind: value.kind,
        payload: { threadHandle: payload.threadHandle, status: payload.status },
      }
    }
    case "turn_status": {
      const payload = parseSimplePayload(value.payload, [
        "threadHandle",
        "turnHandle",
        "status",
      ])
      if (
        !nonEmptyString(payload.threadHandle) ||
        !nonEmptyString(payload.turnHandle) ||
        !nonEmptyString(payload.status)
      ) {
        return violation()
      }
      return {
        ...base,
        kind: value.kind,
        payload: {
          threadHandle: payload.threadHandle,
          turnHandle: payload.turnHandle,
          status: payload.status,
        },
      }
    }
    case "item_status": {
      const payload = parseSimplePayload(value.payload, [
        "itemHandle",
        "itemType",
        "status",
      ])
      if (
        !nonEmptyString(payload.itemHandle) ||
        !nonEmptyString(payload.itemType) ||
        !nonEmptyString(payload.status)
      ) {
        return violation()
      }
      return {
        ...base,
        kind: value.kind,
        payload: {
          itemHandle: payload.itemHandle,
          itemType: payload.itemType,
          status: payload.status,
        },
      }
    }
    case "agent_message_delta": {
      const payload = parseSimplePayload(value.payload, ["itemHandle", "delta"])
      if (!nonEmptyString(payload.itemHandle) || !safeString(payload.delta)) {
        return violation()
      }
      return {
        ...base,
        kind: value.kind,
        payload: { itemHandle: payload.itemHandle, delta: payload.delta },
      }
    }
    case "agent_message_completed": {
      const payload = parseSimplePayload(value.payload, ["itemHandle", "text"])
      if (!nonEmptyString(payload.itemHandle) || !safeString(payload.text)) {
        return violation()
      }
      return {
        ...base,
        kind: value.kind,
        payload: { itemHandle: payload.itemHandle, text: payload.text },
      }
    }
    case "plan_updated": {
      const payload = parseSimplePayload(value.payload, ["stepCount"])
      if (!safeInteger(payload.stepCount)) return violation()
      return {
        ...base,
        kind: value.kind,
        payload: { stepCount: payload.stepCount },
      }
    }
    case "diff_updated": {
      const payload = parseSimplePayload(value.payload, [
        "byteCount",
        "detailRef",
      ])
      if (!safeInteger(payload.byteCount) || !nonEmptyString(payload.detailRef))
        return violation()
      return {
        ...base,
        kind: value.kind,
        payload: { byteCount: payload.byteCount, detailRef: payload.detailRef },
      }
    }
    case "tool_output": {
      const payload = parseSimplePayload(value.payload, [
        "itemHandle",
        "excerpt",
      ])
      if (!nonEmptyString(payload.itemHandle) || !safeString(payload.excerpt))
        return violation()
      return {
        ...base,
        kind: value.kind,
        payload: { itemHandle: payload.itemHandle, excerpt: payload.excerpt },
      }
    }
    case "file_change": {
      const payload = parseSimplePayload(value.payload, [
        "itemHandle",
        "pathAlias",
        "changeKind",
      ])
      if (
        !nonEmptyString(payload.itemHandle) ||
        !nonEmptyString(payload.pathAlias) ||
        !nonEmptyString(payload.changeKind)
      ) {
        return violation()
      }
      return {
        ...base,
        kind: value.kind,
        payload: {
          itemHandle: payload.itemHandle,
          pathAlias: payload.pathAlias,
          changeKind: payload.changeKind,
        },
      }
    }
    case "pending_request": {
      const payload = parseSimplePayload(value.payload, ["request"])
      return {
        ...base,
        kind: value.kind,
        payload: { request: parsePendingRequest(payload.request) },
      }
    }
    case "pending_request_resolved": {
      const payload = parseSimplePayload(value.payload, ["pendingId", "status"])
      if (
        !nonEmptyString(payload.pendingId) ||
        !oneOf(payload.status, ["accepted", "expired", "failed"] as const)
      ) {
        return violation()
      }
      return {
        ...base,
        kind: value.kind,
        payload: { pendingId: payload.pendingId, status: payload.status },
      }
    }
    case "diagnostic": {
      const payload = parseSimplePayload(value.payload, [
        "code",
        "willRetry",
        "detailRef",
      ])
      if (
        !nonEmptyString(payload.code) ||
        typeof payload.willRetry !== "boolean" ||
        !nonEmptyString(payload.detailRef)
      ) {
        return violation()
      }
      return {
        ...base,
        kind: value.kind,
        payload: {
          code: payload.code,
          willRetry: payload.willRetry,
          detailRef: payload.detailRef,
        },
      }
    }
    case "model_violation": {
      const payload = parseSimplePayload(value.payload, [
        "fromModel",
        "toModel",
      ])
      if (
        !nonEmptyString(payload.fromModel) ||
        !nonEmptyString(payload.toModel)
      )
        return violation()
      return {
        ...base,
        kind: value.kind,
        payload: { fromModel: payload.fromModel, toModel: payload.toModel },
      }
    }
    case "protocol_unsupported": {
      const payload = parseSimplePayload(value.payload, [
        "methodHash",
        "byteCount",
        "detailRef",
      ])
      if (
        !nonEmptyString(payload.methodHash) ||
        !safeInteger(payload.byteCount) ||
        !nonEmptyString(payload.detailRef)
      ) {
        return violation()
      }
      return {
        ...base,
        kind: value.kind,
        payload: {
          methodHash: payload.methodHash,
          byteCount: payload.byteCount,
          detailRef: payload.detailRef,
        },
      }
    }
    default:
      return violation()
  }
}

export function parseCodexCommandError(
  value: unknown,
): CodexCommandErrorEnvelope | null {
  if (
    !isRecord(value) ||
    !exact(
      value,
      ["code", "operation", "recoverable", "userMessageKey"],
      ["detailRef"],
    ) ||
    !nonEmptyString(value.code) ||
    !nonEmptyString(value.operation) ||
    typeof value.recoverable !== "boolean" ||
    !nonEmptyString(value.userMessageKey) ||
    (value.detailRef !== undefined && !nonEmptyString(value.detailRef))
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

export function parseCodexResponse<K extends CodexCommand>(
  command: K,
  value: unknown,
): CodexResponseMap[K] {
  switch (command) {
    case codexCommands.pickWorkspace:
      return parseWorkspaceRegistration(value) as CodexResponseMap[K]
    case codexCommands.getDiagnostic:
    case codexCommands.probe:
    case codexCommands.connect:
      return parseCodexDiagnostic(value) as CodexResponseMap[K]
    case codexCommands.threadList:
      return parseThreadListResponse(value) as CodexResponseMap[K]
    case codexCommands.threadStart:
    case codexCommands.threadResume:
      return parseThreadResponse(value) as CodexResponseMap[K]
    case codexCommands.pickAttachments:
    case codexCommands.registerAttachmentPaths:
      return parseAttachmentRegistrationResponse(value) as CodexResponseMap[K]
    case codexCommands.turnStart:
    case codexCommands.answerFallbackDecision:
      return parseTurnResponse(value) as CodexResponseMap[K]
    case codexCommands.turnInterrupt:
    case codexCommands.respondPending:
      return parseAcceptedResponse(value) as CodexResponseMap[K]
    case codexCommands.reviewStart:
      return parseReviewResponse(value) as CodexResponseMap[K]
  }
}
import {
  isPublicMultilineText,
  isPublicSingleLineText,
} from "@/lib/public-text"
