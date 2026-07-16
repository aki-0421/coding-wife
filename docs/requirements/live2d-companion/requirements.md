---
title: "Live2Dコンパニオン 要件定義"
description: "許諾済みの同梱モデル1体だけでmain Solの状態を表現し、描画不能時もtextへ安全に縮退する要件。"
updated: 2026-07-16
last_verified: 2026-07-16
status: "Draft"
prefix: "LIVE"
read_when:
  - "同梱Live2Dモデルのasset境界、状態表現、描画、lip-syncを実装または検証するとき。"
  - "ユーザーモデル追加禁止、Live2Dライセンス表示、WebGL縮退、3OS差分を確認するとき。"
---

# Live2Dコンパニオン 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `LIVE` |
| 状態 | Draft |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-16 |
| 最終レビュー日 | 未レビュー |

## 背景

長時間のCodex作業では、main Solの現在状態を短時間で把握できる視覚表現が必要である。任意modelの追加は配布ライセンスと検証範囲を拡大するため、許諾済みの同梱モデル1体だけへ閉じる。

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| main状態を視覚化する | main Solの9状態を固定表情と同内容のtextへ反映する。 |
| 配布境界を閉じる | 同梱モデルが1体だけ存在し、外部modelの入口が0件である。 |
| 描画障害から縮退する | model・WebGL障害時もCodexを止めず、static、hidden、textを維持する。 |
| 配布差分を示す | macOS実機E2E、Windows・Ubuntu CI、preview表示が完了する。 |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| model resource | 許諾済み1体、16表情、runtime metadata、texture、static previewをbundleする。 |
| 状態表現 | 開いているworkspaceのmain Solだけを9状態と固定表情へ対応させる。 |
| animation | 表情、blink、breath、position/scale、TTS mouthだけを使用する。 |
| 縮退・診断 | reduced motion、TTSなし、asset・WebGL障害をstatic、hidden、textへ縮退する。 |
| 配布・告知 | SDK notice、適用EULA、creator表記、OS別検証水準を表示する。 |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| ユーザーmodelの追加、import、交換 | Expandable Application機能を持ち込まないため | ハッカソン版では禁止 |
| model用file picker、drag and drop、URL、watch folder | 外部model resourceの入力経路を作らないため | ハッカソン版では禁止 |
| plugin hook、IPC model path、model swap API | hidden APIから配布境界を迂回させないため | ハッカソン版では禁止 |
| marketplace、model・expression editor | 状態表現へ集中するため | 期限後も別途ライセンス判断が必要 |
| authored motion playback、motion生成 | 同梱modelにmotion resourceがなく、期限内検証を表情とparameterへ限定するため | 非対象 |
| support avatar、複数model表示 | main Solだけを表現するため | [support-agent-orchestration要件](../support-agent-orchestration/requirements.md) |
| camera、microphone、STTによるlip-sync | TTS音声だけを入力とし、追加権限を不要にするため | [audio-commentary要件](../audio-commentary/requirements.md) |
| Windows・UbuntuのLive2D実機保証 | ハッカソン期間の実機検証をmacOS Apple Siliconへ集中するため | preview artifactとしてbuild/testだけを必須化 |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ユーザー | main window利用者 | 状態・license閲覧、renderer再試行 | model選択・追加・交換を拒否 |
| main Sol | 開いているworkspaceのmain thread | turn・item状態を発生 | 相関不一致eventを破棄 |
| support role | mainを支援する7 role | support evidenceを生成 | avatar・表情の対象外 |
| TTS adapter | 実況音声の再生境界 | 相関済みenvelopeを渡す | 不正値、別audio、mic入力を拒否 |
| React renderer | 同梱resource表示境界 | manifest、mapping、WebGL、縮退を扱う | 任意path、URL、pluginを拒否 |
| build / release pipeline | 配布境界 | 許諾済みassetをbundleし検査 | resource・hash・license不備で失敗 |

## 機能要件

### 同梱assetとライセンス境界

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| LIVE-F-001 | release artifactへ同梱モデルを1体だけ含める。 | artifact展開検査でmodel descriptorとcompiled modelが各1件で同じresource IDに属し、2体目のdescriptor、compiled model、model catalogが0件である。 | Draft | 非該当 |
| LIVE-F-002 | 許諾済みsource assetから固定bundleへruntime resourceだけを複製する。 | clean buildでdescriptor、compiled model、texture、physics、display metadata、16 expressions、previewだけを複製し、editor source、配信tool設定、補助資料を除外する。 | Draft | 非該当 |
| LIVE-F-003 | resource manifestで配布内容とhashを固定する。 | 各resourceのrelative path、SHA-256、media type、byte長が1件あり、欠落、余分、hash不一致、重複、motionがあればbuildと起動診断を`LIVE_ASSET_INVALID`にする。 | Draft | 非該当 |
| LIVE-F-004 | resource pathをapplication bundle内へ閉じる。 | manifest記載relative pathだけを受理し、absolute、`..`、URL、bundle外symlink、workspace、home、application data参照をdecode前に拒否する。 | Draft | 非該当 |
| LIVE-F-005 | model追加用UIとOS入力を提供しない。 | S-002、S-004、menu、context menuにmodel picker、import、drag and drop、URL、watch folder、model選択が存在せず、model fileをdropしても状態とfilesystemが変化しない。 | Draft | 非該当 |
| LIVE-F-006 | model追加用外部起動経路を登録しない。 | Deep Link、file association、CLI argument、clipboard、network responseからmodel resourceを登録するhandlerが0件で、該当入力を与えても同梱モデルresource IDが変化しない。 | Draft | 非該当 |
| LIVE-F-007 | pluginとhidden APIからmodelを交換できない。 | Tauri Command、IPC message、JavaScript global、plugin hook、config keyにmodel path、model URL、model bytes、model swapを受け取るpublic entryが0件であることをrelease API surface testで確認できる。 | Draft | 非該当 |
| LIVE-F-008 | runtimeで外部modelを取得または保存しない。 | animated、static、hidden、retry、offlineの各試験でmodel用HTTP request、filesystem picker、directory watcher、application dataへのmodel bytes書き込みが0件である。 | Draft | 非該当 |
| LIVE-F-009 | 同梱modelの16表情とmotionなしを固定inventoryとして検証する。 | build manifestのexpression IDが次の16件と完全一致し、motion groupとmotion fileが0件である。 | Draft | 非該当 |
| LIVE-F-010 | Live2Dとcreatorの配布noticeを含める。 | 3OS artifactにSDK version、copyright、適用EULA参照、creator表記、許諾確認IDがあり、S-004からoffline閲覧できる。 | Draft | 非該当 |
| LIVE-F-011 | Expandable Application機能をrelease gateで禁止する。 | LIVE-F-001、LIVE-F-005〜LIVE-F-008が合格し、任意modelを追加できない境界と適用契約の確認記録がある場合だけ公開候補にする。 | Draft | 非該当 |

#### 同梱expression inventory

| Expression ID | Expression ID | Expression ID | Expression ID |
|---|---|---|---|
| `BrowCheerfulFix` | `KirakiraEyesOn` | `BlushOn` | `BrowSadFix` |
| `PaleOn` | `EyeHighlightOff` | `HeartEyesOn` | `GuruguruEyesOn` |
| `EyeSizeChangeSmall` | `ZBodySwitch` | `TearsOn` | `AngryMarkOn` |
| `BackLightOn` | `XEyesOn` | `OEyesOn` | `BeretOff` |

### main Solのsemantic state

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| LIVE-F-012 | semantic stateを開いているworkspaceのmain Solだけから導出する。 | session IDとmain thread IDが現在値へ一致するeventだけを反映し、別workspace、thread、sessionでは表示を変えない。 | Draft | 非該当 |
| LIVE-F-013 | support roleの状態をcompanionへ反映しない。 | 7 roleそれぞれの`running`、`completed`、`failed`、`waiting` eventを単独発生させてもsemantic state、expression、mouth以外のparameterが変化せず、support avatarが作成されない。 | Draft | 非該当 |
| LIVE-F-014 | semantic stateを9種類へ限定する。 | runtime state IDが`idle`、`planning`、`working`、`testing`、`waiting_for_user`、`succeeded`、`warning`、`failed`、`interrupted`のいずれかで、追加値を受け取るとLIVE-F-019へ縮退する。 | Draft | 非該当 |
| LIVE-F-015 | semantic stateとexpressionを固定表どおり対応させる。 | 9状態を1件ずつ発生させるE2Eで、現在expressionが次表のIDと一致し、表にないexpressionをUIまたはeventから選択できない。 | Draft | 非該当 |
| LIVE-F-016 | 同時main状態を固定優先順位で1件へ解決する。 | `interrupted > failed > waiting_for_user > warning > succeeded > testing > working > planning > idle`の先頭だけを表示し、同じfixtureを100回処理して一致する。 | Draft | 非該当 |
| LIVE-F-017 | state eventをsession、main thread、sequenceで相関する。 | 現在値より大きいmonotonic sequenceだけを適用し、重複または小さいsequenceを受け取っても現在state、terminal latch、expressionを変更しない。 | Draft | 非該当 |
| LIVE-F-018 | rapid state changeを最新状態へ集約する。 | 100 ms内の非terminal eventを最新1件にし、20 event/秒を5秒入力してerror 0件、最終eventから500 ms以内に表示を一致させる。質問待ち、失敗、中断は即時反映する。 | Draft | 非該当 |
| LIVE-F-019 | 不正semantic stateを`idle`へ縮退する。 | enum外、相関field欠落、負のsequenceでbase poseへ戻し、日英textと`LIVE_STATE_UNKNOWN`を表示して継続する。 | Draft | 非該当 |
| LIVE-F-020 | workspace切替時に切替先mainの最新状態を表示する。 | 2 workspaceを切り替えると250 ms以内に切替先の保存済みmain statusから再評価し、切替元のterminal latchとexpressionを引き継がない。 | Draft | 非該当 |
| LIVE-F-021 | main statusが未取得の初期状態を`idle`にする。 | 初回表示、session未選択、main thread開始前ではbase poseと`待機中`または英語訳を表示し、loadingをerrorとして扱わない。 | Draft | 非該当 |
| LIVE-F-022 | terminal stateを3秒後に`idle`へ戻す。 | 4 terminal stateを後続eventなしで3,000±100 ms保持し、高優先度またはactive stateは即時置換する。 | Draft | 非該当 |
| LIVE-F-023 | Live2D表示と同じsemantic stateをHTML textで常時表示する。 | animated、static、hidden、reduced motionの全状態でS-002のARIA statusに同じ日本語または英語のstate labelが1件あり、canvasだけを見なくても状態を識別できる。 | Draft | 非該当 |
| LIVE-F-024 | 1つのmain windowへcompanion canvasを1つだけ作成する。 | workspaceとsessionを3件作成して切り替えてもcanvas数が1、loaded compiled model数が1で、support role数とsession数に比例して増えない。 | Draft | 非該当 |

#### semantic state mapping

| State ID | mainからの観測条件 | Expression | 表示期間 |
|---|---|---|---|
| `idle` | running turnなし、質問待ちなし、terminal latchなし | base poseへreset | 次stateまで |
| `planning` | mainのplan作成・更新itemがactive | `EyeSizeChangeSmall` | item終了まで |
| `working` | main turnまたは非test tool itemがrunning | `BrowCheerfulFix` | state変更まで |
| `testing` | mainのtest・validation itemがrunning | `GuruguruEyesOn` | item終了まで |
| `waiting_for_user` | mainのAskUserQuestionが未解決 | `OEyesOn` | 回答または解決まで |
| `succeeded` | main turnがsuccessでcompleted | `KirakiraEyesOn` | 3秒 |
| `warning` | mainに継続可能なtool・protocol・I/O failureがある | `PaleOn` | 3秒 |
| `failed` | main turnがfailedまたは回復不能failure | `BrowSadFix` | 3秒 |
| `interrupted` | main turnがuser、緊急停止、Quit、sidecar切断でinterrupted | `XEyesOn` | 3秒 |

### animationとTTS lip-sync

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| LIVE-F-025 | modelへ適用するanimation入力を表情、blink、breath、position/scale、TTS mouth parameterへ限定する。 | renderer instrumentationで前記5分類以外のmotion start、random pose、camera、pointer追従、gaze、user parameter入力が0件である。 | Draft | 非該当 |
| LIVE-F-026 | expression切替時に前stateをresetして現在stateのexpressionを1件だけ適用する。 | 9状態の全遷移72組で前expressionの加算状態が残らず、現在stateに対応するexpressionまたはbase poseだけが有効になる。 | Draft | 非該当 |
| LIVE-F-027 | animated表示中にblinkとbreathをmodel parameterで生成する。 | `EyeBlink` groupの左右eye parameterと`ParamBreath`だけがidle loopで時間変化し、60秒試験で左右blinkが1回以上、breath cycleが3〜15回、値がmodel定義範囲内になる。 | Draft | 非該当 |
| LIVE-F-028 | positionとscaleをcompanion領域へresponsiveにfitする。 | 800×600から3,840×2,160のwindow、100%・150%・200% scaleでmodel比率を維持し、headとbody中心がcompanion領域外へ出ず、resize完了から250 ms以内に最終transformへ到達する。 | Draft | 非該当 |
| LIVE-F-029 | TTS envelopeを`ParamMouthOpenY`へ同期する。 | 現在audioと一致する0.0〜1.0値を30 Hz以上で適用し、有声音で0より大きく、pause・終了から100 ms以内に0へ戻す。expressionは変えない。 | Draft | 非該当 |
| LIVE-F-030 | TTS音声がない場合はmouthを閉じたままにする。 | API key未設定、text-only、offline、TTS error、queue空、別workspace音声の各試験で`ParamMouthOpenY`が0となり、mic、system audio、推測波形を入力に使わない。 | Draft | 非該当 |
| LIVE-F-031 | reduced motionで非必須animationを停止する。 | 250 ms以内にblink、breath、transform、lip-syncを止め、expression、ARIA status、transcriptを保持する。 | Draft | 非該当 |
| LIVE-F-032 | window非表示中にrender loopを停止する。 | closeから2秒以内にframe・drawを0件/秒にし、最新stateだけを保持する。再表示から500 ms以内に描画し、Codex・TTSは継続する。 | Draft | 非該当 |
| LIVE-F-033 | 明示Quitでrenderer resourceを解放する。 | Quit時にanimation frame、WebGL texture、buffer、context listenerを破棄し、プロセス終了まで新しいdraw、asset load、retryを開始しない。 | Draft | 非該当 |
| LIVE-F-034 | expressionとanimationの一時状態を永続化しない。 | SQLite、Web Storage、設定fileにexpression ID、mouth envelope、blink phase、breath phase、transform frameが保存されず、再起動時はLIVE-F-021から再評価する。 | Draft | 非該当 |

### 描画縮退と復旧

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| LIVE-F-035 | 表示をanimated、static、hiddenの3段階で縮退する。 | modelとWebGLが有効ならanimated、animated不能かつpreview有効ならstatic、previewも無効ならhiddenとなり、全段階でLIVE-F-023のtext statusが表示される。 | Draft | 非該当 |
| LIVE-F-036 | asset欠落・破損でstaticへ縮退する。 | 各resource欠落、hash不一致、JSON失敗で外部探索せず`LIVE_ASSET_INVALID`を表示し、有効previewがあればstaticにする。 | Draft | 非該当 |
| LIVE-F-037 | state対応expressionがruntimeで利用不能ならbase poseへ縮退する。 | mapping対象expressionを1件読取不能にするとmodel全体を停止せずbase poseとtext stateを表示し、expression IDを含む`LIVE_EXPRESSION_UNAVAILABLE`をS-004へ1件記録する。 | Draft | 非該当 |
| LIVE-F-038 | WebGLを作成できない場合はstatic表示へ縮退する。 | WebGL無効、context作成失敗、shader compile失敗、texture上限不足の各fixtureでrendererがdrawを開始せず、previewが有効ならstaticと`LIVE_WEBGL_UNAVAILABLE`を表示する。 | Draft | 非該当 |
| LIVE-F-039 | context lossから1回だけ自動復旧する。 | lossでdrawを止めてstaticへ移り、5秒以内にmanifest検証と初期化を1回行う。失敗・2回目では自動再試行しない。 | Draft | 非該当 |
| LIVE-F-040 | S-004からrendererを明示再試行できる。 | static・hidden時だけ有効で、1操作につきasset検証と初期化を各1回行う。失敗時も外部取得・model交換しない。 | Draft | 非該当 |
| LIVE-F-041 | renderer障害をCodex sessionから分離する。 | asset、WebGL、expression、animation frameのuncaught errorを発生させてもmain/support turn、TTS text、prompt draftが停止せず、回復不能通知は共通仕様の条件を満たす場合だけ送る。 | Draft | 非該当 |

### 性能と3OS検証

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| LIVE-F-042 | high-DPI描画のbacking storeを制限する。 | device pixel ratioを1.0〜4.0で変化させてもrender DPRを最大2.0、canvas一辺を最大4,096 pxへclampし、CSS表示寸法とpointer非入力のlayoutが変化しない。 | Draft | 非該当 |
| LIVE-F-043 | macOS実機でsemantic stateを250 ms以内に描画する。 | macOS 13以降のApple Silicon実機でevent受信からexpressionとARIA status更新までp95 250 ms以内、60秒のvisible idleで平均28〜30 fps、1秒区間の最小20 fps以上となる。 | Draft | 非該当 |
| LIVE-F-044 | macOS実機でrenderer CPU利用を制限する。 | 8 CPU core・16 GB RAMのApple Siliconでvisible idle 60秒の平均が1 logical coreの20%以下、TTS lip-sync中が35%以下、window非表示2秒後が1%以下となる。 | Draft | 非該当 |
| LIVE-F-045 | macOS実機でrenderer memoryを制限する。 | 1体を10分表示したrenderer有効時のprocess RSS増分が非表示baseline比512 MiB以下で、2分時点から10分時点の増加が32 MiB以下となる。 | Draft | 非該当 |
| LIVE-F-046 | macOS artifactで主要導線を実機E2E検証する。 | `.dmg`から起動し、16 expression inventory、9 state mapping、TTS mouth、TTSなし、reduced motion、resize/DPI、context loss、asset破損、static・hidden縮退、Quitを全件実行したevidenceがある。 | Draft | 非該当 |
| LIVE-F-047 | Windows 11 x64をCI検証しpreview表示する。 | `.msi`とmanifest、mapping、path、no-import、fallback、reduced motion testが合格し、README・S-004に実機未検証と表示する。 | Draft | 非該当 |
| LIVE-F-048 | Ubuntu 24.04 x64 artifactをCI build/testしpreview表示する。 | `.AppImage`を生成し、LIVE-F-047と同じautomated testが合格する。READMEとS-004にLive2D/Tauri WebView実機未検証のpreview表示がある。 | Draft | 非該当 |
| LIVE-F-049 | release artifactごとにmodel拡張入口が0件であることを検査する。 | macOS、Windows、UbuntuのartifactへLIVE-F-005〜LIVE-F-008のUI、handler、API、network、watcher検査を行い、1件でも検出したartifactをrelease候補にしない。 | Draft | 非該当 |

### privacy、offline、多言語

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| LIVE-F-050 | model dataとstateを外部送信しない。 | network traceでSDK、model、expression、state、WebGL診断を送るHTTP、WebSocket、telemetryが0件で、TTS通信を別actorと識別できる。 | Draft | 非該当 |
| LIVE-F-051 | 診断logから秘密とpathを除外する。 | error、tier、expression、WebGL分類、UTCだけを記録し、model、texture、絶対path、workspace、会話、key、tokenが0件となる。 | Draft | 非該当 |
| LIVE-F-052 | offlineでも同梱modelとtext statusを表示する。 | networkを遮断して起動してもlocal assetだけでanimatedまたは定義済み縮退を表示し、network再接続を要求しない。TTS不能時はLIVE-F-030を適用する。 | Draft | 非該当 |
| LIVE-F-053 | Live2D関連UIを日本語と英語で提供する。 | state label、static・hidden理由、retry、preview表示、license、error guidanceが両localeにあり、state ID、expression ID、error code、SDK versionは翻訳しない。 | Draft | 非該当 |
| LIVE-F-054 | companionを補助的な視覚表現として扱う。 | canvasとstatic previewをaccessibility treeから除外し、ARIA status、診断、retryをkeyboardとscreen readerで利用でき、色または表情だけを状態の唯一の伝達手段にしない。 | Draft | 非該当 |

## 入力項目要件

ユーザーがmodel、expression、motion、parameter、path、URLを入力するformは提供しない。runtime adapterが扱う内部入力だけを次に定義する。

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| semantic state | session ID / main thread ID | 現在選択値 | 必須 | 現在開いているworkspaceと完全一致 | eventを破棄し現在表示を維持する |
| semantic state | sequence | 0 | 必須 | 0以上のmonotonic integer | LIVE-F-017どおり重複・古い値を破棄する |
| semantic state | state ID | `idle` | 必須 | LIVE-F-014の9値 | LIVE-F-019へ縮退する |
| TTS | audio request ID | なし | 条件付き | 現在workspaceの再生中requestと一致 | mouth値を0にする |
| TTS | envelope | 0.0 | 条件付き | finite number、0.0〜1.0、30 Hz以上 | clamp不能値を破棄してmouth値を0にする |
| viewport | CSS width / height | container寸法 | 必須 | 各1〜8,192 px | 直前のvalid layoutを維持する |
| viewport | device pixel ratio | OS値 | 必須 | finite number、0.5〜4.0、render時はLIVE-F-042でclamp | 1.0として描画する |
| renderer retry | 明示操作 | 未実行 | 任意 | staticまたはhidden時だけ実行可能 | 縮退を維持してerror codeを表示する |

## デスクトップ固有要件

[デスクトップ共通仕様](../../screen-design/desktop-common-specification.md)との差分だけを次に定義する。

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | macOS 13+ Apple Siliconだけを実機保証し、Windows 11 x64とUbuntu 24.04 x64はCI検証済みpreview artifactと表示する。 | LIVE-F-043〜LIVE-F-049 |
| ウィンドウ生成・再利用 | 共通`main`内のcompanion canvasを1つだけ再利用し、workspace、session、supportごとのwindow、WebView、canvasを作らない。 | LIVE-F-012、LIVE-F-024 |
| 閉じる・アプリ終了 | closeではrendererだけをsuspendしCodex/TTSを継続する。Quitではrenderer resourceを解放する。 | LIVE-F-032、LIVE-F-033 |
| 未保存データ | 非該当: model編集を提供せず、一時expressionとanimation phaseを保存しない。 | LIVE-F-034 |
| ローカルデータ | bundle manifestをasset正本とし、SQLiteへmodel bytes、path、animation stateを保存しない。診断eventだけを共通形式で保存する。 | LIVE-F-003、LIVE-F-004、LIVE-F-034、LIVE-F-051 |
| オフライン | 同梱assetとtext statusを利用でき、TTS不能時はmouthを閉じる。再接続によるmodel同期は存在しない。 | LIVE-F-030、LIVE-F-050、LIVE-F-052 |
| ファイル・OS操作 | runtimeのfile選択、保存、watchを提供しない。build pipelineだけが固定resourceを複製する。 | LIVE-F-002、LIVE-F-005〜LIVE-F-008 |
| メニュー・ショートカット | Live2D固有menuとglobal shortcutを追加しない。retryとlicense閲覧はS-004から行う。 | LIVE-F-010、LIVE-F-040 |
| Deep Link・ファイル関連付け | 非該当: modelまたはstateを受け取るschemeとassociationを登録しない。 | LIVE-F-006 |
| 通知 | Live2D state、expression、縮退ではOS通知を送らない。回復不能失敗だけ共通仕様の通知を利用する。 | LIVE-F-041 |
| Capability・認可 | WebViewへ任意path、URL、model bytesを渡すCommandを公開せず、bundle resourceとfixed retryだけを許可する。 | LIVE-F-004〜LIVE-F-008、LIVE-F-040 |
| アップデート・互換性 | 更新artifactごとにmanifest、SDK version、notice、expression mappingを再検証し、旧modelまたはユーザーmodelのmigrationを実装しない。 | LIVE-F-003、LIVE-F-009〜LIVE-F-011、LIVE-F-049 |

## 画面・UI

画面レイアウト、表示状態、操作フローは各画面詳細仕様を正本とし、この文書では画面IDと要件IDの対応だけを管理する。

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-002` | コーディングワークスペース | LIVE-F-012〜LIVE-F-035、LIVE-F-037〜LIVE-F-043、LIVE-F-050、LIVE-F-052〜LIVE-F-054 | 新規 | [S-002 コーディングワークスペース](../../screen-design/S-002_coding-workspace.md) |
| `S-004` | 設定・診断 | LIVE-F-001〜LIVE-F-011、LIVE-F-036〜LIVE-F-041、LIVE-F-043〜LIVE-F-049、LIVE-F-051、LIVE-F-053、LIVE-F-054 | 新規 | [S-004 設定・診断](../../screen-design/S-004_settings-diagnostics.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | decode前にmanifest、hash、bundle containmentを検証し、外部入力を拒否する。 |
| 権限 | 固定resource描画だけを行い、camera、mic、任意filesystem、network、shell権限を追加しない。 |
| プライバシー | model、state、WebGL情報を外部送信せず、TTS通信と分離する。 |
| 監査・ログ | manifest、SDK、notice、tier、error、OS水準を記録し、生data、path、会話、秘密を除外する。 |
| 性能 | p95 250 ms、平均28〜30 fps、idle CPU 20%以下、hidden 1%以下、RSS増分512 MiB以下。 |
| 信頼性・復旧 | asset・WebGL障害を縮退し、自動context復旧は1回、以後は明示retryだけとする。 |
| アクセシビリティ | canvasを装飾扱いにし、状態・障害・操作をtext、keyboard、screen readerで提供する。 |
| 多言語・地域 | 日本語と英語を提供し、canonical IDとversionは翻訳しない。 |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| 許諾済み同梱model | creatorの再配布許諾がある1体、16 expression、motionなしをbuild sourceとする。 | 解決済み | manifestを生成できずrelease不可 |
| Live2D Cubism SDK for Web | runtime CDNを使わず、buildでversionとintegrityを固定し、適用契約とnoticeをrelease evidenceへ記録する。 | release gate | version、契約、noticeを確定できなければartifact公開不可 |
| WebGL / Tauri WebView | macOS実機だけを保証対象とし、Windows・Ubuntuは公式platform情報を参照したpreviewとする。 | OS別検証 | WebGL不能時はstaticまたはhiddenへ縮退 |
| [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) | 3OS artifact、単一window、close、Quit、通知、reduced motion、text fallbackを提供する。 | 解決済み | 共通lifecycleとOS表示を検証できない |
| [codex-main-session要件](../codex-main-session/requirements.md) | main thread、turn、item、AskUserQuestion、interruptの相関済み状態を提供する。 | Draft | LIVE-F-012〜LIVE-F-023を導出できない |
| [support-agent-orchestration要件](../support-agent-orchestration/requirements.md) | support roleをmainとは別主体として識別する。 | Draft | LIVE-F-013の分離を検証できない |
| [audio-commentary要件](../audio-commentary/requirements.md) | TTS audio request ID、再生状態、envelope、text fallbackを提供する。 | Draft | LIVE-F-029、LIVE-F-030はmouth closedへ縮退 |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| なし | 同梱モデル1体、固定mapping、no motion、no import、3段階縮退で実装する | 仕様責任者レビューで適用Live2D契約のrelease evidenceとS-002・S-004の相互参照を確認する | いいえ |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [要件定義基準](../../rules/requirements-definition-standards.md) | 1挙動1ID、受け入れ条件、desktop境界、異常系の記述基準 |
| [ID管理ルール](../../rules/id-management-rules.md) | `LIVE` Prefix、要件ID、画面IDの正本 |
| [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) | 3OS、window lifecycle、通知、reduced motion、text fallbackの共通契約 |
| [Live2D Cubism SDK License](https://www.live2d.com/en/sdk/license/) | SDK利用と配布時に確認する公式license案内 |
| [Live2D Expandable Application](https://www.live2d.com/en/sdk/license/expandable/) | ユーザーが任意modelを追加できる機能を本製品へ含めない根拠 |
| [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) | Cubism Coreを含むproprietary componentの適用条件確認 |
| [Live2D Open Software License Agreement](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html) | Cubism Componentsのopen software条件とnotice確認 |
| [Live2D Cubism SDK supported platforms](https://docs.live2d.com/en/cubism-sdk-manual/platform/) | OS、browser、SDKの公式support情報とTauri WebView実機保証を区別する根拠 |

外部資料は2026-07-16に確認した。本文は製品境界の要約であり、配布時はリンク先の現行契約とprojectの利用形態をrelease ownerが確認する。

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Not Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 未合意 |
| 残る非ブロック論点 | 適用Live2D契約のrelease evidence、S-002・S-004からの逆参照、仕様責任者合意 |

## 着手可チェック

- [x] 背景と目的が説明できる。
- [x] スコープ内・外と理由が明確である。
- [x] 全機能要件に一意な要件IDがある。
- [x] 全機能要件に検証可能な受け入れ条件がある。
- [x] 正常系、異常系、キャンセル、権限差分、空状態、境界値を確認した。
- [x] デスクトップ固有要件を確認し、非該当も明記した。
- [ ] 画面IDと要件IDの相互参照が一致している。
- [x] 非機能要件と依存関係を確認した。
- [x] 着手ブロックが「はい」または「不明」の未確定事項がない。
- [ ] 仕様責任者がレビューし、合意した。
