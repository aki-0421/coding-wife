---
title: "デスクトップ共通仕様"
description: "Coding Wifeの単一macOSウィンドウ、共通レイアウト、状態、操作、信頼境界、復旧、アクセシビリティを定義する。"
updated: 2026-07-18
read_when:
  - "S-001〜S-004の共通window、navigation、state、keyboard、native boundaryを実装するとき。"
  - "個別画面仕様とdesktop-shell要件の整合を確認するとき。"
status: "Approved"
---

# デスクトップ共通仕様

## 目的と正本

本書は、単一のTauri `main` windowでS-001〜S-004を表示する時の共通契約を定義する。個別画面は本書との差分だけを各画面詳細仕様へ記載する。

優先順位は次の通りとする。

1. [PRODUCT.md](../../PRODUCT.md)と[DESIGN.md](../../DESIGN.md)。
2. `docs/requirements/`の8要件定義書。
3. Figma Desktop node `8:2`と[demo.png](../thinking/demo.png)。
4. 本書とS-001〜S-004。

Figmaの1470×836 CSS pxを標準表示とし、bitmapの2940×1672 pxは2倍scaleの比較画像として扱う。Figmaの低contrast文字と8.25〜9px文字は採用せず、DESIGN.mdの`text-muted-accessible`と11px captionを実装値とする。

## 対象範囲

### 含める

| 対象 | 共通契約 |
|---|---|
| Platform | macOS 14以降、Apple Silicon、単一利用者、単一`main` window |
| Frontend | React + TypeScript + ViteをTauri v2 WebViewへbundleする |
| Navigation | persistent workspace sidebar、二段header、Chat/Commit/Context/Settings、settings gear |
| State | loading、empty、processing、offline、error、permission、cancel、restart recovery |
| Trust boundary | WebViewは表示と入力、Rustはprocess、Git、DB、filesystem、asset、secretの認可 |
| Inclusion | ja/en、keyboard-only、WCAG 2.2 AA、200% text zoom、reduced motion |

### 含めない

| 非対象 | 理由 |
|---|---|
| Windows / Linux runtime | Build Week MVPではmacOS artifactだけを検証する |
| 複数window、tray、常に手前 | 単一作業面と状態一貫性を守る |
| light theme | Figma node `8:2`のdark restrained systemを正本とする |
| embedded terminal | 任意shellをWebViewへ公開しない |
| remote push、merge、自動update | local reviewと復旧のMVP境界を越える |

## 画面・route台帳

| 画面ID | 画面 | route / view key | 主な入口 |
|---|---|---|---|
| [S-001](S-001_session-dashboard.md) | セッションダッシュボード | `/sessions` / `session-dashboard` | cold start、FolderPlus、Plus、missing project |
| [S-002](S-002_coding-workspace.md) | コーディングワークスペース | `/workspace/:workspaceId/chat` / `coding-workspace` | workspace選択、Chat tab |
| [S-003](S-003_session-evidence.md) | セッション証拠 | `/workspace/:workspaceId/evidence` / `session-evidence` | Commit tab、checkpoint通知 |
| [S-004](S-004_settings-diagnostics.md) | 設定・診断 | `/settings/:section?` / `settings-diagnostics` | Settings tab、sidebar gear、診断link |

Context tabはS-002内の`/workspace/:workspaceId/context` subviewであり、新しい画面IDを発行しない。確認dialog、OS picker、decision overlay、popoverも独立した画面IDを持たない。

## 技術境界

| 境界 | 許可する責務 | 禁止する責務 |
|---|---|---|
| React WebView | rendering、input、focus、route、transient UI state、typed IPC request | shell実行、Git argument組立、absolute private pathの保持、secret永続化 |
| Vite | release asset生成 | runtime server、認可境界 |
| Tauri plugin | window、dialog、clipboardの目的別native operation | unrestricted filesystem、unscoped URL open |
| Rust core | IPC schema、scope、process、Git、SQLite、character library、audio、redaction | 未検証WebView payloadの実行、raw secretの表示返却 |
| Codex App Server | active workspaceのmain turnとallowlist capability | UI state正本、support raw history永続化 |
| External TTS |明示enable時のredacted transcript変換 | source、path、secret、raw event payloadの受信 |

実際のCapabilityは`src-tauri/capabilities/`、CSPはTauri configを正本とする。画面IDやrouteを認可根拠にせず、command種別、workspace ID、canonical root、object ID、payload schemaをRustで再検証する。

## windowとtitlebar

| 項目 | 契約 |
|---|---|
| window label | `main` |
| 生成数 | process内に1枚。二重起動は既存windowを前面化する |
| default geometry | 1470×836 CSS px |
| minimum geometry | 960×640 CSS px。これ未満へのresizeをOSへ許可しない |
| maximum / fullscreen | macOS標準zoomとfullscreenを許可し、終了時geometryを保存する |
| titlebar | custom overlay。traffic lightsは12×12、左15px、上14.25px、間隔9px |
| drag region | traffic lights、button、tab、input、scrollbarを除くbreadcrumb rowだけ |
| radius | window 7.5px、compact control 4.5px、composer/decision 9px |
| close | idle時はorderly shutdown。running turnまたはGit mutation中は停止して終了/終了しないを選ぶ |

close、minimize、zoomのhit testingはmacOS標準結果と一致させる。close確認で「終了しない」を選ぶとwindow、turn、draft、focusを維持する。「停止して終了」ではCodex、support、TTSを停止し、DB transactionをcommitまたはrollbackして5秒以内にprocessを終了する。

## レイアウト契約

### 実装拘束値

| token / region | 値 | 適用 |
|---|---:|---|
| standard sidebar | 255.04px | 1470px基準の左rail |
| header | 81px | breadcrumb 40.5px + tabs 40.5px |
| standard Chat | 607.11px | S-002標準 |
| standard Companion | 607.84px | S-002標準 |
| sidebar footer | 40.5px | gear固定領域 |
| workspace row | 242.25×49.5px | sidebar 255.04px時 |
| content inset | 18px | timeline/composer左右 |
| composer | 571.11×128.25px | S-002標準、bottom 15px |
| focus outline | 2px + 2px offset | `warm-active`、背景比3:1以上 |
| visual/hit target | visual 12〜27px / hit 24×24px以上 | icon-only control |

標準geometryで主要boundaryはFigma node `8:2`の±2 CSS px以内とする。0.75pxのFigma strokeは実装で1px dividerへ丸め、DPRぼけを避ける。

### 可変値とbreakpoint

| effective width | shell | S-002 body | tab / control |
|---:|---|---|---|
| 1470px以上 | sidebar 255.04px固定。超過幅はmainへ与える | ChatとCompanionを1:1で拡張 | tab row固定、長値ellipsis |
| 1280〜1469px | sidebar 255.04px固定 | 残幅をChat/Companionで1:1。Chat 500px未満ならCompanionを先に縮める | composerはChat内で左右18px |
| 960〜1279px | 64px icon rail。workspace listはbuttonからportal drawer | Chatを最低520px、Companionへ残幅。decision/review時はCompanionをcompact化 | tabsはhorizontal scroll、footer controlsはwrap |
| 200% text zoom | 64px rail + drawerを使用 | Companionをhide可能、Chat/decisionを優先 | labelを縮小せずwrap/overflow menu |

S-003はevidence、S-004はsetting formを優先してbodyを再構成できる。S-002の標準表示だけはChatとCompanionの間へdividerまたは別cardを置かない。

## surface、文字、motion

- color、type、spacing、radius、shadowの正本はDESIGN.mdとする。
- normal text、placeholder、inactive tab、helperには`text-muted-accessible`以上を使う。`text-disabled`はdisabled controlだけに使う。
- UI sansはInter / Noto Sans JP / system-ui、code monoはJetBrains Mono / ui-monospaceだけとする。
- spacingは3、6、9、12、15、18、21pxの系列を使う。
- shadowはwindow、composer、portal overlayだけに使う。通常message、tool row、workspace row、Live2D paneへshadowを付けない。
- state transitionは150〜250ms ease-out。reduced motion時は位置・scale transitionを削除し、即時切替または80ms以下のcrossfadeにする。

### shadcn primitive対応

| UI契約 | 使用するshadcn primitive | custom実装 |
|---|---|---|
| main tabs | `Tabs` | 二段header、81px寸法、active underline、route同期 |
| action | `Button` | compact density、warm active、icon hit area、loading policy |
| composer / Other | `Textarea` | auto-grow、Send/decision validation、draft persistence |
| timeline / list / setting | `ScrollArea` | scroll owner、virtualization、anchor復元、new-event threshold |
| Context / effort / filter | `Popover` | body-level portal、viewport collision、trigger focus復帰 |
| confirmation / destructive action | `Dialog` | typed native operation、fingerprint、cancel invariants |
| decision option | `RadioGroup` | reason、impact、reversibility、Other/Hold/Interrupt/Approve |
| icon help | `Tooltip` | accessible nameを置換せず補足だけを表示 |
| loading | `Skeleton` | 各領域の最終形に合わせ、全画面spinnerを避ける |

shadcnはinteractionとkeyboard behaviorだけに使う。shell、sidebar、event row、evidence/diff、Live2D canvasはcustom componentとし、shadcn既定のlayout、色、大きなradius、shadow、typographyを持ち込まない。

## scroll ownership

| 領域 | scroll owner | 固定要素 | 復元key |
|---|---|---|---|
| workspace sidebar | status-group list | traffic lights、heading actions、gear footer | workspace collection + filter |
| S-002 | event timeline | header、composer、Companion mute | workspace ID + Chat tab |
| S-003 | checkpoint/event listとdetailを別scroll | header、summary/filter | workspace ID + selected evidence |
| S-004 | settings main panel | header、section navigation | selected settings section |
| portal | popover/dialog自身 | trigger位置 | open中だけ。route変更で閉じる |

wheel/trackpad eventを親へ二重伝播させない。timelineがbottomから48px超離れた状態でeventを受けてもscrollを動かさず、「最新へ」を表示する。

## focusとkeyboard

### 共通focus順

1. traffic lights以外のheader navigation。
2. sidebar heading actions、workspace groups/items、gear。
3. active viewのheading、filter、primary content。
4. composerまたは画面固有action。
5. Companionのmute/hide、visible caption。

route遷移後は画面h1または最初の回復操作へfocusを置く。workspace切替後は直前の領域を保ち、消失した要素へfocusがあった場合だけactive view headingへ移す。popover/dialogを閉じるとtriggerへ戻す。blocking decisionはdialog focus trapを使わず、decision headingから操作までをDOM上で連続させ、背景のSendをdisabledにする。

### shortcut

| 操作 | shortcut | 条件 | 結果 |
|---|---|---|---|
| turn送信 | `Command+Enter` | valid composer、online、decisionなし | 1 turnだけ開始。Enterは改行 |
| tab移動 | `Control+Tab` / `Control+Shift+Tab` | main window active | Chat/Commit/Context/Settingsを循環 |
| workspace filter | `Command+K` | destructive dialogなし | sidebarを開きfilterへfocus |
| non-destructive overlay close | `Escape` | popover/drawer/preview表示中 | 入力を保持しtriggerへfocus |
| decision answer | `Command+Enter` | optionと条件付きOtherがvalid | answerを1回送信 |
| stop / restore | shortcutなし | buttonの条件を満たす | 誤操作を避けるため明示buttonだけ |
| Quit | `Command+Q` | 常時 | close契約と同じ停止判断 |

macOS予約shortcutを上書きしない。icon-only操作にはaccessible nameとtooltipを付ける。

## 共通表示状態

| 状態 | 共通表示 | 許可する操作 | 終了条件 |
|---|---|---|---|
| 初期化中 | shell、選択済みlocale、各領域の形に合うskeleton | Quit、必要なcancel | DB、workspace、component診断がterminalになる |
| 通常 | active route、current workspace、同期済みlocal state | 画面固有操作 | processing、offline、errorへ遷移 |
| データなし | 一文の理由と一つの次操作。空table/card gridは出さない | add、diagnostic、戻る | 対象data作成または選択 |
| 処理中 | 対象row/sectionのprogress、重複操作disabled | cancel可能操作、影響外navigation | success、cancel、error |
| オフライン | persistent banner、local evidence、送信不可理由 | local閲覧、filter、Context、Settings | 接続回復後の明示Reconnect/preflight |
| エラー | code、原因、影響、保持data、retry/modify/stop/details | 影響外操作と明示回復 | retry成功または別routeへ移動 |
| 権限不足 | 拒否したoperation、必要なOS権限、再選択/再診断 | read-only閲覧、Settings、Quit | 権限変更後の明示再試行 |
| キャンセル後 | errorを表示せず開始前の入力、選択、fingerprintを維持 | 元操作または別操作 | 次の明示操作 |
| 再起動復旧 | Interrupted turn、draft、last checkpoint、未完了work unit | review、new turn、diagnostic | 利用者が次操作を選択 |

loading中に最終dataがある場合は前回dataを薄く残し、全画面spinnerへ置換しない。errorを成功toastへ変換せず、blocking errorは該当領域に残す。

## lifecycle、persistence、recovery

| data | 正本 | 保存契機 | restart | 破棄 |
|---|---|---|---|---|
| window geometry / locale / reduced motion | Rust管理SQLite | valid変更時 | bounds補正後に復元 | Reset settings |
| project/workspace/context/draft/selection | Rust管理SQLite | field commit、route/workspace切替 | active workspaceと一緒に復元 | project登録解除または履歴削除の契約 |
| normalized event / review pack | append-only SQLite + hash artifact | redaction/schema合格後 | sequence順に再構築 | workspace history明示削除 |
| Git object / source | repository | Rust Git transaction成功時 | Gitを正本として再診断 | appから自動削除しない |
| custom character pack | app-private character library | quarantine検証とatomic昇格 | pack IDから復元 | 未使用packの明示削除 |
| TTS key | OS secret store |明示保存 | set/unsetだけ表示 |明示削除 |
| audio byte / support raw history / raw reasoning | 保存しない | 非該当 | 復元しない | playback/task終了時 |

Web Storageを永続正本にしない。schema migrationはbackup付きtransactionで行い、失敗時は元DBを上書きせずread-only recoveryを表示する。startedでterminal eventがないturnはInterruptedとし、自動再送、自動commit、自動restoreを行わない。

## CSP、Capability、privacy

- CSPはdefault deny。release版はbundle assetと限定character asset protocolだけを読み、外部script、CDN、許可していないinline scriptを拒否する。
- WebViewから任意shell文字列、任意Git引数、allowlist外absolute path、process handle、secretを受け取らない。
- file picker結果はRustでcanonicalizeし、選択目的のrootとfile typeを再検証する。
- UI payload、log、diagnosticのAPI key、token、cookie、home directoryは永続化前に`[REDACTED]`へ置換する。
- telemetryとOS notificationはMVPで送信しない。TTSだけが明示enable後にallowlist endpointへredacted transcriptを送る。
- error envelopeは`code`、`operation`、`recoverable`、`user_message_key`、`detail_ref`だけをWebViewへ返し、raw stderr/path/secretを含めない。

## accessibilityと多言語

- WCAG 2.2 AA。通常文字4.5:1、large textとnon-text UI 3:1以上。
- すべてのinteractive elementへvisible `:focus-visible`、accessible name、keyboard activationを付ける。
- statusはtext、icon、fill/outline/dashのうち最低三つを併用する。
- Live2D canvasは`aria-hidden`かpresentation扱いとし、state、uncertainty、waiting、verificationをHTML textでも表示する。
- polite live regionは完了と通常status、assertiveはblocking decision、error、disconnectに限定する。tool streamを逐次読み上げない。
- ja/enを同じ機能範囲で提供する。初回はOS localeが`ja`で始まればja、それ以外はen。user content、path、branch、SHA、model名は翻訳しない。
- 200% text zoomでは文字を縮小せず、rail/drawer、wrap、horizontal scroll、overflow menuで主要操作を残す。
- high contrast/forced colorsではsemantic borderとsystem colorを優先し、背景画像やLive2Dなしでも操作できる。

## 性能と検証viewports

| 指標 | 合格条件 |
|---|---:|
| shell first interactive | Apple Silicon 16GB、release build、workspace 20件でp95 3,000ms以下 |
| tab/workspace/toggle feedback | 100 sampleでp95 100ms以下 |
| event render | receiptからp95 200ms以下 |
| Live2D input interference | Chat input p95 100ms、100ms超main-thread long task 0件 |
| visual regression | 1470×836でFigma主要boundary ±2px |

agent-browserで1470×836、1280×800、960×640、200% text zoom、reduced motion、ja/enを検証し、screenshotは`/tmp`またはignore済み`tmp/`へ保存する。

## OS差分

| 項目 | macOS 14+ Apple Silicon | Windows | Linux |
|---|---|---|---|
| release / support | MVP対応・実機検証対象 | MVP非対応 | MVP非対応 |
| window chrome | custom titlebar + traffic lights | artifactを提供しない | artifactを提供しない |
| modifier | Command | 非該当 | 非該当 |
| file picker / secret store | native picker / Keychain相当 | 非該当 | 非該当 |
| unsupported起動 | 非該当 | 対応済みと表示しない | 対応済みと表示しない |

## 関連要件

| 要件ID | 共通契約 | 要件定義書 |
|---|---|---|
| `APP-F-052`〜`APP-F-072` | window、layout、navigation、language、a11y、lifecycle、CSP、performance | [desktop-shell](../requirements/desktop-shell.md) |
| `WORK-F-059`〜`WORK-F-062` | workspace state分離と復元 | [workspace-sessions](../requirements/workspace-sessions.md) |
| `CODE-F-073`〜`CODE-F-076` | stop、crash、auth、stale event | [codex-main-session](../requirements/codex-main-session.md) |
| `HIST-F-037`〜`HIST-F-057` | local persistence、redaction、migration、recovery | [activity-history](../requirements/activity-history.md) |
| `LIVE-F-058`〜`LIVE-F-067` | resize、single canvas、text/reduced/static fallback | [live2d-companion](../requirements/live2d-companion.md) |
| `NARR-F-064`〜`NARR-F-076` | default off、secret、mute、fallback、microphone禁止 | [audio-commentary](../requirements/audio-commentary.md) |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| 1470px超の最大幅 | sidebar固定、S-002のChat/Companionを1:1で拡張する | 1728px visual QAでline lengthを確認する | いいえ |
| Intel Mac | MVP artifactはApple Siliconだけ | release工程でuniversal build時間を記録する | いいえ |
| OS notification | MVPはapp内statusだけ | demo後に需要を計測する | いいえ |

## レビュー確認

| 項目 | 内容 |
|---|---|
| レビュー結果 | Approved |
| レビュー日 | 2026-07-18 |

- [x] single main window、default/minimum geometry、titlebarを定義した。
- [x] breakpoint、scroll owner、focus、keyboard、ja/enを定義した。
- [x] loading、empty、processing、offline、error、permission、cancel、restartを定義した。
- [x] CSP、Capability、native boundary、persistence、recoveryを定義した。
- [x] WCAG 2.2 AA、200% text zoom、reduced motionを定義した。
- [x] 着手ブロックが「はい」または「不明」の未確定事項は0件である。
