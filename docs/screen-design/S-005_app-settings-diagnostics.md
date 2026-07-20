---
title: "S-005 アプリ設定・診断"
description: "登録projectごとのProject contextと、全projectへ共通適用するcharacter presentation、表示、音声、支援、診断を管理する画面仕様。"
updated: 2026-07-20
read_when:
  - "sidebar gear、project一覧とProject context詳細、アプリ全体の設定、音声、support、native diagnosticsを実装するとき。"
  - "S-005とAPP、CODE、SUP、GIT、LIVE、NARR要件の対応を確認するとき。"
screen_id: "S-005"
status: "Approved"
---

# S-005 アプリ設定・診断

| 項目                   | 内容                                                          |
| ---------------------- | ------------------------------------------------------------- |
| window label           | `main`                                                        |
| React route / view key | `/app-settings/:section?`、`/app-settings/projects/:projectId` / `app-settings` |
| 対象OS                 | macOS 14以降、Apple Silicon                                   |
| デザイン               | [DESIGN.md](../../DESIGN.md)、Figma Desktop node `8:2`のshell |
| 共通仕様               | [デスクトップ共通仕様](desktop-common-specification.md)       |
| 廃止理由               | 非該当                                                        |
| 後継画面ID             | 非該当                                                        |

## 目的

利用者が、登録projectを起点にProject contextを管理し、すべてのprojectへ共通適用する設定とアプリ実行環境の診断も、workspace固有の履歴設定と混同せず確認・変更・復旧できるようにする。

## 対象範囲

### 含める

| section     | 内容                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| General           | ja/en、app version。preferenceのpersistence種別、record/schema version、snapshot IDは表示しない         |
| Projects          | appへ登録しているGit project一覧、workspace件数、project詳細、Project context、登録解除                 |
| Character context | app-globalなname、tone、speech density、behavior、prohibited expressions                                |
| Companion         | app-globalなbundled Hiyoriとcustom 1枠、選択、import/置換、preview、semantic mapping、provenance、delete、runtime status |
| Audio             | app共通のlocal TTS enable、voice、rate、mute、test、reset                                                |
| Support           | app共通のsupport role enable、readiness、capacity、usage、sanitized error                                |
| Diagnostics       | OS/app、Codex、Git、DB、Live2D、audio、supportのnative readinessとrecheck                                |

### 含めない

| 非対象                                                | 理由                      | 扱う画面・文書                         |
| ----------------------------------------------------- | ------------------------- | -------------------------------------- |
| workspace history削除                                 | workspace-scopedのため    | [S-006](S-006_project-settings.md)     |
| account credential、raw stderr、absolute private path | secret boundaryを守るため | sanitized readiness statusだけ表示する |

## 表示契機と終了

| 項目           | 内容                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| 表示契機       | workspace sidebar最下部の`App settings / アプリ設定` gear、Chatのdiagnostics link        |
| 表示前提       | workspace選択は不要。registered project/workspaceが0件でも7 sectionすべてを表示する                 |
| 初期フォーカス | header breadcrumbの現在section                                                           |
| 正常完了       | section単位の保存を即時反映し、画面を維持する                                            |
| キャンセル     | section固有のdraftと保存済み値を各契約どおり維持する                                     |
| 閉じる操作     | workspace sidebarでworkspaceを選び、現在のworkspace tabへ戻る                             |
| 再表示         | gearはGeneral、diagnostics linkはDiagnosticsを開き、保存済み値を維持する                  |

## 利用者と権限

| 利用者・ロール | 表示                                                                 | 操作                            | 拒否時の動作                                       |
| -------------- | -------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------- |
| ローカル利用者 | non-secret global setting、character metadata、sanitized readiness   | edit、import、select、test、retry、reset | 保存済み値を維持し、操作箇所にsafe errorを表示する |
| React WebView  | typed snapshot、status、safe code                                    | render、input、typed IPC        | raw path、secret、arbitrary commandを保持しない    |
| Rust service   | owner-only preference/context/character/narration store、readiness、support controller | validate、atomic save、diagnose | scope外payloadを拒否し、前snapshotを維持する |

## 画面構成

| 領域                | 表示内容                                                      | 主な操作                       |
| ------------------- | ------------------------------------------------------------- | ------------------------------ |
| workspace sidebar   | workspace一覧、activeなapp settings gear                      | workspaceへ戻る、project追加   |
| app settings header | `App settings / アプリ設定` > 現在sectionのbreadcrumbだけを表示する | compact幅では現在sectionからsection pickerを開く |
| section navigation  | General、Projects、Character context、Companion、Audio、Support、Diagnosticsの7 section | section選択 |
| settings main       | 選択sectionのform、status、error、recovery                    | edit、save、test、retry、reset |

app settings表示中はworkspace breadcrumbとChat/Commit/Settings tabを表示しない。これによりworkspace scopeを示すheaderとglobal scopeを同時にactive表示しない。960〜1279pxではsection navigationをpopoverへ移し、mainを単一columnで表示する。

## 表示状態

| 状態       | 進入条件                          | 表示                                           | 操作可否               | 状態から抜ける条件      |
| ---------- | --------------------------------- | ---------------------------------------------- | ---------------------- | ----------------------- |
| 初期化中   | preference/readiness未取得        | field shape skeleton、loading status           | workspace選択のみ可    | snapshot取得またはerror |
| 通常       | snapshot取得済み                  | 7 sectionと保存済み値                          | 契約済み操作が可       | save/test/recheck開始   |
| データなし | voiceまたはdiagnostic resultが0件 | 理由とRetry                                    | 影響しないsectionは可  | 再取得成功              |
| 処理中     | save、test、reset、recheck中      | 操作箇所のprocessing status                    | 同一操作の二重実行不可 | terminal result         |
| オフライン | network/Codex unavailable         | local settingは表示、診断はBlocked/Unavailable | local saveとrecheck可  | readiness更新           |
| エラー     | storeまたはdiagnostic失敗         | safe code、前snapshot、Retry                   | 破壊的fallback不可     | retry成功               |
| 権限不足   | native operation拒否              | localized reason、変更前値                     | scope外操作不可        | permission回復後のretry |

## 操作

| 操作                  | 事前条件              | 正常結果                                          | キャンセル時                   | 失敗時                          | 関連要件ID                            |
| --------------------- | --------------------- | ------------------------------------------------- | ------------------------------ | ------------------------------- | ------------------------------------- |
| app settingsを開く    | workspace shell表示中 | gearをactiveにしS-005のGeneralだけを表示          | 非該当                         | shellとworkspace stateを維持    | `APP-F-083`                           |
| workspaceを選ぶ       | S-005表示中           | app settingsを閉じ、現在のactive tabで選択workspaceへ切り替える | running turn時は既存switch確認 | 選択前workspaceを維持           | `APP-F-055`                           |
| preferenceを変更する  | Generalがready        | 全workspaceへ即時反映しatomic保存                 | 前値維持                       | 前durable snapshot、Retry       | `APP-F-057`, `APP-F-058`, `APP-F-076` |
| Character contextを保存する | Character contextがready | global versionを更新し次の全workspace turnから適用 | draft維持 | field errorまたはconflict、draft維持 | `APP-F-084`, `WORK-F-063` |
| modelを選択する       | verified pack preview成功 | 全workspaceへatomic適用                           | 前selection維持                | 前selection維持、safe error     | `APP-F-084`, `LIVE-F-075` |
| custom modelを取り込む | custom slotが空、native picker利用可能 | 検証・preview成功後に1件を保存しapp-global選択へatomic適用 | 前selectionと空slotを維持 | localized reasonとsafe code、前selection維持 | `LIVE-F-068`〜`LIVE-F-076` |
| custom modelを置き換える | custom slot使用中、native picker利用可能 | 検証・preview成功後に旧assetを新packへatomic置換しapp-global選択を新packへ切り替える | 前slotとselectionを維持 | 前slotとselectionを維持しlocalized reasonとsafe code | `LIVE-F-073`〜`LIVE-F-078` |
| custom modelを削除する | custom slot使用中、確認済み | app-global selectionをbundled Hiyoriへ戻してからassetとmappingを削除 | 前slotとselectionを維持 | 前slotとselectionを維持しsafe error | `LIVE-F-078` |
| readinessを再確認する | Diagnostics表示中     | shared snapshot IDを更新                          | 前snapshotをstale表示          | safe codeとRetry                | `APP-F-070`                           |
| project登録を解除する | Projects表示中、対象にactive/pending turnなし | 確認後にapp registrationだけを外し、repositoryと既存worktreeを残す | 一覧とregistrationを維持 | 対象を残してsafe errorとRetry | `WORK-F-057`, `WORK-F-068` |
| project詳細を開く | Projects一覧で登録projectを選択 | 同じProjects section内でproject identityとProject context editorを表示 | 一覧を維持 | 一覧と他projectのdraftを維持 | `WORK-F-063`, `APP-F-083` |
| Project contextを保存する | project詳細がready | Project ID単位のversionを更新し、同projectの全workspaceで次turnから適用 | draft維持 | field errorまたはconflict、draft維持 | `WORK-F-063` |

## 入力項目

| 項目                 | 初期値    | 必須     | 制約・境界                            | エラー表示            | 保存契機 |
| -------------------- | --------- | -------- | ------------------------------------- | --------------------- | -------- |
| Language             | OS locale | 必須     | `ja` / `en`                           | field直下、前言語維持 | 選択時   |
| Character context    | `Sol`と既定presentation | 任意 | display name 1〜40、全体12,000 scalar、technical policy禁止 | field直下、draft維持 | Save |
| Project context      | 空       | 任意 | goal / constraints / notes各8,000、配列各20件、総量32,000 scalar、project-relative reference | field直下、draft維持 | Save |
| Audio settings       | off       | 条件付き | verified local voice、rate 0.75〜1.25 | Audio内Alert          | Save     |
| Support controls     | disabled  | 条件付き | approved role/policyだけ              | Support内Alert        | toggle時 |

## ネイティブ連携

| ユーザー操作                | 実行境界                 | Tauri plugin / Command             | 必要なCapability・認可                | キャンセル時      | 拒否・失敗時                          |
| --------------------------- | ------------------------ | ---------------------------------- | ------------------------------------- | ----------------- | ------------------------------------- |
| preference取得・更新       | Rust owner-only store    | `app_preferences_get/update`       | exact schema/version                  | 前record維持      | safe defaultまたは前record、safe code |
| Character context load/save | Rust SQLite             | app character context commands     | global singleton、expected version    | draft維持         | conflictまたはsafe code                |
| Project context load/save | Rust SQLite | `project_context_get` / `project_context_save` | registered Project ID、expected version、canonical project-relative reference | draft維持 | conflictまたはsafe code |
| model import/select/mapping/delete | Rust asset/settings service | character library commands | app-global scope、pack ID、manifest hash、custom slot上限1 | quarantine cleanup、前selection維持 | bundled delete拒否、置換/削除失敗時は前slotとselection維持 |
| Audio取得・保存・test       | Rust local process/store | `narration_*`                      | fixed `/usr/bin/say`、voice allowlist | process group停止 | caption維持、TTS offへfail closed     |
| Support control             | Rust supervisor          | `configure/cancel_support`         | role allowlist、budget固定            | 前config維持      | disabled fallback                     |
| readiness recheck           | Rust readiness service   | `run_diagnostic_check`             | read-only check                       | 前snapshot維持    | stale snapshotとsafe code             |
| project一覧・登録解除       | Rust workspace store     | `workspace_list` / `workspace_unregister` | typed Project ID、metadata-only mutation | 一覧維持 | repository/worktreeを変更せずsafe code |

## ウィンドウ固有動作

単一`main` windowを再利用する。初期・最小サイズ、close、full screenは共通仕様どおり。app settings表示中もsidebarを維持し、bodyだけを専用header、section navigation、main formへ置換する。

## メニュー・ショートカット

| 操作                 | macOS    | Windows / Linux | 有効条件             | 実行結果                     |
| -------------------- | -------- | --------------- | -------------------- | ---------------------------- |
| overlayを閉じる      | `Escape` | 非対応          | popover/dialog表示中 | 入力を維持してtriggerへfocus |
| app settingsを閉じる | workspace選択 | 非対応      | S-005表示中          | 現在のworkspace tabへ戻る    |

## データ保持

Project ID単位のProject context、言語だけを保持する`AppPreferencesV2`、app-global Character context、character library selection/mapping、Narration settings、Support metadata、readiness snapshotの正本と失敗契約は各要件定義書に従う。`AppPreferencesV1`からはlocaleだけを移行し、廃止したreduced motion、character visibility、Reset Preferences、Reset UI stateを公開しない。Projects一覧と詳細の表示だけではworkspace history、Git state、他projectのdraftを変更しない。

## OS差分

MVPはmacOS 14以降のApple Siliconだけを検証する。Windows/Linuxを対応済みとして表示しない。

## アクセシビリティ

- gearは`App settings / アプリ設定`というscopeを含むaccessible nameと`aria-current`を持つ。
- 画面進入時とsection変更時にbreadcrumbの現在sectionへfocusする。専用のBack buttonは置かず、workspace選択後は選択したworkspace rowへfocusを維持する。
- project行は名前、repository、workspace件数を含むaccessible nameを持ち、詳細から一覧へ戻ると起点projectへfocusを戻す。
- section navigation、error、readinessを色だけで表現しない。
- 200% text zoomではsection navigationをpopover化し、全fieldとactionへ到達できる。

## 関連要件

| 要件ID                                                               | この画面での扱い                                 | 要件定義書                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `APP-F-055`, `APP-F-057`〜`APP-F-072`, `APP-F-076`, `APP-F-083`, `APP-F-084` | global navigation、preference、character presentation、diagnostics、a11y | [desktop-shell](../requirements/desktop-shell.md) |
| `CODE-F-051`〜`CODE-F-053`, `CODE-F-075`                             | Codex readiness                                  | [codex-main-session](../requirements/codex-main-session.md)                   |
| `SUP-F-062`〜`SUP-F-078`                                             | global support control/readiness                 | [support-agent-orchestration](../requirements/support-agent-orchestration.md) |
| `GIT-F-077`, `GIT-F-079`〜`GIT-F-081`, `GIT-F-092`                   | read-only Git/skill diagnostics                  | [git-review-harness](../requirements/git-review-harness.md)                   |
| `NARR-F-058`, `NARR-F-064`〜`NARR-F-077`, `NARR-F-088`, `NARR-F-089` | app共通Audio                                     | [audio-commentary](../requirements/audio-commentary.md)                       |
| `LIVE-F-055`〜`LIVE-F-083`                                          | global model library、mapping、runtime readiness、常時表示 | [live2d-companion](../requirements/live2d-companion.md)                       |

## 未確定事項

| 論点   | 初期判断                   | 確認事項 | 着手ブロック |
| ------ | -------------------------- | -------- | ------------ |
| 非該当 | 分離scopeはAPP-F-083で確定 | 非該当   | いいえ       |

## レビュー確認

| 項目         | 内容       |
| ------------ | ---------- |
| レビュー結果 | Approved   |
| レビュー日   | 2026-07-20 |

- [x] app settingsの7 section、Projects内のproject-scoped詳細、workspace-scoped非対象が一意である。
- [x] breadcrumb、workspace選択時の終了と状態維持を定義した。
- [x] loading、empty、processing、offline、error、permissionを定義した。
- [x] native boundary、ja/en、keyboard、200% zoomを定義した。
- [x] `agent-docs lint`対象のfront matterと相互参照を記載した。
