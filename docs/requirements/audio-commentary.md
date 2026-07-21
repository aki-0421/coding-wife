---
title: "NARR 音声実況要件定義"
description: "意味あるイベントの字幕優先実況、OpenAI TTS、provider credential、mute、rate limit、privacy、fallbackを定義する。"
updated: 2026-07-20
read_when:
  - "narration policy、TTS、mute、captionを実装するとき。"
  - "active workspace分離、stale破棄、local process境界を検証するとき。"
---

# 音声実況 要件定義

| 項目           | 内容               |
| -------------- | ------------------ |
| Prefix         | `NARR`             |
| 状態           | Approved           |
| 仕様責任者     | プロダクトオーナー |
| 作成日         | 2026-07-18         |
| 最終レビュー日 | 2026-07-21         |

## 背景

利用者が別作業をしている間も、入力待ちや失敗を短い字幕で知れると状況把握負担が下がる。commit説明は、App Serverが報告したGit commit成功とnative observerの成功SHAが一致した時点で、main sessionとは独立したbackground support runtimeが自動準備する。ただし、commit検知だけでは字幕も音声も開始せず、利用者がそのcommitの「詳しく教えて」を選んだ時だけapp-owned presentation controllerが説明をcharacter captionへstreamする。音声を希望する場合だけ同じ確定chunkを同順で読み上げれば、視覚・聴覚のどちらでも追える。main sessionのassistant/sub-agent出力を説明sourceにしたり、説明本文をmain conversation/historyへ混入させたりしてはならない。MVPのTTS providerはOpenAI APIだけとし、native境界が保存済みAPI keyで`/v1/audio/speech`を呼び出す。captionはnetworkと音声に依存しない正本として維持する。

## 目的

| 目的                     | 達成したと判断できる状態                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 意味ある状態だけを伝える | active workspaceの入力待ち、失敗と、明示的にpresentationを開始したcommit説明だけを字幕として表示する。commit検知だけでは表示・発話しない       |
| 音声を完全に任意にする   | TTSはdefault offで、API key未設定、mute、offline、provider failureでも字幕と操作が残る                                                         |
| privacyと鮮度を守る      | bounded redacted transcriptだけを固定OpenAI Speech endpointへ送り、API keyをWebView/logへ返さず、stale/old workspace audioを再生しない          |

## スコープ

### 含める

| 対象                | 内容                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Narration policy    | meaningful event、priority、rate limit、queue、stale generation                                                       |
| Transcript          | ja/en textをaudioより先に表示、caption/live region                                                                    |
| TTS                 | OpenAI Speech API、provider/API key、model/voice/speed allowlist、bounded request/playback、text fallback             |
| Playback            | active workspaceだけ、mute即時、unmute後の新規発話だけ                                                                |
| Commit presentation | 成功SHAに結び付いたbackground support streamをapp-owned controllerで保留し、「詳しく教えて」後だけ字幕・任意TTSへ適用 |
| Privacy             | redacted textだけを固定provider endpointへ送り、credentialをnativeだけに保持し、一時audioを再生後に削除する            |

### 含めない

| 非対象                      | 理由                                    | 扱う機能・文書                          |
| --------------------------- | --------------------------------------- | --------------------------------------- |
| microphone / speech input   | privacyとscopeを限定する                | text composer                           |
| always-on voice             | quiet-by-default原則                    | event-driven narration                  |
| audio archive/export        | transcriptを正本とする                  | [Activity history](activity-history.md) |
| character voice cloning     | 権利・同意・安全範囲を増やさない        | 非対象                                  |
| system-wide daemon / hotkey | app内active workspace processへ限定する | 非対象                                  |

## アクターと権限

| アクター                          | 説明                                                                                            | 許可する操作                                                                  | 拒否時の動作                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ローカル利用者                    | TTS設定と再生を管理                                                                             | provider credential、enable、model、voice、speed、Companion mute、test、disable | provider/network/player失敗時も字幕を維持する                                    |
| Narration policy                  | validated eventから短文を選ぶ                                                                   | priority、rate limit、queue、generation判定                                    | stale、sequence不正、low-priority burstを破棄する                                 |
| App-owned presentation controller | background support streamをcommit key単位で受理し、visible captionとlocal TTSの適用順を所有する | activate、replay、sequence検証、cancel、workspace/commit/generation切替       | main session出力、未選択commit、stale/gap/duplicate chunkを適用しない             |
| Background support runtime        | App Serverのcommit成功とnative observerの成功SHA一致後に、main sessionと独立して説明を準備する  | versioned redacted chunkをapp-owned channelへ送る                             | Git検知だけでcaption/TTSを直接開始せず、main conversation/historyへ本文を送らない |
| OpenAI TTS adapter                | native owner-only secretと固定`https://api.openai.com/v1/audio/speech`を所有する境界              | 明示enable中のbounded text、allowlist model/voice、validated speedだけを送る  | key未設定、HTTP/TLS/status/size検証失敗時は再生せずcaptionを維持する              |
| Audio player                      | active workspaceの一時audioと固定system player process groupを管理する                            | single playback、interrupt、mute、終了時削除                                  | workspace切替・mute・stop・closeで100ms以内に停止し一時audioを削除する             |

## 機能要件

### Transcriptとevent policy

| 要件ID       | 要件                                        | 受け入れ条件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 状態     | 廃止理由・後継ID |
| ------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| `NARR-F-057` | appは意味あるeventから短いtranscriptを作る  | waiting_for_userと利用者対応可能なerrorで1〜240文字のja/en transcriptを生成し、通常tool row、commit_observed、App Server disconnectedでは生成しない。App Server connection状態はcaption、live region、TTSへ投影せず、commit説明は`NARR-F-079`の確定chunkを使う                                                                                                                                                                                                                                                                                                                              | Approved | 非該当           |
| `NARR-F-058` | transcriptはaudioより先に表示される         | narration event受理から300ms以内にactive viewportのHTML captionへtextをcommitし、発話対象の各chunk自身またはTest voice sample自身がlayout後のpaint境界を通過し、windowと内側scroll viewportの両方で全体がvisibleかつfrontmost hit targetであることをackした時点から100ms以上表示した後にだけTTS requestを開始する。各chunkのack deadlineは追加chunkで延長しない独立1秒とし、component未mount、hidden child、scroll外、部分clip、occlusion、ack timeoutでは発話せずcaption-onlyへterminal化する | Approved | 非該当           |
| `NARR-F-059` | narrationはactive workspaceだけへ適用される | workspace B選択中にAのeventが届いてもBのcaption/Live2D/audioへ表示・再生せず、Aのtimeline metadataへ記録する                                                                                                                                                                                                                                                                                                                                                                                         | Approved | 非該当           |
| `NARR-F-060` | stale narrationを破棄する                   | transcript generationがactive workspace generationと一致しない場合、TTS processとplaybackを開始しない。同一workspaceのscope generationはfrontend/nativeで単調増加させ、currentより小さい値をgateway適用前とnative policy適用前の双方で安定したerror codeにより拒否する。別workspaceのgenerationは独立に扱う                                                                                                                                                                                          | Approved | 非該当           |
| `NARR-F-061` | duplicate narrationを抑制する               | 同一文面の明示的な再読上げを妨げるため、この時間窓による抑制は使用しない                                                                                                                                                                                                                                                                                                                                                                                                                              | Deprecated | `NARR-F-091`へ置換 |
| `NARR-F-062` | narrationは発話頻度を制限する               | 発話開始間隔を8秒以上、1分あたり6件以下にし、超過したlow-priority eventをまとめて1件のsummaryにする                                                                                                                                                                                                                                                                                                                                                                                                  | Approved | 非該当           |
| `NARR-F-063` | high-priority eventは低優先音声を中断できる | waiting_for_user/errorがplaying中のprogress narrationを停止し、caption表示後500ms以内にhigh-priority requestをqueue先頭へ置く                                                                                                                                                                                                                                                                                                                                                                        | Approved | 非該当           |
| `NARR-F-091` | 同一文面のnarrationを繰り返し再生できる     | 有効なscopeとsequenceを持つ同じsemantic type・同じtextのrequestを続けて送った場合も各requestを個別にqueueへ追加し、`NARRATION-DUPLICATE`または`dropped_duplicate`を返さない。queue上限、rate limit、stale generation、request内sequence検証は引き続き適用する                                                                                                                                                                                                                                                | Approved | 非該当           |

### TTS設定・再生・fallback

| 要件ID       | 要件                                   | 受け入れ条件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 状態     | 廃止理由・後継ID |
| ------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| `NARR-F-064` | TTSは初回に無効である                  | fresh profileではTTS toggleがoffで、provider未選択、API key未設定、network request、audio fileが0件になる。Audio設定画面には全設定を初期化するreset操作を表示しない                                                                                                                                                                                                                                                                                                                                                                      | Approved | 非該当           |
| `NARR-F-065` | TTSは設定済みproviderだけを利用する     | provider selectはcredential設定済み候補だけを表示し、0件ではdisabledにする。MVPの候補はOpenAIだけで、API key未設定時はTTS toggleをdisabledにし、nativeは固定Speech endpoint以外へcredentialやtranscriptを送らない                                                                                                                                                                                                                                                                                                                       | Approved | 非該当           |
| `NARR-F-066` | 利用者はmodel、voice、speedをpreviewできる | provider、API key、allowlist model/voice選択後に固定sample captionをmountし、sample自身のvisible ackと100ms lead後だけrequest/replayする。speedは0.75〜1.25を0.05刻みとする。Test voiceのnative provider取得・再生は通常音声と同じ45秒以内でterminal化し、frontendはnative terminalの反映余裕を含む50秒だけ監視する。caption未mount/hidden/ack timeout、cancel、network/playback timeout時も設定入力を保持する                                                                                                                                                                                                                                                                      | Approved | 非該当           |
| `NARR-F-067` | provider失敗はtext fallbackになる      | API key未設定/拒否、offline、TLS/timeout、HTTP error、response size/format不正、player missing/tampered/spawn/exit error、audio deviceなし、Test voice timeoutの各場合にaudio unavailableを即時terminal表示し、nativeのsanitized `lastErrorCode`、caption、main turnを維持する。native runtimeまたはspeak responseが`unavailable`になった時はfrontend timeoutまでpollせず、native active/queued playbackをcancelして既存speech chainを全無効化し、terminal status/errorを後続のidleで上書きしない | Approved | 非該当           |
| `NARR-F-068` | muteは現在の音声を即時停止する         | mute操作後100ms以内にactive process groupを終了し、queueをclearし、captionを消去しない                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Approved | 非該当           |
| `NARR-F-069` | unmuteは過去音声を再生しない           | mute中に発生したeventをunmute後に再生せず、unmute後の次eventからだけqueueへ追加する                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Approved | 非該当           |
| `NARR-F-070` | workspace切替とapp終了は再生を停止する | workspace switch、turn stop、app closeの各操作後100ms以内にactive process groupとqueueを停止し、旧workspace audioが再開しない                                                                                                                                                                                                                                                                                                                                                                                                          | Approved | 非該当           |
| `NARR-F-071` | queueは古い音声を蓄積しない            | waiting/queued合計を3件以下にし、4件目追加時は最古のlow-priority項目を破棄してmetadataを記録する                                                                                                                                                                                                                                                                                                                                                                                                                                       | Approved | 非該当           |

### Privacy・accessibility・言語

| 要件ID       | 要件                                               | 受け入れ条件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 状態     | 廃止理由・後継ID |
| ------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| `NARR-F-072` | providerへredacted transcriptだけを渡す            | scalar count 1〜240、NULなしで、root directory名を列挙しない任意のPOSIX absolute path（`/root/x`、`/workspace/x`、`/System/x`を含み、括弧・引用符・`=`・`:`・全角句読点直後も対象）、Bearer token、GitHub token、AWS access/secret/session key、Slack token、PEM private key、cookie/session/password/token/key assignmentを検出したtextをfrontend/nativeの同一fixture集合でrejectする。relative source pathと検証済みURLはpath判定だけでrejectしない。検査済みtext、allowlist model/voice、validated speedだけを固定OpenAI endpointへ送り、private path、raw evidence、API keyを本文・logへ混入させない | Approved | 非該当           |
| `NARR-F-073` | generated audioを永続化しない                      | response audioはowner-only temporary fileへboundedに保存し、固定player終了・cancel・error・app closeで削除する。app DB、history、artifact、diagnostic、logへaudio byteやtemporary pathを残さない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Approved | 非該当           |
| `NARR-F-074` | narrationは音声なしでも理解できる                  | TTS off、mute、screen reader、audio deviceなしの各状態で同じtranscript、priority icon、workspaceを確認できる                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Approved | 非該当           |
| `NARR-F-075` | appはprovider対応voiceをallowlist表示する          | `gpt-4o-mini-tts`で利用可能な組み込みvoiceをapp releaseで固定し、ja/enのどちらでも同じ候補を表示する。保存voiceが発話直前のmodel別allowlistへ完全一致しなければTTSをdisabledにしてtext fallbackを使う                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Approved | 非該当           |
| `NARR-F-076` | narrationのnetworkとcredentialをnativeへ限定する   | WebViewはAPI key平文、Authorization header、audio bytesを受け取らず、nativeだけが固定OpenAI endpointへBearer requestを行う。microphone capability/requestは0件とする                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Approved | 非該当           |
| `NARR-F-077` | 利用者はTTS testをcancelできる                     | test playbackまたは起動待ち中にCancelすると100ms以内にprocess groupを停止し、保存済み設定を変更しない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Approved | 非該当           |

### Commit explanation caption

| 要件ID       | 要件                                                              | 受け入れ条件                                                                                                                                                                                                                                                                                                                                                                                                                       | 状態     | 廃止理由・後継ID |
| ------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| `NARR-F-078` | commit説明は成功SHA一致後に独立background runtimeで自動準備される | App Serverが報告したGit commit成功SHAとnative observerが確認したexact SHAが一致した時だけ、そのcommit keyのbackground support generationを自動開始する。main sessionのassistant/sub-agent outputから説明streamを生成・転送しない                                                                                                                                                                                                   | Approved | 非該当           |
| `NARR-F-079` | active presentationの確定chunkをcharacter captionへstreamする     | 利用者が対象commitの「詳しく教えて」または再表示を1回選んだ後だけ、そのselection version、commit evidence ID、support request ID、presentation intent epochへ束縛したredaction/schema検査済みdeltaをsequence順に1chunkずつvisible captionへ表示する。未生成、生成中、生成済みcacheのいずれも同じ1回の明示操作をpresent-on-complete intentとして保持し、追加clickを要求しない。Commit画面から開始した時はtab遷移を要求せず、同じactive viewportの共通caption層へ300ms以内にmountし、windowと内側scroll viewportの双方で全体をvisibleかつfrontmostにする。Live2D canvasだけへ描画しない | Approved | 非該当           |
| `NARR-F-080` | TTS無効・失敗時もcaptionを維持する                                | TTS off、mute、binary/voice unavailable、process error、audio deviceなしの各状態で説明captionを全件表示し、説明request自体を失敗扱いにしない                                                                                                                                                                                                                                                                                       | Approved | 非該当           |
| `NARR-F-081` | TTSはactive captionと同じchunkだけを読む                          | TTS enabledかつunmutedで、同一commit key・同一text・同一sequenceの`li[data-narration-sequence]`自身がwindow/scroll viewport内で完全visibleかつfrontmostとackされた時だけnative OpenAI adapterへ渡し、音声用の追加要約・言い換え・evidence再送を0件にする                                                                                                                                                                              | Approved | 非該当           |
| `NARR-F-082` | commit検知だけではpresentationを開始しない                        | `auto_verified_commit`のbackground生成がstarted/streaming/completedになってもnative presentation event、caption、live region、presentation activation、TTSを0件にする。利用者の明示intentがないstate/event/responseは、生成済みcacheとexact一致してもpresentationへ昇格しない                                                                                                                                                          | Approved | 非該当           |
| `NARR-F-083` | 「詳しく教えて」は生成中と生成済みの両方を1回で表示できる         | `user_request` / `user_retry`の1回の操作をpresent-on-complete intentとして、未生成job、既存の自動queued/runningへのdedupe合流、generated cache hitへ再束縛する。生成中なら受理済みchunkと後続を、生成済みなら保存順の全chunkを追加clickなしで決定的に提示し、TTSはactivate後に未読sequenceだけを読む                                                                                                                                | Approved | 非該当           |
| `NARR-F-084` | app-owned controllerだけが字幕・音声をcommit key単位で適用する    | `workspaceId + workspaceGeneration + full commit SHA + support request ID + selection version + presentation intent epoch + locale`が現在の明示intentと完全一致するversioned envelopeだけを、native event/responseのpublishとactivationの直前に再検査して受理する。main session event、React componentへの任意text、別channelからcaption/TTSへ直接書き込めない                                                                                                                               | Approved | 非該当           |
| `NARR-F-085` | selection変更は字幕・音声を同じgenerationで停止する               | 別commit選択、workspace切替、locale変更、stale workspace generation、main Stopの各場合にpresentation intent epochとpresentation generationを同期的に進め、旧keyのcaption/live regionをdismissedとして閉じ、active/queued speechを100ms以内に停止して旧intent宛の後着event/response/chunkを表示・発話しない。これらの操作はpresentationだけをrevokeし、background jobとgenerated/prepared cacheをcancel・削除するsupport cancelとは区別する                                                                                      | Approved | 非該当           |
| `NARR-F-086` | commit説明本文をmain conversation/historyへ混入させない           | background support input/output、caption chunk、TTS transcriptをmain sessionのconversation item、assistant message、main timeline/history event本文へappendせず、app-owned volatile presentation stateとsanitized runtime metadataだけに限定する                                                                                                                                                                                   | Approved | 非該当           |
| `NARR-F-087` | stream破損はcaption-onlyの安全なterminalになる                    | schema/locale/commit key mismatch、sequence gap/duplicate、oversize/unsafe textを適用せず、active presentationをunavailableでterminal化し、TTSをcancelする。main coding sessionと既存commit evidenceは継続する                                                                                                                                                                                                                     | Approved | 非該当           |
| `NARR-F-088` | presentation dismissとsupport cancelを分離する                    | `Close explanation`とmain Stopはactive intent epoch、caption/live region、speechだけを100ms以内に停止し、prepared chunk cacheとbackground jobを維持する。dismiss前のnative event/responseが後着しても再表示せず、同じcommitを再度明示Showした新epochでだけcacheをsequence順に再提示する。queued/running中だけ表示する`Cancel explanation generation`はsupport jobをCanceledへterminal化し、明示Retryまで同requestを再提示しない                                                    | Approved | 非該当           |
| `NARR-F-089` | Audio設定の失敗復旧で入力とlocaleを維持する                       | settings取得済み状態でprovider/voice取得、自動保存、testが失敗してもinline safe error codeを表示し、最後の保存済み設定と保存待ちまたは失敗したAPI key/model/voice/speed入力を維持する。mute保存によるsettings version更新で入力を再初期化しない。Audio設定にはmute fieldとactive commit presentation statusを表示しない                                                                                                               | Approved | 非該当           |
| `NARR-F-090` | Audio設定は変更後に自動保存する                                   | enable/provider/model/voiceは変更直後、speedはsliderのvalue commit時、validなAPI keyは500ms入力が止まるかfieldをblurした時に、expected version付きnative updateを直列実行する。保存中は同じformの重複変更を無効にし、成功snapshotで入力とversionを再同期する。Audio設定にはSave、Discard、Resetのbuttonを表示しない。validationまたは保存失敗時は入力と最後の保存済みsnapshotを維持する                                                                                                 | Approved | 非該当           |

## 入力項目要件

| グループ     | 項目              | 初期値     | 必須                   | 制約・境界                                                                                       | エラー時                                    |
| ------------ | ----------------- | ---------- | ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Audio        | TTS enabled       | off        | 必須                   | boolean                                                                                          | 不正値はoff                                 |
| Audio        | provider          | なし       | 条件付き               | credential設定済みproviderだけ。MVPは`openai`                                                    | select無効、TTS off、caption維持             |
| Audio        | OpenAI API key     | なし       | 条件付き               | 1〜512文字、password input。native snapshotは`apiKeyConfigured`だけを返す                        | TTS無効、入力値維持                          |
| Audio        | model             | `gpt-4o-mini-tts` | 条件付き         | app allowlist内のOpenAI Speech model                                                             | TTS無効、caption維持                         |
| Audio        | voice             | `marin`    | 条件付き               | 選択modelのbuilt-in exact allowlist候補                                                          | TTS無効、caption維持                         |
| Audio        | speed             | 1.0        | 必須                   | 0.75〜1.25、0.05刻み                                                                              | 1.0へ戻し理由表示                            |
| Audio        | mute              | false      | 必須                   | boolean、workspace非依存global                                                                   | 不正値はmutedへfail closed                  |
| Presentation | active commit key | なし       | 「詳しく教えて」後だけ | workspace/generation/full SHA/request/presentation generation/localeの完全一致。永続設定ではない | presentationを停止しcaption/TTSへ適用しない |

## デスクトップ固有要件

| 領域                        | 要件                                                                                    | 対象要件ID                               |
| --------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| 対象OS・OS差分              | macOS 14以降のHTTPS/TLS、固定system audio player、system audio output                  | `NARR-F-065`, `NARR-F-068`               |
| ウィンドウ生成・再利用      | S-002のmuteとS-005アプリ設定を同一stateで再利用                                         | `NARR-F-068`, `NARR-F-069`               |
| 閉じる・アプリ終了          | process groupとqueueをbounded cancelしaudio fileを残さない                              | `NARR-F-070`, `NARR-F-073`               |
| 未保存データ                | validな変更は自動保存する。validationまたは保存失敗で残る入力はroute離脱時に破棄する     | `NARR-F-066`, `NARR-F-089`, `NARR-F-090` |
| ローカルデータ              | API keyを含むowner-only atomic settingsを保存し、公開snapshotは設定有無だけを返す        | `NARR-F-064`, `NARR-F-073`               |
| オフライン                  | TTSをUnavailableへterminal化しcaptionと設定入力を維持する                               | `NARR-F-067`                             |
| ファイル・OS操作            | owner-only request/audio temporary fileと固定playerを使い、全terminal pathで削除する     | `NARR-F-065`, `NARR-F-072`, `NARR-F-073` |
| メニュー・ショートカット    | mute buttonは27px visual、24px以上hit area、aria-pressed                                | `NARR-F-068`                             |
| Deep Link・ファイル関連付け | 非該当                                                                                  | 非該当                                   |
| 通知                        | caption/live regionを正本、音声は補助                                                   | `NARR-F-058`, `NARR-F-074`               |
| Capability・認可            | nativeだけが固定OpenAI endpointへ接続し、WebView network/microphone capabilityを増やさない | `NARR-F-064`, `NARR-F-072`, `NARR-F-076` |
| アップデート・互換性        | provider/model/voice allowlistとfixed player metadataをrelease/testで再検証              | `NARR-F-065`, `NARR-F-075`               |

## 画面・UI

| 画面ID  | 画面名                     | 対象要件ID                                                                         | 扱い | 画面詳細仕様                                                   |
| ------- | -------------------------- | ---------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------- |
| `S-002` | コーディングワークスペース | `NARR-F-057`〜`NARR-F-063`, `NARR-F-068`〜`NARR-F-075`, `NARR-F-078`〜`NARR-F-088`, `NARR-F-091` | 変更 | [画面詳細仕様](../screen-design/S-002_coding-workspace.md)     |
| `S-003` | セッション証拠             | `NARR-F-078`〜`NARR-F-088`                                                         | 変更 | [画面詳細仕様](../screen-design/S-003_session-evidence.md)     |
| `S-005` | アプリ設定・診断           | `NARR-F-058`, `NARR-F-064`〜`NARR-F-077`, `NARR-F-088`〜`NARR-F-090`               | 変更 | [画面詳細仕様](../screen-design/S-005_app-settings-diagnostics.md) |

## 非機能要件

| 領域             | 要件                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| セキュリティ     | fixed HTTPS endpoint、Bearer secret非返却、model/voice allowlist、validated speed、bounded response、root-owned/non-writable player再検証、shellなしを強制する                          |
| 権限             | native provider requestと固定audio outputだけ。WebView network/microphone capabilityを持たない                                                                                       |
| プライバシー     | default off、explicit presentation/enable、redacted transcriptだけをOpenAIへ送信、API key/audio非公開、main conversation/historyへ説明本文を非混入                                    |
| 監査・ログ       | opaque request/commit digest prefix、generation、priority、process status、latency、drop reasonだけを記録し、transcript本文/audio/support input/output/stdout/raw stderrを記録しない |
| 性能             | caption 300ms、mute/stop 100ms、native test timeout 45秒、frontend watchdog 50秒、queue 3件、発話間隔8秒                                                                             |
| 信頼性・復旧     | credential/network/provider/player/audio errorでcaption fallback、workspace switchで旧request/process停止                                                                           |
| アクセシビリティ | visible caption、polite/assertive live regionのpriority分離、aria-pressed、音声非依存                                                                                                |
| 多言語・地域     | ja/en transcriptとprovider voice、user content/pathは翻訳しない                                                                                                                      |

## 依存関係・前提

| 依存・前提         | 内容                                                                   | 状態                           | 未解決時の影響                                                    |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| SUP                | main sessionと独立したcommit-keyed background support stream           | 解決済み（typed contract）     | unavailable時はpresentation unavailable。main出力へfallbackしない |
| GIT                | App Serverのcommit成功SHA、native observerのexact SHA、selected commit | 解決済み（typed contract）     | SHA不一致・未確認時はbackground生成/presentation/TTSを開始しない  |
| LIVE               | lip-sync/operational state                                             | 解決済み（相互参照確認済み）   | renderer failureでもcaption/audio継続可能                         |
| HIST               | transcript/usage metadata、audio非保存                                 | 解決済み（相互参照確認済み）   | persistence failureでもplayback後audio削除                        |
| OpenAI Speech API | fixed endpoint、Bearer auth、`gpt-4o-mini-tts`、built-in voice、AI生成音声の明示 | 解決済み（optional remote境界） | unavailable時text fallback                                  |

## 未確定事項

| 論点                | 初期判断                                                                        | 確認事項                                     | 着手ブロック |
| ------------------- | ------------------------------------------------------------------------------- | -------------------------------------------- | ------------ |
| provider voice差分  | releaseでOpenAI built-in voice allowlistを固定し、default off                    | API更新時に公式docsとfixtureを再検証する     | いいえ       |
| lip-sync精度        | MVPはprocess playing中のsemantic speaking stateだけを連動し、失敗/停止時neutral | Hiyori実機QAで開始・停止遅延を確認する       | いいえ       |

## 実装・検証の入口

| 関心事                       | 実装場所                                                                                                                         | 変更時に守ること                                                                                                                                                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| native provider speech       | `src-tauri/src/narration/`                                                                                                       | fixed OpenAI endpoint、API key非返却、owner-only設定、bounded temporary audio、process group cancelをWebViewへ移さない                                                                                                                                                                     |
| native policy・queue         | `src-tauri/src/narration/policy.rs`、`service.rs`、`integration_tests.rs`                                                        | 同一semantic type・textでもrequestごとにqueueへ追加する。request内sequence、stale generation、rate limit、queue上限は独立した保護として維持し、時間窓によるtext dedupeや`NARRATION-DUPLICATE`を再導入しない                                                                                   |
| WebView contract・controller | `src/features/narration/contracts.ts`、`controller.ts`、`transport.ts`                                                           | `background_support`以外を受理せず、same-workspace scopeを巻き戻さず、未activate jobはcaption/TTSへ出さない。dismissとsupport cancelを分離し、sequence別ack deadline、terminal後のspeech chain無効化、native 45秒deadlineより長い50秒のplayback watchdogを維持してunsafe/late chunkを復活させない                       |
| private text parity          | `src/test/fixtures/narration-redaction.v1.json`、`src/features/narration/contracts.test.ts`、`src-tauri/src/narration/policy.rs` | path・token・credential rejectionと、HTTP(S)候補のvalid/invalid authority・host・port・userinfo判定をWebView/nativeの共有fixtureで一致させ、新しい境界caseは両境界のparity testとnative no-spawn testへ追加する                                                                           |
| Audio設定                    | `src/features/narration/components/NarrationSettings.tsx`、`src/features/workspace-view/SettingsView.tsx`                        | TTS toggleを先頭、設定済みprovider select、provider tabs、password API key、model/voiceの2カラム、0.05刻みのspeed sliderとTestの2カラム、default off、直列自動保存、Test sample自身のvisible ack + 100ms lead、保存失敗時の入力保持を検証する。Save、Discard、Reset、通常時のfield補助文、AI生成音声の静的callout、mute、active commit presentationは表示しない                                                                                                         |
| character caption・mute      | `src/features/narration/components/CommitNarrationCaption.tsx`、`CharacterStageSlot.tsx`、`ChatView.tsx`                         | accepted chunkを順番どおりvisible HTML/live regionへ出す。各sequence自身がactive windowと内側scroll viewport内の正の矩形かつ前面hit targetと確認できた時だけackし、100ms lead後に発話する。hidden/scroll外/partially clipped/occluded captionはackせず、840px以下でもmobile captionを残す |

`pnpm exec vitest run src/features/narration/**/*.test.ts src/features/narration/**/*.test.tsx src/features/workspace-view/CharacterStageSlot.narration.test.tsx --testTimeout=20000 --fileParallelism=false`を実行すると、strict envelope、IPC payload、default off、明示presentation、per-sequence window/scroll viewport paint ack + 100ms lead、independent ack deadline、same-text speech、mute、dismiss/replay、support cancel、multi-chunk native unavailable、monotonic scope、Test voice gate/50秒watchdog、voice retry、Audio自動保存、失敗時の入力保持、ja/en statusを検証できる。続けて`cargo test --manifest-path src-tauri/Cargo.toml narration -- --nocapture`を実行し、native policy、同一文面の個別queue/playback、sequence・stale・rate・queue境界、provider processを検証する。さらに`pnpm exec tsc --noEmit --pretty false`、`pnpm exec biome lint src/features/narration src/features/workspace-view/CharacterStageSlot.narration.test.tsx --error-on-warnings`を実行する。実ブラウザでは1470px、960px、480pxと200%相当幅で、captionの実幅、scroll-clipped child、mobile fallback、ja/en、reduced motion、Test voice、native failure、mute、Close→reopen、Cancel、settings error→Retryを確認する。

Commit画面から接続するときは、任意textをReact componentへ直接渡さず、`CommitNarrationConsumerPort`へversioned eventを流してから、current workspace scopeと完全一致する`CommitNarrationSourceKey`だけを`NarrationController.activatePresentation`へ渡す。generationを巻き戻してactivateしてはならない。

## 参照資料

| 資料                                                                      | 参照理由                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------ |
| [PRODUCT.md](../../PRODUCT.md)                                            | quiet-by-default、音声非依存                     |
| [DESIGN.md](../../DESIGN.md)                                              | mute control、Live2D state、motion               |
| [体験設計](../research/02-experience-design.md)                           | active workspaceとmeaningful narration           |
| [セキュリティ調査](../research/09-security-privacy.md)                    | process、redaction、least privilege              |
| [OpenAI Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech) | Speech endpoint、model、voice、AI生成音声の明示 |

## レビュー・合意

| 項目               | 内容                                                                          |
| ------------------ | ----------------------------------------------------------------------------- |
| レビュー結果       | Ready                                                                         |
| 仕様責任者         | プロダクトオーナー                                                            |
| 合意日             | 2026-07-20                                                                    |
| 残る非ブロック論点 | provider voice差分とsemantic speaking tuningはallowlist/fallback/default offで解決済み |

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
