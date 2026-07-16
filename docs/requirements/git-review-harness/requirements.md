---
title: "Gitレビュー支援 要件定義"
description: "CodexのGit・command・test・review結果を変更判断から分離して収集し、read-only evidenceとして再表示する要件。"
updated: 2026-07-16
last_verified: 2026-07-16
status: "Draft"
prefix: "GIT"
read_when:
  - "Codex turnのGit操作、diff、test、review、checkpointの証跡を実装または検証するとき。"
  - "Git状態の競合、秘密情報のredaction、最終evidence表示、組込みskillとの境界を確認するとき。"
---
# Gitレビュー支援 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `GIT` |
| 状態 | Draft |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-16 |
| 最終レビュー日 | 未レビュー |

## 背景

Full accessのCodexはfile変更、test、commit、remote操作まで実行できるが、desktop shellが完了条件やGit outcomeを決めるとユーザー指示とSolの判断を上書きする。ハッカソン版では操作主体と証跡収集を分離し、作業を止める承認gateではなく、後から検証できる構造化evidenceを提供する。

### 用語

| 用語 | 定義 |
|---|---|
| Git outcome | commit、push、PR作成、merge、revert、reset、branch作成・切替・削除の結果。 |
| collector | Git状態、diff統計、command・test eventを読み取り、worktreeとGitを変更しないRust側の収集処理。 |
| evidence snapshot | sessionの特定時点について、HEAD、branch、dirty fingerprint、command、test、reviewへの参照を固定した構造化record。 |
| final evidence | 最新snapshotまでの目的、変更、検証、review、commit、残課題をS-003で再表示するread-onlyなまとめ。 |
| dirty fingerprint | HEAD、index、tracked変更、untracked fileのrelative path・種別・内容hashから算出する識別値。file内容そのものは含めない。 |

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| 操作判断と証跡を分離する | desktop shellがGit outcomeを自動決定せず、ユーザー指示を受けたSolの操作とcollectorの読取操作をactor別に確認できる。 |
| 変更と検証を追跡可能にする | branch、HEAD、dirty状態、diff統計、command、test、review、commitを同じsession evidenceとしてS-003で再表示できる。 |
| 支援を非強制にする | 組込みskill、Detached Reviewer、Checkpoint Curatorがtriggerに応じて利用され、未適用または失敗でもmainを継続できる。 |
| 競合と秘密漏えいを防ぐ | 共有worktreeの書込前照合とGit排他lockを適用し、秘密値とsource本文を永続evidenceから除外できる。 |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| Git状態 | branch、HEAD、detached、履歴操作中、staged・unstaged・untracked、commit変化を構造化する。 |
| diff evidence | file状態、binary判定、追加・削除行数、hash、大規模diffの縮退結果を保存する。 |
| 実行evidence | App Serverから観測したcommand、test、Git operationのactor、分類、status、時間、結果を保存する。 |
| review支援 | 組込みskillの適用状況、Detached Reviewerのfinding、Checkpoint Curatorのsummaryをsnapshotへ関連付ける。 |
| 完了時収集 | main turn終了時とsession終了要求時にread-only snapshotを作り、承認待ちにせずS-003へ表示する。 |
| 競合・復旧 | support要件のfingerprint、session lock、stale判定を共有し、再起動後にevidence indexを復元する。 |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| desktop shellによる自動commit、push、PR作成、merge、revert | Git outcomeはユーザー指示とSolの判断へ委ねるため | [codex-main-session要件](../codex-main-session/requirements.md) |
| 自動reset、stash、clean、checkout、rollback | 既存変更を推測で変えないため | Solへの明示指示または外部Git操作 |
| 固定されたskill順、全turnでのreview強制、最終承認gate | 対話とtriggerに基づく支援へ限定するため | [support-agent-orchestration要件](../support-agent-orchestration/requirements.md) |
| Git hosting APIによるPR・issue・review投稿 | local evidenceの統合を期限内に優先するため | ハッカソン後 |
| source patch、raw command出力、raw model responseの長期保存 | 秘密とcode本文を構造化履歴へ残さないため | current worktreeとCodex側の履歴 |
| Git client相当の履歴編集UI | chat中心の体験と証跡表示へ範囲を限定するため | 外部Git clientまたはSolへの指示 |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ユーザー | Git outcomeの意図をmainへ伝える利用者 | prompt、evidence閲覧・filter・copy、再収集要求 | UIから直接Git変更する操作は提供しない |
| main agent（Sol） | ユーザー指示と現在状態から作業を判断する主体 | Full accessのtool操作、skill選択、support依頼、結果説明 | lock・fingerprint・固定session境界に違反する操作は失敗として受け取る |
| support agent | QA、Detached Reviewer、Checkpoint Curatorを含む支援主体 | role契約内の検証、review、summary | outcome決定、ユーザー質問、競合書込を拒否する |
| Rust collector | App Server event、Git、SQLiteの信頼境界 | read-only収集、分類、redaction、lock調停、保存 | 不正相関、秘密、staleな結果を永続正本へ採用しない |
| React WebView | evidenceを表示する非特権UI | session内のfilter、選択、copy要求 | 任意shell、Git argument、absolute path、raw SQLite queryを拒否する |

## 機能要件

### Git outcomeと完了時snapshotの境界

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| GIT-F-001 | desktop shellはturnまたはsessionの状態変化を契機にGit outcomeを自動実行しない。 | main turnの完了・失敗・中断、AskUserQuestion回答、archive、Quitの各fixtureで、shell actorからcommit、push、PR作成、merge、revert、reset、stash、clean、checkoutが0件である。 | Draft | 非該当 |
| GIT-F-002 | ユーザー指示を受けたmain turnが実行したGit outcomeを別actorとして記録する。 | 操作ごとにmain turn ID、Git operation分類、開始・終了UTC、exit分類、変更前後HEADを保存し、shell collectorの操作と区別してS-003へ表示する。 | Draft | 非該当 |
| GIT-F-003 | Git outcomeの実行可否と成功判定をアプリの完了条件にしない。 | commit・push・PR・mergeが0件のmain turnもterminal statusへ遷移し、S-002のprompt入力が承認待ちまたはcommit待ちで無効化されない。 | Draft | 非該当 |
| GIT-F-004 | main turnが完了、失敗、中断のいずれかへ遷移したときread-only evidence snapshotを1件作る。 | terminal eventから2秒以内にsnapshotを`collecting`として表示し、collectorがGit変更commandを発行せず、成功時に同じturn IDのsnapshotを`complete`へ遷移させる。 | Draft | 非該当 |
| GIT-F-005 | sessionのarchive、cleanup、明示Quit要求時にfinal evidenceを更新する。 | 最新terminal turn以後のGit状態があればsnapshotを追加し、2秒以内に完了しない場合もsession操作を止めず`incomplete`と未収集範囲を保存する。 | Draft | 非該当 |
| GIT-F-006 | snapshot収集失敗でmain sessionを停止しない。 | Git・I/O・parse失敗では対象snapshotを`incomplete`にし、短いerror code、欠落区分、再収集可否を表示してmainの新規turnを許可する。 | Draft | 非該当 |
| GIT-F-007 | 同じtriggerからのsnapshot作成を冪等にする。 | session ID、trigger種別、trigger IDの組が同じeventを再受信してもsnapshot recordが1件だけで、既存recordのterminal statusだけが更新される。 | Draft | 非該当 |
| GIT-F-008 | final evidenceはread-only表示であり承認要求を作成しない。 | S-003の表示、再収集、copyを行ってもAskUserQuestion、tool approval、Git command、support assignmentが自動作成されない。 | Draft | 非該当 |

### 組込みskillとsupport review

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| GIT-F-009 | 組込みskillをeffective Codex catalogへ追加し、dialogueとskill自身のtriggerから選択できる状態にする。 | S-004で各組込みskillのname、source、enabled、trigger概要、load statusを確認でき、明示Skill入力またはCodexのtrigger判断でだけ実行される。 | Draft | 非該当 |
| GIT-F-010 | アプリは組込みskillへ固定実行順を設定しない。 | skill利用eventがないturnではskill assignmentが0件で、複数skillが適用されるturnでもアプリ定義の全体順queueまたは必須先行skillが存在しない。 | Draft | 非該当 |
| GIT-F-011 | skillの未適用をmain turnの失敗として扱わない。 | terminal turnにskill eventが0件の場合、final evidenceへ`skill evidenceなし`と表示し、warning、承認gate、自動再実行を作成しない。 | Draft | 非該当 |
| GIT-F-012 | skillのloadまたは実行失敗を対象支援だけの縮退として扱う。 | skill name、`load_failed`または`execution_failed`、短い理由、代替を記録し、main turnをskill失敗だけで中断せず、raw skill input・outputを保存しない。 | Draft | 非該当 |
| GIT-F-013 | Detached Reviewerを固定snapshotに対する独立reviewとして関連付けられる。 | Solまたはskill triggerで起動した場合、review開始時のHEADとdirty fingerprint、findingのseverity、relative file、line、再現条件、evidence refs、または`no_findings`を同じsnapshotへ保存する。 | Draft | 非該当 |
| GIT-F-014 | Detached Reviewerの結果をGit outcomeまたは完了gateへ変換しない。 | blocker findingが存在してもアプリがfile変更、commit取消、revert、main interrupt、承認要求を実行せず、Solが結果を採否できるadvisory表示になる。 | Draft | 非該当 |
| GIT-F-015 | Checkpoint Curatorの構造化summaryをevidenceへ関連付けられる。 | roleが実行された場合、目的、変更区分、影響、検証、commit参照、review参照、残課題を保存し、Git・testの元recordを変更せずS-003で参照できる。 | Draft | 非該当 |
| GIT-F-016 | ReviewerまたはCuratorの失敗でmainを停止しない。 | roleが`failed`、`interrupted`、`unavailable`、`stale`でもfinal evidenceを`支援未完了`として作成し、main statusとGit状態を変更せず再試行可否を表示する。 | Draft | 非該当 |

### Git状態とdiff evidence

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| GIT-F-017 | collectorはsession worktreeが同じGit repositoryへ属することを収集前に検証する。 | canonical worktree、Git common directory、session IDが保存値と一致する場合だけ収集し、不在、非Git、別repository、読取不能ではGit commandを追加実行せず`git_context_unavailable`にする。 | Draft | 非該当 |
| GIT-F-018 | snapshotへ現在branch、HEAD、base、upstream有無を保存する。 | attached時はbranch名と40桁commit ID、detached時は`detached`とcommit ID、unborn時は`unborn`を記録し、存在しないupstreamを推測しない。 | Draft | 非該当 |
| GIT-F-019 | dirty状態をstaged、unstaged、untrackedへ分けて保存する。 | 各区分のfile数、canonical relative path、change種別、内容SHA-256を記録し、ignored fileとabsolute pathを含めず、0件は明示的に0と表示する。 | Draft | 非該当 |
| GIT-F-020 | merge、rebase、cherry-pick、revert、bisect中の状態をsnapshotへ記録する。 | 検出したoperation名を列挙して`operation_in_progress`を表示し、collectorがcontinue、abort、commit、checkoutを実行せずread-only evidenceの収集だけを行う。 | Draft | 非該当 |
| GIT-F-021 | snapshot収集中のbranchまたはHEAD外部変更をstaleとして扱う。 | 収集前後のbranch・HEADが異なる場合は結果を採用せず1回だけ再収集し、再度変化した場合は`git_state_changed`と両revisionを保存して`incomplete`にする。 | Draft | 非該当 |
| GIT-F-022 | diff evidenceをbase、HEAD、index、worktreeの比較対象ごとに分離する。 | diff evidence ID、snapshot ID、生成UTC、比較元・先revision、staged・unstaged区分、file status、rename元・先、追加・削除行数を記録し、比較対象が解決できない区分を`unavailable`にする。 | Draft | 非該当 |
| GIT-F-023 | binary fileのdiffは本文を取得・保存せずmetadataだけを記録する。 | binary判定されたfileはrelative path、change種別、変更前後byte数、変更前後hash、`binary`を保存し、line統計とpatch本文を空にする。 | Draft | 非該当 |
| GIT-F-024 | 大規模diffを境界付きsummaryへ縮退する。 | 変更fileが500件超、または一時生成したtext patchが5 MiB超のどちらかで`large_diff`と実数を表示し、全体統計、relative path順の先頭500件、未表示件数だけを保存してpatch生成を打ち切る。 | Draft | 非該当 |
| GIT-F-025 | untracked fileをdiff統計へ含めるが内容を永続化しない。 | untrackedごとにrelative path、byte数、binary/text、SHA-256を保存し、directoryは配下の通常fileへ展開し、symbolic linkはlink自体のhashだけを扱い参照先を読まない。 | Draft | 非該当 |
| GIT-F-026 | source patchをSQLite、Web Storage、永続logへ保存しない。 | text diffを収集処理中のmemoryで破棄し、永続recordにはfile参照、hash、line統計、hunk数だけがあり、再起動後にsource行を復元できない。 | Draft | 非該当 |

### command、test、commit evidence

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| GIT-F-027 | App Serverのcommand eventをthread、turn、item、actorへ相関して記録する。 | command evidence ID、thread/turn/item ID、main/support/collector actor、command分類、開始・終了UTC、duration、exit codeまたはsignal、terminal status、result summaryを保存する。 | Draft | 非該当 |
| GIT-F-028 | command全文とraw stdout・stderrを永続evidenceへ保存しない。 | GIT-F-027のfieldに加え、allowlist済みexecutable、argument数・redacted summary、workspace-relative cwd、output digestを持ち、API key、token、credential、環境変数値、absolute path、source本文を含まない。 | Draft | 非該当 |
| GIT-F-029 | test commandの観測結果をtest evidenceとして分類する。 | test/command evidence ID、framework、対象summary、開始・終了UTC、exit、duration、terminal status、parseできたpass・fail・skip件数、未parse時の`counts_unavailable`を保存し、exitを観測できない実行を合格にしない。 | Draft | 非該当 |
| GIT-F-030 | 中断、timeout、process crashしたtestを合格として扱わない。 | 各状態を`interrupted`、`timed_out`、`process_failed`で保存し、合格数を推測せず、S-002とS-003へ未検証範囲とユーザー操作による再実行案内を表示する。 | Draft | 非該当 |
| GIT-F-031 | commit変化をsnapshot間のevidenceとして保存する。 | 新しいreachable commitごとにcommit evidence ID、session ID、40桁commit ID、parent ID、redacted subject、前後branch、観測したmain turn ID・UTCを保存し、author email、署名payload、diff本文を保存しない。 | Draft | 非該当 |
| GIT-F-032 | branch、tag、remote-tracking refの変化をactor不明のまま推測しない。 | App Server eventへ相関できる変化だけをmain/support actorへ結び付け、外部変更は`external_or_unknown`としてref種別、前後object ID、検出UTCを記録する。 | Draft | 非該当 |
| GIT-F-033 | push、fetch、PR作成、mergeの結果を観測できた範囲で分類する。 | command eventからoperation種別、remote名またはprovider種別、exit分類、request参照を保存し、remote URL、credential、PR本文、応答本文を保存せず、未観測結果を成功にしない。 | Draft | 非該当 |
| GIT-F-034 | evidence間の参照切れを表示する。 | command、test、review、commitの参照先が欠落または削除済みならsnapshotを削除せず`HIST_EVIDENCE_MISSING`、対象ID、影響する区分を表示する。 | Draft | 非該当 |

### 共有worktree、秘密、再開

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| GIT-F-035 | mainまたはsupportによるGit index、branch、commit、worktree変更をsession exclusive lockで直列化する。 | [SUP-F-042〜SUP-F-044](../support-agent-orchestration/requirements.md#同一worktreeの競合制御)と同じlock owner・30秒timeout・crash recoveryを使い、同じsessionで変更Git processが同時に2件起動しない。 | Draft | 非該当 |
| GIT-F-036 | supportまたはskillのfile書込へbase fingerprint再照合を適用する。 | [SUP-F-038〜SUP-F-041](../support-agent-orchestration/requirements.md#同一worktreeの競合制御)と同じrelative path・SHA-256を使用し、不一致時は上書きせず`write_conflict` evidenceをmainへ返す。 | Draft | 非該当 |
| GIT-F-037 | collectorのread-only Git操作はsession exclusive lockを取得せずsnapshot整合性で競合を検出する。 | `status`、`diff --no-ext-diff --no-textconv`、`rev-parse`相当の収集中に変更operationを妨げず、GIT-F-021の前後照合でstaleを検出し、external diff、index、refs、worktree fileを変更しない。 | Draft | 非該当 |
| GIT-F-038 | secret redactionを保存、表示、診断copyの前にRust側で行う。 | fixtureのAPI key、access token、cookie、authorization header、credential付きURL、secret環境変数、secret質問回答が各出力へ0件で、置換後のtypeと短いerror codeだけを確認できる。 | Draft | 非該当 |
| GIT-F-039 | evidence保存をSQLite transactionで原子的に行う。 | snapshot本体と参照recordが全件commitされるか全件rollbackされ、クラッシュ注入後に部分snapshotを`complete`として表示しない。 | Draft | 非該当 |
| GIT-F-040 | アプリ再起動時に保存済みevidence indexを復元する。 | session、turn、snapshot、command、test、review、commitのID対応を再構築し、同じfilter結果とfinal evidenceを表示してcollector command、test、reviewを自動再実行しない。 | Draft | 非該当 |
| GIT-F-041 | 収集中のクラッシュまたはQuitを未完了として復元する。 | terminal statusのないsnapshotを`予期しない中断`または`アプリ終了により中断`へ変え、保存済みrecordを保持し、ユーザーが`再収集`を実行するまで追加Git読取を行わない。 | Draft | 非該当 |
| GIT-F-042 | 再収集時に現在revisionと元snapshotを混同しない。 | 新しいsnapshot ID、現在HEAD、dirty fingerprint、再収集元IDを保存し、元snapshotを上書きせず、revision差分がある場合は`current state`として別表示する。 | Draft | 非該当 |

## 入力項目要件

Git outcomeを直接実行するbutton、Git argument入力、commit message入力は提供しない。Git操作の意図は[Codexメインセッション要件](../codex-main-session/requirements.md)のturn入力としてSolへ伝える。

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| evidence filter | 種別 | すべて | 任意 | snapshot、command、test、review、commit、Git状態の複数選択 | 未知値を無視せずfilterを適用しない |
| evidence filter | 期間 | session全体 | 任意 | 保存済みeventの最古〜最新、開始UTCは終了UTC以下 | 入力を保持し境界を表示する |
| evidence filter | status | すべて | 任意 | complete、incomplete、failed、interrupted、stale | 未知値を拒否する |
| snapshot | 再収集 | 未選択 | 任意 | activeまたはarchivedでworktreeが読取可能なsessionだけ | 現在状態を変えず理由を表示する |
| copy | evidence summary | 未選択 | 任意 | 選択snapshotの秘匿化済みtextだけ | clipboard失敗時は元表示を維持する |

### snapshot収集デシジョンテーブル

| Git状態 | diff境界 | 結果 |
|---|---|---|
| worktree不在、非Git、別repository、読取不能 | 任意 | `git_context_unavailable`でincomplete。Git操作を追加実行しない |
| attachedまたはdetached | 通常 | 状態を明記してsnapshotを作る。detachedを自動修復しない |
| 履歴操作中 | 通常 | operation名を付けてsnapshotを作る。continue、abort、commitしない |
| 任意 | binary | metadataだけを保存する |
| 任意 | 500 file超またはtext patch 5 MiB超 | `large_diff` summaryへ縮退する |
| 収集中にbranchまたはHEAD変化 | 任意 | 1回再収集し、再変化ならincompleteにする |

## デスクトップ固有要件

[デスクトップ共通仕様](../../screen-design/desktop-common-specification.md)との差分だけを次に定義する。

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | macOS実機でGit状態、3 session並行収集、review表示をE2E検証する。Windows・Ubuntu CIでpath separator、process status、SQLite復元、redactionを検証する。 | GIT-F-004〜GIT-F-042 |
| ウィンドウ生成・再利用 | 共通`main`のS-002とS-003を再利用し、review・diff・test用の追加windowを作らない。 | GIT-F-008〜GIT-F-016 |
| 閉じる・アプリ終了 | window closeでは収集を継続する。明示QuitはGIT-F-005の2秒境界後に共通終了処理を続行し、collector完了を待つ承認gateを作らない。 | GIT-F-004〜GIT-F-008、GIT-F-041 |
| 未保存データ | source patchとraw outputは保存せず、dirty fileはworktree、構造化evidenceはSQLiteを正本とする。 | GIT-F-019〜GIT-F-028、GIT-F-039 |
| ローカルデータ | snapshotと参照recordをSQLiteへ保存し、Git実体とsource fileは複製しない。 | GIT-F-026〜GIT-F-034、GIT-F-039〜GIT-F-042 |
| オフライン | 保存済みevidenceを閲覧・filter・copyできる。remote操作の成功を推測せず、再収集はlocal Gitだけを対象にする。 | GIT-F-033、GIT-F-040、GIT-F-042 |
| ファイル・OS操作 | collectorはsession IDからRust側でworktreeを再解決し、read-only Git引数だけをallowlistする。clipboardは秘匿化summaryのcopyに限る。 | GIT-F-017〜GIT-F-026、GIT-F-038 |
| メニュー・ショートカット | Git outcome用menuとglobal shortcutは追加しない。filter、再収集、copyは画面詳細仕様のkeyboard操作に従う。 | GIT-F-001〜GIT-F-003、GIT-F-040〜GIT-F-042 |
| Deep Link・ファイル関連付け | 非該当: evidence ID、repository、patchを外部入力から開かない。 | GIT-F-008 |
| 通知 | evidence、test、review、commit、skillの状態変化ではOS通知を送らない。回復不能なSQLite失敗だけ共通通知を使用する。 | GIT-F-006、GIT-F-039 |
| Capability・認可 | WebViewへshell、Git argument、absolute path、raw databaseを公開せず、session IDとevidence IDをRust側で照合する。 | GIT-F-017、GIT-F-027〜GIT-F-042 |
| アップデート・互換性 | schema migrationでevidence ID、actor、revision、redaction versionを維持し、旧recordを新分類へ推測変換しない。 | GIT-F-039、GIT-F-040 |

## 画面・UI

画面レイアウト、表示状態、操作フローは各画面詳細仕様を正本とし、この文書では画面IDと要件IDの対応だけを管理する。

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-002` | コーディングワークスペース | GIT-F-002〜GIT-F-016、GIT-F-027〜GIT-F-038 | 変更 | [S-002 コーディングワークスペース](../../screen-design/S-002_coding-workspace.md) |
| `S-003` | セッション証跡 | GIT-F-002〜GIT-F-042 | 新規 | [S-003 セッション証跡](../../screen-design/S-003_session-evidence.md) |
| `S-004` | 設定・診断 | GIT-F-006、GIT-F-009〜GIT-F-012、GIT-F-017、GIT-F-034、GIT-F-038〜GIT-F-041 | 変更 | [S-004 設定・診断](../../screen-design/S-004_settings-diagnostics.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | collectorはallowlist済みread-only Git commandを引数配列で実行し、WebView入力をshellへ渡さない。worktreeへの書込はSUPのfingerprintとlockを経由し、Full accessをsandboxと誤表示しない。 |
| 権限 | evidence閲覧は選択session内に限定し、session・thread・turn・evidence IDをRust側で照合する。Git outcomeを実行するCapabilityをReactへ提供しない。 |
| プライバシー | relative path、hash、統計、秘匿化summaryだけを保存する。secret、absolute path、remote URL、source patch、raw output、raw responseをSQLite、通知、診断copyへ含めない。 |
| 監査・ログ | snapshot、actor、trigger、revision、Git状態、command/test/review/commit参照、status、UTC、error code、redaction versionを保存する。collector自身の失敗も記録する。 |
| 性能 | 8 CPU core・16 GBのmacOS、1,000 file・100 MiBのfixture、変更500 file以下・text patch 5 MiB以下で、model・tool待ちを除くsnapshot収集p95を2秒以下、terminal eventからstatus表示p95を250 ms以下とする。3 session同時収集でも各p95を3秒以下とする。 |
| 信頼性・復旧 | snapshotをtransaction保存し、同一triggerを冪等処理する。stale、収集失敗、支援失敗をmainへ伝播させず、自動Git変更、自動test再実行、自動review再実行を行わない。 |
| アクセシビリティ | keyboardだけでevidence種別・期間・status filter、snapshot選択、再収集、summary copyを実行できる。statusとfinding severityを色だけで伝えない。 |
| 多言語・地域 | UI、summary label、error説明を日本語・英語で提供する。Git ref、commit ID、relative path、canonical ID、error codeは翻訳せず、UTC保存・OS timezone表示とする。 |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) | SQLite、Quit、redaction、Full access、3OS、通知の共通契約を適用する。 | 解決済み | evidenceの安全な保存・復元ができない |
| [workspace-sessions要件](../workspace-sessions/requirements.md) | session専用worktree、branch、archive、cleanup、Git実体検証を提供する。 | Draft間で整合確認予定 | GIT-F-017とsession終了時収集を検証できない |
| [codex-main-session要件](../codex-main-session/requirements.md) | main turn event、ユーザー指示、Skill入力、Git outcome主体を提供する。 | Draft間で整合確認予定 | actorとtriggerを相関できない |
| [support-agent-orchestration要件](../support-agent-orchestration/requirements.md) | Reviewer、Curator、QA、fingerprint、session exclusive lock、stale判定を提供する。 | Draft間で整合確認予定 | GIT-F-013〜GIT-F-016とGIT-F-035〜GIT-F-037を検証できない |
| [activity-history要件](../activity-history/requirements.md) | HIST-F-003、HIST-F-008〜HIST-F-012、HIST-F-014〜HIST-F-021、HIST-F-028〜HIST-F-036で構造化recordの保存、redaction、復元、表示、削除を提供する。 | Draft間で整合済み | 再起動後のS-003表示と削除を検証できない |
| Git executable | session作成時に検証済みのGitでread-only状態とdiffを取得する。 | 解決済み: runtime診断を定義済み | 不在・非対応ならsnapshotをincompleteにする |
| Codex App Server 0.144.5 | command、turn、support、skill eventの相関元とする。 | 解決済み: CODE要件で固定 | event欠落時はactorと実行結果を推測せずincompleteにする |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| なし | 本文のread-only collector、非強制支援、構造化evidence、競合契約でハッカソン版を実装する | 仕様責任者レビューでHISTの保存・削除IDと画面相互参照を確認する | いいえ |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [要件定義基準](../../rules/requirements-definition-standards.md) | 1挙動1ID、受け入れ条件、desktop境界、異常系の記述基準 |
| [ID管理ルール](../../rules/id-management-rules.md) | `GIT` Prefix、要件ID、画面IDの正本 |
| [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) | Git outcome、SQLite、Quit、redaction、Full access、3OS共通契約 |
| [Git公式 git-status](https://git-scm.com/docs/git-status) | staged、unstaged、untracked、branch状態を読取取得する根拠 |
| [Git公式 git-diff](https://git-scm.com/docs/git-diff) | revision、index、worktree、統計、binary diffを比較する根拠 |

外部資料は2026-07-16に確認した。

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Not Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 未合意 |
| 残る非ブロック論点 | 画面詳細仕様完成後の双方向ID確認 |

## 着手可チェック

- [x] 背景と目的が説明できる。
- [x] スコープ内・外と理由が明確である。
- [x] 全機能要件に一意な要件IDがある。
- [x] 全機能要件に検証可能な受け入れ条件がある。
- [x] 正常系、異常系、キャンセル、権限差分、空状態、境界値を確認した。
- [x] デスクトップ固有要件を確認し、非該当も明記した。
- [ ] 画面IDと要件IDの相互参照が一致している。
- [x] 非機能要件と依存関係を確認した。
- [x] 着手ブロックが「はい」または「不明」の未確定事項がない。
- [ ] 仕様責任者がレビューし、合意した。
