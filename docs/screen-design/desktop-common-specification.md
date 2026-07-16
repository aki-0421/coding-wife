---
title: "デスクトップ共通仕様"
description: "React + TypeScript + Vite + Tauri v2デスクトップアプリに共通する実行境界、ウィンドウ、ライフサイクル、権限、保存、OS検証の確定仕様。"
updated: 2026-07-17
status: "Approved"
approval_date: 2026-07-17
read_when:
  - "Tauriウィンドウ、tray、終了、再開、OS差分、ネイティブ連携を設計するとき。"
  - "Codex App Server、TTS、ローカルデータ、Full accessの共通境界を実装または検証するとき。"
---
# デスクトップ共通仕様

この文書は全画面と全機能に共通するデスクトップ動作の正本である。機能固有の要件は、この文書との差分だけを各要件定義書と画面詳細仕様へ記録する。共通契約を変更する場合は、この文書を先に更新してから差分文書を更新する。

## 技術上の前提

- デスクトップシェルはTauri v2、フロントエンドはReact + TypeScript、ビルドはViteを使用する。
- Viteが生成した静的アセットをTauriへバンドルし、リリース版でフロントエンド開発サーバーを起動しない。
- Reactは表示、入力、画面内状態、画面遷移を担当する。OS操作、秘密情報、プロセス管理、永続化はRust側を信頼境界とする。
- Codex App Server sidecarは、ユーザー導入済みCodex CLI 0.144.5の`codex app-server --stdio`をTauri / Rustが子プロセスとして起動し、メインセッションと支援セッションのthread、turn、通知を調停する。アプリはCodex CLIを同梱、自動install、自動updateしない。
- sidecarとのtransportはstdin / stdout上の改行区切りJSON（JSONL）だけを使用する。実行する0.144.5からstableと`--experimental`の両方で生成したJSON SchemaおよびTypeScript生成物をwire contractの正本とし、adapterのcontract testでrequest、response、notificationを検証する。
- OpenAI Text-to-Speech APIへの通信はRust側から行い、API keyをReact state、Web Storage、SQLite、ログへ保存しない。
- App Serverのaccount、initialize、instruction、app/plugin診断は[codex-main-session要件](../requirements/codex-main-session/requirements.md)の実field契約だけを表示し、欠落・null・非対応を`unavailable`とする。workspace名、instruction scope/status、capability echoを推定しない。experimental `plugin/list`は開発診断だけに限定し、production起動・session・releaseを止めない。
- 生成`ServerRequest` unionと未知requestのrouting・解決はcodex-main-session要件だけを正本とし、shell独自fallbackを定義しない。

| 実行境界 | 責務 | 禁止事項 |
|---|---|---|
| React WebView | 表示、入力、画面遷移、アクセシブルな状態通知 | 任意コマンド実行、資格情報の永続化、OSパスの無検証利用 |
| Tauri / Rust | Capability検査、OS操作、SQLite、資格情報、sidecar、通知、TTS音声ストリーム | WebView入力を無検証でshellへ渡すこと |
| Codex App Server sidecar | ユーザー導入済み0.144.5の子プロセスとして、stdio JSONLでmain/support threadとturnの実行、イベント配信、interruptを行う | UIへ秘密情報を返すこと、stdio以外のlistenerを開くこと、アプリの終了要求を無視して常駐すること |
| OpenAI API | CodexモデルとTTSモデルのオンライン推論 | デスクトップのローカル状態の正本になること |

参考: [Tauri公式 Viteガイド](https://v2.tauri.app/start/frontend/vite/)、[Tauri公式 Process Model](https://v2.tauri.app/concept/process-model/)

## 対象プラットフォームと配布成果物

3つのOS向けartifactをハッカソン提出物として生成する。実機保証とCI検証を区別し、WindowsとLinuxについて未実施の実機検証を完了済みと表示しない。

| OS | アーキテクチャ | 最低バージョン | artifact | 検証水準 | 実機保証 |
|---|---|---|---|---|---|
| macOS | Apple Silicon（arm64） | macOS 13 | `.dmg` | 実機E2E、artifactからの起動、主要導線、Codex、TTS、Live2D、終了・復元を検証する | ハッカソン版の保証対象 |
| Windows | x64 | Windows 11 | `.msi` | unlocked interactive desktop VM runnerでbuild、install、window、tray、Quit、uninstallを自動検証する | 実機未検証。Live2D描画とTauri WebView挙動を保証しない |
| Linux | x64 | Ubuntu 24.04 | `.AppImage` | Xvfb `:99`、DBus、Xfce panel、FUSEを備えたVM runnerでbuild、window、tray、Quitを自動検証する | 実機未検証。Live2D描画とTauri WebView挙動を保証しない |

- macOS実機E2Eと3OSのwindow・tray・Quit artifact smokeをrelease合格条件とし、build/package成功だけでは合格にしない。
- Windows・Linux artifactはpreviewとしてラベル表示し、READMEとアプリ内診断画面へ実機未検証の制約を表示する。
- Live2DとTauri WebViewの視覚・入力・音声同期はmacOS 13以降のApple Silicon実機だけを保証する。
- App Store、Microsoft Store、Linux package repositoryへの公開、自動アップデート、配布署名の取得はハッカソン版の対象外とする。署名されていないartifactにはOS警告を回避せず、起動手順へ警告が表示される事実を記載する。
- release bundleへpackage、OS別verifier、macOS safe shell、version、byte数、SHA-256を列挙するmanifestを同梱する。PowerShell/POSIX shell/macOS safe shellは導入・初回起動前にsize/hashを検証し、欠落・不一致ならpackageを実行せず非0で停止する。導入手順は日本語・英語を提供する。

### Cubism配布境界

- release publisherは個人/General Userとし、実質的な管理主体と直近年商が1,000万円未満であることをrelease recordへ固定する。固定同梱1modelかつimport/追加/切替なしの非Expandableである間は、[Live2D公式FAQ](https://help.live2d.com/en/sdk/sdk_001/)と[publisher規模FAQ](https://help.live2d.com/en/sdk/sdk_007/)に基づきPublication License契約・申請・料金は不要とする。アプリが無料であることだけを免除根拠にしない。
- SDK取得者本人がProprietary/Open EULAに同意し、SDK release、Core/Framework、EULA、`RedistributableFiles.txt`のversion/date/hashをrelease recordへ残す。artifactは同fileが指定するCoreだけをas-isで含め、Frameworkをアプリの主要機能へ統合し、license・notice・copyrightとCore保護のend-user条項を保持する。
- 安全側のrelease gateとして、起動時のLive2D logo表示とREADME/提出説明のLive2D言及を必須にする。publisher条件の変更・不明化、Expandable化、配布file/notice/end-user条項の不備は配布をblockする。Publication Licenseが必要な場合は[releaseの1か月以上前](https://www.live2d.com/en/sdk/license/)に契約を完了する。
- Tauri WebViewは[Cubism公式platform表](https://docs.live2d.com/en/cubism-sdk-manual/platform/)にhostとして列挙されない。build成功で代替せず、`.dmg`、`.msi`、`.AppImage`の実artifactを対象OS環境で起動し、model load、WebGL/texture、animation、縮退をrelease gateで検証する。

## managed process tree

| OS | 所有境界 | crash時 |
|---|---|---|
| macOS / Ubuntu | app-owned sidecar/helperはdaemonize、`setsid`、double-forkを行わないlauncher契約でspawn時に専用supervised process groupへ登録する。appだけが非継承write endを持つliveness pipeをgroup外のsupervisorが監視する | app側pipeのEOFでsupervisorがgroupを終了し、登録group memberが0件になるまでwait/reapする |
| Windows | managed childをsuspendedで起動し、breakawayを禁止した`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`相当Job Objectへ割り当ててからresumeする | appのJob handle closeでOSがJob内processを終了する |

- tree registryはspawn UUID handshake、owner session、process-group/job identity、leader PID、executable file identity、start time、状態を持つ。登録group/job内だけをapp-ownedとし、Full access taskがgroupからescapeしたprocessまたは外部processは、検出できた場合も`external_or_unknown`として警告し、PIDだけでkillせず絶対終了を保証しない。
- stdout JSONLとstderrは別pipeで継続drainし、stderrはbounded bufferと秘匿化を適用する。終了は新規処理拒否、protocol interrupt、stdin/HTTP stream/audio close、最大5秒のgrace、group/job kill、wait/reapの順とする。
- explicit Quit、emergency stop、crash、手動installer updateのfixtureを各OSで10回実行し、登録group/job member 0件を確認する。escape/external fixtureは警告し無関係processを終了させない。手動更新はこの結果を確認できない場合、既存appを置換しない。

## ウィンドウとtray

### 構成

| 要素 | 識別子 | 目的 | 生成数 | ライフサイクル |
|---|---|---|---|---|
| メインwindow | `main` | セッション、コーディング、証跡、設定を表示する | 1プロセスにつき1つ | 初回起動時に生成し、閉じる操作では破棄しない |
| system tray | `desktop-tray` | 非表示中の再表示、緊急停止、明示Quitを提供する | 1プロセスにつき1つ | アプリの明示Quitまで維持する |

- 追加windowと追加WebViewは作成しない。画面は`main`内のReact route / view keyで切り替える。
- `main`はユーザーが変更した位置、サイズ、最大化状態をSQLiteへ保存し、次回起動時に接続中ディスプレイの表示領域内へ補正して復元する。
- trayメニューは `Show`、`Emergency Stop`、`Quit` の3操作をこの順序で表示し、日本語UIでは `表示`、`緊急停止`、`終了` と表示する。
- trayの `Show`、Dockアイコン、タスクバーアイコン、二重起動のいずれから再表示しても既存の`main`を表示して前面化し、新しいwindowを作成しない。

参考: [Tauri公式 System Tray](https://v2.tauri.app/learn/system-tray/)

### 閉じる操作

- `main`のOS標準close操作を捕捉し、windowを非表示にする。アプリプロセス、Codex App Server sidecar、全workspace session、実行中turn、TTS生成、TTS再生は継続する。
- close時に未送信の入力文をSQLiteへdraftとして保存し、再表示時に同じworkspaceへ復元する。
- close操作をQuitとして扱わず、turn interrupt、sidecar終了、TTS停止を実行しない。
- 非表示中もtrayを残す。trayを作成できない回復不能エラーが発生した場合はcloseを無効化し、`Quit`または再試行を選べるアプリ内エラーを表示する。

### 二重起動

- OS上で2個目のプロセスが起動された場合、引数と起動要求を既存プロセスへ転送し、既存の`main`を表示して前面化した後、2個目のプロセスを終了する。
- 2個目のプロセスはsidecar、tray、SQLite writerを起動しない。
- 起動引数に対応するDeep Linkとファイル関連付けはハッカソン版では提供しない。引数は診断ログへ値を残さず、既存windowの再表示だけに使用する。

参考: [Tauri公式 Single Instance](https://v2.tauri.app/plugin/single-instance/)

## アプリケーションライフサイクル

| 契機 | 動作 |
|---|---|
| 初回起動 | SQLiteを初期化し、Full access同意が未完了なら同意画面、完了済みならセッション一覧を表示する。sidecarは同意後に起動する |
| 通常起動 | SQLite migrationと整合性検査を行い、前回選択workspace、session一覧、選択session、window状態を復元する |
| window close | `main`を非表示にし、全セッションとTTSを継続する |
| tray / Dock / タスクバーから再表示 | 既存の`main`を表示し、最後に選択していたviewとworkspaceへ戻す |
| 二重起動 | 既存プロセスへ集約し、既存の`main`を再表示する |
| 緊急停止 | 新規turnを拒否し、実行中の全main/support turnをinterruptし、TTS生成・再生を停止する。アプリは終了しない |
| 明示Quit | 新規操作を停止し、turn interrupt、状態保存、sidecar終了、SQLite close、プロセス終了を順番に行う |
| クラッシュ後の起動 | 保存済み状態を復元し、完了記録のないturnを「予期しない中断」と表示する。turnを自動再実行しない |
| 更新版の初回起動 | SQLite migrationをtransactionで実行し、成功後に通常起動する。失敗時は旧DBを上書きせず起動を停止する |

### 明示Quit

明示Quitは、macOSの `Command+Q`、Windows・Linuxの `Ctrl+Q`、アプリメニューの `Quit`、trayの `Quit` から開始する。

1. ライフサイクルを`quitting`へ変更し、新しいprompt、support assignment、TTS要求を拒否する。
2. 実行中のmain turnと7つのsupport roleで実行中のturnへinterruptを送る。
3. TTSの待機queueを破棄し、HTTP音声streamと再生中bufferを停止する。
4. workspace、worktree、mainのApp Server thread ID、support assignment証跡、turn状態、timeline、未送信draft、選択view、window状態を1つのSQLite transactionで保存する。
5. 全managed treeへprotocol interruptとstdin/stream closeを行い、5秒以内に終了しない登録group / Jobを終了してwait/reapする。
6. 登録group/job memberが0件であることを確認し、`external_or_unknown`は警告として保存して、SQLite connection、tray、`main`を破棄しappを終了する。

- 手順4のtransactionが失敗した場合はQuitを中止し、`保存を再試行`と`最新状態を保存せず終了`を表示する。後者を選んだ場合も、turn interruptとsidecar終了を実行してから終了する。
- sidecarを強制終了した場合は、次回起動時に診断イベントを1件表示する。API key、prompt、応答本文、ファイル内容、絶対パスを診断イベントへ含めない。
- OSの強制終了、電源断、プロセスクラッシュでは明示Quit契約の完了を保証しない。次回起動時にクラッシュ後の復旧契約を適用する。

### 明示Quit後の再開

- 次回起動時に、Quit前のworkspaceとsessionを一覧へ戻し、最後に選択していたsessionを選択状態にする。
- interrupt済みturnは`アプリ終了により中断`と表示し、自動継続、自動再送、自動Git操作を行わない。
- ユーザーが中断sessionで`再開`を実行すると、同じmain root threadと同じ専用worktreeを使用し、Quitによる中断事実を含む新しいmain turnを開始する。
- support root threadとその生履歴は保持・再開しない。mainの再開後に同じroleへ次のassignmentが作成された時点で、新しい`ephemeral: true` root threadを作成し、保存済みの構造化contextとevidence参照を再投入する。
- 復元したworktreeが存在しない、Git repositoryでなくなった、読み取りできない、書き込みできない場合はCodex turnを開始せず、診断結果とrepository再選択操作を表示する。

## Codexセッションと支援エージェントの共通契約

| 項目 | main | support |
|---|---|---|
| App Server thread | sessionごとに1つの永続root thread | role別に最初のassignmentで作成するオンデマンドroot thread。`ephemeral: true`固定 |
| worktree | session専用worktree | 対応するmainと同じsession専用worktree |
| model | `gpt-5.6-sol`固定 | role mappingとApp Serverの`model/list`結果から自動選択 |
| sandbox | `danger-full-access`固定 | `danger-full-access`固定 |
| approval policy | `never`固定 | `never`固定 |
| AskUserQuestion | 利用でき、回答までmain turnを待機させる | 利用禁止。呼び出しを拒否し、mainへ質問候補を報告させる |
| ユーザー設定 | model、sandbox、approval policyを変更できない | model、sandbox、approval policyを変更できない |

- 通常のtool approvalではturnを停止しない。ユーザー回答を待つ停止状態は、mainが実行した`AskUserQuestion`だけが作成できる。
- canonical worktreeごとのexclusive turn leaseによりactive App Server turnを全thread合計1件にする。support中にmain要求を受理した場合はmainをqueueし、supportを強制cancelせずterminalと安定post snapshot後にmainがleaseを取得する。別worktreeのsessionは並行できる。
- mainが`AskUserQuestion`を出す時点で同sessionのrunning supportは0件である。main turnを待機させてleaseを保持し、回答overlayを表示する。新しいsupport assignmentは`deferred`にして回答後に再評価する。
- supportの質問要求はApp Server tool errorとして拒否し、質問内容をsupport結果としてmainへ返す。supportからユーザーへ直接overlayやOS通知を出さない。
- App Server開始時と再起動時に`model/list`を先頭から`nextCursor: null`まで取得し、support-agent-orchestration要件のrole mappingへ一致する利用可能modelを選ぶ。mainの`gpt-5.6-sol`が一覧にない場合はsessionを開始せず、設定・診断画面へ接続エラーを表示する。
- 内蔵skillsの実行順は固定しない。各agentがskillのtriggerと現在のtaskに基づいて選択する。
- main turn中のactive workspace eventはRustの決定論的event rendererがApp Server turnなしで即時play-by-playと重要event textを作り、TTSとLive2Dへ渡す。Narrator supportはmain terminal後のfresh snapshotでleaseを取得できる場合だけcolor commentary / turn summaryを補強し、失敗しても決定論的経路を継続する。
- desktop shellはtask完了を契機に`git commit`、`git push`、PR作成、mergeを自動実行しない。Git操作はユーザー指示とmainの判断に従うCodex turnだけが実行し、結果をtimelineへ記録する。

## 通知

OS通知は`main`が非表示または非アクティブな場合だけ送る。通知を送るイベントは次の3種類に限定する。

| イベント | 通知内容 | クリック時 |
|---|---|---|
| mainの`AskUserQuestion` | session名と「回答が必要です」 | `main`を表示し、対象sessionの回答overlayへフォーカスする |
| main turn完了 | session名と成功・中断・失敗の結果 | `main`を表示し、対象sessionのtimeline末尾へ移動する |
| 回復不能失敗 | 影響を受けた機能と診断画面への案内 | `main`を表示し、設定・診断viewへ移動する |

- support turn完了、通常のtool実行、Git状態変化、TTS発話、window closeではOS通知を送らない。
- 通知本文へprompt、応答本文、コード、API key、token、絶対パスを含めない。
- 通知権限が拒否されている場合もアプリ内overlayとtimelineで同じ状態を表示し、通知権限を繰り返し要求しない。

参考: [Tauri公式 Notification](https://v2.tauri.app/plugin/notification/)

## Full access、同意、緊急停止

### 既知のリスク

Codexのmain/supportは`danger-full-access`かつ`approval: never`で実行する。この契約により、Codexプロセスはログイン中のOSユーザーがアクセスできる範囲で、ファイルの読み取り・作成・変更・削除、プログラム実行、ネットワーク通信、Git remote操作を実行できる。誤った指示、prompt injection、生成コマンドの誤りにより、作業対象外ファイルの変更、データ消失、秘密情報の読み取り、外部送信が発生するリスクがある。Tauri Capabilityの制限はWebViewからRust Commandへの呼び出しを制御するものであり、Codex sidecarのFull accessをsandbox化しない。

### 初回明示同意

- 初回session開始前に、日本語または英語で上記リスク、固定されるsandboxとapproval policy、緊急停止の効果、停止しても既存変更を取り消さない事実を表示する。
- ユーザーがリスク説明を最後まで表示し、`Full accessを有効にする`を押した場合だけ同意完了とする。window close、戻る、`同意しない`ではsidecarとsessionを起動しない。
- 同意の文面version、日時、アプリversionだけをSQLiteへ保存する。同意文面versionが変わった場合は、次のsession開始前に再同意を要求する。
- UIから`sandbox`と`approval policy`を変更する設定を提供しない。拒否したユーザーは設定・診断とアプリ終了を利用できる。

### 緊急停止

- 緊急停止はコーディング画面とtrayから常に実行できる。
- 実行直後に新しいprompt、tool request、support assignment、TTS要求を拒否し、main/supportの全実行中turnへinterruptを送り、TTS queue、HTTP stream、音声再生を停止する。
- 緊急停止はアプリを終了せず、SQLite履歴とworktreeを削除せず、既に行われたファイル変更とGit操作を取り消さない。
- 緊急停止後は全sessionを`停止中`と表示する。ユーザーが対象sessionで`再開`を実行するまで新しいturnを開始しない。

## Capabilityとネイティブ認可

- Tauri Capabilityは`main`windowへ必要最小限で付与し、実際の設定は`src-tauri/capabilities/`を正本とする。
- repository選択はOS file dialogでdirectoryを1件選択し、Rust側で存在、Git repository、GitHub origin、読み書き権限を診断する。
- WebViewから任意のshell文字列を直接実行するCommandを提供しない。Codex App Serverへの入力はsession IDとthread IDをRust側で照合する。
- 外部URLはOpenAI、Tauri、Live2Dの公式資料とアプリ内で明示したsupport URLだけをOS既定browserで開く。file URLと任意schemeを拒否する。

| 機能 | 使用状態 | キャンセル・拒否・失敗時 |
|---|---|---|
| directory選択 | 使用する | キャンセルでは状態を変更しない。検証失敗では選択値を保存せず診断結果を表示する |
| system tray | 使用する | 作成失敗時はwindow closeを無効化し、再試行またはQuitを表示する |
| OS通知 | 3イベントで使用する | 拒否時はアプリ内表示へフォールバックする |
| OS credential store | TTS API key保存に使用する | 利用不能時はkeyを保存せずTTSを無効化し、診断結果を表示する |
| clipboard | コード・診断情報のユーザー操作によるcopyだけに使用する | 失敗時は元表示を維持してcopy失敗を表示する |
| Deep Link | ハッカソン版では使用しない | 受信処理を登録しない |
| ファイル関連付け | ハッカソン版では使用しない | 受信処理を登録しない |
| global shortcut | ハッカソン版では使用しない | 登録しない |
| 自動アップデート | ハッカソン版では使用しない | 新版はartifactを手動導入する |

参考: [Tauri公式 Capabilities](https://v2.tauri.app/security/capabilities/)

## ローカルデータ、秘密情報、オフライン

### SQLite

- OSのapplication data directoryにSQLite databaseを1つ作成し、workspace、session、mainのApp Server thread ID、turn、support assignment、timeline event、Git evidence、test result、model evidence、window state、ユーザー設定を構造化して保存する。supportはthread IDや生履歴を保存せず、assignment ID、role、実model・effort、status、秘匿化summary、evidence参照を保存する。
- timelineは発生時刻をUTCで保存し、表示時にOS timezoneへ変換する。eventはsession ID、role、event type、status、表示用summary、参照先IDを持つ。
- 書き込みはtransactionで行う。migration前にdatabaseを同じapplication data directoryへ1世代backupし、migration成功後もbackupを次の正常起動まで保持する。
- 起動時の整合性検査またはmigrationに失敗した場合、元databaseを上書きせず、sidecarとsessionを起動しない。設定・診断viewでdatabase pathを伏せたerror code、backup有無、`再試行`、`新規databaseで開始`を表示する。
- API key、access token、OS credential、生成音声bufferをSQLiteへ保存しない。

### TTS API key

| OS | 保存先 |
|---|---|
| macOS | Keychain |
| Windows | Windows Credential Manager |
| Ubuntu | Secret Service互換credential store |

- ユーザーが入力したTTS API keyはRust側へ1回だけ渡し、credential storeへの保存結果を受け取った時点でReactの入力値を消去する。
- 平文設定ファイル、環境変数、SQLite、Web Storage、診断ログ、クラッシュログへのfallbackを実装しない。
- credential storeがロック中、未導入、アクセス拒否、書き込み失敗の場合はkeyを保持せずTTSを無効化する。ユーザーはcredential storeを利用可能にしてから再入力する。
- key値を画面へ再表示せず、設定済み・未設定・利用不能の状態だけを表示する。

### オフライン

- オフライン時も保存済みworkspace/session一覧、timeline、diff evidence、test result、設定・診断を読み取れる。
- ネットワークを必要とするCodex turnとTTS生成は開始せず、入力文をdraftとして保持してオフライン状態を表示する。自動再送しない。
- 再接続後、ユーザーが送信または再生を明示した要求だけを実行する。
- TTS生成失敗時も実況テキストをtimelineへ表示し、音声なしでCodex作業を継続する。

## 共通エラーとログ

| エラー種別 | ユーザーへの表示 | 再試行 | データ保持 |
|---|---|---|---|
| 入力不備 | 対象項目と修正条件を項目直下へ表示する | 修正後にユーザーが再実行する | 入力を保持する。秘密入力は保持しない |
| ユーザーキャンセル | エラー表示を出さず操作前状態へ戻す | ユーザーが再操作する | 操作前状態を保持する |
| Capability / OS権限不足 | 拒否された機能とOS設定の確認手順を表示する | 権限変更後にユーザーが再実行する | 入力とsessionを保持する |
| ローカルI/O失敗 | 対象操作、短いerror code、再試行を表示する | 最大1回の自動再試行後、ユーザー操作へ切り替える | 成功済みtransactionだけを正とする |
| Codex / TTS API失敗 | 影響を受けたsession、HTTP status分類、再実行可否を表示する | Codexのrate limit・一時障害は上限3回、TTSは[audio-commentary要件](../requirements/audio-commentary/requirements.md)どおり自動再試行0回 | prompt draftとtext timelineを保持する |
| sidecar切断 | 全実行中turnを中断表示し、sidecar再起動を提示する | ユーザーが再起動を実行する | SQLite履歴とworktreeを保持する |
| 復旧不能な初期化失敗 | 回復不能通知と設定・診断viewを表示する | migrationまたはcredential storeの診断結果に従う | 元databaseとbackupを上書きしない |

- 永続ログはevent type、status、時刻、短いerror code、provider request IDだけを記録する。
- API key、token、credential、prompt、model応答本文、コード、ファイル内容、生成音声、絶対パスを永続ログへ記録しない。
- 診断情報をclipboardへcopyする前に、repository名を除くパス、remote URLのcredential、ユーザー名、秘密値をredactする。

## OS差分

| 項目 | macOS 13+ arm64 | Windows 11 x64 | Ubuntu 24.04 x64 |
|---|---|---|---|
| 検証 | Apple Silicon実機E2E | interactive desktop VMでwindow/tray/Quit smoke、実機未検証 | Xvfb+DBus+Xfce panel+FUSEでwindow/tray/Quit smoke、実機未検証 |
| 明示Quit | `Command+Q`、アプリメニュー、tray | `Ctrl+Q`、アプリメニュー、tray | `Ctrl+Q`、アプリメニュー、tray |
| window close | 非表示、処理継続 | 非表示、処理継続 | 非表示、処理継続 |
| 再表示 | Dockまたはtray | タスクバーまたはtray | タスクバーまたはtray |
| credential store | Keychain | Windows Credential Manager | Secret Service互換store。利用不能時はTTS無効 |
| artifact | `.dmg` | `.msi` preview | `.AppImage` preview |
| Live2D / WebView | 実機保証対象 | 実機未検証で保証対象外 | 実機未検証で保証対象外 |

## アクセシビリティと多言語

- 日本語と英語を提供し、初回はOS localeが日本語なら日本語、それ以外は英語を選ぶ。ユーザー変更をSQLiteへ保存する。
- キーボードだけでsession開始、prompt送信、AskUserQuestion回答、緊急停止、設定変更、Quitを実行できる。
- フォーカス順と初期フォーカスを各画面詳細仕様で一意に定義し、overlayを閉じた後は起点へフォーカスを戻す。
- status、agent role、test結果、エラーを色だけで伝えず、text labelとicon形状を併用する。
- TTSの全発話に同一内容のtext transcriptを表示する。
- OSのreduced motionが有効な場合、Live2Dの待機motionと装飾animationを停止し、状態変化に必要なtext表示は維持する。
- Live2D canvasを装飾としてaccessibility treeから除外し、session状態と実況内容をHTMLのstatus領域で通知する。

## ハッカソン版の共通スコープ

### 含める

- 単一main window、tray、window close後のバックグラウンド継続、明示Quit、復元、二重起動集約。
- macOS実機E2E、Windows CI、Ubuntu CI、3OS artifact。
- SQLite構造化履歴、OS credential store、Full access同意、緊急停止。
- sessionごとのmain永続root threadと、7 support roleのオンデマンド`ephemeral: true` root thread、固定実行権限、AskUserQuestion待機。
- 日本語・英語、キーボード操作、text transcript。

### 含めない

| 非対象 | 理由 |
|---|---|
| 複数window・複数WebView | 単一windowで主要導線を完結し、期限内の状態管理と検証を集中するため |
| Windows・Linux実機保証 | ハッカソン期間内の実機検証環境をmacOS Apple Siliconへ集中するため |
| 自動アップデート、store公開、配布署名取得 | 主要体験と3OS artifactのbuild検証を優先するため |
| Deep Link、ファイル関連付け、global shortcut | セッション開始と再開に不要で、OS別検証範囲を増やすため |
| sandbox・approval policy・main modelのユーザー変更 | 確定したCodex実行契約を全sessionで同一にするため |

## 未確定事項

共通仕様の着手を妨げる未確定事項はない。機能固有の論点は、対応する要件定義書の「未確定事項」で管理する。
