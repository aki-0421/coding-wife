---
title: "S-004 設定・診断"
description: "言語、Context、Live2D model、音声、support、履歴・privacy、起動前提と復旧状態を安全に管理する画面仕様。"
updated: 2026-07-18
read_when:
  - "Settings tab、診断、Live2D import、TTS、support、history/privacy設定を実装するとき。"
  - "S-004とWORK、CODE、SUP、GIT、HIST、LIVE、NARR、APP要件の対応を確認するとき。"
screen_id: "S-004"
status: "Approved"
---

# S-004 設定・診断

| 項目 | 内容 |
|---|---|
| window label | `main` |
| React route / view key | `/settings/:section?` / `settings-diagnostics` |
| 対象OS | macOS 14以降、Apple Silicon |
| デザイン | [DESIGN.md](../../DESIGN.md)、Figma Desktop node `8:2`のshell、[demo.png](../thinking/demo.png) |
| 共通仕様 | [デスクトップ共通仕様](desktop-common-specification.md) |
| 廃止理由 | 非該当 |
| 後継画面ID | 非該当 |

## 目的

利用者がアプリの前提条件、表示、Context、companion、音声、support、履歴を一か所で理解し、安全な範囲で変更・診断・復旧できるようにする。秘密、absolute private path、raw support historyを表示せず、設定失敗がmain coding sessionや現在選択中のLive2D modelを壊さないことを保証する。

## 対象範囲

### 含める

| section | 内容 |
|---|---|
| General | ja/en、reduced motion、version、reset UI state |
| Project context | active project/workspaceのgoal、constraints、definition of done、technical references |
| Character context | name、tone、speech density、表現上の禁止事項。technical policyから分離 |
| Companion | bundled Hiyori、custom model import、inventory、preview、semantic mapping、hide、provenance、delete |
| Audio | default off、separate API key、voice、rate、test、mute、text fallback |
| Support | global/role enable、active/queue/budget、usage、last error、policy固定値 |
| Diagnostics | OS/app、Codex、Git、DB、Live2D、audio、support、capability、error code、retry |
| History & Privacy | persistence内容、redaction、workspace history削除、migration/recovery、non-persistence |

### 含めない

| 非対象 | 理由 | 代替 |
|---|---|---|
| account/login credential本文の表示 | secret boundaryを守る | CodexはAuthenticated/Blocked statusだけ |
| arbitrary executable/path設定 | allowlist外process/filesystemを公開しない |目的別pickerとpreflight |
| model picker for Codex | main modelは`GPT-5.6 Sol`固定 | availability/capability診断だけ |
| microphone / speech input | output-only audio契約 | text composer |
| support prompt/response閲覧 | ephemeral/non-persistence契約 | usage metadataとdeterministic fallback |

## 表示契機と終了

| 項目 | 内容 |
|---|---|
| 表示契機 | Settings tab、sidebar gear、preflight/permission/errorの診断link、model/audio/support fallback link |
| 表示前提 | app DBがread可能。破損時はread-only Diagnostics/History recoveryだけを表示する |
| 初期フォーカス | routeのsection heading。unknown sectionはGeneral headingへreplace遷移する |
| 正常完了 | section単位の保存成功をinline表示し、元routeへ戻って設定を即時反映する |
| キャンセル | picker、preview、test、confirm開始前の保存済み設定と入力を維持し、errorを出さない |
| 閉じる操作 | [共通close契約](desktop-common-specification.md#windowとtitlebar)に従う。import/test/supportを停止する |
| 再表示 | selected section、section scroll、保存済み値、診断結果を復元する。secret値は復元表示しない |

## 利用者と権限

| 利用者・ロール | 表示 | 操作 | 拒否時の動作 |
|---|---|---|---|
| ローカル利用者 | non-secret setting、status、inventory、usage、sanitized diagnostic | edit、import、preview、select、test、delete、retry、history削除 | invalid/unsafe operationを開始せず理由を表示 |
| React WebView | typed setting、pack ID、secret set/unset、diagnostic summary | render、input、typed IPC | source absolute path、raw key、arbitrary commandを保持しない |
| Rust settings service | SQLite、secret store、filesystem quarantine、process/Git diagnostics | validate、transaction、import、store secret、diagnose、cleanup | scope外path/schema/secret requestを拒否 |
| Live2D preview worker | verified quarantine/library pack | first frameとstate test | WebView DOM、network、script、root外assetへaccessしない |
| TTS adapter | secret handle、redacted transcript、voice/rate | fixed sample request、playback、cancel | source/event payload、repo/path、microphoneを使用しない |
| Support policy | role config、usage metadata | queue/budget/disable/cancel | outputによるpolicy/model/DOM変更を許可しない |

## 画面構成

sidebarと81px headerは他画面と同じ位置を維持し、Settings tabまたはgearをactiveにする。bodyは設定専用のsection navigationとform/detailに再構成する。

| 領域 | 標準1470×836 | 表示内容 | scroll owner |
|---|---:|---|---|
| workspace sidebar | 255.04px | workspace selection、gear | workspace list |
| settings section nav | body内228px | 8 section、attention/error badge | nav単独 |
| settings main | 残幅、content max 780px | section heading、status、field、preview、danger zone | main単独 |
| sticky action row | main下部、必要sectionだけ | Save / Cancel / Test cancel / Import cancel |固定 |

section navは表の順にし、同型card gridではなく一つのform flowを使う。960〜1279pxではnavをportal drawerへ移してmainを最低640px確保する。960×640の200% text zoomでは実効480px幅の単一columnへ切り替え、section navとmainを別々に縦scroll可能にする。説明文とdanger actionを横方向にclipせず、actionをwrapし、danger actionをprimary actionと隣接させない。

## section仕様

### General

| setting | 契約 | 即時反映 | 永続化 |
|---|---|---|---|
| Language | `日本語` / `English`。初回はOS localeが`ja`開始ならja、他はen | sidebar、tab、error、decision、Settings、notification | Rust SQLite |
| Reduced motion | OS preferenceを初期値にapp override `System / Reduce / Allow` | transition、Live2D、decorative motion | Rust SQLite |
| App version | semantic version、build、schema versionをread-only表示 | 非該当 | bundle/DB metadata |
| Reset UI state | geometry、active section、filter、scrollをsafe defaultへ | confirmation後 | domain history、context、Git、model、audio keyは削除しない |

language変更中もuser content、path、branch、SHA、model名、commit messageを翻訳しない。切替は100ms以内にvisual feedbackを出し、再起動を要求しない。

### Project context

active project/workspaceを明示し、[S-002 Context subview](S-002_coding-workspace.md#context-subview)と同じversioned storeを編集する。

| field | 初期値 | 制約 | 適用 |
|---|---|---|---|
| Goal | current version | 0〜8,000 Unicode scalar | main/support snapshotのgoal |
| Constraints | current version | 0〜8,000、secret警告 | technical decision boundary |
| Definition of done | current version | 0〜20項目、各1〜500 | work unit acceptance補助 |
| Technical references | managed doc ID / repo-relative path | canonical project root内、absolute path非保存 | mainのみ。supportへ本文を渡さない |
| User notes | current version | 0〜8,000 | next turnから適用 |

保存時にexpected versionを検証し、競合時はremote/currentの差と再読み込みを示す。running turnへ途中適用せず、`次のturnから適用`と表示する。project登録解除はsource、Git object、branchを削除せず、[S-001](S-001_session-dashboard.md)の確認契約を使う。

### Character context

| field | 初期値 | 制約 | 適用 |
|---|---|---|---|
| Display name | `Sol` | 1〜40文字 | visible companion identity |
| Tone | concise / warm / neutral等のallowlist + 0〜1,000文字補足 |感情的強制や虚偽確信を要求できない | assistant presentation |
| Speech density | quiet / key events / detailed | audio eligibility上限を越えない | visible transcript/audio候補 |
| Companion behavior | cue preference | inventory内cueだけ | Live2D presentation |
| Prohibited expressions | 0〜20項目、各1〜200 | safety/error/decisionの事実表示は抑止できない | output presentation |

Character contextはpermission、model、tool、Git gate、checkpoint、verification、approval、privacy、support capabilityを上書きできない。technical policy keyを含む入力は保存前に拒否し、Project contextへ自動コピーしない。running turnには次turnから適用する。

### Companion

#### bundled Hiyori

build時の入力はrepositoryの`tmp/hiyori_pro`とし、release resourceにはruntimeに必要な次の17 fileとnoticeだけをcopyする。

- `hiyori_pro_t11.model3.json`、`.moc3`、texture 2件、physics、pose、cdi、motion 10件。
- `.cmo3`、`.can3`、`.DS_Store`、authoring cache、不要source assetは配布へ含めない。
- install後はimmutable `builtin:hiyori_pro` packとしてapp resourceから解決し、sourceの`tmp/` pathをruntime/UIへ渡さない。
- pack name、creator、source notice、bundled version、manifest hashへCompanion sectionから到達できる。

#### library

| 項目 | 表示・操作 |
|---|---|
| Bundled | Hiyori preview、selected project数、provenance。Delete不可 |
| Custom | pack name、thumbnail、motion/expression count、size、hash、selected project数 |
| Hide character | canvas/GPU animationを停止し、Chat幅とHTML text stateを残す。再起動後も復元 |
| Select | preview first frameとstate test成功後だけproject単位で有効 |
| Delete | active projectで未選択のcustom packだけ。確認後にapp-private copyを削除 |

#### custom model import

1. `Import model`からnative file pickerを開き、regular `.model3.json`を1件だけ選ぶ。
2. Rustがsource rootをcanonicalizeし、参照closureを収集する。Moc、Textures、Physics、Pose、DisplayInfo、Expressions、Motions、UserDataの存在する参照だけを扱う。
3. `..`、absolute path、`file:` / `http:` / `https:`、symlink/alias解決後のroot外、HTML、JavaScript、実行可能fileを一つでも含むpackはcopy前に拒否する。
4. file数128以下、合計100MiB以下、1 file 32MiB以下、texture各8192×8192以下、JSON depth 64以下を検証する。
5. file数、合計size、motion/expression inventory、検証resultを表示し、続行時だけapp-private quarantineへ全fileをcopyする。
6. quarantine内で再hash、closure、MOC compatibility、decoder、first frame、state testを行う。WebViewへはtemporary preview handleだけを返す。
7. manifest作成後のatomic rename成功時だけlibraryへpack UUIDを登録する。source absolute path/home pathはpayload、DB、logへ保存しない。
8. preview成功後だけ`このprojectで使用`を有効にする。失敗/cancel時はquarantineを削除し、現在modelとSettings入力を維持する。

#### semantic mapping

| operational state |選択可能なcue | fallback |
|---|---|---|
| idle | inventory内motion/expression/parameter | neutral pose + text |
| thinking | inventory内cue | neutral + `考えています` |
| acting | inventory内cue | neutral + `作業中` |
| waiting_for_user | inventory内cue | neutral + `回答待ち` |
| reviewing | inventory内cue | neutral + `検証中` |
| error | inventory内cue | neutral + error text |
| completed | inventory内cue | neutral + completion text |
| disconnected | inventory内cue | neutral + offline text |

Hiyoriのdefault mappingは実在する`Idle`、`Flick`、`FlickDown`、`FlickUp`、`Tap`、`Tap@Body`、`Flick@Body`のmotionだけを参照する。expressionが0件でも保存でき、未割当stateはneutralへ戻す。mapping previewは同じstate列で決定的に再生し、reduced motion時はanimationせずstatic pose/icon/textを確認する。

### Audio

fresh profileと`Reset Audio Settings`後はTTSをoffにし、external requestを0件にする。

| setting / control | 契約 | 失敗・cancel |
|---|---|---|
| Enable TTS | default off。明示enable時だけproviderへ接続 | invalid key/offlineならoff相当のtext fallback |
| API key |別用途のkeyをOS secret storeへ保存。UIはset/unsetとreplace/deleteだけ | raw値を再表示、DB、log、diagnosticへ出さない |
| Voice | active UI localeに対応するallowlistだけ | 0件ならTTS disabled |
| Rate | 0.75〜1.25、0.05刻み、初期1.0 | invalid値を保存しない |
| Test |固定ja/en sampleを先にtext表示し、その後request/playback | 5秒timeout。Cancel後100ms以内にabort/stop、設定入力維持 |
| Mute |現在再生を100ms以内に停止しqueue clear、caption維持 | unmute後に過去eventを再生しない |
| Reset | toggle off、voice/rate default、secret削除 |確認cancelで全設定不変 |

provider requestは240文字以下のredacted transcript、voice、formatだけとする。source、absolute path、SHA以外のevent payload、secretを含めない。generated audioはmemory/temporary playbackだけに置き、完了/cancel後に削除する。microphone capability、permission request、入力UIを一切持たない。

### Support

| setting / status | 初期値・制約 | 動作 |
|---|---|---|
| Global enable | default off。tool 0件/cwdなし/fs・shell・MCPなしを強制できるcapability合格時だけon可能 | capability不足またはoffでthreadを起動せず、queued/activeをcancelしdeterministic fallbackを維持 |
| Presence / narration | on | deterministic eventだけで起動 |
| Decision explainer | role policy値 | main decisionを補助し、直接質問しない |
| Checkpoint reviewer | role policy値 | explicit triggerのfixed diff最大1MiBだけ |
| Concurrency / queue | active 1、queue最大10 | 11件目はlow priorityをdropしmetadata記録 |
| Task budget | 15秒、input+output 16,000 token |超過でcancel、fallback |
| Model / effort | GPT-5.6 familyのrole policy固定、read-only | support output/UIから変更不可 |
| Usage | role、status、model family、tokens、latency、queue、last error | prompt/response本文を表示・保存しない |

role toggleをoffにするとqueued taskをcancelし、新規invocationを作らない。active taskは5秒以内にCanceled/Timeoutへ遷移させ、main turnを継続する。non-persistence release auditの最終resultと実施日時へDiagnosticsから到達できる。

### Diagnostics

| check | Ready表示 | Warning / Blocked | 回復操作 |
|---|---|---|---|
| OS / App | macOS version、Apple Silicon、app/build/schema | unsupported OS/arch、migration pending | release note / recovery |
| Codex | executable、protocol initialize、login、`GPT-5.6 Sol`、Fast/Max capability | missing、unauthenticated、model/effort unavailable、disconnect | Recheck、login案内 |
| Git | executable capability、repo/HEAD/identity、read/write条件 | missing、bare、submodule root、LFS mutation、lock、permission | project再選択、refresh |
| DB | integrity、writer、schema、backup | migration rollback、corruption、read-only | backup pathをbasename化してrecovery案内 |
| Live2D | bundled manifest/hash、WebGL、selected pack、first frame | asset/context loss、unsupported MOC、fallback level | Retry、Hiyori選択、text-only |
| Audio | toggle、key set/unset、voice、device、last provider code | offline、invalid key、timeout、deviceなし | Replace key、Test、Mute |
| Support | enable、role、queue、budget、audit、last usage | timeout、schema、policy、non-persistence未検証 | Cancel、Disable、Recheck |
| Security | CSP/capability version、redaction self-check | policy mismatch、future schema event | safe mode、release guidance |

診断はtoken、API key、cookie、完全なhome/source path、support prompt/response、raw stderrを表示しない。各resultはcode、checked time、scope、impact、recoverable、safe detail refを持つ。`Copy diagnostics`は同じsanitized summaryだけをclipboardへ出す。

DB readinessはHistory & Privacyのbadgeと同じnative履歴状態を正本にする。`ready`でない時に`Persisted locally`を表示せず、read-onlyまたはrecovery errorとsanitized codeを一致して表示する。

### History & Privacy

| 項目 | 表示・操作 |
|---|---|
| Stored locally | project/workspace、normalized event、draft、context、checkpoint pack、selected character、settings |
| Never stored | raw reasoning、audio byte、support prompt/response、raw secret |
| Redaction | key/token/cookie/home pathのself-check status、last failure code |
| Schema | current version、last migration、backup、writer queue/integrity |
| Delete workspace history | running turnなしの対象だけ。app DB/artifactを削除し、Git repo/commit/branchを変更しない |
| Recovery | corruption時のread-only mode、backup、retry/locate support情報。自動初期化しない |

history削除dialogはworkspace名、削除するapp data、残るGit data、不可逆性を表示する。Cancel時はrow/artifact数、selection、filterを変えない。削除成功後はS-001のempty/remaining workspaceへ移動し、Git refを消したと表示しない。

## 表示状態

| 状態 | 進入条件 | 表示 | 操作可否 | 状態から抜ける条件 |
|---|---|---|---|---|
| 初期化中 | settings、diagnostics、libraryを読込中 | shell、section nav、field shape skeleton。demo履歴を表示しない | section移動、Quit。保存、context取得、履歴削除は開始しない | query/migration terminal |
| 通常 | DB read/write、section ready | current values、status、section action | edit、save、test、import、diagnose | operation開始/error |
| データなし | custom pack、usage、history対象が0件 |理由と一つの次操作。空table/card gridなし | Import、Support enable、Chatへ戻る |対象data作成 |
| 処理中 | save、diagnose、import/hash、preview、test、delete |対象step、progress、Cancel可能性、他section status |安全なCancel、影響外section | success/cancel/error |
| オフライン | network/Codex/TTS/support unavailable | local setting/library/history、persistent reason | local edit、Live2D、Git/DB診断。external test不可 |明示Recheck成功 |
| エラー | validation、I/O、provider、DB、renderer failure | code、operation、impact、保持値、retry/modify/details |影響外設定 | terminal recovery |
| 権限不足 | picker/library/secret store/process/Git拒否 |拒否scope、OS案内、再選択/再診断。private path非表示 | Cancel、read-only diagnostics | permission変更後のretry |
| キャンセル後 | picker/import/preview/test/delete confirmをcancel |保存済み値、現在model、入力、library/DBを維持。errorなし |元操作または別操作 |次の明示操作 |
| 再起動復旧 | save/import/delete/migrationが中断 | last durable settings、quarantine cleanup、Interrupted operation、backup | diagnose、retry、discard quarantine | integrity/fingerprint確定 |
| read-only recovery | DB corruption/migration rollback | Diagnostics/History、backup、error code、Gitは不変 | copy sanitized diagnostic、Quit | explicit successful recovery |
| secret unavailable | secret store locked/denied | key set状態をUnknownにしTTS off相当 | Replace/Delete/Retry | secret handle確認成功 |
| companion fallback | pack/render failure | current fallback level、Hiyori/text-only、Chat継続 | Retry/Select/Hide | first frame/state test成功 |

## 操作

| 操作 | 事前条件 | 正常結果 | キャンセル時 | 失敗時 | 関連要件ID |
|---|---|---|---|---|---|
| language変更 | supported locale |全shellを即時切替、設定保存 | 非該当 |前locale維持 | `APP-F-057`, `APP-F-058` |
| reduced motion変更 | valid option | UI/Live2Dへ即時適用 | 非該当 | OS preferenceへfallback | `APP-F-061`, `LIVE-F-066` |
| Context保存 | valid section、expected version | version更新、next turn適用 |開始前version維持 |入力保持、field/conflict表示 | `WORK-F-063` |
| model3.json import | picker利用可能 |検証、quarantine、preview後にlibraryへatomic登録 | library/DB/quarantine/current model不変 | current model継続、失敗pack非登録 | `LIVE-F-068`〜`LIVE-F-076` |
| model選択 | first frame/state test成功 | active projectのpack IDを保存、single canvasへ切替 | current selection維持 | current renderer継続 | `LIVE-F-059`, `LIVE-F-075` |
| semantic mapping保存 | inventory内cueまたはneutral | pack mapping version更新 |前mapping維持 | invalid cueを保存しない | `LIVE-F-061`〜`LIVE-F-064`, `LIVE-F-077` |
| custom pack削除 |未選択custom、confirm | library copyとmetadataをatomic削除 | pack/library/DB不変 | packを残しretry | `LIVE-F-078` |
| API key保存/削除 | secret store利用可能 | secret handle状態だけをDB/UIへ反映 |入力clear、保存状態不変 | raw keyをlog/DBへ出さずerror | `NARR-F-064`, `NARR-F-065` |
| TTS test | enable、key、voice、online |固定sampleを表示後再生、audio非永続 | 100ms以内停止、設定入力維持 | text fallback、main不変 | `NARR-F-066`, `NARR-F-067`, `NARR-F-077` |
| support enable/disable | valid role | queue/cancel policy適用、usage metadata記録 | 非該当 | offへfail closed、main継続 | `SUP-F-062`〜`SUP-F-068` |
| 再診断 |対象check選択 | result、checked time、error code更新 |前result維持 | Blocked reason更新 | `CODE-F-051`〜`CODE-F-053`, `CODE-F-075`, `APP-F-070` |
| history削除 | running turnなし、confirm | app DB/artifactだけ削除、Git不変 | row/artifact/selection不変 |削除済みと表示せずrecovery | `HIST-F-049`, `HIST-F-050` |

## 入力項目

| 項目 | 初期値 | 必須 | 制約・境界 | エラー表示 | 保存契機 |
|---|---|---|---|---|---|
| locale | OS由来または前回値 | 必須 | `ja` / `en` |前値維持 | valid変更時 |
| reduced motion | `System` | 必須 | System / Reduce / Allow | Systemへfallback | valid変更時 |
| project context | current version | 任意 |総量32,000 Unicode scalar、secret warning | section内、入力保持 | expected-version transaction |
| character context | current version | 任意 |総量12,000、technical policy key禁止 | section内、入力保持 | expected-version transaction |
| model3.json | なし | import時必須 | regular file 1件、closure/resource/security上限 | import step内、library不変 | atomic promotion成功 |
| mapping | neutral/default | stateごと任意 | inventoryに存在するcueだけ | row内、前mapping維持 | mapping transaction |
| TTS key |表示しない | enable時必須 | secret storeへ直接渡し、WebView persistence禁止 | set/unset statusだけ | secret store success |
| voice | locale候補 | enable時必須 | allowlist voice ID | field直下 | testまたはsave成功 |
| rate | 1.0 | 必須 | 0.75〜1.25、0.05刻みのselect option | field直下 | valid変更時 |
| support toggles | policy default | 必須 | allowlist role boolean | unknown role非保存 | valid変更時 |
| history target | active workspace |削除時必須 | existing workspace ID、running 0 | dialog内 |削除transaction成功 |

## ネイティブ連携

実際のCapability設定は`src-tauri/capabilities/`を正本とし、以下は目的別commandである。

| ユーザー操作 | 実行境界 | Tauri plugin / Command | 必要なCapability・認可 | キャンセル時 | 拒否・失敗時 |
|---|---|---|---|---|---|
| settings/context保存 | Rust DB | `save_settings_section` | allowlist section/key/schema、expected version | transaction前なら不変 |前値維持、field/error code |
| model選択/import | Tauri dialog → Rust importer | `select_and_import_model3` | regular file 1件、canonical root、quarantine、resource limit | library/DB/quarantine不変 | current model継続 |
| model preview/select/delete | Rust asset service | `preview/select/delete_character_pack` | verified pack UUID、project scope、usage check | current state維持 | bundled/selected delete拒否 |
| API key | OS secret store | `set/delete_tts_secret` | service-scoped secret、raw値return禁止 | saved handle不変 | TTS off相当 |
| TTS test/mute | Rust network/audio | `test/cancel_tts` / `set_mute` | allowlist endpoint、redacted fixed sample、no microphone | abort/stop、settings維持 | text fallback |
| support control | Rust supervisor | `configure/cancel_support` | role allowlist、budget固定、main分離 |前config維持 | fail closed + fallback |
| diagnostic | Rust diagnostics | `run_diagnostic_check` |目的別read-only process/fs/db check |前result維持 | check単位Blocked |
| history削除 | Rust DB/artifact service | `delete_workspace_history` | running 0、workspace ID、Git path mutation禁止 | row/artifact不変 | partialを成功表示せずrecovery |
| copy diagnostic | Tauri clipboard | `copy_sanitized_diagnostics` | redaction済みsummaryだけ | 非該当 | raw detailへfallbackしない |

## ウィンドウ固有動作

| 項目 | 動作 |
|---|---|
| 生成・再利用 |同じ`main` windowを再利用し、元workspaceとreturn routeを保持する |
| 初期サイズ・最小サイズ |共通の1470×836 / 960×640 |
| リサイズ | section navをdrawer化し、main formとCancel/Saveを優先する |
| 最大化・全画面 | formは最大780px、preview areaへ残幅を与える |
| 常に手前へ表示 | 不可 |
| 閉じる操作 | import/test/support taskをcancelし、DB transactionをcommit/rollback後に終了 |
| 未保存変更がある場合 | section内にSave/Discard/Cancelを表示。secret入力はroute離脱時にclear |

## メニュー・ショートカット

| 操作 | macOS | Windows / Linux | 有効条件 | 実行結果 |
|---|---|---|---|---|
| tab移動 | `Control+Tab` / `Control+Shift+Tab` | 非対応 | destructive confirmなし | main tabs循環 |
| section検索 | `Command+K` | 非対応 | Settings active | section/field searchへfocus |
| picker/preview/dialogを閉じる | `Escape` | 非対応 | non-destructive overlay |入力維持、triggerへfocus |
| Save |明示button | 非対応 | dirty + valid | section transaction |
| destructive action | shortcutなし | 非対応 | safety preflight + confirm | Delete/Reset/history action |

## データ保持

| データ | 正本・保存先 | 保存契機 | 復元契機 | 破棄条件 | 失敗時 |
|---|---|---|---|---|---|
| locale/motion/settings | Rust SQLite | valid section transaction | startup/route | Reset対象に応じる |前version維持 |
| project/character context | versioned Rust SQLite | expected-version save | workspace/Context | project/history契約 | conflict、入力保持 |
| bundled Hiyori | release resource + manifest | build/package | startup/selection |削除不可 | static/text fallback |
| custom pack | app-private library + manifest | quarantineからatomic promotion | library/selection |未使用pack明示削除 | orphan quarantine cleanup |
| source absolute path |保存しない | 非該当 |復元しない | picker/import終了 | pack UUIDだけ使用 |
| TTS key | OS secret store |明示save | set/unset query |明示delete/reset | off相当、raw値非表示 |
| generated audio | memory/temporary only | playback中 |復元しない | complete/cancel/switch/quit | text保持 |
| support usage | Rust SQLite metadata | invocation terminal | Support/Diagnostics | history削除 | raw prompt/response非保存 |
| normalized history | append-only SQLite/artifact | writer transaction | timeline/evidence/restart | workspace history明示削除 | read-only recovery |
| diagnostic result | Rust SQLiteのsanitized summary | check terminal | Settings再表示 | Reset diagnostics |前result + stale label |

## OS差分

| 項目 | macOS | Windows | Linux |
|---|---|---|---|
| support | macOS 14+ Apple Silicon | MVP非対応 | MVP非対応 |
| picker / secret store | native file picker / Keychain相当 | 非該当 | 非該当 |
| motion preference | `prefers-reduced-motion` + app override | 非該当 | 非該当 |
| microphone | capability/request 0件 | 非該当 | 非該当 |
| unsupported platform | 非該当 |対応済みと表示しない |対応済みと表示しない |

## アクセシビリティ

- focus順はsection navigation、heading/status、fields、inline error/help、section actionとする。
- section navigation、toggle、diagnostic、mapping stateはcolorだけで状態を伝えず、label、value、icon/shapeを併用する。
- errorはfieldとの関連をprogrammaticに示し、Save後に最初のinvalid fieldへfocusを置く。
- Live2D preview canvasはpresentation扱いとし、inventory、current state、test resultをHTML textでも表示する。
- audio test sampleは再生前にvisible textとして表示し、mute/off/deviceなしでも同じ意味を取得できる。
- progressはstep名とcount/sizeをtextで出し、頻繁なhash updateをlive regionへ逐次流さない。
- destructive confirmationは削除対象と残るGit dataを読み上げ、Cancelを最初の安全な選択にする。
- 200% text zoomではsection navをdrawerへ移し、Save/Cancel、import cancel、history cancelを欠落させない。

## 性能と境界

| 指標 | 合格条件 |
|---|---:|
| settings toggle feedback | p95 100ms以下 |
| bundled Hiyori first frame | S-002表示からp95 3,000ms以下 |
| import resource | 128 files / 100MiB / 1 file 32MiB / texture 8192² / JSON depth 64を超える前にreject |
| TTS test timeout/cancel | timeout 5秒、Cancel/Stop 100ms以内 |
| support | active 1、queue 10、task 15秒、16,000 token |

## 関連要件

| 要件ID | この画面での扱い | 要件定義書 |
|---|---|---|
| `WORK-F-048`, `WORK-F-057`, `WORK-F-063` | preflight、project登録解除、project/character context | [workspace-sessions](../requirements/workspace-sessions.md) |
| `CODE-F-051`〜`CODE-F-053`, `CODE-F-075` | Codex initialize/login/Sol/effort/attachment前提診断 | [codex-main-session](../requirements/codex-main-session.md) |
| `SUP-F-062`〜`SUP-F-068` | concurrency、budget、usage、toggle、non-persistence、model policy | [support-agent-orchestration](../requirements/support-agent-orchestration.md) |
| `GIT-F-043`, `GIT-F-062`, `GIT-F-065` | Git baseline/error/unsupported診断 | [git-review-harness](../requirements/git-review-harness.md) |
| `HIST-F-049`〜`HIST-F-056` | history削除、migration、corruption、writer、schema、support metadata | [activity-history](../requirements/activity-history.md) |
| `LIVE-F-055`〜`LIVE-F-081` | bundled Hiyori、renderer、import、mapping、delete、performance | [live2d-companion](../requirements/live2d-companion.md) |
| `NARR-F-064`〜`NARR-F-077` | default off、secret、voice/test、mute、privacy、no microphone | [audio-commentary](../requirements/audio-commentary.md) |
| `APP-F-055`, `APP-F-057`〜`APP-F-072` | navigation、language、a11y、lifecycle、native boundary、diagnostics、performance | [desktop-shell](../requirements/desktop-shell.md) |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| custom pack名の編集 | manifest由来名を表示し、MVPではrenameしない | user testで識別困難ならaliasを追加する | いいえ |
| TTS provider/voice最終allowlist | provider adapterで分離し、ja/enの検証済みvoiceだけをrelease configへ固定する | release前のlatency/quality testで確定する | いいえ |
| `Allow motion`とOS Reduceの競合 | OS Reduceを優先し、appから解除しない | accessibility reviewでcopyを確認する | いいえ |
| history artifact partial delete | transaction journalで再起動時に完了/rollbackを分類する | failure injection testで方式を確定する | いいえ |

## レビュー確認

| 項目 | 内容 |
|---|---|
| レビュー結果 | Approved |
| レビュー日 | 2026-07-18 |

- [x] front matter、title、filenameの`S-004`が一致する。
- [x] `status: Approved`である。
- [x] 8 section、project/character context分離、diagnostics、history/privacyを定義した。
- [x] `tmp/hiyori_pro`をbuild入力とし、runtime 17 fileだけを同梱する契約を定義した。
- [x] custom model importのpicker、closure、resource limit、quarantine、preview、mapping、deleteを定義した。
- [x] TTS default off、secret store、voice/test/mute、text parity、microphone禁止を定義した。
- [x] normal、empty、loading、processing、offline、error、permission、cancel、restartを定義した。
- [x] 関連要件IDを要件定義書のS-004対応と一致させた。
- [x] 着手ブロックが「はい」または「不明」の未確定事項は0件である。
