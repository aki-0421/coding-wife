---
title: "S-001 セッションダッシュボード"
description: "ローカルGit projectを安全に追加・診断し、workspaceの状態を一覧して作成・選択・復元する画面仕様。"
updated: 2026-07-19
last_verified: 2026-07-19
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

利用者が既存のローカルGit projectを破壊的変更なしで登録・診断し、そのprojectから作業単位のGit worktreeであるworkspaceを作成する。workspaceのlifecycleと介入要否を一覧から理解し、固有のworktree、branch、draft、履歴を持つ作業面へ移動できるようにする。

## 対象範囲

### 含める

| 対象 | 内容 |
|---|---|
| Project追加 | OS folder picker、canonicalization、Git worktree検証、重複選択 |
| Preflight | Git、Codex executable、login、GPT-5.6 Sol、character packのready/warning/blocked |
| Workspace作成 | project select、既定name、app-owned Git worktree作成、Backlog登録 |
| Sidebar | lifecycle group、attention、repo、branch、filter、active selection |
| Continuity | Project ID、group、active workspace、filter、draft、last summary、timeline anchor ID/sequence/offset、repository healthの復元 |
| Safe removal | workspace Archiveによる対象worktree削除、project metadata登録解除。Archive以外ではworktreeとGit refを削除しない |

### 含めない

| 非対象 | 理由 | 扱う画面・文書 |
|---|---|---|
| repository clone / fetch | network credentialと競合解決をMVPへ含めない | 外部Git client |
| 同時に複数turnを実行 | MVPはactive execution 1件 | [S-002](S-002_coding-workspace.md) |
| manual commit / terminal | workspace作成の目的ではない | [S-003](S-003_session-evidence.md)、read-only tool event |
| Context本文編集 | active workspaceを選んでから行う | [S-002](S-002_coding-workspace.md) Context tab |

## 表示契機と終了

| 項目 | 内容 |
|---|---|
| 表示契機 | 初回起動、workspace 0件、sidebarのFolderPlus/Plus、missing project、S-002〜S-006からSessionsへ戻る |
| 表示前提 | app-private DBをreadできること。読めない場合はrecovery stateを表示する |
| 初期フォーカス | 0件時は`Projectを追加`、通常時はactive workspace item、error時は最初の回復操作 |
| 正常完了 | workspace選択後、同じIDの[S-002](S-002_coding-workspace.md)へ移動する |
| キャンセル | picker/dialog開始前の一覧、active selection、filter、入力を維持する |
| 閉じる操作 | [共通close契約](desktop-common-specification.md#windowとtitlebar)に従う |
| 再表示 | group、active selection、filter、sidebar scroll、last summary、timeline anchor ID/sequence/offset、repository identity/health snapshot、preflight結果をRust DBから復元する |

## 利用者と権限

| 利用者・ロール | 表示 | 操作 | 拒否時の動作 |
|---|---|---|---|
| ローカル利用者 | project、workspace、preflightの非秘密情報 | add、create、filter、select、cancel、登録解除、再診断 | 無効path・権限・実行中turnではmutationせず理由を表示 |
| React WebView | pack ID、workspace ID、sanitized repo/branch | typed picker/create/select request | absolute home path、任意Git引数、任意shellを送れない |
| Rust project service | canonical path、Git metadata、DB | picker result検証、read-only preflight、metadata transaction | 不正path、I/O、duplicateを構造化errorにする |
| Codex supervisor | preflight statusだけ | executable/login/model capability診断 | blockedならSend不可のstatusを返しthreadを開始しない |

## 画面構成

### 標準1470×836

| 領域 | 実装拘束値 | 表示内容 | 主な操作 |
|---|---:|---|---|
| native titlebar safe area | sidebar上40.5px | OS所有のnative traffic lights用余白。WebViewは赤・黄・緑の円を描画しない | close、minimize、zoomはmacOS native controlで行う |
| workspace heading | sidebar内40.5px | `Workspaces`、ListFilter、FolderPlus、Plus | filter、project追加、workspace作成 |
| workspace list | sidebar幅255.04px、item 242.25×49.5px | Done / In Review / In Progress / Backlog / Canceled | select、attention確認、overflow |
| sidebar footer | 40.5px | App settings gear | [S-005](S-005_app-settings-diagnostics.md)へ移動 |
| main header | sidebar右、81px | `Sessions` breadcrumb、preflight summary | current project切替、診断詳細 |
| project surface | main content | project概要、preflight、workspace create/empty/recovery | add、recheck、create、open |

S-001のmain contentはChat/Companionを描画せず、main幅中央へ最大760pxの一続きの設定面を置く。projectごとに同型cardをgrid表示せず、選択project 1件の詳細とsidebar一覧を表示する。960〜1279pxでは64px rail + portal drawerを使い、project surfaceを残幅へ広げる。

### sidebar visual state

| lifecycle | shape | color token | label |
|---|---|---|---|
| Done | filled circle + check | successの代わりにwarm done fill | `Done` |
| In Review | half-filled progress circle | `success` | `In Review` |
| In Progress | quarter-filled progress circle | `running` | `In Progress` |
| Backlog | dotted circle | `text-muted-accessible` | `Backlog` |
| Canceled | filled circle + x | `canceled` | `Canceled` |

sidebarのlifecycle statusは[LinearのIssue status](https://linear.app/docs/configuring-workflows)と同じ英語表記と進捗円形状を正本とし、app localeが日本語でも翻訳しない。この例外はgroup headingとworkspace itemのaccessible lifecycle labelだけに限定し、周辺control、attention、repository healthはja/en localeへ追従する。status colorは本appのsemantic tokenを維持する。

各lifecycle groupはheading行全体をaccordion toggleとし、画面mount時はすべて展開する。heading行の任意位置をclickすると対象groupだけを開閉し、他group、active workspace、filterを変更しない。toggleは`aria-expanded`と`aria-controls`を持ち、折り畳みchevronはpointer hover時だけ表示する。keyboard操作ではaffordanceを失わないようfocus-visible時にも表示し、`Enter`または`Space`で同じ開閉を行う。展開状態は永続化せず、画面を再mountすると全groupを展開する。折り畳み中だけheading右端に対象workspaceの数値件数を表示し、0件も`0`として省略しない。読み上げ名には展開状態にかかわらず同じ件数を1回だけ含める。

workspace navigation contentは242.25pxを上限として、右端の件数とchevronを255.04px sidebar内へ収める。`pnpm exec vitest run src/features/workspace-view/WorkspaceShell.test.tsx --fileParallelism=false -t "expands lifecycle groups by default and toggles them independently"`で初期展開、独立開閉、1件・0件表示、ARIA、content幅を検証する。

sidebar typographyは、`Workspaces` headingを14px / 600 / 21px、lifecycle statusを12px / 600 / 18px、branch titleを13px / 500 / 19.5px、GitHub repository full nameを11px / 400 / 16.5px、filter 0件helperを12px / 400 / 18pxとする。workspace selectionでfont weightと文字幅を変えず、selected backgroundとstrong textだけを切り替える。health metadataは11px / 500 / 16.5pxを維持する。

`text-sidebar-*`のsize roleと`text-*` colorを同じ`cn` / Tailwind mergeへ渡すとsize roleが競合classとして除去されるため、両classをmergeしないかmerge設定を明示する。`pnpm exec vitest run src/features/workspace-view/WorkspaceShell.test.tsx --fileParallelism=false -t "uses branch titles and GitHub repository metadata with stable typography"`でbranch/repositoryの表示順、role classの保持、selection時の安定性を検証する。

attentionはlifecycleを変更せず、`Needs answer / Approval required / Test failed / High risk`のicon、text、countをitem右端へ付ける。active itemだけ`selected-row`、strong text、branch violet iconを使う。itemの第一行はbranchまたはdetached HEAD短縮SHA、第二行はGitHub `origin`から抽出した`owner/repo`とし、GitHub `origin`がない場合はlocal repo名へfallbackする。remote URL自体やcredentialはWebView、DB、logへ渡さない。repo/branchは一行ellipsis + tooltipとする。

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

workspace cancel、project登録解除、active-turn切替の確認dialogは安全な`戻る / Back`を初期focusとし、focusをdialog内にtrapする。`Escape`は`戻る`と同じで、selection、turn、lifecycle、draft、timeline anchor、caption/TTS、Git fingerprintを変更せず、閉じた後は起点controlへfocusを戻す。成功後は次のvalid workspace item、存在しなければempty CTAへfocusする。processingはpolite、失敗はassertive live regionへ1回だけ通知する。

## 表示状態

| 状態 | 進入条件 | 表示 | 操作可否 | 状態から抜ける条件 |
|---|---|---|---|---|
| 初期化中 | DB、workspace、Git linkageを読込中 | sidebar/list/project surfaceのskeleton、locale、Quit。demo workspaceを表示しない | Quitだけ。add/create/select/draft/context/deleteを開始しない | queryとmigrationがterminalになる |
| 通常 | 1件以上のvalid workspace | group list、active project、preflight、primary action 1件 | filter、select、add、create、state action | 操作開始、offline、error |
| projectなし | registered project 0件 | 理由、`Projectを追加`、shortcut。空gridは出さない | picker、Settings、Quit | project登録またはrehydrate |
| workspaceなし | registered project 1件以上、workspace 0件 | project登録済みの説明、`Workspaceを作成`、project追加 | create dialog、Settings、Quit | worktree作成またはproject登録解除 |
| 処理中 | picker後検証、preflight、create、cancel、remove | 対象stepとprogress、他workspaceは利用可能 | 可能なCancel、影響外select | success、cancel、error |
| オフライン | network/Codex接続なし | local list、Git/DB status、Codex offline | filter、Context、local project操作可。Send不可 | 明示preflight成功 |
| エラー | Git I/O、DB write、Codex診断失敗 | code、対象、保持data、retry/reselect/details | 影響外workspaceを開ける | 明示回復または登録解除 |
| 権限不足 | selected rootまたは`.git` read不可 | 拒否pathはbasenameだけ、OS権限案内、再選択 | 再選択、Settings、Quit | permission変更後の再診断 |
| キャンセル後 | picker/create/remove確認をcancel | 開始前の一覧、selection、input、fingerprint | 元操作または別操作 | 次の明示操作 |
| 再起動復旧 | crash、missing repo、migration rollback | active selection、Interrupted badge、last summary、timeline anchor、repository health、Missing/Recovery | reselect、open read-only、diagnostic、remove | linkage/preflight成功 |
| native読込失敗 | DB open、contract、復元taskがterminal error | demo dataを使わないempty recovery surface、sanitized error code、再試行案内 | Retry、Settings、Quitだけ | native queryが成功する |
| filter 0件 | queryに一致するworkspaceなし | queryと`Filterを解除` | query変更、clear | 1件以上一致 |
| active execution競合 | active/pending turnを持つworkspaceから別workspaceを選択または別workspaceでSend | 新selectionを保留し、old workspaceをactive表示したまま`停止して切替 / Stop and Switch`、`戻る / Back`だけを表示 | 二つの明示操作だけ | exact old turnのterminal interruptとcleanup完了、またはBack |
| repository repair | healthが`missing` / `changed` / `unreadable` | picker、identity照合、atomic updateのstepとCancel | Cancel、影響外workspace選択 | exact identity一致またはtyped error |

## 操作

| 操作 | 事前条件 | 正常結果 | キャンセル時 | 失敗時 | 関連要件ID |
|---|---|---|---|---|---|
| Projectを追加 | FolderPlusまたはempty CTA | native pickerの1 directoryをRust診断し、validならprojectだけを1件追加。workspaceは作成しない | 一覧とselection維持、errorなし | 登録せず原因と再選択 | `WORK-F-044`〜`WORK-F-049` |
| preflight再診断 | project rootが存在 | Git/Codex/login/Sol/characterを更新 | 非該当 | check単位でBlocked、既存履歴維持 | `WORK-F-048`, `CODE-F-051`, `CODE-F-075` |
| Workspace作成 | registered project 1件以上、project/name valid | 選択projectの現在HEADからapp-owned root配下へ新branchとworktreeを作り、成功後だけBacklogへ1件追加して選択する | dialog入力を破棄し一覧・filesystemを維持 | 入力保持、field error。Git/DBの片方だけを残さずrollback | `WORK-F-050` |
| workspaceをArchive | sidebar rowのArchive、active/pending turnなし | 確認後、対象worktreeを削除してrowを一覧から外す。既にworktreeが消失済みなら成功扱い | workspace、worktree、selection不変 | 対象以外を変更せず、再試行可能なerror | `WORK-F-067` |
| filter | query 0〜200文字 | repo/branch/nameの部分一致を100ms以内に表示 | Escapeで直前query維持 | 一覧維持、境界表示 | `WORK-F-051` |
| workspace選択 | itemがMissing以外、別workspaceにactive/pending turnなし | header、Chat、Commit、Context、Companionを同一IDへ100ms以内にatomic切替 | 非該当 | 元workspace維持 | `WORK-F-052`, `WORK-F-054`, `WORK-F-059` |
| active turn中のworkspace切替 | active/pending turnを持つold workspaceから別workspaceを選択または別workspaceでSend | selectionを保留し確認。`停止して切替`後、exact old turnのterminal interruptとcleanup完了時だけnew workspaceをactivateし、固有draft/summary/anchorを復元 | `戻る`でold selection、turn、draft、anchor、caption/TTSを完全維持 | old workspaceをactiveのままerrorとRetryを表示。rapid/duplicate/stale responseでnew workspaceをactivateしない | `WORK-F-058`, `WORK-F-059` |
| workspaceをCanceledへ移動 | idle、またはactive/pending turnを停止可能 | idleは確認後、activeは`停止してキャンセル / Stop and Cancel`後のexact terminal interrupt、cleanup、履歴flush完了時だけ専用native cancel commandでCanceled groupへ移動 | `戻る`でselection、turn、lifecycle、draft、caption/TTS、Git fingerprint不変 | generic lifecycle commandのCanceled指定を含めて拒否し、元groupとturnを維持してretry。source、working tree、Git index/object/ref、履歴本文を変更しない | `WORK-F-056` |
| project登録解除 | App Settings Projects、対象project配下のactive/pending turn 0件 | project名を示す確認後、project/workspaceのapp registrationをnavigationから外す | DB/repo/worktree/file/library/history本文不変 | 完了表示せずretry。running時は拒否 | `WORK-F-057`, `WORK-F-068` |
| repository再選択・Repair | `missing` / `changed` / `unreadable`、保存済み`RepositoryIdentityV1`あり | picker後・mutation前・activation直前・DB直前にlive identityを再検査し、対象Project IDの保存identityとexact一致した時だけcompare-and-swapでlinkageを更新してworkspace ID、history、Context、draft、summary、anchorを維持 | linkage、selection、health維持 | same-path replacement、TOCTOU、identity不一致、権限、I/Oは候補を保存せず新規project追加を案内。source、working tree、Git index/object/refを変更しない | `WORK-F-062`, `WORK-F-066` |
| repository再確認 | window focus、workspace選択確定、Send直前 | identity、HEAD、branch、readability、writeabilityをread-only照合しsnapshot更新 | 非該当 | stale warningと回復操作を表示しSendを開始しない | `WORK-F-061`, `WORK-F-066` |

## 入力項目

| 項目 | 初期値 | 必須 | 制約・境界 | エラー表示 | 保存契機 |
|---|---|---|---|---|---|
| repository folder | なし | project追加時必須 | regular Git worktree、canonical path、duplicate不可 | itemを作らず再選択 | 全preflight transaction成功 |
| project | project 1件なら自動選択、複数なら直前値または先頭 | 必須 | registered Project IDのselect | field直下、入力保持 | Create成功 |
| workspace name | `workspace-YYYYMMDD-HHmmss-<random>` | 必須 | trim後1〜80 Unicode scalar、改行不可。path/branchはnativeが安全な別名を生成 | field直下、入力保持 | Create成功 |
| filter query | 前回値 | 任意 | 0〜200 Unicode scalar、case-insensitive | query維持、検索未実行 | debounce後workspace単位 |

## ネイティブ連携

実際のCapability設定は`src-tauri/capabilities/`を正本とする。

GitHub repository補助表示はnetwork APIを呼ばず、`src-tauri/src/codex/workspace.rs`がtrusted worktreeで`git config --get remote.origin.url`をread-only実行し、`github.com`のHTTPS / SSH / SCP形式だけを`owner/repo`へ正規化する。remote URL全体とcredentialは破棄し、nullableな`projects.github_repository`（workspace history DB migration 6）だけを保存する。HEADとremoteのGit processは同時観測し、20 repositoryの起動復元を5秒未満に保つ。`src/features/workspace-persistence/adapter.ts`がこの値をoptionalなview metadataへ変換し、値がない場合は`WorkspaceSidebar.tsx`がlocal repository aliasへfallbackする。parser、Git読取、migration、cross-language contractを変更した場合は`cargo test github_repository`、`cargo test repository_identity_reads_github_origin_without_network_access`、`cargo test legacy_versions_migrate_resume_state_and_registration_columns`、`cargo test serialized_contracts_match_the_cross_language_fixture`、`cargo test startup_restore_of_twenty_repositories_stays_within_the_budget`を実行する。

| ユーザー操作 | 実行境界 | Tauri plugin / Command | 必要なCapability・認可 | キャンセル時 | 拒否・失敗時 |
|---|---|---|---|---|---|
| project folder選択 | Tauri dialog → Rust | `select_project_root`（設計名） | directory picker 1件、選択rootのread診断 | 変更なし | path非表示のerror code |
| Git preflight | Rust child process | `diagnose_project` | canonical root、read-only allowlist Git command | running checkをsafe abort | check別Blocked |
| Codex preflight | Rust supervisor | `diagnose_codex` | executable/stdio capability、auth内容非読取 | 前回結果維持 | failure stageを表示 |
| create/select | Rust Git process + DB + Codex supervisor | `create/select_workspace` | typed Project ID/workspace name、app-owned worktree root、固定Git引数、expected generation | worktree/DBを作らない | partial worktree/DBをrollbackし、元selection/turn/lifecycle維持 |
| workspace Archive | Rust Git process + DB | `workspace_archive` | typed workspace ID、app-owned root containment、固定`git worktree remove --force`。missing targetは成功扱い | 変更なし | 他worktree/project/refを変更しない |
| workspace cancel | Rust DB + Codex supervisor | `workspace_cancel` | typed workspace ID、expected DB version。supervisor gateはactive/pending turnとcancel中のturn開始をatomicに拒否し、active cancelはexact terminal、cleanup、履歴flush proof後だけ呼ぶ | transaction前なら変更なし | `workspace_update_lifecycle`によるCanceled指定を拒否し、元selection/turn/lifecycle維持 |
| active workspace切替 | Rust supervisor + DB | `interrupt_and_switch_workspace` | old workspace/thread/turn/generation、pending selection、terminal cleanup proof | old workspaceの全state維持 | old workspaceをactiveのままerror |
| repository repair | Tauri dialog → Rust project service | `repair_project_linkage` | target Project ID、saved `RepositoryIdentityV1`、canonical worktree exact identity、atomic transaction | linkage/selection不変 | source/Gitを変更せずtyped reason |
| project登録解除 | Rust DB | `unregister_project` | typed Project ID、active/pending turn 0件、confirmation、metadata scope | 変更なし | source/Git/worktree/library/history本文を変更しない |

## ウィンドウ固有動作

| 項目 | 動作 |
|---|---|
| 生成・再利用 | `main`の既存sidebarとproject surfaceを再利用 |
| 初期サイズ・最小サイズ | 共通の1470×836 / 960×640 |
| リサイズ | 960〜1279pxで64px rail + portal drawer。main formは最大760px |
| 最大化・全画面 | 共通仕様どおり |
| 常に手前へ表示 | 不可 |
| 閉じる操作 | 共通仕様どおり |
| 未保存変更がある場合 | create inputはdialog cancel/route離脱で破棄、既存workspace draftは保存 |

## メニュー・ショートカット

| 操作 | macOS | Windows / Linux | 有効条件 | 実行結果 |
|---|---|---|---|---|
| filterへfocus | `Command+K` | 非対応 | destructive dialogなし | drawerを開きqueryへfocus |
| project追加 | toolbar/empty CTA | 非対応 | picker未起動 | native pickerを1回開く |
| workspace開く | `Enter` | 非対応 | item focus、Missing以外 | S-002へ移動 |
| drawer/menuを閉じる | `Escape` | 非対応 | non-destructive overlay | 入力維持、triggerへfocus |

## データ保持

| データ | 正本・保存先 | 保存契機 | 復元契機 | 破棄条件 | 失敗時 |
|---|---|---|---|---|---|
| project canonical path/metadata | Rust SQLiteの目的限定project linkage | registration transaction | cold start |明示登録解除 | 前回transaction維持 |
| workspace worktree linkage/lifecycle/attention | Rust SQLite + normalized event。worktree pathはapp-private | worktree作成成功後のtransaction、valid state transition | cold start/route return | workspace Archive | stale表示 |
| active selection/filter/scroll | Rust SQLite | valid selection/query/scroll settle | route return/restart | Reset UI state | safe default + notice |
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
| `WORK-F-044`〜`WORK-F-066` | project追加、preflight、workspace lifecycle、active-turn confirmation、repository health/repair、persistence、native初期化境界 | [workspace-sessions](../requirements/workspace-sessions.md) |
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
