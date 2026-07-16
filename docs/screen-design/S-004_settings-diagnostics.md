---
title: "S-004 設定・診断"
description: "言語・表示・同梱Live2D・音声・通知・履歴を設定し、Codex、Git、storage、renderer、audio、配布物を秘密値なしで診断する画面仕様。"
updated: 2026-07-17
read_when:
  - "言語、appearance、Live2D、TTS、通知、履歴削除の設定画面を実装するとき。"
  - "Codex、Git、SQLite、WebGL、audio、model asset、OS artifactの診断とredactionを検証するとき。"
screen_id: "S-004"
status: "Draft"
---
# S-004 設定・診断

| 項目 | 内容 |
|---|---|
| window label | `main` |
| React route / view key | `/settings` |
| 対象OS | macOS 13+ Apple Silicon、Windows 11 x64、Ubuntu 24.04 x64 |
| デザイン | 未作成。本文のsection順、状態、文言を実装正本とする |
| 共通仕様 | [デスクトップ共通仕様](desktop-common-specification.md) |
| 廃止理由 | 非該当 |
| 後継画面ID | 非該当 |

## 目的

ユーザーがデスクトップ体験と秘密でない設定を安全に変更し、外部依存・local data・配布artifactの利用可否を秘密値なしで診断・復旧できるようにする。音声、Live2D、通知が利用不能でもCodex sessionとtext情報を維持する。

## 対象範囲

### 含める

| 対象 | 内容 |
|---|---|
| general・appearance | 日本語/英語、system/light/dark theme、OSのreduced motion・high contrast・text scale状態を扱う。 |
| Live2D | 同梱1model、asset/renderer、publisher免除条件、SDK/EULA/再配布記録、logo・notice、明示retryを扱う。 |
| audio commentary | TTS enabled、mute、volume、組込みvoice、言語、AI音声同意、text-only縮退を扱う。 |
| TTS credential | Codex loginとは別のOpenAI Platform API keyをwrite-onlyで設定・状態確認・削除する。 |
| notifications | OS permissionと、質問・main完了・回復不能失敗の3通知だけを設定する。 |
| history・privacy | session/workspace履歴の明示削除、保持境界、redaction、analyticsなし方針を表示する。 |
| diagnostics | Codex CLI/App Server/model/schema、Git、storage、Live2D/WebGL、TTS/audio、OS artifactを一括・個別診断する。 |
| release/install | 3OS artifactの検証水準、version、checksum、署名、macOS install/launch手順を表示する。 |

### 含めない

| 非対象 | 理由 | 扱う画面・文書 |
|---|---|---|
| model、sandbox、approval policyの変更 | main実行契約を固定するため | read-only値と不一致診断だけ表示 |
| Codex CLIのinstall、update、login credential入力 | ユーザー導入済みCLIと公式loginを正本にするため | 公式手順への案内と再診断 |
| Live2D modelのimport、交換、path/URL/drop | 同梱許諾model 1体へ配布境界を閉じるため | [live2d-companion要件](../requirements/live2d-companion/requirements.md) |
| custom voice、audio file、microphone、STT | output-onlyの短いTTSへ限定するため | [audio-commentary要件](../requirements/audio-commentary/requirements.md) |
| timeline、diff、test、reviewの詳細閲覧 | 設定と診断へ集中するため | [S-003 セッション証跡](S-003_session-evidence.md) |
| updater、store、notarization、paid signing | ハッカソン版の無料配布範囲外のため | bundled install guideとartifact情報だけ提供 |
| history export/import、remote telemetry、product analytics | local-firstと期限内実装を守るため | 本画面に入口を設けない |

## 表示契機と終了

| 項目 | 内容 |
|---|---|
| 表示契機 | 主navigationの`設定 / Settings`、first-run同意拒否後、回復不能failure通知、[S-001 セッションダッシュボード](S-001_session-dashboard.md)・[S-002 コーディングワークスペース](S-002_coding-workspace.md)・[S-003 セッション証跡](S-003_session-evidence.md)の診断link。 |
| 表示前提 | `main`が存在する。SQLiteが開けない場合もbundled static shellで復旧sectionとQuitを表示する。sidecar、network、credential storeは不要。 |
| 初期フォーカス | page heading。遷移元がcheck IDまたは設定fieldを指定した場合は、heading読み上げ後に対象sectionへfocusを移す。 |
| 正常完了 | non-secret設定はfield単位でRust検証後にatomic保存する。戻る操作は直前のvalid route、なければ[S-001 セッションダッシュボード](S-001_session-dashboard.md)へ移動する。 |
| キャンセル | secret入力を消去し、確認modalを変更なしで閉じ、起点へfocusを戻す。保存済み設定は戻さない。 |
| 閉じる操作 | [共通仕様の閉じる操作](desktop-common-specification.md#閉じる操作)どおり非表示にする。診断とTTSの継続・停止は各要件に従う。 |
| 再表示 | 選択section、non-secret保存値、最新診断statusを復元する。API key欄、確認入力、sample audio、diagnostic running要求は復元しない。 |

## 利用者と権限

| 利用者・ロール | 表示 | 操作 | 拒否時の動作 |
|---|---|---|---|
| ユーザー | 可 | 設定、key設定・削除、通知要求、履歴削除、診断、copy、renderer retry、緊急停止 | 項目別errorと安全な次操作を表示 |
| Full access未同意ユーザー | 可 | 全設定、local診断、release情報、Quit | Codex sidecarを必要とするcheckだけ`unavailable` |
| React WebView | redacted view modelだけ可 | typed setting/check/target IDを要求 | secret読取、任意path、URL、shell、SQLを拒否 |
| Tauri / Rust | 信頼境界 | credential、process、Git、SQLite、network、audio、clipboard、notification | 影響componentだけをfail/unavailableにする |
| main/support agent | read-onlyの診断対象 | effective環境とstatusを提供 | 設定、credential、履歴削除を実行させない |

## 画面構成

単一route内を次のsection navigationで切り替える。sectionは別画面IDにせず、左navigationとmain panelを1つずつ表示する。800×600ではnavigationを上部selectへ折り畳む。

| 領域 | 表示内容 | 主な操作 |
|---|---|---|
| persistent header | `設定・診断 / Settings & diagnostics`、戻る、全session状態、常時表示の`緊急停止 / Emergency stop` | 戻る、緊急停止 |
| General | UI language、theme、app version、固定main model/sandbox/approvalのread-only表示 | locale/theme変更 |
| Accessibility | OS reduced motion、forced colors/high contrast、text scale、keyboard modeの現在値 | OS設定手順を確認 |
| Companion | 同梱model preview、animated/static/hidden、manifest、publisher/SDK/EULA/再配布記録、logo/creator notice。import UIは0件 | renderer retry、license・release gate表示 |
| Audio commentary | TTS enabled、mute、volume、voice、narration language、AI音声表示、text-only status | setting変更、sample診断 |
| API key | Platform API keyの未設定/設定済み/credential store利用不能。値、長さ、末尾文字は表示しない | masked key設定、key削除 |
| Notifications | OS permission、app preference、対象3イベント | permission要求、app内通知切替 |
| History & privacy | retention、保存しないdata、session/workspace別の履歴件数、danger zone | 履歴削除、privacy説明 |
| Diagnostics | 全check summary、component別status、開始/終了UTC、error code、再試行可否 | 一括・個別実行、redacted copy |
| Release & install | current OS/arch、artifact、preview/実機、checksum、signing、macOS install/launch guide | offline手順・manifest表示 |

### 表示優先順位

1. 回復不能なstorage/migration errorは全section上部のpersistent alertにする。
2. 緊急停止はalertやmodalがあってもheaderとtrayから到達可能にする。履歴削除確認中はmodal内にも同じ操作を置かず、`Escape`で閉じてheaderへ戻れるようにする。
3. component warningは該当sectionだけに表示し、Live2D/TTS/notificationの失敗で他sectionを置換しない。
4. setting保存statusはfield直下、診断statusはcheck row、全体summaryはDiagnostics heading直下に表示する。

### 診断check matrix

| Check group | 表示する判定材料 | 主な失敗分類 | 要件ID |
|---|---|---|---|
| Codex CLI | executable検出、exact `0.144.5`、login | missing、version mismatch、not logged in | CODE-F-001〜CODE-F-006 |
| App Server | stdio child、initialize、stable/experimental schema fingerprint | spawn、handshake、schema、protocol | CODE-F-007〜CODE-F-011 |
| main/model policy | `gpt-5.6-sol`、cwd、Full access、approval never、組織policy | model unavailable、effective mismatch、policy denied | CODE-F-012、CODE-F-017〜CODE-F-020 |
| effective environment | AGENTS、skills、MCP、plugins、apps、support model catalog | load/auth/unavailable/fallback | CODE-F-033〜CODE-F-037、SUP-F-020〜SUP-F-027 |
| Git/worktree | Git version、GitHub origin/default head、選択sessionのrepository・branch・linkage | invalid、auth、operation in progress、repair required | WORK-F-004〜WORK-F-013、WORK-F-031〜WORK-F-034 |
| storage/history | app data read/write、schema、integrity、backup、free bytes、evidence refs | write、newer schema、migration、integrity、missing ref | HIST-F-022〜HIST-F-025、HIST-F-031 |
| model asset | descriptor、manifest/hash、1 model、16 expression、notice、preview | missing、extra、hash、expression | LIVE-F-001〜LIVE-F-011、LIVE-F-036〜LIVE-F-037 |
| Cubism release | 個人/General User・年商1,000万円未満・非Expandable、SDK/EULA/RedistributableFiles、end-user条項、logo/言及、3OS実artifact | 条件不明/変更、配布file/notice不備、WebView smoke | LIVE-F-010〜LIVE-F-011、LIVE-F-046〜LIVE-F-049、APP-F-032、APP-F-038 |
| WebGL renderer | context、renderer tier、static/hidden fallback、explicit retry | unavailable、context loss、shader/texture | LIVE-F-038〜LIVE-F-040、LIVE-F-043〜LIVE-F-049 |
| TTS/audio | fixed endpoint/model、credential state、API分類、default output、sample、last success | text only、invalid key、rate limit、API/device unavailable | NARR-F-031〜NARR-F-048 |
| OS artifact | OS/arch/version、package、startup smoke、preview、SHA-256、signing/install guide | unsupported OS、checksum、smoke、unsigned warning | APP-F-037〜APP-F-040、APP-F-047〜APP-F-051 |

各checkは`running`から`pass`、`warn`、`fail`、`unavailable`の1値へ遷移する。同じcheckの同時実行は1件までとし、前回結果を薄く表示しつつ現在実行中であることをtextで示す。

## 表示状態

| 状態 | 進入条件 | 表示 | 操作可否 | 状態から抜ける条件 |
|---|---|---|---|---|
| 初期化中 | setting schemaと保存済みstatusを読込中 | section skeleton、`設定を読み込み中… / Loading settings…` | 緊急停止、Quitだけ可 | 読込成功または復旧状態 |
| 通常 | local storageが利用可能 | 保存値、component cards、最新check | 全操作を条件付きで可 | 保存、診断、offline、error |
| データなし | key未設定、session未選択、履歴0件のいずれか | 各section内empty state。全画面emptyにはしない | key設定、general check、release閲覧可 | 対象data追加またはsession選択 |
| 処理中 | setting保存、診断、key操作、history delete中 | 対象rowのprogress、cancel可否、status live region | 対象の二重操作だけ不可。緊急停止は可 | terminal result |
| オフライン | network利用不可 | offline banner。local settings/storage/Git/model asset/WebGLは診断可 | Speech/APIとonline Codex checkはunavailable。local操作可 | 接続後の明示再診断 |
| エラー | field検証、component、clipboard、notificationの継続可能失敗 | fieldまたはrow単位のerror、短いcode、再試行 | 影響外sectionと緊急停止は可 | 修正または明示再試行 |
| 権限不足 | credential store、notification、audio、Git/fs権限拒否 | 拒否機能、OS別確認手順、現在値 | permission再要求は初回明示操作だけ。設定・診断は継続 | OS設定変更後の明示再診断 |
| storage復旧専用 | integrity/migration/DB open失敗 | redacted code、backup有無、`再試行`、`新規databaseで開始`、release情報 | sidecar/session/TTS設定保存は不可。緊急停止、Quit可 | integrity合格または明示新規DB |
| emergency stopped | 緊急停止完了 | 全session停止、既存変更非rollback、sidecar/child診断へのlink | local設定・診断・履歴閲覧可。新規turn不可 | 診断合格後に各sessionを明示再開 |

## 操作

| 操作 | 事前条件 | 正常結果 | キャンセル時 | 失敗時 | 関連要件ID |
|---|---|---|---|---|---|
| localeを変更 | `ja`または`en` | 4 routes、tray、通知、error、diagnosticを即時切替して保存 | 直前値 | field error、直前localeを維持 | APP-F-027、APP-F-044 |
| themeを変更 | `system`、`light`、`dark` | atomic保存し、`system`はOS変更に追従、明示themeは維持。forced colorsはOS優先 | 直前値 | 全fieldを直前commitへ戻しcontrastを維持 | APP-F-027、APP-F-046 |
| Live2D rendererを再試行 | staticまたはhidden | asset検証と初期化を各1回行いstatusを更新 | 非該当 | 縮退表示とtext statusを維持 | LIVE-F-036〜LIVE-F-041 |
| TTS設定を変更 | input境界内 | mute/disableは即時、volumeは250 ms以内、voice/languageは次文から適用 | 直前値 | 全fieldを保存せず項目別error | NARR-F-049〜NARR-F-052、APP-F-027 |
| API keyを設定 | 1〜512 ASCII、前後空白なし | credential store成功状態だけを返しinputを消去 | keyを消去 | keyを保持せずstore復旧・再入力を表示 | NARR-F-035〜NARR-F-037、APP-F-028 |
| API keyを削除 | 設定済み、確認済み | 再生/生成を停止し`deleting`を保存、store削除成功後だけ`unset`/text-only | 操作前なら0件変更 | 失敗・再起動は`delete_failed`/text-onlyとし、削除済みと推測せず再試行 | NARR-F-036〜NARR-F-037、NARR-F-043〜NARR-F-044、NARR-F-052、APP-F-028 |
| TTSを初回有効化 | valid key、AI音声・外部data説明の確認済み | TTS enabledを保存し次のvalid textから音声化 | text-onlyを維持 | text-onlyと理由を表示 | NARR-F-038〜NARR-F-041、NARR-F-050 |
| notificationを有効化 | app preferenceがoff | OS permissionを1回要求し、許可時だけon | offを維持 | 再要求せずapp内状態を維持 | APP-F-022〜APP-F-023 |
| session履歴を削除 | running/waitingが0件 | `secure_delete=ON`、WAL checkpoint、FTS/cache/owned file/backup消去を行い、app query/再起動から復元不能にする。Git/worktreeは維持 | 0件変更 | cleanup不完全は完了表示せず再試行 | HIST-F-032、HIST-F-034〜HIST-F-035 |
| workspace履歴を削除 | 全sessionが終了条件合格 | 対象全recordとapp-owned派生dataを同境界で消去 | 0件変更 | 1件でも実行中またはcleanup失敗なら完了表示しない | HIST-F-033〜HIST-F-035 |
| 診断を一括・個別実行 | 同じcheckがrunningでない | check ID、status、UTC、error、再試行可否を更新 | 未開始checkを維持 | 対象checkだけfail/unavailable | APP-F-029〜APP-F-033 |
| 診断summaryをcopy | terminal checkが1件以上 | redacted textだけをclipboardへ渡す | 非該当 | 元表示を維持しcopy失敗 | APP-F-034、GIT-F-038 |
| 緊急停止 | 常時 | 新規実行を拒否し全turnをinterrupt、audio停止、必要時child kill、app/data/worktreeを維持 | 非該当 | 残存childとerrorを診断へ表示 | APP-F-017〜APP-F-019 |

## 入力項目

| 項目 | 初期値 | 必須 | 制約・境界 | エラー表示 | 保存契機 |
|---|---|---|---|---|---|
| UI language | OS locale | 必須 | `ja`または`en` | 直前値を維持 | valid選択時 |
| theme | `system` | 必須 | `system`、`light`、`dark`。forced colors時はOS優先 | 直前値と許可値を表示 | valid選択時 |
| reduced motion / high contrast | OS値 | read-only | OS media settingを反映しapp overrideなし | 検出不能なら`不明 / Unknown` | 保存しない |
| TTS enabled | `false` | 必須 | valid key・AI音声確認後だけ`true` | text-only理由 | valid toggle時 |
| mute | `false` | 必須 | boolean | 直前値 | valid toggle時 |
| volume | `70` | 必須 | integer 0〜100 | 実値と境界 | valid change時 |
| voice | `cedar` | 必須 | `alloy`、`ash`、`ballad`、`coral`、`echo`、`fable`、`onyx`、`nova`、`sage`、`shimmer`、`verse`、`marin`、`cedar` | 直前voice | valid選択時 |
| narration language | `ui` | 必須 | `ui`、`ja`、`en` | 直前値 | valid選択時 |
| Platform API key | 空 | 設定時に必須 | masked、1〜512 ASCII、前後whitespaceなし、write-only | 値を消去し再入力案内 | credential保存成功時。値はSQLiteへ保存しない |
| AI音声確認 | 未確認 | 初回TTS有効化時 | current説明versionへの明示確認 | TTSを有効化しない | 確認時 |
| notification preference | OS状態 | 必須 | boolean。on操作時だけOS permission要求 | 拒否状態とapp内fallback | permission結果時 |
| history delete target | 未選択 | 削除時に必須 | 保存済みsessionまたはworkspace ID、件数、running/waiting 0件 | 対象と拒否理由 | 削除transaction成功時 |
| delete confirmation | 未選択 | 条件付き | `削除 / Delete`または`キャンセル / Cancel` | 未選択では実行しない | 操作eventだけ保存 |

Live2D model/path/URL、Codex model/sandbox/approval、custom voice、Git argument、database pathの入力欄は提供しない。

## ネイティブ連携

実際のCapability設定は`src-tauri/capabilities/`を正本とする。

| ユーザー操作 | 実行境界 | Tauri plugin / Command | 必要なCapability・認可 | キャンセル時 | 拒否・失敗時 |
|---|---|---|---|---|---|
| setting保存 | Rust + SQLite | typed settings command | allowlist field、schema、single writer | 直前値 | transaction全体をrollback |
| API key設定・削除 | Rust + OS credential store | typed set/delete command | user gesture、write/deleteだけ。read valueなし | 開始前ならmemoryをzeroizeし変更0件 | `ready|deleting|unset|delete_failed`だけ返し、失敗はtext-only |
| notification permission | OS notification plugin | permission request | user gesture、未決定時だけ | preference off | 再要求せずapp内fallback |
| diagnostic process/Git | Rust child process | fixed check commands | executable/argument allowlist、timeout、redaction | 未開始checkを維持 | childを終了し分類だけ返す |
| Speech/audio sample | Rust HTTP + output device | fixed Speech check | valid key、AI音声確認、fixed endpoint、no microphone | streamを停止 | text-only、mouth closed |
| model asset/WebGL retry | bundled asset + WebView renderer | fixed retry command | manifest containment、1 retry | 縮退維持 | external assetを探索しない |
| history削除 | Rust + SQLite/app-owned data | typed delete command | target ownership、終了条件、transaction | 0件変更 | partial完了を表示しない |
| diagnostic copy | OS clipboard | write text | redaction済みallowlist fieldだけ | 非該当 | 元表示を維持 |
| install/release資料 | bundled static document | open bundled resource | network・任意file path不要 | 画面維持 | offline資料を維持 |

## ウィンドウ固有動作

[デスクトップ共通仕様](desktop-common-specification.md)との差分は次のとおり。

| 項目 | 動作 |
|---|---|
| 生成・再利用 | 既存`main`の`/settings` routeを再利用し、credential、診断、license用windowを作らない。 |
| 初期サイズ・最小サイズ | 共通保存値。800×600でsection navigationをselectへ折り畳み、headerの緊急停止を常時表示する。 |
| リサイズ | 可。main panelを最大80文字程度にし、diagnostic tableはrow cardへ折り畳む。 |
| 最大化・全画面 | 共通仕様どおり可。 |
| 常に手前へ表示 | 不可。 |
| 閉じる操作 | 共通仕様どおり非表示。未保存API keyは即時消去し、保存済みTTS再生はcloseだけでは停止しない。 |
| 未保存変更がある場合 | non-secret settingはvalid changeごとに保存。secret入力と未確定modalだけを破棄する。 |

## メニュー・ショートカット

| 操作 | macOS | Windows / Linux | 有効条件 | 実行結果 |
|---|---|---|---|---|
| focus移動 | `Tab` / `Shift+Tab` | 同左 | 常時 | header、section navigation、main panelの順に移動 |
| section移動 | 矢印キー | 同左 | section navigation focus時 | focusと選択sectionを変更 |
| control実行 | `Enter` / `Space` | 同左 | enabled control | 1回だけ実行 |
| modalを閉じる | `Escape` | 同左 | cancel可能modal | secretを消去し起点へ戻る |
| 明示Quit | `Command+Q` | `Ctrl+Q` | 共通仕様の条件 | 共通Quitを開始 |

緊急停止をglobal shortcutへ登録しない。keyboard利用者はskip link直後のheader buttonまたはtrayから常に実行できる。

## データ保持

| データ | 正本・保存先 | 保存契機 | 復元契機 | 破棄条件 | 失敗時 |
|---|---|---|---|---|---|
| locale、theme、TTS、notification | local SQLite | valid field transaction | 起動・再表示 | 明示変更または履歴削除範囲 | 直前値を維持 |
| API key | OS credential store | 明示設定成功時 | 値を読まずstatus照会 | 明示削除成功 | `deleting/delete_failed`はTTS disabled/text-only、再試行 |
| diagnostic result | local SQLiteの構造化event | check terminal時 | S-004再表示 | 対象履歴削除 | 前回結果と失敗を区別 |
| model manifest・notice | application bundle | build時 | 起動・retry | app更新 | invalidならstatic/hidden |
| release manifest・guide | application bundle | build時 | S-004表示 | app更新 | checksum/statusをfail表示 |
| history/evidence | local SQLite | 各producer transaction | S-002/S-003/S-004 | 明示session/workspace削除 | partial削除を完了扱いしない |
| audio、key input、raw diagnostic output | 保存しない | 非該当 | 非該当 | 操作終了時に破棄 | redacted statusだけ保持 |

## OS差分

| 項目 | macOS | Windows | Linux |
|---|---|---|---|
| credential store | Keychain | Windows Credential Manager | Secret Service互換store。利用不能時はtext-only |
| notification | macOS permission/status | Windows notification permission/status | desktop notification service。利用不能時はapp内表示 |
| audio output | default CoreAudio outputを実機検証 | adapter CI、実機未検証 | adapter CI、device実機未検証 |
| Live2D/WebGL | Apple Silicon実機保証、renderer retry可 | CI済みpreview、実機未検証 | Ubuntu 24.04 CI済みpreview、実機未検証 |
| artifact | ad-hoc signed `.dmg`、SHA-256、JA/EN guide、user `.sh` | unsigned `.msi`、SHA-256、preview | `.AppImage`、SHA-256、preview |
| install表示 | `$HOME/Applications`既定、sudoなし、Gatekeeper riskとOS標準`開く`を先に案内 | install/uninstall smoke結果 | executable permission/start smoke結果 |

## アクセシビリティ

- skip link、header、section navigation、main heading、field/check statusの順を一意にし、section変更時は同名headingへfocusする。
- emergency stopは最初の主要actionとして明確なaccessible nameを持ち、色だけに依存せず、確認なしで即時実行することを説明する。
- switch、slider、select、secret inputへvisible label、current value、help、errorを関連付ける。volumeは矢印キーで1、Page Up/Downで10ずつ変更できる。
- API keyのmasked状態、保存済み/未設定/利用不能を読み上げるが、文字数や末尾文字をaccessible nameへ含めない。
- diagnostic status、preview、permission、artifact保証水準をtextとicon形状で示し、table headerまたはdescription listを関連付ける。
- forced colorsではOS colorを優先し、theme選択でcontrastを下げない。reduced motionでは装飾transition、Live2D animation、sample連動lip-syncを停止してtextを維持する。
- 200% text zoom、100/150/200% DPI、800×600で横scrollなしにsetting保存、診断、履歴削除、緊急停止へ到達できる。

## 表示文言例

| 用途 | 日本語 | English |
|---|---|---|
| API key分離 | `TTSにはCodexログインとは別のOpenAI Platform API keyが必要です。` | `TTS requires an OpenAI Platform API key separate from your Codex login.` |
| AI音声 | `音声は人間ではなくAIが生成します。` | `This voice is generated by AI, not a human.` |
| key状態 | `API keyは設定済みです。値は表示できません。` | `The API key is set. Its value cannot be displayed.` |
| bundled model | `許諾済みの同梱モデル1体を使用します。モデルの追加・交換はできません。` | `This app uses one licensed bundled model. Models cannot be added or replaced.` |
| Cubism公開条件 | `個人・年商1,000万円未満・非Expandableの記録に基づき公開免除条件を判定します。` | `Release eligibility is based on the recorded publisher scale and non-Expandable design.` |
| preview artifact | `CIでbuild/test済み。実機では未検証です。` | `Built and tested in CI. Not verified on physical hardware.` |
| emergency | `緊急停止は処理と音声を止めます。既存の変更は元に戻しません。` | `Emergency stop halts work and audio. It does not undo existing changes.` |
| history delete | `アプリ履歴を削除します。Git branch、worktree、ソースファイルは削除しません。` | `This deletes app history. Git branches, worktrees, and source files are kept.` |

## 分析・telemetry

analytics SDK、tracking pixel、remote crash upload、usage telemetry、A/B test、診断自動送信を実装しない。local diagnostic eventはユーザーがS-004で見るためだけに保存し、`診断情報をコピー`もclipboardへ渡すだけでnetwork送信しない。

## 画面受け入れ条件

1. locale/theme/TTS/notificationのvalid変更だけがatomic保存され、system/explicit themeとOS forced colorsの優先順が守られ、不正値・write失敗は直前commitを維持する。
2. API key削除は`deleting`でaudioを停止し、store消去成功だけ`unset`、失敗・再起動は`delete_failed`/text-onlyとなる。key値はUI、request memory、SQLite、logへ残らない。
3. Live2Dは同梱1model、publisher免除条件、SDK/EULA/再配布記録、logo/noticeのgateが合格し、picker/drop/URL/path/import/swapが0件である。不備時は配布をblockする。
4. 診断matrixの全checkが一括・個別に実行でき、status、UTC、error、再試行可否を表示し、copy結果にsecret、会話、code、absolute pathがない。
5. session/workspace履歴削除はrunning/waitingを拒否し、app UI/query/再起動から対象を復元できない場合だけ完了とする。Git/worktree/source/Codexは不変で、OS backup/snapshot/forensic eraseは保証外と表示する。
6. 緊急停止は全stateでkeyboardから到達でき、既存変更をrollbackせずturn/audio/managed childを定義時間内に停止する。
7. macOS実機保証とWindows/Linux preview、artifact checksum、signing、install/launch手順が日英で正しく表示される。
8. screen reader、forced colors、reduced motion、200% zoom、800×600で全主要操作を完了できる。

## 関連要件

| 要件ID | この画面での扱い | 要件定義書 |
|---|---|---|
| APP-F-003〜APP-F-004、APP-F-008、APP-F-015、APP-F-019〜APP-F-029 | route、復旧、offline、error、setting、credential、診断起動 | [desktop-shell要件](../requirements/desktop-shell/requirements.md) |
| APP-F-030〜APP-F-046 | component診断、redaction、artifact、security、日英・A11y | [desktop-shell要件](../requirements/desktop-shell/requirements.md) |
| APP-F-047〜APP-F-051 | checksum、ad-hoc signing、macOS guide/shell、Gatekeeper境界 | [desktop-shell要件](../requirements/desktop-shell/requirements.md) |
| CODE-F-001〜CODE-F-012、CODE-F-017〜CODE-F-020 | CLI、login、App Server、schema、model/policy診断 | [codex-main-session要件](../requirements/codex-main-session/requirements.md) |
| CODE-F-033〜CODE-F-037、CODE-F-046〜CODE-F-050 | effective環境、障害、offline、secret診断 | [codex-main-session要件](../requirements/codex-main-session/requirements.md) |
| SUP-F-020〜SUP-F-027 | support model catalog、preset、fallbackのread-only診断 | [support-agent-orchestration要件](../requirements/support-agent-orchestration/requirements.md) |
| WORK-F-004〜WORK-F-013、WORK-F-021〜WORK-F-022、WORK-F-031〜WORK-F-034 | repository/worktree診断、作成失敗、repair | [workspace-sessions要件](../requirements/workspace-sessions/requirements.md) |
| GIT-F-006、GIT-F-009〜GIT-F-012、GIT-F-017、GIT-F-034、GIT-F-038〜GIT-F-041 | evidence/skill/Git診断、redaction、復元 | [git-review-harness要件](../requirements/git-review-harness/requirements.md) |
| HIST-F-022〜HIST-F-025、HIST-F-031〜HIST-F-036 | storage復旧、参照欠落、履歴削除・保持 | [activity-history要件](../requirements/activity-history/requirements.md) |
| LIVE-F-001〜LIVE-F-011、LIVE-F-036〜LIVE-F-041 | bundled model境界、asset/WebGL縮退とretry | [live2d-companion要件](../requirements/live2d-companion/requirements.md) |
| LIVE-F-043〜LIVE-F-049、LIVE-F-051、LIVE-F-053〜LIVE-F-054 | OS検証、diagnostic redaction、日英・A11y | [live2d-companion要件](../requirements/live2d-companion/requirements.md) |
| NARR-F-031〜NARR-F-042 | Speech API、credential、AI音声・data境界 | [audio-commentary要件](../requirements/audio-commentary/requirements.md) |
| NARR-F-043〜NARR-F-056 | TTS status、縮退、setting、復元、検証、no microphone | [audio-commentary要件](../requirements/audio-commentary/requirements.md) |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| visual design token | common tokenを使い、system/light/darkの3 themeだけを提供する | UI実装時に3 theme×forced colorsのcontrastを確認 | いいえ |
| OS設定link | deep linkに依存せず日英の手順を表示し、OSが安全に提供する場合だけ設定画面を開く | 3OS smokeで利用可否とfallback文言を確認 | いいえ |

## レビュー確認

- [x] front matterの`screen_id`、タイトル、ファイル名の画面IDが一致している。
- [x] `status`が`Draft`である。
- [x] 目的と対象外が一意である。
- [x] 初期化、通常、空、処理中、オフライン、エラー、権限不足を定義した。
- [x] キャンセル、閉じる、再表示、未保存データの動作を定義した。
- [x] ネイティブ操作のCapability・認可と失敗時動作を定義した。
- [x] OS差分を確認し、未確認を共通扱いしていない。
- [x] 関連要件IDを8要件定義書へ照合した。
- [x] 着手をブロックする未確定事項がない。
- [x] `agent-docs lint`が成功した。
