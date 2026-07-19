export const gitReviewSchemaVersion = 1 as const

export const gitReviewCommands = {
  observeRepository: "observe_git_repository",
  observeTerminalWorkUnit: "observe_terminal_work_unit",
  listCommitEvidence: "list_commit_evidence",
  readCommitEvidence: "read_commit_evidence",
  readCommitDiffFile: "read_commit_diff_file",
  prepareCommitExplanationEvidence: "prepare_commit_explanation_evidence",
} as const

export const commitExplanationCommands = {
  request: "commit_explanation_request",
  cancel: "commit_explanation_cancel",
  present: "commit_explanation_present",
  getState: "commit_explanation_get_state",
  setScope: "commit_explanation_set_scope",
} as const

export const commitExplanationEventChannels = {
  state: "coding-wife://commit-explanation-state",
  presentation: "coding-wife://commit-explanation-presentation",
} as const

export type GitSupportState = "ready" | "blocked"
export type GitObservationReason =
  | "active_view"
  | "work_unit_started"
  | "work_unit_terminal"
  | "manual_refresh"
export type WorkUnitTerminalState =
  | "completed"
  | "failed"
  | "interrupted"
  | "canceled"
export type CommitProducer = "main_codex" | "external_uncorrelated"
export type ChangeKind = "added" | "modified" | "deleted" | "type_changed"
export type GateOutcome = "pass" | "needs_review" | "fail" | "unknown"
export type GateKind = "scope" | "ownership" | "verification" | "risk"
export type RiskLevel = "low" | "medium" | "high" | "critical"
export type VerificationResult =
  | "passed"
  | "failed"
  | "skipped"
  | "inconclusive"
export type DiffContentState = "text" | "binary" | "oversize" | "invalid_utf8"
export type CommitEvidenceFilter = "all" | "this_work_unit" | "needs_attention"
export type SkillPathAuthority = "app_bundle"
export type SkillInjectionMode = "skill_input" | "developer_instructions"
export type CommitExplanationRequestTrigger =
  | "auto_verified_commit"
  | "user_request"
  | "user_retry"
export type CommitExplanationUserRequestTrigger = Exclude<
  CommitExplanationRequestTrigger,
  "auto_verified_commit"
>
export type CommitExplanationControllerStatus =
  | "not_generated"
  | "queued"
  | "running"
  | "generated"
  | "failed"
  | "unavailable"
  | "canceled"
export type CommitExplanationPresentationMode = "show" | "replay_narration"
export type CommitExplanationLocale = "ja" | "en"
export type CommitExplanationCommand =
  (typeof commitExplanationCommands)[keyof typeof commitExplanationCommands]
export type CommitExplanationEventChannel =
  (typeof commitExplanationEventChannels)[keyof typeof commitExplanationEventChannels]
export type CommitExplanationNarrationSection =
  | "summary"
  | "changes"
  | "reasons"
  | "verification"
  | "impact"
  | "cautions"
  | "howToReadNext"

export interface ProtectedChangeSummary {
  readonly fileId: string
  readonly relativePath: string
  readonly changeKind: ChangeKind
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
}

export interface GitObservation {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly observationId: string
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly reason: GitObservationReason
  readonly workUnitId: string | null
  readonly sourceEventId: string | null
  readonly supportState: GitSupportState
  readonly headSha: string
  readonly headReference: string | null
  readonly branch: string
  readonly detached: boolean
  readonly indexFingerprint: string
  readonly statusFingerprint: string
  readonly repositoryFingerprint: string
  readonly preExisting: readonly ProtectedChangeSummary[]
  readonly blockedReasons: readonly string[]
  readonly capturedAt: string
  readonly historySequence: number | null
}

export interface VerificationEvidence {
  readonly evidenceId: string
  readonly sourceEventId: string
  readonly check: string
  readonly result: VerificationResult
  readonly durationMs: number
  readonly summary: string
}

export interface DecisionEvidence {
  readonly decisionId: string
  readonly sourceEventId: string
  readonly summary: string
  readonly answer: string
  readonly rationale: string
  readonly reversible: boolean
}

export interface FailedAttemptEvidence {
  readonly attemptId: string
  readonly sourceEventId: string
  readonly approach: string
  readonly outcome: string
  readonly learning: string
}

export interface KnownRisk {
  readonly riskId: string
  readonly sourceEventId: string
  readonly category: string
  readonly level: RiskLevel
  readonly summary: string
  readonly mitigation: string
  readonly resolved: boolean
}

export interface GateResult {
  readonly gate: GateKind
  readonly outcome: GateOutcome
  readonly reasonCodes: readonly string[]
  readonly evidenceIds: readonly string[]
}

export interface CommitSkillInjectionAudit {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly skillId: "coding-wife-commit-work"
  readonly skillVersion: string
  readonly contentDigest: string
  readonly pathAuthority: SkillPathAuthority
  readonly injectionMode: SkillInjectionMode
  readonly workspaceGeneration: number
  readonly workUnitId: string
  readonly clientRequestId: string
  readonly injectedAt: string
}

export interface DiffSummary {
  readonly filesChanged: number
  readonly additions: number
  readonly deletions: number
  readonly binaryFiles: number
}

export interface CommitIdentity {
  readonly commitSha: string
  readonly subject: string
  readonly body: string
  readonly authorName: string
  readonly authorEmail: string
  readonly authoredAt: string
  readonly committedAt: string
  readonly parents: readonly string[]
}

export interface CommitFileSummary {
  readonly fileEvidenceId: string
  readonly relativePath: string
  readonly changeKind: ChangeKind
  readonly additions: number
  readonly deletions: number
  readonly binary: boolean
}

export interface CommitEvidenceDetail {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly commitEvidenceId: string
  readonly workspaceId: string
  readonly producer: CommitProducer
  readonly identity: CommitIdentity
  readonly workUnitId: string | null
  readonly objective: string | null
  readonly acceptance: readonly string[]
  readonly beforeObservationId: string | null
  readonly afterObservationId: string | null
  readonly sourceEventId: string | null
  readonly gates: readonly GateResult[]
  readonly files: readonly CommitFileSummary[]
  readonly diffSummary: DiffSummary
  readonly verification: readonly VerificationEvidence[]
  readonly decisions: readonly DecisionEvidence[]
  readonly failedAttempts: readonly FailedAttemptEvidence[]
  readonly risks: readonly KnownRisk[]
  readonly commitSkillInjection: CommitSkillInjectionAudit | null
  readonly observedAt: string
  readonly historySequence: number | null
}

export interface CommitEvidenceSummary {
  readonly commitEvidenceId: string
  readonly commitSha: string
  readonly subject: string
  readonly authorName: string
  readonly authoredAt: string
  readonly parentCount: number
  readonly producer: CommitProducer
  readonly workUnitId: string | null
  readonly verificationOutcome: GateOutcome
  readonly riskOutcome: GateOutcome
  readonly diffSummary: DiffSummary
  readonly historySequence: number | null
}

export interface CommitEvidencePage {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly items: readonly CommitEvidenceSummary[]
  readonly nextCursor: string | null
}

export interface WorkUnitGitObservation {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly workUnitId: string
  readonly sourceEventId: string
  readonly terminalState: WorkUnitTerminalState
  readonly beforeObservationId: string
  readonly afterObservationId: string
  readonly newCommitEvidenceIds: readonly string[]
  readonly commitSkillInjection: CommitSkillInjectionAudit
  readonly reportedCommitBlockReason: string | null
  readonly observedAt: string
  readonly historySequence: number | null
}

export interface TerminalWorkUnitObservationResult {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly observation: GitObservation
  readonly workUnit: WorkUnitGitObservation
  readonly newCommits: readonly CommitEvidenceSummary[]
}

export interface CommitDiffFile {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly commitEvidenceId: string
  readonly fileEvidenceId: string
  readonly relativePath: string
  readonly changeKind: ChangeKind
  readonly state: DiffContentState
  readonly content: string
  readonly byteCount: number
  readonly additions: number
  readonly deletions: number
}

export interface CommitChangeAggregate {
  readonly changeKind: ChangeKind
  readonly fileCount: number
  readonly additions: number
  readonly deletions: number
  readonly binaryFiles: number
}

/** The only payload permitted to cross into the isolated commit explainer. */
export interface CommitEvidenceV1 {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly commitId: string
  readonly subject: string
  readonly body: string
  readonly changes: readonly CommitChangeAggregate[]
  readonly diffSummary: DiffSummary
  readonly verification: readonly VerificationEvidence[]
  readonly decisions: readonly DecisionEvidence[]
  readonly risks: readonly KnownRisk[]
  readonly locale: "ja" | "en"
  readonly workspaceGeneration: number
  readonly selectionVersion: number
}

export interface ObserveGitRepositoryRequest {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly clientRequestId: string
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly reason: GitObservationReason
  readonly workUnitId: string | null
  readonly sourceEventId: string | null
}

export interface ObserveTerminalWorkUnitRequest {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly clientRequestId: string
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly beforeObservationId: string
  readonly workUnitId: string
  readonly sourceEventId: string
  readonly terminalState: WorkUnitTerminalState
  readonly objective: string
  readonly acceptance: readonly string[]
  readonly verification: readonly VerificationEvidence[]
  readonly decisions: readonly DecisionEvidence[]
  readonly failedAttempts: readonly FailedAttemptEvidence[]
  readonly risks: readonly KnownRisk[]
  readonly commitSkillInjection: CommitSkillInjectionAudit
  readonly reportedCommitBlockReason: string | null
}

export interface ListCommitEvidenceRequest {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly cursor: string | null
  readonly limit: number
  readonly filter: CommitEvidenceFilter
  readonly workUnitId: string | null
}

export interface CommitEvidenceDetailRequest {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly commitEvidenceId: string
}

export interface ReadCommitDiffRequest extends CommitEvidenceDetailRequest {
  readonly fileEvidenceId: string
}

export interface PrepareCommitExplanationEvidenceRequest
  extends CommitEvidenceDetailRequest {
  readonly locale: "ja" | "en"
  readonly selectionVersion: number
}

export interface GitReviewErrorEnvelope {
  readonly code: string
  readonly operation: string
  readonly recoverable: boolean
  readonly userMessageKey: string
  readonly detailRef?: string
}

export interface GitReviewRequestMap {
  observe_git_repository: ObserveGitRepositoryRequest
  observe_terminal_work_unit: ObserveTerminalWorkUnitRequest
  list_commit_evidence: ListCommitEvidenceRequest
  read_commit_evidence: CommitEvidenceDetailRequest
  read_commit_diff_file: ReadCommitDiffRequest
  prepare_commit_explanation_evidence: PrepareCommitExplanationEvidenceRequest
}

export interface GitReviewResponseMap {
  observe_git_repository: GitObservation
  observe_terminal_work_unit: TerminalWorkUnitObservationResult
  list_commit_evidence: CommitEvidencePage
  read_commit_evidence: CommitEvidenceDetail
  read_commit_diff_file: CommitDiffFile
  prepare_commit_explanation_evidence: CommitEvidenceV1
}

export type GitReviewCommand = keyof GitReviewRequestMap &
  keyof GitReviewResponseMap

export interface CommitExplanationRequestedV1 {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly requestId: string
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly commitEvidenceId: string
  readonly locale: "ja" | "en"
  readonly selectionVersion: number
  readonly trigger: CommitExplanationRequestTrigger
  readonly requestedAt: string
}

export interface CommitExplanationDispatchV1 {
  readonly request: CommitExplanationRequestedV1
  readonly evidence: CommitEvidenceV1
}

export type CommitExplanationRequestHandler = (
  dispatch: CommitExplanationDispatchV1,
) => void | Promise<void>

export type CommitExplanationCancelHandler = (
  request: CommitExplanationCancelRequestedV1,
) => void | Promise<void>

export interface CommitExplanationControllerStateV1 {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly commitEvidenceId: string
  readonly requestId: string | null
  readonly locale: CommitExplanationLocale | null
  readonly selectionVersion: number | null
  readonly status: CommitExplanationControllerStatus
  readonly trigger: CommitExplanationRequestTrigger | null
  readonly retryable: boolean
  readonly presentationAvailable: boolean
  readonly errorCode: string | null
  readonly updatedAt: string
}

export interface CommitExplanationStateRequestedV1 {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly commitEvidenceId: string
}

export interface CommitExplanationScopeRequestedV1 {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly locale: CommitExplanationLocale
}

export interface ExplanationNarrationChunkV1 {
  readonly sequence: number
  readonly section: CommitExplanationNarrationSection
  readonly text: string
}

export interface CommitExplanationV1 {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly locale: CommitExplanationLocale
  readonly summary: string
  readonly changes: readonly string[]
  readonly reasons: readonly string[]
  readonly verification: readonly string[]
  readonly impact: readonly string[]
  readonly cautions: readonly string[]
  readonly howToReadNext: readonly string[]
  readonly narrationChunks: readonly ExplanationNarrationChunkV1[]
}

export interface CommitExplanationSupportUsageV1 {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
}

export interface CommitExplanationPresentationV1 {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly commitEvidenceId: string
  readonly requestId: string
  readonly selectionVersion: number
  readonly trigger: CommitExplanationRequestTrigger
  readonly locale: CommitExplanationLocale
  readonly mode: CommitExplanationPresentationMode
  readonly explanation: CommitExplanationV1
  readonly usage: CommitExplanationSupportUsageV1
  readonly latencyMs: number
  readonly presentedAt: string
}

export interface CommitExplanationControllerErrorEnvelope {
  readonly code: string
  readonly operation: string
  readonly recoverable: boolean
  readonly userMessageKey: string
}

export interface CommitExplanationPresentationRequestedV1 {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly commitEvidenceId: string
  readonly requestId: string
  readonly mode: CommitExplanationPresentationMode
  readonly requestedAt: string
}

export type CommitExplanationPresentationHandler = (
  request: CommitExplanationPresentationRequestedV1,
) => void | Promise<void>

/**
 * App-owned commit explanation boundary. Implementations must update their
 * observable state before a request/cancel promise resolves. This controller
 * is independent from the main Codex thread and must never proxy through it.
 */
export interface CommitExplanationController {
  readonly request: CommitExplanationRequestHandler
  readonly cancel: CommitExplanationCancelHandler
  readonly present: CommitExplanationPresentationHandler
  readonly getState: (
    workspaceId: string,
    workspaceGeneration: number,
    commitEvidenceId: string,
  ) => CommitExplanationControllerStateV1 | null
  readonly subscribe: (listener: () => void) => () => void
}

export interface ExplainSkillInjectionAudit {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly skillId: "coding-wife-explain-commit"
  readonly skillVersion: string
  readonly contentDigest: string
  readonly pathAuthority: SkillPathAuthority
  readonly injectionMode: "skill_input"
  readonly requestId: string
  readonly injectedAt: string
}

export interface CommitExplanationStartedV1 {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly requestId: string
  readonly commitEvidenceId: string
  readonly workspaceGeneration: number
  readonly selectionVersion: number
  readonly locale: "ja" | "en"
  readonly skillInjection: ExplainSkillInjectionAudit
  readonly startedAt: string
}

export interface CommitExplanationDeltaV1 {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly requestId: string
  readonly commitEvidenceId: string
  readonly workspaceGeneration: number
  readonly selectionVersion: number
  readonly locale: "ja" | "en"
  readonly sequence: number
  readonly text: string
  readonly done: boolean
}

export type CommitExplanationTerminalStatus =
  | "completed"
  | "canceled"
  | "unavailable"
  | "failed"
  | "timeout"
  | "stale"

export interface CommitExplanationUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
}

export interface CommitExplanationTerminalV1 {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly requestId: string
  readonly commitEvidenceId: string
  readonly workspaceGeneration: number
  readonly selectionVersion: number
  readonly locale: "ja" | "en"
  readonly status: CommitExplanationTerminalStatus
  readonly usage: CommitExplanationUsage | null
  readonly latencyMs: number
  readonly errorCode: string | null
  readonly completedAt: string
}

export type CommitExplanationCancelReason =
  | "user"
  | "selection_changed"
  | "workspace_changed"
  | "route_changed"
  | "superseded"

export interface CommitExplanationCancelRequestedV1 {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly requestId: string
  readonly workspaceGeneration: number
  readonly selectionVersion: number
  readonly reason: CommitExplanationCancelReason
  readonly requestedAt: string
}

export class GitReviewContractError extends Error {
  constructor() {
    super("The value did not match the read-only Git review contract.")
    this.name = "GitReviewContractError"
  }
}

type JsonRecord = Readonly<Record<string, unknown>>

const changeKinds = ["added", "modified", "deleted", "type_changed"] as const
const gateKinds = ["scope", "ownership", "verification", "risk"] as const
const gateOutcomes = ["pass", "needs_review", "fail", "unknown"] as const
const producerKinds = ["main_codex", "external_uncorrelated"] as const
const verificationResults = [
  "passed",
  "failed",
  "skipped",
  "inconclusive",
] as const

function violation(): never {
  throw new GitReviewContractError()
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exact(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  )
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.some((item) => item === value)
}

function uint(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
  )
}

function positive(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return uint(value, maximum) && value > 0
}

function text(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.trim().length > 0) &&
    value.length <= maximum &&
    !value.includes("\0")
  )
}

const maxCommitEvidencePayloadBytes = 64 * 1024
const maxGitCommitSubjectLength = 1024
const maxGitCommitBodyLength = 16 * 1024
const maxGitAuthorNameLength = 256
const maxGitAuthorEmailLength = 512
const maxGitVerificationCheckLength = 512
const maxGitRiskMitigationLength = 2048

function containsPrivateMaterial(value: string): boolean {
  return (
    /(?:^|[\s=:'"(,[<{])(?:\/(?:[A-Za-z0-9_~.+@%{}$-]+)){2,}/i.test(value) ||
    /(?:^|[\s=:'"(,[<{])[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]+/i.test(value) ||
    /(?:bearer\s+[a-z0-9._~+/=-]{6,}|(?:authorization|api[ _-]?key|access[ _-]?(?:key|token)|refresh[ _-]?token|id[ _-]?token|token|password|passwd|secret|client[ _-]?secret|private[ _-]?key|auth[ _-]?cookie|cookie|set-cookie|session[ _-]?id|sessionid)\s*[:=]\s*[^\s,;]{3,})/i.test(
      value,
    ) ||
    /\b(?:gh[pousr]_[a-z0-9]{8,}|github_pat_[a-z0-9_]{8,}|(?:akia|asia)[a-z0-9]{16}|xox[baprs]-[a-z0-9-]{10,}|(?:sk|sess|rk|pk)-[a-z0-9_-]{12,})\b/i.test(
      value,
    ) ||
    /-----begin(?: [a-z0-9]+)* private key-----/i.test(value) ||
    value.toLocaleLowerCase().includes("chain-of-thought")
  )
}

function containsCommitEvidencePrivateMaterial(value: string): boolean {
  return (
    containsPrivateMaterial(value) ||
    /(?:<workspace>|<path>|\[redacted\])/i.test(value) ||
    /(?:~|\$home|\$\{home\}|%userprofile%)[\\/]/i.test(value) ||
    /(?:^|[\s=:'"(,[<{])(?:(?:\.\.?)[\\/][^\s,'")\]>}]+|(?:src(?:-tauri)?|docs|tests?|packages?|apps?|scripts?|public|assets?|config|crates?|\.github|node_modules|target)[\\/][^\s,'")\]>}]+|(?:[a-z0-9_.@+-]+[\\/])+(?:[a-z0-9_.@+-]+\.[a-z0-9]{1,16}))/i.test(
      value,
    )
  )
}

function isPublicCommitEvidencePayload(value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value)
    if (
      new TextEncoder().encode(encoded).byteLength >
      maxCommitEvidencePayloadBytes
    ) {
      return false
    }

    const pending: unknown[] = [value]
    const seen = new Set<object>()
    while (pending.length > 0) {
      const current = pending.pop()
      if (typeof current === "string") {
        if (containsCommitEvidencePrivateMaterial(current)) return false
      } else if (Array.isArray(current)) {
        if (seen.has(current)) return false
        seen.add(current)
        pending.push(...(current as unknown[]))
      } else if (record(current)) {
        if (seen.has(current)) return false
        seen.add(current)
        if (
          Object.keys(current).some((key) =>
            [
              "relativePath",
              "fileEvidenceId",
              "content",
              "rawDiff",
              "repositoryPath",
            ].includes(key),
          )
        ) {
          return false
        }
        pending.push(...Object.values(current))
      }
    }
    return true
  } catch {
    return false
  }
}

function publicText(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  return text(value, maximum, allowEmpty) && !containsPrivateMaterial(value)
}

function publicExplanationText(
  value: unknown,
  maximumScalars: number,
): value is string {
  return (
    publicText(value, maximumScalars * 2) &&
    Array.from(value).length <= maximumScalars &&
    !Array.from(value).some((character) => /\p{Cc}/u.test(character)) &&
    !containsCommitEvidencePrivateMaterial(value) &&
    !value.toLocaleLowerCase().includes("file:") &&
    !value.includes("://") &&
    !value.includes("\\")
  )
}

function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,160}$/.test(value)
}

function sha(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value)
  )
}

function commitEvidenceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:commit-)[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value)
  )
}

function commitExplanationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0)
      return (
        codePoint !== undefined &&
        codePoint >= 0x21 &&
        codePoint <= 0x7e &&
        character !== "/" &&
        character !== "\\"
      )
    })
  )
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-fA-F0-9]{64}$/.test(value)
}

function timestamp(value: unknown): value is string {
  return (
    text(value, 128) &&
    value.includes("T") &&
    Number.isFinite(Date.parse(value))
  )
}

function commitExplanationTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  )
}

function relativePath(value: unknown): value is string {
  return (
    publicText(value, 4096) &&
    !value.startsWith("/") &&
    !value.startsWith("-") &&
    !value.includes(",") &&
    !value
      .split("/")
      .some((part) => part === ".." || part.toLocaleLowerCase() === ".git")
  )
}

function nullable<T>(
  value: unknown,
  parser: (item: unknown) => item is T,
): value is T | null {
  return value === null || parser(value)
}

function arrayOf<T>(
  value: unknown,
  maximumItems: number,
  parser: (item: unknown) => T,
): value is T[] {
  if (!Array.isArray(value) || value.length > maximumItems) return false
  try {
    value.forEach(parser)
    return true
  } catch {
    return false
  }
}

function stringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
  allowEmpty = false,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => publicText(item, maximumLength, allowEmpty))
  )
}

function parseDiffSummary(value: unknown): DiffSummary {
  if (
    !record(value) ||
    !exact(value, ["filesChanged", "additions", "deletions", "binaryFiles"]) ||
    !uint(value.filesChanged, 500) ||
    !uint(value.additions, 50_000) ||
    !uint(value.deletions, 50_000) ||
    !uint(value.binaryFiles, 500) ||
    value.binaryFiles > value.filesChanged
  ) {
    return violation()
  }
  return value as unknown as DiffSummary
}

function parseVerification(value: unknown): VerificationEvidence {
  if (
    !record(value) ||
    !exact(value, [
      "evidenceId",
      "sourceEventId",
      "check",
      "result",
      "durationMs",
      "summary",
    ]) ||
    !id(value.evidenceId) ||
    !id(value.sourceEventId) ||
    !publicText(value.check, maxGitVerificationCheckLength) ||
    !oneOf(value.result, verificationResults) ||
    !uint(value.durationMs, 86_400_000) ||
    !publicText(value.summary, 4096, true)
  ) {
    return violation()
  }
  return value as unknown as VerificationEvidence
}

function parseDecision(value: unknown): DecisionEvidence {
  if (
    !record(value) ||
    !exact(value, [
      "decisionId",
      "sourceEventId",
      "summary",
      "answer",
      "rationale",
      "reversible",
    ]) ||
    !id(value.decisionId) ||
    !id(value.sourceEventId) ||
    !publicText(value.summary, 2048) ||
    !publicText(value.answer, 2048) ||
    !publicText(value.rationale, 4096, true) ||
    typeof value.reversible !== "boolean"
  ) {
    return violation()
  }
  return value as unknown as DecisionEvidence
}

function parseAttempt(value: unknown): FailedAttemptEvidence {
  if (
    !record(value) ||
    !exact(value, [
      "attemptId",
      "sourceEventId",
      "approach",
      "outcome",
      "learning",
    ]) ||
    !id(value.attemptId) ||
    !id(value.sourceEventId) ||
    !publicText(value.approach, 2048) ||
    !publicText(value.outcome, 1024) ||
    !publicText(value.learning, 2048, true)
  ) {
    return violation()
  }
  return value as unknown as FailedAttemptEvidence
}

function parseRisk(value: unknown): KnownRisk {
  if (
    !record(value) ||
    !exact(value, [
      "riskId",
      "sourceEventId",
      "category",
      "level",
      "summary",
      "mitigation",
      "resolved",
    ]) ||
    !id(value.riskId) ||
    !id(value.sourceEventId) ||
    !publicText(value.category, 256) ||
    !oneOf(value.level, ["low", "medium", "high", "critical"] as const) ||
    !publicText(value.summary, 2048) ||
    !publicText(value.mitigation, maxGitRiskMitigationLength, true) ||
    typeof value.resolved !== "boolean"
  ) {
    return violation()
  }
  return value as unknown as KnownRisk
}

function parseGate(value: unknown): GateResult {
  if (
    !record(value) ||
    !exact(value, ["gate", "outcome", "reasonCodes", "evidenceIds"]) ||
    !oneOf(value.gate, gateKinds) ||
    !oneOf(value.outcome, gateOutcomes) ||
    !stringArray(value.reasonCodes, 20, 256) ||
    !Array.isArray(value.evidenceIds) ||
    value.evidenceIds.length > 100 ||
    !value.evidenceIds.every(id)
  ) {
    return violation()
  }
  return value as unknown as GateResult
}

function parseCommitSkillAudit(value: unknown): CommitSkillInjectionAudit {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "skillId",
      "skillVersion",
      "contentDigest",
      "pathAuthority",
      "injectionMode",
      "workspaceGeneration",
      "workUnitId",
      "clientRequestId",
      "injectedAt",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    value.skillId !== "coding-wife-commit-work" ||
    !publicText(value.skillVersion, 64) ||
    !hash(value.contentDigest) ||
    value.pathAuthority !== "app_bundle" ||
    !oneOf(value.injectionMode, [
      "skill_input",
      "developer_instructions",
    ] as const) ||
    !positive(value.workspaceGeneration) ||
    !id(value.workUnitId) ||
    !id(value.clientRequestId) ||
    !timestamp(value.injectedAt)
  ) {
    return violation()
  }
  return value as unknown as CommitSkillInjectionAudit
}

function parseProtectedChange(value: unknown): ProtectedChangeSummary {
  if (
    !record(value) ||
    !exact(value, [
      "fileId",
      "relativePath",
      "changeKind",
      "staged",
      "unstaged",
      "untracked",
    ]) ||
    !id(value.fileId) ||
    !relativePath(value.relativePath) ||
    !oneOf(value.changeKind, changeKinds) ||
    typeof value.staged !== "boolean" ||
    typeof value.unstaged !== "boolean" ||
    typeof value.untracked !== "boolean" ||
    (!value.staged && !value.unstaged && !value.untracked)
  ) {
    return violation()
  }
  return value as unknown as ProtectedChangeSummary
}

export function parseGitObservation(value: unknown): GitObservation {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "observationId",
      "workspaceId",
      "workspaceGeneration",
      "reason",
      "workUnitId",
      "sourceEventId",
      "supportState",
      "headSha",
      "headReference",
      "branch",
      "detached",
      "indexFingerprint",
      "statusFingerprint",
      "repositoryFingerprint",
      "preExisting",
      "blockedReasons",
      "capturedAt",
      "historySequence",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !id(value.observationId) ||
    !id(value.workspaceId) ||
    !positive(value.workspaceGeneration) ||
    !oneOf(value.reason, [
      "active_view",
      "work_unit_started",
      "work_unit_terminal",
      "manual_refresh",
    ] as const) ||
    !nullable(value.workUnitId, id) ||
    !nullable(value.sourceEventId, id) ||
    !oneOf(value.supportState, ["ready", "blocked"] as const) ||
    !(value.headSha === "unborn" || sha(value.headSha)) ||
    !nullable(value.headReference, (item): item is string =>
      publicText(item, 512),
    ) ||
    !publicText(value.branch, 512) ||
    typeof value.detached !== "boolean" ||
    !hash(value.indexFingerprint) ||
    !hash(value.statusFingerprint) ||
    !hash(value.repositoryFingerprint) ||
    !arrayOf(value.preExisting, 500, parseProtectedChange) ||
    !stringArray(value.blockedReasons, 20, 256) ||
    !timestamp(value.capturedAt) ||
    !nullable(value.historySequence, uint)
  ) {
    return violation()
  }
  return value as unknown as GitObservation
}

function parseCommitIdentity(value: unknown): CommitIdentity {
  if (
    !record(value) ||
    !exact(value, [
      "commitSha",
      "subject",
      "body",
      "authorName",
      "authorEmail",
      "authoredAt",
      "committedAt",
      "parents",
    ]) ||
    !sha(value.commitSha) ||
    !publicText(value.subject, maxGitCommitSubjectLength) ||
    !publicText(value.body, maxGitCommitBodyLength, true) ||
    !publicText(value.authorName, maxGitAuthorNameLength) ||
    !publicText(value.authorEmail, maxGitAuthorEmailLength) ||
    !timestamp(value.authoredAt) ||
    !timestamp(value.committedAt) ||
    !Array.isArray(value.parents) ||
    value.parents.length > 32 ||
    !value.parents.every(sha)
  ) {
    return violation()
  }
  return value as unknown as CommitIdentity
}

function parseCommitFile(value: unknown): CommitFileSummary {
  if (
    !record(value) ||
    !exact(value, [
      "fileEvidenceId",
      "relativePath",
      "changeKind",
      "additions",
      "deletions",
      "binary",
    ]) ||
    !id(value.fileEvidenceId) ||
    !relativePath(value.relativePath) ||
    !oneOf(value.changeKind, changeKinds) ||
    !uint(value.additions, 50_000) ||
    !uint(value.deletions, 50_000) ||
    typeof value.binary !== "boolean"
  ) {
    return violation()
  }
  return value as unknown as CommitFileSummary
}

export function parseCommitEvidenceDetail(
  value: unknown,
): CommitEvidenceDetail {
  if (!record(value)) return violation()
  const diffSummary = parseDiffSummary(value.diffSummary)
  if (
    !exact(value, [
      "schemaVersion",
      "commitEvidenceId",
      "workspaceId",
      "producer",
      "identity",
      "workUnitId",
      "objective",
      "acceptance",
      "beforeObservationId",
      "afterObservationId",
      "sourceEventId",
      "gates",
      "files",
      "diffSummary",
      "verification",
      "decisions",
      "failedAttempts",
      "risks",
      "commitSkillInjection",
      "observedAt",
      "historySequence",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !id(value.commitEvidenceId) ||
    !id(value.workspaceId) ||
    !oneOf(value.producer, producerKinds) ||
    !parseCommitIdentity(value.identity) ||
    !nullable(value.workUnitId, id) ||
    !nullable(value.objective, (item): item is string =>
      publicText(item, 8192),
    ) ||
    !stringArray(value.acceptance, 20, 4096) ||
    !nullable(value.beforeObservationId, id) ||
    !nullable(value.afterObservationId, id) ||
    !nullable(value.sourceEventId, id) ||
    !arrayOf(value.gates, 4, parseGate) ||
    value.gates.length !== 4 ||
    new Set(value.gates.map((gate) => gate.gate)).size !== 4 ||
    !arrayOf(value.files, 500, parseCommitFile) ||
    diffSummary.filesChanged !== value.files.length ||
    !arrayOf(value.verification, 100, parseVerification) ||
    !arrayOf(value.decisions, 100, parseDecision) ||
    !arrayOf(value.failedAttempts, 100, parseAttempt) ||
    !arrayOf(value.risks, 100, parseRisk) ||
    !nullable(
      value.commitSkillInjection,
      (item): item is CommitSkillInjectionAudit => {
        try {
          parseCommitSkillAudit(item)
          return true
        } catch {
          return false
        }
      },
    ) ||
    !timestamp(value.observedAt) ||
    !nullable(value.historySequence, uint)
  ) {
    return violation()
  }
  const correlated =
    value.workUnitId !== null &&
    value.beforeObservationId !== null &&
    value.afterObservationId !== null &&
    value.sourceEventId !== null &&
    value.commitSkillInjection !== null
  if (
    (value.producer === "main_codex" && !correlated) ||
    (value.producer === "external_uncorrelated" && correlated)
  ) {
    return violation()
  }
  return value as unknown as CommitEvidenceDetail
}

function parseCommitSummary(value: unknown): CommitEvidenceSummary {
  if (
    !record(value) ||
    !exact(value, [
      "commitEvidenceId",
      "commitSha",
      "subject",
      "authorName",
      "authoredAt",
      "parentCount",
      "producer",
      "workUnitId",
      "verificationOutcome",
      "riskOutcome",
      "diffSummary",
      "historySequence",
    ]) ||
    !id(value.commitEvidenceId) ||
    !sha(value.commitSha) ||
    !publicText(value.subject, 1024) ||
    !publicText(value.authorName, 512) ||
    !timestamp(value.authoredAt) ||
    !uint(value.parentCount, 32) ||
    !oneOf(value.producer, producerKinds) ||
    !nullable(value.workUnitId, id) ||
    !oneOf(value.verificationOutcome, gateOutcomes) ||
    !oneOf(value.riskOutcome, gateOutcomes) ||
    !parseDiffSummary(value.diffSummary) ||
    !nullable(value.historySequence, uint)
  ) {
    return violation()
  }
  return value as unknown as CommitEvidenceSummary
}

function parseCommitPage(value: unknown): CommitEvidencePage {
  if (
    !record(value) ||
    !exact(value, ["schemaVersion", "items", "nextCursor"]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !arrayOf(value.items, 51, parseCommitSummary) ||
    !nullable(value.nextCursor, id)
  ) {
    return violation()
  }
  return value as unknown as CommitEvidencePage
}

export function parseWorkUnitGitObservation(
  value: unknown,
): WorkUnitGitObservation {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "workspaceId",
      "workspaceGeneration",
      "workUnitId",
      "sourceEventId",
      "terminalState",
      "beforeObservationId",
      "afterObservationId",
      "newCommitEvidenceIds",
      "commitSkillInjection",
      "reportedCommitBlockReason",
      "observedAt",
      "historySequence",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !id(value.workspaceId) ||
    !positive(value.workspaceGeneration) ||
    !id(value.workUnitId) ||
    !id(value.sourceEventId) ||
    !oneOf(value.terminalState, [
      "completed",
      "failed",
      "interrupted",
      "canceled",
    ] as const) ||
    !id(value.beforeObservationId) ||
    !id(value.afterObservationId) ||
    !Array.isArray(value.newCommitEvidenceIds) ||
    value.newCommitEvidenceIds.length > 100 ||
    !value.newCommitEvidenceIds.every(id) ||
    !parseCommitSkillAudit(value.commitSkillInjection) ||
    !nullable(value.reportedCommitBlockReason, (item): item is string =>
      publicText(item, 2048),
    ) ||
    !timestamp(value.observedAt) ||
    !nullable(value.historySequence, uint)
  ) {
    return violation()
  }
  return value as unknown as WorkUnitGitObservation
}

function parseTerminalResult(
  value: unknown,
): TerminalWorkUnitObservationResult {
  if (
    !record(value) ||
    !exact(value, ["schemaVersion", "observation", "workUnit", "newCommits"]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !parseGitObservation(value.observation) ||
    !parseWorkUnitGitObservation(value.workUnit) ||
    !arrayOf(value.newCommits, 100, parseCommitSummary)
  ) {
    return violation()
  }
  return value as unknown as TerminalWorkUnitObservationResult
}

export function parseCommitDiffFile(value: unknown): CommitDiffFile {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "commitEvidenceId",
      "fileEvidenceId",
      "relativePath",
      "changeKind",
      "state",
      "content",
      "byteCount",
      "additions",
      "deletions",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !id(value.commitEvidenceId) ||
    !id(value.fileEvidenceId) ||
    !relativePath(value.relativePath) ||
    !oneOf(value.changeKind, changeKinds) ||
    !oneOf(value.state, [
      "text",
      "binary",
      "oversize",
      "invalid_utf8",
    ] as const) ||
    !publicText(value.content, 1024 * 1024, true) ||
    (value.state !== "text" && value.content !== "") ||
    !uint(value.byteCount, 128 * 1024 * 1024) ||
    !uint(value.additions, 50_000) ||
    !uint(value.deletions, 50_000)
  ) {
    return violation()
  }
  return value as unknown as CommitDiffFile
}

function parseChangeAggregate(value: unknown): CommitChangeAggregate {
  if (
    !record(value) ||
    !exact(value, [
      "changeKind",
      "fileCount",
      "additions",
      "deletions",
      "binaryFiles",
    ]) ||
    !oneOf(value.changeKind, changeKinds) ||
    !uint(value.fileCount, 500) ||
    !uint(value.additions, 50_000) ||
    !uint(value.deletions, 50_000) ||
    !uint(value.binaryFiles, 500) ||
    value.binaryFiles > value.fileCount
  ) {
    return violation()
  }
  return value as unknown as CommitChangeAggregate
}

export function parseCommitEvidenceV1(value: unknown): CommitEvidenceV1 {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "commitId",
      "subject",
      "body",
      "changes",
      "diffSummary",
      "verification",
      "decisions",
      "risks",
      "locale",
      "workspaceGeneration",
      "selectionVersion",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !id(value.commitId) ||
    !publicText(value.subject, maxGitCommitSubjectLength) ||
    !publicText(value.body, maxGitCommitBodyLength, true) ||
    !arrayOf(value.changes, 4, parseChangeAggregate) ||
    !parseDiffSummary(value.diffSummary) ||
    !arrayOf(value.verification, 100, parseVerification) ||
    !arrayOf(value.decisions, 100, parseDecision) ||
    !arrayOf(value.risks, 100, parseRisk) ||
    !oneOf(value.locale, ["ja", "en"] as const) ||
    !positive(value.workspaceGeneration) ||
    !positive(value.selectionVersion)
  ) {
    return violation()
  }
  if (!isPublicCommitEvidencePayload(value)) {
    return violation()
  }
  return value as unknown as CommitEvidenceV1
}

export function parseGitReviewError(value: unknown): GitReviewErrorEnvelope {
  if (
    !record(value) ||
    !exact(
      value,
      ["code", "operation", "recoverable", "userMessageKey"],
      ["detailRef"],
    ) ||
    !id(value.code) ||
    !text(value.operation, 160) ||
    typeof value.recoverable !== "boolean" ||
    !id(value.userMessageKey) ||
    (value.detailRef !== undefined && !publicText(value.detailRef, 256))
  ) {
    return violation()
  }
  return value as unknown as GitReviewErrorEnvelope
}

export function parseGitReviewResponse<C extends GitReviewCommand>(
  command: C,
  value: unknown,
): GitReviewResponseMap[C] {
  let parsed: GitReviewResponseMap[GitReviewCommand]
  switch (command) {
    case "observe_git_repository":
      parsed = parseGitObservation(value)
      break
    case "observe_terminal_work_unit":
      parsed = parseTerminalResult(value)
      break
    case "list_commit_evidence":
      parsed = parseCommitPage(value)
      break
    case "read_commit_evidence":
      parsed = parseCommitEvidenceDetail(value)
      break
    case "read_commit_diff_file":
      parsed = parseCommitDiffFile(value)
      break
    case "prepare_commit_explanation_evidence":
      parsed = parseCommitEvidenceV1(value)
      break
    default:
      return violation()
  }
  return parsed as GitReviewResponseMap[C]
}

export function createCommitExplanationRequested(
  value: CommitExplanationRequestedV1,
): CommitExplanationRequestedV1 {
  if (
    !exact(value as unknown as JsonRecord, [
      "schemaVersion",
      "requestId",
      "workspaceId",
      "workspaceGeneration",
      "commitEvidenceId",
      "locale",
      "selectionVersion",
      "trigger",
      "requestedAt",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !commitExplanationId(value.requestId) ||
    !commitExplanationId(value.workspaceId) ||
    !positive(value.workspaceGeneration) ||
    !commitEvidenceId(value.commitEvidenceId) ||
    !oneOf(value.locale, ["ja", "en"] as const) ||
    !positive(value.selectionVersion) ||
    !oneOf(value.trigger, [
      "auto_verified_commit",
      "user_request",
      "user_retry",
    ] as const) ||
    !commitExplanationTimestamp(value.requestedAt)
  ) {
    return violation()
  }
  return value
}

export function createCommitExplanationDispatch(
  value: CommitExplanationDispatchV1,
): CommitExplanationDispatchV1 {
  if (!record(value) || !exact(value, ["request", "evidence"])) {
    return violation()
  }
  const request = createCommitExplanationRequested(value.request)
  const evidence = parseCommitEvidenceV1(value.evidence)
  if (
    evidence.commitId !== request.commitEvidenceId ||
    evidence.workspaceGeneration !== request.workspaceGeneration ||
    evidence.locale !== request.locale ||
    evidence.selectionVersion !== request.selectionVersion
  ) {
    return violation()
  }
  return { request, evidence }
}

export function createCommitExplanationStateRequested(
  value: CommitExplanationStateRequestedV1,
): CommitExplanationStateRequestedV1 {
  if (
    !exact(value as unknown as JsonRecord, [
      "schemaVersion",
      "workspaceId",
      "workspaceGeneration",
      "commitEvidenceId",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !commitExplanationId(value.workspaceId) ||
    !positive(value.workspaceGeneration) ||
    !commitEvidenceId(value.commitEvidenceId)
  ) {
    return violation()
  }
  return value
}

export function createCommitExplanationScopeRequested(
  value: CommitExplanationScopeRequestedV1,
): CommitExplanationScopeRequestedV1 {
  if (
    !exact(value as unknown as JsonRecord, [
      "schemaVersion",
      "workspaceId",
      "workspaceGeneration",
      "locale",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !commitExplanationId(value.workspaceId) ||
    !positive(value.workspaceGeneration) ||
    !oneOf(value.locale, ["ja", "en"] as const)
  ) {
    return violation()
  }
  return value
}

export function parseCommitExplanationControllerState(
  value: unknown,
): CommitExplanationControllerStateV1 {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "workspaceId",
      "workspaceGeneration",
      "commitEvidenceId",
      "requestId",
      "locale",
      "selectionVersion",
      "status",
      "trigger",
      "retryable",
      "presentationAvailable",
      "errorCode",
      "updatedAt",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !commitExplanationId(value.workspaceId) ||
    !positive(value.workspaceGeneration) ||
    !commitEvidenceId(value.commitEvidenceId) ||
    !nullable(value.requestId, commitExplanationId) ||
    !nullable(value.locale, (item): item is CommitExplanationLocale =>
      oneOf(item, ["ja", "en"] as const),
    ) ||
    !nullable(value.selectionVersion, positive) ||
    !oneOf(value.status, [
      "not_generated",
      "queued",
      "running",
      "generated",
      "failed",
      "unavailable",
      "canceled",
    ] as const) ||
    !nullable(value.trigger, (item): item is CommitExplanationRequestTrigger =>
      oneOf(item, [
        "auto_verified_commit",
        "user_request",
        "user_retry",
      ] as const),
    ) ||
    typeof value.retryable !== "boolean" ||
    typeof value.presentationAvailable !== "boolean" ||
    !nullable(value.errorCode, id) ||
    !commitExplanationTimestamp(value.updatedAt)
  ) {
    return violation()
  }

  const hasRequest =
    value.requestId !== null &&
    value.locale !== null &&
    value.selectionVersion !== null &&
    value.trigger !== null
  const noRequest =
    value.requestId === null &&
    value.locale === null &&
    value.selectionVersion === null &&
    value.trigger === null
  const validLifecycle =
    (value.status === "not_generated" &&
      noRequest &&
      !value.retryable &&
      !value.presentationAvailable &&
      value.errorCode === null) ||
    ((value.status === "queued" || value.status === "running") &&
      hasRequest &&
      !value.retryable &&
      !value.presentationAvailable &&
      value.errorCode === null) ||
    (value.status === "generated" &&
      hasRequest &&
      !value.retryable &&
      value.presentationAvailable &&
      value.errorCode === null) ||
    ((value.status === "failed" ||
      value.status === "unavailable" ||
      value.status === "canceled") &&
      hasRequest &&
      value.retryable &&
      !value.presentationAvailable &&
      value.errorCode !== null)
  if (!validLifecycle) return violation()

  return value as unknown as CommitExplanationControllerStateV1
}

const explanationNarrationSections = [
  "summary",
  "changes",
  "reasons",
  "verification",
  "impact",
  "cautions",
  "howToReadNext",
] as const

function parseCommitExplanationTextArray(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 16 ||
    !value.every((item) => publicExplanationText(item, 2048))
  ) {
    return violation()
  }
  return [...value] as string[]
}

function parseCommitExplanation(value: unknown): CommitExplanationV1 {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "locale",
      "summary",
      "changes",
      "reasons",
      "verification",
      "impact",
      "cautions",
      "howToReadNext",
      "narrationChunks",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !oneOf(value.locale, ["ja", "en"] as const) ||
    !publicExplanationText(value.summary, 4096) ||
    !Array.isArray(value.narrationChunks) ||
    value.narrationChunks.length < 1 ||
    value.narrationChunks.length > 32
  ) {
    return violation()
  }

  const narrationChunks: ExplanationNarrationChunkV1[] = []
  let previousSection = 0
  for (const [index, chunk] of value.narrationChunks.entries()) {
    if (
      !record(chunk) ||
      !exact(chunk, ["sequence", "section", "text"]) ||
      chunk.sequence !== index + 1 ||
      !oneOf(chunk.section, explanationNarrationSections) ||
      !publicExplanationText(chunk.text, 240)
    ) {
      return violation()
    }
    const section = explanationNarrationSections.indexOf(chunk.section)
    if (section < previousSection) return violation()
    previousSection = section
    narrationChunks.push({
      sequence: chunk.sequence,
      section: chunk.section,
      text: chunk.text,
    })
  }

  const explanation: CommitExplanationV1 = {
    schemaVersion: gitReviewSchemaVersion,
    locale: value.locale,
    summary: value.summary,
    changes: parseCommitExplanationTextArray(value.changes),
    reasons: parseCommitExplanationTextArray(value.reasons),
    verification: parseCommitExplanationTextArray(value.verification),
    impact: parseCommitExplanationTextArray(value.impact),
    cautions: parseCommitExplanationTextArray(value.cautions),
    howToReadNext: parseCommitExplanationTextArray(value.howToReadNext),
    narrationChunks,
  }
  if (
    new TextEncoder().encode(JSON.stringify(explanation)).byteLength >
    64 * 1024
  ) {
    return violation()
  }
  return explanation
}

function parseCommitExplanationUsage(
  value: unknown,
): CommitExplanationSupportUsageV1 {
  if (
    !record(value) ||
    !exact(value, ["inputTokens", "outputTokens", "totalTokens"]) ||
    !uint(value.inputTokens) ||
    !uint(value.outputTokens) ||
    !uint(value.totalTokens)
  ) {
    return violation()
  }
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
  }
}

export function parseCommitExplanationPresentation(
  value: unknown,
): CommitExplanationPresentationV1 {
  if (!record(value)) return violation()
  const explanation = parseCommitExplanation(value.explanation)
  const usage = parseCommitExplanationUsage(value.usage)
  if (
    !exact(value, [
      "schemaVersion",
      "workspaceId",
      "workspaceGeneration",
      "commitEvidenceId",
      "requestId",
      "selectionVersion",
      "trigger",
      "locale",
      "mode",
      "explanation",
      "usage",
      "latencyMs",
      "presentedAt",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !commitExplanationId(value.workspaceId) ||
    !positive(value.workspaceGeneration) ||
    !commitEvidenceId(value.commitEvidenceId) ||
    !commitExplanationId(value.requestId) ||
    !positive(value.selectionVersion) ||
    !oneOf(value.trigger, [
      "auto_verified_commit",
      "user_request",
      "user_retry",
    ] as const) ||
    !oneOf(value.locale, ["ja", "en"] as const) ||
    !oneOf(value.mode, ["show", "replay_narration"] as const) ||
    explanation.locale !== value.locale ||
    !uint(value.latencyMs) ||
    !commitExplanationTimestamp(value.presentedAt)
  ) {
    return violation()
  }
  return {
    schemaVersion: gitReviewSchemaVersion,
    workspaceId: value.workspaceId,
    workspaceGeneration: value.workspaceGeneration,
    commitEvidenceId: value.commitEvidenceId,
    requestId: value.requestId,
    selectionVersion: value.selectionVersion,
    trigger: value.trigger,
    locale: value.locale,
    mode: value.mode,
    explanation,
    usage,
    latencyMs: value.latencyMs,
    presentedAt: value.presentedAt,
  }
}

export function parseCommitExplanationControllerError(
  value: unknown,
): CommitExplanationControllerErrorEnvelope {
  if (
    !record(value) ||
    !exact(value, ["code", "operation", "recoverable", "userMessageKey"]) ||
    !id(value.code) ||
    !publicText(value.operation, 128) ||
    typeof value.recoverable !== "boolean" ||
    !publicText(value.userMessageKey, 160)
  ) {
    return violation()
  }
  return {
    code: value.code,
    operation: value.operation,
    recoverable: value.recoverable,
    userMessageKey: value.userMessageKey,
  }
}

export function createCommitExplanationPresentationRequested(
  value: CommitExplanationPresentationRequestedV1,
): CommitExplanationPresentationRequestedV1 {
  if (
    !exact(value as unknown as JsonRecord, [
      "schemaVersion",
      "workspaceId",
      "workspaceGeneration",
      "commitEvidenceId",
      "requestId",
      "mode",
      "requestedAt",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !commitExplanationId(value.workspaceId) ||
    !positive(value.workspaceGeneration) ||
    !commitEvidenceId(value.commitEvidenceId) ||
    !commitExplanationId(value.requestId) ||
    !oneOf(value.mode, ["show", "replay_narration"] as const) ||
    !commitExplanationTimestamp(value.requestedAt)
  ) {
    return violation()
  }
  return value
}

export function createCommitExplanationCancelRequested(
  value: CommitExplanationCancelRequestedV1,
): CommitExplanationCancelRequestedV1 {
  if (
    !exact(value as unknown as JsonRecord, [
      "schemaVersion",
      "requestId",
      "workspaceGeneration",
      "selectionVersion",
      "reason",
      "requestedAt",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !commitExplanationId(value.requestId) ||
    !positive(value.workspaceGeneration) ||
    !positive(value.selectionVersion) ||
    !oneOf(value.reason, [
      "user",
      "selection_changed",
      "workspace_changed",
      "route_changed",
      "superseded",
    ] as const) ||
    !commitExplanationTimestamp(value.requestedAt)
  ) {
    return violation()
  }
  return value
}
