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

| 項目                   | 内容                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| window label           | `main`                                                                                          |
| React route / view key | `/settings/:section?` / `settings-diagnostics`                                                  |
| 対象OS                 | macOS 14以降、Apple Silicon                                                                     |
| デザイン               | [DESIGN.md](../../DESIGN.md)、Figma Desktop node `8:2`のshell、[demo.png](../thinking/demo.png) |
| 共通仕様               | [デスクトップ共通仕様](desktop-common-specification.md)                                         |
| 廃止理由               | 非該当                                                                                          |
| 後継画面ID             | 非該当                                                                                          |

## 目的

利用者がアプリの前提条件、表示、Context、companion、音声、support、履歴を一か所で理解し、安全な範囲で変更・診断・復旧できるようにする。秘密、absolute private path、raw support historyを表示せず、設定失敗がmain coding sessionや現在選択中のLive2D modelを壊さないことを保証する。

## 対象範囲

### 含める

| section           | 内容                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| General           | native `AppPreferencesV1`のja/en、reduced motion、character visibility、version、Reset Preferences、reset UI state |
| Project context   | active project/workspaceのgoal、constraints、definition of done、technical references                     |
| Character context | name、tone、speech density、表現上の禁止事項。technical policyから分離                                    |
| Companion         | bundled Hiyori、custom model import、inventory、preview、semantic mapping、hide、provenance、delete       |
| Audio             | default off、macOS local `/usr/bin/say`、voice、rate、test、mute、text fallback                           |
| Support           | global/role enable、commit explainer skill、active/queue/budget、usage、last error、policy固定値          |
| Diagnostics       | OS/app、Codex、commit skill注入、read-only Git、DB、Live2D、audio、support、capability、error code、retry |
| History & Privacy | persistence内容、redaction、workspace history削除、migration/recovery、non-persistence                    |

### 含めない

| 非対象                             | 理由                                      | 代替                                    |
| ---------------------------------- | ----------------------------------------- | --------------------------------------- |
| account/login credential本文の表示 | secret boundaryを守る                     | CodexはAuthenticated/Blocked statusだけ |
| arbitrary executable/path設定      | allowlist外process/filesystemを公開しない | 目的別pickerとpreflight                 |
| model picker for Codex             | main modelは`GPT-5.6 Sol`固定             | availability/capability診断だけ         |
| microphone / speech input          | output-only audio契約                     | text composer                           |
| support prompt/response閲覧        | ephemeral/non-persistence契約             | usage metadataとdeterministic fallback  |

## 表示契機と終了

| 項目           | 内容                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| 表示契機       | Settings tab、sidebar gear、preflight/permission/errorの診断link、model/audio/support fallback link    |
| 表示前提       | app DBがread可能。破損時はread-only Diagnostics/History recoveryだけを表示する                         |
| 初期フォーカス | routeのsection heading。unknown sectionはGeneral headingへreplace遷移する                              |
| 正常完了       | section単位の保存成功をinline表示し、元routeへ戻って設定を即時反映する                                 |
| キャンセル     | picker、preview、test、confirm開始前の保存済み設定と入力を維持し、errorを出さない                      |
| 閉じる操作     | [共通close契約](desktop-common-specification.md#windowとtitlebar)に従う。import/test/supportを停止する |
| 再表示         | selected section、section scroll、保存済み値、診断結果を復元する。secret値は復元表示しない             |

## 利用者と権限

| 利用者・ロール        | 表示                                                                                 | 操作                                                               | 拒否時の動作                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| ローカル利用者        | non-secret setting、status、inventory、usage、sanitized diagnostic                   | edit、import、preview、select、test、delete、retry、history削除    | invalid/unsafe operationを開始せず理由を表示                                                                    |
| React WebView         | typed setting、pack ID、diagnostic summary                                           | render、input、typed IPC                                           | source absolute path、process path/argument、arbitrary commandを保持しない                                      |
| Rust settings service | SQLite、owner-only narration setting、filesystem quarantine、process/Git diagnostics | validate、transaction、import、persist、diagnose、cleanup          | scope外path/schema/process requestを拒否                                                                        |
| Live2D preview worker | verified quarantine/library pack                                                     | first frameとstate test                                            | WebView DOM、network、script、root外assetへaccessしない                                                         |
| TTS adapter           | bounded redacted transcript、exact installed voice、rate                             | fixed `/usr/bin/say`の再検証、stdin playback、process-group cancel | shell、external provider、API key、network、source/event payload、repo/path、microphone、audio fileを使用しない |
| Support policy        | role config、usage metadata                                                          | queue/budget/disable/cancel                                        | outputによるpolicy/model/DOM変更を許可しない                                                                    |

## 画面構成

sidebarと81px headerは他画面と同じ位置を維持し、Settings tabまたはgearをactiveにする。bodyは設定専用のsection navigationとform/detailに再構成する。

| 領域                 |              標準1470×836 | 表示内容                                             | scroll owner   |
| -------------------- | ------------------------: | ---------------------------------------------------- | -------------- |
| workspace sidebar    |                  255.04px | workspace selection、gear                            | workspace list |
| settings section nav |               body内228px | 8 section、attention/error badge                     | nav単独        |
| settings main        |   残幅、content max 780px | section heading、status、field、preview、danger zone | main単独       |
| sticky action row    | main下部、必要sectionだけ | Save / Cancel / Test cancel / Import cancel          | 固定           |

section navは表の順にし、同型card gridではなく一つのform flowを使う。960〜1279pxではnavをportal drawerへ移してmainを最低640px確保する。960×640の200% text zoomでは実効480px幅の単一columnへ切り替え、section navとmainを別々に縦scroll可能にする。説明文とdanger actionを横方向にclipせず、actionをwrapし、danger actionをprimary actionと隣接させない。

## section仕様

### General

| setting        | 契約                                                          | 即時反映                                              | 永続化                                                         |
| -------------- | ------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| Language       | `日本語` / `English`。初回はOS localeが`ja`開始ならja、他はen。wire値`ja` / `en` | sidebar、tab、error、decision、Settings、notification | owner-only native `AppPreferencesV1` |
| Reduced motion | OS preferenceを初期値にapp override `System / Reduce / Allow`。wire値`system` / `on` / `off` | transition、Live2D、decorative motion | owner-only native `AppPreferencesV1` |
| Character visibility | `表示 / Visible`、`非表示 / Hidden`。wire値`visible` / `hidden` | canvas/GPU animation、Chat幅、HTML state text | owner-only native `AppPreferencesV1` |
| App version    | semantic version、build、schema versionをread-only表示        | 非該当                                                | bundle/DB metadata                                             |
| Reset Preferences | confirmation後にOS由来locale、`system`、`visible`へ戻す | 保存成功後に全app-owned copyへ即時反映 | `AppPreferencesV1`だけ。workspace、history、Context、model library、Git、Narration settingは不変 |
| Reset UI state | geometry、active section、filter、scrollをsafe defaultへ      | confirmation後                                        | domain history、context、Git、model、narration設定は削除しない |

Settingsとruntimeはowner-only app-private native storeの同じ`AppPreferencesV1` snapshot ID/versionだけを使い、temporary fileのfsyncとatomic renameで更新する。language変更中もuser content、path、branch、SHA、model名、commit messageを翻訳しない。保存成功後100ms以内に全app-owned copyへ反映し、再起動を要求しない。missing/corrupt/unknown-version recordはraw値を表示せず、OS由来locale、`system`、`visible`へfail closedし、sanitized diagnosticと`Reset Preferences / 設定をリセット`を表示する。WebView/localStorage/demo fixtureを永続正本にしない。

### Project context

active project/workspaceを明示し、[S-002 Context subview](S-002_coding-workspace.md#context-subview)と同じversioned storeを編集する。

| field                | 初期値                              | 制約                                          | 適用                              |
| -------------------- | ----------------------------------- | --------------------------------------------- | --------------------------------- |
| Goal                 | current version                     | 0〜8,000 Unicode scalar                       | main/support snapshotのgoal       |
| Constraints          | current version                     | 0〜8,000、secret警告                          | technical decision boundary       |
| Definition of done   | current version                     | 0〜20項目、各trim後1〜500                     | work unit acceptance補助          |
| Technical references | managed doc ID / repo-relative path | 0〜20項目、各1〜500。canonical project root内、absolute path・`..`非保存 | mainのみ。supportへ本文を渡さない |
| User notes           | current version                     | 0〜8,000                                      | next turnから適用                 |

全field・全配列itemの合計は32,000 Unicode scalarを上限とする。3つの配列editorはraw textarea draftを別に保持し、typing / paste / IME composition中の空白、空行、caretを変更しない。blurまたはSave時にだけtrim、空item除去、canonical path正規化を行い、保存成功後にcanonical valueを表示する。保存時にexpected versionを検証し、競合時はremote/currentの差と再読み込みを示す。running turnへ途中適用せず、`次のturnから適用`と表示する。project登録解除はsource、Git object、branchを削除せず、[S-001](S-001_session-dashboard.md)の確認契約を使う。

### Character context

| field                  | 初期値                                                   | 制約                                          | 適用                         |
| ---------------------- | -------------------------------------------------------- | --------------------------------------------- | ---------------------------- |
| Display name           | `Sol`                                                    | 1〜40文字                                     | visible companion identity   |
| Tone                   | concise / warm / neutralのallowlist + 0〜1,000文字補足   | 感情的強制や虚偽確信を要求できない            | assistant presentation       |
| Speech density         | quiet / key events / detailed                            | audio eligibility上限を越えない               | visible transcript/audio候補 |
| Companion behavior     | 0〜4,000文字のpresentation希望                           | technical policyを変更せず、inventory外cueはneutral | Live2D presentation          |
| Prohibited expressions | 0〜20項目、各1〜200                                      | safety/error/decisionの事実表示は抑止できない | output presentation          |

全field・全配列itemの合計は12,000 Unicode scalarを上限とする。Character contextはpermission、model、tool、Git observer、commit skill、verification、approval、privacy、support capability、checkpoint policyを上書きできない。行頭・JSON key位置のtechnical policy key、override / bypass / disable / ignore、またはgrant / deny / allow / skip / avoid / never askとtechnical policy名を組み合わせた意味的な変更指示を保存前にrecord単位で拒否する。ja/en fixtureを同じ結果へ固定し、単なるpresentation説明はfalse positiveにしない。拒否内容はProject contextへ自動コピーしない。running turnには次turnから適用する。

#### Context editor stateと競合復旧

Context tabとSettings内のProject context / Character contextは、同じworkspace-scoped native storeと同じ画面内draft stateを編集する。SettingsからContextへ遷移した時、section focusは対応するheadingへ移り、保存済みversion、未保存入力、validation errorを維持する。

| 状態 | 表示 | 操作・focus |
|---|---|---|
| loading | field shape skeletonとworkspace名。旧workspace内容を表示しない | Save不可。load terminal後に最初のinvalid fieldまたはsection headingへfocus |
| clean | `Version N`、content hash短縮、`次のturnから適用` | field編集可能 |
| dirty | `未保存`と文字数・項目数。running turn中は`実行中のturnには反映されません` | Save / 変更を破棄 |
| saving | 保存対象sectionだけprocessing、入力はread-only | 二重Save不可。別sectionの未保存draftは維持 |
| saved | `Version N+1`と`次のturnから適用`をstatus regionへ通知 | Saveへfocusを固定しない |
| validation error | field直下の理由と安全境界。technical-policy拒否はprivate入力を復唱しない | 最初のinvalid fieldへfocus。入力保持 |
| version conflict | `手元 Version N / 保存済み Version M`、内容が異なるfield名、手元draft保持 | `保存済みを再読み込み`で当該sectionだけ置換。Cancel/Escapeでdraft維持し編集へ戻る |
| load/save unavailable | safe error code、Retry | 他workspaceと他sectionを壊さない |

field error stateは`field + safe reason key + native code`を保持する。field直下のlocalized reasonへ安定したIDを付け、help textがある場合はhelp IDとerror IDの両方を`aria-describedby`へ設定する。native reference boundary / missing / changed errorもTechnical referencesへ関連付ける。field不明のrecord errorはfallback fieldを選ばずsection Alert / headingへfocusし、conflictの再読込後は対応section headingへfocusする。

workspace切替時は旧workspaceのpending load/save responseをgenerationで無効化し、新workspaceのfieldへ適用しない。再起動後はSQLiteの保存済みrecordだけを復元し、未保存draftを保存済みと表示しない。Sendはclick/shortcut受付時にProject / Characterのversionとhashを一つのimmutable request snapshotへ固定し、実行中のturnへ後から注入しない。snapshot失敗時は該当field errorまたはpreflight errorを表示し、root/referenceを再Saveせずに暗黙採用しない。demoでもnativeと同じcanonical content digestを短縮表示する。

### Companion

#### bundled Hiyori

build時の入力はrepositoryの`tmp/hiyori_pro`とし、release resourceにはruntimeに必要な次の17 fileとnoticeだけをcopyする。

- `hiyori_pro_t11.model3.json`、`.moc3`、texture 2件、physics、pose、cdi、motion 10件。
- `.cmo3`、`.can3`、`.DS_Store`、authoring cache、不要source assetは配布へ含めない。
- install後はimmutable `builtin:hiyori_pro` packとしてapp resourceから解決し、sourceの`tmp/` pathをruntime/UIへ渡さない。
- pack name、creator、source notice、bundled version、manifest hashへCompanion sectionから到達できる。

#### library

| 項目           | 表示・操作                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundled        | Hiyori preview、selected project数、provenance。Delete不可                                                                                                                                                                                                                                                                                                                       |
| Custom         | pack name、attested thumbnail、motion/expression count、size、manifest/trusted-frame hash、selected project数。thumbnailは再読込・再起動後もpack IDとtrusted-frame asset IDだけのopaque binary IPCで取得し、manifest記載のbyte数とSHA-256へ一致したPNGだけを表示する。hashは省略表示し、完全値をaccessible nameで提供する。missing/tampered frameではuntrusted bytesを表示しない |
| Hide character | `AppPreferencesV1.characterVisibility`を更新し、canvas/GPU animationを停止してChat幅とHTML text stateを残す。全workspaceへ即時反映し再起動後もexact復元                                                                                                                                                                                                                           |
| Select         | preview first frameとstate test成功後だけstable Project ID単位で有効。atomic保存成功時に同じProject IDの全workspaceへ即時反映する。切替時はcandidate client/model/trusted frameをfirst accepted frameまでstageし、成功時だけrenderer、React committed pack、metrics、status、frameを一括で置換する。失敗またはabortではcandidateだけをreleaseし、現在表示を全項目そのまま維持する |
| Delete         | どのProject IDからも選択されていないcustom packだけ。bundled Hiyoriまたは1件以上のProjectが選択中ならdisabled理由を表示し、確認後にselectionとusageを同じnative transactionで再検査してapp-private copyを削除                                                                                                                                                                         |

legacy workspace-scoped selectionはProjectごとに`selectionUpdatedAt DESC, workspaceId ASC`で最初のvalid packを一度だけ移行する。valid値がなければbundled Hiyoriへ戻し、stale workspace responseから選択やDeleteを開始しない。

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

`SemanticMappingV1`はpack ID、manifest hash、mapping versionと次の7 stateを一つのtransactionで保存する。選択候補は検証済みmanifest inventory内のmotion cue、expression cue、または`neutral`だけで、parameter式、path、URL、任意file名を保存・実行しない。

| semantic state | operational source | ja/en fallback text |
|---|---|---|
| `neutral` | idle、unknown/unsupported | `待機中 / Idle` |
| `thinking` | thinking | `考えています / Thinking` |
| `working` | acting、reviewing、explicit commit presentation | `作業中 / Working` |
| `asking` | waiting_for_user | `回答待ち / Waiting for your answer` |
| `success` | completed | `完了 / Completed` |
| `warning` | disconnected | `接続を確認してください / Check connection` |
| `error` | error | `エラー / Error` |

| mapping state | 表示 | 操作・focus |
|---|---|---|
| loading | state row skeleton、pack名/hash | Save disabled、terminal後mapping headingへfocus |
| empty/default | 7 stateすべてneutral、理由 | inventory cue選択、state preview |
| editing | dirty、stateごとのja/en label、cue種別 | keyboard-onlyでrow→cue→Preview→次rowの順 |
| saving/saved | 対象mappingだけprocessing、version更新 | 二重Save disabled。成功はpolite statusでfocusを奪わない |
| invalid | unknown version、manifest hash不一致、invalid/deleted cue | mapping全体を実行せずneutralへfallbackし、最初のinvalid rowへfocus |
| recovery | current pack/manifest、safe code、Reset to neutral | 前mapping/raw値を実行せず、再保存またはpack再選択 |

Hiyoriのdefault mappingは実在する`Idle`、`Flick`、`FlickDown`、`FlickUp`、`Tap`、`Tap@Body`、`Flick@Body`のmotionだけを参照する。expressionが0件でも保存でき、未割当stateはneutralへ戻す。mapping previewは同じsemantic state列で決定的に再生し、reduced motion時はanimationせずtrusted static frame、icon、textを確認する。

### Audio

fresh profileと`Reset Audio Settings`後はTTSをoffにし、`say` process、network request、audio fileを0件にする。captionは音声設定に関係なく正本として表示する。App ServerのGit commit成功SHAとnative observerのexact SHAが一致すると独立background support runtimeで説明準備は自動開始するが、commit検知だけではcaption/TTSを開始しない。利用者が対象commitの「詳しく教えて」を選んだ時だけ、そのcommitのpresentationをactiveにする。

| setting / control   | 契約                                                                                                                         | 失敗・cancel                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Enable TTS          | default off。明示enable時だけ検証済みlocal adapterを起動可能にする                                                           | binary/voice unavailableでもcaptionを維持し、networkへfallbackしない |
| Adapter             | exact `/usr/bin/say`をread-only表示。voice列挙・test・発話の直前にregular file、UID 0、group/other writeなしをnativeで再検証 | 不一致時はTTS disabled、process未起動、typed reason                  |
| Voice               | 検証済み`-v '?'`出力のうちactive UI localeに対応するinstalled exact allowlistだけ。再列挙失敗時も直前listと未保存draftを維持する | inline codeと`Retry voices`を常時表示し、0件または保存値不一致ならTTS disabled |
| Rate                | 0.75〜1.25、0.05刻み、初期1.0。nativeで基準180 words/minuteの135〜225へ変換                                                  | invalid値を保存・起動しない                                          |
| Test                | 固定ja/en sampleを先にvisible caption表示し、その後local playback                                                            | 5秒timeout。Cancel後100ms以内にprocess groupを停止し設定入力維持     |
| Mute                | 現在process groupを100ms以内に停止しqueue clear、caption維持。保存version更新で未保存voice/rate draftを初期化しない           | unmute後に過去eventを再生しない                                      |
| Reset               | toggle off、locale既定voice、rate 1.0、mute falseへowner-only atomic保存                                                     | 確認cancelで全設定不変                                               |
| Commit source       | `App-owned · background support`をread-only表示。main session assistant/sub-agent outputは選択肢にせず、sourceを変更できない | source unavailable時はcaption/TTSを開始せずtyped statusを表示        |
| Active presentation | short SHA、ja/en管理文言へ変換したpreparing/streaming/ready/canceled/unavailable、caption sequence、speech状態をread-only表示 | transcript本文・support input/output・full private pathを表示しない  |
| Close explanation   | caption/live regionをdismissし、speechを100ms以内に停止する。prepared cacheとbackground jobは維持し、再open時にsequence順で再提示 | support jobをCanceledにしない                                        |
| Cancel generation   | queued/running support jobの時だけ表示し、jobとspeechをcancelして同requestの後着chunk/cache replayを無効化する                | terminal後は明示Retryで新requestを作るまで再提示しない               |

app-owned presentation controllerは`workspaceId + workspaceGeneration + full commit SHA + support request ID + selection version + presentation intent epoch + presentation generation + locale`を一つのactive keyとして所有する。background streamはkey、schema、redaction、連続sequenceを満たす時だけvolatile bufferへ入り、activeでなければcaption/live region/TTSへ適用しない。生成中のcommitをactivateした時は既着chunkから後続をstreamし、生成済みなら全chunkを順番に再提示する。TTS enabledかつunmutedの場合だけ、captionへ確定した同じchunkを同じsequenceで読む。

`Close explanation`、別commit選択、workspace切替、stale workspace generationではpresentation generationを進め、captionをdismissしspeechを同じkeyで停止する。prepared cache/background jobは維持し、同じcommitを再openするとcacheをsequence順に再提示する。queued/running中の`Cancel explanation generation`だけがsupport jobをCanceledへterminal化し、同requestの後着chunkとcache replayを無効化する。background support input/output、caption chunk、TTS transcriptをmain conversation、assistant message、main session historyへappendしない。

caption componentはactive viewportのHTMLへchunkをcommitした後、layoutとpaint境界を通過してvisibleであることをcontrollerへackする。controllerはack後100ms以上captionを表示してからだけnative発話を許可し、unmount/hidden/ack timeoutではcaption-onlyへterminal化する。native runtimeの`unavailable`はfrontend timeoutを待たずsanitized native codeのまま即時terminal化し、frontend watchdog時はnative cancel完了後にterminal表示する。

native adapterは240 Unicode scalar以下、NULなしで、括弧・引用符・`=`・`:`直後を含むPOSIX absolute path、Bearer/GitHub/AWS/Slack/PEM、cookie/session/password/token/key assignmentをfrontendとnativeの共通fixture集合でrejectしたtranscriptだけをstdinへ書く。processはshellなしでexact `/usr/bin/say`を新しいprocess groupとして起動し、引数を`-v <exact allowlist voice> -r <validated integer>`へ固定する。`-f`、`-o`、`-n`、`-a`、command-line text、inherited secret environmentを使わない。audioはsystem outputへ直接再生し、memory/fileへ保存しない。microphone/network capability、permission request、入力UIを一切持たない。

設定正本はnative `NarrationSettingsV1`とし、app-private narration directoryをowner-only、fileを`0600`で作り、schema検証済みtemporary fileのfsyncとatomic renameで置換する。WebView/localStorageを正本にせず、fresh/missing/invalid schemaはTTS offへfail closedする。

### Support

| setting / status     | 初期値・制約                                                                                                              | 動作                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global enable        | release proof済みcapacity 1の時だけdefault on。専用clean runtime、wire-advertised/external-authority tool 0件、`tools` field不在、空のowner-only cwd、runtime root 0件をread-only表示 | capacity 0、capability不足、tool-absence boundary不一致、またはoffではthreadを起動せず、queued/activeをcancelしてdeterministic fallbackを維持。Codex内部の`update_plan` eventも当該taskをfailedにする |
| Presence / narration | on                                                                                                                        | deterministic eventだけで起動                                                                                                                                                   |
| Decision explainer   | role policy値                                                                                                             | main decisionを補助し、直接質問しない                                                                                                                                           |
| Commit explainer     | on                                                                                                                        | verified new commitは`auto_verified_commit`で自動job、未生成の既存commitは`user_request`、failed/canceledは`user_retry`で起動し、redacted `CommitEvidenceV1`最大64KiBだけを読む |
| Explainer skill      | `coding-wife-explain-commit`、`app_bundle`、implicit invocation off                                                       | version、digest、last injected request、schema statusをread-only表示                                                                                                            |
| Concurrency / queue  | active 1、queue最大10                                                                                                     | 11件目はlow priorityをdropしmetadata記録                                                                                                                                        |
| Task budget          | 15秒、input+output 16,000 token                                                                                           | 超過でcancel、fallback                                                                                                                                                          |
| Model / effort       | GPT-5.6 familyのrole policy固定、read-only                                                                                | support output/UIから変更不可                                                                                                                                                   |
| Usage                | role、status、model family、tokens、latency、queue、last error                                                            | prompt/response本文を表示・保存しない                                                                                                                                           |

role toggleをoffにするとqueued taskをcancelし、新規invocationを作らない。active taskは5秒以内にCanceled/Timeoutへ遷移させ、main turnを継続する。non-persistence release auditの最終resultと実施日時へDiagnosticsから到達できる。

commit explainer jobの起動とpresentation開始は別状態である。background jobが自動でstarted/streaming/completedになってもcaption/TTSは開始せず、「詳しく教えて」で対象commitをactive presentationにした後だけ表示・任意読み上げへ進む。

### Diagnostics

Diagnosticsはdemo/fixtureでなく同じnative readiness serviceのversioned snapshotだけを表示する。各checkは`ready` / `warning` / `blocked` / `unavailable`、UTC `checkedAt`、snapshot ID、sanitized error code、ja/en recovery actionを持つ。Recheck中は前snapshotをstale表示で残して`aria-busy=true`とし、terminal時に全checkとHistory DB badgeを同じ新snapshotへatomic置換する。

| check         | Ready表示                                                                                                                                                                                   | Warning / Blocked                                                                                       | 回復操作                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| OS / App      | macOS version、Apple Silicon、app/build/schema                                                                                                                                              | unsupported OS/arch、migration pending                                                                  | release note / recovery                             |
| Codex         | executable、protocol initialize、login、`GPT-5.6 Sol`、Fast/Max capability                                                                                                                  | missing、unauthenticated、model/effort unavailable、disconnect                                          | Recheck、login案内                                  |
| Commit policy | `coding-wife-commit-work`のversion、digest prefix、`app_bundle`、explicit injection mode、last verified turn                                                                                | resource missing、digest mismatch、skill input/developer instruction unavailable、last injection failed | Recheck。failure中はdraftを保持してturnを開始しない |
| Git observer  | executable capability、repository identity、repo/HEAD/status、health=`healthy`、read-only policy version、last observation                                                                  | health=`missing` / `changed` / `unreadable` / `read_only` / `stale_branch`、bare、unsupported repo、mutation command exposed | Repair、project再選択、read-only Refresh/Recheck |
| DB            | integrity、writer、schema、backup                                                                                                                                                           | migration rollback、corruption、read-only                                                               | backup pathをbasename化してrecovery案内             |
| Live2D        | bundled manifest/hash、WebGL、selected pack、first frame                                                                                                                                    | asset/context loss、unsupported MOC、fallback level                                                     | Retry、Hiyori選択、text-only                        |
| Audio         | toggle、binary metadata status、installed voice count、selected voice/rate、device、source、active commit prefix/presentation generation、caption sequence、speech/queue、last adapter code | binary/permission/voice/source/key/schema/sequence/spawn/stdin/exit/timeout/device error                | Recheck、Test、Mute、Cancel presentation            |
| Support       | enable、capacity 1、wire-advertised/external-authority tool 0件、tool-absence fingerprint、permission profile、clean runtime/auth bridge/canary、`coding-wife-explain-commit` version/digest、last usage | capacity 0、isolation/auth/tool-field mismatch、internal plan event、timeout、output schema、policy、non-persistence未検証 | Cancel、Disable、Recheck                            |
| Security      | CSP/capability version、redaction self-check                                                                                                                                                | policy mismatch、future schema event                                                                    | safe mode、release guidance                         |

診断はtoken、cookie、credential、absolute/private path、transcript本文、support prompt/response、raw process stdout/stderrを表示・copy・logしない。各resultはcode、UTC checkedAt、snapshot ID、scope、impact、recoverable、safe detail refを持つ。`Copy diagnostics`は同じsanitized summaryだけをclipboardへ出す。native結果がないcheckは`unavailable`であり、demo/fixture値を`ready`として表示しない。

DB readinessはHistory & Privacyのbadgeと同じsnapshot IDの履歴状態を正本にする。native `ready`でない時に`Persisted locally`を表示せず、read-onlyまたはrecovery errorとsanitized codeを一致して表示する。browser demoの`ephemeral`は`Demo memory / デモ用メモリ`として別表示し、native DB readinessや復旧errorを偽装しない。

### History & Privacy

| 項目                     | 表示・操作                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Stored locally           | project/workspace、normalized event、draft、context、Git observation、commit evidence、skill injection audit、selected character、settings      |
| Never stored             | raw reasoning、audio byte/file、support prompt/response、commit explanation transcript、raw secret                                              |
| Redaction                | key/token/cookie/home pathのself-check status、last failure code                                                                                |
| Schema                   | current version、last migration、backup、writer queue/integrity                                                                                 |
| Delete workspace history | running turnなしの対象だけ。app DB/artifactを削除し、Git repo/commit/branchを変更しない                                                         |
| Reset demo workspace     | `ephemeral`の対象だけ。現在のbrowser preview memoryから対象を除き、preview再起動でfixtureへ戻ることとGit/repositoryへ未接続であることを明示する |
| Recovery                 | corruption時のread-only mode、backup、retry/locate support情報。自動初期化しない                                                                |

history削除dialogはworkspace名、削除するapp data、残るGit data、不可逆性を表示する。Cancel時はrow/artifact数、selection、filterを変えない。削除成功後はS-001のempty/remaining workspaceへ移動し、Git refを消したと表示しない。demo resetはnative deleteの語彙を使わず、現在のpreview memoryだけが対象で再起動により戻ることを確認面と操作labelの両方で示す。

## 表示状態

| 状態                  | 進入条件                                                 | 表示                                                                     | 操作可否                                                   | 状態から抜ける条件           |
| --------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------- |
| 初期化中              | settings、diagnostics、libraryを読込中                   | shell、section nav、field shape skeleton。demo履歴を表示しない           | section移動、Quit。保存、context取得、履歴削除は開始しない | query/migration terminal     |
| 通常                  | DB read/write、section ready                             | current values、status、section action                                   | edit、save、test、import、diagnose                         | operation開始/error          |
| データなし            | custom pack、usage、history対象が0件                     | 理由と一つの次操作。空table/card gridなし                                | Import、Support enable、Chatへ戻る                         | 対象data作成                 |
| 処理中                | save、diagnose、import/hash、preview、test、delete       | 対象step、progress、Cancel可能性、他section status                       | 安全なCancel、影響外section                                | success/cancel/error         |
| オフライン            | network/Codex/support unavailable                        | local setting/library/history/TTS、persistent reason                     | local edit、Live2D、local TTS test、Git/DB診断             | 明示Recheck成功              |
| エラー                | validation、I/O、local TTS process、DB、renderer failure | code、operation、impact、保持値、retry/modify/details                    | 影響外設定                                                 | terminal recovery            |
| 権限不足              | picker/library/process/Git拒否                           | 拒否scope、OS案内、再選択/再診断。private path非表示                     | Cancel、read-only diagnostics                              | permission変更後のretry      |
| キャンセル後          | picker/import/preview/test/delete confirmをcancel        | 保存済み値、現在model、入力、library/DBを維持。errorなし                 | 元操作または別操作                                         | 次の明示操作                 |
| 再起動復旧            | save/import/delete/migrationが中断                       | last durable settings、quarantine cleanup、Interrupted operation、backup | diagnose、retry、discard quarantine                        | integrity/fingerprint確定    |
| read-only recovery    | DB corruption/migration rollback                         | Diagnostics/History、backup、error code、Gitは不変                       | copy sanitized diagnostic、Quit                            | explicit successful recovery |
| local TTS unavailable | binary metadata/voice/audio device検証失敗               | native typed reasonとcaptionを即時terminal表示しTTS off相当。voice list、保存値、未保存voice/rate draftを維持 | Recheck/Retry voices/Test/Mute                             | 全preflight成功              |
| companion fallback    | pack/render failure                                      | current fallback level、Hiyori/text-only、Chat継続                       | Retry/Select/Hide                                          | first frame/state test成功   |
| preference recovery   | `AppPreferencesV1` missing/corrupt/unknown version       | safe default、sanitized code、`Reset Preferences`。raw値を表示しない     | Reset、Diagnostics、影響外section                          | atomic save成功              |
| diagnostics rechecking | Recheck中                                                | 前snapshot + Stale、check progress、UTC checkedAt、`aria-busy`            | Cancel、影響外section、copyは前snapshot                    | 同一snapshotのterminal結果   |
| diagnostics unavailable | native service/checkが結果を返せない                    | `Unavailable`、safe code、localized recovery。demo Readyを表示しない      | Recheck、Settings内回復                                    | native terminal result       |
| mapping invalid/recovery | version/hash/cue不一致                                  | 全state neutral、invalid row、保持pack、Reset to neutral                  | previewなしのedit/reset、pack再選択                        | valid atomic mapping save    |

## 操作

| 操作                   | 事前条件                           | 正常結果                                                               | キャンセル時                             | 失敗時                              | 関連要件ID                                            |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------- | ----------------------------------------------------- |
| app preference変更     | `AppPreferencesV1`のlocale/reducedMotion/characterVisibilityがvalid | owner-only native recordをatomic保存し、同じsnapshot/versionを全runtimeへ即時適用 | transaction前なら前snapshot維持 | 前snapshotを維持しsanitized code | `APP-F-057`, `APP-F-058`, `APP-F-061`, `APP-F-076` |
| Reset Preferences      | confirmation、current snapshot     | recordだけをOS由来locale/`system`/`visible`へatomic置換                  | preferenceを含む全state、workspace/history/Context/model/Git不変 | 前snapshot維持、Retry | `APP-F-076` |
| Context保存            | valid section、expected version    | version更新、next turn適用                                             | 開始前version維持                        | 入力保持、field/conflict表示        | `WORK-F-063`                                          |
| model3.json import     | picker利用可能                     | 検証、quarantine、preview後にlibraryへatomic登録                       | library/DB/quarantine/current model不変  | current model継続、失敗pack非登録   | `LIVE-F-068`〜`LIVE-F-076`                            |
| model選択              | first frame/state test成功、stable Project ID | Project IDのpack IDをatomic保存し同Project全workspaceへ即時反映、single canvasへ切替 | current selection維持 | current renderer継続 | `LIVE-F-059`, `LIVE-F-075` |
| semantic mapping保存   | 7 stateすべてinventory内motion/expression cueまたはneutral、manifest hash一致 | pack ID/hash/versionとmapping全体をatomic更新 | 前mapping維持 | mapping全体をneutral fallback、invalid cueを保存しない | `LIVE-F-061`, `LIVE-F-062`, `LIVE-F-077` |
| custom pack削除        | 全Project IDで未選択のcustom、confirm、transaction再検査 | library copyとmetadataをatomic削除 | pack/library/DB不変 | selected/race時disabledまたはpackを残しretry | `LIVE-F-078` |
| Audio設定保存/reset    | schema/voice/rate valid            | owner-only temporary fileをfsync後atomic rename、default off/reset反映 | 保存状態不変                             | 前version維持、TTS offへfail closed | `NARR-F-064`〜`NARR-F-066`                            |
| TTS test               | enable、verified binary/voice/rate | 固定sampleを表示後stdinでlocal再生、audio非永続                        | 100ms以内process group停止、設定入力維持 | text fallback、main不変             | `NARR-F-066`, `NARR-F-067`, `NARR-F-077`              |
| narrationを閉じる      | active presentation                | captionをdismiss、speech停止、prepared cache維持                        | 非該当                                   | caption維持、speech停止              | `NARR-F-083`, `NARR-F-085`, `NARR-F-088`              |
| narrationを再度開く    | prepared cacheあり                 | 同じchunkをsequence順に再提示し、paint ack後100ms以上で未読だけ発話     | presentation不変                         | caption-only terminal                | `NARR-F-058`, `NARR-F-083`, `NARR-F-088`              |
| explanation生成cancel | queued/running support job         | jobをCanceledへterminal化し、後着chunk/cache replayを無効化             | job/presentation不変                     | main継続、sanitized code表示         | `NARR-F-087`, `NARR-F-088`                             |
| support enable/disable | valid role                         | queue/cancel policy適用、usage metadata記録                            | 非該当                                   | offへfail closed、main継続          | `SUP-F-062`〜`SUP-F-068`                              |
| 再診断                 | 対象check選択                      | native serviceが全check、UTC checkedAt、sanitized code、History DB badgeを同じsnapshot IDへ更新 | 前snapshotをstale表示で維持 | checkをUnavailable/Blockedにしlocalized recovery | `CODE-F-051`〜`CODE-F-053`, `CODE-F-075`, `APP-F-070` |
| history削除            | running turnなし、confirm          | app DB/artifactだけ削除、Git不変                                       | row/artifact/selection不変               | 削除済みと表示せずrecovery          | `HIST-F-049`, `HIST-F-050`                            |
| demo workspace reset   | historyが`ephemeral`、confirm      | 現在のpreview memoryから対象を除き、他のdemo workspaceへ移動           | preview memory/selection不変             | reset済みと表示せず入力状態を維持   | `HIST-F-059`                                          |

## 入力項目

| 項目                | 初期値             | 必須          | 制約・境界                                                                                           | エラー表示                 | 保存契機                     |
| ------------------- | ------------------ | ------------- | ---------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------- |
| locale              | OS由来または前回値 | 必須          | `ja` / `en`                                                                                          | 前値維持                   | `AppPreferencesV1` atomic save |
| reduced motion      | `System`           | 必須          | UIはSystem / Reduce / Allow、wire値は`system` / `on` / `off`                                         | Systemへfallback           | `AppPreferencesV1` atomic save |
| character visibility | `Visible`         | 必須          | UIはVisible / Hidden、wire値は`visible` / `hidden`                                                    | Visibleへfallback          | `AppPreferencesV1` atomic save |
| project context     | current version    | 任意          | 総量32,000 Unicode scalar、secret warning                                                            | section内、入力保持        | expected-version transaction |
| character context   | current version    | 任意          | 総量12,000、technical policy key禁止                                                                 | section内、入力保持        | expected-version transaction |
| model3.json         | なし               | import時必須  | regular file 1件、closure/resource/security上限                                                      | import step内、library不変 | atomic promotion成功         |
| mapping             | neutral/default    | 7 state必須   | `neutral/thinking/working/asking/success/warning/error`へinventory内motion/expression cueまたはneutralだけ | row内、全mapping neutral fallback | pack ID/hash/version付きmapping transaction |
| voice               | locale候補         | enable時必須  | allowlist voice ID                                                                                   | field直下                  | testまたはsave成功           |
| rate                | 1.0                | 必須          | 0.75〜1.25、0.05刻みのselect option。native WPMは135〜225                                            | field直下                  | valid atomic save時          |
| mute                | false              | 必須          | boolean、global。invalid/missing settingはmutedではなくTTS offへfail closed                          | section status             | valid atomic save時          |
| active presentation | なし               | 非該当        | volatile read-only key。workspace/generation/full SHA/request/selection version/intent epoch/presentation generation/locale完全一致 | Audio status | 「詳しく教えて」activate時 |
| support toggles     | policy default     | 必須          | allowlist role boolean                                                                               | unknown role非保存         | valid変更時                  |
| history target      | active workspace   | 削除時必須    | existing workspace ID、running 0                                                                     | dialog内                   | 削除transaction成功          |

## ネイティブ連携

実際のCapability設定は`src-tauri/capabilities/`を正本とし、以下は目的別commandである。

| ユーザー操作                | 実行境界                                                     | Tauri plugin / Command                                                              | 必要なCapability・認可                                                                                                                                                                      | キャンセル時                                              | 拒否・失敗時                                                  |
| --------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| settings/context保存        | Rust DB                                                      | `save_settings_section`                                                             | allowlist section/key/schema、expected version                                                                                                                                              | transaction前なら不変                                     | 前値維持、field/error code                                    |
| app preference読込/保存/reset | Rust owner-only atomic store                               | `app_preferences_get` / `app_preferences_update` / `app_preferences_reset`          | exact `AppPreferencesV1` schema/version、snapshot ID、expected version、fsync + atomic rename                                                                                              | 前snapshot不変                                            | safe default + sanitized diagnostic                            |
| model選択/import            | Tauri dialog → Rust importer                                 | `select_and_import_model3`                                                          | regular file 1件、canonical root、quarantine、resource limit                                                                                                                                | library/DB/quarantine不変                                 | current model継続                                             |
| model preview/select/delete | Rust asset service                                           | `character_read_asset` / `preview/select/delete_character_pack`                     | verified pack UUID、manifest hash、relative asset ID、stable Project ID、全Project usage transaction。trusted frameはbinary responseをmanifestのbyte数/SHA-256へ再照合                     | current state維持                                         | missing/tampered frameは表示せず、bundled/selected delete拒否 |
| semantic mapping            | Rust asset/settings service                                 | `save_semantic_mapping`                                                              | `SemanticMappingV1`、pack ID、manifest hash、expected mapping version、inventory cue allowlist、atomic transaction                                                                         | 前mapping維持                                             | mapping全体neutral fallback                                   |
| Audio設定                   | Rust owner-only atomic store                                 | `narration_get_settings` / `narration_update_settings` / `narration_reset_settings` | `NarrationSettingsV1`、directory owner-only、file `0600`、fsync + atomic rename                                                                                                             | saved version不変                                         | TTS offへfail closed                                          |
| Voice列挙                   | Rust local process                                           | `narration_list_voices`                                                             | fixed `/usr/bin/say` metadata再検証、shellなし、bounded `-v '?'` output、ja/en only                                                                                                         | 前list維持                                                | TTS unavailable + caption維持                                 |
| TTS test/playback/mute      | app-owned presentation controller → Rust local process/audio | `narration_speak` / `narration_cancel`                                              | active commit/presentation generationと一致するcaption確定chunkだけ。bounded redacted stdin、exact voice allowlist、rate 0.75〜1.25、新規process group、queue 3、no network/microphone/file | 同じgeneration keyのprocess group/queue停止、settings維持 | caption維持。main session outputへfallbackしない              |
| support control             | Rust supervisor                                              | `configure/cancel_support`                                                          | role allowlist、budget固定、main分離                                                                                                                                                        | 前config維持                                              | fail closed + fallback                                        |
| diagnostic                  | Rust native readiness service                               | `run_diagnostic_check`                                                              | OS/app/build/schema、Codex binary/auth/model/protocol、Git、DB、Live2Dのread-only check、shared snapshot ID、UTC checkedAt、sanitized code                                                  | 前snapshotをstale表示で維持                               | check単位Blocked/Unavailable                                  |
| history削除                 | Rust DB/artifact service                                     | `delete_workspace_history`                                                          | running 0、workspace ID、Git path mutation禁止                                                                                                                                              | row/artifact不変                                          | partialを成功表示せずrecovery                                 |
| copy diagnostic             | Tauri clipboard                                              | `copy_sanitized_diagnostics`                                                        | redaction済みsummaryだけ                                                                                                                                                                    | 非該当                                                    | raw detailへfallbackしない                                    |

## ウィンドウ固有動作

| 項目                   | 動作                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| 生成・再利用           | 同じ`main` windowを再利用し、元workspaceとreturn routeを保持する            |
| 初期サイズ・最小サイズ | 共通の1470×836 / 960×640                                                    |
| リサイズ               | section navをdrawer化し、main formとCancel/Saveを優先する                   |
| 最大化・全画面         | formは最大780px、preview areaへ残幅を与える                                 |
| 常に手前へ表示         | 不可                                                                        |
| 閉じる操作             | import/test/support taskをcancelし、DB transactionをcommit/rollback後に終了 |
| 未保存変更がある場合   | section内にSave/Discard/Cancelを表示。未保存voice/rateはroute離脱時に破棄   |

## メニュー・ショートカット

| 操作                          | macOS                               | Windows / Linux | 有効条件                   | 実行結果                    |
| ----------------------------- | ----------------------------------- | --------------- | -------------------------- | --------------------------- |
| tab移動                       | `Control+Tab` / `Control+Shift+Tab` | 非対応          | destructive confirmなし    | main tabs循環               |
| section検索                   | `Command+K`                         | 非対応          | Settings active            | section/field searchへfocus |
| picker/preview/dialogを閉じる | `Escape`                            | 非対応          | non-destructive overlay    | 入力維持、triggerへfocus    |
| Save                          | 明示button                          | 非対応          | dirty + valid              | section transaction         |
| destructive action            | shortcutなし                        | 非対応          | safety preflight + confirm | Delete/Reset/history action |

## データ保持

| データ                    | 正本・保存先                                             | 保存契機                                    | 復元契機                            | 破棄条件                                               | 失敗時                                                                                                      |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------- | ----------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| AppPreferencesV1          | owner-only app-private native store                      | valid expected-version transaction、fsync + atomic rename | startup/route、全runtime snapshot | Reset Preferencesでrecordだけsafe defaultへ | missing/corrupt/unknownはraw値非表示、safe default + diagnostic |
| selected character       | stable Project ID → verified pack ID                     | preview/state test後のatomic selection      | 同Project全workspace/restart        | project解除契約。選択中packは削除不可                  | invalid legacy値はbundled Hiyori fallback                                                                 |
| SemanticMappingV1        | pack ID + manifest hash + mapping versionのnative store | inventory検証後のatomic save                | pack load/preview/restart           | pack明示削除                                           | mapping全体neutral fallback                                                                                |
| project/character context | versioned Rust SQLite                                    | expected-version save                       | workspace/Context                   | project/history契約                                    | conflict、入力保持                                                                                          |
| bundled Hiyori            | release resource + manifest                              | build/package                               | startup/selection                   | 削除不可                                               | static/text fallback                                                                                        |
| custom pack               | app-private library + manifest + manifest拘束trusted PNG | quarantineからatomic promotion              | library/selection/card再読込/再起動 | 未使用pack明示削除                                     | orphan quarantine cleanup。trusted PNGがmissing/tamperedならpack metadataは保持しthumbnailだけをfail closed |
| source absolute path      | 保存しない                                               | 非該当                                      | 復元しない                          | picker/import終了                                      | pack UUIDだけ使用                                                                                           |
| Narration setting         | app-private owner-only `NarrationSettingsV1`             | valid temporary fileのfsync + atomic rename | startup/Audio section               | Resetでdefault offへ置換                               | invalid/missingはoffへfail closed                                                                           |
| generated audio           | 保存先なし。system audio outputだけ                      | playback中                                  | 復元しない                          | complete/cancel/switch/quit                            | caption保持                                                                                                 |
| support usage             | Rust SQLite metadata                                     | invocation terminal                         | Support/Diagnostics                 | history削除                                            | raw prompt/response非保存                                                                                   |
| normalized history        | append-only SQLite/artifact                              | writer transaction                          | timeline/evidence/restart           | workspace history明示削除                              | read-only recovery                                                                                          |
| demo workspace history    | browser process memory                                   | preview操作中                               | 同じpreview process内               | preview再起動またはdemo reset。再起動時はfixtureへ戻る | native persistence成功として表示しない                                                                      |
| diagnostic result         | Rust SQLiteのsanitized summary                           | check terminal                              | Settings再表示                      | Reset diagnostics                                      | 前result + stale label                                                                                      |

## OS差分

| 項目                  | macOS                                   | Windows              | Linux                |
| --------------------- | --------------------------------------- | -------------------- | -------------------- |
| support               | macOS 14+ Apple Silicon                 | MVP非対応            | MVP非対応            |
| picker / local speech | native file picker / `/usr/bin/say`     | 非該当               | 非該当               |
| motion preference     | `prefers-reduced-motion` + app override | 非該当               | 非該当               |
| microphone            | capability/request 0件                  | 非該当               | 非該当               |
| unsupported platform  | 非該当                                  | 対応済みと表示しない | 対応済みと表示しない |

## アクセシビリティ

- focus順はsection navigation、heading/status、fields、inline error/help、section actionとする。
- section navigation、toggle、diagnostic、mapping stateはcolorだけで状態を伝えず、label、value、icon/shapeを併用する。
- errorはfieldとの関連をprogrammaticに示し、Save後に最初のinvalid fieldへfocusを置く。
- Live2D preview canvasはpresentation扱いとし、inventory、current state、test resultをHTML textでも表示する。
- audio test sampleは再生前にvisible textとして表示し、mute/off/deviceなしでも同じ意味を取得できる。
- progressはstep名とcount/sizeをtextで出し、頻繁なhash updateをlive regionへ逐次流さない。
- destructive confirmationは削除対象と残るGit dataを読み上げ、Cancelを最初の安全な選択にする。
- App Preferences、mapping、Diagnosticsはloading/empty/error/disabled/recoveryをja/enで同機能にし、status/errorをstable IDでcontrolへ関連付ける。
- Recheckは起点buttonへfocusを維持して`aria-busy`を設定し、完了をpolite、blocked/unavailableをassertive live regionへ1回通知する。Copy後もfocusを奪わない。
- mappingは7 state rowのkeyboard順を固定し、Preview/Save/Reset後は起点row、invalid時は最初のinvalid rowへfocusを戻す。reduced motionでも同じtext結果を得られる。
- Reset Preferencesとpack deleteは`Cancel / キャンセル`を初期focusにしてfocus trapし、Escape=Cancel、close後はexact triggerへfocusを戻す。
- 200% text zoomではsection navをdrawerへ移し、Save/Cancel、import cancel、history cancelを欠落させない。

## 性能と境界

| 指標                       |                                                                            合格条件 |
| -------------------------- | ----------------------------------------------------------------------------------: |
| settings toggle feedback   |                                                                       p95 100ms以下 |
| bundled Hiyori first frame |                                                        S-002表示からp95 3,000ms以下 |
| import resource            | 128 files / 100MiB / 1 file 32MiB / texture 8192² / JSON depth 64を超える前にreject |
| TTS test timeout/cancel    |                                                  timeout 5秒、Cancel/Stop 100ms以内 |
| support                    |                                         active 1、queue 10、task 15秒、16,000 token |

## 関連要件

| 要件ID                                                          | この画面での扱い                                                                          | 要件定義書                                                                    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `WORK-F-048`, `WORK-F-057`, `WORK-F-063`, `WORK-F-066`          | preflight、project登録解除、project/character context、repository health/repair             | [workspace-sessions](../requirements/workspace-sessions.md)                   |
| `CODE-F-051`〜`CODE-F-053`, `CODE-F-075`                        | Codex initialize/login/Sol/effort/attachment前提診断                                      | [codex-main-session](../requirements/codex-main-session.md)                   |
| `SUP-F-062`〜`SUP-F-078`                                        | concurrency、budget、usage、commit explainer skill、controller、toggle、non-persistence、model policy | [support-agent-orchestration](../requirements/support-agent-orchestration.md) |
| `GIT-F-072`, `GIT-F-077`, `GIT-F-079`〜`GIT-F-081`, `GIT-F-090`〜`GIT-F-096` | read-only Git observer、main/explainer skill診断、background生成と明示presentation | [git-review-harness](../requirements/git-review-harness.md) |
| `HIST-F-049`〜`HIST-F-056`, `HIST-F-058`, `HIST-F-059`          | history削除、migration、corruption、writer、schema、support metadata、durability表示      | [activity-history](../requirements/activity-history.md)                       |
| `LIVE-F-055`〜`LIVE-F-081`                                      | bundled Hiyori、renderer、import、mapping、delete、performance                            | [live2d-companion](../requirements/live2d-companion.md)                       |
| `NARR-F-058`, `NARR-F-064`〜`NARR-F-089` | caption-first、default off、local binary/voice/test、explicit presentation、mute、dismiss/cancel、privacy、recovery、no network/microphone/audio file | [audio-commentary](../requirements/audio-commentary.md) |
| `APP-F-055`, `APP-F-057`〜`APP-F-072`, `APP-F-076`              | navigation、versioned native preference、a11y、lifecycle、native readiness、performance   | [desktop-shell](../requirements/desktop-shell.md)                             |

## 未確定事項

| 論点                            | 初期判断                                                                        | 確認事項                                  | 着手ブロック |
| ------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------- | ------------ |
| custom pack名の編集             | manifest由来名を表示し、MVPではrenameしない                                     | user testで識別困難ならaliasを追加する    | いいえ       |
| installed voice差分             | verified `say -v '?'`からja/en exact allowlistを毎回作り、保存voiceを再照合する | release hostでlatency/qualityを再確認する | いいえ       |
| `Allow motion`とOS Reduceの競合 | OS Reduceを優先し、appから解除しない                                            | accessibility reviewでcopyを確認する      | いいえ       |
| history artifact partial delete | transaction journalで再起動時に完了/rollbackを分類する                          | failure injection testで方式を確定する    | いいえ       |

## レビュー確認

| 項目         | 内容       |
| ------------ | ---------- |
| レビュー結果 | Approved   |
| レビュー日   | 2026-07-18 |

- [x] front matter、title、filenameの`S-004`が一致する。
- [x] `status: Approved`である。
- [x] 8 section、project/character context分離、diagnostics、history/privacyを定義した。
- [x] `tmp/hiyori_pro`をbuild入力とし、runtime 17 fileだけを同梱する契約を定義した。
- [x] custom model importのpicker、closure、resource limit、quarantine、preview、mapping、deleteを定義した。
- [x] `AppPreferencesV1`、native readiness snapshot、Project-scoped selection、`SemanticMappingV1`の正常・loading・empty・error・disabled・recoveryを定義した。
- [x] TTS default off、local binary/voice/test/mute、text parity、dismiss/cancel分離、voice retry、dirty draft保持、network/microphone/audio file禁止を定義した。
- [x] normal、empty、loading、processing、offline、error、permission、cancel、restartを定義した。
- [x] 関連要件IDを要件定義書のS-004対応と一致させた。
- [x] 着手ブロックが「はい」または「不明」の未確定事項は0件である。
