---
title: "WORK ワークスペース・セッション要件定義"
description: "ローカルGitプロジェクトの追加、preflight、状態別一覧、選択、復元を定義する。"
updated: 2026-07-18
read_when:
  - "workspace sidebar、project picker、session lifecycleを実装するとき。"
  - "active workspace切替とdraft・audio分離を検証するとき。"
---

# ワークスペース・セッション 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `WORK` |
| 状態 | Draft |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-18 |
| 最終レビュー日 | 未レビュー |

## 背景

長時間のCodex作業を監督するには、作業対象、branch、ライフサイクル、介入要否を混同せず選べる入口が必要である。既存リポジトリや既存変更を壊さず、再起動後も現在地へ戻れるworkspace管理を提供する。

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| projectを安全に追加する | OS pickerで有効なローカルGit repositoryを追加し、cancel・権限不足・無効folderを破壊的変更なしで処理できる |
| 状態を一目で選ぶ | sidebarでlifecycle、repo、branch、attentionを確認し、active workspaceを切り替えられる |
| 再開可能にする | app再起動後に一覧、active selection、draft、scroll位置、session summaryが戻る |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| Project registration | local Git repository選択、canonicalization、診断 |
| Workspace list | filter、state grouping、repo/branch、active selection、empty state |
| Lifecycle | Backlog、In progress、In review、Done、Canceledと別軸attention |
| Session continuity | active workspace、draft、scroll、summaryのlocal persistence |
| Preflight | Git、Codex、auth、Sol、characterの送信前診断 |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| 初回からの並列実行 | MVPでは一つのactive executionへ集中する | 将来のmulti-workspace execution |
| 自動worktree作成 | 既存変更とbranch所有権の安全性を優先する | 将来のworkspace isolation |
| GitHub origin必須 | local repositoryを第一級で扱う | 非対象 |
| repository clone/fetch UI | network credentialと競合解決を今回含めない | 外部Git client |
| repository file削除 | appからproject登録を外してもsourceを変更しない | 非対象 |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ローカル利用者 | project所有者 | folder選択、workspace作成・選択・filter・cancel・登録解除 | filesystem権限不足または無効repoなら登録せず理由を表示する |
| Rust core | pathとGit状態の信頼境界 | canonical path検証、read-only Git診断、metadata保存 | root外参照、消失path、I/O失敗を構造化errorにする |
| Codex main session | active workspaceで作業するprocess | 選択済みcwdで一つのthreadを開始 | inactive workspaceやpreflight失敗workspaceでは開始しない |

## 機能要件

### Project追加とpreflight

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `WORK-F-044` | 利用者はfolder pickerからlocal projectを追加できる | regular directory内のGit worktreeを選ぶとcanonical path、repo名、branchを表示し、workspace一覧へ1件追加する | Draft | 非該当 |
| `WORK-F-045` | 利用者はfolder選択をcancelできる | pickerをcancelすると既存一覧とactive selectionを維持し、errorを表示しない | Draft | 非該当 |
| `WORK-F-046` | アプリは無効repositoryを拒否する | non-Git directory、bare repository、存在しないpathを選ぶと登録せず、原因と再選択を表示する | Draft | 非該当 |
| `WORK-F-047` | アプリは読取権限不足を拒否する | repositoryまたは`.git` metadataを読めない場合は登録せず、権限不足をI/O errorと区別して表示する | Draft | 非該当 |
| `WORK-F-048` | 利用者は送信前preflightを確認できる | Git、Codex executable、auth、`gpt-5.6-sol`、character packを`ready/warning/blocked`で表示し、blocked項目があればSendを無効にする | Draft | 非該当 |
| `WORK-F-049` | 同じrepositoryの重複登録を防ぐ | symlink表記や`..`を含む同一canonical pathを再選択すると新規作成せず、既存workspaceを選択する | Draft | 非該当 |

### Workspace作成・一覧・切替

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `WORK-F-050` | 利用者は登録projectにworkspaceを作成できる | nameとgoalを確定するとBacklog groupへworkspaceが作成され、同じprojectに複数workspace metadataを持てる | Draft | 非該当 |
| `WORK-F-051` | 利用者はworkspace一覧をfilterできる | repo、branch、workspace nameのcase-insensitive部分一致で200件を絞り込み、0件時はfilter解除操作を表示する | Draft | 非該当 |
| `WORK-F-052` | 利用者はlifecycle groupからworkspaceを選択できる | Done/In review/In progress/Backlog/Canceledごとに表示し、item選択でheader、Chat、Commit、Context、Companionが同一workspaceへ100ms以内に切り替わる | Draft | 非該当 |
| `WORK-F-053` | アプリはlifecycleとattentionを別に表示する | lifecycleを変えずにNeeds answer、Approval required、Test failed、High riskをbadgeとaccessible labelで併記できる | Draft | 非該当 |
| `WORK-F-054` | アプリは現在のrepoとbranchを表示する | selected itemとheaderに実Gitのrepo名とbranchまたはdetached HEAD短縮SHAを表示し、長い値はellipsisと全文tooltipを持つ | Draft | 非該当 |
| `WORK-F-055` | 利用者は空一覧から最初のprojectを追加できる | workspaceが0件の時、説明、FolderPlus、keyboard shortcutを表示し、decorative card gridを表示しない | Draft | 非該当 |
| `WORK-F-056` | 利用者はworkspaceをCanceledへ移せる | cancel確認後にactive turnを停止し、source fileとGit branchを削除せず、workspaceをCanceled groupへ移す | Draft | 非該当 |
| `WORK-F-057` | 利用者はproject登録を外せる | 対象に実行中turnがなく確認を完了するとapp metadataだけを削除し、repository内のfileとGit refを変更しない | Draft | 非該当 |

### 継続性と境界

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `WORK-F-058` | アプリは一度に一つのactive executionだけを許可する | 別workspaceでSendした時に既存turnが実行中なら「既存を停止して切替」「戻る」を表示し、同時に二つのCodex turnを開始しない | Draft | 非該当 |
| `WORK-F-059` | workspace切替はview stateとaudioを分離する | 切替時に旧workspaceの音声を停止し、新workspace固有のdraftとscroll位置を復元し、旧音声を新workspaceで再生しない | Draft | 非該当 |
| `WORK-F-060` | アプリはworkspace stateを再起動後に復元する | 20件のworkspace、group、active selection、draft、last summaryがapp再起動後に一致する | Draft | 非該当 |
| `WORK-F-061` | アプリは外部branch変更を検出する | active repositoryのHEADが外部で変わった場合、次のSendまたはwindow focus後1秒以内にstale warningを表示し、再preflightまでturnを開始しない | Draft | 非該当 |
| `WORK-F-062` | 消失repositoryは復旧可能なerrorになる | 登録後にfolderが移動・削除された場合、workspace履歴を残してMissing表示にし、再選択または登録解除を提示する | Draft | 非該当 |
| `WORK-F-063` | 利用者はproject contextとcharacter contextを分離して編集できる | Context tabで二つのsectionを別々に保存し、character contextからtechnical rule、permission、checkpoint policyを変更できない | Draft | 非該当 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| Project | repository folder | なし | 必須 | canonical regular directory、Git worktree、同一path重複不可 | 入力を登録せず、再選択とcancelを残す |
| Workspace | name | repo名 + timestamp | 必須 | trim後1〜80 Unicode scalar、改行不可 | 入力保持、該当fieldへerror |
| Workspace | goal | 空 | 任意 | 0〜4,000 Unicode scalar | 入力保持、超過数を表示 |
| Filter | query | 空 | 任意 | 0〜200 Unicode scalar | 200超を受け付けず一覧を維持 |
| Context | project context | 空 | 任意 | UTF-8で最大64KiB | 保存せず入力保持 |
| Context | character context | 空 | 任意 | UTF-8で最大16KiB、technical policy key禁止 | 禁止内容を除いて再編集を求める |

## デスクトップ固有要件

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | macOS 14以降のfolder pickerとpath normalization | `WORK-F-044`〜`WORK-F-047` |
| ウィンドウ生成・再利用 | single main window内のsidebarとtabを再利用 | `WORK-F-052` |
| 閉じる・アプリ終了 | active executionの停止判断はAPP要件に従う | `WORK-F-058`, `WORK-F-060` |
| 未保存データ | draftとContext入力をworkspace単位で保持 | `WORK-F-059`, `WORK-F-063` |
| ローカルデータ | canonical pathはRust管理DBへ保存し、UI storageを正本にしない | `WORK-F-060` |
| オフライン | project一覧、filter、Contextは利用可能 | `WORK-F-051`, `WORK-F-063` |
| ファイル・OS操作 | picker cancel、権限不足、移動・削除を区別 | `WORK-F-045`, `WORK-F-047`, `WORK-F-062` |
| メニュー・ショートカット | FolderPlusとPlusへ24×24px hit areaとaccessible nameを与える | `WORK-F-044`, `WORK-F-050` |
| Deep Link・ファイル関連付け | 非該当: MVPで登録しない | 非該当 |
| 通知 | attentionはapp内sidebarとheaderに表示 | `WORK-F-053` |
| Capability・認可 | pickerで選択したrootの診断だけをRustに許可 | `WORK-F-044`〜`WORK-F-049` |
| アップデート・互換性 | workspace schema migration失敗時は旧DBを維持 | `WORK-F-060` |

## 画面・UI

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-001` | セッションダッシュボード | `WORK-F-044`〜`WORK-F-062` | 変更 | 次工程: `docs/screen-design/S-001_session-dashboard.md` |
| `S-002` | コーディングワークスペース | `WORK-F-052`〜`WORK-F-063` | 変更 | 次工程: `docs/screen-design/S-002_coding-workspace.md` |
| `S-004` | 設定・診断 | `WORK-F-048`, `WORK-F-057`, `WORK-F-063` | 変更 | 次工程: `docs/screen-design/S-004_settings-diagnostics.md` |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | pathをcanonicalizeし、WebViewへhome directoryを含むabsolute pathを通常表示しない |
| 権限 | project rootのread診断とapp metadata writeだけを許可し、登録解除でsourceを削除しない |
| プライバシー | repository path、goal、Contextはlocal保存のみ。支援agentへ送る場合は別要件のredactionを通す |
| 監査・ログ | add、cancel、select、lifecycle、preflight resultをsecretなしで記録する |
| 性能 | 200 workspaceのfilter・group更新p95 100ms、selection更新p95 100ms |
| 信頼性・復旧 | DBまたはrepo消失時も他workspaceを開け、破損itemを明示する |
| アクセシビリティ | statusを色だけで表さず、label、icon、stroke/fillを併用する |
| 多言語・地域 | app labelはja/en、repo/branch/user contextは翻訳しない |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| Git repository | local worktreeを対象とする | 解決済み（MVP範囲） | bare/non-Gitは登録不可 |
| APP | single window、persistence、locale、close契約 | 解決済み（同時Draft） | 独立レビューで整合確認 |
| CODE | Codex/auth/model preflight | 解決済み（同時Draft） | blocked項目はSend不可 |
| LIVE | character pack preflight | 解決済み（同時Draft） | fallbackでもworkspaceは開ける |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| 並列workspace実行 | MVPはactive execution 1件、一覧と履歴は複数件 | demo後に需要を計測する | いいえ |
| worktree自動作成 | MVP非対象、既存worktreeだけを登録 | checkpoint運用後に安全性を評価する | いいえ |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [PRODUCT.md](../../PRODUCT.md) | 利用者、監督、復元の目的 |
| [DESIGN.md](../../DESIGN.md) | sidebar、status、responsive仕様 |
| [プロダクト論点](../research/01-product-thesis.md) | 対象利用者と負担 |
| [体験設計](../research/02-experience-design.md) | workspaceとcontext分離 |

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Not Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 未合意 |
| 残る非ブロック論点 | 並列実行、worktree自動作成はMVP非対象 |

## 着手可チェック

- [x] 背景と目的が説明できる。
- [x] スコープ内・外と理由が明確である。
- [x] 全機能要件に一意な要件IDがある。
- [x] 全機能要件に検証可能な受け入れ条件がある。
- [x] 正常系、異常系、キャンセル、権限差分、空状態、境界値を確認した。
- [x] デスクトップ固有要件を確認し、非該当も明記した。
- [ ] 画面IDと要件IDの相互参照が一致している。画面詳細仕様は次工程で作成する。
- [x] 非機能要件と依存関係を確認した。
- [x] 着手ブロックが「はい」または「不明」の未確定事項がない。
- [ ] 仕様責任者がレビューし、合意した。
