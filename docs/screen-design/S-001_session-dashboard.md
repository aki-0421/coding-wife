---
title: "S-001 セッションダッシュボード"
description: "GitHub originを持つローカルrepositoryから分離sessionを作成・復元し、状態を確認してコーディング画面へ進む画面仕様。"
updated: 2026-07-17
read_when:
  - "repository選択、session作成、復元、archive、並行稼働warningの画面挙動を実装するとき。"
  - "S-001の状態、入力検証、S-002への遷移、関連要件IDを検証するとき。"
screen_id: "S-001"
status: "Approved"
approved_by: "プロダクトオーナー（PO）"
approval_date: 2026-07-17
---
# S-001 セッションダッシュボード

| 項目 | 内容 |
|---|---|
| window label | `main` |
| React route / view key | `/sessions` |
| 対象OS | macOS 13+ Apple Silicon、Windows 11 x64、Ubuntu 24.04 x64 |
| デザイン | 未作成。本文の領域、状態、文言を実装正本とする |
| 共通仕様 | [デスクトップ共通仕様](desktop-common-specification.md) |
| 廃止理由 | 非該当 |
| 後継画面ID | 非該当 |

## 目的

ユーザーが検証済みのローカルGit repositoryから安全にsessionを作成または復元し、branch・専用worktree・実行状態を確認して[S-002 コーディングワークスペース](S-002_coding-workspace.md)へ進めるようにする。

## 対象範囲

### 含める

| 対象 | 内容 |
|---|---|
| 初回起動 | locale、Full accessのriskと非rollbackを確認し、同意後だけsession導線を有効にする。 |
| repository entry | OS directory picker、Git root、clean状態、GitHub `origin`、fetch、default branchを診断する。 |
| session作成 | 自動生成branchとapplication data内の専用worktreeを作成し、利用可能になるまで進捗を表示する。 |
| session一覧 | active・stopped・repair required・archivedを一覧化し、状態、branch、最終活動、通知badgeを表示する。 |
| lifecycle | sessionの明示再開、archive、unarchive、clean archived worktreeのcleanupを提供する。 |
| 並行稼働 | 3 sessionの同時稼働を通常導線で扱い、4件目以降はresource warning後も件数だけで拒否しない。 |

### 含めない

| 非対象 | 理由 | 扱う画面・文書 |
|---|---|---|
| prompt、AskUserQuestion回答、main/support詳細 | session内の作業へ責務を分けるため | [S-002 コーディングワークスペース](S-002_coding-workspace.md) |
| diff、test、review、履歴の詳細 | 一覧の情報密度を抑えるため | [S-003 セッション証跡](S-003_session-evidence.md) |
| 設定、component診断、credential | session選択と分離するため | [S-004 設定・診断](S-004_settings-diagnostics.md) |
| clone、GitHub以外のremote、branch・base・worktree path入力 | ハッカソン版のGit境界を固定するため | [workspace-sessions要件](../requirements/workspace-sessions/requirements.md) |
| commit、push、PR、merge、reset、stash、checkoutの直接UI | Git outcomeをユーザーとSolのturnへ委ねるため | [git-review-harness要件](../requirements/git-review-harness/requirements.md) |

## 表示契機と終了

| 項目 | 内容 |
|---|---|
| 表示契機 | 初回・通常起動、主navigationの`セッション / Sessions`、不正route/sessionからのfallback、S-002/S-003の戻る操作。 |
| 表示前提 | `main`が存在する。SQLite初期化に失敗した場合も復旧案内を表示できる。Full access未同意ではsidecarを起動しない。 |
| 初期フォーカス | page heading。初回同意が必要なら同意説明、sessionが0件なら`リポジトリを選択`、通常時は前回選択sessionへ次に移動できる順序とする。 |
| 正常完了 | 作成・再検証済みsessionをactive workspaceにし、`/workspace/:sessionId`へ遷移する。 |
| キャンセル | picker、resource warning、archive、cleanupの起点へfocusを戻し、Git、filesystem、SQLiteを操作前の状態に保つ。 |
| 閉じる操作 | [共通仕様の閉じる操作](desktop-common-specification.md#閉じる操作)どおり`main`を非表示にし、処理を継続する。 |
| 再表示 | 同じroute、選択session、一覧区分、非秘密の処理状態を復元する。完了した処理は結果へ更新し、操作を二重実行しない。 |

## 利用者と権限

| 利用者・ロール | 表示 | 操作 | 拒否時の動作 |
|---|---|---|---|
| ユーザー | 可 | 同意、repository選択、session作成・選択・再開・archive・unarchive・cleanup、warning回答 | 対象項目と理由を表示し、既存sessionを維持する |
| Full access未同意ユーザー | 条件付き | risk確認、同意、S-004表示、Quit | repository診断、sidecar、session作成を開始しない |
| React WebView | redacted view modelだけ可 | session IDを伴うallowlist済み要求 | 任意path、Git argument、shell、SQLを拒否する |
| Tauri / Rust | 非表示の信頼境界 | picker、Git、path、worktree、SQLite、route相関 | 検証不合格時は変更前状態とerror codeを返す |

## 画面構成

| 領域 | 表示内容 | 主な操作 |
|---|---|---|
| page header | `セッション / Sessions`、同時稼働数、offline/error概要、S-004へのlink | 設定・診断へ移動 |
| first-run panel | 日英のFull access risk、固定model・sandbox・approval、緊急停止、変更をrollbackしない説明 | 説明を最後まで読む、同意、同意しない |
| repository card | repository表示名、sanitized GitHub `origin`、default branch、診断status。絶対pathは通常表示しない | repository選択、再診断、fetch再試行 |
| primary action | `新しいセッション / New session`と処理progress | repository選択またはsession作成、cancel |
| session summary | active、回答待ち、停止中、repair required、archivedの件数 | 一覧区分を切替 |
| session list | session名、lifecycle text、local branch、dirty件数、最終活動、質問・完了・失敗badge | 選択、開く、再開、archive、unarchive、cleanup |
| status region | picker、fetch、branch/worktree、復元、archiveの結果と短いerror code | 再試行またはS-004へ移動 |
| modal layer | resource warning、archive、cleanupの確認。単純確認なので別画面IDを付けない | 続行、キャンセル、確認 |

session rowの主要actionは状態ごとに1つだけ表示する。`available`は`開く`、中断・停止は`再開`、`repair_required`は`再診断`、`archived`は`アーカイブ解除`とする。補助actionはoverflow menuへ置き、Git変更を暗黙実行しない。

### badge契約

| Badge | 条件 | 表示 | 選択結果 |
|---|---|---|---|
| 回答が必要 / Needs answer | mainが`waiting_for_user` | question iconと未解決件数 | S-002の回答overlayへ移動 |
| 完了 / Completed | 未確認のmain terminal success | check iconと`完了` | S-002のtimeline末尾へ移動し、badgeを確認済みにする |
| 失敗 / Failed | 未確認のmain failureまたは回復不能failure | warning icon、`失敗`、短い分類 | session failureはS-002末尾、component failureはS-004へ移動 |

badgeはOS通知の代替となるアプリ内状態であり、support完了、Git/test、audioだけでは作らない。色だけで状態を表現しない。

## 表示状態

| 状態 | 進入条件 | 表示 | 操作可否 | 状態から抜ける条件 |
|---|---|---|---|---|
| 初回同意 | Full access同意versionが未保存 | risk全文、固定権限、緊急停止、`有効にする / Enable Full access`、`同意しない / Not now` | 同意、S-004、Quitだけ可 | 同意保存、またはアプリ終了 |
| 初期化中 | SQLite rehydrateとGit実体照合中 | page skeleton、`セッションを復元中… / Restoring sessions…` | S-004とQuit以外不可 | 成功、復旧可能error、回復不能error |
| 通常 | 1件以上の表示可能sessionがある | repository card、件数summary、session list | 状態に応じたrow action可 | 操作開始、offline、error |
| データなし | workspaceまたはsessionが0件 | 空state、選択条件、`リポジトリを選択 / Choose repository` | pickerとS-004可 | repository選択または復元 |
| 処理中 | 診断、fetch、branch/worktree作成、repair、cleanup中 | 現在step、spinner、cancel可能性、対象repository/session | 読取navigation可。対象変更actionは不可 | terminal result。cancelは外部process終了後に整合化 |
| resource warning | 操作後の同時稼働数が4以上 | 現在数、CPU/memory/model負荷、`続行 / Continue`、`キャンセル / Cancel` | modal内2操作だけ可 | 回答後に起点へfocusを戻す |
| オフライン | network利用不可 | offline banner、保存済み一覧、`接続後に再試行` | 保存済み情報、archive、S-004は可。fetch・新規作成・main開始は不可 | 接続回復後のユーザー再試行 |
| Git入力不正 | dirty、detached、履歴操作中、layout非対応、GitHub `origin`不正、default head不明 | 条件名、件数またはsanitized値、`WORK_*` code、解消方法 | 再選択・再診断・S-004可。branch/worktree作成不可 | 外部解消後の明示再診断 |
| conflict / repair required | branch/path衝突の再生成失敗、作成途中artifact、linkage破損、branch不一致 | 対象session、期待値と現在値の非秘密表示、保持したfile、再診断・repair・archive | 自動checkout・削除不可。安全条件を満たす操作だけ可 | 再検証合格またはarchive |
| エラー | fetch、Git process、SQLite write、route componentの継続可能失敗 | 影響範囲、短いerror code、保持data、再試行 | 影響外sessionは利用可 | 手動再試行成功またはS-004で復旧 |
| 権限不足 | directory read/write、Git credential、組織policyが不足 | 拒否機能とOS/Git/Codex側の確認手順 | 再診断、再選択、S-004、Quit可 | 権限変更後の明示再試行 |

## 操作

| 操作 | 事前条件 | 正常結果 | キャンセル時 | 失敗時 | 関連要件ID |
|---|---|---|---|---|---|
| Full accessへ同意 | risk全文を表示済み | version・日時・app versionを保存しrepository導線を有効化 | sidecarを起動せずS-004とQuitを残す | 保存せず再試行を表示 | APP-F-024、CODE-F-021 |
| repositoryを選択 | 同意済み、処理中でない | native pickerの1 directoryをRust診断へ渡す | errorなし、状態不変 | WORK error codeと再選択を表示 | WORK-F-001〜WORK-F-004 |
| repositoryを診断 | directory選択済み | clean、GitHub `origin`、fetch、default headを順に合格表示 | fetch前またはprocess終了後に状態不変 | branch/worktreeを作らず原因を表示 | WORK-F-005〜WORK-F-013 |
| sessionを作成 | 診断合格、Solと固定policyが利用可 | 自動branch・専用worktree・main root threadを保存しS-002へ移動 | app-owned artifactだけを安全条件で回収 | `repair_required`を含む結果を保持 | WORK-F-014〜WORK-F-022、CODE-F-012〜CODE-F-015 |
| 4件目以降を開始 | 開始後の同時稼働数が4以上 | warning確認後に件数だけで拒否せず開始 | session/turn状態不変 | resource不足の実errorを表示 | WORK-F-025〜WORK-F-026、APP-F-035〜APP-F-036 |
| sessionを開く・再開 | 保存IDとGit実体が一致 | active workspaceにして同じthread・branch・worktreeでS-002へ移動 | 選択状態を維持 | 暗黙の新規threadを作らず診断へ案内 | WORK-F-027〜WORK-F-034、CODE-F-047、APP-F-004 |
| badgeを開く | 未確認badgeがある | questionは回答overlay、完了・失敗は対象末尾、component failureはS-004へ移動 | 非該当 | session消失時はS-001に留まり理由を表示 | APP-F-003〜APP-F-004、APP-F-022、CODE-F-043 |
| archive | runningとwaiting turnが0件 | active一覧から外しbranch・worktree・dirty file・evidenceを保持 | 状態不変 | 対象turnと拒否理由を表示 | WORK-F-036〜WORK-F-037 |
| unarchive | archivedでGit実体を再検証可能 | 合格なら`available`へ戻す | archivedを維持 | `repair_required`と原因を表示 | WORK-F-038 |
| cleanup | archived、clean、正常、unlocked | worktreeだけをforceなしで削除しbranch・evidenceを保持 | Git/filesystem/SQLiteを変更しない | 不合格条件を列挙し削除しない | WORK-F-039〜WORK-F-041 |

## 入力項目

| 項目 | 初期値 | 必須 | 制約・境界 | エラー表示 | 保存契機 |
|---|---|---|---|---|---|
| Full access同意 | 未同意 | 初回session前に必須 | current文面versionを最後まで表示し、明示buttonだけで同意 | 同意未完了を表示しsession actionを無効化 | 同意button成功時 |
| repository directory | 未選択 | 新規workspaceで必須 | OS pickerで1 directory。bare、dirty、detached、履歴操作中、submodule、sparse、非GitHub `origin`を拒否 | 対象条件と`WORK_*` codeを項目直下へ表示 | 全診断合格時 |
| resource warning回答 | 未選択 | 同時稼働4件以上で必須 | `続行`または`キャンセル` | 未選択では開始しない | 操作eventだけ保存 |
| archive確認 | 未選択 | 条件付き | session名、running/waiting有無、保持対象を照合 | 不合格turnを表示 | 確認成功時 |
| cleanup確認 | 未選択 | 条件付き | 削除worktreeと保持branch/evidenceを表示 | 安全条件の不合格を列挙 | 確認・cleanup成功時 |

session名、branch名、base branch、worktree path、Git credentialの自由入力は提供しない。

## ネイティブ連携

実際のCapability設定は`src-tauri/capabilities/`を正本とする。

| ユーザー操作 | 実行境界 | Tauri plugin / Command | 必要なCapability・認可 | キャンセル時 | 拒否・失敗時 |
|---|---|---|---|---|---|
| repository選択 | Tauri dialog + Rust | directory open / command名未定 | `main`のdialog permission、Rustでcanonical再検証 | selectionを破棄 | pathを保存せず再選択を表示 |
| Git診断・fetch | Rust child process | 固定Git command群 | session/workspace所有、allowlist引数、repository FIFO | process終了後に結果を整合 | secret・absolute pathなしの分類を返す |
| branch・worktree作成 | Rust filesystem/Git | command名未定 | app data containment、衝突検査、Full access同意 | app-owned artifactだけ安全回収 | unsafe artifactを保持しrepair requiredへ移す |
| session復元・保存 | Rust + SQLite | command名未定 | typed ID、single writer、transaction | 読取状態を維持 | partial成功を表示しない |
| route遷移 | React router + Rust照合 | route command | session IDとworkspace所有を再検証 | S-001に留まる | childを起動せず理由を表示 |

## ウィンドウ固有動作

[デスクトップ共通仕様](desktop-common-specification.md)との差分は次のとおり。

| 項目 | 動作 |
|---|---|
| 生成・再利用 | 既存`main`の`/sessions` routeを再利用し、picker以外の追加windowを作らない。 |
| 初期サイズ・最小サイズ | 共通保存値を使用する。800×600ではsession rowを縦積みにして主要actionを欠落させない。 |
| リサイズ | 可。1,024 CSS px未満でsummaryとrepository cardを1 columnにする。 |
| 最大化・全画面 | 共通仕様どおり可。 |
| 常に手前へ表示 | 不可。 |
| 閉じる操作 | `main`を非表示にし、Git process、session、TTSを共通仕様どおり継続する。 |
| 未保存変更がある場合 | picker・確認modalはキャンセル扱い。進行中外部processは継続し、再表示時に同じoperation IDへ再接続する。 |

## メニュー・ショートカット

| 操作 | macOS | Windows / Linux | 有効条件 | 実行結果 |
|---|---|---|---|---|
| focus移動 | `Tab` / `Shift+Tab` | 同左 | 常時 | visual順に移動 |
| row内移動 | 矢印キー | 同左 | session list focus時 | row選択だけを変更 |
| primary action | `Enter` / `Space` | 同左 | enabled control | 表示中actionを1回実行 |
| modalを閉じる | `Escape` | 同左 | cancel可能modal | 状態不変で起点へfocusを戻す |
| 明示Quit | `Command+Q` | `Ctrl+Q` | 共通仕様の条件 | 共通Quitを開始 |

新規session、archive、cleanup専用のglobal shortcutは登録しない。

## データ保持

| データ | 正本・保存先 | 保存契機 | 復元契機 | 破棄条件 | 失敗時 |
|---|---|---|---|---|---|
| workspace/session mapping | local SQLite | 診断・作成transaction成功時 | 起動、再表示 | 明示履歴削除 | 最後の成功transactionを表示 |
| branch・HEAD・dirty・worktree | Git/filesystem | Git操作完了時に参照を保存 | 起動・再開前の再診断 | cleanupはworktreeだけ。branchは保持 | 推測修復せずrepair required |
| main thread ID | local SQLite | thread/start成功時 | session再開 | 明示履歴削除 | 暗黙の新規threadへ置換しない |
| Full access同意 | local SQLite | 明示同意時 | 起動・session開始前 | 文面version変更で再同意 | sessionを開始しない |
| 一覧選択・区分 | local SQLiteのshell state | selection変更時 | 再表示・再起動 | 対象消失 | 先頭またはemptyへfallback |
| raw credential・Git output | 保存しない | 非該当 | 非該当 | process終了時に破棄 | redacted errorだけ保存 |

## OS差分

| 項目 | macOS | Windows | Linux |
|---|---|---|---|
| directory picker | macOS native dialog | Windows native dialog | desktop portal/native dialog。利用不能時は権限不足 |
| path表示 | POSIX separator、case-sensitive照合 | native表示、case-insensitive差分をRustで照合 | POSIX separator、filesystemのcase規則を保持 |
| Git認証 | credential helper / SSH agent | credential helper / SSH agent | credential helper / SSH agent |
| 検証水準 | Apple Silicon実機で3 sessionと30回切替をE2E | CI build/test済みpreview | Ubuntu 24.04 CI build/test済みpreview |

## アクセシビリティ

- `main` landmark、page heading、repository region、session list、status live regionの順を一意にする。
- session rowは名前をaccessible nameに含め、状態、dirty件数、badgeをtextでも読み上げる。table/gridを使う場合はrowとcolumn headerを関連付ける。
- 処理開始・完了・失敗、同時稼働数、offlineを`aria-live="polite"`、回復不能failureを`assertive`で1回だけ通知する。
- modalはfocus trapを持ち、初期focusを安全な`キャンセル`へ置き、終了後は起点buttonへ戻す。
- 200% text zoom、forced colors、800×600で横scrollなしにprimary actionへ到達できる。状態を色だけで表さない。
- reduced motionではskeleton shimmerと装飾transitionを止め、進捗textとspinnerのaccessible labelは維持する。

## 表示文言例

| 用途 | 日本語 | English |
|---|---|---|
| empty | `GitHub originのあるローカルリポジトリを選択してください。` | `Choose a local repository with a GitHub origin.` |
| dirty | `変更が残っているため作成できません。元のチェックアウトをcleanにして再診断してください。` | `This checkout has changes. Make it clean, then run diagnostics again.` |
| resource warning | `4件目の同時セッションです。CPU、メモリ、モデル利用が増える可能性があります。` | `This will be the fourth concurrent session. CPU, memory, and model usage may increase.` |
| offline | `オフラインです。保存済みセッションは確認できますが、新規作成はできません。` | `You are offline. Saved sessions remain available, but a new session cannot be created.` |
| badge | `回答が必要` / `完了` / `失敗` | `Needs answer` / `Completed` / `Failed` |

## 分析・telemetry

product analytics、tracking SDK、remote telemetry、A/B test eventは送信しない。repository診断、session lifecycle、error codeのlocal構造化eventは機能証跡であり、利用分析へ転用しない。

## 画面受け入れ条件

1. cleanなGitHub repositoryを選択すると、fetch後default headから自動branchと専用worktreeが作られ、元checkoutが変わらずS-002へ遷移する。
2. dirty、detached、履歴操作中、不正`origin`、default head不明ではbranch/worktreeが0件のまま修正条件を表示する。
3. 3 sessionを同時稼働でき、30回切替でsession・thread・worktree・badgeが混在しない。4件目以降はwarning後に続行でき、cancelでは状態が変わらない。
4. 再起動後に一覧と選択を復元し、中断turnを自動実行せず、同じthread・branch・worktreeの明示再開だけを許可する。
5. archive、unarchive、cleanupのcancelと失敗でdirty file、branch、evidenceを失わない。
6. 日英、keyboard only、screen reader、forced colors、reduced motion、200% zoomで主要導線を完了できる。

## 関連要件

| 要件ID | この画面での扱い | 要件定義書 |
|---|---|---|
| WORK-F-001〜WORK-F-013 | repository選択、GitHub origin、fetch、default branchの検証 | [workspace-sessions要件](../requirements/workspace-sessions/requirements.md) |
| WORK-F-014〜WORK-F-026 | branch・専用worktree作成、競合回収、並行稼働warning | [workspace-sessions要件](../requirements/workspace-sessions/requirements.md) |
| WORK-F-027〜WORK-F-034 | 一覧復元、再開、Git外部変更・repair状態の参照 | [workspace-sessions要件](../requirements/workspace-sessions/requirements.md) |
| WORK-F-036〜WORK-F-041 | archive、unarchive、cleanup | [workspace-sessions要件](../requirements/workspace-sessions/requirements.md) |
| CODE-F-006、CODE-F-012〜CODE-F-015、CODE-F-021、CODE-F-047 | login/model gate、main thread、Full access同意、resume失敗 | [codex-main-session要件](../requirements/codex-main-session/requirements.md) |
| HIST-F-003、HIST-F-019〜HIST-F-020、HIST-F-027 | badge元event、rehydrate、workspace/session一覧 | [activity-history要件](../requirements/activity-history/requirements.md) |
| APP-F-003〜APP-F-004、APP-F-024〜APP-F-026 | route、初回、offline、error | [desktop-shell要件](../requirements/desktop-shell/requirements.md) |
| APP-F-022〜APP-F-023、APP-F-035〜APP-F-036 | 通知3分類のbadge導線、3並行、4件目warning | [desktop-shell要件](../requirements/desktop-shell/requirements.md) |
| APP-F-044〜APP-F-046 | 日英、keyboard、screen reader、表示設定 | [desktop-shell要件](../requirements/desktop-shell/requirements.md) |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| visual design token | 共通theme tokenとnative controlを使い、本文の情報階層を変えない | UI実装時にcontrastと800×600を確認する | いいえ |
| session表示名 | repository名と作成日時から決定論的に生成し、編集UIは設けない | 実装時に重複時suffixだけを確定する | いいえ |

## レビュー確認

- [x] front matterの`screen_id`、タイトル、ファイル名の画面IDが一致している。
- [x] `status`が`Approved`である。
- [x] 目的と対象外が一意である。
- [x] 初期化、通常、空、処理中、オフライン、エラー、権限不足を定義した。
- [x] キャンセル、閉じる、再表示、未保存データの動作を定義した。
- [x] ネイティブ操作のCapability・認可と失敗時動作を定義した。
- [x] OS差分を確認し、未確認を共通扱いしていない。
- [x] 関連要件IDを要件定義書へ照合した。
- [x] 着手をブロックする未確定事項がない。
- [x] `agent-docs lint`が成功した。
