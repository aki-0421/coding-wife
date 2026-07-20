---
title: "APP デスクトップシェル要件定義"
description: "Coding Wifeの単一Tauriウィンドウ、言語、アクセシビリティ、ライフサイクル、信頼境界、macOS配布物を定義する。"
updated: 2026-07-20
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
| 最終レビュー日 | 2026-07-19 |

## 背景

Codex、Git、Live2D、履歴を一つのデスクトップ画面で安全に調停する共通基盤がない。WebViewへローカル権限を直接渡さず、作業中の状態を失わずに終了・再起動できるシェルが必要である。

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| 一つの作業面を提供する | macOSで単一main windowが起動し、現行S-001〜S-003、S-005へ移動できる |
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
| macOS release | Apple Silicon用`.app`、development demo分離、ad-hoc resource seal、Finder非依存DMG、artifact検証、固定依存ライセンス台帳、diff hygiene |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| Windows / Linux配布 | Build Week MVPは検証済みmacOS artifactへ集中する | 将来のplatform validation |
| 複数window | demoの単一作業面と状態一貫性を優先する | 将来検討 |
| 自動update | 署名・配布基盤を今回のMVPに含めない | 将来のrelease要件 |
| Developer ID署名・Apple公証 | ハッカソンMVPは全resourceをsealするad-hoc署名までを必須とするが、配布者identityを証明するDeveloper ID署名とApple公証は行わず、外部配布の信頼連鎖を別gateとする | [macOS release packaging調査](../research/macos-release-packaging.md) |
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
| `APP-F-052` | 利用者はmacOS 14以降で単一main windowを起動できる | cold startでmain windowが1枚だけ表示される。native windowは初期React shellとCSSのlayoutが確定するまで非表示とし、1文字ずつ折り返す狭幅frame、unstyled content、空のWebViewを利用者へ見せない。frontend moduleの読込に失敗した場合もraw errorを出さず、OS localeに応じたja/enの再起動案内をstyled shellで表示する。app-private single-instance lockを保持中の二重起動要求は新しいWebView、Codex/App Server、support runtime、audio controller、DB writerを作らず、既存windowをunminimizeしてfocus/raiseしてから新processを終了する。stale lockはowner/process identityを検証した場合だけ回収する | Approved | 非該当 |
| `APP-F-053` | 利用者はFigma基準の三領域を表示できる | 1470×836 CSS pxでsidebar 255.04px、header 81px、Chat 607.11px、Character 607.84pxとなり、主要境界が各基準値の±2px以内になる。起動画面の利用可能領域が標準geometryより小さい場合はwindow全体をwork area内へ収め、native resize edgeとtraffic lightsを画面外へ出さない | Approved | 非該当 |
| `APP-F-054` | 利用者はminimum window sizeでも主要操作を継続できる | windowは960×640 CSS px未満へ縮小できず、960×640でtab、timeline、composer、Send、停止操作が欠落しない | Approved | 非該当 |
| `APP-F-055` | 利用者は現行画面へ同じwindow内で移動できる | sidebar、Chat/Commit tab、app settings gearからS-001〜S-003、S-005へ移動し、戻った時にworkspace選択とcomposer draftが保たれる。workspace tabのallowlistは`chat` / `commit`だけとし、旧`context` / `settings`値、表示trigger、subview、keyboard順、route aliasを公開しない | Approved | 非該当 |
| `APP-F-056` | 利用者はmacOS native titlebarから標準window操作を実行できる | close、minimize、zoomがmacOS標準結果になる。WebViewは赤・黄・緑のtraffic-light代替要素を描画しない。main window上端40.5 CSS pxはReact component境界と無関係な一続きのnative titlebar hit bandとし、primary single mousedownでdrag、primary second mousedownでzoomを開始する。button、link、tab、input、select、textarea、contenteditable等のinteractive targetだけを除外し、native control用safe areaとdrag判定が操作を奪わない。`main` WebViewにはdrag開始と明示toggle maximizeに必要なTauri window permissionだけを許可し、任意のwindow操作権限は追加しない | Approved | 非該当 |
| `APP-F-085` | 利用者は前回終了時と同じmain windowの大きさで作業を再開できる | 有効な保存状態がない初回起動では、main windowをReact shell表示前にmacOS標準zoomでwork area内の最大へ広げ、fullscreenにはしない。通常windowのresize settle時とorderly close受付時にlogical width / heightとzoom状態をversion付きRust管理SQLiteへ保存し、次のcold startではwindowを表示する前に復元する。fullscreen中の寸法は最後の通常window状態を上書きしない。missing、破損、未知schema、960×640未満、非有限値、または現画面のwork areaを超える保存値はraw値を表示せず、minimum geometryとwork areaへ補正できるTauri window configを通した初回起動動作へfail closedする | Approved | 非該当 |
| `APP-F-084` | appはcharacter presentation設定を選択中characterとして全workspaceへ共通適用する | Character contextはopaque pack IDごとに独立version/hashを持つnative record、selected character packとsemantic mappingはowner-only character library stateを正本とし、workspace IDまたはProject IDでpartitionしない。個別設定でのCharacter context保存はそのpackだけを更新し、そのpackを選択した次の全workspaceのturnから適用する。pack選択とmapping保存は全workspaceのcharacterへ反映する。旧app-global Character contextはmigration時にbundled Hiyoriのrecordへ一度だけ移し、以後ほかのpackの値と混在させない | Approved | 非該当 |
| `APP-F-083` | 利用者はアプリ全体設定とworkspace設定を別画面で識別できる | sidebarのapp settings gearはS-005、workspaceのSettings tabはS-006を開く | Deprecated | workspace側に設定項目がなく独立画面を維持する理由がないためS-006と同時に廃止。後継IDなし |

### 言語・アクセシビリティ

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `APP-F-057` | アプリは初回言語を決定する | OS localeが`ja`で始まる場合は日本語、それ以外は英語で初回表示する | Approved | 非該当 |
| `APP-F-058` | 利用者は日本語と英語を即時切り替えられる | App settingsで言語を変更すると再起動なしでsidebar、tabs、errors、decision、settings、notificationsが切り替わり、再起動後も選択が戻る | Approved | 非該当 |
| `APP-F-059` | 利用者はkeyboardだけで主要フローを操作できる | workspace選択、Chat/Commit tab移動、添付、read-only context snapshot、effort、送信、判断回答、停止、mute、read-only commit review、workspace repair、App SettingsのProject detailとCharacter個別設定へTab/Shift+Tab/矢印/Enter/Escapeで到達できる。Commit画面にcommit/revert/undo/restore/checkout/resetの操作またはshortcutを置かない | Approved | 非該当 |
| `APP-F-060` | 利用者は現在focusを視認できる | 全interactive controlの`:focus-visible`が背景に対して3:1以上の2px outlineを表示し、focus順が視覚順と一致する | Approved | 非該当 |
| `APP-F-061` | アプリはOSの動作抑制設定を尊重する | OSの`prefers-reduced-motion`が有効な時、idle/decorative motionと位置・scale transitionを停止し、状態変化は即時または80ms以下のcrossfadeになる。アプリ独自のreduced motion設定は提供しない | Approved | 非該当 |
| `APP-F-062` | 利用者は200% text zoomで操作できる | 960×640で200% text zoomを適用した実効480px幅でも主要labelが横方向に切れず、workspace tabとApp Settings section navigationはscroll/overflow、composer controlはwrapしてSendを残す | Approved | 非該当 |

### ライフサイクル・安全境界

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `APP-F-063` | 利用者はclose結果を安全に選べる | active/pending turnがないcloseは通常終了する。active/pending turnがあるcloseはnative closeを保留して「停止して終了」と「終了しない」だけを表示する。「終了しない」はdialogを閉じて元controlへfocusを戻し、window、turn、selection、draft、caption/TTSを維持する。duplicate close、Escape、window manager経由でも確認を迂回しない | Approved | 非該当 |
| `APP-F-064` | アプリは終了時にchild processとwriterを停止する | idle closeまたは「停止して終了」受理後、Codex/App Server process group、audio process/queue、app-owned support controller/process group、pending scope writer、DB writer/transactionを順序付きで閉じ、全descendant消滅、writer task join、transaction commitまたはrollback、unfinished turnの`Interrupted`化、WAL checkpointがすべて完了した場合だけmain processを終了する。graceful cleanup全体の期限は5秒とし、期限超過または失敗時は各process groupを強制終了する。force後も一つ以上の必須cleanupを確認できない場合はexit-readyにせず、native stateを`CleanupFailed`へ遷移してmain windowを表示・focusし、absolute pathやservice内部情報を含まない日本語・英語のerrorと「安全な終了処理を再試行」を表示する。duplicate closeは新しいshutdownを開始せず、retryは同じrequestに対して未完了cleanupだけをboundedに再実行し、全項目の完了後だけ終了する。historyはshutdown admissionを閉じて新しいwriterを拒否し、既存writerへcancelを通知してjoinした後、blocking DB収束をasync taskから期限管理する。Git stateとsupport explanation本文は永続化しない | Approved | 非該当 |
| `APP-F-065` | 利用者は異常終了後に安全な回復概要を確認できる | 再起動時にterminal eventのないturnを`Interrupted`として表示し、workspace固有のdraft、last summary、timeline anchor、未完了work unitを示す。Codex turn、support presentation、TTS、Git commandを自動再送・再開せず、persisted commit evidenceとapp-owned sanitized metadataだけを再構築する | Approved | 非該当 |
| `APP-F-066` | 利用者はofflineでもlocal evidenceを確認できる | networkまたはCodex接続がない時もworkspace、timeline、Commit、App SettingsのProject detailとCharacter個別設定を開け、送信だけを理由付きで無効にする | Approved | 非該当 |
| `APP-F-067` | WebViewは目的別native操作だけを要求できる | 任意command名、任意shell文字列、allowlist外absolute pathをIPCへ渡すtestが拒否され、OS処理が開始されない | Approved | 非該当 |
| `APP-F-068` | release版はlocal bundleだけからscriptを実行する | CSP violation testで外部`http:`, `https:`, inline未許可scriptが拒否され、許可されたapp assetと限定character assetだけがloadされる | Approved | 非該当 |
| `APP-F-069` | UI向けerrorは秘密情報を含まない | API key、auth token、home directoryを含むfixture errorを表示・log保存してもsecret値が`[REDACTED]`になり、raw値を検索できない | Approved | 非該当 |

### 診断・性能

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `APP-F-070` | 利用者は実際のnative readinessを診断できる | App settingsのDiagnosticsにOS、app/build/schema version、Codex binary/auth/model/protocol schema、Git、DB、Live2Dのnative checkを`ready` / `warning` / `blocked` / `unavailable`、UTC `checkedAt`、sanitized error code、localized recovery actionとして表示する。Recheckは同じnative readiness serviceを再評価し、History badgeとDB診断は同じsnapshot IDの値を使う。demo/fixture値をnative readyとして表示せず、absolute/private path、token、credential、raw stderrを表示・copy・logしない | Approved | 非該当 |
| `APP-F-071` | アプリは基準端末で作業面を短時間に表示する | Apple Silicon・16GB RAM・release build・既存workspace 20件の条件で、process開始からskeletonを持つ操作可能なshell表示までのp95が3,000ms以下になる。workspace Git再検証はsetupをblockせず非同期で開始し、各processを期限内に終了する | Approved | 非該当 |
| `APP-F-072` | UIは通常操作へ短時間に反応する | tab、workspace、settings toggleの入力からvisual state更新までのp95が100ms以下になり、測定中のsampleを100回以上記録する | Approved | 非該当 |

### macOS release・差分品質

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `APP-F-073` | Release maintainerはFinder自動化なしでmacOS DMGを作れる | macOS 14以降で`pnpm release:macos`を実行するとTauriが`.app`だけをbundleし、明示DMG commandがその`.app`と`/Applications`へのsymlinkの2entryだけを持つread-only DMGを生成する。実行中にFinder、AppleScript、`osascript`を起動しない | Approved | 非該当 |
| `APP-F-074` | DMG生成は不完全な出力を公開しない | missing/invalid `.app`、不正なoutput・volume、明示`--overwrite`なしの既存出力、copy/create/convert/mount/verify失敗で非0になり、既存artifactを検証完了前に置換せず、partial image・mount・一時directoryを残さない。失敗出力にinput/output/tempのabsolute pathを含めない | Approved | 非該当 |
| `APP-F-075` | Contributorはbyte-exact third-party noticeを改変せず差分品質を検査できる | `pnpm check:diff`が既定の`origin/develop...HEAD`または明示baseからのcommitted差分と、staged、unstaged、untracked fileを検査する。`src-tauri/resources/characters/builtin-hiyori/NOTICE.txt`のみをwhitespace検査から除外する一方、worktreeでそのpathがregular file・固定SHA-256であることを毎回検証する。HEADまたは選択したbaseにNOTICEがある場合はindexにexact pathのstage 0 entryが1件あることを必須とし、mode `100644`・regular blob・固定SHA-256を検証する。tracked baselineにNOTICEがない場合のcanonical untracked addは許可するが、index entryがあれば同じmode・blob検証を適用する。NOTICEの改変・削除・rename・mode変更・symlink置換、または他pathのadd・rename・untracked whitespace errorは非0にし、consoleにabsolute path、差分行、secretを表示しない | Approved | 非該当 |
| `APP-F-076` | app preferenceはversioned native storeを正本にする | `AppPreferencesV2`は`locale=ja|en`だけをowner-only app-private native storeへatomic保存し、App settingsとruntimeは同じsnapshot/versionだけを使う。再起動後にexact復元し、localeは保存成功後ただちに全app-owned copyへ反映する。`AppPreferencesV1`はlocaleだけをV2へ一度移行し、旧reduced motionとcharacter visibilityは破棄する。Reset Preferences commandとReset UI state操作は公開しない。missing/corrupt/unknown-version recordはraw値をUIへ出さずsafe defaultとsanitized diagnosticへfail closedする | Approved | 非該当 |
| `APP-F-077` | final candidateはclean HEADから必要resourceだけを含む | clean final HEADから生成した`.app`にbundled Hiyori runtime 17fileとNOTICE、main commit skill、commit explanation skill、app-owned support runtime、schema/migrationを含め、development fixture、source map、quarantine、absolute private path、credential、user dataを含めない。同じ検証済み`.app`だけを入力にFinder非依存DMGを作り、別々の2回のread-only mountでroot 2entry、`/Applications` link、正規化app inventoryがsource `.app`と一致することを確認する。DMG filesystem metadataによるbyte同一性は要求せず、公開する最終DMGだけのsizeとSHA-256を凍結して記録する。build前後のfree diskとcleanup結果を記録し、stale mountと中間artifactを残さない | Approved | 非該当 |
| `APP-F-078` | installed artifactでprimary pathとlifecycleを再現できる | final DMGを実mountし、Applications相当へcopyした`.app`をbuild directory外からmacOS 14以降のfresh profile、別Mac、または同等の隔離環境でlaunchする。Hiyori、project picker、Codex preflight、main turn、trusted read-only commit evidence、「詳しく教えて」のcaptionとoptional TTS、Context restart、single-instance、running close、5秒以内cleanup、Interrupted recoveryを完走する。署名・notarization済みでない場合は英語testing guideにunsigned/unnotarized状態、Gatekeeper手順、security trade-offを明記してその手順も検証する | Approved | 非該当 |
| `APP-F-079` | release artifactは横断受け入れ条件を満たす | installed `.app`のja/enで主要happy pathとmajor error/recovery pathを完走し、locale即時切替とrestart復元、keyboard-only、dialog focus containment/return、visible focus、role/name/state、caption live region、200% text zoom、reduced motionを検証する。offline、Codex unavailable、TTS unavailable、repository health error、DB recovery、invalid Live2D packでlocal historyとrecoveryを維持し、secret、token、absolute private path、raw stderr、support本文をUI/log/evidenceへ出さない。1470×836、960×640、実効幅480で到達不能control・clipping・caption overflowを0件にし、起動/操作/Live2D/履歴/cleanupの各既定p95と長時間listener/process/cache非増殖をrelease buildで測定する | Approved | 非該当 |
| `APP-F-080` | production frontend bundleはdevelopment demo runtimeを含まない | Vite development serverで明示した`?demoAppServer=1`だけがdevelopment demo runtimeとfixtureを遅延取得できる。queryなしのdevelopment画面とTauri production画面はnative adapterを維持する。production `dist`と`.app`のregular file contentをscanし、`demoAppServer`、`Demo commit evidence is missing`、`Demo diff evidence is missing`、`workspace-demo-selected-project`、`demo-decision-turn-1`、`file-demo-image`、`demo-auto-`の一致を各0件にする | Approved | 非該当 |
| `APP-F-081` | Release maintainerは一つの正本commandでappとDMGを検証できる | `pnpm release:macos`は同じhost-global lockとUUID run IDの下でapp、DMG、両sidecar manifestをmode `0700`のprivate candidateへbuildし、`scripts/release/verify-macos-release.sh`相当のcanonical verificationが全candidateへ成功した後だけ4成果物を一つのpublish transactionで置換する。既存4pathの内容と不在状態を同一filesystemのprivate backup/journalへ退避し、publish途中または全path移動後のfailure・HUP・INT・TERMではexact旧pairへrollbackし、新規buildなら4pathを0件へ戻す。process crashでstale backup/journalが残った場合、次のlock ownerは新規build前に一意で整合したjournalだけを有限処理で復旧し、曖昧・不正な状態をsafe codeで拒否する。app、DMG、manifestのmixed run IDを受理しない。nested codeを先に、最後に`.app`全体をtimestampなしのad-hoc署名でsealし、`codesign --verify --deep --strict`成功、TeamIdentifierなし、Developer ID署名なし、Apple公証なしを区別して報告する。sorted inventoryはrelative path、file type、permission mode、symlink target、regular file size、SHA-256を含み、app inventory digest、arm64、minimum macOS 14.0、bundle ID/version、Hiyori runtime 17file、legal notice、2 bundled skills、schema/migration、source map/demo/private path/quarantine/credential不在を検証する。entry path、link target、file bytesの先頭またはPOSIX path component境界にあるUNC pathも拒否する。DMGは別々の2回のread-only mountで同じapp inventoryを再現し、final DMGのsizeとSHA-256を出力する。成功・失敗・signal後にmount、child process、lock、private workを0件へ収束する | Approved | 非該当 |
| `APP-F-082` | Release maintainerは配布対象の第三者依存とライセンス帰属を再現できる | `pnpm-lock.yaml`のproduction closureと、`LC_ALL=C`・color無効で実行する`cargo tree --locked --offline --target aarch64-apple-darwin --edges normal`の実効graphを、networkを使わずlockfile・installed package metadata・Cargo registry source metadataと照合する。Cargo treeの各name/version表示は`cargo metadata`のexact package IDへ一意に解決し、rootとworkspace memberはexact IDで除外する。同じname/versionの候補が複数ある曖昧表示、未知の表示、root欠落は誤mergeせず非0にする。license expressionはlegacyの`/`を`OR`へ正規化した上でSPDX ID、`AND`、`OR`、balanced parentheses、単一`WITH` exception、`LicenseRef`だけをstrict grammarで受理し、未知・禁止IDとmalformed expressionをfail closedにする。すべての依存にecosystem、name、固定version、source、integrity/checksum、license expression、attributionを持つsorted JSON inventoryと可読NOTICEを決定論的に生成し、lockまたはmetadataが生成物と一致しない場合とlicense/source/integrityのunknown・forbidden・missingを非0にする。`.app`は生成済みJSONとNOTICE、既存Live2D/Hiyoriの原文notice・termsをすべてresourcesに含む | Approved | 非該当 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| 表示 | 言語 | OS localeから決定 | 必須 | `ja` / `en`の2値 | 保存に失敗した場合は現在言語を維持し、再試行を表示する |
| macOS release | app path | Tauri release bundleの`Coding Wife.app` | 必須 | 存在する非symlinkの`.app` directory。`Contents/Info.plist`を持つ | 出力を作らず非0で終了する |
| macOS release | output path | `src-tauri/target/release/bundle/dmg/Coding-Wife.dmg` | 必須 | `.dmg`で終わる。symlinkとdirectoryは拒否する | 既存artifactを変更せず非0で終了する |
| macOS release | volume name | `Coding Wife` | 必須 | 1〜63 byteのASCII alphanumeric、space、`.`、`_`、`-` | 出力を作らず非0で終了する |
| macOS release | overwrite | `false` | 必須 | `--overwrite`の有無だけ。有効時も検証完了まで既存artifactを保持する | 明示されない場合は既存artifactを変更せず非0で終了する |

## デスクトップ固有要件

デスクトップ共通契約は[デスクトップ共通仕様](../screen-design/desktop-common-specification.md)を正本とし、本書の機能要件と相互参照する。

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | MVP対象はmacOS 14以降。Windows/Linuxは非対応表示とする | `APP-F-052` |
| ウィンドウ生成・再利用 | 単一main windowを再利用し、二重起動で増やさない。初回はfullscreenにせず標準zoomし、以後は最後の安全な通常windowサイズとzoom状態を復元する | `APP-F-052`, `APP-F-056`, `APP-F-085` |
| 閉じる・アプリ終了 | idleは通常終了し、実行中turnは停止して終了するか終了を取り消す。Codex/audio/support/DBをbounded cleanupする | `APP-F-063`〜`APP-F-065` |
| 未保存データ | composer draftはworkspace単位で保存し、送信成功まで消去しない | `APP-F-055`, `APP-F-065` |
| ローカルデータ | Rust管理DBをwindow状態と履歴の正本とし、WebView storageを永続正本にしない | `APP-F-065`, `APP-F-085` |
| オフライン | local evidenceを閲覧可能、online送信は無効 | `APP-F-066` |
| ファイル・OS操作 | feature別typed commandに限定 | `APP-F-067` |
| メニュー・ショートカット | macOS標準window shortcutを妨げず、送信はCommand+Enter | `APP-F-056`, `APP-F-059` |
| Deep Link・ファイル関連付け | 非該当: MVPで登録しない | 非該当 |
| 通知 | app内statusとtoastだけ。OS通知はMVP非対象 | `APP-F-055` |
| Capability・認可 | window、dialog、process、filesystemのscopeを目的別に最小化 | `APP-F-067`, `APP-F-068` |
| アップデート・互換性 | 自動updateは非該当。DB migrationはforward-onlyかつ失敗時rollback | `APP-F-065` |
| 配布物生成 | Tauriは`.app`だけをbundleし、repository scriptがdevelopment demo不在と固定依存NOTICEの一致を検証してnested codeからapp順にad-hoc sealし、`hdiutil`でread-only DMGを作成・mount検証・公開する | `APP-F-073`, `APP-F-074`, `APP-F-080`〜`APP-F-082` |
| 差分品質 | byte-exact Hiyori NOTICEだけをwhitespace検査から除外し、他のrepository-owned textは除外しない | `APP-F-075` |
| 設定・診断 | app preferenceとreadinessはversioned native sourceを正本にし、WebView/demo値を永続・readyとして扱わない | `APP-F-070`, `APP-F-076` |
| 配布物受け入れ | clean final HEADのsealed resource inventory、固定依存NOTICE、実DMG mount/copy/launch、fresh-profile相当、ja/en/a11y/privacy/offline/performanceをinstalled artifactで検証する | `APP-F-077`〜`APP-F-082` |

## 画面・UI

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-001` | セッションダッシュボード | `APP-F-052`〜`APP-F-062` | 変更 | [画面詳細仕様](../screen-design/S-001_session-dashboard.md) |
| `S-002` | コーディングワークスペース | `APP-F-053`〜`APP-F-069` | 変更 | [画面詳細仕様](../screen-design/S-002_coding-workspace.md) |
| `S-003` | セッション証拠 | `APP-F-055`, `APP-F-059`〜`APP-F-062` | 変更 | [画面詳細仕様](../screen-design/S-003_session-evidence.md) |
| `S-004` | 設定・診断（廃止） | 非該当 | 廃止 | [画面詳細仕様](../screen-design/S-004_settings-diagnostics.md) |
| `S-005` | アプリ設定・診断 | `APP-F-055`, `APP-F-057`〜`APP-F-072`, `APP-F-076` | 追加 | [画面詳細仕様](../screen-design/S-005_app-settings-diagnostics.md) |
| `S-006` | ワークスペース設定（廃止） | `APP-F-083` | 廃止 | [画面詳細仕様](../screen-design/S-006_project-settings.md) |

`APP-F-073`〜`APP-F-075`と`APP-F-077`〜`APP-F-082`はrelease/CI/installed artifact境界の要件であり、アプリ画面への追加を伴わないため画面IDは非該当とする。

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | CSPはdefault deny、外部script/CDN禁止。IPC payloadをRust側でschema・scope検証する |
| 権限 | Tauri Capabilityはmain windowと目的別commandへ限定し、任意shell/fs APIを公開しない |
| プライバシー | telemetryはMVPで送信しない。診断exportを実装する場合も利用者の明示操作前に外部送信しない |
| 監査・ログ | app lifecycle、migration、redacted error codeを記録し、secretとraw reasoningを記録しない |
| 配布信頼性 | appは全resourceをad-hoc sealしてstrict検証し、DMGはFinder/AppleEventに依存せず、2回のread-only mountで正規化inventoryが一致したcandidateだけをfinal pathへ置く。DMG byte同一性は要求せず、final artifactのsizeとSHA-256を凍結する |
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
| 画面詳細仕様 | 現行S-001〜S-003、S-005とdesktop commonを相互参照する | 解決済み（同時レビュー） | 実装は承認済み画面仕様に従う |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| Intel Mac artifact | MVPはApple Silicon release buildを審査artifactとし、Intelは未検証と明記する | release工程でuniversal build時間を計測する | いいえ |
| OS notification | MVPはapp内通知に限定する | demo後の利用試験でOS通知需要を評価する | いいえ |
| Repository-level project license | 選択を行わず、所有者の法的判断までroot `LICENSE`を作成しない | 所有者が権利関係と公開条件を確認し、ライセンスを明示選択する | いいえ（依存NOTICE実装は進めるが、public submissionとredistributionはblock） |

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
