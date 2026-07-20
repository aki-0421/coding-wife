---
title: "S-001 セッションダッシュボード"
description: "ローカルfolderをGit/GitHub要件まで安全にセットアップしてproject登録し、workspaceの状態を一覧して作成・選択・復元する画面仕様。"
updated: 2026-07-20
last_verified: 2026-07-20
read_when:
  - "project picker、preflight、workspace sidebar、lifecycle、filter、selectionを実装するとき。"
  - "S-001とWORK、CODE、HIST、APP要件の対応を確認するとき。"
screen_id: "S-001"
status: "Approved"
---

# S-001 セッションダッシュボード

| 項目 | 内容 |
|---|---|
| window label | `main` |
| React route / view key | `/sessions` / `session-dashboard` |
| 対象OS | macOS 14以降、Apple Silicon |
| デザイン | [DESIGN.md](../../DESIGN.md)、Figma node `8:2`のworkspace sidebar、[demo.png](../thinking/demo.png) |
| 共通仕様 | [デスクトップ共通仕様](desktop-common-specification.md) |
| 廃止理由 | 非該当 |
| 後継画面ID | 非該当 |

## 目的

利用者がローカルfolderを選び、必要なら明示操作でGitとGitHub originをセットアップしてprojectとして登録・診断し、そのprojectから作業単位のGit worktreeであるworkspaceを作成する。workspaceのlifecycleと介入要否を一覧から理解し、固有のworktree、branch、draft、履歴を持つ作業面へ移動できるようにする。

## 対象範囲

### 含める

| 対象 | 内容 |
|---|---|
| Project追加 | OS folder picker、Git初期化、GitHub originセットアップ、canonicalization、Git worktree検証、重複選択 |
| Preflight | Git、Codex executable、login、GPT-5.6 Sol、character packのready/warning/blocked |
| Workspace作成 | 0件時のproject/name入力、通常時のsidebar project card選択、app-owned Git worktree作成、Backlog登録・選択 |
| Sidebar | lifecycle group、attention、repo、branch、project filter、active selection |
| Continuity | Project ID、group、active workspace、project filter、draft、last summary、timeline anchor ID/sequence/offset、repository healthの復元 |
| Safe removal | workspace Archiveによる対象worktree削除、project metadata登録解除。Archive以外ではworktreeとGit refを削除しない |

### 含めない

| 非対象 | 理由 | 扱う画面・文書 |
|---|---|---|
| repository clone / fetch | network credentialと競合解決をMVPへ含めない | 外部Git client |
| 同時に複数turnを実行 | MVPはactive execution 1件 | [S-002](S-002_coding-workspace.md) |
| manual commit / terminal | workspace作成の目的ではない | [S-003](S-003_session-evidence.md)、read-only tool event |
| Project Context本文編集 | App settingsのProjectsから対象projectを開いて行う | [S-005](S-005_app-settings-diagnostics.md) project detail |

## 表示契機と終了

| 項目 | 内容 |
|---|---|
| 表示契機 | 初回起動、workspace 0件、sidebarのFolderPlus/Plus、missing project、S-002〜S-006からSessionsへ戻る |
| 表示前提 | app-private DBをreadできること。読めない場合はrecovery stateを表示する |
| 初期フォーカス | 0件時は`Projectを追加`、通常時はactive workspace item、error時は最初の回復操作 |
| 正常完了 | workspace選択後、同じIDの[S-002](S-002_coding-workspace.md)へ移動する |
| キャンセル | picker/dialog開始前の一覧、active selection、project filter、入力を維持する |
| 閉じる操作 | [共通close契約](desktop-common-specification.md#windowとtitlebar)に従う |
| 再表示 | group、active selection、project filter、sidebar scroll、last summary、timeline anchor ID/sequence/offset、repository identity/health snapshot、preflight結果をRust DBから復元する |

## 利用者と権限

| 利用者・ロール | 表示 | 操作 | 拒否時の動作 |
|---|---|---|---|
| ローカル利用者 | project、workspace、preflightの非秘密情報 | add、create、project filter、select、cancel、登録解除、再診断 | 無効path・権限・実行中turnではmutationせず理由を表示 |
| React WebView | pack ID、workspace ID、sanitized repo/branch | typed picker/create/select request | absolute home path、任意Git引数、任意shellを送れない |
| Rust project service | canonical path、Git metadata、DB | picker result検証、read-only preflight、metadata transaction | 不正path、I/O、duplicateを構造化errorにする |
| Codex supervisor | preflight statusだけ | executable/login/model capability診断 | blockedならSend不可のstatusを返しthreadを開始しない |

## 画面構成

### 標準1470×836

| 領域 | 実装拘束値 | 表示内容 | 主な操作 |
|---|---:|---|---|
| native titlebar safe area | sidebar上40.5px | OS所有のnative traffic lights用余白。WebViewは赤・黄・緑の円を描画しない | close、minimize、zoomはmacOS native controlで行う |
| workspace heading | sidebar内40.5px | `Workspaces`、ListFilter、FolderPlus、Plus | project filter、project追加、workspace作成 |
| workspace list | sidebar幅255.04px、item 242.25×49.5px | owner avatar、branch、`owner/repo`、Done / In Review / In Progress / Backlog / Canceled | select、attention確認、overflow |
| sidebar footer | 40.5px | App settings gear | [S-005](S-005_app-settings-diagnostics.md)へ移動 |
| main header | sidebar右、81px | `Sessions` breadcrumb、preflight summary | current project切替、診断詳細 |
| project surface | main content | project概要、preflight、workspace create/empty/recovery | add、recheck、create、open |

S-001のmain contentはChat/Companionを描画せず、main幅中央へ最大760pxの一続きの設定面を置く。projectごとに同型cardをgrid表示せず、選択project 1件の詳細とsidebar一覧を表示する。960〜1279pxでは64px rail + portal drawerを使い、project surfaceを残幅へ広げる。

Project folder選択後、Git初期化済みかつorigin設定済みとnativeが診断した場合はsetup stateを生成せず、setup dialogを一度も描画しないでproject登録へ直行する。不足要件がある場合だけportalされた一つのsetup dialogで段階表示する。dialogは`プロジェクトをセットアップ / Set up project`のtitle、必要なcontrol、Cancelとprimary actionだけを表示し、folder説明、section heading、通常時helper、absolute path、Setup IDを表示しない。非Git時は`Gitを初期化 / Initialize Git`をprimary actionにする。初期化後または既にGitでorigin未設定なら、認証済みGitHub current userを先頭、organizationを続けて重複なく列挙するowner select、literal `/`、folder basenameのsafe slugを初期値とするrepository inputを`owner/repository`形式の1行に置く。visible labelは置かず、各controlのaccessible nameだけを保持する。確定actionは`GitHubをセットアップ / Set up GitHub`とする。

setup dialogはGitHub CLI未導入、未認証、owner取得失敗、invalid repository name、repository作成・origin設定失敗の該当errorだけをfieldまたはaction直上へ表示し、入力とSetup IDを保持して再試行できる。Git初期化とGitHub接続はprocessing中だけcontrolsを無効化し、polite live regionへ進行を通知する。全checkがreadyになったnative responseを受けた時だけdialogを閉じてproject一覧へ反映する。Escape / Cancelは未実行mutationとproject登録を行わず起点buttonへfocusを返すが、既に利用者が確定したGit初期化やGitHub側の作成をrollbackしない。

registered projectが1件以上ある状態でsidebarのWorkspace追加を押すと、`プロジェクトを選択 / Select a project` dialogを開く。登録projectはtableやselectではなく、repository owner avatarまたはlocal repository fallback icon、GitHub `owner/repo`またはproject名を持つcard風buttonとして3column gridへ表示する。card全体をclick、`Enter`、`Space`で選択でき、選択時に既定workspace nameを生成して作成を開始する。processing中は全cardを無効化し、選択cardだけに作成中状態を表示する。成功時だけdialogを閉じて新workspaceを開き、失敗時は元selectionを維持したままdialog内で再試行できる。Escapeまたはcloseでは作成せず起点buttonへfocusを戻す。

### sidebar visual state

| lifecycle | shape | color token | label |
|---|---|---|---|
| Done | filled circle + check | successの代わりにwarm done fill | `Done` |
| In Review | half-filled progress circle | `success` | `In Review` |
| In Progress | quarter-filled progress circle | `running` | `In Progress` |
| Backlog | dotted circle | `text-muted-accessible` | `Backlog` |
| Canceled | filled circle + x | `canceled` | `Canceled` |

sidebarのlifecycle statusは[LinearのIssue status](https://linear.app/docs/configuring-workflows)と同じ英語表記と進捗円形状を正本とし、app localeが日本語でも翻訳しない。この例外はgroup headingとworkspace itemのaccessible lifecycle labelだけに限定し、周辺control、attention、repository healthはja/en localeへ追従する。status colorは本appのsemantic tokenを維持する。

各lifecycle groupはheading行全体をaccordion toggleとし、画面mount時はすべて展開する。heading行の任意位置をclickすると対象groupだけを開閉し、他group、active workspace、project filterを変更しない。toggleは`aria-expanded`と`aria-controls`を持ち、折り畳みchevronはpointer hover時だけ表示する。keyboard操作ではaffordanceを失わないようfocus-visible時にも表示し、`Enter`または`Space`で同じ開閉を行う。展開状態は永続化せず、画面を再mountすると全groupを展開する。折り畳み中だけheading右端に対象workspaceの数値件数を表示し、0件も`0`として省略しない。読み上げ名には展開状態にかかわらず同じ件数を1回だけ含める。

workspace navigation contentは242.25pxを上限として、右端の件数とchevronを255.04px sidebar内へ収める。`pnpm exec vitest run src/features/workspace-view/WorkspaceShell.test.tsx --fileParallelism=false -t "expands lifecycle groups by default and toggles them independently"`で初期展開、独立開閉、1件・0件表示、ARIA、content幅を検証する。

sidebar typographyは、`Workspaces` headingを14px / 600 / 21px、lifecycle statusを12px / 600 / 18px、branch titleを13px / 500 / 19.5px、GitHub repository full nameを11px / 400 / 16.5pxとする。workspace itemの先頭にはheaderと同じ24px owner avatarを置き、GitHub metadataがない時はneutral Git worktree fallback、画像取得失敗時はneutral user fallbackを使う。workspace selectionでfont weight、文字幅、avatar geometryを変えず、selected background、strong text、branch violet iconだけを切り替える。health metadataは11px / 500 / 16.5pxを維持する。

sidebar内のicon-only buttonは、project filter、project追加、workspace追加、Archive、App Settings、compact navigationを含め、静止時に`Workspaces` headingと同じ`text-muted-accessible`相当の色を使う。hover、focus-visible、active/current stateでは既存のforegroundまたはselected stateへ切り替え、操作可能性と現在地を示す。workspace rowはArchive buttonが透明な静止時も24pxのcontrol幅と右6px insetを通常flow内で確保し、branch、repository、healthのellipsis領域をその予約幅へ侵入させない。Archiveのhover/focus表示によってrow内の文字幅、折り返し、位置を変えない。`pnpm exec vitest run src/features/workspace-view/WorkspaceShell.test.tsx --fileParallelism=false -t "mutes sidebar icon controls and reserves the archive action width"`でicon-only buttonの静止色とArchiveの通常flow内予約を検証する。

ListFilterはtooltipを`フィルター / Filter`とし、任意文字列inputを表示しない。押下するとportalされたPopover menuを開き、`プロジェクト / Project` labelと横並びの非native複数選択controlへfocusを移す。controlは登録済みProject IDごとにrepository iconとGitHub `owner/repo`、取得できない時はproject名を表示し、1件以上を同時選択できる。選択値は登録済みProject IDの重複なしlistだけを受け付け、未選択ではすべて、選択中はProject IDのいずれかと完全一致するrowだけをlifecycle group内へ残す。選択workspace自体はfilterで変更せず、project登録解除などでIDが無効になった時は該当IDだけをfilterから除去する。filter有効中はListFilter buttonをselected state、`aria-pressed="true"`、選択件数badgeで示し、Popoverを閉じても状態を識別できるようにする。一致するworkspaceが0件でも専用empty説明やfilter解除buttonを表示せず、通常のlifecycle groupを残す。`pnpm exec vitest run src/features/workspace-view/WorkspaceShell.test.tsx --fileParallelism=false -t "filters workspaces with the registered project multi-select"`でmenu、日英accessible name、非native control、repository icon、複数Project IDのOR一致、適用件数、empty helper非表示を検証する。

`text-sidebar-*`のsize roleと`text-*` colorを同じ`cn` / Tailwind mergeへ渡すとsize roleが競合classとして除去されるため、両classをmergeしないかmerge設定を明示する。`pnpm exec vitest run src/features/workspace-view/WorkspaceShell.test.tsx --fileParallelism=false -t "uses branch titles and GitHub repository metadata with stable typography"`でbranch/repositoryの表示順、role classの保持、selection時の安定性を検証する。

attentionはlifecycleを変更せず、`Needs answer / Approval required / Test failed / High risk`のicon、text、countをitem右端へ付ける。active itemだけ`selected-row`、strong text、branch violet iconを使う。itemはowner avatar、二行のtext columnの順とし、第一行はbranch iconとbranchまたはdetached HEAD短縮SHA、第二行はGitHub `origin`から抽出した`owner/repo`とする。GitHub `origin`がない場合はlocal repo名へfallbackする。remote URL自体やcredentialはWebView、DB、logへ渡さない。repo/branchは一行ellipsis + tooltipとする。

### preflight

| check | Ready | Warning | Blocked |
|---|---|---|---|
| Git | worktree/HEAD readable | detached HEAD | non-Git、bare、missing、permission |
| Codex | executable/initialize usable | optional capability不足 | spawn/protocol不可 |
| Login | authenticated | 診断更新待ち | unauthenticated |
| Sol | `gpt-5.6-sol` usable | effort一部だけ | model unavailable |
| Character | selected/default pack usable | static/reduced fallback | text-only。workspaceは作成可、Send可否は他checkで決める |

Blocked checkが1件以上ならS-002はread-onlyで開けるがSendを無効にする。CharacterだけのBlockedはChatを止めずtext-onlyへ縮退する。

### repository healthとlifecycle action

repository healthはpreflightの集約結果とは別のversioned stateとして、workspace rowとheaderの両方へlocalized text、icon、shapeで表示する。色だけで区別しない。

| state | 日本語 / English | Sendと選択 | 回復 |
|---|---|---|---|
| `healthy` | `正常 / Healthy` | Send可 | 非該当 |
| `missing` | `リポジトリが見つかりません / Repository missing` | 履歴はread-only、Send不可 | `再選択して修復 / Repair location`、登録解除 |
| `changed` | `別のリポジトリです / Repository changed` | 現selectionを維持しSend不可 | 保存identityと一致するworktreeを再選択、新規project追加 |
| `unreadable` | `読み取れません / Repository unreadable` | 履歴はread-only、Send不可 | 権限案内、再診断、再選択 |
| `read_only` | `書き込みできません / Repository read-only` | 閲覧のみ、Send不可 | 権限案内、再診断 |
| `stale_branch` | `ブランチの再確認が必要です / Branch changed` | 再preflightまでSend不可 | read-only再診断。Git状態を自動で戻さない |

window focus、workspace選択確定、Send直前にrepository identity、HEAD、branch、readability、writeabilityをread-onlyで再検査する。前snapshotとの差があれば1秒以内にheaderとrowを更新し、明示preflightが成功するまでturnを開始しない。

workspace cancel、project登録解除、active-turn切替の確認dialogは安全な`戻る / Back`を初期focusとし、focusをdialog内にtrapする。`Escape`は`戻る`と同じで、selection、turn、lifecycle、draft、timeline anchor、caption/TTS、Git fingerprintを変更せず、閉じた後は起点controlへfocusを戻す。成功後は次のvalid workspace item、存在しなければinline create formの最初の操作可能なfieldへfocusする。processingはpolite、失敗はassertive live regionへ1回だけ通知する。

## 表示状態

| 状態 | 進入条件 | 表示 | 操作可否 | 状態から抜ける条件 |
|---|---|---|---|---|
| 初期化中 | DB、workspace、Git linkageを読込中 | sidebar/list/project surfaceのskeleton、locale、Quit。demo workspaceを表示しない | Quitだけ。add/create/select/draft/context/deleteを開始しない | queryとmigrationがterminalになる |
| 通常 | 1件以上のvalid workspace | group list、active project、preflight、primary action 1件 | project filter、select、add、create、state action | 操作開始、offline、error |
| projectなし | registered project 0件、workspace 0件 | main surfaceのinline create form。Project fieldには`Projectを追加`、workspace nameには短い既定値を表示する。sidebarにはempty説明文を置かず、5つのlifecycle groupを常に表示する | picker、name編集、Settings、Quit | project登録またはrehydrate |
| project setup: Git未初期化 | pickerでregular writable non-Git folderを選択 | dialog title、`Gitを初期化`、Cancel。通常時の説明文は表示しない | 明示Git初期化、Cancel | Git初期化成功、Cancel、typed error |
| project setup: origin未設定 | valid Git repositoryにoriginがない | visible labelなしの`owner / repository`横並びcontrol、`GitHubをセットアップ`、Cancel。通常時のhelperは表示しない | owner/name編集、確定、Cancel、owner再取得 | origin設定と最終診断成功、Cancel、typed error |
| workspace project選択 | registered project 1件以上でsidebarのWorkspace追加を押す | repository icon画像とrepository名を持つ3columnのproject card grid | card選択、Escape、close | 作成成功、Cancel、typed error |
| workspaceなし | registered project 1件以上、workspace 0件 | main surfaceのProject select、workspace name、`Workspaceを作成`を持つinline form。sidebarにはempty説明文を置かず、5つのlifecycle groupを常に表示する | inline create、project追加、Settings、Quit | worktree作成またはproject登録解除 |
| 処理中 | picker後検証、preflight、create、cancel、remove | 対象stepとprogress、他workspaceは利用可能 | 可能なCancel、影響外select | success、cancel、error |
| オフライン | network/Codex接続なし | local list、Git/DB status、Codex offline | project filter、Context、local project操作可。Send不可 | 明示preflight成功 |
| エラー | Git I/O、DB write、Codex診断失敗 | code、対象、保持data、retry/reselect/details | 影響外workspaceを開ける | 明示回復または登録解除 |
| 権限不足 | selected rootまたは`.git` read不可 | 拒否pathはbasenameだけ、OS権限案内、再選択 | 再選択、Settings、Quit | permission変更後の再診断 |
| キャンセル後 | picker/create/remove確認をcancel | 開始前の一覧、selection、input、fingerprint | 元操作または別操作 | 次の明示操作 |
| 再起動復旧 | crash、missing repo、migration rollback | active selection、Interrupted badge、last summary、timeline anchor、repository health、Missing/Recovery | reselect、open read-only、diagnostic、remove | linkage/preflight成功 |
| native読込失敗 | DB open、contract、復元taskがterminal error | demo dataを使わないempty recovery surface、sanitized error code、再試行案内 | Retry、Settings、Quitだけ | native queryが成功する |
| active execution競合 | active/pending turnを持つworkspaceから別workspaceを選択または別workspaceでSend | 新selectionを保留し、old workspaceをactive表示したまま`停止して切替 / Stop and Switch`、`戻る / Back`だけを表示 | 二つの明示操作だけ | exact old turnのterminal interruptとcleanup完了、またはBack |
| repository repair | healthが`missing` / `changed` / `unreadable` | picker、identity照合、atomic updateのstepとCancel | Cancel、影響外workspace選択 | exact identity一致またはtyped error |

## 操作

| 操作 | 事前条件 | 正常結果 | キャンセル時 | 失敗時 | 関連要件ID |
|---|---|---|---|---|---|
| Projectを追加 | toolbar FolderPlusまたはinline formのProject field | native pickerの1 directoryをRust診断し、Gitとoriginがreadyならdialogを描画せずprojectだけを1件追加。不足時だけSetup IDによるdialogへ進み、全check成功後に同じ登録処理を行う。workspaceは作成せず、inline formのProject selectへ反映する | 一覧、selection、inline入力を維持し、errorなし。確定済みGit/GitHub mutationは保持 | 登録せず該当stepで入力と再試行を保持 | `WORK-F-044`〜`WORK-F-049`, `WORK-F-070` |
| preflight再診断 | project rootが存在 | Git/Codex/login/Sol/characterを更新 | 非該当 | check単位でBlocked、既存履歴維持 | `WORK-F-048`, `CODE-F-051`, `CODE-F-075` |
| Workspace作成 | 0件時はinline form、通常時はsidebarのPlus。registered project 1件以上 | inline formは指定project/nameを使う。sidebarは3columnのproject card dialogを開き、cardで選んだProject IDと生成した既定nameを使う。選択projectの現在HEADからapp-owned root配下へ新branchとworktreeを作り、workspace固有rootとprojectのGit common directory identityを照合して、成功後だけdialogを閉じ、Backlogへ1件追加・選択してそのworkspaceを開く | inline入力は維持する。sidebar dialogは閉じ、作成開始前のselectionを維持する。一覧・filesystemは変更しない | inlineは入力保持。sidebar dialogは開いたまま元selectionを維持してerror noticeを表示する。Git/DBの片方だけを残さずrollback | `WORK-F-050` |
| workspaceをArchive | sidebar rowのArchive、active/pending turnなし | 確認後、対象worktreeを削除してrowを一覧から外す。既にworktreeが消失済みなら成功扱い | workspace、worktree、selection不変 | 対象以外を変更せず、再試行可能なerror | `WORK-F-067` |
| project filter | 登録済みproject 1件以上 | Popoverの非native複数選択controlで選んだProject IDのいずれかと完全一致するworkspaceを100ms以内に表示し、ListFilterに選択件数を示す | Escapeで選択値を維持 | 一覧維持、無効Project IDだけを除去 | `WORK-F-051` |
| workspace選択 | itemがMissing以外、別workspaceにactive/pending turnなし | header、Chat、Commit、Settings、Companionを同一IDへ100ms以内にatomic切替。App SettingsのProject / Character contextはworkspace tab状態へ含めない | 非該当 | 元workspace維持 | `WORK-F-052`, `WORK-F-054`, `WORK-F-059` |
| active turn中のworkspace切替 | active/pending turnを持つold workspaceから別workspaceを選択または別workspaceでSend | selectionを保留し確認。`停止して切替`後、exact old turnのterminal interruptとcleanup完了時だけnew workspaceをactivateし、固有draft/summary/anchorを復元 | `戻る`でold selection、turn、draft、anchor、caption/TTSを完全維持 | old workspaceをactiveのままerrorとRetryを表示。rapid/duplicate/stale responseでnew workspaceをactivateしない | `WORK-F-058`, `WORK-F-059` |
| workspaceをCanceledへ移動 | idle、またはactive/pending turnを停止可能 | idleは確認後、activeは`停止してキャンセル / Stop and Cancel`後のexact terminal interrupt、cleanup、履歴flush完了時だけ専用native cancel commandでCanceled groupへ移動 | `戻る`でselection、turn、lifecycle、draft、caption/TTS、Git fingerprint不変 | generic lifecycle commandのCanceled指定を含めて拒否し、元groupとturnを維持してretry。source、working tree、Git index/object/ref、履歴本文を変更しない | `WORK-F-056` |
| project登録解除 | App Settings Projects、対象project配下のactive/pending turn 0件 | project名を示す確認後、project/workspaceのapp registrationをnavigationから外す | DB/repo/worktree/file/library/history本文不変 | 完了表示せずretry。running時は拒否 | `WORK-F-057`, `WORK-F-068` |
| repository再選択・Repair | `missing` / `changed` / `unreadable`、保存済み`RepositoryIdentityV1`あり | picker後・mutation前・activation直前・DB直前にlive identityを再検査し、対象Project IDの保存identityとexact一致した時だけcompare-and-swapでlinkageを更新してworkspace ID、history、Context、draft、summary、anchorを維持 | linkage、selection、health維持 | same-path replacement、TOCTOU、identity不一致、権限、I/Oは候補を保存せず新規project追加を案内。source、working tree、Git index/object/refを変更しない | `WORK-F-062`, `WORK-F-066` |
| repository再確認 | window focus、workspace選択確定、Send直前 | identity、HEAD、branch、readability、writeabilityをread-only照合しsnapshot更新 | 非該当 | stale warningと回復操作を表示しSendを開始しない | `WORK-F-061`, `WORK-F-066` |

## 入力項目

| 項目 | 初期値 | 必須 | 制約・境界 | エラー表示 | 保存契機 |
|---|---|---|---|---|---|
| repository folder | なし | project追加時必須 | canonical regular directory、duplicate不可。登録確定時はregular Git worktreeかつorigin設定済み | itemを作らずsetupまたは再選択 | 全preflight transaction成功 |
| GitHub owner | 認証済みcurrent user | origin未設定時必須 | nativeが返したcurrent user / organization loginのselectだけ。repository inputとliteral `/`を挟んで横並びにし、visible labelは置かない | field直下、選択保持 | GitHub setup成功 |
| GitHub repository name | folder basenameのsafe slug | origin未設定時必須 | 1〜100文字のASCII英数字、`.`、`_`、`-`。`.` / `..`、control、slash、末尾`.git`は不可。owner selectと横並びにし、visible labelと通常時helperは置かない | field直下、入力保持 | GitHub setup成功 |
| project | inline formはproject 1件なら自動選択、複数なら直前値または先頭。sidebar dialogは未選択 | 必須 | inline formはregistered Project IDのselect。sidebar dialogはrepository icon画像付き3column card buttonで単一選択し、tableとselectは使わない | field直下またはcreate actionのnotice、選択肢を維持 | Create成功 |
| workspace name | `ws-MMDD-<random 4文字>` | 必須 | trim後1〜80 Unicode scalar、改行不可。path/branchはnativeが安全な別名を生成 | field直下、入力保持 | Create成功 |
| project filter | 前回のProject ID listまたは空list | 任意 | 重複のない登録済みProject IDの非native複数選択。空listはすべてを表示し、optionはrepository iconとGitHub `owner/repo`、なければproject名を表示 | 無効IDだけを除去 | 選択変更時 |

## ネイティブ連携

実際のCapability設定は`src-tauri/capabilities/`を正本とする。

GitHub repository補助表示はnetwork APIを呼ばず、`src-tauri/src/codex/workspace.rs`がtrusted worktreeで`git config --get remote.origin.url`をread-only実行し、`github.com`のHTTPS / SSH / SCP形式だけを`owner/repo`へ正規化する。remote URL全体とcredentialは破棄し、nullableな`projects.github_repository`（workspace history DB migration 6）だけを保存する。HEADとremoteのGit processは同時観測し、20 repositoryの起動復元を5秒未満に保つ。`src/features/workspace-persistence/adapter.ts`がこの値をoptionalなview metadataへ変換し、値がない場合は`WorkspaceSidebar.tsx`がlocal repository aliasへfallbackする。parser、Git読取、migration、cross-language contractを変更した場合は`cargo test github_repository`、`cargo test repository_identity_reads_github_origin_without_network_access`、`cargo test legacy_versions_migrate_resume_state_and_registration_columns`、`cargo test serialized_contracts_match_the_cross_language_fixture`、`cargo test startup_restore_of_twenty_repositories_stays_within_the_budget`を実行する。

| ユーザー操作 | 実行境界 | Tauri plugin / Command | 必要なCapability・認可 | キャンセル時 | 拒否・失敗時 |
|---|---|---|---|---|---|
| project folder選択 | Tauri dialog → Rust | `select_project_root`（設計名） | directory picker 1件、選択rootのread診断 | 変更なし | path非表示のerror code |
| project Git初期化 | Rust Git process | `workspace_project_setup_git_init` | opaque Setup ID、保存root identity、固定`git -C <root> init`、5秒timeout | 未実行なら変更なし | project未登録、`.git`作成済みなら再診断へ収束 |
| GitHub owner取得・origin設定 | Rust GitHub CLI + Git process | `workspace_project_setup_github` | trusted `gh` executable、authenticated user/org allowlist、validated repository name、private createまたはexisting view、固定origin URL、保存root identity | 未実行なら変更なし | project未登録、入力保持、GitHub側成功後のlocal失敗は再試行で収束 |
| Git preflight | Rust child process | `diagnose_project` | canonical root、read-only allowlist Git command | running checkをsafe abort | check別Blocked |
| Codex preflight | Rust supervisor | `diagnose_codex` | executable/stdio capability、auth内容非読取 | 前回結果維持 | failure stageを表示 |
| create/select | Rust Git process + DB + Codex supervisor | `workspace_create_session` / `workspace_select` | typed Project ID/workspace name、app-owned worktree root、固定Git引数、expected generation | worktree/DBを作らない | partial worktree/DBをrollbackし、元selection/turn/lifecycle維持 |
| workspace Archive | Rust Git process + DB | `workspace_archive` | typed workspace ID、app-owned root containment、固定`git worktree remove --force`。missing targetは成功扱い | 変更なし | 他worktree/project/refを変更しない |
| workspace cancel | Rust DB + Codex supervisor | `workspace_cancel` | typed workspace ID、expected DB version。supervisor gateはactive/pending turnとcancel中のturn開始をatomicに拒否し、active cancelはexact terminal、cleanup、履歴flush proof後だけ呼ぶ | transaction前なら変更なし | `workspace_update_lifecycle`によるCanceled指定を拒否し、元selection/turn/lifecycle維持 |
| active workspace切替 | Rust supervisor + DB | `interrupt_and_switch_workspace` | old workspace/thread/turn/generation、pending selection、terminal cleanup proof | old workspaceの全state維持 | old workspaceをactiveのままerror |
| repository repair | Tauri dialog → Rust project service | `repair_project_linkage` | target Project ID、saved `RepositoryIdentityV1`、canonical worktree exact identity、atomic transaction | linkage/selection不変 | source/Gitを変更せずtyped reason |
| project登録解除 | Rust DB | `workspace_unregister` | typed Project ID、active/pending turn 0件、confirmation、metadata scope | 変更なし | source/Git/worktree/library/history本文を変更しない |

ローカルUI検証では`?demoAppServer=1`の通常一覧でsidebarのPlusを押し、repository icon画像付きproject cardが3columnで並ぶdialogを確認する。cardを選ぶとBacklogが1件増え、新workspaceのbranchとnameがsidebarのselected rowとheaderへ同時反映されることを確認する。同じ通常一覧でProject追加を押した時はreadyなprojectがsetup dialogなしで登録される。`?demoAppServer=1&projectSetup=git`ではGit初期化から簡素な`owner / repository`横並び入力への遷移、`?demoAppServer=1&projectSetup=github`ではorigin未設定のGit projectを直接再現する。いずれも実filesystem、GitHub repository、credentialを変更しないdemo transportだけで動作する。

## ウィンドウ固有動作

| 項目 | 動作 |
|---|---|
| 生成・再利用 | `main`の既存sidebarとproject surfaceを再利用 |
| 初期サイズ・最小サイズ | 共通の1470×836 / 960×640 |
| リサイズ | 960〜1279pxで64px rail + portal drawer。workspace 0件のcreate surfaceはmain幅いっぱいに外周paddingを取り、見出しとselect / input / actionは最大640pxで中央配置 |
| 最大化・全画面 | 共通仕様どおり |
| 常に手前へ表示 | 不可 |
| 閉じる操作 | 共通仕様どおり |
| 未保存変更がある場合 | dialogのcreate inputはcancel/route離脱で破棄し、inline create inputはworkspace 0件の表示中だけ保持する。既存workspace draftは保存 |

## メニュー・ショートカット

| 操作 | macOS | Windows / Linux | 有効条件 | 実行結果 |
|---|---|---|---|---|
| project filterへfocus | `Command+K` | 非対応 | destructive dialogなし | 必要ならdrawerとPopoverを開きProject複数選択controlへfocus |
| project追加 | toolbar/inline Project field | 非対応 | picker未起動 | native pickerを1回開く |
| workspace開く | `Enter` | 非対応 | item focus、Missing以外 | S-002へ移動 |
| drawer/menuを閉じる | `Escape` | 非対応 | non-destructive overlay | 入力維持、triggerへfocus |

## データ保持

| データ | 正本・保存先 | 保存契機 | 復元契機 | 破棄条件 | 失敗時 |
|---|---|---|---|---|---|
| project canonical path/metadata | Rust SQLiteの目的限定project linkage | registration transaction | cold start |明示登録解除 | 前回transaction維持 |
| workspace worktree linkage/lifecycle/attention | Rust SQLite + normalized event。worktree pathはapp-private | worktree作成成功後のtransaction、valid state transition | cold start/route return | workspace Archive | stale表示 |
| active selection/project filter/scroll | Rust SQLite | valid selection/Project ID list/scroll settle | route return/restart | Project登録解除またはschema不整合 | filterから無効IDだけを除去しselectionは維持 |
| summary/timeline anchor | Rust SQLite | terminal summary、scroll settle | route return/restart | history削除契約 | 同workspaceの最寄りvalid sequenceだけへ補正 |
| repository identity/health、HEAD/branch、GitHub `owner/repo` | Gitを観測正本、Rust DBはversioned last snapshot。GitHub full nameはlocal `origin` URLから抽出した非秘密値だけを保存する | 登録、window focus、selection、Send直前 | route return/restart後に再照合 | project登録解除 | GitHub `origin`なしではlocal repo名へfallbackし、health判定は変更しない |
| create input | React transient state | 保存しない | dialog中だけ | success/cancel/route leave | input保持できる範囲で保持 |

## OS差分

| 項目 | macOS | Windows | Linux |
|---|---|---|---|
| support | macOS 14+ Apple Silicon | MVP非対応 | MVP非対応 |
| folder picker | native directory picker | 非該当 | 非該当 |
| path display | basename/repo名、private absolute path非表示 | 非該当 | 非該当 |
| modifier | Command | 非該当 | 非該当 |

## アクセシビリティ

- focus順はheading actions、lifecycle group、workspace item、project surface、primary action、gearとする。
- group headingへitem件数を付け、collapseしてもattention itemを見失わない。
- lifecycle/attentionは色、label、icon、fill/outline/dashを併用する。
- 12px visual iconは24×24px以上のhit areaとtooltipを持つ。
- repo/branch ellipsisはfocus/hover tooltipとaccessible full valueを持つ。
- repository health、切替保留、Cancel/Repair/登録解除の状態はja/en textとiconで示し、rowとheaderを同じaccessible statusへ関連付ける。
- destructive/interrupt dialogはDOM順を説明、対象、保持data、`戻る`、実行actionとし、`戻る`へ初期focus、close後はtriggerへfocusを返す。
- processing updateはpolite、blocked/errorはassertive live regionへ1回だけ通知する。
- 200% text zoomではdrawer内itemを2行のまま保ち、primary actionを欠落させない。

## 関連要件

| 要件ID | この画面での扱い | 要件定義書 |
|---|---|---|
| `WORK-F-044`〜`WORK-F-070` | project追加・Git/GitHub setup、preflight、workspace lifecycle、active-turn confirmation、repository health/repair、persistence、native初期化境界 | [workspace-sessions](../requirements/workspace-sessions.md) |
| `CODE-F-051`, `CODE-F-075` | Codex/login/Sol preflightとblocked reason | [codex-main-session](../requirements/codex-main-session.md) |
| `HIST-F-040`, `HIST-F-045`, `HIST-F-051` | rehydrateとempty history導線 | [activity-history](../requirements/activity-history.md) |
| `APP-F-052`〜`APP-F-062` | single window、layout、navigation、language、a11y | [desktop-shell](../requirements/desktop-shell.md) |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| project surfaceの最終copy | ja/enの短文を実装時にlocalization tableへ置く | copy reviewでtoneを確認する | いいえ |
| workspace 200件時のgroup collapse初期値 | active/attention groupを展開、他を前回状態で復元 | performance/usage testで確認する | いいえ |
| character preflight Blocked | Chatをtext-onlyで継続し、Sendは他checkだけで判定 | Live2D integration testで確認する | いいえ |

## レビュー確認

| 項目 | 内容 |
|---|---|
| レビュー結果 | Approved |
| レビュー日 | 2026-07-18 |

- [x] front matter、title、filenameの`S-001`が一致する。
- [x] `status: Approved`である。
- [x] normal、empty、loading、processing、offline、error、permission、disabled、cancel、repair、restartを定義した。
- [x] active-turn切替、workspace cancel、project登録解除、repository health/repairのja/en copy、focus、live regionを定義した。
- [x] native operation、cancel、permission、data retention、OS差分を定義した。
- [x] 関連要件IDを要件定義書のS-001対応と一致させた。
- [x] 着手ブロックが「はい」または「不明」の未確定事項は0件である。
