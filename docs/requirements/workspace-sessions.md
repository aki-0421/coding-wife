---
title: "WORK ワークスペース・セッション要件定義"
description: "ローカルfolderのGit/GitHubセットアップ、project登録と、app管理Git worktreeであるworkspaceの作成・選択・復元・Archiveを定義する。"
updated: 2026-07-20
last_verified: 2026-07-20
read_when:
  - "workspace sidebar、project picker、session lifecycleを実装するとき。"
  - "active workspace切替とdraft・audio分離を検証するとき。"
---

# ワークスペース・セッション 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `WORK` |
| 状態 | Approved |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-18 |
| 最終レビュー日 | 2026-07-19 |

## 背景

長時間のCodex作業を監督するには、作業対象、branch、ライフサイクル、介入要否を混同せず選べる入口が必要である。既存リポジトリや既存変更を壊さず、再起動後も現在地へ戻れるworkspace管理を提供する。

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| projectを安全に追加する | OS pickerで選んだfolderをGit/GitHub要件まで明示的にセットアップし、全check成功後だけprojectへ登録できる |
| 状態を一目で選ぶ | sidebarでlifecycle、repo、branch、attentionを確認し、active workspaceを切り替えられる |
| 再開可能にする | app再起動後に一覧、active selection、draft、scroll位置、session summaryが戻る |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| Project registration | local folder選択、Git初期化、GitHub originセットアップ、canonicalization、診断 |
| Workspace list | registered project filter、state grouping、repo/branch、active selection、empty state |
| Lifecycle | Backlog、In Progress、In Review、Done、Canceledと別軸attention |
| Session continuity | active workspace、draft、scroll、summaryのlocal persistence |
| Preflight | Git、Codex、auth、Sol、characterの送信前診断 |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| 初回からの並列実行 | MVPでは一つのactive executionへ集中する | 将来のmulti-workspace execution |
| project root自体をworkspaceとして自動登録 | projectとworktreeの区別を保つ | 利用者がinline formまたはsidebarのWorkspace追加からapp-owned worktreeを明示作成する |
| repository clone/fetch UI | network credentialと競合解決を今回含めない | 外部Git client |
| repository file削除 | appからproject登録を外してもsourceを変更しない | 非対象 |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ローカル利用者 | project所有者 | folder選択、workspace作成・選択・project filter・cancel・登録解除 | filesystem権限不足または無効repoなら登録せず理由を表示する |
| Rust core | pathとGit/GitHub状態の信頼境界 | canonical path検証、固定引数のGit初期化・origin設定、GitHub CLI診断、metadata保存 | root外参照、候補置換、未認証、I/O失敗を構造化errorにする |
| Codex main session | active workspaceで作業するprocess | 選択済みcwdで一つのthreadを開始 | inactive workspaceやpreflight失敗workspaceでは開始しない |

## 機能要件

### Project追加とpreflight

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `WORK-F-044` | 利用者はfolder pickerからlocal projectを追加できる | regular directoryを選ぶとnativeがGit初期化とorigin有無を診断する。Git初期化済みかつorigin設定済みならセットアップdialogを一度も描画せず、opaqueでstableなProject ID、canonical path、repository identity、repo名、branchをnative storeへ保存する。Git初期化済みでoriginだけがない場合は、認証済みGitHub current userとorganizationの同名repositoryを診断し、一意な既存repositoryが見つかればHTTPS originへ自動接続して同じ直接登録へ進む。非Git、既存repositoryなし、または同名repositoryが複数ownerで競合する場合だけ、pathをWebViewへ渡さない一時Setup IDとfolder basenameでセットアップdialogへ遷移する。project追加だけではworkspaceを作成・選択・再activateせず、既存active selectionを維持する。migration前にproject rootをworkspaceとして保存したlegacy recordは、再登録時もworkspace一覧・件数・復元対象へ含めない。Project ID、Setup IDとcanonical pathは通常UI、support payload、logへ表示しない | Approved | 非該当 |
| `WORK-F-045` | 利用者はfolder選択をcancelできる | pickerをcancelすると既存一覧とactive selectionを維持し、errorを表示しない | Approved | 非該当 |
| `WORK-F-046` | アプリは無効folderまたはrepositoryを拒否する | non-Gitのregular writable directoryはセットアップへ進める一方、bare repository、壊れた`.git`、symlink Git marker、存在しないpathを選ぶと登録せず、原因と再選択を表示する | Approved | 非該当 |
| `WORK-F-047` | アプリは読取権限不足を拒否する | repositoryまたは`.git` metadataを読めない場合は登録せず、権限不足をI/O errorと区別して表示する | Approved | 非該当 |
| `WORK-F-048` | 利用者は送信前preflightを確認できる | Git、Codex executable、auth、`gpt-5.6-sol`、character packを`ready/warning/blocked`で表示し、blocked項目があればSendを無効にする | Approved | 非該当 |
| `WORK-F-049` | 同じrepositoryの重複登録を防ぐ | symlink表記や`..`を含む同一canonical pathかつ保存済みrepository identityとexact一致するrepositoryを再選択すると新規作成せず、既存project登録を返す。登録中projectの同じpathが別identityへ置換されていればtyped changed errorで拒否し、登録解除済みprojectはidentity一致時だけ同じProject IDへ復帰する。identity不一致のrepositoryを追加する場合は新しいProject IDと履歴partitionを発行し、旧workspace/historyへ再linkしない | Approved | 非該当 |
| `WORK-F-070` | 利用者は登録前にGitとGitHub originをセットアップできる | 非Git folderでは`git init`を明示実行する。Git初期化済みでorigin未設定の場合は、folder basenameのsafe slugと認証済みGitHub current user / organizationを使って既存repositoryを先に照合する。一意な既存`owner/repository`が見つかれば、mutation直前に保存root identityとlive root、Git、originを再検査し、HTTPS originへ自動接続してdialogなしで登録する。既存repositoryがない場合または複数ownerで競合する場合だけ、owner select、literal `/`、repository name inputを`owner/repository`形式の1行に表示する。二つのcontrolにはvisible labelや通常時のhelperを置かず、accessible nameだけを付ける。確定時に`owner/name`が存在すればHTTPS originへ接続し、存在しなければprivate repositoryを作成してoriginへ接続する。Git初期化済みかつorigin設定済みの時だけproject登録へ進む。GitHub CLI未導入・未認証、owner不一致、invalid name、競合、network失敗では登録せず入力と候補を保持し、該当errorだけを操作箇所に表示する。Cancelはapp登録と未実行mutationを行わないが、利用者が既に確定した`git init`、origin自動接続、またはGitHub repository作成は巻き戻さない | Approved | 非該当 |

### Workspace作成・一覧・切替

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `WORK-F-050` | 利用者は登録projectにworkspaceを作成できる | workspaceが0件ならmain surfaceのinline formからprojectとnameを指定できる。sidebarの`+`はregistered projectが1件以上ならproject選択dialogを開き、登録projectをrepository icon画像とGitHub `owner/repo`、取得できない時はproject名を持つcard風buttonとして3columnで列挙する。tableとselectは使わず、cardを選ぶと対象Project IDと`ws-MMDD-<random 4文字>`形式の既定nameで作成を開始する。projectの現在HEADを起点にapp-owned worktree root配下へ新branchとGit worktreeを作り、workspace固有rootとper-worktree Git directoryが登録projectと同じGit common directory identityであることを照合する。作成成功後だけdialogを閉じてBacklogへ追加・選択し、そのworkspaceを開く。処理中の重複操作と失敗時のselection変更を行わず、失敗時はdialog内のproject選択を再試行できる。同じprojectに複数worktreeを持てる | Approved | 非該当 |
| `WORK-F-051` | 利用者はworkspace一覧を登録projectでfilterできる | tooltipが`フィルター / Filter`のListFilterを押すとPopoverを開き、`プロジェクト / Project` labelと横並びの非native複数選択controlへ登録済みProject IDをGitHub `owner/repo`、取得できない時はproject名とrepository iconで列挙する。未選択はすべて、1件以上は選択Project IDのいずれかと完全一致するworkspaceを200件・100ms以内で絞り込み、ListFilterのselected stateと選択件数で適用中をPopover外でも示す。一致0件でも専用empty説明やfilter解除buttonを表示しない。任意文字列input、repo/branch/workspace nameの部分一致は提供しない | Approved | 非該当 |
| `WORK-F-052` | 利用者はlifecycle groupからworkspaceを選択できる | app localeにかかわらずLinearと同じ英語のDone/In Review/In Progress/Backlog/Canceledでgroupを表示し、各statusをcheck、half-filled progress、quarter-filled progress、dotted、xの円形iconで識別できる。各groupは初期展開され、heading行全体のclick、`Enter`、`Space`で他groupとselectionを変えず独立して開閉できる。toggleは`aria-expanded`と`aria-controls`を持ち、chevronはhoverまたはfocus-visible時だけ表示する。折り畳み中だけ対象workspaceの数値件数を0件を含めて表示し、accessible nameでは展開状態にかかわらず件数を1回だけ伝える。item選択でheader、Chat、Commit、Companionが同一workspaceへ100ms以内に切り替わる | Approved | 非該当 |
| `WORK-F-053` | アプリはlifecycleとattentionを別に表示する | lifecycleを変えずにNeeds answer、Approval required、Test failed、High riskをbadgeとaccessible labelで併記できる | Approved | 非該当 |
| `WORK-F-054` | アプリは現在のrepoとbranchを表示する | sidebar itemではowner avatarを先頭へ置き、実Gitのbranchまたはdetached HEAD短縮SHAを最も目立つtitle、GitHub `origin`がある場合はcredentialを除いた`owner/repo`を小さい補助文字で表示する。headerはGitHub `origin`がある場合にownerのGitHub avatar、`owner/repo`、workspace名をこの順のbreadcrumbとして表示し、branchを隣接表示する。sidebarとheaderのavatarはreferrerを送信せずGitHubの画像originだけから取得し、offline、画像取得失敗、またはGitHub `origin`がないlocal repositoryではapp iconを使わずrepositoryを示すneutral fallbackへ縮退する。GitHub `origin`がないlocal repositoryの文字列は保存済みrepo名へfallbackする。selected itemとheaderの長い値はellipsisと全文tooltipを持つ | Approved | 非該当 |
| `WORK-F-055` | 利用者は空一覧から最初のworkspaceを作成できる | workspaceが0件のmain surfaceにはProject選択、workspace name、作成actionを持つinline formを表示する。registered projectが0件ならProject field内のFolderPlusからpickerを開き、登録成功後は同じformでProjectを選択して作成を完了できる。sidebarにはempty説明文を表示せず、Done / In Review / In Progress / Backlog / Canceledのlifecycle groupをworkspace 0件でも常に表示する | Approved | 非該当 |
| `WORK-F-056` | 利用者はworkspaceをCanceledへ移せる | idle workspaceは確認後に専用native cancel commandでCanceled groupへ移す。active/pending turnがある場合は「停止してキャンセル」と「戻る」を表示し、exact turnのterminal interrupt、workspace cleanup、履歴flushが完了した後だけ同commandを実行する。native supervisorはcancel transaction中のturn開始とactive/pending turnをatomicに拒否し、generic lifecycle commandによるCanceled指定もtyped errorで拒否する。「戻る」またはinterrupt/cleanup/flush失敗ではselection、turn、lifecycle、draft、caption/TTSを変更しない。いずれの場合もsource、working tree、Git index/object/ref、履歴本文を変更しない | Approved | 非該当 |
| `WORK-F-057` | 利用者はproject登録を外せる | App SettingsのProjects一覧で対象project名を示す確認を完了するとprojectと配下workspaceをnavigationから外す。実行中turnがある場合は操作を拒否し、履歴本文の変更・削除は`HIST-F-049`の別操作に限定する。project repository、作成済みworktree directory、Git index/object/ref、branch、共有model libraryを変更・削除しない | Approved | 非該当 |
| `WORK-F-067` | 利用者はworkspaceをArchiveしてworktreeを削除できる | sidebar rowのhoverまたはfocus-withinでArchive iconを表示する。active/pending main turnがない対象は確認dialogを表示せず、直ちにapp-owned root境界を検証した`git worktree remove --force`を実行してworkspace recordをnavigationから削除する。対象workspaceでactive/pending main turnがある時だけ、停止してArchiveする確認を表示する。利用者が確定した場合はexact workspace generationを照合し、turn interrupt、terminal state、local cleanup、履歴flushを完了してから同じArchive処理へ進む。戻る、stale generation、interrupt、cleanup、flush失敗ではArchive commandを呼ばず、workspace、worktree、selection、draft、履歴を保持する。worktree directoryまたはGit worktree registrationが既に存在しない場合も成功としてmetadataを収束させる。project repository、他worktree、branch、Git object/refを削除しない | Approved | 非該当 |
| `WORK-F-068` | 利用者は登録project一覧を管理できる | App SettingsのProjects sectionで登録中projectをworkspace件数とともに一覧し、project登録解除を開始できる。workspaceが0件でもproject一覧とApp Settingsへ到達できる | Approved | 非該当 |
| `WORK-F-069` | workspace UIの初期描画は空windowへ失敗しない | 0件を含むworkspace selectionを全viewportのsidebarでoptionalとして扱い、compact navigationも存在しないselectionを参照しない。inline create formの初期表示またはsidebarのproject cardを選んだ時にlocal timestampとrandom suffixを生成し、WebViewが`crypto.randomUUID`を提供しない場合もfallback suffixを生成して画面を維持する。application moduleの読込またはReact描画が失敗した場合はrootを空のままにせず、localeに合う回復案内と再読込操作を表示する | Approved | 非該当 |

### 継続性と境界

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `WORK-F-058` | アプリは一度に一つのactive executionだけを許可する | active/pending turnを持つworkspaceから別workspaceを選択または別workspaceでSendすると、selectionを保留して「停止して切替」と「戻る」だけを表示する。「戻る」はselection、turn、draft、timeline anchor、caption/TTSを完全に維持する。「停止して切替」はexact old turnのterminal interruptとcleanup完了後だけ新workspaceをactivateし、失敗時はold workspaceをactiveのままerrorと再試行を示す。rapid selection、duplicate response、stale terminalでも同時turnと誤workspace activationを0件にする | Approved | 非該当 |
| `WORK-F-059` | workspace切替はview stateとaudioを分離する | 成功した切替時に旧workspaceのactive presentationと音声を停止し、新workspace固有のdraftとtimeline anchor ID/sequence/offsetを復元し、anchor消失時だけ最寄りvalid sequenceへ補正する。旧workspaceのevent/error/音声を新workspaceで表示・再生しない。commit説明のworkspace切替はpresentation intentだけをrevokeし、app-owned support jobとgenerated/prepared cacheをcancel・削除しない | Approved | 非該当 |
| `WORK-F-060` | アプリはworkspace stateを再起動後に復元する | 20件のworkspaceについてProject ID、group、active selection、draft、last summary、timeline anchor ID/sequence/offsetをnative storeから再起動後に一致させる。保存anchorが削除・retention・correctionで存在しない場合だけ同workspaceの最寄りvalid sequenceへ補正し、別workspaceのsummary/anchorを再利用しない | Approved | 非該当 |
| `WORK-F-061` | アプリは外部branch変更を検出する | window focusとSend直前にrepository identity、HEAD、branch、readability、writeabilityをread-onlyで再検査する。登録時または前回確認時から変化した場合は1秒以内にstale warningと安全なrecovery actionを表示し、再preflightまでturnを開始せず、Git状態を自動で戻さない | Approved | 非該当 |
| `WORK-F-062` | 消失repositoryは復旧可能なerrorになる | 登録後にfolderが移動・削除された場合、workspace履歴、Context、draft、summary、anchorを残してMissing表示にし、repository再選択/repairまたは登録解除を提示する。他workspaceは継続利用でき、消失projectのturnを自動再送しない | Approved | 非該当 |
| `WORK-F-063` | 利用者はproject contextとapp-globalなcharacter contextを分離して編集できる | App settings > Projectsで個別projectを開くと、そのProject IDに属する全workspaceで共有するProject contextを編集できる。App settingsのCharacter contextは全project・全workspaceへ共通適用する。二つは別record、別versionとして保存し、Character contextからtechnical rule、permission、checkpoint policyを変更できない | Approved | 非該当 |
| `WORK-F-064` | 利用者はboundedなread-only workspace contextを取得できる | FilesとGit diffはtrusted root内のnative Git processから5秒以内、stdout 1MiB・stderr 4KiB以内で取得し、超過・停止時はprocess treeを終了して保存しない。workspaceごとにcapture順で最新10件だけをUIとDBへ一致して残し、信頼できるproducerがないTerminal outputはdemoを含め成功表示しない | Approved | 非該当 |
| `WORK-F-065` | native workspace読込はdemo状態と分離する | native初期化中はworkspace skeletonと読込状態だけを表示し、add/create/select/draft/context/deleteを開始しない。読込失敗時もdemo workspaceへfallbackせず、回復errorと再試行可能性だけを表示する | Approved | 非該当 |
| `WORK-F-066` | repository healthとrepairを状態付きで扱う | 各projectを`healthy` / `missing` / `changed` / `unreadable` / `read_only` / `stale_branch`へ分類し、workspace rowとheaderへ色だけでなくlocalized textとiconで表示する。Repair pickerは新しいcanonical Git worktreeのrepository identityが対象Project IDの保存identityと一致する時だけlinkageをatomic更新し、workspace ID、history、Context、draft、summary、anchorを維持する。candidate identityはpicker直後、mutation前、activation直前、DB transaction直前にlive filesystemから再検証し、DBでは保存Project ID・旧linkage・immutable identityとのcompare-and-swapを行う。同一repositoryの通常renameは許可するが、same-path replacementとTOCTOUはtyped changed errorで拒否する。identity不一致、picker cancel、権限不足、I/O失敗ではlinkageとselectionを変更せず、新規project追加を案内する。repairはsource、working tree、Git index/object/refを変更しない | Approved | 非該当 |

`RepositoryIdentityV1`は、symlinkをたどらず検証したGit common directoryのfilesystem device/inodeとGit object formatをnativeだけで保持する。通常のpath renameでは同一identityを維持し、copy、別volumeへの移動、Git directory置換、object format変更はidentity不一致としてrepairせず新規project追加を要求する。Project IDはappが一度だけ発行するopaque UUIDであり、path、workspace、branch、character selectionのいずれからも再生成しない。

## 実装参照と変更時の不変条件

| 境界 | 正本 | 変更時に同時確認する範囲 |
|---|---|---|
| IPC contract | `src/lib/contracts/workspace-history.ts`、`src-tauri/src/workspace_history/types.rs` | Project summary、workspace summary、create/unregister/archive requestのja/en UI projection |
| persistence / migration | `src-tauri/src/workspace_history/store.rs` | `projects.registered`、workspace固有canonical root、`managed_worktree`、migration 8のnullable common Git directory identity、DB version、cross-language fixture |
| Git mutation / trust | `src-tauri/src/workspace_history/service.rs`、`src-tauri/src/codex/workspace.rs` | project common Git identity、app-owned worktree path、固定Git引数、partial failure rollback |
| frontend state | `src/features/workspace-persistence/adapter.ts`、`src/features/workspace-view/useWorkspaceViewModel.ts` | Project IDをworkspace作成まで維持し、workspace 0件でもproject一覧を失わない |
| UI | `src/main.tsx`、`src/app/StartupFailure.tsx`、`WorkspaceCreateForm.tsx`、`WorkspaceSidebar.tsx`、`SettingsView.tsx`、`WorkspaceShell.tsx` | startup error boundary、zero-workspace inline form、sidebar project選択dialog、hover/focus Archive、compact navigation、Projects登録解除確認 |

project登録解除は`projects.registered`とnavigationだけを変更し、workspace row、history、worktree、branchを物理削除しない。workspaceとして一覧・件数・active selection・起動時復元へ公開するのは`managed_worktree = 1`のapp管理worktreeだけとし、migration前のproject rootに対応するlegacy rowは保持したまま公開しない。project linkageはproject root identityとGit common directory identityを保存し、workspace preflightはworkspace固有root identityとそのcommon directory identityを照合する。migration 8以前のprojectはcommon identityをnullableで移行し、project rootの保存済みidentityとのexact一致を確認した最初のworkspace作成時にだけcommon identityを補完する。per-worktree Git directory identityやworkspace root identityをproject root identityと比較してはならない。workspace Archiveだけが`managed_worktree = 1`かつ保存rootがapp data配下の導出済みexact pathと一致する対象へ固定`git worktree remove --force`を実行する。legacy workspaceまたはroot不一致にGit削除を拡張してはならない。履歴削除はworkspace登録とworktreeを残し、履歴・draft・editable contextだけを初期化する。

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| Project | repository folder | なし | 必須 | canonical regular directory、同一path重複不可。非Gitまたはorigin未設定はsetupへ進み、登録確定時にはGit worktreeかつorigin設定済みであること | 入力を登録せず、setup入力、再選択とcancelを残す |
| Workspace | project | projectが1件ならそのproject、複数なら直前選択または先頭 | 必須 | 登録済みProject IDだけ | 入力保持、該当fieldへerror |
| Workspace | name | `ws-MMDD-<random 4文字>` | 必須 | trim後1〜80 Unicode scalar、改行不可。Git branch/worktree pathへはnative側で安全なslugとopaque IDを使用し、表示nameをpathへ直接使用しない | 入力保持、該当fieldへerror |
| Project filter | registered Project ID list | 空 | 任意 | 重複のない登録済みProject IDを複数選択。空配列はすべてを表示 | 無効IDだけを除去し一覧を維持 |
| Repair | repository folder | 現在のlinkage | 条件付き | canonical regular Git worktree、保存repository identityとのexact一致 | linkageを変更せず、再選択・cancel・新規project追加を残す |
| App settings > Projects > project detail | project context | 空 | 任意 | Project ID-scoped。goal / constraints / user notesは各0〜8,000、Definition of doneは最大20項目・各1〜500、technical referencesは最大20項目・各1〜500、全field・全項目の総量32,000 Unicode scalar | 保存せず入力保持 |
| App settings | character context | Display nameは`Sol`、他は既定値 | 任意 | app-global。display name 1〜40、tone補足0〜1,000、behavior 0〜4,000、prohibited expressions最大20項目・各1〜200、全field・全項目の総量12,000 Unicode scalar、technical policy key禁止 | 禁止内容を除いて再編集を求める |

### Versioned editable Context contract

`ProjectContext`と`CharacterContext`はcapture済みFiles / Git diffとは別のeditable contextである。ProjectはProject IDをpartition keyとして保存し、同じprojectに属する全workspaceで共有する。Characterはapp-globalなsingletonとして保存する。ProjectとCharacterは別versionを持ち、片方の保存が他方の未保存draftまたはversionを変更してはならない。

| record | field | 型・保存境界 |
|---|---|---|
| `ProjectContext` | `goal` | string、0〜8,000 Unicode scalar |
| `ProjectContext` | `constraints` | string、0〜8,000 Unicode scalar |
| `ProjectContext` | `definitionOfDone` | string配列、0〜20項目、各trim後1〜500 Unicode scalar |
| `ProjectContext` | `technicalReferences` | string配列、0〜20項目。`doc:`で始まるmanaged document IDまたはproject rootからの正規化済みrelative pathだけを保存し、absolute path、`..`、root外symlinkを拒否する |
| `ProjectContext` | `userNotes` | string、0〜8,000 Unicode scalar |
| `CharacterContext` | `displayName` | string、trim後1〜40 Unicode scalar。fresh workspaceは`Sol` |
| `CharacterContext` | `tone` | `concise` / `warm` / `neutral`のallowlist |
| `CharacterContext` | `toneNotes` | string、0〜1,000 Unicode scalar |
| `CharacterContext` | `speechDensity` | `quiet` / `key_events` / `detailed`のallowlist |
| `CharacterContext` | `behavior` | string、0〜4,000 Unicode scalar。presentation上の希望だけを扱う |
| `CharacterContext` | `prohibitedExpressions` | string配列、0〜20項目、各trim後1〜200 Unicode scalar |

Project総量は32,000、Character総量は12,000 Unicode scalarを上限とし、配列の各itemも総量へ加算する。Projectの保存requestは`projectId`と`expectedVersion`、Characterの保存requestは`expectedVersion`を必須にし、SQLite transaction内で現在versionとの一致を検証してからversionをちょうど1増やし、canonical JSONのSHA-256を更新する。不一致時は`PROJECT-CONTEXT-CONFLICT`または`APP-CHARACTER-CONTEXT-CONFLICT`を返し、DBと利用者のdraftを変更しない。

Characterの自由入力は、行頭またはJSON key位置にある`permission`、`approval`、`model`、`tool`、`git`、`commit_skill`、`verification`、`privacy`、`support_capability`、`checkpoint_policy`と、その表記揺れをtechnical policy keyとして拒否する。また`override` / `bypass` / `disable` / `ignore`とtechnical policy名を組み合わせた指示に限らず、grant / deny / allow / skip / avoid / never askや「常に許可」「確認しない」「検証を省略」等、権限、承認、検証、安全、checkpointの実行ruleを変更する意味的な指示もja/en共通fixtureに基づき拒否する。presentation上の語（例: permission errorを簡潔に説明する、verification結果を温かく伝える）は拒否しない。拒否はCharacter record全体をatomicに失敗させ、Project Contextへ自動コピーしない。

Projectの配列fieldは入力中のraw textをProject ID-scoped draftとして保持し、Space、行末空白、空行、IME compositionを`onChange`で正規化しない。blurまたはSave時だけ行をtrimし、空itemを除外して配列化する。validation失敗時はraw入力とcaretを保持し、保存成功時だけcanonical itemをUIへ戻す。

technical referenceはSave時に`.` segmentと重複separatorを除いたcanonical project-relative表記へ正規化し、登録projectのtrusted root内で各componentと最終targetを解決する。保存時のproject root identityとreference target identityをapp-private metadataへ記録する。missing、absolute、`..`、root外symlinkを保存しない。Send時は同じProject IDの対象workspace root内で同じrelative pathを再解決し、root境界、存在状態、symlink解決先を再検証する。branchごとに正当に異なるworktree identityまたはtarget identityはProject Contextの共有を妨げない。対象workspaceでmissingだったpathが後から作成された場合も、次のSendで同じ境界検査を最初から行う。

Sendはnative storeから対象workspaceが属するProject IDのProject contextとapp-globalなCharacter contextを同じread transactionで取得し、各versionとcanonical JSON hashを持つimmutable request snapshotをturn開始前に一度だけ確定する。snapshot直前に現在のtrusted workspace root、workspace identity、全technical referenceを再検証し、失敗時はrecoverable preflight errorでSendを止める。main sessionへ渡すcontextは命令ではないquoted untrusted dataとして明示的な境界内へ直列化し、authoritative user instructionおよびapp-owned technical policyと混在させない。Character contextはpresentation metadataとしてのみ扱い、permission、verification、安全ruleのauthorityを持たない。turnが`running` / `waiting`になった後の保存を途中注入せず、次のSendだけが新versionを取得する。Project record、draft、conflictはProject IDごとに共有し、turn snapshotだけを対象workspaceへ固定する。Character contextは同じglobal version・hash・内容を全workspaceで参照する。

既存のworkspace-scoped Project Contextはschema migration時にProject ID-scoped recordへ集約する。同じprojectに複数recordがある場合は`last_selected_at`が新しいworkspace、workspaceの`updated_at`が新しいrecord、workspace IDの昇順を順に優先して1件を選ぶ。workspaceがないprojectには空の既定recordを作成し、移行後の保存はproject recordだけを更新する。

nativeとdemoは同じcanonical JSON SHA-256およびsnapshot hash materialを使う。同じcanonical contentは同じcontent hash、異なるcontentは異なるhashとなり、UIの短縮hashをsynthetic placeholderで代用しない。

## デスクトップ固有要件

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | macOS 14以降のfolder pickerとpath normalization | `WORK-F-044`〜`WORK-F-047` |
| ウィンドウ生成・再利用 | single main window内のsidebarとtabを再利用 | `WORK-F-052` |
| 閉じる・アプリ終了 | active executionの停止判断はAPP要件に従う | `WORK-F-058`, `WORK-F-060` |
| 未保存データ | composer draftはworkspace単位、Project context入力はProject ID単位、Character context入力はapp単位で保持 | `WORK-F-059`, `WORK-F-063`, `WORK-F-064` |
| ローカルデータ | canonical pathはRust管理DBの目的限定project linkageへ保存し、normalized eventやUI storageを正本にしない | `WORK-F-060` |
| オフライン | project一覧、project filter、Project detailのProject Contextは利用可能 | `WORK-F-051`, `WORK-F-063` |
| ファイル・OS操作 | picker cancel、権限不足、移動・削除、bounded context process失敗を区別 | `WORK-F-045`, `WORK-F-047`, `WORK-F-062`, `WORK-F-064` |
| メニュー・ショートカット | FolderPlusとPlusへ24×24px hit areaとaccessible nameを与える。`Command+K`はListFilterのPopoverを開きProject複数選択controlへfocusする | `WORK-F-044`, `WORK-F-050`, `WORK-F-051` |
| Deep Link・ファイル関連付け | 非該当: MVPで登録しない | 非該当 |
| 通知 | attentionはapp内sidebarとheaderに表示 | `WORK-F-053` |
| Capability・認可 | pickerで選択したrootの診断だけをRustに許可 | `WORK-F-044`〜`WORK-F-049` |
| アップデート・互換性 | workspace schema migration失敗時は旧DBを維持 | `WORK-F-060` |

## 画面・UI

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-001` | セッションダッシュボード | `WORK-F-044`〜`WORK-F-062`, `WORK-F-065`〜`WORK-F-068` | 変更 | [画面詳細仕様](../screen-design/S-001_session-dashboard.md) |
| `S-002` | コーディングワークスペース | `WORK-F-052`〜`WORK-F-066` | 変更 | [画面詳細仕様](../screen-design/S-002_coding-workspace.md) |
| `S-005` | アプリ設定・診断 | `WORK-F-063` | 変更 | [画面詳細仕様](../screen-design/S-005_app-settings-diagnostics.md) |
| `S-006` | ワークスペース設定 | `WORK-F-048`, `WORK-F-057`, `WORK-F-066` | 変更 | [画面詳細仕様](../screen-design/S-006_project-settings.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | pathをcanonicalizeし、WebViewへhome directoryを含むabsolute pathを通常表示しない |
| 権限 | project rootのread診断、app metadata write、app-owned root内のworktree add/removeだけを許可し、登録解除でsource/worktreeを削除しない |
| プライバシー | repository path、goal、Contextはlocal保存のみ。支援agentへ送る場合は別要件のredactionを通す |
| 監査・ログ | add、cancel、select、lifecycle、preflight resultをsecretなしで記録する |
| 性能 | 200 workspaceのProject ID filter・group更新p95 100ms、selection更新p95 100ms |
| 信頼性・復旧 | DBまたはrepo消失時も他workspaceを開け、破損itemを明示する |
| アクセシビリティ | statusを色だけで表さず、label、icon、stroke/fillを併用する |
| 多言語・地域 | app labelはja/en。sidebarのlifecycle statusだけはLinearと同じ英語表記へ固定し、repo/branch/user contextも翻訳しない |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| Git repository | local worktreeを対象とする | 解決済み（MVP範囲） | bare/non-Gitは登録不可 |
| APP | single window、persistence、locale、close契約 | 解決済み（相互参照確認済み） | 独立レビューで整合確認 |
| CODE | Codex/auth/model preflight | 解決済み（相互参照確認済み） | blocked項目はSend不可 |
| LIVE | character pack preflight | 解決済み（相互参照確認済み） | fallbackでもworkspaceは開ける |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| 並列workspace実行 | MVPはactive execution 1件、一覧と履歴は複数件 | demo後に需要を計測する | いいえ |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [PRODUCT.md](../../PRODUCT.md) | 利用者、監督、復元の目的 |
| [DESIGN.md](../../DESIGN.md) | sidebar、status、responsive仕様 |
| [プロダクト論点](../research/01-product-thesis.md) | 対象利用者と負担 |
| [体験設計](../research/02-experience-design.md) | workspaceとcontext分離 |
| [Linear Issue status](https://linear.app/docs/configuring-workflows) | lifecycle statusの英語表記と円形icon表現 |

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 2026-07-19 |
| 残る非ブロック論点 | 並列workspace実行はMVP非対象 |

## 着手可チェック

- [x] 背景と目的が説明できる。
- [x] スコープ内・外と理由が明確である。
- [x] 全機能要件に一意な要件IDがある。
- [x] 全機能要件に検証可能な受け入れ条件がある。
- [x] 正常系、異常系、キャンセル、権限差分、空状態、境界値を確認した。
- [x] デスクトップ固有要件を確認し、非該当も明記した。
- [x] 画面IDと要件IDの相互参照が一致し、承認済み画面詳細仕様を参照している。
- [x] 非機能要件と依存関係を確認した。
- [x] 着手ブロックが「はい」または「不明」の未確定事項がない。
- [x] 仕様責任者がレビューし、合意した。
