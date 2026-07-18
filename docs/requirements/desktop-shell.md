---
title: "APP デスクトップシェル要件定義"
description: "Coding Wifeの単一Tauriウィンドウ、言語、アクセシビリティ、ライフサイクル、信頼境界、macOS配布物を定義する。"
updated: 2026-07-18
read_when:
  - "デスクトップシェル、共通ナビゲーション、言語、アクセシビリティを実装するとき。"
  - "TauriのCapability、CSP、終了、復旧の契約を確認するとき。"
  - "macOSの.app・DMG配布物、release手順、diff hygieneを変更するとき。"
---

# デスクトップシェル 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `APP` |
| 状態 | Approved |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-18 |
| 最終レビュー日 | 2026-07-18 |

## 背景

Codex、Git、Live2D、履歴を一つのデスクトップ画面で安全に調停する共通基盤がない。WebViewへローカル権限を直接渡さず、作業中の状態を失わずに終了・再起動できるシェルが必要である。

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| 一つの作業面を提供する | macOSで単一main windowが起動し、S-001〜S-004へ移動できる |
| ローカル権限を限定する | 許可された目的別操作だけがRust境界を通り、任意shell・任意filesystem操作をWebViewから実行できない |
| 作業状態を保護する | close、crash、再起動後に未完了処理を再実行せず、安全な回復概要を表示する |
| 審査用macOS配布物を再現する | Finder自動化に依存せず、検証済み`.app`とread-only DMGを明示commandで生成できる |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| Desktop shell | Tauri v2の単一main window、macOS chrome、minimum size、navigation |
| 共通状態 | loading、empty、offline、permission denied、error、recovery |
| 言語 | 日本語・英語の初期選択、即時切替、永続化 |
| Accessibility | keyboard、focus、contrast、200% text zoom、reduced motion、screen reader |
| Trust boundary | typed command、最小Capability、CSP、secret redaction |
| macOS release | Apple Silicon用`.app`、Finder非依存DMG、artifact検証、diff hygiene |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| Windows / Linux配布 | Build Week MVPは検証済みmacOS artifactへ集中する | 将来のplatform validation |
| 複数window | demoの単一作業面と状態一貫性を優先する | 将来検討 |
| 自動update | 署名・配布基盤を今回のMVPに含めない | 将来のrelease要件 |
| Developer ID署名・Apple公証 | ハッカソンMVPはローカルで再現する未署名配布物に限定し、外部配布の信頼連鎖を別gateとする | [macOS release packaging調査](../research/macos-release-packaging.md) |
| 内蔵terminal | 任意shellをWebViewへ公開しない | [Codex main session](codex-main-session.md)のread-only tool event |
| light theme | Figma node 8:2のdark restrained systemを正本とする | [DESIGN.md](../../DESIGN.md) |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ローカル利用者 | macOSへログインしてアプリを操作する本人 | 画面移動、設定、許可されたnative操作、終了 | OS権限または入力条件を満たさない操作を実行せず、理由と回復操作を表示する |
| React WebView | 表示と入力を担当する非信頼境界 | allowlist済みtyped commandの呼び出し | 未登録command、scope外path、無効payloadをRust側で拒否する |
| Rust core | OS、process、Git、DB、assetの信頼境界 | 検証済み入力に対する目的別処理 | 失敗を構造化errorとして返し、secretとabsolute private pathを表示用payloadから除く |
| Release maintainer / CI | リポジトリ所有の手順でmacOS artifactを作る実行者 | 検証済み`.app`からDMGを作る、明示指定でartifactを置換する、diff hygieneを検査する | 不正引数・不完全入力・既存出力への暗黙上書きは処理開始前に拒否する |

## 機能要件

### 起動・レイアウト・ナビゲーション

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `APP-F-052` | 利用者はmacOS 14以降で単一main windowを起動できる | cold startでmain windowが1枚だけ表示され、二重起動要求は既存windowを前面へ出す | Approved | 非該当 |
| `APP-F-053` | 利用者はFigma基準の三領域を表示できる | 1470×836 CSS pxでsidebar 255.04px、header 81px、Chat 607.11px、Companion 607.84pxとなり、主要境界が各基準値の±2px以内になる | Approved | 非該当 |
| `APP-F-054` | 利用者はminimum window sizeでも主要操作を継続できる | windowは960×640 CSS px未満へ縮小できず、960×640でtab、timeline、composer、Send、停止操作が欠落しない | Approved | 非該当 |
| `APP-F-055` | 利用者はS-001〜S-004の目的へ同じwindow内で移動できる | sidebar、Chat/Commit/Context/Settings tab、settings gearから対象viewへ移動し、戻った時にworkspace選択とcomposer draftが保たれる | Approved | 非該当 |
| `APP-F-056` | 利用者はcustom titlebarから標準window操作を実行できる | close、minimize、zoomがmacOS標準結果になり、traffic-light周辺のdrag regionがbutton操作を奪わない | Approved | 非該当 |

### 言語・アクセシビリティ

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `APP-F-057` | アプリは初回言語を決定する | OS localeが`ja`で始まる場合は日本語、それ以外は英語で初回表示する | Approved | 非該当 |
| `APP-F-058` | 利用者は日本語と英語を即時切り替えられる | Settingsで言語を変更すると再起動なしでsidebar、tabs、errors、decision、settings、notificationsが切り替わり、再起動後も選択が戻る | Approved | 非該当 |
| `APP-F-059` | 利用者はkeyboardだけで主要フローを操作できる | workspace選択、tab移動、添付、context、effort、送信、判断回答、停止、mute、review、restoreへTab/Shift+Tab/矢印/Enter/Escapeで到達できる | Approved | 非該当 |
| `APP-F-060` | 利用者は現在focusを視認できる | 全interactive controlの`:focus-visible`が背景に対して3:1以上の2px outlineを表示し、focus順が視覚順と一致する | Approved | 非該当 |
| `APP-F-061` | 利用者は動きを抑制できる | OSまたはアプリのreduced motionが有効な時、idle/decorative motionと位置・scale transitionを停止し、状態変化は即時または80ms以下のcrossfadeになる | Approved | 非該当 |
| `APP-F-062` | 利用者は200% text zoomで操作できる | 960×640で200% text zoomを適用した実効480px幅でも主要label、History & Privacyの保存説明、履歴削除actionが横方向に切れず、tabとsection navigationはscroll/overflow、composer controlはwrapしてSendを残す | Approved | 非該当 |

### ライフサイクル・安全境界

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `APP-F-063` | 利用者は実行中turnがある状態でclose結果を選べる | close時に実行中turnがあれば「停止して終了」「終了しない」を表示し、終了しない場合はwindowとturnを維持する | Approved | 非該当 |
| `APP-F-064` | アプリは終了時にchild processとwriterを停止する | 「停止して終了」後5秒以内にCodex childとaudio playbackを停止し、SQLite transactionを完了またはrollbackしてprocessが残らない | Approved | 非該当 |
| `APP-F-065` | 利用者は異常終了後に安全な回復概要を確認できる | 再起動時に未完了turnを`Interrupted`として表示し、draft、最後のcheckpoint、未完了work unitを示し、turnを自動再送しない | Approved | 非該当 |
| `APP-F-066` | 利用者はofflineでもlocal evidenceを確認できる | networkまたはCodex接続がない時もworkspace、timeline、Commit、Context、Settingsを開け、送信だけを理由付きで無効にする | Approved | 非該当 |
| `APP-F-067` | WebViewは目的別native操作だけを要求できる | 任意command名、任意shell文字列、allowlist外absolute pathをIPCへ渡すtestが拒否され、OS処理が開始されない | Approved | 非該当 |
| `APP-F-068` | release版はlocal bundleだけからscriptを実行する | CSP violation testで外部`http:`, `https:`, inline未許可scriptが拒否され、許可されたapp assetと限定character assetだけがloadされる | Approved | 非該当 |
| `APP-F-069` | UI向けerrorは秘密情報を含まない | API key、auth token、home directoryを含むfixture errorを表示・log保存してもsecret値が`[REDACTED]`になり、raw値を検索できない | Approved | 非該当 |

### 診断・性能

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `APP-F-070` | 利用者は起動前提の診断結果を確認できる | SettingsにOS、app version、Codex/Git/DB/Live2Dの利用可否とerror codeを表示し、History badgeとDB診断は同じreadiness sourceから一致する値を示し、token、API key、完全なhome pathを表示しない | Approved | 非該当 |
| `APP-F-071` | アプリは基準端末で作業面を短時間に表示する | Apple Silicon・16GB RAM・release build・既存workspace 20件の条件で、process開始からskeletonを持つ操作可能なshell表示までのp95が3,000ms以下になる。workspace Git再検証はsetupをblockせず非同期で開始し、各processを期限内に終了する | Approved | 非該当 |
| `APP-F-072` | UIは通常操作へ短時間に反応する | tab、workspace、settings toggleの入力からvisual state更新までのp95が100ms以下になり、測定中のsampleを100回以上記録する | Approved | 非該当 |

### macOS release・差分品質

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `APP-F-073` | Release maintainerはFinder自動化なしでmacOS DMGを作れる | macOS 14以降で`pnpm release:macos`を実行するとTauriが`.app`だけをbundleし、明示DMG commandがその`.app`と`/Applications`へのsymlinkの2entryだけを持つread-only DMGを生成する。実行中にFinder、AppleScript、`osascript`を起動しない | Approved | 非該当 |
| `APP-F-074` | DMG生成は不完全な出力を公開しない | missing/invalid `.app`、不正なoutput・volume、明示`--overwrite`なしの既存出力、copy/create/convert/mount/verify失敗で非0になり、既存artifactを検証完了前に置換せず、partial image・mount・一時directoryを残さない。失敗出力にinput/output/tempのabsolute pathを含めない | Approved | 非該当 |
| `APP-F-075` | Contributorはbyte-exact third-party noticeを改変せず差分品質を検査できる | `pnpm check:diff`が既定の`origin/develop...HEAD`または明示baseからのcommitted差分と、staged、unstaged、untracked fileを検査する。`src-tauri/resources/characters/builtin-hiyori/NOTICE.txt`のみをwhitespace検査から除外する一方、そのpathがregular fileで固定SHA-256と一致することを毎回検証する。NOTICEの改変・削除・rename、または他pathのadd・rename・untracked whitespace errorは非0にし、consoleにabsolute path、差分行、secretを表示しない | Approved | 非該当 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| 表示 | 言語 | OS localeから決定 | 必須 | `ja` / `en`の2値 | 保存に失敗した場合は現在言語を維持し、再試行を表示する |
| 表示 | reduced motion | `system` | 必須 | `system` / `on` / `off` | 不正値は`system`へ戻し、診断へ記録する |
| macOS release | app path | Tauri release bundleの`Coding Wife.app` | 必須 | 存在する非symlinkの`.app` directory。`Contents/Info.plist`を持つ | 出力を作らず非0で終了する |
| macOS release | output path | `src-tauri/target/release/bundle/dmg/Coding-Wife.dmg` | 必須 | `.dmg`で終わる。symlinkとdirectoryは拒否する | 既存artifactを変更せず非0で終了する |
| macOS release | volume name | `Coding Wife` | 必須 | 1〜63 byteのASCII alphanumeric、space、`.`、`_`、`-` | 出力を作らず非0で終了する |
| macOS release | overwrite | `false` | 必須 | `--overwrite`の有無だけ。有効時も検証完了まで既存artifactを保持する | 明示されない場合は既存artifactを変更せず非0で終了する |

## デスクトップ固有要件

デスクトップ共通契約は[デスクトップ共通仕様](../screen-design/desktop-common-specification.md)を正本とし、本書の機能要件と相互参照する。

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | MVP対象はmacOS 14以降。Windows/Linuxは非対応表示とする | `APP-F-052` |
| ウィンドウ生成・再利用 | 単一main windowを再利用し、二重起動で増やさない | `APP-F-052`, `APP-F-056` |
| 閉じる・アプリ終了 | 実行中turnを停止するか終了を取り消す | `APP-F-063`, `APP-F-064` |
| 未保存データ | composer draftはworkspace単位で保存し、送信成功まで消去しない | `APP-F-055`, `APP-F-065` |
| ローカルデータ | Rust管理DBを正本とし、WebView storageを永続正本にしない | `APP-F-065` |
| オフライン | local evidenceを閲覧可能、online送信は無効 | `APP-F-066` |
| ファイル・OS操作 | feature別typed commandに限定 | `APP-F-067` |
| メニュー・ショートカット | macOS標準window shortcutを妨げず、送信はCommand+Enter | `APP-F-056`, `APP-F-059` |
| Deep Link・ファイル関連付け | 非該当: MVPで登録しない | 非該当 |
| 通知 | app内statusとtoastだけ。OS通知はMVP非対象 | `APP-F-055` |
| Capability・認可 | window、dialog、process、filesystemのscopeを目的別に最小化 | `APP-F-067`, `APP-F-068` |
| アップデート・互換性 | 自動updateは非該当。DB migrationはforward-onlyかつ失敗時rollback | `APP-F-065` |
| 配布物生成 | Tauriは`.app`だけをbundleし、repository scriptが`hdiutil`でread-only DMGを作成・mount検証・公開する | `APP-F-073`, `APP-F-074` |
| 差分品質 | byte-exact Hiyori NOTICEだけをwhitespace検査から除外し、他のrepository-owned textは除外しない | `APP-F-075` |

## 画面・UI

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-001` | セッションダッシュボード | `APP-F-052`〜`APP-F-062` | 変更 | [画面詳細仕様](../screen-design/S-001_session-dashboard.md) |
| `S-002` | コーディングワークスペース | `APP-F-053`〜`APP-F-069` | 変更 | [画面詳細仕様](../screen-design/S-002_coding-workspace.md) |
| `S-003` | セッション証拠 | `APP-F-055`, `APP-F-059`〜`APP-F-062` | 変更 | [画面詳細仕様](../screen-design/S-003_session-evidence.md) |
| `S-004` | 設定・診断 | `APP-F-055`, `APP-F-057`〜`APP-F-072` | 変更 | [画面詳細仕様](../screen-design/S-004_settings-diagnostics.md) |

`APP-F-073`〜`APP-F-075`はrelease/CI境界のcommand要件であり、アプリ画面への追加を伴わないため画面IDは非該当とする。

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | CSPはdefault deny、外部script/CDN禁止。IPC payloadをRust側でschema・scope検証する |
| 権限 | Tauri Capabilityはmain windowと目的別commandへ限定し、任意shell/fs APIを公開しない |
| プライバシー | telemetryはMVPで送信しない。診断exportを実装する場合も利用者の明示操作前に外部送信しない |
| 監査・ログ | app lifecycle、migration、redacted error codeを記録し、secretとraw reasoningを記録しない |
| 配布信頼性 | DMGはFinder/AppleEventに依存せず、read-only mount検証を通ったcandidateだけをfinal pathへ置く |
| 性能 | 起動p95 3,000ms、通常操作p95 100ms、最低window 960×640 |
| 信頼性・復旧 | 未完了turnを自動再送せず、DB transactionは終了時commitまたはrollbackする |
| アクセシビリティ | WCAG 2.2 AA、keyboard-only、visible focus、200% text zoom、reduced motionを満たす |
| 多言語・地域 | `ja` / `en`を同機能で提供し、保存時刻はUTC、表示時刻は選択localeを使う |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| Tauri v2 | React + TypeScript + Vite assetを単一WebViewへbundleする | 解決済み（採用決定） | 非該当 |
| macOS 14以降 | Build Week MVPの検証対象 | 解決済み（MVP範囲） | 他OSは対応済みと表示しない |
| macOS `hdiutil` / `ditto` | `.app`を保持したDMG作成とread-only mount検証 | 解決済み（macOS 14+標準tool） | 不在または失敗時はartifactを公開しない |
| PRODUCT / DESIGN | product registerとFigma tokenの正本 | 解決済み | 非該当 |
| 画面詳細仕様 | S-001〜S-004とdesktop commonを相互参照する | 解決済み（同時レビュー） | 実装は承認済み画面仕様に従う |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| Intel Mac artifact | MVPはApple Silicon release buildを審査artifactとし、Intelは未検証と明記する | release工程でuniversal build時間を計測する | いいえ |
| OS notification | MVPはapp内通知に限定する | demo後の利用試験でOS通知需要を評価する | いいえ |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [PRODUCT.md](../../PRODUCT.md) | product目的、人格、アクセシビリティ |
| [DESIGN.md](../../DESIGN.md) | Figma node 8:2のgrid、token、interaction rule |
| [Tauriアーキテクチャ調査](../research/08-tauri-architecture.md) | WebView/Rust境界とlifecycle |
| [セキュリティ・プライバシー調査](../research/09-security-privacy.md) | Capability、CSP、secret、recovery |
| [macOS release packaging調査](../research/macos-release-packaging.md) | Finder非依存DMG、read-only検証、Gatekeeperと未署名配布の境界 |
| [Testing instructions](../testing.md) | release command、synthetic smoke、install/launch検証の実行手順 |

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 2026-07-18 |
| 残る非ブロック論点 | Intel Mac artifact、OS notification。どちらもMVP動作をブロックしない |

## 着手可チェック

- [x] 背景と目的が説明できる。
- [x] スコープ内・外と理由が明確である。
- [x] 全機能要件に一意な要件IDがある。
- [x] 全機能要件に検証可能な受け入れ条件がある。
- [x] 正常系、異常系、キャンセル、権限差分、空状態、境界値を確認した。
- [x] デスクトップ固有要件を確認し、非該当も明記した。
- [x] 画面IDと要件IDの相互参照が一致し、承認済み画面詳細仕様を参照している。
- [x] 非機能要件と依存関係を確認した。
- [x] 着手ブロックが「はい」または「不明」の未確定事項がない。
- [x] 仕様責任者がレビューし、合意した。
