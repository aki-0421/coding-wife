export const gitReviewSchemaVersion = 1 as const

export const gitReviewCommands = {
  inspectBaseline: "inspect_git_baseline",
  evaluateCheckpoint: "evaluate_and_checkpoint_work_unit",
  listReviewPacks: "list_git_review_packs",
  readReviewPack: "read_git_review_pack",
  readFileDiff: "read_evidence_diff",
  compareCheckpoints: "compare_checkpoints",
  previewRestore: "preview_git_restore",
  confirmRestore: "confirm_git_restore",
  cancelRestore: "cancel_git_restore",
} as const

export type GitSupportState = "ready" | "read_only" | "blocked"
export type ChangeKind = "added" | "modified" | "deleted" | "type_changed"
export type OwnershipClass =
  "owned" | "pre_existing" | "external" | "overlap" | "unowned"
export type GateOutcome = "pass" | "needs_review" | "fail" | "unknown"
export type GateKind = "scope" | "ownership" | "verification" | "risk"
export type RiskLevel = "low" | "medium" | "high" | "critical"
export type VerificationResult =
  "passed" | "failed" | "skipped" | "inconclusive"
export type CheckpointStatus = "blocked" | "review_ready" | "failed"
export type CheckpointOperationState =
  "prepared" | "objects_ready" | "ref_updated" | "history_complete" | "failed"
export type RestoreKind = "revert_commit" | "recovery_branch"
export type RestorePreviewStatus = "ready" | "blocked"

export interface ProtectedChangeSummary {
  readonly fileId: string
  readonly relativePath: string
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
  readonly contentHash: string | null
}

export interface GitBaseline {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly baselineId: string
  readonly workspaceId: string
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
}

export interface GitFileEvent {
  readonly eventId: string
  readonly relativePath: string
  readonly operation: ChangeKind
  readonly beforeHash: string | null
  readonly afterHash: string | null
  readonly observedHeadSha: string
  readonly observedIndexFingerprint: string
}

export interface VerificationEvidence {
  readonly evidenceId: string
  readonly check: string
  readonly result: VerificationResult
  readonly durationMs: number
  readonly summary: string
  readonly observedRepositoryFingerprint: string
}

export interface DecisionEvidence {
  readonly decisionId: string
  readonly summary: string
  readonly answer: string
  readonly rationale: string
  readonly reversible: boolean
}

export interface FailedAttemptEvidence {
  readonly attemptId: string
  readonly approach: string
  readonly outcome: string
  readonly learning: string
}

export interface KnownRisk {
  readonly riskId: string
  readonly category: string
  readonly level: RiskLevel
  readonly summary: string
  readonly mitigation: string
  readonly resolved: boolean
}

export interface RiskApproval {
  readonly approvalId: string
  readonly approvedCategories: readonly string[]
  readonly observedRepositoryFingerprint: string
  readonly approvedAt: string
}

export interface GateResult {
  readonly gate: GateKind
  readonly outcome: GateOutcome
  readonly reasonCodes: readonly string[]
  readonly observedRepositoryFingerprint: string
}

export interface ManifestEntry {
  readonly fileId: string
  readonly relativePath: string
  readonly changeKind: ChangeKind
  readonly ownership: OwnershipClass
  readonly beforeHash: string | null
  readonly afterHash: string | null
  readonly additions: number
  readonly deletions: number
  readonly reasonCode: string | null
}

export interface DiffSummary {
  readonly filesChanged: number
  readonly additions: number
  readonly deletions: number
  readonly binaryFiles: number
  readonly totalBytes: number
}

export interface CheckpointIdentity {
  readonly checkpointId: string
  readonly commitSha: string
  readonly parentSha: string
  readonly targetReference: string
  readonly message: string
  readonly authorName: string
  readonly authorEmail: string
  readonly createdAt: string
}

export interface ReviewPack {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly checkpoint: CheckpointIdentity
  readonly workspaceId: string
  readonly workUnitId: string
  readonly objective: string
  readonly acceptance: readonly string[]
  readonly gates: readonly GateResult[]
  readonly manifest: readonly ManifestEntry[]
  readonly diffSummary: DiffSummary
  readonly verification: readonly VerificationEvidence[]
  readonly decisions: readonly DecisionEvidence[]
  readonly failedAttempts: readonly FailedAttemptEvidence[]
  readonly risks: readonly KnownRisk[]
  readonly restoreGuidance: readonly string[]
  readonly operationState: CheckpointOperationState
  readonly packDigest: string
  readonly historySequence: number | null
}

export interface CheckpointEvaluation {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly status: CheckpointStatus
  readonly gates: readonly GateResult[]
  readonly manifest: readonly ManifestEntry[]
  readonly checkpoint: CheckpointIdentity | null
  readonly reviewPack: ReviewPack | null
  readonly errorCode: string | null
}

export interface ReviewPackSummary {
  readonly checkpointId: string
  readonly commitSha: string
  readonly workUnitId: string
  readonly objective: string
  readonly operationState: CheckpointOperationState
  readonly filesChanged: number
  readonly verificationFailures: number
  readonly unresolvedRisks: number
  readonly createdAt: string
  readonly historySequence: number
}

export interface ReviewPackPage {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly items: readonly ReviewPackSummary[]
  readonly nextBeforeSequence: number | null
}

export interface FileDiffView {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly checkpointId: string
  readonly fileId: string
  readonly relativePath: string
  readonly changeKind: ChangeKind
  readonly ownership: OwnershipClass
  readonly content: string
  readonly truncated: boolean
  readonly byteCount: number
}

export interface CompareCheckpointsView {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly fromCommitSha: string
  readonly toCommitSha: string
  readonly diffSummary: DiffSummary
  readonly files: readonly ManifestEntry[]
  readonly verificationChanges: readonly string[]
  readonly decisionChanges: readonly string[]
  readonly riskChanges: readonly string[]
}

export interface RestoreImpact {
  readonly targetCommitSha: string
  readonly currentHeadSha: string
  readonly affectedFiles: readonly string[]
  readonly additions: number
  readonly deletions: number
  readonly createsNewCommit: boolean
  readonly checksOutBranch: boolean
}

export interface RestorePreview {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly status: RestorePreviewStatus
  readonly kind: RestoreKind
  readonly checkpointId: string
  readonly impact: RestoreImpact
  readonly confirmationToken: string | null
  readonly expiresAt: string | null
  readonly blockedReasons: readonly string[]
}

export interface RestoreResult {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly kind: RestoreKind
  readonly checkpointId: string
  readonly createdCommitSha: string | null
  readonly createdReference: string | null
  readonly historySequence: number | null
  readonly completedAt: string
}

export interface InspectGitBaselineRequest {
  readonly workspaceId: string
}

export interface EvaluateCheckpointRequest {
  readonly schemaVersion: typeof gitReviewSchemaVersion
  readonly clientRequestId: string
  readonly workspaceId: string
  readonly baselineId: string
  readonly workUnitId: string
  readonly objective: string
  readonly acceptance: readonly string[]
  readonly fileEvents: readonly GitFileEvent[]
  readonly verification: readonly VerificationEvidence[]
  readonly decisions: readonly DecisionEvidence[]
  readonly failedAttempts: readonly FailedAttemptEvidence[]
  readonly risks: readonly KnownRisk[]
  readonly riskApproval: RiskApproval | null
  readonly commitMessage: string
}

export interface ListReviewPacksRequest {
  readonly workspaceId: string
  readonly beforeSequence: number | null
  readonly limit: number
}

export interface ReviewPackDetailRequest {
  readonly workspaceId: string
  readonly checkpointId: string
}

export interface ReadFileDiffRequest extends ReviewPackDetailRequest {
  readonly fileId: string
}

export interface CompareCheckpointsRequest {
  readonly workspaceId: string
  readonly fromCheckpointId: string
  readonly toCheckpointId: string
}

export interface PreviewRestoreRequest extends ReviewPackDetailRequest {
  readonly kind: RestoreKind
  readonly recoveryBranch: string | null
}

export interface ConfirmRestoreRequest {
  readonly workspaceId: string
  readonly confirmationToken: string
}

export type CancelRestoreRequest = ConfirmRestoreRequest

export interface GitReviewErrorEnvelope {
  readonly code: string
  readonly operation: string
  readonly recoverable: boolean
  readonly userMessageKey: string
  readonly detailRef?: string
}

export interface GitReviewRequestMap {
  inspect_git_baseline: InspectGitBaselineRequest
  evaluate_and_checkpoint_work_unit: EvaluateCheckpointRequest
  list_git_review_packs: ListReviewPacksRequest
  read_git_review_pack: ReviewPackDetailRequest
  read_evidence_diff: ReadFileDiffRequest
  compare_checkpoints: CompareCheckpointsRequest
  preview_git_restore: PreviewRestoreRequest
  confirm_git_restore: ConfirmRestoreRequest
  cancel_git_restore: CancelRestoreRequest
}

export interface GitReviewResponseMap {
  inspect_git_baseline: GitBaseline
  evaluate_and_checkpoint_work_unit: CheckpointEvaluation
  list_git_review_packs: ReviewPackPage
  read_git_review_pack: ReviewPack
  read_evidence_diff: FileDiffView
  compare_checkpoints: CompareCheckpointsView
  preview_git_restore: RestorePreview
  confirm_git_restore: RestoreResult
  cancel_git_restore: null
}

export type GitReviewCommand = keyof GitReviewRequestMap &
  keyof GitReviewResponseMap

export class GitReviewContractError extends Error {
  constructor() {
    super("The value did not match the Git review contract.")
    this.name = "GitReviewContractError"
  }
}

type JsonRecord = Readonly<Record<string, unknown>>

const changeKinds = ["added", "modified", "deleted", "type_changed"] as const
const ownershipClasses = [
  "owned",
  "pre_existing",
  "external",
  "overlap",
  "unowned",
] as const
const gateKinds = ["scope", "ownership", "verification", "risk"] as const
const gateOutcomes = ["pass", "needs_review", "fail", "unknown"] as const
const operationStates = [
  "prepared",
  "objects_ready",
  "ref_updated",
  "history_complete",
  "failed",
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
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= maximum
  )
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

function containsPrivateMaterial(value: string): boolean {
  return (
    /(?:^|[\s"'])\/(?:users|volumes|library|applications)\//i.test(value) ||
    /(?:bearer\s+[a-z0-9._~+/=-]{6,}|(?:api[_-]?key|auth[_-]?cookie|sessionid|set-cookie)\s*[:=])/i.test(
      value,
    ) ||
    value.toLocaleLowerCase().includes("chain-of-thought")
  )
}

function publicText(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  return text(value, maximum, allowEmpty) && !containsPrivateMaterial(value)
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

function hash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-fA-F0-9]{64}$/.test(value)
}

function nullableHash(value: unknown): value is string | null {
  return value === null || hash(value)
}

function timestamp(value: unknown): value is string {
  return (
    text(value, 128) &&
    value.includes("T") &&
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

function parseProtectedChange(value: unknown): ProtectedChangeSummary {
  if (
    !record(value) ||
    !exact(value, [
      "fileId",
      "relativePath",
      "staged",
      "unstaged",
      "untracked",
      "contentHash",
    ]) ||
    !id(value.fileId) ||
    !relativePath(value.relativePath) ||
    typeof value.staged !== "boolean" ||
    typeof value.unstaged !== "boolean" ||
    typeof value.untracked !== "boolean" ||
    !nullableHash(value.contentHash)
  ) {
    return violation()
  }
  return value as unknown as ProtectedChangeSummary
}

export function parseGitBaseline(value: unknown): GitBaseline {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "baselineId",
      "workspaceId",
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
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !id(value.baselineId) ||
    !id(value.workspaceId) ||
    !oneOf(value.supportState, ["ready", "read_only", "blocked"] as const) ||
    !(value.headSha === "unborn" || sha(value.headSha)) ||
    !(value.headReference === null || publicText(value.headReference, 251)) ||
    !publicText(value.branch, 251) ||
    typeof value.detached !== "boolean" ||
    !hash(value.indexFingerprint) ||
    !hash(value.statusFingerprint) ||
    !hash(value.repositoryFingerprint) ||
    !Array.isArray(value.preExisting) ||
    value.preExisting.length > 500 ||
    !value.preExisting.every((item) => parseProtectedChange(item)) ||
    !stringArray(value.blockedReasons, 100, 256) ||
    !timestamp(value.capturedAt)
  ) {
    return violation()
  }
  return value as unknown as GitBaseline
}

function parseGate(value: unknown): GateResult {
  if (
    !record(value) ||
    !exact(value, [
      "gate",
      "outcome",
      "reasonCodes",
      "observedRepositoryFingerprint",
    ]) ||
    !oneOf(value.gate, gateKinds) ||
    !oneOf(value.outcome, gateOutcomes) ||
    !stringArray(value.reasonCodes, 100, 256) ||
    !hash(value.observedRepositoryFingerprint)
  ) {
    return violation()
  }
  return value as unknown as GateResult
}

function parseManifest(value: unknown): ManifestEntry {
  if (
    !record(value) ||
    !exact(value, [
      "fileId",
      "relativePath",
      "changeKind",
      "ownership",
      "beforeHash",
      "afterHash",
      "additions",
      "deletions",
      "reasonCode",
    ]) ||
    !id(value.fileId) ||
    !relativePath(value.relativePath) ||
    !oneOf(value.changeKind, changeKinds) ||
    !oneOf(value.ownership, ownershipClasses) ||
    !nullableHash(value.beforeHash) ||
    !nullableHash(value.afterHash) ||
    !uint(value.additions, 50_000) ||
    !uint(value.deletions, 50_000) ||
    !(value.reasonCode === null || publicText(value.reasonCode, 256))
  ) {
    return violation()
  }
  return value as unknown as ManifestEntry
}

function parseDiffSummary(value: unknown): DiffSummary {
  if (
    !record(value) ||
    !exact(value, [
      "filesChanged",
      "additions",
      "deletions",
      "binaryFiles",
      "totalBytes",
    ]) ||
    !uint(value.filesChanged, 500) ||
    !uint(value.additions, 50_000) ||
    !uint(value.deletions, 50_000) ||
    !uint(value.binaryFiles, 500) ||
    !uint(value.totalBytes, 50 * 1024 * 1024)
  ) {
    return violation()
  }
  return value as unknown as DiffSummary
}

function parseCheckpoint(value: unknown): CheckpointIdentity {
  if (
    !record(value) ||
    !exact(value, [
      "checkpointId",
      "commitSha",
      "parentSha",
      "targetReference",
      "message",
      "authorName",
      "authorEmail",
      "createdAt",
    ]) ||
    !id(value.checkpointId) ||
    !sha(value.commitSha) ||
    !sha(value.parentSha) ||
    !publicText(value.targetReference, 251) ||
    !publicText(value.message, 8192) ||
    !publicText(value.authorName, 256) ||
    !publicText(value.authorEmail, 512) ||
    !timestamp(value.createdAt)
  ) {
    return violation()
  }
  return value as unknown as CheckpointIdentity
}

function parseVerification(value: unknown): VerificationEvidence {
  if (
    !record(value) ||
    !exact(value, [
      "evidenceId",
      "check",
      "result",
      "durationMs",
      "summary",
      "observedRepositoryFingerprint",
    ]) ||
    !id(value.evidenceId) ||
    !publicText(value.check, 512) ||
    !oneOf(value.result, [
      "passed",
      "failed",
      "skipped",
      "inconclusive",
    ] as const) ||
    !uint(value.durationMs) ||
    !publicText(value.summary, 4096, true) ||
    !hash(value.observedRepositoryFingerprint)
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
      "summary",
      "answer",
      "rationale",
      "reversible",
    ]) ||
    !id(value.decisionId) ||
    !publicText(value.summary, 2048) ||
    !publicText(value.answer, 2048) ||
    !publicText(value.rationale, 4096) ||
    typeof value.reversible !== "boolean"
  ) {
    return violation()
  }
  return value as unknown as DecisionEvidence
}

function parseAttempt(value: unknown): FailedAttemptEvidence {
  if (
    !record(value) ||
    !exact(value, ["attemptId", "approach", "outcome", "learning"]) ||
    !id(value.attemptId) ||
    !publicText(value.approach, 2048) ||
    !publicText(value.outcome, 1024) ||
    !publicText(value.learning, 2048)
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
      "category",
      "level",
      "summary",
      "mitigation",
      "resolved",
    ]) ||
    !id(value.riskId) ||
    !publicText(value.category, 256) ||
    !oneOf(value.level, ["low", "medium", "high", "critical"] as const) ||
    !publicText(value.summary, 2048) ||
    !publicText(value.mitigation, 2048) ||
    typeof value.resolved !== "boolean"
  ) {
    return violation()
  }
  return value as unknown as KnownRisk
}

export function parseReviewPack(value: unknown): ReviewPack {
  if (
    !record(value) ||
    !exact(value, [
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
      "historySequence",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !parseCheckpoint(value.checkpoint) ||
    !id(value.workspaceId) ||
    !id(value.workUnitId) ||
    !publicText(value.objective, 500) ||
    !stringArray(value.acceptance, 20, 500) ||
    value.acceptance.length === 0 ||
    !Array.isArray(value.gates) ||
    value.gates.length !== 4 ||
    !value.gates.every((item) => parseGate(item)) ||
    new Set(value.gates.map((item) => (item as JsonRecord).gate)).size !== 4 ||
    !value.gates.every((item) => (item as JsonRecord).outcome === "pass") ||
    !Array.isArray(value.manifest) ||
    value.manifest.length > 500 ||
    !value.manifest.every((item) => parseManifest(item)) ||
    !parseDiffSummary(value.diffSummary) ||
    !Array.isArray(value.verification) ||
    value.verification.length === 0 ||
    value.verification.length > 100 ||
    !value.verification.every(
      (item) => parseVerification(item).result === "passed",
    ) ||
    !Array.isArray(value.decisions) ||
    value.decisions.length > 100 ||
    !value.decisions.every((item) => parseDecision(item)) ||
    !Array.isArray(value.failedAttempts) ||
    value.failedAttempts.length > 100 ||
    !value.failedAttempts.every((item) => parseAttempt(item)) ||
    !Array.isArray(value.risks) ||
    value.risks.length > 100 ||
    !value.risks.every((item) => parseRisk(item)) ||
    !stringArray(value.restoreGuidance, 20, 1024) ||
    value.operationState !== "history_complete" ||
    !hash(value.packDigest) ||
    !(value.historySequence === null || uint(value.historySequence))
  ) {
    return violation()
  }
  return value as unknown as ReviewPack
}

export function parseCheckpointEvaluation(
  value: unknown,
): CheckpointEvaluation {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "status",
      "gates",
      "manifest",
      "checkpoint",
      "reviewPack",
      "errorCode",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !oneOf(value.status, ["blocked", "review_ready", "failed"] as const) ||
    !Array.isArray(value.gates) ||
    value.gates.length !== 4 ||
    !value.gates.every((item) => parseGate(item)) ||
    !Array.isArray(value.manifest) ||
    value.manifest.length > 500 ||
    !value.manifest.every((item) => parseManifest(item)) ||
    !(value.checkpoint === null || parseCheckpoint(value.checkpoint)) ||
    !(value.reviewPack === null || parseReviewPack(value.reviewPack)) ||
    !(value.errorCode === null || publicText(value.errorCode, 128)) ||
    (value.status === "review_ready" &&
      (value.checkpoint === null ||
        value.reviewPack === null ||
        value.errorCode !== null)) ||
    (value.status !== "review_ready" &&
      (value.checkpoint !== null || value.reviewPack !== null))
  ) {
    return violation()
  }
  return value as unknown as CheckpointEvaluation
}

function parsePackSummary(value: unknown): ReviewPackSummary {
  if (
    !record(value) ||
    !exact(value, [
      "checkpointId",
      "commitSha",
      "workUnitId",
      "objective",
      "operationState",
      "filesChanged",
      "verificationFailures",
      "unresolvedRisks",
      "createdAt",
      "historySequence",
    ]) ||
    !id(value.checkpointId) ||
    !sha(value.commitSha) ||
    !id(value.workUnitId) ||
    !publicText(value.objective, 500) ||
    !oneOf(value.operationState, operationStates) ||
    !uint(value.filesChanged, 500) ||
    !uint(value.verificationFailures, 100) ||
    !uint(value.unresolvedRisks, 100) ||
    !timestamp(value.createdAt) ||
    !uint(value.historySequence)
  ) {
    return violation()
  }
  return value as unknown as ReviewPackSummary
}

export function parseReviewPackPage(value: unknown): ReviewPackPage {
  if (
    !record(value) ||
    !exact(value, ["schemaVersion", "items", "nextBeforeSequence"]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !Array.isArray(value.items) ||
    value.items.length > 200 ||
    !value.items.every((item) => parsePackSummary(item)) ||
    !(value.nextBeforeSequence === null || uint(value.nextBeforeSequence))
  ) {
    return violation()
  }
  return value as unknown as ReviewPackPage
}

export function parseFileDiffView(value: unknown): FileDiffView {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "checkpointId",
      "fileId",
      "relativePath",
      "changeKind",
      "ownership",
      "content",
      "truncated",
      "byteCount",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !id(value.checkpointId) ||
    !id(value.fileId) ||
    !relativePath(value.relativePath) ||
    !oneOf(value.changeKind, changeKinds) ||
    !oneOf(value.ownership, ownershipClasses) ||
    !publicText(value.content, 1024 * 1024, true) ||
    typeof value.truncated !== "boolean" ||
    !uint(value.byteCount)
  ) {
    return violation()
  }
  return value as unknown as FileDiffView
}

export function parseCompareCheckpointsView(
  value: unknown,
): CompareCheckpointsView {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "fromCommitSha",
      "toCommitSha",
      "diffSummary",
      "files",
      "verificationChanges",
      "decisionChanges",
      "riskChanges",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !sha(value.fromCommitSha) ||
    !sha(value.toCommitSha) ||
    !parseDiffSummary(value.diffSummary) ||
    !Array.isArray(value.files) ||
    value.files.length > 500 ||
    !value.files.every((item) => parseManifest(item)) ||
    !stringArray(value.verificationChanges, 200, 512) ||
    !stringArray(value.decisionChanges, 200, 512) ||
    !stringArray(value.riskChanges, 200, 512)
  ) {
    return violation()
  }
  return value as unknown as CompareCheckpointsView
}

function parseRestoreImpact(value: unknown): RestoreImpact {
  if (
    !record(value) ||
    !exact(value, [
      "targetCommitSha",
      "currentHeadSha",
      "affectedFiles",
      "additions",
      "deletions",
      "createsNewCommit",
      "checksOutBranch",
    ]) ||
    !sha(value.targetCommitSha) ||
    !sha(value.currentHeadSha) ||
    !Array.isArray(value.affectedFiles) ||
    value.affectedFiles.length > 500 ||
    !value.affectedFiles.every((item) => relativePath(item)) ||
    !uint(value.additions, 50_000) ||
    !uint(value.deletions, 50_000) ||
    typeof value.createsNewCommit !== "boolean" ||
    value.checksOutBranch !== false
  ) {
    return violation()
  }
  return value as unknown as RestoreImpact
}

export function parseRestorePreview(value: unknown): RestorePreview {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "status",
      "kind",
      "checkpointId",
      "impact",
      "confirmationToken",
      "expiresAt",
      "blockedReasons",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !oneOf(value.status, ["ready", "blocked"] as const) ||
    !oneOf(value.kind, ["revert_commit", "recovery_branch"] as const) ||
    !id(value.checkpointId) ||
    !parseRestoreImpact(value.impact) ||
    !(value.confirmationToken === null || id(value.confirmationToken)) ||
    !(value.expiresAt === null || timestamp(value.expiresAt)) ||
    !stringArray(value.blockedReasons, 100, 256) ||
    (value.status === "ready" &&
      (value.confirmationToken === null ||
        value.expiresAt === null ||
        value.blockedReasons.length > 0)) ||
    (value.status === "blocked" &&
      (value.confirmationToken !== null ||
        value.expiresAt !== null ||
        value.blockedReasons.length === 0))
  ) {
    return violation()
  }
  return value as unknown as RestorePreview
}

export function parseRestoreResult(value: unknown): RestoreResult {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "kind",
      "checkpointId",
      "createdCommitSha",
      "createdReference",
      "historySequence",
      "completedAt",
    ]) ||
    value.schemaVersion !== gitReviewSchemaVersion ||
    !oneOf(value.kind, ["revert_commit", "recovery_branch"] as const) ||
    !id(value.checkpointId) ||
    !(value.createdCommitSha === null || sha(value.createdCommitSha)) ||
    !(
      value.createdReference === null || publicText(value.createdReference, 251)
    ) ||
    !(value.historySequence === null || uint(value.historySequence)) ||
    !timestamp(value.completedAt) ||
    (value.kind === "revert_commit" && value.createdCommitSha === null) ||
    (value.kind === "recovery_branch" &&
      (value.createdCommitSha !== null || value.createdReference === null))
  ) {
    return violation()
  }
  return value as unknown as RestoreResult
}

export function parseGitReviewError(value: unknown): GitReviewErrorEnvelope {
  if (
    !record(value) ||
    !exact(
      value,
      ["code", "operation", "recoverable", "userMessageKey"],
      ["detailRef"],
    ) ||
    !publicText(value.code, 128) ||
    !publicText(value.operation, 128) ||
    typeof value.recoverable !== "boolean" ||
    !publicText(value.userMessageKey, 256) ||
    !(value.detailRef === undefined || publicText(value.detailRef, 256))
  ) {
    return violation()
  }
  return value as unknown as GitReviewErrorEnvelope
}

export function parseGitReviewResponse<C extends GitReviewCommand>(
  command: C,
  value: unknown,
): GitReviewResponseMap[C] {
  let parsed: unknown
  switch (command) {
    case "inspect_git_baseline":
      parsed = parseGitBaseline(value)
      break
    case "evaluate_and_checkpoint_work_unit":
      parsed = parseCheckpointEvaluation(value)
      break
    case "list_git_review_packs":
      parsed = parseReviewPackPage(value)
      break
    case "read_git_review_pack":
      parsed = parseReviewPack(value)
      break
    case "read_evidence_diff":
      parsed = parseFileDiffView(value)
      break
    case "compare_checkpoints":
      parsed = parseCompareCheckpointsView(value)
      break
    case "preview_git_restore":
      parsed = parseRestorePreview(value)
      break
    case "confirm_git_restore":
      parsed = parseRestoreResult(value)
      break
    case "cancel_git_restore":
      if (value !== null) return violation()
      parsed = null
      break
  }
  return parsed as GitReviewResponseMap[C]
}
