import type { SupportedLocale } from "@/features/localization/types"
import type {
  ChangeKind,
  GateKind,
  GateOutcome,
  OwnershipClass,
  RiskLevel,
  VerificationResult,
} from "@/lib/contracts/git-review"

export type EvidenceFilter = "all" | "attention" | "ready" | "reverted"

export interface GitReviewCopy {
  readonly title: string
  readonly description: string
  readonly checkpointList: string
  readonly checkpointListDescription: string
  readonly storedSuffix: string
  readonly openCheckpointList: string
  readonly close: string
  readonly retry: string
  readonly refresh: string
  readonly refreshing: string
  readonly loadMore: string
  readonly loading: string
  readonly unavailable: string
  readonly noCheckpoint: string
  readonly noCheckpointTitle: string
  readonly noCheckpointDescription: string
  readonly backToChat: string
  readonly searchLabel: string
  readonly searchPlaceholder: string
  readonly filters: Readonly<Record<EvidenceFilter, string>>
  readonly status: {
    readonly ready: string
    readonly attention: string
    readonly blocked: string
    readonly failed: string
    readonly interrupted: string
    readonly reverted: string
    readonly readOnly: string
  }
  readonly shortSha: string
  readonly branch: string
  readonly detached: string
  readonly protectedChanges: string
  readonly files: string
  readonly tests: string
  readonly unresolvedRisks: string
  readonly gatesHeading: string
  readonly gateLabels: Readonly<Record<GateKind, string>>
  readonly gateOutcomes: Readonly<Record<GateOutcome, string>>
  readonly gateRecovery: Readonly<Record<GateKind, string>>
  readonly observedFingerprint: string
  readonly reasonCodes: string
  readonly noReasonCodes: string
  readonly tabs: {
    readonly overview: string
    readonly files: string
    readonly verification: string
    readonly decisions: string
    readonly attempts: string
    readonly risks: string
    readonly compare: string
    readonly restore: string
  }
  readonly objective: string
  readonly acceptance: string
  readonly commitMessage: string
  readonly checkpointMetadata: string
  readonly createdAt: string
  readonly targetReference: string
  readonly author: string
  readonly diffSummary: string
  readonly additions: string
  readonly deletions: string
  readonly binaryFiles: string
  readonly filePrompt: string
  readonly diffLoading: string
  readonly diffTruncated: string
  readonly diffLocalChunk: string
  readonly diffLineKinds: {
    readonly addition: string
    readonly deletion: string
    readonly hunk: string
    readonly context: string
  }
  readonly previousChunk: string
  readonly nextChunk: string
  readonly changeKinds: Readonly<Record<ChangeKind, string>>
  readonly ownership: Readonly<Record<OwnershipClass, string>>
  readonly verificationResults: Readonly<Record<VerificationResult, string>>
  readonly duration: string
  readonly noDecisions: string
  readonly answer: string
  readonly rationale: string
  readonly reversible: string
  readonly irreversible: string
  readonly noAttempts: string
  readonly attemptOutcome: string
  readonly learning: string
  readonly noRisks: string
  readonly riskLevels: Readonly<Record<RiskLevel, string>>
  readonly mitigation: string
  readonly resolved: string
  readonly unresolved: string
  readonly compareHeading: string
  readonly compareDescription: string
  readonly compareFrom: string
  readonly compareTo: string
  readonly chooseCheckpoint: string
  readonly compareAction: string
  readonly compareInvalid: string
  readonly verificationChanges: string
  readonly decisionChanges: string
  readonly riskChanges: string
  readonly noChanges: string
  readonly restoreHeading: string
  readonly restoreDescription: string
  readonly revertTitle: string
  readonly revertDescription: string
  readonly previewRevert: string
  readonly recoveryTitle: string
  readonly recoveryDescription: string
  readonly recoveryBranchLabel: string
  readonly previewRecovery: string
  readonly previewing: string
  readonly restoreBlocked: string
  readonly restoreBlockedDescription: string
  readonly restoreConfirmTitle: string
  readonly restoreConfirmRevert: string
  readonly restoreConfirmRecovery: string
  readonly restoreImpact: string
  readonly currentHead: string
  readonly targetCommit: string
  readonly affectedFiles: string
  readonly createsNewCommit: string
  readonly noCheckout: string
  readonly expiresAt: string
  readonly cancel: string
  readonly confirmRevert: string
  readonly confirmRecovery: string
  readonly confirming: string
  readonly restoreSucceeded: string
  readonly revertSucceeded: string
  readonly recoverySucceeded: string
  readonly dismiss: string
  readonly restoreGuidance: string
  readonly baselineWarning: string
  readonly listError: string
  readonly detailError: string
  readonly diffError: string
  readonly compareError: string
  readonly restoreError: string
  readonly errorCode: string
}

const en: GitReviewCopy = {
  title: "Checkpoint evidence",
  description: "Review work-unit scope, ownership, verification, and risk.",
  checkpointList: "Checkpoints",
  checkpointListDescription: "Automatic local checkpoints for this workspace.",
  storedSuffix: "stored",
  openCheckpointList: "Open checkpoint list",
  close: "Close",
  retry: "Retry",
  refresh: "Refresh",
  refreshing: "Refreshing…",
  loadMore: "Load earlier checkpoints",
  loading: "Loading evidence…",
  unavailable: "Unavailable",
  noCheckpoint: "No checkpoint",
  noCheckpointTitle: "No evidence yet",
  noCheckpointDescription:
    "Evidence appears after a work unit passes all four safety gates and its local checkpoint is stored.",
  backToChat: "Back to Chat",
  searchLabel: "Search checkpoints",
  searchPlaceholder: "Search objective or SHA",
  filters: {
    all: "All",
    attention: "Needs attention",
    ready: "Ready",
    reverted: "Reverted",
  },
  status: {
    ready: "Ready",
    attention: "Needs attention",
    blocked: "Blocked",
    failed: "Failed",
    interrupted: "Interrupted",
    reverted: "Reverted",
    readOnly: "Read only",
  },
  shortSha: "Commit",
  branch: "Branch",
  detached: "Detached HEAD",
  protectedChanges: "Protected user changes",
  files: "Files",
  tests: "Verification failures",
  unresolvedRisks: "Unresolved risks",
  gatesHeading: "Safety gates",
  gateLabels: {
    scope: "Scope",
    ownership: "Ownership",
    verification: "Verification",
    risk: "Risk",
  },
  gateOutcomes: {
    pass: "Pass",
    needs_review: "Needs review",
    fail: "Fail",
    unknown: "Unknown",
  },
  gateRecovery: {
    scope: "Return to Chat and narrow the work unit or acceptance criteria.",
    ownership: "Refresh the baseline and classify every changed hunk again.",
    verification: "Run the required checks or revise the work-unit scope.",
    risk: "Inspect impact and reversibility, then record an explicit decision.",
  },
  observedFingerprint: "Observed repository fingerprint",
  reasonCodes: "Reason codes",
  noReasonCodes: "No blocking reason was recorded.",
  tabs: {
    overview: "Overview",
    files: "Files",
    verification: "Verification",
    decisions: "Decisions",
    attempts: "Failed attempts",
    risks: "Risks",
    compare: "Compare",
    restore: "Restore",
  },
  objective: "Objective",
  acceptance: "Acceptance criteria",
  commitMessage: "Commit message",
  checkpointMetadata: "Checkpoint metadata",
  createdAt: "Created",
  targetReference: "Target reference",
  author: "Author",
  diffSummary: "Diff summary",
  additions: "Additions",
  deletions: "Deletions",
  binaryFiles: "Binary files",
  filePrompt: "Choose one file to load its sanitized diff.",
  diffLoading: "Loading this file’s diff…",
  diffTruncated: "The backend returned a size-limited diff.",
  diffLocalChunk: "Only one diff chunk is rendered at a time.",
  diffLineKinds: {
    addition: "addition",
    deletion: "deletion",
    hunk: "hunk header",
    context: "context",
  },
  previousChunk: "Previous chunk",
  nextChunk: "Next chunk",
  changeKinds: {
    added: "Added",
    modified: "Modified",
    deleted: "Deleted",
    type_changed: "Type changed",
  },
  ownership: {
    owned: "Owned",
    pre_existing: "Pre-existing",
    external: "External",
    overlap: "Overlap",
    unowned: "Unowned",
  },
  verificationResults: {
    passed: "Passed",
    failed: "Failed",
    skipped: "Skipped",
    inconclusive: "Inconclusive",
  },
  duration: "Duration",
  noDecisions: "No decisions were recorded.",
  answer: "Answer",
  rationale: "Rationale",
  reversible: "Reversible",
  irreversible: "Not reversible",
  noAttempts: "No failed attempts were recorded.",
  attemptOutcome: "Outcome",
  learning: "Learning",
  noRisks: "No known risks were recorded.",
  riskLevels: {
    low: "Low",
    medium: "Medium",
    high: "High",
    critical: "Critical",
  },
  mitigation: "Mitigation",
  resolved: "Resolved",
  unresolved: "Unresolved",
  compareHeading: "Compare checkpoints",
  compareDescription:
    "Compare two stored checkpoints without moving HEAD or the working tree.",
  compareFrom: "From",
  compareTo: "To",
  chooseCheckpoint: "Choose a checkpoint",
  compareAction: "Compare",
  compareInvalid: "Choose two different checkpoints.",
  verificationChanges: "Verification changes",
  decisionChanges: "Decision changes",
  riskChanges: "Risk changes",
  noChanges: "No changes were recorded in this category.",
  restoreHeading: "Safe restore",
  restoreDescription:
    "Every restore starts with a fresh Git preflight. The app never hard-resets or checks out over your work.",
  revertTitle: "Create a revert commit",
  revertDescription:
    "Reverse this checkpoint with a new local commit. The original commit remains in history.",
  previewRevert: "Preview revert",
  recoveryTitle: "Create a recovery branch",
  recoveryDescription:
    "Create a local branch at this checkpoint without checking it out or changing your files.",
  recoveryBranchLabel: "New branch name",
  previewRecovery: "Preview branch",
  previewing: "Running fresh Git preflight…",
  restoreBlocked: "Restore is blocked",
  restoreBlockedDescription:
    "No Git mutation was started. Resolve these conditions and run preflight again.",
  restoreConfirmTitle: "Confirm Git operation",
  restoreConfirmRevert:
    "This creates a new revert commit. It does not delete the selected checkpoint.",
  restoreConfirmRecovery:
    "This creates a local branch only. It does not check out the branch.",
  restoreImpact: "Expected impact",
  currentHead: "Current HEAD",
  targetCommit: "Target commit",
  affectedFiles: "Affected files",
  createsNewCommit: "Creates a new commit",
  noCheckout: "Does not check out a branch",
  expiresAt: "Confirmation expires",
  cancel: "Cancel",
  confirmRevert: "Create revert commit",
  confirmRecovery: "Create recovery branch",
  confirming: "Applying confirmed operation…",
  restoreSucceeded: "Git operation completed",
  revertSucceeded: "A new revert commit was created.",
  recoverySucceeded: "A local recovery branch was created without checkout.",
  dismiss: "Dismiss",
  restoreGuidance: "Recovery guidance",
  baselineWarning:
    "Current Git state could not be refreshed. Stored evidence remains read only.",
  listError: "Checkpoint evidence could not be loaded.",
  detailError: "This review pack could not be loaded.",
  diffError: "This file diff could not be loaded.",
  compareError: "The checkpoints could not be compared.",
  restoreError: "The Git operation could not be completed.",
  errorCode: "Error code",
}

const ja: GitReviewCopy = {
  title: "チェックポイント証拠",
  description: "作業単位の範囲、所有権、検証、リスクを確認します。",
  checkpointList: "チェックポイント",
  checkpointListDescription:
    "このワークスペースの自動ローカルチェックポイントです。",
  storedSuffix: "件",
  openCheckpointList: "チェックポイント一覧を開く",
  close: "閉じる",
  retry: "再試行",
  refresh: "更新",
  refreshing: "更新中…",
  loadMore: "以前のチェックポイントを読み込む",
  loading: "証拠を読み込んでいます…",
  unavailable: "利用不可",
  noCheckpoint: "チェックポイントなし",
  noCheckpointTitle: "証拠はまだありません",
  noCheckpointDescription:
    "作業単位が4つの安全ゲートをすべて通過し、ローカルチェックポイントが保存されると証拠が表示されます。",
  backToChat: "Chatへ戻る",
  searchLabel: "チェックポイントを検索",
  searchPlaceholder: "目的またはSHAを検索",
  filters: {
    all: "すべて",
    attention: "要確認",
    ready: "準備完了",
    reverted: "Revert済み",
  },
  status: {
    ready: "準備完了",
    attention: "要確認",
    blocked: "ブロック",
    failed: "失敗",
    interrupted: "中断",
    reverted: "Revert済み",
    readOnly: "読み取り専用",
  },
  shortSha: "コミット",
  branch: "ブランチ",
  detached: "Detached HEAD",
  protectedChanges: "保護されたユーザー変更",
  files: "ファイル",
  tests: "検証失敗",
  unresolvedRisks: "未解決リスク",
  gatesHeading: "安全ゲート",
  gateLabels: {
    scope: "範囲",
    ownership: "所有権",
    verification: "検証",
    risk: "リスク",
  },
  gateOutcomes: {
    pass: "通過",
    needs_review: "要確認",
    fail: "失敗",
    unknown: "不明",
  },
  gateRecovery: {
    scope: "Chatへ戻り、作業単位または受け入れ条件を絞り込みます。",
    ownership: "baselineを更新し、すべての変更hunkの所有権を再判定します。",
    verification: "必要な検証を実行するか、作業単位の範囲を修正します。",
    risk: "影響と可逆性を確認し、明示的な意思決定を記録します。",
  },
  observedFingerprint: "観測時のリポジトリfingerprint",
  reasonCodes: "判定理由",
  noReasonCodes: "ブロック理由は記録されていません。",
  tabs: {
    overview: "概要",
    files: "ファイル",
    verification: "検証",
    decisions: "意思決定",
    attempts: "失敗した試行",
    risks: "リスク",
    compare: "比較",
    restore: "復元",
  },
  objective: "目的",
  acceptance: "受け入れ条件",
  commitMessage: "コミットメッセージ",
  checkpointMetadata: "チェックポイント情報",
  createdAt: "作成日時",
  targetReference: "対象ref",
  author: "作成者",
  diffSummary: "差分概要",
  additions: "追加",
  deletions: "削除",
  binaryFiles: "バイナリファイル",
  filePrompt: "ファイルを1件選ぶと、sanitize済みdiffを読み込みます。",
  diffLoading: "このファイルのdiffを読み込んでいます…",
  diffTruncated: "バックエンドのサイズ上限によりdiffが省略されています。",
  diffLocalChunk: "DOMにはdiffの1チャンクだけを表示しています。",
  diffLineKinds: {
    addition: "追加",
    deletion: "削除",
    hunk: "hunk見出し",
    context: "前後行",
  },
  previousChunk: "前のチャンク",
  nextChunk: "次のチャンク",
  changeKinds: {
    added: "追加",
    modified: "変更",
    deleted: "削除",
    type_changed: "種別変更",
  },
  ownership: {
    owned: "所有済み",
    pre_existing: "既存変更",
    external: "外部変更",
    overlap: "重複",
    unowned: "未所有",
  },
  verificationResults: {
    passed: "成功",
    failed: "失敗",
    skipped: "未実行",
    inconclusive: "判定不能",
  },
  duration: "所要時間",
  noDecisions: "意思決定の記録はありません。",
  answer: "回答",
  rationale: "理由",
  reversible: "可逆",
  irreversible: "不可逆",
  noAttempts: "失敗した試行の記録はありません。",
  attemptOutcome: "結果",
  learning: "得られた知見",
  noRisks: "既知のリスクは記録されていません。",
  riskLevels: {
    low: "低",
    medium: "中",
    high: "高",
    critical: "重大",
  },
  mitigation: "緩和策",
  resolved: "解決済み",
  unresolved: "未解決",
  compareHeading: "チェックポイントを比較",
  compareDescription:
    "HEADやworking treeを移動せず、保存済みチェックポイント2件を比較します。",
  compareFrom: "比較元",
  compareTo: "比較先",
  chooseCheckpoint: "チェックポイントを選択",
  compareAction: "比較する",
  compareInvalid: "異なるチェックポイントを2件選んでください。",
  verificationChanges: "検証の変化",
  decisionChanges: "意思決定の変化",
  riskChanges: "リスクの変化",
  noChanges: "この項目の変化は記録されていません。",
  restoreHeading: "安全な復元",
  restoreDescription:
    "復元前に必ずGit状態を再検査します。hard resetや作業中ファイルへのcheckoutは行いません。",
  revertTitle: "Revertコミットを作成",
  revertDescription:
    "新しいローカルコミットでこのチェックポイントを反転します。元のコミットは履歴に残ります。",
  previewRevert: "Revertを事前確認",
  recoveryTitle: "復旧ブランチを作成",
  recoveryDescription:
    "ファイルを変更せず、このチェックポイントを指すローカルブランチを作成します。",
  recoveryBranchLabel: "新しいブランチ名",
  previewRecovery: "ブランチを事前確認",
  previewing: "最新のGit状態を検査しています…",
  restoreBlocked: "復元はブロックされています",
  restoreBlockedDescription:
    "Gitへの変更は開始していません。条件を解消してから再度検査してください。",
  restoreConfirmTitle: "Git操作の確認",
  restoreConfirmRevert:
    "新しいRevertコミットを作成します。選択したチェックポイントは削除されません。",
  restoreConfirmRecovery:
    "ローカルブランチだけを作成します。ブランチのcheckoutは行いません。",
  restoreImpact: "予想される影響",
  currentHead: "現在のHEAD",
  targetCommit: "対象コミット",
  affectedFiles: "対象ファイル",
  createsNewCommit: "新しいコミットを作成",
  noCheckout: "ブランチをcheckoutしない",
  expiresAt: "確認の有効期限",
  cancel: "キャンセル",
  confirmRevert: "Revertコミットを作成",
  confirmRecovery: "復旧ブランチを作成",
  confirming: "確認済み操作を実行しています…",
  restoreSucceeded: "Git操作が完了しました",
  revertSucceeded: "新しいRevertコミットを作成しました。",
  recoverySucceeded: "checkoutせずにローカル復旧ブランチを作成しました。",
  dismiss: "閉じる",
  restoreGuidance: "復旧ガイダンス",
  baselineWarning:
    "現在のGit状態を更新できませんでした。保存済み証拠は読み取り専用で確認できます。",
  listError: "チェックポイント証拠を読み込めませんでした。",
  detailError: "このレビューパックを読み込めませんでした。",
  diffError: "このファイルのdiffを読み込めませんでした。",
  compareError: "チェックポイントを比較できませんでした。",
  restoreError: "Git操作を完了できませんでした。",
  errorCode: "エラーコード",
}

export const gitReviewCopy: Readonly<Record<SupportedLocale, GitReviewCopy>> = {
  en,
  ja,
}
