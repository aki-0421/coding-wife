import type { SupportedLocale } from "@/features/localization/types"
import type { DiffContentState } from "@/lib/contracts/git-review"

export interface GitReviewCopy {
  readonly title: string
  readonly openCommitList: string
  readonly close: string
  readonly refreshAccessible: string
  readonly loading: string
  readonly retry: string
  readonly loadMore: string
  readonly backToChat: string
  readonly commitCount: (count: number) => string
  readonly observerErrorTitle: string
  readonly observerErrorDescription: string
  readonly listErrorTitle: string
  readonly listErrorDescription: string
  readonly noCommitsTitle: string
  readonly noCommitsDescription: string
  readonly noSelectionTitle: string
  readonly noSelectionDescription: string
  readonly filesChanged: (count: number) => string
  readonly copySha: string
  readonly copyPath: string
  readonly copied: string
  readonly explain: string
  readonly explainPreparing: string
  readonly explainCanceling: string
  readonly explainUnavailable: string
  readonly showExplanation: string
  readonly retryExplanation: string
  readonly cancelExplanation: string
  readonly fileList: string
  readonly filterFiles: string
  readonly noMatchingFiles: string
  readonly chooseFile: string
  readonly selectFile: string
  readonly previousFile: string
  readonly nextFile: string
  readonly fileStats: (additions: number, deletions: number) => string
  readonly collapseFile: string
  readonly expandFile: string
  readonly diffLoading: string
  readonly diffLabel: (relativePath: string) => string
  readonly diffError: string
  readonly diffEmpty: string
  readonly diffRenderLimit: string
  readonly noNewline: string
  readonly oldLine: (line: number) => string
  readonly newLine: (line: number) => string
  readonly diffMetadataSeparator: string
  readonly diffKinds: {
    readonly hunk: string
    readonly context: string
    readonly addition: string
    readonly deletion: string
    readonly no_newline: string
  }
  readonly diffStates: Readonly<
    Record<Exclude<DiffContentState, "text">, string>
  >
}

const en: GitReviewCopy = {
  title: "Commit changes",
  openCommitList: "Open commit list",
  close: "Close",
  refreshAccessible: "Refresh local Git observation",
  loading: "Loading commit changes…",
  retry: "Retry",
  loadMore: "Load earlier commits",
  backToChat: "Back to Chat",
  commitCount: (count) => `${count} ${count === 1 ? "commit" : "commits"}`,
  observerErrorTitle: "Local Git changes are unavailable",
  observerErrorDescription:
    "Saved changes remain readable. Refreshing never fetches or changes Git state.",
  listErrorTitle: "Commit changes could not be loaded",
  listErrorDescription:
    "The repository was not changed. Try the local refresh again.",
  noCommitsTitle: "No observed commits yet",
  noCommitsDescription:
    "Commits made by the main session appear after the workspace is observed.",
  noSelectionTitle: "No commit selected",
  noSelectionDescription: "Choose a commit to review its changed files.",
  filesChanged: (count) => `${count} ${count === 1 ? "file" : "files"} changed`,
  copySha: "Copy commit SHA",
  copyPath: "Copy file path",
  copied: "Copied",
  explain: "Explain changes",
  explainPreparing: "Preparing explanation…",
  explainCanceling: "Canceling explanation…",
  explainUnavailable:
    "Explanation is unavailable. The commit diff is unchanged.",
  showExplanation: "Show explanation",
  retryExplanation: "Retry explanation",
  cancelExplanation: "Cancel explanation",
  fileList: "Changed files",
  filterFiles: "Filter changed files",
  noMatchingFiles: "No changed files match this filter.",
  chooseFile: "Choose a changed file.",
  selectFile: "Select changed file",
  previousFile: "Previous changed file",
  nextFile: "Next changed file",
  fileStats: (additions, deletions) =>
    `${additions} ${additions === 1 ? "addition" : "additions"}, ${deletions} ${deletions === 1 ? "deletion" : "deletions"}`,
  collapseFile: "Collapse file diff",
  expandFile: "Expand file diff",
  diffLoading: "Loading file diff…",
  diffLabel: (relativePath) => `${relativePath} diff`,
  diffError: "This file diff could not be loaded.",
  diffEmpty: "No text changes to display.",
  diffRenderLimit: "This diff is too large to render safely.",
  noNewline: "No newline at end of file",
  oldLine: (line) => `old line ${line}`,
  newLine: (line) => `new line ${line}`,
  diffMetadataSeparator: ", ",
  diffKinds: {
    hunk: "Diff hunk",
    context: "Context line",
    addition: "Added line",
    deletion: "Deleted line",
    no_newline: "File newline note",
  },
  diffStates: {
    binary: "Binary file — preview unavailable.",
    oversize: "Diff is too large to display safely.",
    invalid_utf8: "Text preview is unavailable for this encoding.",
  },
}

const ja: GitReviewCopy = {
  ...en,
  title: "コミットの変更",
  openCommitList: "コミット一覧を開く",
  close: "閉じる",
  refreshAccessible: "ローカル Git の観測を更新",
  loading: "コミットの変更を読み込んでいます…",
  retry: "再試行",
  loadMore: "以前のコミットを読み込む",
  backToChat: "Chat に戻る",
  commitCount: (count) => `${count}件のコミット`,
  observerErrorTitle: "ローカル Git の変更を取得できません",
  observerErrorDescription:
    "保存済みの変更は引き続き読めます。更新で fetch や Git 状態の変更は行いません。",
  listErrorTitle: "コミットの変更を読み込めませんでした",
  listErrorDescription:
    "リポジトリは変更されていません。ローカルの更新を再試行してください。",
  noCommitsTitle: "観測済みのコミットはまだありません",
  noCommitsDescription:
    "main session が作成したコミットはworkspaceの観測後に表示されます。",
  noSelectionTitle: "コミットが選択されていません",
  noSelectionDescription: "変更ファイルを確認するコミットを選択してください。",
  filesChanged: (count) => `${count}ファイルを変更`,
  copySha: "コミット SHA をコピー",
  copyPath: "ファイルパスをコピー",
  copied: "コピーしました",
  explain: "詳しく教えて",
  explainPreparing: "説明を準備中…",
  explainCanceling: "説明をキャンセル中…",
  explainUnavailable:
    "説明機能を利用できません。コミット差分は変更されません。",
  showExplanation: "説明を表示",
  retryExplanation: "説明を再試行",
  cancelExplanation: "説明をキャンセル",
  fileList: "変更ファイル",
  filterFiles: "変更ファイルを絞り込む",
  noMatchingFiles: "一致する変更ファイルはありません。",
  chooseFile: "変更ファイルを選択してください。",
  selectFile: "変更ファイルを選択",
  previousFile: "前の変更ファイル",
  nextFile: "次の変更ファイル",
  fileStats: (additions, deletions) => `追加${additions}行、削除${deletions}行`,
  collapseFile: "ファイル差分を折りたたむ",
  expandFile: "ファイル差分を展開する",
  diffLoading: "ファイル差分を読み込んでいます…",
  diffLabel: (relativePath) => `${relativePath} の差分`,
  diffError: "このファイルの差分を読み込めませんでした。",
  diffEmpty: "表示できるテキスト変更はありません。",
  diffRenderLimit: "差分が大きすぎるため安全に描画できません。",
  noNewline: "ファイル末尾に改行がありません",
  oldLine: (line) => `変更前${line}行目`,
  newLine: (line) => `変更後${line}行目`,
  diffMetadataSeparator: "、",
  diffKinds: {
    hunk: "差分ハンク",
    context: "前後の行",
    addition: "追加された行",
    deletion: "削除された行",
    no_newline: "ファイル末尾の注記",
  },
  diffStates: {
    binary: "バイナリファイルのためプレビューできません。",
    oversize: "差分が大きすぎるため安全に表示できません。",
    invalid_utf8: "この文字コードはテキスト表示できません。",
  },
}

export const gitReviewCopy: Readonly<Record<SupportedLocale, GitReviewCopy>> = {
  en,
  ja,
}
