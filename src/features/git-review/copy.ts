import type { SupportedLocale } from "@/features/localization/types"
import type {
  ChangeKind,
  CommitEvidenceFilter,
  DiffContentState,
  GateKind,
  GateOutcome,
  GitObservationReason,
  RiskLevel,
  VerificationResult,
  CommitExplanationControllerStatus,
} from "@/lib/contracts/git-review"

export interface GitReviewCopy {
  readonly title: string
  readonly description: string
  readonly readOnly: string
  readonly openCommitList: string
  readonly close: string
  readonly refresh: string
  readonly refreshAccessible: string
  readonly refreshing: string
  readonly loading: string
  readonly retry: string
  readonly loadMore: string
  readonly backToChat: string
  readonly filters: Readonly<Record<CommitEvidenceFilter, string>>
  readonly repository: string
  readonly fresh: string
  readonly unavailable: string
  readonly lastObserved: string
  readonly observationReasons: Readonly<Record<GitObservationReason, string>>
  readonly protectedChanges: string
  readonly observerErrorTitle: string
  readonly observerErrorDescription: string
  readonly listErrorTitle: string
  readonly listErrorDescription: string
  readonly errorCode: string
  readonly noCommitsTitle: string
  readonly noCommitsDescription: string
  readonly noSelectionTitle: string
  readonly noSelectionDescription: string
  readonly uncorrelated: string
  readonly mainCodex: string
  readonly externalProducer: string
  readonly filesChanged: string
  readonly linesChanged: string
  readonly mergeCommit: string
  readonly verification: string
  readonly risk: string
  readonly gateLabels: Readonly<Record<GateKind, string>>
  readonly gateOutcomes: Readonly<Record<GateOutcome, string>>
  readonly tabs: {
    readonly overview: string
    readonly changes: string
    readonly evidence: string
  }
  readonly explain: string
  readonly explanationStatuses: Readonly<
    Record<CommitExplanationControllerStatus, string>
  >
  readonly explainPreparing: string
  readonly explainCanceling: string
  readonly explainUnavailable: string
  readonly showExplanation: string
  readonly replayExplanation: string
  readonly retryExplanation: string
  readonly cancelExplanation: string
  readonly message: string
  readonly identity: string
  readonly fullSha: string
  readonly copySha: string
  readonly copied: string
  readonly author: string
  readonly authored: string
  readonly committed: string
  readonly parents: string
  readonly correlation: string
  readonly workUnit: string
  readonly sourceEvent: string
  readonly beforeObservation: string
  readonly afterObservation: string
  readonly objective: string
  readonly acceptance: string
  readonly changeSummary: string
  readonly additions: string
  readonly deletions: string
  readonly binaryFiles: string
  readonly cautions: string
  readonly noCautions: string
  readonly fileList: string
  readonly chooseFile: string
  readonly diffLoading: string
  readonly diffError: string
  readonly diffStates: Readonly<
    Record<Exclude<DiffContentState, "text">, string>
  >
  readonly changeKinds: Readonly<Record<ChangeKind, string>>
  readonly gates: string
  readonly reasonCodes: string
  readonly noReasonCodes: string
  readonly verificationEvidence: string
  readonly noVerification: string
  readonly verificationResults: Readonly<Record<VerificationResult, string>>
  readonly decisions: string
  readonly noDecisions: string
  readonly answer: string
  readonly rationale: string
  readonly failedAttempts: string
  readonly noFailedAttempts: string
  readonly learning: string
  readonly risks: string
  readonly noRisks: string
  readonly mitigation: string
  readonly riskLevels: Readonly<Record<RiskLevel, string>>
  readonly skillAudit: string
  readonly skillVersion: string
  readonly injectionMode: string
  readonly observedAt: string
  readonly persisted: string
}

const sharedMaps = {
  changeKinds: {
    added: "Added",
    modified: "Modified",
    deleted: "Deleted",
    type_changed: "Type changed",
  },
  verificationResults: {
    passed: "Passed",
    failed: "Failed",
    skipped: "Skipped",
    inconclusive: "Inconclusive",
  },
  riskLevels: {
    low: "Low",
    medium: "Medium",
    high: "High",
    critical: "Critical",
  },
} as const

const en: GitReviewCopy = {
  title: "Commit evidence",
  description: "Read-only history observed from the local repository.",
  readOnly: "Read only",
  openCommitList: "Open commit list",
  close: "Close",
  refresh: "Refresh",
  refreshAccessible: "Refresh local Git observation",
  refreshing: "Observing…",
  loading: "Loading commit evidence…",
  retry: "Retry",
  loadMore: "Load earlier commits",
  backToChat: "Back to Chat",
  filters: {
    all: "All",
    this_work_unit: "This work unit",
    needs_attention: "Needs attention",
  },
  repository: "Repository",
  fresh: "Fresh",
  unavailable: "Unavailable",
  lastObserved: "Last observed",
  observationReasons: {
    active_view: "Commit tab opened",
    work_unit_started: "Work unit started",
    work_unit_terminal: "Work unit finished",
    manual_refresh: "Manual refresh",
  },
  protectedChanges: "pre-existing changes",
  observerErrorTitle: "Local Git observation is unavailable",
  observerErrorDescription:
    "Saved evidence remains readable. Refreshing never fetches or changes Git state.",
  listErrorTitle: "Commit evidence could not be loaded",
  listErrorDescription:
    "The repository was not changed. Try the read-only refresh again.",
  errorCode: "Error code",
  noCommitsTitle: "No observed commits yet",
  noCommitsDescription:
    "Commits made by the main Codex session will appear after a work unit is observed.",
  noSelectionTitle: "No commit selected",
  noSelectionDescription:
    "Choose an observed commit. A refresh never silently selects a replacement.",
  uncorrelated: "Uncorrelated",
  mainCodex: "Main Codex",
  externalProducer: "External / uncorrelated",
  filesChanged: "files",
  linesChanged: "lines",
  mergeCommit: "merge",
  verification: "Verification",
  risk: "Risk",
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
  tabs: { overview: "Overview", changes: "Changes", evidence: "Evidence" },
  explain: "Explain this commit",
  explanationStatuses: {
    not_generated: "Not generated",
    queued: "Explanation queued",
    running: "Generating explanation",
    generated: "Explanation ready",
    failed: "Explanation failed",
    unavailable: "Explanation unavailable",
    canceled: "Explanation canceled",
  },
  explainPreparing: "Preparing safe evidence…",
  explainCanceling: "Canceling explanation…",
  explainUnavailable:
    "The app-owned isolated explainer is unavailable. The main conversation is unchanged.",
  showExplanation: "Show explanation",
  replayExplanation: "Read aloud again",
  retryExplanation: "Retry explanation",
  cancelExplanation: "Cancel explanation",
  message: "Commit message",
  identity: "Identity",
  fullSha: "Full SHA",
  copySha: "Copy full SHA",
  copied: "Copied",
  author: "Author",
  authored: "Authored",
  committed: "Committed",
  parents: "Parents",
  correlation: "Work correlation",
  workUnit: "Work unit",
  sourceEvent: "Source event",
  beforeObservation: "Before observation",
  afterObservation: "After observation",
  objective: "Objective",
  acceptance: "Acceptance criteria",
  changeSummary: "Change summary",
  additions: "Additions",
  deletions: "Deletions",
  binaryFiles: "Binary files",
  cautions: "Known cautions",
  noCautions: "No unresolved caution was recorded.",
  fileList: "Changed files",
  chooseFile: "Choose a file to load its sanitized diff.",
  diffLoading: "Loading this file’s diff…",
  diffError:
    "This diff could not be loaded. Other evidence is still available.",
  diffStates: {
    binary: "Binary file — preview unavailable.",
    oversize: "Diff is too large to display safely.",
    invalid_utf8: "Text preview is unavailable for this encoding.",
  },
  changeKinds: sharedMaps.changeKinds,
  gates: "Observed gates",
  reasonCodes: "Reason codes",
  noReasonCodes: "No reason code was recorded.",
  verificationEvidence: "Verification evidence",
  noVerification: "No verification evidence was correlated.",
  verificationResults: sharedMaps.verificationResults,
  decisions: "Decisions",
  noDecisions: "No decision evidence was correlated.",
  answer: "Answer",
  rationale: "Rationale",
  failedAttempts: "Failed attempts",
  noFailedAttempts: "No failed attempt was recorded.",
  learning: "Learning",
  risks: "Known risks",
  noRisks: "No risk evidence was correlated.",
  mitigation: "Mitigation",
  riskLevels: sharedMaps.riskLevels,
  skillAudit: "Commit skill audit",
  skillVersion: "Skill version",
  injectionMode: "Injection mode",
  observedAt: "Observed",
  persisted: "Persisted",
}

const ja: GitReviewCopy = {
  ...en,
  title: "コミット証拠",
  description: "ローカルリポジトリから観測した読み取り専用の履歴です。",
  readOnly: "読み取り専用",
  openCommitList: "コミット一覧を開く",
  close: "閉じる",
  refresh: "更新",
  refreshAccessible: "ローカル Git の観測を更新",
  refreshing: "観測中…",
  loading: "コミット証拠を読み込んでいます…",
  retry: "再試行",
  loadMore: "以前のコミットを読み込む",
  backToChat: "Chat に戻る",
  filters: {
    all: "すべて",
    this_work_unit: "この作業単位",
    needs_attention: "要確認",
  },
  repository: "リポジトリ",
  fresh: "最新",
  unavailable: "利用不可",
  lastObserved: "最終観測",
  observationReasons: {
    active_view: "Commit タブを表示",
    work_unit_started: "作業単位を開始",
    work_unit_terminal: "作業単位を終了",
    manual_refresh: "手動更新",
  },
  protectedChanges: "既存の変更",
  observerErrorTitle: "ローカル Git を観測できません",
  observerErrorDescription:
    "保存済みの証拠は引き続き読めます。更新で fetch や Git 状態の変更は行いません。",
  listErrorTitle: "コミット証拠を読み込めませんでした",
  listErrorDescription:
    "リポジトリは変更されていません。読み取り専用の更新を再試行してください。",
  errorCode: "エラーコード",
  noCommitsTitle: "観測済みのコミットはまだありません",
  noCommitsDescription:
    "main Codex session が作成したコミットは、作業単位の観測後に表示されます。",
  noSelectionTitle: "コミットが選択されていません",
  noSelectionDescription:
    "観測済みコミットを選択してください。更新時に別のコミットへ自動変更しません。",
  uncorrelated: "未相関",
  mainCodex: "Main Codex",
  externalProducer: "外部 / 未相関",
  filesChanged: "ファイル",
  linesChanged: "行",
  mergeCommit: "マージ",
  verification: "検証",
  risk: "リスク",
  gateLabels: {
    scope: "範囲",
    ownership: "所有権",
    verification: "検証",
    risk: "リスク",
  },
  gateOutcomes: {
    pass: "合格",
    needs_review: "要確認",
    fail: "不合格",
    unknown: "不明",
  },
  tabs: { overview: "概要", changes: "変更", evidence: "証拠" },
  explain: "詳しく教えて",
  explanationStatuses: {
    not_generated: "未生成",
    queued: "説明を待機中",
    running: "説明を生成中",
    generated: "説明を生成済み",
    failed: "説明の生成に失敗",
    unavailable: "説明機能を利用不可",
    canceled: "説明をキャンセル済み",
  },
  explainPreparing: "安全な証拠を準備中…",
  explainCanceling: "説明をキャンセル中…",
  explainUnavailable:
    "アプリ所有の隔離説明機能を利用できません。main conversation は変更されません。",
  showExplanation: "説明を表示",
  replayExplanation: "もう一度読み上げる",
  retryExplanation: "説明を再試行",
  cancelExplanation: "説明をキャンセル",
  message: "コミットメッセージ",
  identity: "識別情報",
  fullSha: "完全な SHA",
  copySha: "完全な SHA をコピー",
  copied: "コピーしました",
  author: "作成者",
  authored: "作成日時",
  committed: "コミット日時",
  parents: "親コミット",
  correlation: "作業との相関",
  workUnit: "作業単位",
  sourceEvent: "元イベント",
  beforeObservation: "作業前の観測",
  afterObservation: "作業後の観測",
  objective: "目的",
  acceptance: "受け入れ条件",
  changeSummary: "変更概要",
  additions: "追加",
  deletions: "削除",
  binaryFiles: "バイナリ",
  cautions: "既知の注意点",
  noCautions: "未解決の注意点は記録されていません。",
  fileList: "変更ファイル",
  chooseFile: "ファイルを選ぶと、安全化された差分を読み込みます。",
  diffLoading: "このファイルの差分を読み込んでいます…",
  diffError: "この差分を読み込めませんでした。他の証拠は引き続き確認できます。",
  diffStates: {
    binary: "バイナリファイルのためプレビューできません。",
    oversize: "差分が大きすぎるため安全に表示できません。",
    invalid_utf8: "この文字コードはテキスト表示できません。",
  },
  changeKinds: {
    added: "追加",
    modified: "変更",
    deleted: "削除",
    type_changed: "種類変更",
  },
  gates: "観測されたゲート",
  reasonCodes: "理由コード",
  noReasonCodes: "理由コードは記録されていません。",
  verificationEvidence: "検証証拠",
  noVerification: "相関する検証証拠はありません。",
  verificationResults: {
    passed: "合格",
    failed: "失敗",
    skipped: "未実施",
    inconclusive: "判定不能",
  },
  decisions: "判断",
  noDecisions: "相関する判断はありません。",
  answer: "回答",
  rationale: "理由",
  failedAttempts: "失敗した試行",
  noFailedAttempts: "失敗した試行は記録されていません。",
  learning: "学び",
  risks: "既知のリスク",
  noRisks: "相関するリスク証拠はありません。",
  mitigation: "緩和策",
  riskLevels: {
    low: "低",
    medium: "中",
    high: "高",
    critical: "重大",
  },
  skillAudit: "コミット skill の監査",
  skillVersion: "Skill バージョン",
  injectionMode: "注入方法",
  observedAt: "観測日時",
  persisted: "保存済み",
}

export const gitReviewCopy: Readonly<Record<SupportedLocale, GitReviewCopy>> = {
  en,
  ja,
}
