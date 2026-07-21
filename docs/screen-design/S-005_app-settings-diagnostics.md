---
title: "S-005 アプリ設定・診断"
description: "登録projectごとのProject contextと、characterごとのpresentation、表示、音声、診断を管理する画面仕様。"
updated: 2026-07-21
read_when:
  - "sidebar gear、project一覧とProject context詳細、アプリ全体の設定、音声、native diagnosticsを実装するとき。"
  - "S-005とAPP、CODE、GIT、LIVE、NARR要件の対応を確認するとき。"
screen_id: "S-005"
status: "Approved"
---

# S-005 アプリ設定・診断

| 項目                   | 内容                                                          |
| ---------------------- | ------------------------------------------------------------- |
| window label           | `main`                                                        |
| React route / view key | `/app-settings/:section?`、`/app-settings/projects/:projectId`、`/app-settings/character/:packId` / `app-settings` |
| 対象OS                 | macOS 14以降、Apple Silicon                                   |
| デザイン               | [DESIGN.md](../../DESIGN.md)、Figma Desktop node `8:2`のshell |
| 共通仕様               | [デスクトップ共通仕様](desktop-common-specification.md)       |
| 廃止理由               | 非該当                                                        |
| 後継画面ID             | 非該当                                                        |

## 目的

利用者が、登録projectを起点にProject contextを管理し、すべてのprojectへ共通適用する設定とアプリ実行環境の診断も、workspace固有の状態と混同せず確認・変更・復旧できるようにする。

## 対象範囲

### 含める

| section     | 内容                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| General           | ja/en、app version。preferenceのpersistence種別、record/schema version、snapshot IDは表示しない         |
| Projects          | appへ登録しているGit project一覧、workspace件数、project詳細、Project context、登録解除                 |
| Character         | character一覧、model名から開く個別設定、packごとのCharacter context、app-globalな選択、custom 1枠のimport/置換・motion編集・delete、bundled Hiyori固定motion preset |
| Audio             | app共通のTTS enable、設定済みprovider選択、provider tab、API key、model、voice、speed、test、自動保存    |
| Diagnostics       | OS/app、Codex、Git、DB、Live2D、audioのnative readinessとrecheck                                         |

### 含めない

| 非対象                                                | 理由                      | 扱う画面・文書                         |
| ----------------------------------------------------- | ------------------------- | -------------------------------------- |
| workspace history削除                                 | 専用UIを廃止したため      | 非該当                                 |
| account credential、raw stderr、absolute private path | secret boundaryを守るため | sanitized readiness statusだけ表示する |

## 表示契機と終了

| 項目           | 内容                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| 表示契機       | workspace sidebar最下部の`App settings / アプリ設定` gear、Chatのdiagnostics link        |
| 表示前提       | workspace選択は不要。registered project/workspaceが0件でも5 sectionすべてを表示する                 |
| 初期フォーカス | header breadcrumbの現在section                                                           |
| 正常完了       | section単位の保存を即時反映し、画面を維持する                                            |
| キャンセル     | section固有のdraftと保存済み値を各契約どおり維持する                                     |
| 閉じる操作     | workspace sidebarでworkspaceを選び、現在のworkspace tabへ戻る                             |
| 再表示         | gearはGeneral、diagnostics linkはDiagnosticsを開き、保存済み値を維持する                  |

## 利用者と権限

| 利用者・ロール | 表示                                                                 | 操作                            | 拒否時の動作                                       |
| -------------- | -------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------- |
| ローカル利用者 | non-secret global setting、character metadata、sanitized readiness   | edit、import、select、test、retry、reset | 保存済み値を維持し、操作箇所にsafe errorを表示する |
| React WebView  | typed snapshot、status、safe code                                    | render、input、typed IPC        | Codex pathは利用者が編集中の設定requestにだけ保持し、response、履歴、通常logへ残さない。その他のraw path、secret、arbitrary commandを保持しない    |
| Rust service   | owner-only preference/context/character/narration store、readiness | validate、atomic save、diagnose | scope外payloadを拒否し、前snapshotを維持する |

## 画面構成

| 領域                | 表示内容                                                      | 主な操作                       |
| ------------------- | ------------------------------------------------------------- | ------------------------------ |
| workspace sidebar   | workspace一覧、activeなapp settings gear                      | workspaceへ戻る、project追加   |
| app settings header | `App settings / アプリ設定` > 現在sectionのbreadcrumbだけを表示する | compact幅では現在sectionからsection pickerを開く |
| section navigation  | General、Projects、Character、Audio、Diagnosticsの5 section | section選択 |
| settings main       | 選択sectionのform、status、error、recovery。GeneralにはLanguageとCodex CLI pathを表示する | edit、save、test、retry、reset |

app settings表示中はworkspace breadcrumbとChat/Commit tabを表示しない。これによりworkspace scopeを示すheaderとglobal scopeを同時にactive表示しない。960〜1279pxではsection navigationをpopoverへ移し、mainを単一columnで表示する。

## 表示状態

| 状態       | 進入条件                          | 表示                                           | 操作可否               | 状態から抜ける条件      |
| ---------- | --------------------------------- | ---------------------------------------------- | ---------------------- | ----------------------- |
| 初期化中   | preference/readiness未取得        | field shape skeleton、loading status           | workspace選択のみ可    | snapshot取得またはerror |
| 通常       | snapshot取得済み                  | 5 sectionと保存済み値                          | 契約済み操作が可       | save/test/recheck開始   |
| データなし | 設定済みTTS providerまたはdiagnostic resultが0件 | provider未設定理由と設定tab、またはRetry       | TTS toggle/provider select以外は可 | API key保存または再取得成功 |
| 処理中     | save、自動保存、test、recheck中   | 操作箇所のprocessing status                    | 同一操作の二重実行不可 | terminal result         |
| オフライン | network/Codex unavailable         | 保存済み設定は表示し、OpenAI testはUnavailable | 設定保存とrecheck可    | readiness更新           |
| エラー     | storeまたはdiagnostic失敗         | safe code、前snapshot、Retry                   | 破壊的fallback不可     | retry成功               |
| 権限不足   | native operation拒否              | localized reason、変更前値                     | scope外操作不可        | permission回復後のretry |

## 操作

| 操作                  | 事前条件              | 正常結果                                          | キャンセル時                   | 失敗時                          | 関連要件ID                            |
| --------------------- | --------------------- | ------------------------------------------------- | ------------------------------ | ------------------------------- | ------------------------------------- |
| app settingsを開く    | workspace shell表示中 | gearをactiveにしS-005のGeneralだけを表示          | 非該当                         | shellとworkspace stateを維持    | `APP-F-083`                           |
| workspaceを選ぶ       | S-005表示中           | app settingsを閉じ、現在のactive tabで選択workspaceへ切り替える | running turn時は既存switch確認 | 選択前workspaceを維持           | `APP-F-055`                           |
| preferenceを変更する  | Generalがready        | 全workspaceへ即時反映しatomic保存                 | 前値維持                       | 前durable snapshot、Retry       | `APP-F-057`, `APP-F-058`, `APP-F-076` |
| Codex pathを設定する | Generalまたは初回setupがready | Rustがabsolute pathをcanonicalizeし、binary trust、version、App Server起動とstable initializeを検証してapp-private設定へ保存する。schema、auth、config、modelは通常workspace接続まで確認しない。次のreadiness snapshotを返し、実行中sessionは変更しない。overview setupから成功した場合は未接続の選択workspace再接続を追加clickなしで開始するが、その完了をfieldのprocessingまたはoverview終了の条件にしない | 入力と前設定を維持 | 入力を保持しfield直下にsafe code、前設定を維持。後続のworkspace activation失敗はpathをinvalid扱いせず通常workspaceでSend不可のreasonを表示する | `CODE-F-051`, `WORK-F-048` |
| Codex pathを自動検出へ戻す | 明示pathが設定済み | app-private設定を削除し、GUI `PATH`、default login shell、既知install位置の探索結果でreadinessを更新する | 前設定を維持 | 前設定とsnapshotを維持しsafe code | `CODE-F-051` |
| character個別設定を開く | Character一覧がready | 選択行のmodel名、必要な操作、motion設定、Character contextを同sectionに表示 | 非該当 | 一覧を維持 | `LIVE-F-084`, `LIVE-F-086` |
| Character contextを保存する | character個別設定がready | 対象packのversionだけを更新し、そのpackを選択した次の全workspace turnから適用 | draft維持 | field errorまたはconflict、draft維持 | `APP-F-084`, `WORK-F-063`, `LIVE-F-086` |
| character一覧へ戻る | character個別設定を表示中 | 一覧を表示し、起点character行へfocusを戻す | 非該当 | 個別設定を維持 | `LIVE-F-084` |
| modelを選択する       | verified pack preview成功 | 全workspaceへatomic適用                           | 前selection維持                | 前selection維持、safe error     | `APP-F-084`, `LIVE-F-075` |
| custom modelを取り込む | custom slotが空、native picker利用可能 | 検証・preview成功後に1件を保存しapp-global選択へatomic適用 | 前selectionと空slotを維持 | localized reasonとsafe code、前selection維持 | `LIVE-F-068`〜`LIVE-F-076` |
| custom modelを置き換える | custom slot使用中、native picker利用可能 | 検証・preview成功後に旧assetを新packへatomic置換しapp-global選択を新packへ切り替える | 前slotとselectionを維持 | 前slotとselectionを維持しlocalized reasonとsafe code | `LIVE-F-073`〜`LIVE-F-078` |
| custom modelを削除する | custom slot使用中、確認済み | app-global selectionをbundled Hiyoriへ戻してからassetとmappingを削除 | 前slotとselectionを維持 | 前slotとselectionを維持しsafe error | `LIVE-F-078` |
| readinessを再確認する | Diagnostics表示中     | shared snapshot IDを更新                          | 前snapshotをstale表示          | safe codeとRetry                | `APP-F-070`                           |
| project登録を解除する | Projects表示中、対象にactive/pending turnなし | 確認後にapp registrationだけを外し、repositoryと既存worktreeを残す | 一覧とregistrationを維持 | 対象を残してsafe errorとRetry | `WORK-F-057`, `WORK-F-068` |
| project詳細を開く | Projects一覧で登録projectを選択 | 同じProjects section内でproject identityとProject context editorを表示 | 一覧を維持 | 一覧と他projectのdraftを維持 | `WORK-F-063`, `APP-F-083` |
| Project contextを保存する | project詳細がready | Project ID単位のversionを更新し、同projectの全workspaceで次turnから適用 | draft維持 | field errorまたはconflict、draft維持 | `WORK-F-063` |
| Audio設定を変更する | Audioがready、入力がvalid | enable/provider/model/voiceは変更直後、speedは操作確定時、API keyは500ms入力停止またはblur時に自動保存し、成功snapshotへ再同期 | validation失敗入力を維持 | 最後の保存済みsnapshotと入力を維持しsafe errorを表示 | `NARR-F-089`, `NARR-F-090` |

## 入力項目

| 項目                 | 初期値    | 必須     | 制約・境界                            | エラー表示            | 保存契機 |
| -------------------- | --------- | -------- | ------------------------------------- | --------------------- | -------- |
| Language             | OS locale | 必須     | `ja` / `en`                           | field直下、前言語維持 | 選択時   |
| Codex executable path | 自動検出 | 任意 | UTF-8 absolute path、1〜4,096 byte、NUL/control不可。保存時にRustでcanonical trusted executable、version、App Server spawnとstable initializeを検証 | field直下にsafe code、入力と前設定を維持 | `Use this path`。明示設定中は`Use automatic detection`も表示 |
| Character context    | bundled Hiyoriは桃瀬ひよりpreset、customはpack表示名と中立な既定値 | 任意 | opaque pack ID単位、display name 1〜40、全体12,000 scalar、technical policy禁止 | field直下、draft維持 | Save |
| Project context      | 空       | 任意 | goal / constraints / notes各8,000、配列各20件、総量32,000 scalar、project-relative reference | field直下、draft維持 | Save |
| TTS enabled          | off       | 必須     | 保存済みAPI keyと選択可能providerがある時だけon | toggle直下、offへfail closed | 変更直後に自動保存 |
| TTS provider         | なし      | 条件付き | 設定済みproviderだけを候補表示。0件ではselectをdisabledにして未設定表示 | provider select直下 | 変更直後に自動保存 |
| OpenAI API key       | 空        | 条件付き | password input、trim後1〜512文字。保存済み値はWebViewへ返さず、設定済み状態だけを返す | OpenAI tab内、入力値維持 | 500ms入力停止またはblur時に自動保存 |
| OpenAI model         | `gpt-4o-mini-tts` | 条件付き | app allowlist内のSpeech API対応model | OpenAI tab内 | 変更直後に自動保存 |
| OpenAI voice         | `marin`   | 条件付き | 選択modelで利用可能な組み込みvoice allowlist | OpenAI tab内 | 変更直後に自動保存 |
| Speech speed         | 1.0       | 必須     | 0.75〜1.25、0.05刻みのslider | OpenAI tab内 | value commit時に自動保存 |

Audio sectionでは、通常時の見出し説明と各fieldの補助文を表示せず、validation errorや保存状態など操作結果に必要な動的feedbackだけを残す。provider、OpenAI model、voiceは共通の非native `Select`を使い、候補をportalへ表示する。OpenAI tab内のmodelとvoiceは同幅の2カラムへ配置し、triggerはfield幅へ引き伸ばさず内容に必要なcompact幅とする。speed sliderとTest voice操作も2カラムへ並べ、狭いviewportと200% text zoomではfocus順を保った1カラムへ戻す。AI生成音声に関する静的calloutと、Save、Discard、Resetのbuttonは表示しない。

## ネイティブ連携

| ユーザー操作                | 実行境界                 | Tauri plugin / Command             | 必要なCapability・認可                | キャンセル時      | 拒否・失敗時                          |
| --------------------------- | ------------------------ | ---------------------------------- | ------------------------------------- | ----------------- | ------------------------------------- |
| preference取得・更新       | Rust owner-only store    | `app_preferences_get/update`       | exact schema/version                  | 前record維持      | safe defaultまたは前record、safe code |
| Character context load/save | Rust SQLite             | app character context commands     | opaque pack ID、expected version      | draft維持         | conflictまたはsafe code                |
| Project context load/save | Rust SQLite | `project_context_get` / `project_context_save` | registered Project ID、expected version、canonical project-relative reference | draft維持 | conflictまたはsafe code |
| model import/select/motion設定/delete | Rust asset/settings service | character library commands | app-global scope、pack ID、manifest hash、custom slot上限1。bundled Hiyoriのpreset保存要求は拒否 | quarantine cleanup、前selection維持 | bundled preset編集・delete拒否、置換/削除失敗時は前slotとselection維持 |
| Audio取得・自動保存・test   | Rust provider adapter/private store | `narration_*`                 | fixed OpenAI Speech endpoint、Bearer secret、model/voice allowlist、owner-only secret、fixed audio player、expected version | request/playback停止 | 最後の保存済みsnapshotと入力、captionを維持 |
| readiness recheck           | Rust readiness service   | `run_diagnostic_check`             | read-only check                       | 前snapshot維持    | stale snapshotとsafe code             |
| Codex path保存・自動検出復帰 | Rust readiness / app-private workspace store | `configure_codex_binary` | exact request schema、absolute path上限、binary trust、version、App Server spawn / stable initialize。responseはreadiness snapshotだけでpathを返さない | 入力と前record維持 | 前recordとsnapshotを維持しsafe code |
| project一覧・登録解除       | Rust workspace store     | `workspace_list` / `workspace_unregister` | typed Project ID、metadata-only mutation | 一覧維持 | repository/worktreeを変更せずsafe code |

## ウィンドウ固有動作

単一`main` windowを再利用する。初期・最小サイズ、close、full screenは共通仕様どおり。app settings表示中もsidebarを維持し、bodyだけを専用header、section navigation、main formへ置換する。

## メニュー・ショートカット

| 操作                 | macOS    | Windows / Linux | 有効条件             | 実行結果                     |
| -------------------- | -------- | --------------- | -------------------- | ---------------------------- |
| overlayを閉じる      | `Escape` | 非対応          | popover/dialog表示中 | 入力を維持してtriggerへfocus |
| app settingsを閉じる | workspace選択 | 非対応      | S-005表示中          | 現在のworkspace tabへ戻る    |

## データ保持

Project ID単位のProject context、言語だけを保持する`AppPreferencesV2`、app-private settingsに保存する検証済みCodex canonical path、pack ID単位のCharacter context、character library selection/custom motion設定、Narration settings、readiness snapshotの正本と失敗契約は各要件定義書に従う。Codex pathは設定済みかどうかだけをreadiness factで返し、canonical valueはWebView、diagnostics、履歴本文、通常logへ返さない。NarrationのAPI keyはowner-only native storeだけに保存し、WebView、diagnostics、logへ平文を返さない。`AppPreferencesV1`からはlocaleだけを移行し、廃止したreduced motion、character visibility、Reset Preferences、Reset UI stateを公開しない。コミット説明の内部実行単位、model policy、利用量、監査metadataはS-005に表示しない。一覧と詳細の表示だけではworkspace history、Git state、他projectまたは他packのdraftを変更しない。

## OS差分

MVPはmacOS 14以降のApple Siliconだけを検証する。Windows/Linuxを対応済みとして表示しない。

## アクセシビリティ

- gearは`App settings / アプリ設定`というscopeを含むaccessible nameと`aria-current`を持つ。
- Audioのfocus順はTTS toggle、provider select、provider tabs、API key、API key削除、model、voice、speed、test、test停止とし、Save、Discard、Reset、mute control、commit presentation statusを設定画面へ表示しない。
- API keyは`type=password`とし、保存済み値の伏字文字数や末尾を再現せず、`設定済み / Configured`という状態だけをtextでも示す。
- 画面進入時とsection変更時にbreadcrumbの現在sectionへfocusする。専用のBack buttonは置かず、workspace選択後は選択したworkspace rowへfocusを維持する。
- project行は名前、repository、workspace件数を含むaccessible nameを持ち、詳細から一覧へ戻ると起点projectへfocusを戻す。
- character行はmodel名と使用中状態を含むaccessible nameを持ち、個別設定から一覧へ戻ると起点character行へfocusを戻す。
- section navigation、error、readinessを色だけで表現しない。
- Codex path fieldはvisible label、補助説明、入力単位のerror live regionを持ち、保存成功後はpath自体ではなく`Custom path configured / カスタムパス設定済み`を通知する。
- 200% text zoomではsection navigationをpopover化し、全fieldとactionへ到達できる。

## 関連要件

| 要件ID                                                               | この画面での扱い                                 | 要件定義書                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `APP-F-055`, `APP-F-057`〜`APP-F-072`, `APP-F-076`, `APP-F-083`, `APP-F-084` | global navigation、preference、character presentation、diagnostics、a11y | [desktop-shell](../requirements/desktop-shell.md) |
| `CODE-F-051`〜`CODE-F-053`, `CODE-F-075`                             | Codex readiness                                  | [codex-main-session](../requirements/codex-main-session.md)                   |
| `GIT-F-077`, `GIT-F-079`〜`GIT-F-081`, `GIT-F-092`                   | read-only Git/skill diagnostics                  | [git-review-harness](../requirements/git-review-harness.md)                   |
| `NARR-F-058`, `NARR-F-064`〜`NARR-F-077`, `NARR-F-088`〜`NARR-F-090` | app共通Audio                                     | [audio-commentary](../requirements/audio-commentary.md)                       |
| `LIVE-F-055`〜`LIVE-F-081`, `LIVE-F-083`〜`LIVE-F-086`              | global model library、motion設定、一覧・個別設定、固定Hiyori motion preset、pack別context、character用語契約 | [live2d-character](../requirements/live2d-character.md)                       |

## 未確定事項

| 論点   | 初期判断                   | 確認事項 | 着手ブロック |
| ------ | -------------------------- | -------- | ------------ |
| 非該当 | pack別scopeはAPP-F-084で確定 | 非該当   | いいえ       |

## レビュー確認

| 項目         | 内容       |
| ------------ | ---------- |
| レビュー結果 | Approved   |
| レビュー日   | 2026-07-20 |

- [x] app settingsの5 section、Projects内のproject-scoped詳細、Character内のpack-scoped詳細、workspace-scoped非対象が一意である。
- [x] breadcrumb、workspace選択時の終了と状態維持を定義した。
- [x] loading、empty、processing、offline、error、permissionを定義した。
- [x] native boundary、ja/en、keyboard、200% zoomを定義した。
- [x] `agent-docs lint`対象のfront matterと相互参照を記載した。
