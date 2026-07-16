---
title: "S-002 コーディングワークスペース"
description: "現在のworkspaceでSolへ入力し、main・support・Live2D・音声実況の進行とAskUserQuestionを扱う画面仕様。"
updated: 2026-07-17
read_when:
  - "コーディング画面のlayout、composer、AskUserQuestion、session切替、緊急停止を実装するとき。"
  - "Live2D、音声実況、support role status、offline・再開状態をS-002へ統合するとき。"
screen_id: "S-002"
status: "Draft"
---
# S-002 コーディングワークスペース

| 項目 | 内容 |
|---|---|
| window label | `main` |
| React route / view key | `/workspace/:sessionId` / `coding-workspace` |
| 対象OS | macOS 13+ Apple Silicon、Windows 11 x64、Ubuntu 24.04 x64 |
| デザイン | 未作成 |
| 共通仕様 | [デスクトップ共通仕様](desktop-common-specification.md) |
| 廃止理由 | 非該当 |
| 後継画面ID | 非該当 |

## 目的

現在選択中のsession専用worktreeでmain Solと対話し、作業・質問・検証結果を1画面で追跡する。現在workspaceだけのLive2Dと実況を表示し、障害時もtextと明示操作で安全に継続または停止できる。

## 対象範囲

### 含める

| 対象 | 内容 |
|---|---|
| Sol | latest timeline、固定実行契約、turn状態、全5種類のCodex入力を扱う中央領域 |
| main質問 | 1〜3問、各2〜3 option、client追加の`Other`、到達wire値のtimeout、解決済み状態を扱うoverlay |
| support | 固定7 roleのidle・lease owner・queued・deferred・結果・縮退・実model/effortを表示する |
| companion・実況 | current workspaceのmain Sol 1体、決定論的play-by-play、terminal後のcolor commentary、TTS状態、muteを扱う |
| lifecycle | session切替、turn中断、offline、再接続、明示再開、緊急停止、tray再表示を扱う |

### 含めない

| 非対象 | 理由 | 扱う画面・文書 |
|---|---|---|
| repository選択、session作成・archive・cleanup | workspace lifecycleと分離するため | [S-001 セッションダッシュボード](S-001_session-dashboard.md)、[workspace要件](../requirements/workspace-sessions/requirements.md) |
| evidenceの全文検索・詳細比較・削除 | 実行画面を簡潔に保つため | [S-003 セッション証跡](S-003_session-evidence.md) |
| Codex、TTS、Live2Dの設定・診断 | secretと診断の境界を分離するため | [S-004 設定・診断](S-004_settings-diagnostics.md) |
| model、sandbox、approval、support roleの変更 | 固定実行契約を守るため | read-only値だけを表示 |
| 通常turnのPause / Resume | 停止種別をinterruptと緊急停止へ限定するため | turn中断後は新しいturn、停止sessionは明示再開 |
| Git outcomeの専用button | commit等の判断をユーザー指示とSolへ委ねるため | composerの通常Text入力、[Git要件](../requirements/git-review-harness/requirements.md) |
| Live2D model追加・交換、microphone・STT | 配布・権限範囲を固定するため | 同梱model 1体とTTS出力だけを使用 |

## 表示契機と終了

| 項目 | 内容 |
|---|---|
| 表示契機 | S-001で利用可能sessionを開く、S-003から戻る、質問・完了通知をclickする、tray・Dock・taskbarから再表示する |
| 表示前提 | routeのsessionがactive workspaceに属し、保存recordとworktreeの照合結果を取得できること。利用不能でもread-only error stateは表示する |
| 初期フォーカス | idle時はcomposer本文、未解決質問時は最初の質問、停止・復旧error時は最初の復旧操作 |
| 正常完了 | turn terminal後にtimelineとsnapshot状態を更新し、質問待ち・停止中でなければcomposerを再び有効にする |
| キャンセル | picker・catalogを閉じてもdraftと添付済みitemを維持する。実行済みturnはcancelせず、別操作の`turnを中断`を使う |
| 閉じる操作 | `main`を非表示にし、turn、support、履歴、TTSを継続し、Live2D render loopだけを停止する |
| 再表示 | 同じroute、active workspace、timeline、非秘密draft、質問、support statusを復元し、audioを二重再生しない |

## 利用者と権限

| 利用者・ロール | 表示 | 操作 | 拒否時の動作 |
|---|---|---|---|
| ユーザー | 全領域 | session切替、入力、質問回答、turn中断、mute、緊急停止、画面遷移 | draftを守り、項目直下またはstatus bannerへ理由を表示 |
| main Sol | 中央timeline | 固定契約のturnとmain-only質問を発生 | session・thread・worktree不一致ならturnを開始しない |
| 7 support role | 左railのstatusだけ | trigger済みassignmentを実行 | ユーザー質問・直接assignment UI・設定変更を提供しない |
| React WebView | redacted view model | 表示、入力、typed IPC要求 | shell、SQL、secret再取得、任意path・URLを拒否 |
| Tauri / Rust | statusとして間接表示 | 相関、schema、path、process、履歴、TTS、緊急停止 | 不正requestをsidecarへ渡さず短いerror codeを返す |

## 画面構成

| 領域 | 表示内容 | 主な操作 |
|---|---|---|
| 上部bar | workspace/session名、branch、lifecycle、online状態、`Sol`、`gpt-5.6-sol`、Full access / neverのread-only badge | session switcher、S-003、S-004、常時表示の`緊急停止` |
| 左rail | 7 roleのidle・lease owner・queued・deferred、actual model/effort、fallback、最新summary | role詳細をtimelineまたはS-003で開く。role作成・model変更は不可 |
| Sol中央領域 | 最新100 event、Solのredacted message summary、command/test/Git/review status、snapshot収集中・結果 | event選択、末尾へ移動、turn実行中の`turnを中断` |
| composer | Text textarea、InlineImage/LocalImage chip、Skill picker、Mention picker、byte・画像count、送信error | item追加・削除、`Solへ送信`。remote画像と汎用fileは受け付けない |
| 質問overlay | mainだけの1〜3 question card、各2〜3 option、client追加の`Other`、残り時間、回答送信状態 | radioで全問回答し、`Other`選択時だけ任意文を入力して1回送信。未解決overlayは閉じられない |
| 固定companion | 同梱Live2D 1体、main semantic stateのHTML label、animated/static/hidden理由 | 表示のみ。model・expression選択なし |
| 実況panel | Rust rendererの即時play-by-play、terminal後のNarrator color commentary、audio status、mute、回答待ちの沈黙表示 | mute切替、S-004を開く。voice等は変更しない |
| live status | turn、質問、送信、error、session切替、実況textを通知するARIA領域 | 操作なし |

1,360 CSS px以上は左rail 248 px・中央min 600 px・右companion 304 pxの3列とする。800〜1,359 pxは左railを上部barから開くdrawerにし、中央と右240 pxを維持する。実効幅799 px以下では中央、compact companion、support drawerの順へ1列化し、composerと緊急停止を常に到達可能にする。canvasは全breakpointで1つだけである。

## 表示状態

| 状態 | 進入条件 | 表示 | 操作可否 | 状態から抜ける条件 |
|---|---|---|---|---|
| 初期化中 | route検証、最新100件、main/worktree照合中 | skeleton、session名、緊急停止 | 画面遷移と緊急停止だけ可 | 全照合がterminalになる |
| 通常・idle | main turn、main queue、未解決質問なし | composer、`待機中`、lease ownerなし、support status | 入力、送信、切替、mute可 | turn開始、queue、質問、障害 |
| 処理中 | main/supportがlease owner、またはmainがqueued | owner、queued/deferred、streaming status、実行item | support owner中はmainをqueue可。main owner中はdraft編集、turn中断、切替、緊急停止可 | owner terminal後の安定snapshot、または質問待ち |
| 回答待ち | validなmain AskUserQuestionが未解決 | mainがlease owner、support running 0件、overlay、質問を1回告知後に沈黙 | 回答と緊急停止可。composer送信不可、support triggerはdeferred | 回答、timeout、server解決、interrupt後のturn terminal |
| データなし | session ID不在・別workspace・削除済み | 理由を表示してS-001へ戻る | 緊急停止と遷移だけ可 | valid sessionを選ぶ |
| オフライン | network unavailable | 保存timeline、draft、`offline`、text companion | local閲覧・編集・切替・緊急停止可。turn/TTS送信不可 | 再接続後にユーザーが送信する |
| 停止中 | emergency stop後 | 全session停止、既存変更は未取消、診断案内 | 閲覧、S-004、対象sessionの明示再開可 | 診断合格後にユーザーが再開 |
| 復旧必要 | branch不一致、Git操作中、worktree破損、resume失敗 | 原因、dirty件数、error code、再診断または解消用再開 | 通常送信不可。許可された復旧操作と緊急停止可 | worktree/thread再検証に合格 |
| sidecar・互換性error | 切断、schema・固定契約不一致 | turn中断、draft保持、S-004への案内 | 自動再起動・再送不可 | ユーザー再診断後に明示再開 |
| audio・renderer縮退 | TTS、asset、WebGL、device失敗 | transcript＋main state、static/hidden、mouth closed | Codex操作は継続。S-004を開ける | component復旧または明示retry |
| 権限不足 | Full access / neverがpolicyで禁止 | 不一致値と管理者確認項目 | 閲覧・設定・Quit・緊急停止のみ | policyと診断が固定契約へ一致 |

## 操作

| 操作 | 事前条件 | 正常結果 | キャンセル時 | 失敗時 | 関連要件ID |
|---|---|---|---|---|---|
| session切替 | 保存済みsessionが選択可能 | draftを保存しrouteを変更。旧audioを100 ms以内に破棄し、新sessionのmain stateを250 ms以内に表示 | 元sessionを維持 | S-001へ戻さず元sessionと理由を表示 | [APP-F-004、APP-F-010](../requirements/desktop-shell/requirements.md#runtimewindowroutetray)、[LIVE-F-020](../requirements/live2d-companion/requirements.md#main-solのsemantic-state) |
| Solへ送信 | main turnなし、online、質問なし、valid itemが1件以上 | Rust再検証後、leaseが空なら開始し、support owner中ならmainをqueuedにする。受付成功時にdraftをclear | 非該当 | 非秘密draftを保持し項目別error | [CODE-F-016](../requirements/codex-main-session/requirements.md#main-threadと固定実行契約)、[CODE-F-024〜CODE-F-032](../requirements/codex-main-session/requirements.md#turn入力) |
| 画像を追加 | composer利用可 | paste画像をInlineImage、picker画像をLocalImage chipとして追加 | 変更なし | 違反MIME・size・pathを表示し全turnを未送信 | [CODE-F-026〜CODE-F-029](../requirements/codex-main-session/requirements.md#turn入力) |
| Skill / Mention追加 | effective catalog entryが利用可能 | 明示選択したentryだけをitemにする | 変更なし | itemを追加せず理由と再読込案内 | [CODE-F-030〜CODE-F-031](../requirements/codex-main-session/requirements.md#turn入力) |
| turnを中断 | main turnがrunning | 対象turnへinterruptを1回送りterminal表示にする。Pause状態を作らない | 確認を閉じれば継続 | 相関失敗を表示し緊急停止を維持 | [CODE-F-022](../requirements/codex-main-session/requirements.md#main-threadと固定実行契約) |
| 質問へ回答 | CODE-F-038〜CODE-F-042適合、全問valid、未解決 | request IDへ選択labelまたは`Other`本文を1回だけ送りoverlayを解決済みにする | `autoResolutionMs: null`は待機を維持 | 自動再送せず送信状態と再入力可否を表示 | [CODE-F-038〜CODE-F-045](../requirements/codex-main-session/requirements.md#askuserquestion) |
| mute切替 | S-002表示中 | muteは即時audio停止、unmuteは過去発話を再生せず次発話から有効 | 非該当 | text実況を維持しS-004診断を案内 | [NARR-F-030](../requirements/audio-commentary/requirements.md#優先queueinterrupt質問待ち) |
| 証跡を開く | valid session | 同じsessionの[S-003 セッション証跡](S-003_session-evidence.md)へ遷移 | 非該当 | S-002を維持しerror表示 | [HIST-F-028](../requirements/activity-history/requirements.md#閲覧filtersearch) |
| 緊急停止 | 常時 | 250 ms以内に新規処理を拒否し、全turnをinterrupt、audioを100 ms以内に停止、必要時にchildを段階終了 | 確認は置かず即時実行 | appを残し残存childとerrorをS-004へ表示 | [APP-F-017〜APP-F-019](../requirements/desktop-shell/requirements.md#quitemergencycrash) |

`autoResolutionMs`がnullなら無期限、到達wire値60,000〜240,000 msなら残り時間を1秒単位で表示し、0で全questionの空answerを1回だけ送る。既にanswerまたは`serverRequest/resolved`済みの操作・後着eventは無視する。secret、free-form-only、`isOther: false`、範囲外件数・option・timeout、組込みmain質問以外のoriginはcompatibility failureとし、overlay、OS通知、実況text/TTS、answer保存を作らない。

lease ownerがsupportならmainはqueuedとし、support terminalと安定snapshot後まで`turn/start`を送らない。main実行中と質問待ちでは同じsessionのsupport runningを0件、triggerをdeferredにする。別canonical worktreeのsessionだけは並行できる。

## 入力項目

| 項目 | 初期値 | 必須 | 制約・境界 | エラー表示 | 保存契機 |
|---|---|---|---|---|---|
| Text | workspace別draft | 条件付き | 全Text合計UTF-8 1〜65,536 bytes | byte数と上限をtextarea直下へ表示 | 非秘密値を編集、close、切替時にSQLiteへ保存 |
| InlineImage | なし | 任意 | pasteしたPNG/JPEG/WebP data URL。HTTP(S) URLは禁止 | MIME、decode、magic bytesの違反 | 送信までmemoryだけ |
| LocalImage | なし | 任意 | OS pickerで選んだabsolute readable regular PNG/JPEG/WebP | path種別・読取・format違反。absolute pathはUIにbasenameだけ表示 | 送信までmemoryだけ |
| 全画像 | 0件 | 任意 | 最大10件、各20 MiB、decode後合計50 MiB、各辺1〜8,192 px | 違反した実値と境界を一覧上部へ表示 | 保存しない |
| Skill | なし | 任意 | enabled effective catalogのnameとabsolute `SKILL.md`が一致 | entry消失・load error | item選択だけをdraft保存 |
| Mention | なし | 任意 | accessibleな導入済みapp/plugin catalog entry | 任意scheme・未導入entryを拒否 | item選択だけをdraft保存 |
| option質問 | 未選択 | 各問必須 | 2〜3 optionの単一選択＋client `Other`。`Other`選択時だけ任意文欄を表示し、空は未回答 | 未回答、無効option、空の`Other`本文 | 適合requestの解決時だけ履歴保存 |
| autoResolutionMs | server値 | 任意 | nullまたは60,000〜240,000 ms | 範囲外requestはcompatibility failure | timeout結果だけ保存 |

## ネイティブ連携

実際のCapability設定は `src-tauri/capabilities/` を正本とする。

| ユーザー操作 | 実行境界 | Tauri plugin / Command | 必要なCapability・認可 | キャンセル時 | 拒否・失敗時 |
|---|---|---|---|---|---|
| turn送信・中断 | Rust Command / App Server | `main_turn_start` / `main_turn_interrupt` | session・thread・cwd・schemaのRust再照合 | 送信前ならdraft維持 | sidecarへ未検証値を送らずerror |
| LocalImage選択 | Tauri dialog / Rust | `dialog.open` / `validate_local_image` | file 1件の選択とRust側canonical検証 | itemを追加しない | basenameと違反理由だけ表示 |
| 質問回答 | Rust Command / App Server | `answer_user_question` | main threadとrequest/turn/item ID、CODE-F-038〜CODE-F-042を照合 | 待機維持 | 二重送信せずcompatibility failureを表示 |
| mute | Rust Command / audio | `set_narration_mute` | current workspaceとgeneration照合 | 非該当 | text-onlyへ縮退 |
| 緊急停止 | Rust lifecycle | `emergency_stop` | `main`とtrayから常時許可 | 非該当 | kill対象を照合し未知processを残す |
| 通知click | Tauri notification / router | `focus_notification_target` | 3種類のallowlist eventだけ | 非該当 | S-001へ安全に戻す |

## ウィンドウ固有動作

[デスクトップ共通仕様](desktop-common-specification.md)との差分だけを示す。

| 項目 | 動作 |
|---|---|
| 生成・再利用 | 既存`main`のrouteを再利用し、質問・support・companion用windowを作らない |
| 初期サイズ・最小サイズ | 初期1,280×800 CSS px、最小800×600 CSS px。保存値があれば共通仕様の補正後に復元 |
| リサイズ | 可。上記breakpointへ再配置し、resize完了250 ms以内にcompanionをfitする |
| 最大化・全画面 | OS標準操作を許可し、状態を共通仕様どおり保存 |
| 常に手前へ表示 | 不可 |
| 閉じる操作 | 非表示。turn、support、TTSを止めずLive2D drawだけ停止 |
| 未保存変更がある場合 | 非秘密draftを保存して非表示。未解決質問は回答を保存せず、再表示時に同じrequestからoverlayを復元する |

## メニュー・ショートカット

| 操作 | macOS | Windows / Linux | 有効条件 | 実行結果 |
|---|---|---|---|---|
| Solへ送信 | `Command+Enter` | `Ctrl+Enter` | composerがvalidかつ送信可能 | 1 turn送信。通常のEnterは改行 |
| 質問回答 | `Command+Enter` | `Ctrl+Enter` | overlay内の全問がvalid | 回答を1回送信 |
| 非modal panelを閉じる | `Escape` | `Escape` | session/support/catalog drawer表示中 | 起点へfocusを戻す。未解決質問は閉じない |
| 緊急停止 | 専用shortcutなし | 専用shortcutなし | 常時 | 上部barまたはtrayのbuttonをkeyboard実行する |
| Pause / Resume | 非該当 | 非該当 | 常に | menu、button、IPCを設けない |

## データ保持

| データ | 正本・保存先 | 保存契機 | 復元契機 | 破棄条件 | 失敗時 |
|---|---|---|---|---|---|
| 非秘密draft | SQLite / session | 編集、close、session切替 | 同じsessionの再表示・再起動 | turn送信成功またはユーザーclear | 画面に保持し再試行 |
| timeline・evidence参照 | SQLite append-only | Rust transaction成功時 | 最新100件を表示 | 明示履歴削除 | 未保存を成功表示しない |
| 質問回答 | SQLite / history | 適合requestの解決時 | 解決済み表示 | 明示履歴削除 | compatibility failureではrecordを作らない |
| InputItem画像byte | memory | 保存しない | 復元しない | 送信、削除、route離脱、Quit | itemを外しdraft textを維持 |
| support status | SQLite summaryとruntime | assignment terminal時 | 再表示ではsummary、次回は新thread | 明示履歴削除 | raw outputを保存しない |
| expression・audio queue | runtime memory | 永続保存しない | main statusから再評価 | 切替、mute、停止、Quit | textへ縮退 |

## OS差分

| 項目 | macOS | Windows | Linux |
|---|---|---|---|
| modifier | `Command` | `Ctrl` | `Ctrl` |
| companion・TTS | Apple Silicon実機保証 | CI済みpreview・実機未検証 | CI済みpreview・実機未検証 |
| LocalImage picker | macOS native dialog | Windows native dialog | portal/native dialog。利用不能なら添付不可 |
| 再表示 | Dockまたはtray | taskbarまたはtray | taskbarまたはtray |
| 通知拒否 | app内表示へ縮退 | app内表示へ縮退 | app内表示へ縮退 |

## アクセシビリティ

- focus順を上部bar、左railまたはdrawer、Sol timeline、composer、右companion・実況の順に固定する。
- 質問overlayは最初のquestionへfocusし、未解決中はoverlay内へtrapする。解決後はcomposer、停止時は復旧操作へ戻す。
- optionはquestionごとのradio group、`Other`は選択後だけlabel付き任意文inputを表示する。
- timelineとsupport更新を過剰に読み上げず、main terminal、質問、error、実況textを別のARIA statusへ通知する。
- Live2D canvasとstatic previewをaccessibility treeから除外し、同じsemantic stateをHTML textで常時表示する。
- status、role、test、error、audioを色だけで示さずtext labelとicon形状を併用する。
- keyboardだけでsession切替、全InputItem編集、送信、回答、turn中断、mute、緊急停止、S-003/S-004遷移を完了できる。
- 日本語・英語でlayoutを検証し、200% text zoomでもcomposer、質問、緊急停止を欠落させない。

## 関連要件

| 要件ID | この画面での扱い | 要件定義書 |
|---|---|---|
| APP-F-003〜APP-F-007、APP-F-010〜APP-F-023、APP-F-035〜APP-F-036、APP-F-044〜APP-F-046 | route、active workspace、lifecycle、通知、並行session、日英・A11y | [デスクトップシェル要件](../requirements/desktop-shell/requirements.md) |
| WORK-F-024、WORK-F-027〜WORK-F-035 | 同一worktree、復元、明示再開、dirty・特殊Git状態 | [workspace要件](../requirements/workspace-sessions/requirements.md) |
| CODE-F-016〜CODE-F-032、CODE-F-038〜CODE-F-049 | fixed main、全InputItem、main-only質問、切断・offline | [Codexメインセッション要件](../requirements/codex-main-session/requirements.md) |
| SUP-F-001〜SUP-F-015、SUP-F-020〜SUP-F-037、SUP-F-045〜SUP-F-049 | 7 role、ephemeral、model evidence、質問境界、stale・縮退 | [support要件](../requirements/support-agent-orchestration/requirements.md) |
| GIT-F-002〜GIT-F-016、GIT-F-027〜GIT-F-038 | Git actor、snapshot status、test/review/commit要約、競合・redaction | [Gitレビュー支援要件](../requirements/git-review-harness/requirements.md) |
| HIST-F-002〜HIST-F-012、HIST-F-019〜HIST-F-022、HIST-F-028 | latest timeline、再開、質問・command・evidence、write失敗 | [アクティビティ履歴要件](../requirements/activity-history/requirements.md) |
| LIVE-F-012〜LIVE-F-035、LIVE-F-037〜LIVE-F-043、LIVE-F-050、LIVE-F-052〜LIVE-F-054 | current main 1体、state mapping、lip-sync、縮退、A11y | [Live2D要件](../requirements/live2d-companion/requirements.md) |
| NARR-F-001〜NARR-F-030、NARR-F-043〜NARR-F-048、NARR-F-052〜NARR-F-055 | current workspace実況、queue、質問沈黙、text fallback、試験 | [音声実況要件](../requirements/audio-commentary/requirements.md) |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| なし | 本文の3領域layout、main-only質問、固定companion、常時緊急停止で実装する | 仕様責任者レビューで実装と8要件の双方向IDを確認する | いいえ |

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
