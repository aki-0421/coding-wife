---
title: "デスクトップシェル 要件定義"
description: "単一window、4 routes、tray、process-tree lifecycle、設定・診断、3OS artifactを統合するデスクトップshellの要件。"
updated: 2026-07-17
last_verified: 2026-07-17
status: "Approved"
prefix: "APP"
read_when:
  - "Tauri shell、route、tray、終了、緊急停止、single instanceを実装または検証するとき。"
  - "設定・診断、3OS artifact、起動smoke、IPC・CSP境界を確認するとき。"
---

# デスクトップシェル 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `APP` |
| 状態 | Approved |
| 仕様責任者 | プロダクトオーナー（PO） |
| 作成日 | 2026-07-16 |
| 最終レビュー日 | 2026-07-17 |

## 背景

8機能を統合するwindow、route、child process、設定、診断、配布artifactの境界が曖昧だと、孤児process、秘密漏えい、OS別起動失敗が残る。本書は[デスクトップ共通仕様](../../screen-design/desktop-common-specification.md)を正本とし、shell固有の差分だけを定義する。

### 用語

| 用語 | 定義 |
|---|---|
| active workspace | current routeがS-002またはS-003で示すworkspace。hidden中は保持し、S-001・S-004ではなし。 |
| managed process tree | app登録済みApp Server等のsupervised group / Job member。Full access taskがescapeしたprocessと外部processは`external_or_unknown`でありapp-ownedに含めない。 |
| explicit Quit | OS shortcut、app menu、trayからapp process全体を終了する操作。window closeとは別。 |
| emergency stop | appを残したまま新規実行を拒否し、全turn、audio、managed process treeを停止する操作。 |

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| 統合shell | 1つの`main` windowとtrayから4画面、複数session、設定、診断を利用できる。 |
| 終了安全性 | close、Quit、emergency、crashの各経路で状態とchildの結果を観測でき、dirty worktreeを自動変更しない。 |
| 配布可能性 | macOS、Windows、Ubuntuの3 artifactがbuild gateと起動smokeを通過する。 |
| 診断可能性 | Codex、TTS、Live2D、WebGL、audio、storage、Gitを秘密値なしで診断できる。 |
| OS統合品質 | 日本語・英語、keyboard、screen reader、reduced motion、high contrast、high DPIへ対応する。 |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| shell | Tauri v2 / RustとReact + TypeScript / Viteの境界、single instance、1 window、4 routes、tray。 |
| lifecycle | close、explicit Quit、emergency stop、managed process tree、crash復旧。 |
| settings・診断 | shell設定の検証、credential状態、component診断、redacted copy。 |
| release | `.dmg`、`.msi`、`.AppImage`、SHA-256 manifest、OS別事前検証、GUI smoke、macOS用safe shell、preview表示。 |
| security・A11y | IPC allowlist、CSP、path検証、日英、keyboard、OS表示設定。 |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| 複数window・複数WebView | 期限内の状態管理を単一境界へ閉じるため | [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) |
| 通常turnのPause / Resume | App Serverのinterruptとsession再開へ状態を限定するため | emergency、Quit、crash後の明示再開だけ提供 |
| 有料Developer ID / Windows証明書、macOS notarization、store公開 | 証明書取得と審査を期限外にするため | macOS ad-hoc signingとunsigned Windowsの警告・起動手順を提供 |
| custom installer UI、enterprise silent install | 標準artifactを優先するため | OS別checksum verifierから`.msi`、`.AppImage`、macOS用safe shellを起動する |
| 自動update、差分配信、rollback updater | schemaと主要導線を優先するため | 新artifactを手動導入 |
| Deep Link、file association、global shortcut | 外部入力面とOS別検証を増やさないため | handlerを登録しない |
| cloud settings同期、crash upload、telemetry | local-firstとprivacy境界を維持するため | local診断だけ保存 |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ユーザー | OS account本人 | route移動、window/tray、設定、診断、Quit、emergency | 不正値を保持して項目直下へ理由を表示する |
| React WebView | 非特権UI | redacted state表示、検証済みIPC要求 | shell、SQL、任意path、secret読取を拒否する |
| Tauri / Rust | shell信頼境界 | window、tray、child、credential、storage、OS操作 | allowlist外IPCを実行せず診断eventにする |
| main/support agent | Full accessのCodex actor | 対応session worktreeでturnを実行 | shell設定、window、credential storeを直接操作させない |
| build / CI | 3OS artifact生成主体 | build、test、package、smoke、evidence収集 | gate失敗artifactをrelease候補にしない |

## 機能要件

### runtime、window、route、tray

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| APP-F-001 | release appをTauri v2 / RustとReact + TypeScript / Viteで構成する。 | 3 artifactがVite生成static assetをbundleし、起動中のfrontend dev server、remote UI、2個目のWebViewが0件である。 | Approved | 非該当 |
| APP-F-002 | 1 processにつき`main` windowを1つだけ生成する。 | 初回起動、route移動、tray再表示、二重起動を各10回行ってもwindow label `main`とWebViewが各1件である。 | Approved | 非該当 |
| APP-F-003 | `main`に4 routesだけを提供する。 | `/sessions`=`S-001`、`/workspace/:sessionId`=`S-002`、`/evidence/:sessionId`=`S-003`、`/settings`=`S-004`となり、5番目のproduct routeを登録しない。 | Approved | 非該当 |
| APP-F-004 | routeとactive workspaceを検証・復元する。 | 再表示と再起動で最後のvalid route/sessionを復元し、不在・別workspaceのsession IDまたは未知routeはprocessを起動せずS-001へ戻して理由を表示する。 | Approved | 非該当 |
| APP-F-005 | trayへ`Show`、`Emergency Stop`、`Quit`だけを順番どおり表示する。 | 日英label、enabled状態、各操作が共通仕様と一致し、session・model・pause項目が0件である。 | Approved | 非該当 |
| APP-F-006 | OS window closeで`main`だけを非表示にする。 | close後もapp、tray、全session/turn、TTS生成・再生が継続し、非秘密draftを保存し、Live2D render loopだけを停止する。 | Approved | 非該当 |
| APP-F-007 | tray、Dock、taskbarから既存`main`を再表示する。 | 500 ms以内に同じwindow、route、active workspaceを前面化し、新規window、sidecar、SQLite writerを作成しない。 | Approved | 非該当 |
| APP-F-008 | trayを作成できない場合はwindow closeを無効化する。 | `APP_TRAY_UNAVAILABLE`、再試行、explicit Quitを表示し、close操作で到達不能なbackground processを作らない。 | Approved | 非該当 |
| APP-F-009 | 二重起動を既存processへ集約する。 | 2個目は既存`main`を前面化して終了し、window、tray、SQLite writer、managed treeを0件生成する。引数値をlogへ残さない。 | Approved | 非該当 |
| APP-F-010 | active workspaceだけをcompanionと実況の対象にする。 | background eventはtimeline保存だけ行い、Live2D、transcript、audioを変えない。active変更・解除ではgenerationを更新し、旧audio stateを100 ms以内に破棄する。 | Approved | 非該当 |

### Quit、emergency、crash

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| APP-F-011 | OS shortcut、app menu、trayの3経路を同じexplicit Quitへ集約する。 | macOS `Command+Q`、Windows・Ubuntu `Ctrl+Q`、menu、trayの各fixtureで同じ順序・error処理が1回だけ実行される。 | Approved | 非該当 |
| APP-F-012 | explicit Quit開始後に新しい処理を拒否する。 | lifecycleを`quitting`にし、prompt、support assignment、Git/test、TTS、route由来の再試行を開始せず、実行中main/support turnへinterruptを1回送る。 | Approved | 非該当 |
| APP-F-013 | explicit Quitで状態をatomic保存しdirty worktreeを保持する。 | workspace/session、main thread、support assignment、turn、timeline、draft、route、window状態を1 transactionで保存し、stash、reset、clean、checkout、commitを発行しない。 | Approved | 非該当 |
| APP-F-014 | explicit Quitで全managed process treeを終了する。 | macOS/Ubuntuのapp-owned sidecarはdaemonize/setsid/double-fork禁止でsupervised group+liveness pipe、Windowsはbreakaway禁止Jobへ登録する。interrupt/close/grace/kill/wait後に登録memberを0件にし、escaped/externalは警告して絶対終了を主張しない。 | Approved | 非該当 |
| APP-F-015 | Quit保存失敗時にユーザーが再試行または未保存終了を選べる。 | `保存を再試行`は同じtransactionを1回実行し、`最新状態を保存せず終了`はAPP-F-012とAPP-F-014を完了する。cancelではappを残す。 | Approved | 非該当 |
| APP-F-016 | 通常turnのPause / Resume UIとIPCを提供しない。 | button、menu、shortcut、tray、IPCにpause/resume操作が0件で、interrupt後の再開は新しいmain turnとしてユーザー操作でだけ開始する。 | Approved | 非該当 |
| APP-F-017 | emergency stopをS-002とtrayから常時利用可能にする。 | foreground、hidden、offline、質問待ち、error表示中の各状態で操作でき、実行から250 ms以内に新規prompt、assignment、TTSを拒否する。 | Approved | 非該当 |
| APP-F-018 | emergency stopをinterruptからtree killへ段階実行する。 | 全turnをinterruptしaudioを100 ms以内に停止する。3秒後にstdin、さらに2秒後にAPP-F-014のgroup/jobをkillし、登録memberを0件にする。`external_or_unknown`は警告してkillを保証しない。 | Approved | 非該当 |
| APP-F-019 | emergency stop後もappと既存変更を保持する。 | 全sessionを`停止中`にし、SQLite履歴、branch、worktree、dirty fileを削除・rollbackせず、sidecar再診断とsessionの明示再開まで新規turnを拒否する。 | Approved | 非該当 |
| APP-F-020 | crash後に保存済みshell状態を復元する。 | liveness pipe EOF / Job closeで登録group/jobを終了し、route、workspace/sessionを復元する。未完了turnを`予期しない中断`にし、自動prompt、command、Git、test、TTSを0件にする。 | Approved | 非該当 |
| APP-F-021 | crash後に登録済みapp-owned orphanだけを安全に回収する。 | spawn UUID、group/job identity、executable identity、start timeが全一致する対象だけを回収して登録memberを0件にする。escape、外部、PID再利用は残して`external_or_unknown`を警告し、絶対killを保証しない。 | Approved | 非該当 |

### 通知、初回、offline、設定

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| APP-F-022 | OS通知をmain AskUserQuestion、main turn完了、回復不能失敗の3 typeに限定する。 | `main`がhiddenまたはinactiveの場合だけ送り、clickで順にS-002回答、S-002末尾、S-004へ移動する。support完了、Git/test、audio、closeでは0件である。 | Approved | 非該当 |
| APP-F-023 | 通知拒否と秘密を安全に扱う。 | permission拒否後は再要求せず同じapp内表示を維持し、通知title/bodyにprompt、response、code、key、token、absolute pathが0件である。 | Approved | 非該当 |
| APP-F-024 | 初回起動をsidecarなしで完了できる。 | DB初期化、OS locale選択、Full access同意をS-001の初回状態で行い、同意前はmanaged treeが0件である。拒否時もS-004とQuitを利用できる。 | Approved | 非該当 |
| APP-F-025 | offline時もlocal shell機能を提供する。 | S-001、保存済みS-002/S-003、S-004、設定、履歴削除を利用でき、Codex/TTSを開始せずdraftを保持し、再接続後も自動送信・再生しない。 | Approved | 非該当 |
| APP-F-026 | errorを影響範囲へ分離して再試行可能にする。 | route/component errorはerror boundary、I/Oは1回自動retry後に手動retry、回復不能DB/child初期化はS-004へ移し、非秘密入力と正常sessionを保持する。 | Approved | 非該当 |
| APP-F-027 | shell設定をRustで検証しatomic保存する。 | locale、theme（`system|light|dark`）、TTS、notificationをschema検証する。`system`はOS変更に追従し、明示themeは維持、forced colorsはOS優先とする。不正値・write失敗は全fieldを直前commitへ戻し、model/sandbox/approvalはread-onlyとする。 | Approved | 非該当 |
| APP-F-028 | TTS API keyをwrite-onlyで設定・削除する。 | 削除はTTSを停止し`deleting`をatomic保存してからcredential storeを消去する。成功だけ`unset`、失敗・再起動は`delete_failed`/text-onlyとし再試行する。key値をUI、SQLite、Web Storage、log、diagnostic、IPC responseへ残さない。 | Approved | 非該当 |

### 設定・診断

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| APP-F-029 | S-004からcomponent診断を一括または個別実行できる。 | check ID、`pass|warn|fail|unavailable`、開始・終了UTC、error code、再試行可否を表示し、同一checkのrunningを最大1件にする。 | Approved | 非該当 |
| APP-F-030 | Codex CLIとApp Server契約を診断する。 | CODE-F-004/008/033〜036の実field/pathだけを表示し、欠落・null・非対応は`unavailable`とする。workspace名、instruction scope/status、capability echoを推定せず、`plugin/list`は開発診断だけでproduction/release gateにしない。ServerRequest routingはCODE-F-009〜011だけを正本とする。 | Approved | 非該当 |
| APP-F-031 | TTS credential、model、audio outputを診断する。 | NARR-F-031のendpoint・snapshot、credential/key状態、default output、user起動sample、最終成功UTC、NARR-F-043の接続分類を表示し、key値とdevice IDを保存しない。 | Approved | 非該当 |
| APP-F-032 | Live2D asset・WebGL・公開条件を診断する。 | asset/WebGLに加え、個人/General User・直近年商1,000万円未満・固定1model/非Expandableの記録を表示し、満たす場合だけPublication License契約・申請・料金不要と判定する。条件不明はrelease failとする。 | Approved | 非該当 |
| APP-F-033 | storage、schema、Gitを診断する。 | app dataのread/write、SQLite schema/integrity/backup/free bytes、Git executable/version/worktree support、選択sessionのrepository/worktree対応を個別表示する。 | Approved | 非該当 |
| APP-F-034 | 診断表示とcopyをredactする。 | API key、token、credential、prompt、response、code本文、username、remote userinfo、absolute pathを除去し、repository名、component、version、status、error codeだけをcopyできる。 | Approved | 非該当 |

### 複数sessionとactive workspace

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| APP-F-035 | 3つのmain sessionを別worktreeで同時稼働できる。 | 異なる3 canonical worktreeでA/CのmainとBのsupportを各1 turn同時runningにし、同一worktreeはactive turn最大1件とする。S-001/S-002を30回切り替えてもsession/thread/timelineが混在しない。 | Approved | 非該当 |
| APP-F-036 | session数へfixed capを設けない。 | 4件目以降の同時稼働開始前に現在数、CPU/memory/model負荷、`続行`、`キャンセル`を表示し、続行では開始し、cancelでは状態を変えない。件数だけで拒否しない。 | Approved | 非該当 |

### artifactとrelease gate

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| APP-F-037 | macOS、Windows、Ubuntuの標準artifactを生成・配布する。 | macOS 13+ Apple Silicon `.dmg`、Windows 11 x64 `.msi`、Ubuntu 24.04 x64 `.AppImage`がclean buildから1件ずつ生成され、同一versionのrelease bundleへ収録される。 | Approved | 非該当 |
| APP-F-038 | 各artifactでGUI・Live2D・Quit smokeを実行する。 | macOS実機、interactive Windows、Xvfb+DBus+Xfce+FUSEのUbuntuでwindow/tray/Live2DとQuit後の登録member 0件を確認し、escape/external fixtureでは警告する。screenshot、log、process inventoryを保存しWindowsはinstall/uninstallも行う。 | Approved | 非該当 |
| APP-F-039 | OS別release gateとpreview表示を適用する。 | macOS実機E2EとAPP-F-038の3OS GUI smokeが成功した場合だけrelease候補にする。build/package成功だけでは合格にせず、Windows/UbuntuはCI GUI検証済み・実機未検証と表示する。 | Approved | 非該当 |
| APP-F-040 | 無料で再現できるtoolchainだけをrelease・提出gateにする。 | macOSはad-hoc signed app、Windowsはunsigned `.msi`、Ubuntuは`.AppImage`を生成し、有料Developer ID / Windows証明書、notarization、store receiptの不在を失敗にしない。updater、Deep Link、file associationは0件である。 | Approved | 非該当 |

### IPC、CSP、path

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| APP-F-041 | WebView IPCをtyped allowlistへ限定する。 | route、workspace、history read、設定、診断、lifecycleの既知commandだけを受け、任意shell、SQL、URL、path、child commandを受けるgeneric IPCが0件である。 | Approved | 非該当 |
| APP-F-042 | release CSPでremote・動的code実行を拒否する。 | bundled assetとTauri IPCに必要なsourceだけを許可し、inline/eval script、remote script/style/frame、WebView直接HTTP/WebSocketをCSP testで遮断する。 | Approved | 非該当 |
| APP-F-043 | pathとprocess起動をRust側で再検証する。 | workspace/session IDからcanonical pathを再解決し、containment・symlink・存在・権限を検証する。childはallowlist executableとargument arrayで起動しshell文字列を使わない。 | Approved | 非該当 |

### 多言語とaccessibility

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| APP-F-044 | shell UIを日本語と英語で提供する。 | OS localeが日本語なら`ja`、それ以外は`en`を初期値にし、変更後は4 routes、tray、notification、error、diagnosticが選択言語となる。ID/version/pathは翻訳しない。 | Approved | 非該当 |
| APP-F-045 | shell主要導線をkeyboardとscreen readerで利用可能にする。 | 4 route移動、session選択、settings、diagnostic、AskUserQuestion、emergency、Quitをpointerなしで実行でき、overlay終了後は起点へfocusが戻り、statusをARIA live regionで通知する。 | Approved | 非該当 |
| APP-F-046 | reduced motion、high contrast、high DPIへ追従する。 | reduced motionで装飾animationを250 ms以内に停止し、forced colorsでtext/icon/borderを識別でき、800×600〜3,840×2,160・100/150/200% scaleで主要操作が欠けない。 | Approved | 非該当 |

### 配布完全性とmacOS導入

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| APP-F-047 | 3OS配布物へSHA-256 manifestと事前検証entrypointを同梱する。 | manifestがpackage、verifier、macOS shell、version、byte数、SHA-256を列挙する。PowerShell、POSIX shell、macOS safe shellが導入・初回起動前に対象を検証し、欠落・size/hash不一致ならartifactを実行せず非0で停止する。 | Approved | 非該当 |
| APP-F-048 | macOS appへ再現可能なad-hoc signingを行う。 | clean build手順が無料のOS標準toolで`.app`をad-hoc signし、package前後にbundle全体の署名検証が成功する。有料identityやnetwork serviceを要求しない。 | Approved | 非該当 |
| APP-F-049 | macOSのinstallから初回起動までを日英で提供する。 | JA/EN手順と`/bin/sh`用user installer/launcherを配布し、GUI手順だけでも完了できる。shellは非対話CI buildと別artifactで、CIやdownload直後に自動実行されない。 | Approved | 非該当 |
| APP-F-050 | macOS shellを失敗安全にする。 | APP-F-047を検証し`$HOME/Applications`へsudoなしで導入する。更新時は既存appへQuitを要求し登録group member 0件を確認してからbackup/置換し、失敗時rollbackする。全pathをquoteし、取消・検証・終了・導入失敗を別codeにする。 | Approved | 非該当 |
| APP-F-051 | Gatekeeper / quarantine対応を最小権限にする。 | まずFinderの`開く`というOS標準導線を案内し、なお遮断される場合だけrisk説明と明示同意後に、checksum検証済みの正確な`.app` bundleの`com.apple.quarantine`だけを扱う。任意path、親directory、広範囲属性操作を拒否する。 | Approved | 非該当 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| route | session ID | 選択session | S-002/S-003で必須 | 保存済みsession UUID、active workspace所属 | S-001へ戻し理由を表示する |
| settings | locale | OS locale | 必須 | `ja`または`en` | 保存せず直前値を維持する |
| settings | TTS enabled | `false` | 必須 | boolean。key設定とAI音声確認の完了後だけ`true`にできる | 保存しない |
| settings | mute | `false` | 必須 | boolean | 保存しない |
| settings | volume | `70` | 必須 | integer 0〜100 | 実値と境界を表示する |
| settings | voice | `cedar` | 必須 | [audio-commentary要件](../audio-commentary/requirements.md)で定義する固定13 voiceのいずれか | 保存せず直前値を維持する |
| settings | narration language | `ui` | 必須 | `ui`、`ja`、`en` | 保存せず直前値を維持する |
| settings | AI音声確認version | 未確認 | TTS有効化時に必須 | 現在の確認文versionと一致する非負整数 | TTSを有効化しない |
| settings | notification preference | OS状態 | 必須 | boolean。enable時だけOS permissionを要求 | 拒否状態を保持する |
| settings | TTS API key | 空 | 任意 | 1〜512 ASCII、前後whitespaceなし、write-only | 値を保持せず再入力を求める |
| concurrency | 4件目以降 | 未選択 | 条件付き | `続行`または`キャンセル` | cancelで状態を維持する |
| Quit failure | 保存失敗後の選択 | 未選択 | 条件付き | 再試行、未保存終了、cancel | 選択までappを残す |

### shell lifecycle状態

| 状態 | 新規turn | child | 終了条件 |
|---|---|---|---|
| `foreground` | 可 | 稼働可 | close、Quit、emergency |
| `hidden` | background event経由のみ | 継続 | Show、Quit、emergency |
| `quitting` | 拒否 | interrupt後に終了 | process終了またはsave cancel |
| `emergency_stopped` | 拒否 | kill fallback後0件 | 診断合格とsession明示再開 |
| `recovering` | 拒否 | app-owned orphanだけ回収 | integrity・tree診断完了 |

## デスクトップ固有要件

[デスクトップ共通仕様](../../screen-design/desktop-common-specification.md)との差分だけを定義する。

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | macOS実機E2E、Windows/Ubuntu GUI-capable CI previewとし、3OSでartifactのwindow/tray/Quit smokeを行う。 | APP-F-037〜APP-F-040 |
| ウィンドウ生成・再利用 | 単一`main`と4 routesを再利用する。 | APP-F-002〜APP-F-004 |
| 閉じる・アプリ終了 | close、Quit、emergency、crashを区別する。 | APP-F-006、APP-F-011〜APP-F-021 |
| 未保存データ | 非秘密draftと構造化状態を保存し、dirty worktreeを変更しない。 | APP-F-013、APP-F-015、APP-F-020 |
| ローカルデータ | SQLiteとcredential storeを共通正本とし、shell独自data storeを増やさない。 | APP-F-024、APP-F-027〜APP-F-034 |
| オフライン | local route、履歴、settings、diagnosticを提供し、自動再送しない。 | APP-F-025 |
| ファイル・OS操作 | repository picker、credential、artifact、child、audio outputをRust境界で扱う。 | APP-F-028、APP-F-031、APP-F-037〜APP-F-043 |
| メニュー・ショートカット | QuitはOS shortcut、app menu、trayへ限定し、global shortcutを登録しない。 | APP-F-005、APP-F-011、APP-F-016 |
| Deep Link・ファイル関連付け | 非該当: scheme、association、外部route handlerを登録しない。 | APP-F-009、APP-F-040 |
| 通知 | 共通3 typeだけをrouteへ接続する。 | APP-F-022、APP-F-023 |
| Capability・認可 | IPC、CSP、path、processをAPP-F-041〜APP-F-043で閉じる。 | APP-F-041〜APP-F-043 |
| アップデート・互換性 | 自動updateなし。schemaはHIST、artifactは対象要件を適用する。 | APP-F-033、APP-F-037〜APP-F-040 |

## 画面・UI

| 画面ID | Route | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|---|
| `S-001` | `/sessions` | セッションダッシュボード | APP-F-003〜APP-F-004、APP-F-022〜APP-F-026、APP-F-035〜APP-F-036、APP-F-044〜APP-F-046 | 新規 | [S-001 セッションダッシュボード](../../screen-design/S-001_session-dashboard.md) |
| `S-002` | `/workspace/:sessionId` | コーディングワークスペース | APP-F-003〜APP-F-007、APP-F-010〜APP-F-023、APP-F-035〜APP-F-036、APP-F-044〜APP-F-046 | 新規 | [S-002 コーディングワークスペース](../../screen-design/S-002_coding-workspace.md) |
| `S-003` | `/evidence/:sessionId` | セッション証跡 | APP-F-003〜APP-F-004、APP-F-010、APP-F-022〜APP-F-026、APP-F-034〜APP-F-036、APP-F-044〜APP-F-046 | 新規 | [S-003 セッション証跡](../../screen-design/S-003_session-evidence.md) |
| `S-004` | `/settings` | 設定・診断 | APP-F-003〜APP-F-004、APP-F-008、APP-F-015、APP-F-019〜APP-F-051 | 新規 | [S-004 設定・診断](../../screen-design/S-004_settings-diagnostics.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | APP-F-041〜APP-F-043をrelease buildで検査する。Full accessのsidecarとWebView Capabilityを別境界として表示する。 |
| 権限 | `main`へ必要最小Capabilityだけを付与し、credential、process、filesystem、notificationはRust側で操作ごとに再認可する。 |
| プライバシー | credential値、conversation、code、audio、absolute pathをshell log、notification、diagnostic copy、crash recordへ保存しない。 |
| 監査・ログ | app/version/OS、lifecycle遷移、child ID/type/status、diagnostic check/error code、UTCだけを構造化保存し、HISTのretention/deletionを適用する。 |
| 性能 | 8 CPU core・16 GBのmacOSでprocess開始からS-001/S-004表示p95 5秒、route切替p95 250 ms、tray Show p95 500 msとする。初回migration、OS security dialog、model/API待ちは除外する。 |
| 並行負荷 | 別worktreeの3 sessionで各active turn最大1件とし、route切替p95 500 ms以下、30回中誤workspace表示0件とする。4件目以降はwarningを必須とし性能値を保証しない。 |
| 信頼性・復旧 | tree registry、idempotent lifecycle、single instance、atomic state、orphan照合をfault injectionで検証し、未知processをkillしない。 |
| アクセシビリティ | WCAG 2.2 AAを目標とし、APP-F-045〜APP-F-046、text label、44×44 CSS pxの主要target、200% text zoomをmacOS実機で検証する。 |
| 多言語・地域 | 日本語・英語を提供し、UTC保存・OS timezone表示、locale切替後のroute/tray/notification同期を行う。 |

## artifact検証マトリクス

| OS | Artifact | 必須検証 | 表示 |
|---|---|---|---|
| macOS 13+ Apple Silicon | ad-hoc signed `.dmg`、JA/EN手順、safe `.sh`、manifest | 実機で検証・install、window/tray/Quit、主要導線、Codex/TTS/Live2D | 実機保証 |
| Windows 11 x64 | unsigned `.msi`、JA/EN手順、manifest/verifier | interactive desktop VMで検証・install、window/tray/Quit、uninstall | preview・実機未検証 |
| Ubuntu 24.04 x64 | `.AppImage`、JA/EN手順、manifest/verifier | Xvfb+DBus+Xfce panel+FUSEで検証・window/tray/Quit | preview・実機未検証 |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) | lifecycle、SQLite、notification、Full access、3OSの正本 | 解決済み | APP差分を適用できない |
| [workspace-sessions要件](../workspace-sessions/requirements.md) | session/worktree、3並行、4件目warningを提供する | Approved | APP-F-004、APP-F-035〜APP-F-036を検証できない |
| [codex-main-session要件](../codex-main-session/requirements.md) | CLI 0.144.5、App Server、main interrupt/resumeを提供する | Approved | tree lifecycleとAPP-F-030を検証できない |
| [support-agent-orchestration要件](../support-agent-orchestration/requirements.md) | ephemeral support、interrupt、model catalogを提供する | Approved | Quit/emergencyの全turn停止を検証できない |
| [git-review-harness要件](../git-review-harness/requirements.md) | Git/test childとevidenceを提供する | Approved | child分類とGit診断を統合できない |
| [activity-history要件](../activity-history/requirements.md) | SQLite、migration、recovery、redactionを提供する | Approved | 保存、crash復旧、診断logを検証できない |
| [live2d-companion要件](../live2d-companion/requirements.md) | 固定1model、SDK/EULA配布記録、公開条件、3OS WebView smokeを提供する | Approved | APP-F-010、APP-F-032、APP-F-038を検証できない |
| [audio-commentary要件](../audio-commentary/requirements.md) | current active workspaceだけのtext/TTS、queue、Speech、設定、audio outputを提供する | Approved | APP-F-010、APP-F-018、APP-F-027〜APP-F-031を統合検証できない |
| CI runners | macOS arm64実機、unlocked interactive Windows 11 x64 VM、Xvfb/DBus/Xfce/FUSE付きUbuntu 24.04 x64 VM | release gate | 1環境でも欠けるとAPP-F-037〜APP-F-040をrelease合格にできない |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| 画面相互参照 | 4 screen/route対応を使用する | 要件表と画面表の機械照合で差分0件を維持する | いいえ |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [要件定義基準](../../rules/requirements-definition-standards.md) | 記述基準 |
| [要件定義テンプレート](../../rules/requirements-definition-template.md) | 文書形式 |
| [ID管理ルール](../../rules/id-management-rules.md) | ID正本 |
| [要件定義索引](../README.md) | 機能索引 |
| [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) | 共通契約 |
| AskUserQuestion回答（2026-07-16） | 3OS配布方針 |

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Not Ready |
| 仕様責任者 | プロダクトオーナー（PO） |
| 合意日 | 2026-07-17 |
| 残る非ブロック論点 | なし |

## 着手可チェック

- [x] 背景と目的が説明できる。
- [x] スコープ内・外と理由が明確である。
- [x] 全機能要件に一意な要件IDがある。
- [x] 全機能要件に検証可能な受け入れ条件がある。
- [x] 正常系、異常系、キャンセル、権限差分、空状態、境界値を確認した。
- [x] デスクトップ固有要件を確認し、非該当も明記した。
- [x] 画面IDと要件IDの相互参照が一致している。
- [x] 非機能要件と依存関係を確認した。
- [x] 着手ブロックが「はい」または「不明」の未確定事項がない。
- [x] 仕様責任者がレビューし、合意した。
