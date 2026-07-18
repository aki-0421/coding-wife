---
title: "NARR 音声実況要件定義"
description: "意味あるイベントの字幕優先実況、任意TTS、mute、rate limit、privacy、fallbackを定義する。"
updated: 2026-07-18
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
| 最終レビュー日 | 2026-07-18         |

## 背景

利用者が別作業をしている間も、入力待ちや失敗を短い字幕で知れると状況把握負担が下がる。commit説明は、App Serverが報告したGit commit成功とnative observerの成功SHAが一致した時点で、main sessionとは独立したbackground support runtimeが自動準備する。ただし、commit検知だけでは字幕も音声も開始せず、利用者がそのcommitの「詳しく教えて」を選んだ時だけapp-owned presentation controllerが説明をcharacter captionへstreamする。音声を希望する場合だけ同じ確定chunkを同順で読み上げれば、視覚・聴覚のどちらでも追える。main sessionのassistant/sub-agent出力を説明sourceにしたり、説明本文をmain conversation/historyへ混入させたりしてはならない。MVPはmacOS同梱の`/usr/bin/say`だけをoptional local adapterとして使い、外部TTS provider、API key、音声fileを必要としない。

## 目的

| 目的                     | 達成したと判断できる状態                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 意味ある状態だけを伝える | active workspaceの入力待ち、失敗と、明示的にpresentationを開始したcommit説明だけを字幕として表示する。commit検知だけでは表示・発話しない       |
| 音声を完全に任意にする   | TTSはdefault offで、mute・offline・local adapter failureでも字幕と操作が残る                                                                   |
| privacyと鮮度を守る      | bounded redacted transcriptだけを検証済みlocal processのstdinへ渡し、network/secret/audio fileを0件にしてstale/old workspace audioを再生しない |

## スコープ

### 含める

| 対象                | 内容                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Narration policy    | meaningful event、priority、dedupe、rate limit、queue、stale generation                                               |
| Transcript          | ja/en textをaudioより先に表示、caption/live region                                                                    |
| TTS                 | macOS local `/usr/bin/say`、voice/rate、bounded process、text fallback                                                |
| Playback            | active workspaceだけ、mute即時、unmute後の新規発話だけ                                                                |
| Commit presentation | 成功SHAに結び付いたbackground support streamをapp-owned controllerで保留し、「詳しく教えて」後だけ字幕・任意TTSへ適用 |
| Privacy             | redacted textだけをstdinへ渡し、network、secret、audio fileを使用しない                                               |

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
| ローカル利用者                    | TTS設定と再生を管理                                                                             | enable、voice、rate、mute、test、disable、reset                               | binary/voice/audio device失敗時も字幕を維持する                                   |
| Narration policy                  | validated eventから短文を選ぶ                                                                   | priority、dedupe、queue、generation判定                                       | stale、duplicate、low-priority burstを破棄する                                    |
| App-owned presentation controller | background support streamをcommit key単位で受理し、visible captionとlocal TTSの適用順を所有する | activate、replay、sequence検証、cancel、workspace/commit/generation切替       | main session出力、未選択commit、stale/gap/duplicate chunkを適用しない             |
| Background support runtime        | App Serverのcommit成功とnative observerの成功SHA一致後に、main sessionと独立して説明を準備する  | versioned redacted chunkをapp-owned channelへ送る                             | Git検知だけでcaption/TTSを直接開始せず、main conversation/historyへ本文を送らない |
| Local TTS adapter                 | root所有かつ非writableと再検証した`/usr/bin/say`をshellなしで起動するnative境界                 | 明示enable中のbounded text、exact allowlist voice、validated rateだけを受ける | 検証失敗時はprocessを起動せずcaptionを維持する                                    |
| Audio player                      | active workspaceの`/usr/bin/say` process groupを管理する                                        | single playback、interrupt、mute                                              | workspace切替・mute・stop・closeで100ms以内に停止する                             |

## 機能要件

### Transcriptとevent policy

| 要件ID       | 要件                                        | 受け入れ条件                                                                                                                                                            | 状態     | 廃止理由・後継ID |
| ------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| `NARR-F-057` | appは意味あるeventから短いtranscriptを作る  | waiting_for_user、error、disconnectedで1〜240文字のja/en transcriptを生成し、通常tool rowやcommit_observedだけでは生成しない。commit説明は`NARR-F-079`の確定chunkを使う | Approved | 非該当           |
| `NARR-F-058` | transcriptはaudioより先に表示される         | narration event受理から300ms以内にactive viewportのHTML captionへtextをcommitし、発話対象の各chunk自身またはTest voice sample自身がlayout後のpaint境界を通過し、windowと内側scroll viewportの両方で全体がvisibleかつfrontmost hit targetであることをackした時点から100ms以上表示した後にだけlocal TTS processを開始する。各chunkのack deadlineは追加chunkで延長しない独立1秒とし、component未mount、hidden child、scroll外、部分clip、occlusion、ack timeoutでは発話せずcaption-onlyへterminal化する | Approved | 非該当           |
| `NARR-F-059` | narrationはactive workspaceだけへ適用される | workspace B選択中にAのeventが届いてもBのcaption/Live2D/audioへ表示・再生せず、Aのtimeline metadataへ記録する                                                            | Approved | 非該当           |
| `NARR-F-060` | stale narrationを破棄する                   | transcript generationがactive workspace generationと一致しない場合、TTS processとplaybackを開始しない。同一workspaceのscope generationはfrontend/nativeで単調増加させ、currentより小さい値をgateway適用前とnative policy適用前の双方で安定したerror codeにより拒否する。別workspaceのgenerationは独立に扱う | Approved | 非該当           |
| `NARR-F-061` | duplicate narrationを抑制する               | 同じsemantic typeと正規化textが30秒以内に再発した場合、2件目以降を音声queueへ追加しない                                                                                 | Approved | 非該当           |
| `NARR-F-062` | narrationは発話頻度を制限する               | 発話開始間隔を8秒以上、1分あたり6件以下にし、超過したlow-priority eventをまとめて1件のsummaryにする                                                                     | Approved | 非該当           |
| `NARR-F-063` | high-priority eventは低優先音声を中断できる | waiting_for_user/errorがplaying中のprogress narrationを停止し、caption表示後500ms以内にhigh-priority requestをqueue先頭へ置く                                           | Approved | 非該当           |

### TTS設定・再生・fallback

| 要件ID       | 要件                                   | 受け入れ条件                                                                                                                                                                                      | 状態     | 廃止理由・後継ID |
| ------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| `NARR-F-064` | TTSは初回とreset後に無効である         | fresh profileとReset Audio Settings後にTTS toggleがoffで、`say` process、network request、audio fileが0件になる                                                                                   | Approved | 非該当           |
| `NARR-F-065` | local TTS binaryを起動ごとに検証する   | executableをexact `/usr/bin/say`に固定し、regular file、owner UID 0、group/other write bit 0をvoice列挙・test・発話の直前に再検証する。違反時はshell/processを起動しない                          | Approved | 非該当           |
| `NARR-F-066` | 利用者はvoiceとrateをpreviewできる     | enableと検証済みvoice選択後に固定sample captionをmountし、sample自身のvisible ackと100ms lead後だけ再生する。rate倍率0.75〜1.25を基準180 words/minuteの135〜225へ変換し、caption未mount/hidden/ack timeout、cancel、playback timeout時も設定入力を保持する | Approved | 非該当           |
| `NARR-F-067` | local adapter失敗はtext fallbackになる | binary missing/tampered、voice unavailable、spawn/stdin/exit error、audio deviceなし、Test voice専用5秒timeoutの各場合にaudio unavailableを即時terminal表示し、nativeのsanitized `lastErrorCode`、caption、main turnを維持する。native runtimeまたはspeak responseが`unavailable`になった時はfrontend timeoutまでpollせず、native active/queued playbackをcancelして既存speech chainを全無効化し、terminal status/errorを後続のidleで上書きしない。frontend watchdog時もnative cancel完了後にterminal化する。offlineは失敗条件にしない | Approved | 非該当           |
| `NARR-F-068` | muteは現在の音声を即時停止する         | mute操作後100ms以内にactive process groupを終了し、queueをclearし、captionを消去しない                                                                                                            | Approved | 非該当           |
| `NARR-F-069` | unmuteは過去音声を再生しない           | mute中に発生したeventをunmute後に再生せず、unmute後の次eventからだけqueueへ追加する                                                                                                               | Approved | 非該当           |
| `NARR-F-070` | workspace切替とapp終了は再生を停止する | workspace switch、turn stop、app closeの各操作後100ms以内にactive process groupとqueueを停止し、旧workspace audioが再開しない                                                                     | Approved | 非該当           |
| `NARR-F-071` | queueは古い音声を蓄積しない            | waiting/queued合計を3件以下にし、4件目追加時は最古のlow-priority項目を破棄してmetadataを記録する                                                                                                  | Approved | 非該当           |

### Privacy・accessibility・言語

| 要件ID       | 要件                                               | 受け入れ条件                                                                                                                                                                                                                                       | 状態     | 廃止理由・後継ID |
| ------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| `NARR-F-072` | local processへredacted transcriptだけを渡す       | scalar count 1〜240、NULなしで、root directory名を列挙しない任意のPOSIX absolute path（`/root/x`、`/workspace/x`、`/System/x`を含み、括弧・引用符・`=`・`:`・全角句読点直後も対象）、Bearer token、GitHub token、AWS access/secret/session key、Slack token、PEM private key、cookie/session/password/token/key assignmentを検出したtextをfrontend/nativeの同一fixture集合でrejectする。relative source pathとURLはpath判定だけでrejectせず、検査済みtextだけをstdinへ書き、command line、environment、file、networkへ本文を渡さない。引数は`-v <exact allowlist voice> -r <validated integer>`だけで、shell、`-f`、`-o`、`-n`、`-a`を使用しない | Approved | 非該当           |
| `NARR-F-073` | generated audioを永続化しない                      | `say`のaudio outputをsystem outputへ直接再生し、temporary/output fileを作らず、app DB/artifact/logにaudio byteが残らない                                                                                                                           | Approved | 非該当           |
| `NARR-F-074` | narrationは音声なしでも理解できる                  | TTS off、mute、screen reader、audio deviceなしの各状態で同じtranscript、priority icon、workspaceを確認できる                                                                                                                                       | Approved | 非該当           |
| `NARR-F-075` | appはja/enに対応するvoiceを選ぶ                    | 検証済みbinaryの`-v '?'`出力をboundedにparseし、`ja_JP`または`en_*`のinstalled voice名をexact allowlistとして候補表示する。保存voiceも発話直前のallowlistへ完全一致しなければTTSをdisabledにしてtext fallbackを使う                                | Approved | 非該当           |
| `NARR-F-076` | appはnarrationでnetwork/microphoneへアクセスしない | capability manifestとruntime testでnarration由来のnetwork request、microphone capability/requestが0件になる                                                                                                                                        | Approved | 非該当           |
| `NARR-F-077` | 利用者はTTS testをcancelできる                     | test playbackまたは起動待ち中にCancelすると100ms以内にprocess groupを停止し、保存済み設定を変更しない                                                                                                                                              | Approved | 非該当           |

### Commit explanation caption

| 要件ID       | 要件                                                              | 受け入れ条件                                                                                                                                                                                                                                                         | 状態     | 廃止理由・後継ID |
| ------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| `NARR-F-078` | commit説明は成功SHA一致後に独立background runtimeで自動準備される | App Serverが報告したGit commit成功SHAとnative observerが確認したexact SHAが一致した時だけ、そのcommit keyのbackground support generationを自動開始する。main sessionのassistant/sub-agent outputから説明streamを生成・転送しない                                     | Approved | 非該当           |
| `NARR-F-079` | active presentationの確定chunkをcharacter captionへstreamする     | 利用者が対象commitの「詳しく教えて」を選んだ後だけ、redaction/schema検査済みdeltaをsequence順に1chunkずつvisible captionへ表示し、summary、changes、reasons、verification、impact、cautions、howToReadNextをja/enで追える。Live2D canvasだけへ描画しない             | Approved | 非該当           |
| `NARR-F-080` | TTS無効・失敗時もcaptionを維持する                                | TTS off、mute、binary/voice unavailable、process error、audio deviceなしの各状態で説明captionを全件表示し、説明request自体を失敗扱いにしない                                                                                                                         | Approved | 非該当           |
| `NARR-F-081` | TTSはactive captionと同じchunkだけを読む                          | TTS enabledかつunmutedで、同一commit key・同一text・同一sequenceの`li[data-narration-sequence]`自身がwindow/scroll viewport内で完全visibleかつfrontmostとackされた時だけlocal adapterのstdinへ渡し、音声用の追加要約・言い換え・evidence再送を0件にする | Approved | 非該当           |
| `NARR-F-082` | commit検知だけではpresentationを開始しない                        | background生成がstarted/streaming/completedになっても、対象commitがactive presentationでなければcaption/live region/TTSを変更せず、`say` processを0件にする                                                                                                          | Approved | 非該当           |
| `NARR-F-083` | 「詳しく教えて」は生成中と生成済みの両方を表示できる              | 生成中のcommitをactivateした場合は受理済みchunkを表示して後続をstreamし、生成済みcommitをactivateした場合は保存順の全chunkを決定的に再提示する。TTSはactivate後に未読sequenceだけを読む                                                                              | Approved | 非該当           |
| `NARR-F-084` | app-owned controllerだけが字幕・音声をcommit key単位で適用する    | `workspaceId + workspaceGeneration + full commit SHA + support request ID + presentation generation + locale`がactive keyと完全一致するversioned envelopeだけを受理する。main session event、React componentへの任意text、別channelからcaption/TTSへ直接書き込めない | Approved | 非該当           |
| `NARR-F-085` | selection変更は字幕・音声を同じgenerationで停止する               | 別commit選択、workspace切替、stale workspace generationの各場合にpresentation generationを進め、旧keyのcaption/live regionをdismissedとして閉じ、active/queued speechを100ms以内に停止して旧presentation key宛の後着chunkを表示・発話しない。background jobのprepared cacheを破棄するsupport cancelとは区別する                 | Approved | 非該当           |
| `NARR-F-086` | commit説明本文をmain conversation/historyへ混入させない           | background support input/output、caption chunk、TTS transcriptをmain sessionのconversation item、assistant message、main timeline/history event本文へappendせず、app-owned volatile presentation stateとsanitized runtime metadataだけに限定する                     | Approved | 非該当           |
| `NARR-F-087` | stream破損はcaption-onlyの安全なterminalになる                    | schema/locale/commit key mismatch、sequence gap/duplicate、oversize/unsafe textを適用せず、active presentationをunavailableでterminal化し、TTSをcancelする。main coding sessionと既存commit evidenceは継続する                                                       | Approved | 非該当           |
| `NARR-F-088` | presentation dismissとsupport cancelを分離する                    | `Close explanation`はactive caption/live regionを閉じてspeechだけを100ms以内に停止し、prepared chunk cacheとbackground jobを維持する。同じcommitを再度「詳しく教えて」で開くとcacheをsequence順に再提示する。queued/running中だけ表示する`Cancel explanation generation`はsupport jobをCanceledへterminal化して後着chunkを破棄し、明示Retryで新requestを作るまで同requestを再提示しない | Approved | 非該当           |
| `NARR-F-089` | Audio設定の失敗復旧で入力とlocaleを維持する                       | settings取得済み状態でvoice列挙が失敗してもinline error codeと`Retry voices`を表示し、保存済み設定、直前voice list、未保存voice/rate draftを維持する。mute保存によるsettings version更新でdirty draftを再初期化せず、presentation/speech statusをja/enの管理文言で表示する                                         | Approved | 非該当           |

## 入力項目要件

| グループ     | 項目              | 初期値     | 必須                   | 制約・境界                                                                                       | エラー時                                    |
| ------------ | ----------------- | ---------- | ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Audio        | TTS enabled       | off        | 必須                   | boolean                                                                                          | 不正値はoff                                 |
| Audio        | voice             | locale既定 | 条件付き               | 発話直前のinstalled exact allowlist候補                                                          | TTS無効、caption維持                        |
| Audio        | rate              | 1.0        | 必須                   | 0.75〜1.25、0.05刻み。nativeでは180倍をroundした135〜225 words/minute                            | 1.0へ戻し理由表示                           |
| Audio        | mute              | false      | 必須                   | boolean、workspace非依存global                                                                   | 不正値はmutedへfail closed                  |
| Presentation | active commit key | なし       | 「詳しく教えて」後だけ | workspace/generation/full SHA/request/presentation generation/localeの完全一致。永続設定ではない | presentationを停止しcaption/TTSへ適用しない |

## デスクトップ固有要件

| 領域                        | 要件                                                                                    | 対象要件ID                               |
| --------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| 対象OS・OS差分              | macOS 14以降のroot-owned `/usr/bin/say`とsystem audio output                            | `NARR-F-065`, `NARR-F-068`               |
| ウィンドウ生成・再利用      | S-002のmuteとS-004設定を同一stateで再利用                                               | `NARR-F-068`, `NARR-F-069`               |
| 閉じる・アプリ終了          | process groupとqueueをbounded cancelしaudio fileを残さない                              | `NARR-F-070`, `NARR-F-073`               |
| 未保存データ                | voice/rateの未保存入力はdialog cancelで破棄                                             | `NARR-F-066`                             |
| ローカルデータ              | owner-only atomic settingsとtranscript metadataだけを保存し、audioはDB/fileへ保存しない | `NARR-F-064`, `NARR-F-073`               |
| オフライン                  | local TTSを継続でき、network requestは常に0件                                           | `NARR-F-067`                             |
| ファイル・OS操作            | fixed system binaryをshellなしで起動し、temporary/output audio fileを作らない           | `NARR-F-065`, `NARR-F-072`, `NARR-F-073` |
| メニュー・ショートカット    | mute buttonは27px visual、24px以上hit area、aria-pressed                                | `NARR-F-068`                             |
| Deep Link・ファイル関連付け | 非該当                                                                                  | 非該当                                   |
| 通知                        | caption/live regionを正本、音声は補助                                                   | `NARR-F-058`, `NARR-F-074`               |
| Capability・認可            | narration network capabilityとmicrophoneを持たず、fixed `say` process/audio outputだけ  | `NARR-F-064`, `NARR-F-072`, `NARR-F-076` |
| アップデート・互換性        | binary metadataとinstalled voice listを実行時に再検証                                   | `NARR-F-065`, `NARR-F-075`               |

## 画面・UI

| 画面ID  | 画面名                     | 対象要件ID                                                                         | 扱い | 画面詳細仕様                                                   |
| ------- | -------------------------- | ---------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------- |
| `S-002` | コーディングワークスペース | `NARR-F-057`〜`NARR-F-063`, `NARR-F-068`〜`NARR-F-075`, `NARR-F-078`〜`NARR-F-088` | 変更 | [画面詳細仕様](../screen-design/S-002_coding-workspace.md)     |
| `S-003` | セッション証拠             | `NARR-F-078`〜`NARR-F-088`                                                         | 変更 | [画面詳細仕様](../screen-design/S-003_session-evidence.md)     |
| `S-004` | 設定・診断                 | `NARR-F-058`, `NARR-F-064`〜`NARR-F-077`, `NARR-F-088`, `NARR-F-089`                | 変更 | [画面詳細仕様](../screen-design/S-004_settings-diagnostics.md) |

## 非機能要件

| 領域             | 要件                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| セキュリティ     | root-owned/non-writable binary再検証、shellなし、exact voice allowlist、validated rate、bounded stdinを強制する                                                                      |
| 権限             | fixed local processとaudio outputだけ。network/microphone capabilityを持たない                                                                                                       |
| プライバシー     | default off、explicit presentation/enable、secret不要、audio非永続、source/path非送信、main conversation/historyへ説明本文を非混入                                                   |
| 監査・ログ       | opaque request/commit digest prefix、generation、priority、process status、latency、drop reasonだけを記録し、transcript本文/audio/support input/output/stdout/raw stderrを記録しない |
| 性能             | caption 300ms、mute/stop 100ms、test timeout 5秒、queue 3件、発話間隔8秒                                                                                                             |
| 信頼性・復旧     | binary/voice/process/audio errorでcaption fallback、workspace switchで旧process group停止                                                                                            |
| アクセシビリティ | visible caption、polite/assertive live regionのpriority分離、aria-pressed、音声非依存                                                                                                |
| 多言語・地域     | ja/en transcriptとvoice filter、user content/pathは翻訳しない                                                                                                                        |

## 依存関係・前提

| 依存・前提         | 内容                                                                   | 状態                           | 未解決時の影響                                                    |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| SUP                | main sessionと独立したcommit-keyed background support stream           | 解決済み（typed contract）     | unavailable時はpresentation unavailable。main出力へfallbackしない |
| GIT                | App Serverのcommit成功SHA、native observerのexact SHA、selected commit | 解決済み（typed contract）     | SHA不一致・未確認時はbackground生成/presentation/TTSを開始しない  |
| LIVE               | lip-sync/operational state                                             | 解決済み（相互参照確認済み）   | renderer failureでもcaption/audio継続可能                         |
| HIST               | transcript/usage metadata、audio非保存                                 | 解決済み（相互参照確認済み）   | persistence failureでもplayback後audio削除                        |
| macOS local speech | `/usr/bin/say` metadata、installed voice list、system audio output     | 解決済み（optional local境界） | unavailable時text fallback                                        |

## 未確定事項

| 論点                | 初期判断                                                                        | 確認事項                                     | 着手ブロック |
| ------------------- | ------------------------------------------------------------------------------- | -------------------------------------------- | ------------ |
| installed voice差分 | `ja_JP` / `en_*`を実行時列挙しexact allowlist化、default off                    | release hostでvoice availabilityを再検証する | いいえ       |
| lip-sync精度        | MVPはprocess playing中のsemantic speaking stateだけを連動し、失敗/停止時neutral | Hiyori実機QAで開始・停止遅延を確認する       | いいえ       |

## 実装・検証の入口

| 関心事                       | 実装場所                                                                                                  | 変更時に守ること                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| native local speech          | `src-tauri/src/narration/`                                                                                | `/usr/bin/say`検証、stdinだけの本文、owner-only設定、process group cancelをWebViewへ移さない                               |
| WebView contract・controller | `src/features/narration/contracts.ts`、`controller.ts`、`transport.ts`                                    | `background_support`以外を受理せず、same-workspace scopeを巻き戻さず、未activate jobはcaption/TTSへ出さない。dismissとsupport cancelを分離し、sequence別ack deadline、terminal後のspeech chain無効化、Test voice 5秒watchdogを維持してunsafe/late chunkを復活させない |
| private text parity          | `src/test/fixtures/narration-redaction.v1.json`、`src/features/narration/contracts.test.ts`、`src-tauri/src/narration/policy.rs` | path・token・credential rejectionをWebView/nativeの共有fixtureで一致させ、新しいpatternは両境界のparity testへ追加する |
| Audio設定                    | `src/features/narration/components/NarrationSettings.tsx`、`src/features/workspace-view/SettingsView.tsx` | default off、明示Save、Test voice sample自身のvisible ack + 100ms lead、native設定を正本にし、voice retryとdirty draft保持を全error stateで検証する |
| character caption・mute      | `src/features/narration/components/CommitNarrationCaption.tsx`、`CharacterStageSlot.tsx`、`ChatView.tsx`  | accepted chunkを順番どおりvisible HTML/live regionへ出す。各sequence自身がactive windowと内側scroll viewport内の正の矩形かつ前面hit targetと確認できた時だけackし、100ms lead後に発話する。hidden/scroll外/partially clipped/occluded captionはackせず、840px以下でもmobile captionを残す |

`pnpm exec vitest run src/features/narration/**/*.test.ts src/features/narration/**/*.test.tsx src/features/workspace-view/CharacterStageSlot.narration.test.tsx --testTimeout=20000 --fileParallelism=false`を実行すると、strict envelope、IPC payload、default off、明示presentation、per-sequence window/scroll viewport paint ack + 100ms lead、independent ack deadline、same-text speech、mute、dismiss/replay、support cancel、multi-chunk native unavailable、monotonic scope、Test voice gate/5秒watchdog、voice retry、dirty draft、ja/en statusを検証できる。続けて`cargo test --manifest-path src-tauri/Cargo.toml narration -- --nocapture`、`pnpm exec tsc --noEmit --pretty false`、対象pathのESLintを実行する。実ブラウザでは1470px、960px、480pxと200%相当幅で、captionの実幅、scroll-clipped child、mobile fallback、ja/en、reduced motion、Test voice、native failure、mute、Close→reopen、Cancel、settings error→Retryを確認する。

Commit画面から接続するときは、任意textをReact componentへ直接渡さず、`CommitNarrationConsumerPort`へversioned eventを流してから、current workspace scopeと完全一致する`CommitNarrationSourceKey`だけを`NarrationController.activatePresentation`へ渡す。generationを巻き戻してactivateしてはならない。

## 参照資料

| 資料                                                                      | 参照理由                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------ |
| [PRODUCT.md](../../PRODUCT.md)                                            | quiet-by-default、音声非依存                     |
| [DESIGN.md](../../DESIGN.md)                                              | mute control、Live2D state、motion               |
| [体験設計](../research/02-experience-design.md)                           | active workspaceとmeaningful narration           |
| [セキュリティ調査](../research/09-security-privacy.md)                    | process、redaction、least privilege              |
| [macOS local narration実測](../research/macos-local-narration-runtime.md) | `/usr/bin/say`のmetadata、stdin、voice、rate契約 |

## レビュー・合意

| 項目               | 内容                                                                          |
| ------------------ | ----------------------------------------------------------------------------- |
| レビュー結果       | Ready                                                                         |
| 仕様責任者         | プロダクトオーナー                                                            |
| 合意日             | 2026-07-18                                                                    |
| 残る非ブロック論点 | installed voice差分とsemantic speaking tuningはfallback/default offで解決済み |

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
