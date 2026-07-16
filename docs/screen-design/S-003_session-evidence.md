---
title: "S-003 セッション証跡"
description: "sessionの履歴、Git・command・test・review evidenceを検索し、read-onlyで検証する画面仕様。"
updated: 2026-07-16
read_when:
  - "session timeline、filter、search、evidence詳細、final summaryを実装するとき。"
  - "欠落・stale・large diff・履歴削除をGit非変更のまま表示または検証するとき。"
screen_id: "S-003"
status: "Draft"
---
# S-003 セッション証跡

| 項目 | 内容 |
|---|---|
| window label | `main` |
| React route / view key | `/evidence/:sessionId` / `session-evidence` |
| 対象OS | macOS 13+ Apple Silicon、Windows 11 x64、Ubuntu 24.04 x64 |
| デザイン | 未作成 |
| 共通仕様 | [デスクトップ共通仕様](desktop-common-specification.md) |
| 廃止理由 | 非該当 |
| 後継画面ID | 非該当 |

## 目的

選択sessionの目的、変更、実行、検証、review、commit、残課題を構造化証跡から追跡する。証跡内容はread-onlyとし、閲覧を承認gateまたはGit変更操作へ変換しない。app履歴の明示削除だけを独立した破棄操作として扱う。

## 対象範囲

### 含める

| 対象 | 内容 |
|---|---|
| session summary | purpose、変更区分、影響、検証、commit・review参照、残課題、snapshot完全性をまとめる |
| timeline | 100件page、filter、NFC部分一致search、actor・model・test別の絞り込みを行う |
| evidence詳細 | Git状態、diff metadata、command、test、commit、review、model、support、質問を表示する |
| 異常証跡 | missing、stale、incomplete、interrupted、binary、large diff、外部変更を推測せず表示する |
| local操作 | read-only再収集、redacted summary copy、終了済みsession/workspaceのapp履歴削除を扱う |

### 含めない

| 非対象 | 理由 | 扱う画面・文書 |
|---|---|---|
| prompt送信、AskUserQuestion回答、turn中断 | 実行操作と証跡閲覧を分離するため | [S-002 コーディングワークスペース](S-002_coding-workspace.md) |
| commit、push、PR作成、merge、revert、reset、stash、clean、checkout | Git outcomeをSolとユーザー指示へ委ねるため | [S-002 コーディングワークスペース](S-002_coding-workspace.md)のcomposer、[Git要件](../requirements/git-review-harness/requirements.md) |
| approval・承認gate | evidenceをadvisoryな検証情報に限定するため | button、dialog、statusを作らない |
| patch、diff hunk、file本文、raw stdout/stderr、raw model response | code・秘密をSQLiteへ複製しないため | current worktreeまたはCodex側の履歴 |
| evidence recordの編集、status補正、支援結果の採用 | append-only事実を守るため | 新しいevent・snapshotだけを追加 |
| repository/worktree/branchの削除 | app履歴削除とGitを分離するため | [S-001 セッションダッシュボード](S-001_session-dashboard.md)とworkspace lifecycle |

## 表示契機と終了

| 項目 | 内容 |
|---|---|
| 表示契機 | [S-002 コーディングワークスペース](S-002_coding-workspace.md)の`証跡`、[S-001 セッションダッシュボード](S-001_session-dashboard.md)の終了session、保存済みrouteの復元 |
| 表示前提 | routeのsession IDがactive workspaceへ属し、SQLiteからredacted履歴をqueryできること |
| 初期フォーカス | 通常は`S-002へ戻る`、query error時は再試行、削除確認時は確認dialog見出し |
| 正常完了 | 閲覧は保存を伴わない。戻る操作で同じsessionの[S-002 コーディングワークスペース](S-002_coding-workspace.md)へ遷移する |
| キャンセル | filter editor、copy、再収集、削除確認を閉じ、event・Git・履歴を変更しない |
| 閉じる操作 | `main`を非表示にする。query・snapshot収集・background sessionは共通仕様どおり継続する |
| 再表示 | 同じsession、filter、search、選択event、scroll anchorを復元し、再収集を自動開始しない |

## 利用者と権限

| 利用者・ロール | 表示 | 操作 | 拒否時の動作 |
|---|---|---|---|
| ユーザー | redacted履歴とevidence | filter、search、page追加、選択、再収集、copy、app履歴削除、S-002へ戻る | invalid条件を保持し、Git非変更の理由を表示 |
| main Sol・support | actorとして表示 | event/evidenceのproducer | この画面からturn、assignment、Git操作を開始しない |
| React WebView | redacted view model | typed queryと選択操作 | SQL、database path、absolute path、Git argumentを拒否 |
| Tauri / Rust | statusとして間接表示 | ownership、query、redaction、read-only collector、delete transaction | 不正IDをquery・deleteせずS-001へ戻す |

## 画面構成

| 領域 | 表示内容 | 主な操作 |
|---|---|---|
| 上部bar | workspace/session名、branch、lifecycle、最終活動、online状態 | `S-002へ戻る`、session切替、[S-004 設定・診断](S-004_settings-diagnostics.md)、常時`緊急停止` |
| session summary | purpose、変更、影響、test、review、commit、残課題、latest snapshot ID/status/UTC | 参照eventへ移動、redacted summary copy |
| filter bar | local date、event/evidence type、status、actor/role、model、test result、1〜200文字search、適用件数 | AND filter適用、個別解除、全解除、search |
| event list | session sequence順の最新100件、UTCからOS timezoneへ変換した時刻、actor、type、status、title | item選択、`以前を読み込む`。全件を一括DOM展開しない |
| evidence detail | 選択eventの共通headerと型別field、参照関係、完全性、redaction・truncation表示 | 関連IDへ移動、再収集、copy、S-004で再診断 |
| danger zone | app履歴の保持範囲、削除件数、resume不能、Git非削除の説明 | session履歴削除、条件付きworkspace履歴削除 |
| live status | query、filter、page、copy、再収集、削除、errorのARIA通知 | 操作なし |

1,200 CSS px以上はevent list 38%・detail 62%の2列とし、summaryとfilterを上部へ固定する。800〜1,199 pxはlist 44%・detail 56%、実効幅799 px以下はsummary、filter、list、detailの1列とし、選択eventへ見出しfocusを移す。大量eventは100件pageとvirtualized listを併用する。

### evidence型別表示

| 型 | 表示するfield | 表示しないfield・縮退 |
|---|---|---|
| command | actor、分類、executable、argument数・redacted summary、relative cwd、開始/終了、duration、exit code/signal、terminal status、digest | command全文、stdin、raw stdout/stderr、absolute path |
| test | framework、対象summary、duration、exit、pass/fail/skipまたは`counts_unavailable`、未検証範囲 | raw test output。interrupted/timeout/crashをpassにしない |
| Git snapshot | branch、HEAD、base、upstream有無、dirty fingerprint、staged/unstaged/untracked件数、履歴操作中、actor | 自動修復、成功推測、Git変更操作 |
| diff | 比較元・先、staged/unstaged、relative path、status/rename、追加削除行数、hash、hunk数 | patch・file本文。binaryは前後byte/hashだけ。largeは全体統計、先頭500件、未表示数だけ |
| commit・remote | commit/parent ID、redacted subject、前後branch、観測turn/UTC、operation・exit分類 | author email、署名、diff、remote URL、PR本文・response本文 |
| model | owner turn/assignment、requested/actual model、actual effort、preset、fallback有無・理由 | hidden reasoning、raw response |
| support | assignment ID、固定role、source、actual model/effort、status、redacted summary、evidence refs、開始/終了 | support thread ID、prompt、raw output・reasoning |
| question | 非secretの質問・option・回答・resolved理由/UTC。secretはanswered flagとresolved理由/UTC | secret値、長さ、hash、label、TTS内容 |
| review・checkpoint・skill | severity、finding、relative file/line、再現条件、`no_findings`、目的・変更・検証・残課題、skill status | 自動採用、source修正、固定skill順、承認gate |

## 表示状態

| 状態 | 進入条件 | 表示 | 操作可否 | 状態から抜ける条件 |
|---|---|---|---|---|
| 初期化中 | session ownershipと最新100件をquery中 | skeleton、session context、緊急停止 | 戻る、緊急停止だけ可 | query terminal |
| 通常 | 1件以上のeventを取得 | summary、list、選択detail | 全read-only操作、条件付き削除可 | query、収集、削除、error |
| データなし | valid sessionにevent 0件 | `証跡はまだありません`、S-002へ戻る | 戻る、session切替可 | 最初のevent保存 |
| 検索結果なし | filter/search結果が0件 | 条件と`filterを解除` | filter変更だけ可 | 条件変更 |
| 収集中 | snapshot再収集がrunning | 新snapshotを`collecting`、元snapshotを維持 | 閲覧・戻る可。同じtriggerの再収集不可 | complete/incomplete/interrupted |
| stale・欠落 | snapshot相関不一致または参照先なし | `stale`理由、`HIST_EVIDENCE_MISSING`、対象ID、影響区分 | 閲覧、copy、再診断可。現在結果へ採用不可 | 新snapshotまたは参照復旧 |
| binary・large diff | binaryまたは500 file超・一時patch 5 MiB超 | metadata、境界の実数、未表示数 | metadata閲覧・copy可 | 別evidence選択 |
| オフライン | network unavailable | local履歴とoffline label | query、filter、search、copy、削除、local Git再収集可。remote結果は推測不可 | network回復。自動操作なし |
| write・collector error | transaction、Git context、parse失敗 | `incomplete`、欠落区分、短いerror code、再試行可否 | 保存済み閲覧、許可時の手動再試行可 | 新transactionまたは再収集完了 |
| crash復旧 | terminal recordなしで再起動 | `予期しない中断`または`結果不明`、保存済みrecord | 閲覧と手動再収集可。自動command/test/reviewなし | ユーザー操作 |
| 削除確認・処理中 | danger zone操作 | 件数、resume不能、Git/worktree/source非削除、進捗 | confirm/cancel。処理中は二重操作不可 | cancel、成功、失敗 |
| 権限不足 | sessionが別workspace、ID不在、DB ownership不一致 | 理由を表示してS-001へ戻る | 緊急停止と遷移だけ | valid session選択 |

## 操作

| 操作 | 事前条件 | 正常結果 | キャンセル時 | 失敗時 | 関連要件ID |
|---|---|---|---|---|---|
| S-002へ戻る | sessionが存在 | 同じsessionのcoding routeへ遷移し、composerまたは復旧操作へfocus | 非該当 | S-001へ戻して理由表示 | [APP-F-003〜APP-F-004](../requirements/desktop-shell/requirements.md#runtimewindowroutetray) |
| session切替 | 保存済みsessionが選択可能 | active workspaceを更新し、同じsessionのS-003を表示。旧workspaceのaudioを破棄する | 元sessionを維持 | 元sessionと理由を表示 | [APP-F-004、APP-F-010](../requirements/desktop-shell/requirements.md#runtimewindowroutetray) |
| filter・search | queryがvalid | 条件をAND結合し件数と先頭resultを更新 | editorを閉じ前条件維持 | 入力を保持し項目直下へ境界表示 | [HIST-F-029〜HIST-F-030](../requirements/activity-history/requirements.md#閲覧filtersearch) |
| 以前を読み込む | 次pageあり | 100件をsequence順に追加し重複・欠落なし | 非該当 | 既存pageを維持し再試行 | [HIST-F-028](../requirements/activity-history/requirements.md#閲覧filtersearch) |
| evidence選択 | list itemあり | 型別detailと参照を表示 | 非該当 | 欠落を推測せずIDと影響表示 | [HIST-F-031](../requirements/activity-history/requirements.md#閲覧filtersearch) |
| snapshot再収集 | worktreeがreadableなactive/archived session | current HEAD/fingerprintの新snapshotを作り元recordを不変保持 | collector開始前なら変更なし | `incomplete`と再収集可否を表示しmainを止めない | [GIT-F-040〜GIT-F-042](../requirements/git-review-harness/requirements.md#共有worktree秘密再開) |
| summary copy | redacted summaryあり | 選択summaryだけをclipboardへcopy | 変更なし | 元表示を維持しcopy error | [GIT-F-038](../requirements/git-review-harness/requirements.md#共有worktree秘密再開) |
| session履歴削除 | running/waitingが0件 | 確認後にsession、resume、event、evidence、derived dataをtransaction削除しS-001へ戻る | 0件変更 | 完了表示せず再試行。Git/filesystemは不変 | [HIST-F-032、HIST-F-034〜HIST-F-035](../requirements/activity-history/requirements.md#削除とretention) |
| workspace履歴削除 | 配下sessionがすべて終了 | 全recordとapp-owned derived dataを削除しS-001へ戻る | 0件変更 | 1件でも実行中なら全体を無変更で拒否 | [HIST-F-033〜HIST-F-035](../requirements/activity-history/requirements.md#削除とretention) |

この画面のDOM、menu、context menu、IPCにはcommit、push、PR、merge、revert、reset、stash、clean、checkout、approvalのbuttonを作らない。`再収集`はallowlist済みread-only Git commandだけを使い、Git index、refs、worktree fileを変更しない。

## 入力項目

| 項目 | 初期値 | 必須 | 制約・境界 | エラー表示 | 保存契機 |
|---|---|---|---|---|---|
| session ID | route値 | 必須 | 保存済みかつactive workspace所属 | S-001へ戻し理由表示 | 保存しない |
| local date range | 全期間 | 任意 | OS timezone、開始日≦終了日 | queryせず両field直下へ表示 | filter変更時にSQLiteへ保存 |
| event/evidence type | すべて | 任意 | catalogの複数選択 | unknown値を適用しない | filter変更時 |
| status | すべて | 任意 | complete、incomplete、failed、interrupted、stale等のcatalog | unknown値を拒否 | filter変更時 |
| actor/role・model・test result | すべて | 任意 | catalogの複数選択 | 消失entryを除外し通知 | filter変更時 |
| search query | 空 | 任意 | NFC、空で解除、1〜200 Unicode文字 | 201文字以上はqueryしない | 入力debounce後 |
| snapshot | latest | 任意 | 同じsessionの保存済みID | missing state | 選択だけを保存 |
| 削除判断 | 未選択 | 条件付き | `削除`または`キャンセル`、対象ID・件数・非対象を確認 | 条件不成立理由 | confirm時だけtransaction |

## ネイティブ連携

実際のCapability設定は `src-tauri/capabilities/` を正本とする。

| ユーザー操作 | 実行境界 | Tauri plugin / Command | 必要なCapability・認可 | キャンセル時 | 拒否・失敗時 |
|---|---|---|---|---|---|
| timeline query・search | Rust / SQLite | `history_query` | session ownership、parameterized query、100件limit | 直前result維持 | SQL・DB pathを返さずerror code |
| evidence detail | Rust / SQLite | `evidence_detail` | session/evidence ID相関とredaction | 直前選択維持 | missing stateを返す |
| snapshot再収集 | Rust / Git | `collect_git_snapshot` | sessionからworktree再解決、read-only command allowlist | 開始前は0件変更 | Gitを変えずincomplete record |
| summary copy | Tauri clipboard / Rust | `copy_redacted_summary` | server-side redaction済みtextだけ | 0件変更 | 元表示維持 |
| app履歴削除 | Rust / SQLite・app data | `delete_session_history` / `delete_workspace_history` | terminal状態、ownership、transaction、owned data containment | 0件変更 | Git・Codex外部dataを変更せず再試行 |

## ウィンドウ固有動作

[デスクトップ共通仕様](desktop-common-specification.md)との差分だけを示す。

| 項目 | 動作 |
|---|---|
| 生成・再利用 | 既存`main`のrouteを再利用し、detail、diff、review、削除用windowを作らない |
| 初期サイズ・最小サイズ | S-002と同じ保存済み`main` geometry、最小800×600 CSS px |
| リサイズ | 可。2列と1列を切り替え、list selectionとscroll anchorを維持 |
| 最大化・全画面 | OS標準操作を許可 |
| 常に手前へ表示 | 不可 |
| 閉じる操作 | 非表示。query/collectorを継続し、再表示で同じ選択へ戻る |
| 未保存変更がある場合 | filter/search/selectionだけを保存。evidence本文の未保存編集は存在しない。削除確認中のcloseはcancel扱い |

## メニュー・ショートカット

| 操作 | macOS | Windows / Linux | 有効条件 | 実行結果 |
|---|---|---|---|---|
| searchへfocus | `Command+F` | `Ctrl+F` | S-003表示中 | search inputを選択 |
| eventを開く | `Enter` | `Enter` | list itemへfocus中 | detail見出しへfocus |
| panel・確認を閉じる | `Escape` | `Escape` | filter editor、detail overlay、削除確認 | 起点へfocusを戻し変更なし |
| Git outcome | 非該当 | 非該当 | 常に | menu、shortcut、buttonを設けない |

## データ保持

| データ | 正本・保存先 | 保存契機 | 復元契機 | 破棄条件 | 失敗時 |
|---|---|---|---|---|---|
| event・evidence | SQLite append-only | producer transaction成功時 | page query、再起動 | 明示履歴削除 | partial recordをcomplete表示しない |
| filter・search・選択 | SQLite / UI state | 条件・route変更 | 同じsession再表示 | session履歴削除 | default条件へ戻し通知 |
| source・Git実体 | repository/worktree | この画面は保存しない | read-only再収集時に参照 | この画面は削除しない | unavailable/incomplete表示 |
| raw patch・output・reasoning | 保存しない | 非該当 | 復元しない | 収集処理終了時にmemory破棄 | metadataだけ表示 |
| secret質問回答 | answered flagだけSQLite | 解決時 | detail表示 | 履歴削除 | 値を復元・copyしない |
| derived data | FTS/index/cache/owned evidence | primary transactionに従う | query時 | primaryと同じ明示削除 | 削除完了を表示しない |

## OS差分

| 項目 | macOS | Windows | Linux |
|---|---|---|---|
| modifier | `Command` | `Ctrl` | `Ctrl` |
| path表示 | `/`正規化relative path | `/`正規化relative path | `/`正規化relative path |
| clipboard | native clipboard | native clipboard | desktop sessionのclipboard。利用不能ならcopy error |
| 検証水準 | Git・復旧・性能を実機E2E | build/test済みpreview、実機未検証 | build/test済みpreview、実機未検証 |

## アクセシビリティ

- focus順を上部bar、summary、filter、event list、detail、danger zoneの順に固定する。
- virtualized listを`list`/`listitem`として扱い、現在位置、全取得件数、次page追加をscreen readerへ通知する。
- event選択時はdetail見出しへfocusでき、戻ると元itemへ戻す。削除dialogはfocus trapとする。
- status、test結果、finding severity、stale、missingを色だけで示さずlabelとicon形状を併用する。
- tableはcaption相当の見出しとcolumn headerを持ち、長いID・relative pathは視覚省略してもaccessible textを保持する。
- copy、再収集、削除の結果をARIA statusへ通知し、live timeline更新で読上げ位置を移動しない。
- 日本語・英語、200% text zoom、forced colorsでfilter、S-002へ戻る、緊急停止、削除cancelを欠落させない。

## 関連要件

| 要件ID | この画面での扱い | 要件定義書 |
|---|---|---|
| APP-F-003〜APP-F-004、APP-F-010、APP-F-022〜APP-F-026、APP-F-034〜APP-F-036、APP-F-044〜APP-F-046 | route、active workspace、通知、offline、redaction、並行session、A11y | [デスクトップシェル要件](../requirements/desktop-shell/requirements.md) |
| WORK-F-012、WORK-F-020、WORK-F-027、WORK-F-028、WORK-F-043 | base・resume・復元・中断・lifecycle evidence | [workspace要件](../requirements/workspace-sessions/requirements.md) |
| CODE-F-023、CODE-F-044、CODE-F-046、CODE-F-050 | Git actor境界、質問解決、切断、secret | [Codexメインセッション要件](../requirements/codex-main-session/requirements.md) |
| SUP-F-016〜SUP-F-019、SUP-F-026、SUP-F-028〜SUP-F-034、SUP-F-038〜SUP-F-045、SUP-F-048、SUP-F-049 | ephemeral summary、model evidence、role結果、競合、stale・停止 | [support要件](../requirements/support-agent-orchestration/requirements.md) |
| GIT-F-002〜GIT-F-042 | actor、snapshot、skill/review、Git/diff、command/test/commit、復旧 | [Gitレビュー支援要件](../requirements/git-review-harness/requirements.md) |
| HIST-F-005〜HIST-F-012、HIST-F-027〜HIST-F-036 | support/質問/evidence、一覧、page、filter、search、欠落、削除・retention | [アクティビティ履歴要件](../requirements/activity-history/requirements.md) |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| なし | 本文の2-pane read-only表示、100件page、型別縮退、app履歴だけの明示削除で実装する | 仕様責任者レビューで実装と6要件の双方向IDを確認する | いいえ |

## レビュー確認

- [x] front matterの `screen_id`、タイトル、ファイル名の画面IDが一致している。
- [x] `status` が `Draft`、`Approved`、`Deprecated` のいずれかである。
- [x] 目的と対象外が一意である。
- [x] 初期化、通常、空、処理中、オフライン、エラー、権限不足を確認した。
- [x] キャンセル、閉じる、再表示、未保存データの動作が決まっている。
- [x] ネイティブ操作のCapability・認可と失敗時動作が決まっている。
- [x] OS差分を確認し、未確認を「共通」としていない。
- [x] 関連要件IDが要件定義書と一致している。
- [x] 着手ブロックが「はい」または「不明」の未確定事項が残っていない。
- [x] `agent-docs lint` が成功している。
