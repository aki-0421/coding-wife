---
title: アクティビティ履歴 要件定義
description: workspaceとsessionの再開情報、turn、質問、コマンド、Git、test、modelの構造化証跡をlocal SQLiteへ保存・再表示する要件を定義する。
updated: 2026-07-17
read_when:
  - アクティビティ履歴の保存、検索、削除を実装するとき
  - S-002またはS-003でsession証跡を表示するとき
  - SQLite schema、migration、復旧を変更するとき
---

# アクティビティ履歴 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `HIST` |
| 状態 | Draft |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-16 |
| 最終レビュー日 | 未レビュー |

## 背景

複数sessionと7つのsupport roleが同じworktreeで動くため、再起動後の再開と、ユーザーが作業結果を追跡できる構造化証跡が必要である。一方、会話全文や生のreasoningを複製すると、秘密・コード・個人pathの漏えいと実装範囲が増える。ハッカソン版はlocal SQLiteを正本とし、再開情報と検証可能なeventだけを保持する。

### 用語

| 用語 | 定義 |
|---|---|
| event | workspace、session、turn、質問、command、Git、test、supportの状態変化を表すappend-only record。 |
| evidence | eventから参照するsnapshot、command、diff、commit、test、review、model、support summaryの構造化record。 |
| raw content | user prompt、model response、reasoning、stdout/stderr、file・diff本文、音声byte列。 |
| derived data | 検索index、cache、集計、app-owned evidence file、migration backup。 |

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| 再開 | 再起動後にworkspace、session、main threadを復元し、ユーザー操作で同じsessionを再開できる。 |
| 追跡 | turn、質問、command、diff、commit、model、test、review、support assignmentをS-002とS-003で時系列確認できる。 |
| 秘密保護 | credential、互換性違反の質問・回答・入力内容、生reasoning、コード本文、音声dataがSQLite、index、backupへ入らない。 |
| 復旧 | crash、write失敗、schema migration失敗で完了を捏造せず、元databaseを保護できる。 |
| ユーザー制御 | 自動期限切れなしで保持し、明示削除時はapp-owned派生dataも消去できる。 |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| 保存 | 1つのlocal SQLiteへworkspace、session、main resume、turn、event、evidenceを構造化保存する。 |
| 閲覧 | workspace/session一覧、timeline、詳細、filter、部分一致searchを提供する。 |
| 復旧 | transaction、crash判定、integrity check、schema version、1世代backup、migration rollbackを扱う。 |
| privacy | ingress redaction、path正規化、明示削除、派生data消去を扱う。 |

### 含めない

| 非対象 | 理由 | 扱い |
|---|---|---|
| raw prompt・model response・reasoningの保存 | 秘密保護と期限内実装のため | redacted summaryだけ保存 |
| file・diff本文、patch、raw stdout/stderr | コード複製を避けるため | relative path、件数、hash、結果summaryだけ保存 |
| 生成・再生音声の保存 | 容量とprivacyのため | text eventだけ保存 |
| support thread ID、rollout、生履歴の保存・再開 | supportはephemeral固定のため | assignment summaryだけ保存 |
| 履歴のCSV・JSON・archive export/import | 主要導線を期限内に完成させるため | ハッカソン版にbutton、IPC、CLIを設けない |
| cloud同期、共有、telemetry送信 | local-first境界を守るため | 期限後に再検討 |
| OS snapshot、外部backup、SSDの物理・forensic secure erase | アプリから消去を保証できないため | app-owned DB・WAL・index・cache・backupの論理消去をbest effortで行い、OS/device領域は保証外と表示 |

## アクターと権限

| アクター | 許可する操作 | 拒否時の動作 |
|---|---|---|
| ユーザー | 閲覧、filter、search、session/workspace履歴削除 | 実行中sessionの削除は理由を表示して拒否する |
| main agent | 検証済みevent/evidenceの発生 | SQLite、削除、schemaを直接操作させない |
| support agent | assignment結果とevidence参照の発生 | raw payload、secret、support thread IDを永続化しない |
| Tauri / Rust | redaction、path照合、transaction、migration、query、delete | 不正eventはmodel出力を補完せず拒否する |
| React WebView | redacted view modelの表示とuser操作 | 任意SQL、database path、raw payloadへアクセスさせない |

## 機能要件

### 保存と構造化証跡

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| HIST-F-001 | app-owned履歴の正本をOS application data内の単一SQLite databaseにする。 | writer接続を開くたび`journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、`secure_delete=ON`、`busy_timeout=5000`、`wal_autocheckpoint=1000` pagesを設定・読戻し、一致後だけ履歴を利用可能にする。process再起動後もrecord数と非秘密fieldが一致し、network・Web Storageへ複製しない。 | Draft | 非該当 |
| HIST-F-002 | eventへ一意ID、session内連番、UTC発生時刻を付ける。 | 同一sessionの連番が1から重複・逆転なく増え、同時刻eventも連番順で再表示され、表示時刻だけOS timezoneへ変換される。 | Draft | 非該当 |
| HIST-F-003 | eventを定義済みtypeとstatusへ正規化してappend-only保存する。 | lifecycle、main turn、support、question、command、snapshot、diff、commit、test、review、skill、model、diagnosticを識別でき、状態変更は旧event更新でなく新event追加になる。 | Draft | 非該当 |
| HIST-F-004 | main sessionの再開locatorを保存する。 | workspace/session ID、main root thread ID、last turn ID、branch、canonical worktree、lifecycleを1 transactionで保存し、再起動後も同じ組合せを解決できる。 | Draft | 非該当 |
| HIST-F-005 | supportはassignment summaryだけを保存する。 | assignment ID、role、source、requested/actual model、effort、fallback、status、redacted summary、evidence refs、開始・終了UTCを再表示でき、thread IDとraw contentが0件である。 | Draft | 非該当 |
| HIST-F-006 | 到達可能な非secret AskUserQuestionの質問・回答を保存する。 | 各問がserver提供の2〜3 optionとclient追加の`Other`だけであるrequestについて、request/question ID、質問文、option、選択labelまたは`Other`本文、resolved理由・UTCをredaction後に保存し、再起動後に解決済みとして1回だけ表示する。 | Draft | 非該当 |
| HIST-F-007 | secretまたはfree-form-only AskUserQuestionを互換性違反として記録する。 | `isSecret: true`または`options: null|[]`を受信したとき、request/thread/turn/item ID、protocol method、`-32004`、理由enum、検出・解決UTCだけをprotocol error metadataとして保存する。質問文、question ID、option label/description、回答、入力内容、answered flag、値の長さ・hashはSQLite・index・backup・logに0件である。 | Draft | 非該当 |
| HIST-F-008 | commandの実行証跡を保存する。 | command evidence ID、thread/turn/item ID、actor、分類、executable、argument数・redacted summary、workspace-relative cwd、開始・終了UTC、duration、exit code/signal、terminal status、result summary・output digestを確認でき、stdinとraw stdout/stderrを保存しない。 | Draft | 非該当 |
| HIST-F-009 | diff参照をコード本文なしで保存する。 | diff evidence/snapshot ID、比較元・先revision、Git state fingerprint、staged/unstaged、relative path、file status・rename、file数・追加削除行数、binary/large diff metadata、生成UTCを確認でき、hunk・patch・file本文が0件である。 | Draft | 非該当 |
| HIST-F-010 | commit証跡を保存する。 | commit evidence ID、session ID、40桁commit ID、parent ID、redacted subject、前後branch、観測main turn ID・UTCを確認でき、commit本文、author email、署名payloadを保存しない。 | Draft | 非該当 |
| HIST-F-011 | modelとreasoning effortの実値をownerへ関連付ける。 | main turnまたはsupport assignmentごとにrequested/actual model、actual effort、fallback有無・理由、preset IDを確認できる。 | Draft | 非該当 |
| HIST-F-012 | testと検証evidenceを保存する。 | test/command evidence ID、framework、対象summary、開始・終了UTC、duration、exit、terminal status、pass/fail/skip数または`counts_unavailable`、未検証範囲を確認でき、test output本文を保存しない。 | Draft | 非該当 |
| HIST-F-013 | hidden chain-of-thoughtとraw reasoningを永続化しない。 | main/supportのreasoning eventを含むfixtureで、SQLite全column、FTS、backup、永続logにreasoning本文のmarkerが0件である。 | Draft | 非該当 |
| HIST-F-014 | secretをSQLite transaction前にredactする。 | schemaのsecret field、Authorization/Cookie、key名がpassword/token/secret/api_keyの値、URL userinfo、既知credential fixtureが`<redacted>`またはfield削除になり、元値・hashが全local copyに0件である。 | Draft | 非該当 |
| HIST-F-015 | コード・file本文を永続化しない。 | patch、diff hunk、file content、heredoc、`-c`/`--eval` payload、stdinを除去したcommand summaryだけが残り、fixture markerがSQLite・index・backupに0件である。 | Draft | 非該当 |
| HIST-F-016 | 音声dataを永続化しない。 | TTS request/stream/playback後もencoded audio、PCM、buffer、音声fileがSQLite、cache、backupに0件で、text eventだけが残る。 | Draft | 非該当 |
| HIST-F-017 | pathを所有境界に応じて保存する。 | repository/worktree rootはresume tableだけにcanonical absolute pathで保存し、配下のevent pathはseparatorを`/`にしたrelative path、外部pathは`<outside-workspace-path>`として保存する。 | Draft | 非該当 |
| HIST-F-018 | 表示用textをbounded redacted summaryに限定する。 | titleは256、summary・質問・回答・command summaryは各4,096 Unicode scalar以下で、超過分を保存せず`truncated: true`を表示し、raw prompt/responseは保存しない。 | Draft | 非該当 |

### 再起動、crash、migration

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| HIST-F-019 | 起動時に保存済み履歴をrehydrateする。 | workspace/session一覧、選択session、main resume、最新100 event、filter条件をSQLiteから復元し、support threadをresumeしない。 | Draft | 非該当 |
| HIST-F-020 | terminal記録のない実行を自動再実行しない。 | clean-shutdown markerがない起動ではWAL recovery後の`quick_check`が`ok`の場合だけ、`running`/`waiting_for_user`のturn・command・assignmentを`予期しない中断`または`結果不明`eventで閉じる。prompt、command、Git、testを自動送信しない。 | Draft | 非該当 |
| HIST-F-021 | 1 eventと対応evidenceをatomic transactionで書く。 | single writerが各eventを`BEGIN IMMEDIATE`で開始し、event、typed evidence、参照、session last sequenceを全件commitまたは全件rollbackする。途中fault後の孤立参照、半端なevent、同じidempotency keyの重複は0件である。 | Draft | 非該当 |
| HIST-F-022 | 履歴write失敗を成功扱いにしない。 | I/O、disk full、または5,000 msのbusy待機後のlock失敗は同じidempotency keyで1回だけretryし、再失敗時に`HIST_WRITE_FAILED`と手動retryを表示する。成功済みtransactionだけを再表示し、重複eventを作らない。 | Draft | 非該当 |
| HIST-F-023 | schema versionを検査してforward migrationする。 | 同版は変更せず、旧版はmigration前にSQLite backup APIで整合性確認済み1世代backupを作り、全stepを1 transactionで実行する。新版databaseは`HIST_SCHEMA_NEWER`で無変更停止する。 | Draft | 非該当 |
| HIST-F-024 | migration、WAL recovery、integrity check失敗時に元databaseを保護する。 | 起動時の`quick_check`またはmigration検査が`ok`以外ならwriterを閉じ、DB・WAL・SHM・backupを上書き、削除、置換せず、sidecar/sessionを開始しない。S-004にpathを伏せた`HIST_DB_INTEGRITY_FAILED`、backup有無、再試行、明示的新規database開始を表示する。 | Draft | 非該当 |
| HIST-F-025 | migration backupを限定期間だけ保持する。 | 成功したmigration後の次回正常起動でintegrity checkが成功するまで1世代を保持し、成功後に削除する。primary履歴はHIST-F-036の保持契約に従う。 | Draft | 非該当 |
| HIST-F-026 | SQLite writerを1 process・1 FIFO queueへ限定する。 | 二重起動、main/support同時event、削除、migrationでwriter connectionが最大1つ、全writeが`BEGIN IMMEDIATE`で直列となり、2個目のprocessはDB connectionを開かない。graceful Quitは受付済みqueueをdrainし、`wal_checkpoint(TRUNCATE)`の`busy=0`とWALのtruncated状態を確認してからDB外のapp-owned clean-shutdown markerをatomic replaceし、失敗時は正常終了済みと記録しない。 | Draft | 非該当 |

### 閲覧、filter、search

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| HIST-F-027 | workspaceとsessionの履歴一覧を表示する。 | workspaceは表示名・session数・最終活動UTC、sessionは名前・lifecycle・branch・event数・最終eventを表示し、0件では新規sessionへのempty stateを表示する。 | Draft | 非該当 |
| HIST-F-028 | session timelineを100件単位で遅延読込する。 | S-002は最新100件、S-003は最新100件と`以前を読み込む`を表示し、追加pageに重複・欠落がなく、全件を一括DOM展開しない。 | Draft | 非該当 |
| HIST-F-029 | timelineを複数条件でfilterできる。 | local date範囲、event type、status、actor/role、model、test resultをAND結合し、解除で同じsessionの全eventへ戻る。開始日が終了日より後ならqueryしない。 | Draft | 非該当 |
| HIST-F-030 | redacted textを部分一致searchできる。 | 1〜200文字のqueryをNFC正規化し、title、summary、command summary、commit ID/subject、test framework・対象summaryを日本語・英語で検索する。secret除外fieldをindexせず、0件時はno-resultを表示する。 | Draft | 非該当 |
| HIST-F-031 | evidence詳細と欠落状態を表示する。 | eventからsnapshot、command、diff、commit、test、review、model、support evidenceへ移動でき、参照先が外部削除・不整合なら推測せず`HIST_EVIDENCE_MISSING`、ID、再診断を表示する。 | Draft | 非該当 |

### 削除とretention

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| HIST-F-032 | 終了済みsessionをapp履歴から明示削除できる。 | `running`/`waiting_for_user`を0件と確認し、削除対象数、resume不能、Git非削除を確認後にsession、main resume、turn、support summary、event、evidenceを削除する。cancelでは0件変更する。 | Draft | 非該当 |
| HIST-F-033 | workspace単位で全app履歴を明示削除できる。 | 配下sessionが全てHIST-F-032の終了条件を満たす場合だけ件数と影響を確認し、workspace rootを含む全recordを削除する。1件でも実行中なら全体を無変更で拒否する。 | Draft | 非該当 |
| HIST-F-034 | 削除時にapp-owned派生dataも論理消去する。 | `secure_delete=ON`のprimary/FTS行削除をcommit後、WAL checkpoint/truncate、関連index・cache・集計・app-owned evidence file・対象backup削除、必要時VACUUMをbest effortで行う。app UI/query/再起動から対象IDと本文を復元できないことを検証し、一部失敗を完了表示しない。 | Draft | 非該当 |
| HIST-F-035 | 履歴削除でrepositoryとCodex外部dataを変更しない。 | local branch、commit、worktree、source file、Codex CLI所有rolloutにdelete/reset/cleanを発行せず、削除確認に非対象を表示する。 | Draft | 非該当 |
| HIST-F-036 | primary履歴を明示削除まで無期限保持する。 | age、件数、容量、archive、app updateを理由にeventを自動削除・要約置換せず、保存上限とTTL設定を設けない。disk full時はHIST-F-022を適用する。 | Draft | 非該当 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| 一覧 | workspace/session | 前回選択 | 条件付き | SQLiteに存在するIDだけ | 消失時は先頭またはempty stateへ移る |
| filter | date range | 全期間 | 任意 | OS timezoneの日付、開始≦終了 | 値を保持し項目直下に表示する |
| filter | type/status/actor/model/test | 全て | 任意 | catalogの複数選択 | 不明値を除外し診断eventにする |
| search | query | 空 | 任意 | NFC、1〜200文字。空は検索解除 | 201文字以上はqueryせず上限を表示する |
| 削除 | confirmation | 未選択 | 必須 | 対象ID・件数・非対象を表示し`削除`または`キャンセル` | cancelは変更しない |
| internal event | title/summary | なし | typeに応じ必須 | HIST-F-014〜HIST-F-018をtransaction前に適用 | `HIST_EVENT_REJECTED`で保存しない |

## データ要件

| Entity | 主なfield | 保存境界 |
|---|---|---|
| workspace | workspace ID、表示名、canonical repository root、作成・最終活動UTC | rootはresume用local tableだけ |
| session | session ID、workspace ID、名前、branch、canonical worktree、lifecycle、last sequence | workspace削除でcascade |
| main_resume | session ID、root thread ID、last turn ID、resume state、検証UTC | auth/token、conversationなし |
| turn/event | ID、session、sequence、actor/role、type、status、UTC、redacted title/summary、refs | append-only、HIST-F-018の上限 |
| support_assignment | HIST-F-005のfield | thread ID、prompt、raw responseなし |
| question / protocol_error | 到達可能requestの非secret質問・回答、または互換性違反requestのID・method・error code・理由enum・UTC | secret/free-form-onlyの質問・option・回答・入力内容・answered flagなし |
| snapshot/command/Git/test/review/model | HIST-F-008〜HIST-F-012とGIT-F-004〜GIT-F-034のfield | code・raw outputなし |
| search_index | redacted検索対象とevent ID | primary削除と同じtransactionでcascade |

writer接続はHIST-F-001の6設定を毎回読戻し、1つでも不一致ならwriteを開始しない。session内sequence、event ID、evidence ID、idempotency keyへunique制約を置き、allowlist外のtype、status、schema versionを保存しない。削除後はcheckpointと所有ファイル消去の個別成否を記録する。OS snapshot、外部backup、解放済みblock、SSD wear levelingからの物理復元防止は保証しない。

### 例外・復旧マトリクス

| 事象 | 表示 | data契約 |
|---|---|---|
| write失敗 | `HIST_WRITE_FAILED`、再試行 | 成功済みtransactionだけを正とする |
| crash中の実行 | 予期しない中断・結果不明 | terminal結果を推測しない |
| 異常終了後のWAL recovery / integrity・migration失敗 | `HIST_DB_INTEGRITY_FAILED`または`HIST_MIGRATION_FAILED` | `quick_check=ok`までrehydrateせず、元DB・WAL・SHM・backupを上書きしない |
| evidence欠落 | `HIST_EVIDENCE_MISSING` | eventを残し参照切れを表示する |
| disk full | 空き容量の確保と再試行 | 既存recordを自動purgeしない |
| offline | offline label | 一覧、search、詳細、削除をlocalで利用できる |
| 削除cleanup失敗 | `HIST_DELETE_INCOMPLETE`、再試行、保証外境界 | app UI/queryで対象を表示せず、残るapp-owned派生dataのcleanupを再試行する |

## デスクトップ固有要件

[デスクトップ共通仕様](../../screen-design/desktop-common-specification.md)との差分だけを定義する。

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | macOS実機で性能・crash復旧、Windows・Ubuntu CIでmigration、separator、transactionを検証する。 | HIST-F-017、HIST-F-019〜HIST-F-026 |
| ウィンドウ生成・再利用 | 単一`main`内のS-002/S-003を再利用し追加windowを作らない。 | HIST-F-027〜HIST-F-031 |
| 閉じる・アプリ終了 | closeではwriteと実行を継続し、graceful Quitではwriter queue drain、TRUNCATE checkpoint確認、DB外clean markerのatomic replace後にcloseする。 | HIST-F-019〜HIST-F-022、HIST-F-026 |
| 未保存データ | 未commitのin-memory eventを保存済みと表示せず、write失敗時は再試行状態を表示する。 | HIST-F-021、HIST-F-022 |
| ローカルデータ | SQLiteを履歴正本、Git/filesystemをsource・commit・worktreeの正本として参照する。 | HIST-F-001、HIST-F-009、HIST-F-010 |
| オフライン | local一覧、filter、search、詳細、削除を利用でき、cloud同期は行わない。 | HIST-F-027〜HIST-F-036 |
| ファイル・OS操作 | app data、backup、app-owned evidenceだけをRust側で操作し、relative pathをworkspace rootへ再照合する。 | HIST-F-017、HIST-F-023〜HIST-F-025、HIST-F-034 |
| メニュー・ショートカット | 履歴固有global shortcutを追加せず、S-003の操作をkeyboardで実行可能にする。 | HIST-F-027〜HIST-F-034 |
| Deep Link・ファイル関連付け | 非該当: 履歴ID・database・evidenceの外部受信を登録しない。 | HIST-F-031 |
| 通知 | 履歴保存・検索・削除ではOS通知を送らず、回復不能DB errorだけ共通通知を使う。 | HIST-F-022〜HIST-F-024 |
| Capability・認可 | WebViewへSQL、absolute path、delete APIの任意IDを公開せず、Rust側でID所有関係を再検証する。 | HIST-F-017、HIST-F-032〜HIST-F-035 |
| アップデート・互換性 | forward migrationだけを実行し、新版DBを旧appで開かない。 | HIST-F-023〜HIST-F-025 |

## 画面・UI

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-002` | コーディングワークスペース | HIST-F-002〜HIST-F-012、HIST-F-019〜HIST-F-022、HIST-F-028 | 変更 | [S-002 コーディングワークスペース](../../screen-design/S-002_coding-workspace.md) |
| `S-003` | セッション証跡 | HIST-F-005〜HIST-F-012、HIST-F-027〜HIST-F-036 | 新規 | [S-003 セッション証跡](../../screen-design/S-003_session-evidence.md) |
| `S-001` | セッションダッシュボード | HIST-F-003、HIST-F-019、HIST-F-020、HIST-F-027 | 参照 | [S-001 セッションダッシュボード](../../screen-design/S-001_session-dashboard.md) |
| `S-004` | 設定・診断 | HIST-F-022〜HIST-F-025、HIST-F-031〜HIST-F-036 | 変更 | [S-004 設定・診断](../../screen-design/S-004_settings-diagnostics.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | parameterized SQL、foreign key、schema allowlist、Rust側ID ownership、transaction前redactionを使用する。databaseをWebViewへ公開しない。 |
| 権限 | app data内のDB・backup・owned evidenceだけを作成・削除する。Full accessのCodexへDB pathとdelete機能を渡さない。 |
| プライバシー | HIST-F-007、HIST-F-013〜HIST-F-018をprimary、WAL、index、backup、cache、logへ同一適用する。互換性違反の質問・回答・入力内容を保存しない。 |
| 監査・ログ | schema version、migration ID、event ID/type/status、UTC、短いerror codeだけを診断logへ残し、履歴本文、secret、absolute pathを残さない。 |
| 性能 | 8 CPU core・16 GBのmacOS、100 workspace・1,000 session・100,000 event fixtureで、cold一覧p95 2秒、最新100件p95 500 ms、filter/search p95 2秒、event commit p95 100 msとする。各30回、model・filesystem evidence読込を除外する。 |
| 負荷 | 1,000 event/分を10分投入し、重複・欠落・sequence逆転0件、UI threadの2秒超block 0回とする。pageは100件固定とする。 |
| 信頼性・復旧 | HIST-F-001のWAL/FULL設定、single writerの`BEGIN IMMEDIATE`、1,000 page自動checkpoint、graceful Quitのdrain/TRUNCATE、異常終了後のWAL recovery・`quick_check`をfault injectionで検証する。完了不明の外部操作を成功へ補正しない。 |
| アクセシビリティ | 一覧、filter、search、page追加、詳細、削除確認をkeyboardだけで操作でき、statusと結果を色だけで表さず、更新をstatus regionで通知する。 |
| 多言語・地域 | 日本語・英語を提供する。ID、hash、error codeは翻訳せず、UTC保存・OS timezone表示とする。searchは両言語のNFC textを扱う。 |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) | single instance、Quit、SQLite、秘密、通知、3OS契約 | 解決済み | 保存・復旧境界を保証できない |
| [workspace-sessions要件](../workspace-sessions/requirements.md) | workspace/session/worktree mappingとlifecycle eventを提供する | Draft | resumeと一覧を構成できない |
| [codex-main-session要件](../codex-main-session/requirements.md) | main thread/turn、到達可能AskUserQuestion、互換性違反分類を提供する | Draft | HIST-F-004、HIST-F-006、HIST-F-007を検証できない |
| [support-agent-orchestration要件](../support-agent-orchestration/requirements.md) | ephemeral assignment summaryとmodel evidenceを提供する | Draft | HIST-F-005、HIST-F-011を検証できない |
| [git-review-harness要件](../git-review-harness/requirements.md) | snapshot、command、diff、commit、test、review evidenceとproducer fieldを提供する | Draft間で整合済み | GIT-F-004〜GIT-F-042が欠けるとHIST-F-003、HIST-F-008〜HIST-F-012、HIST-F-031を検証できない |
| SQLite | bundle済みlibraryでtransaction、WAL、backup API、integrity checkを利用できる | runtime/build検証 | 利用不能時はappを起動しない |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| 画面相互参照 | S-001〜S-004との双方向ID対応を維持する | 要件表と画面表を機械照合し差分0件を確認する | いいえ |

## トレーサビリティ

| 上流契約 | 対応する本要件 |
|---|---|
| WORK-F-020、WORK-F-027、WORK-F-028、WORK-F-043 | HIST-F-004、HIST-F-019、HIST-F-020、HIST-F-002〜HIST-F-003 |
| CODE-F-013、CODE-F-023、CODE-F-038〜CODE-F-046、CODE-F-050 | HIST-F-004、HIST-F-006〜HIST-F-008、HIST-F-013〜HIST-F-020 |
| SUP-F-016〜SUP-F-019、SUP-F-026、SUP-F-049 | HIST-F-005、HIST-F-011、HIST-F-013〜HIST-F-016、HIST-F-020 |
| GIT-F-004〜GIT-F-008、GIT-F-013〜GIT-F-016、GIT-F-017〜GIT-F-042 | HIST-F-003、HIST-F-008〜HIST-F-010、HIST-F-012〜HIST-F-015、HIST-F-017〜HIST-F-021、HIST-F-028〜HIST-F-031 |
| 共通仕様のSQLite、Quit、crash、migration契約 | HIST-F-001〜HIST-F-004、HIST-F-019〜HIST-F-026 |
| ユーザーの保持・検索・削除判断 | HIST-F-027〜HIST-F-036 |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [要件定義基準](../../rules/requirements-definition-standards.md) | 1挙動1ID、受け入れ条件、desktop境界 |
| [要件定義テンプレート](../../rules/requirements-definition-template.md) | 必須sectionとreview形式 |
| [ID管理ルール](../../rules/id-management-rules.md) | `HIST` Prefixと画面IDの正本 |
| [要件定義一覧](../README.md) | 8機能の共通判断と責務境界 |
| [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) | SQLite、秘密、lifecycle、OS差分の正本 |
| [git-review-harness要件](../git-review-harness/requirements.md) | Git・command・test・review evidenceのproducer契約 |

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Not Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 未合意 |
| 残る非ブロック論点 | 仕様責任者合意 |

## 着手可チェック

- [x] 背景と目的が説明できる。
- [x] スコープ内・外と理由が明確である。
- [x] 全機能要件に一意な要件IDがある。
- [x] 全機能要件に検証可能な受け入れ条件がある。
- [x] 正常系、異常系、キャンセル、権限差分、空状態、境界値を確認した。
- [x] デスクトップ固有要件を確認し、非該当も明記した。
- [x] 画面IDと要件IDの相互参照が一致している。
- [x] 非機能要件と依存関係を確認した。
- [x] 着手ブロックが「はい」または「不明」の未確定事項がない。
- [ ] 仕様責任者がレビューし、合意した。
