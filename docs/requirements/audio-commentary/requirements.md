---
title: "音声実況 要件定義"
description: "現在workspaceの状態変化を1人のNarratorがtextとOpenAI TTSで実況する要件。"
updated: 2026-07-16
last_verified: 2026-07-16
status: "Draft"
prefix: "NARR"
read_when:
  - "Narrator、優先queue、質問中の沈黙を実装・検証するとき。"
  - "Speech API、TTS key、audio再生、縮退、音声設定を変更するとき。"
---
# 音声実況 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `NARR` |
| 状態 | Draft |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-16 |
| 最終レビュー日 | 未レビュー |

## 背景

長時間のCodex作業を画面へ張り付かず把握できるよう、raw logではなく現在の行動と意味を短く伝える。ハッカソン版は、現在開いているworkspaceだけを1人のNarratorがevent-drivenで実況し、音声障害時もtextとmain Solのexpressionで継続する。

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| 画面を見ずに進捗を理解する | 10分のheadphone-only試験で目的、現在phase、直近結果、次の一手、回答要否の5項目中4項目以上を回答できる。 |
| 重要な変化を落とさない | 6種類の重要eventすべてが同一内容のtext transcriptへ100%反映される。 |
| 実況過多を防ぐ | 状態変化がない時間帯、重複event、質問回答待ちでは新しい発話が0件になる。 |
| 音声障害から縮退する | key、API、network、deviceの失敗時もtext、main expression、Codex sessionを維持できる。 |
| 秘密を読み上げない | code、raw log、秘密、長いpath、生IDを含むfixtureがtranscriptとSpeech API inputへ0件となる。 |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| 実況生成 | Narratorの構造化出力と決定論的fallbackから、日英1〜2文のtextを作る。 |
| event・再生 | 現在workspaceの状態変化を選別し、playing＋next、文境界interrupt、topic return、stale破棄を扱う。 |
| 会話構造 | 目的、行動、理由、期待、実結果、影響・次手をplay-by-playとcolor commentaryへ分ける。 |
| TTS | RustからOpenAI Speech APIへ短いredacted textを送り、PCM chunkを再生する。 |
| 設定・検証 | key、mute、volume、voice、language、縮退、coverage、日英headphone-only試験を扱う。 |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| microphone、STT、system audio capture | output-onlyで録音権限を持たないため | 禁止 |
| Realtime API、speech-to-speech | request-based TTSへ集中するため | ハッカソン後 |
| 複数実況者、role別voice | 1人の聴取体験にするため | 非対象 |
| custom voice作成・upload | consentとasset管理を増やさないため | 組込みvoiceだけを使用 |
| audio fileの保存、download、export、履歴再生 | privacyと実装期間を守るため | text transcriptだけを履歴へ保存 |
| 別workspaceのbackground実況 | 聞いている対象を一意にするため | workspace切替後に新しい対象へ移る |
| raw code、log、path、IDの読み上げ | 秘密保護のため | 状態と結果だけを要約 |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ユーザー | 実況を聞く利用者 | TTS、mute、volume、voice、language、key | 秘密値を再表示しない |
| Narrator | 固定support role | 検証済みeventから実況textを返す | TTS、質問、source変更は不可 |
| Solとsupport role | 実況対象 | 正規化eventとevidenceを提供 | raw responseを読まない |
| Rust adapter | 信頼境界 | 照合、redaction、queue、credential、HTTP、再生 | 不正・秘密・stale payloadを拒否 |
| React WebView | 非特権UI | transcript、status、設定、keyboard操作 | key、HTTP、audio byteへアクセス不可 |
| OpenAI Speech API | 外部TTS | 固定endpoint、model、voice、PCM | 失敗時はtext-onlyへ縮退 |

## 機能要件

### 実況対象とtext生成

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| NARR-F-001 | 実況者を固定support role `Narrator`の1人にする。 | runtimeで実況textのproducerが`narrator`またはNARR-F-018のfallbackだけで、main・他supportのraw outputが直接TTSへ渡らず、全発話へ選択中voice 1種類を使う。 | Draft | 非該当 |
| NARR-F-002 | actorの表示名を固定する。 | transcriptで使用できるrole名が`Sol`、`Planner`、`Narrator`、`Decision Explainer`、`Risk Sentinel`、`QA`、`Detached Reviewer`、`Checkpoint Curator`と一致し、ユーザーが変更・翻訳できない。 | Draft | 非該当 |
| NARR-F-003 | APPのactive workspaceだけを実況対象にする。 | eventのworkspace IDがactive値と一致する場合だけNarratorまたはfallbackを作り、activeなし・別workspaceではtranscript、TTS、expression変更が0件となる。 | Draft | 非該当 |
| NARR-F-004 | active workspace変更でgeneration IDを更新し旧実況を停止する。 | 変更・解除から100 ms以内に旧stream、buffer、playing、nextを破棄し、新active eventだけを受け付け、旧音声を追加再生しない。 | Draft | 非該当 |
| NARR-F-005 | 実況triggerを正規化された状態変化eventに限定する。 | timer、heartbeat、token delta、raw log line、同じstatusの再通知だけではNarrator assignmentとfallbackが0件で、event typeとsource evidenceがある場合だけ生成する。 | Draft | 非該当 |
| NARR-F-006 | 同じ状態を表すeventを重複排除する。 | workspace、session、event type、phase、result、evidence refsから作るfingerprintが直前発話と同じ場合は新しいtranscriptとTTS requestを作らず、状態変化後の同種eventは受け付ける。 | Draft | 非該当 |
| NARR-F-007 | 6種類の重要eventを必ずtext transcriptへ反映する。 | 受理した一意な重要event数を分母、そのevent IDを参照する表示済みtranscript数を分子としてcoverageが100%になり、Narrator失敗時もfallbackで満たす。 | Draft | 非該当 |
| NARR-F-008 | 通常eventの発話間隔を8秒以上にする。 | 重要event以外は直前の通常発話開始から8,000 ms未満ならnextへ最大1件集約し、重要eventは間隔制限を適用しない。 | Draft | 非該当 |
| NARR-F-009 | 実況contextを6要素で管理する。 | `purpose`、`current_action`、`reason`、`expectation`、`actual_result`、`impact_or_next`をnullable fieldとして持ち、1つのwork unitの開始から終了までに該当する全fieldがtranscriptまたは`not_applicable`で解決される。 | Draft | 非該当 |
| NARR-F-010 | 未確定の期待を仮説として表現する。 | `expectation`を含む日英fixtureで「見込み」「予想」または`expect`、`likely`のいずれかを含み、結果を示す過去形または成功断定を含まない。 | Draft | 非該当 |
| NARR-F-011 | 実結果をterminal evidence受信後だけ発話する。 | test、command、turn、reviewの開始eventでは成功・失敗を断定せず、対応するterminal statusとevidence受信後にだけ`actual_result`を生成する。 | Draft | 非該当 |
| NARR-F-012 | play-by-playで現在の行動または実結果を伝える。 | action開始、phase変更、terminal resultの各fixtureで、`current_action`または`actual_result`の少なくとも1つを含む発話が表示される。 | Draft | 非該当 |
| NARR-F-013 | color commentaryで理由、期待、影響・次手を補う。 | 10分scenario内で`reason`、`expectation`、`impact_or_next`が各1回以上発話され、根拠のない感情やriskを事実として追加しない。 | Draft | 非該当 |
| NARR-F-014 | 1発話を1〜2文かつ1〜500 Unicode scalarに制限する。 | 境界fixtureで1文・500 scalarは受理し、0文、3文、501 scalarはTTSへ送らず、重要eventは500以内のfallbackへ置換し、通常eventは`invalid_narration`にする。 | Draft | 非該当 |
| NARR-F-015 | 読み上げ禁止情報をtranscript生成前に除外する。 | code・diff・file本文、raw stdout/stderr、prompt/response全文、API key、token、credential、secret回答、UUID、request/thread/turn/item ID、commit SHAがtranscriptとSpeech API inputへ0件となる。 | Draft | 非該当 |
| NARR-F-016 | pathを一般化して読み上げる。 | absolute pathを0件にし、relative pathが必要な場合も最後のfile名を40 scalarまで表示し、超過またはworkspace外pathは日英の`対象ファイル`相当へ置換する。 | Draft | 非該当 |
| NARR-F-017 | 実況textを日本語または英語の1言語で生成する。 | 発話ごとに`ja`または`en`が1つあり、選択言語とtranscriptが一致し、同じ発話内で固定role名以外のUI文言を混在させない。 | Draft | 非該当 |
| NARR-F-018 | Narratorが2秒以内にvalid outputを返せない重要eventを決定論的textへ縮退する。 | timeout、unavailable、stale、schema不正でevent type、固定role名、status、次の操作から500 scalar以内のfallbackを2秒以内に表示し、mainとTTS設定を変更しない。 | Draft | 非該当 |

### 優先queue、interrupt、質問待ち

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| NARR-F-019 | 実況eventを固定優先順位へ分類する。 | `question・unrecoverable_failure > session_completed・failure・plan_changed > work_unit_completed > 通常event`で解決し、同一priorityはevent sequence順になる。 | Draft | 非該当 |
| NARR-F-020 | audio queueをplaying 1件とnext 1件へ制限する。 | 100 eventを入力してもaudio slotが最大2件、同時再生が最大1streamで、3件目のaudio bufferまたはHTTP requestを先行生成しない。 | Draft | 非該当 |
| NARR-F-021 | 新しいeventでnextを優先度とfreshnessにより置換・集約する。 | 高priorityは既存nextを置換し、同priorityの通常eventは最新stateへ集約する。置換された重要eventはtextを保持してaudio statusを`superseded`にする。 | Draft | 非該当 |
| NARR-F-022 | 発話を文単位のSpeech API requestへ分割して文境界でinterruptする。 | 2文発話を2requestとして順に再生し、高priority到着時は再生中の文を完了後100 ms以内に残りの文を破棄してnextを開始する。 | Draft | 非該当 |
| NARR-F-023 | interruption後に元topicへ戻る場合だけtopic returnを1回発話する。 | 中断元work unitがactiveのまま高priority topicが解決した場合は「元の作業へ戻る」相当を1回だけ出し、元topicが完了・変更済みならreturn発話を出さない。保持する中断元は1件だけとする。 | Draft | 非該当 |
| NARR-F-024 | mainのAskUserQuestionをtext、条件付きaudio、OS通知で知らせる。 | 非secretはredactした要旨、secretは非公開入力が必要とのtextを1回表示し、readyかつ非muteなら1回発話する。window非表示・非activeなら共通の質問通知を1件送る。 | Draft | 非該当 |
| NARR-F-025 | AskUserQuestion告知後は回答または解決まで沈黙する。 | `waiting_for_user`中は新しいNarrator、fallback、TTS requestが0件で、既存nextを破棄し、回答待ちtextだけを維持する。 | Draft | 非該当 |
| NARR-F-026 | AskUserQuestion解決後に最新状態から実況を再開する。 | answer、timeout、server resolutionのいずれかで待機解除後、古いdeferred audioを再生せず、最新phaseが中断前と同じ場合だけNARR-F-023を適用する。 | Draft | 非該当 |
| NARR-F-027 | transcriptをaudio開始前に表示する。 | valid textはTTS状態を問わず200 ms以内にARIA statusとtimelineへ表示し、readyかつ非muteの場合だけ、その後にaudio requestを開始する。 | Draft | 非該当 |
| NARR-F-028 | audio再生をLive2D mouth envelopeと相関する。 | audio request IDとworkspaceがLIVE-F-029の現在値に一致する間だけ0.0〜1.0 envelopeを30 Hz以上で送り、停止・silence・別workspace・errorから100 ms以内に0へ戻し、semantic expressionを変更しない。 | Draft | 非該当 |
| NARR-F-029 | window非表示中もcommentary workspaceのTTSを継続する。 | close後もplaying、next、HTTP stream、audio deviceを維持し、trayから再表示しても二重再生せず、別workspace eventを実況しない。 | Draft | 非該当 |
| NARR-F-030 | mute、workspace切替、緊急停止、Quitではaudioを即時停止する。 | 操作から100 ms以内にHTTP stream、buffer、device playback、mouth envelopeを停止しgeneration IDを更新する。停止した発話をunmute・再表示・再起動時に再生しない。 | Draft | 非該当 |

### OpenAI Speech APIとcredential

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| NARR-F-031 | Speech API endpointとmodel snapshotを固定する。 | `POST https://api.openai.com/v1/audio/speech`へ`model: "gpt-4o-mini-tts-2025-12-15"`だけを送り、alias、別snapshot、Realtime API、別providerへfallbackしない。 | Draft | 非該当 |
| NARR-F-032 | 1文ごとに最小のSpeech request bodyを送る。 | bodyが`model`、redacted `input`、allowlist済み`voice`、`response_format: "pcm"`、`stream_format: "audio"`だけを持ち、workspace/session/role ID、evidence、path、logを含まない。 | Draft | 非該当 |
| NARR-F-033 | PCM audioをchunked responseから逐次再生する。 | 24 kHz・16-bit signed little-endian mono PCMとしてheaderなしでdecodeし、全response完了前に先頭chunkを再生でき、chunk順序の欠落・逆転・奇数byteではstreamを停止する。 | Draft | 非該当 |
| NARR-F-034 | Speech API通信とaudio device操作をRust側だけで行う。 | browser network traceとWebView heapにAPI key、Authorization header、PCM byteが0件で、Reactはrequest ID、status、transcript、envelope statusだけを受け取る。 | Draft | 非該当 |
| NARR-F-035 | TTSへCodex/ChatGPT認証とは別のOpenAI Platform API keyを使用する。 | S-004へ「Codex loginではTTSを利用できない」とPlatform API課金の案内を表示し、Codex auth file、ChatGPT session、App Server tokenをSpeech requestへ使用しない。 | Draft | 非該当 |
| NARR-F-036 | TTS API keyをOS credential storeだけへ保存する。 | macOS Keychain、Windows Credential Manager、Ubuntu Secret Service互換storeへ保存し、SQLite、Web Storage、平文file、環境変数、logへのfallbackが0件となる。 | Draft | 非該当 |
| NARR-F-037 | API key入力を保存完了後にmemoryから消去する。 | masked入力をRustへ1回渡し、credential storeの成功・失敗response後100 ms以内にReact値とRust request bufferをzeroizeし、key値、長さ、末尾文字を再表示・copyしない。 | Draft | 非該当 |
| NARR-F-038 | 初回audio再生前にAI生成音声であることを明示する。 | 日英で「人間ではなくAI生成音声」と常時S-004へ表示し、初回TTS有効化時に同内容を確認するまでaudioを再生せず、text実況は継続する。 | Draft | 非該当 |
| NARR-F-039 | voiceをsnapshot対応の組込み13種類へ限定する。 | `alloy`、`ash`、`ballad`、`coral`、`echo`、`fable`、`onyx`、`nova`、`sage`、`shimmer`、`verse`、`marin`、`cedar`だけを選択でき、defaultは`cedar`、custom voice IDは拒否する。 | Draft | 非該当 |
| NARR-F-040 | OpenAIへ送るcustomer contentを発話1文だけに限定する。 | static fieldを除くrequest dataがNARR-F-014〜NARR-F-016を通過した1〜500 scalarの`input`だけで、会話、source event、evidence、workspace名、user識別子を送らない。 | Draft | 非該当 |
| NARR-F-041 | Speech APIの外部data境界をTTS有効化前に表示する。 | `/v1/audio/speech`はAPI training利用なし、標準abuse monitoring最大30日、application state保持なし、ZDR対象であることと組織設定で差があることを日英で表示し、公式data controlsへlinkする。 | Draft | 非該当 |
| NARR-F-042 | 生成audioをlocalへ永続化しない。 | PCM、encoded audio、stream chunk、ring bufferがSQLite、cache、file、Web Storage、backup、crash logへ0件で、再生終了・失敗・停止後1秒以内にmemory bufferを破棄し、transcriptだけをHISTへ保存する。 | Draft | 非該当 |

### 設定、障害、復元、受け入れ試験

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| NARR-F-043 | S-004へTTSの利用可能状態と診断を表示する。 | `text_only`、`ready`、`muted`、`offline`、`invalid_key`、`rate_limited`、`api_unavailable`、`device_unavailable`の1値、最終成功UTC、短いerror codeを表示し、keyとprovider本文を表示しない。 | Draft | 非該当 |
| NARR-F-044 | API key未設定・credential store利用不能ではtext＋expressionへ縮退する。 | Speech requestが0件、transcriptとmain semantic expressionが維持され、mouthは閉じ、main/support turnを継続し、S-004へ設定またはstore復旧案内を表示する。 | Draft | 非該当 |
| NARR-F-045 | 401、403、model unavailableではtext＋expressionへ縮退する。 | 当該発話のaudioを再試行せず`invalid_key`または`api_unavailable`を表示し、keyをlog・timelineへ出さず、別modelへfallbackせず、次のmain turnを許可する。 | Draft | 非該当 |
| NARR-F-046 | 429、network、timeout、5xxではfreshnessを優先してtext＋expressionへ縮退する。 | 自動retryを0回とし、connect 5秒、first byte 10秒、inter-chunk 5秒、1文全体60秒のいずれかを超えたstreamをcancelしてstatusを分類し、次のevent処理を継続する。 | Draft | 非該当 |
| NARR-F-047 | audio device・PCM decode失敗ではtext＋expressionへ縮退する。 | device open、device loss、unsupported format、decode、buffer overflowでstreamを停止しmouthを閉じ、既定deviceの再診断を表示してmainとtranscriptを維持する。 | Draft | 非該当 |
| NARR-F-048 | chunk再生前にgeneration IDとrequest IDを再照合する。 | どちらかがcurrent値と異なるchunkをaudio deviceとmouthへ0件渡し、`stale_audio_discarded`だけを記録して新しいgenerationを止めない。 | Draft | 非該当 |
| NARR-F-049 | 非秘密音声設定をSQLiteへ保存する。 | TTS enabled、mute、integer volume、voice、language、AI音声確認versionをtransaction保存して再起動後に復元し、API keyとaudioを含めない。 | Draft | 非該当 |
| NARR-F-050 | 音声設定の初期値を固定する。 | 初回はTTS disabled、mute false、volume 70、voice `cedar`、language `ui`で、valid key保存とAI音声確認後にユーザーがTTSを明示有効化できる。 | Draft | 非該当 |
| NARR-F-051 | 設定変更を安全な再生境界で反映する。 | muteとTTS disableは即時停止、volumeは0〜100を現在streamへ250 ms以内、voice・languageは次の文から反映し、範囲外値では直前設定を維持する。 | Draft | 非該当 |
| NARR-F-052 | 再起動時にaudio queueを復元・再生しない。 | transcriptと設定だけを復元し、playing、next、generation、PCM、HTTP requestを空から開始し、中断発話を自動生成・送信しない。 | Draft | 非該当 |
| NARR-F-053 | 日英で10分のheadphone-only scenarioを合格させる。 | healthyなkey・API・macOS deviceで日本語1回、英語1回を行い、画面を見ない評価者が目的、現在phase、直近結果、次の一手、回答要否の5問中4問以上へ各言語で正答する。 | Draft | 非該当 |
| NARR-F-054 | event coverageと沈黙を自動検証する。 | 6重要eventを各10件、重複・state不変eventを各100件、質問待ち60秒を入力し、重要transcript coverage 100%、重複発話0件、質問発話後から解決まで発話0件となる。 | Draft | 非該当 |
| NARR-F-055 | 実況adapterのlocal性能とmemoryを制限する。 | 8 CPU core・16 GBのmacOSで1,000 event/分を10分入力し、model/API待ちを除くevent受付からqueue更新p95 200 ms、transcript反映p95 200 ms、audio buffer 2 MiB以下、UI threadの1秒超block 0回となる。 | Draft | 非該当 |
| NARR-F-056 | microphone・STT機能と権限を持たない。 | 3OS artifactのCapability、permission manifest、OS prompt、UI、network traceにmicrophone、audio input、speech transcriptionが0件で、lip-sync sourceがNARR-F-028のTTSだけとなる。 | Draft | 非該当 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| TTS | enabled | false | 必須 | boolean。key保存・AI音声確認後だけtrue | text-onlyを維持して理由を表示 |
| TTS | mute | false | 必須 | boolean | 不正値は直前値を維持 |
| TTS | volume | 70 | 必須 | integer 0〜100 | 入力を保持し境界を表示 |
| TTS | voice | `cedar` | 必須 | NARR-F-039の13値 | 直前のvalid voiceを維持 |
| TTS | language | `ui` | 必須 | `ui`、`ja`、`en` | 直前値を維持 |
| credential | Platform API key | 未設定 | 条件付き | masked、1〜512 ASCII文字、前後空白を除外 | 保存せず再入力を求める |
| event | workspace/session/sequence | なし | 必須 | current workspace、既知session、0以上の単調増加値 | eventを破棄する |
| event | type・evidence | なし | 必須 | allowlist event type、0〜20 evidence refs | `invalid_event`で実況しない |
| Narrator output | context・text | なし | 必須 | NARR-F-009、NARR-F-014〜NARR-F-017 | 重要eventはfallback、通常eventは破棄 |

### 実況・音声デシジョンテーブル

| 条件 | text | audio | expression・mouth |
|---|---|---|---|
| 別workspaceまたはstate不変 | 生成しない | 生成しない | 変更しない |
| current workspaceの重要event | 必ず表示 | readyかつ非muteならqueue | main expression維持、再生中だけmouth |
| current workspaceの通常event | cadenceと重複排除後に表示 | readyかつ非muteならqueue | main expression維持、再生中だけmouth |
| AskUserQuestion未解決 | 質問要旨と回答待ちだけ | readyかつ非muteなら質問を1回後に沈黙 | waiting expression、mouth closed |
| key・API・network・device失敗 | 必ず表示 | 再生しない | main expression維持、mouth closed |
| mute・緊急停止・Quit・workspace切替 | 保存済みtextは維持 | 即時停止 | main契約に従いmouth closed |

## デスクトップ固有要件

[デスクトップ共通仕様](../../screen-design/desktop-common-specification.md)との差分だけを次に定義する。

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | macOS 13+ Apple Siliconでlive TTS・device・headphone-onlyを実機検証する。Windows 11 x64とUbuntu 24.04 x64はHTTP/audio adapter、queue、redaction、credential abstractionをCI検証し、実機音声を保証しない。 | NARR-F-031〜NARR-F-056 |
| ウィンドウ生成・再利用 | 共通`main`のS-002とS-004を再利用し、audio・質問・設定用の追加windowを作らない。 | NARR-F-024〜NARR-F-029、NARR-F-043〜NARR-F-051 |
| 閉じる・アプリ終了 | closeでは最後のcommentary workspaceのaudioを継続し、明示Quitではstream、queue、device、mouthを即時停止する。 | NARR-F-029、NARR-F-030 |
| 未保存データ | transcriptはHISTへ保存し、audio、queue、generation、envelopeは保存しない。 | NARR-F-027、NARR-F-042、NARR-F-052 |
| ローカルデータ | 非秘密設定とtranscript metadataはSQLite、API keyはcredential store、audioはmemoryだけを正本とする。 | NARR-F-036〜NARR-F-043、NARR-F-049 |
| オフライン | 新しいSpeech requestを開始せずtext＋expressionへ縮退し、再接続後も過去発話を自動再生しない。 | NARR-F-046、NARR-F-052 |
| ファイル・OS操作 | 音声fileの作成・選択・保存を行わず、OS既定output deviceとcredential storeだけをRustから使用する。 | NARR-F-033〜NARR-F-037、NARR-F-042、NARR-F-047 |
| メニュー・ショートカット | narration固有global shortcutは追加しない。S-002のmuteとS-004設定をkeyboard操作可能にする。 | NARR-F-030、NARR-F-049〜NARR-F-051 |
| Deep Link・ファイル関連付け | 非該当: audio、key、voice、eventを外部schemeまたはfile openから受け取らない。 | NARR-F-032、NARR-F-036 |
| 通知 | narration固有通知を追加せず、AskUserQuestion、main完了、回復不能失敗だけ共通仕様のOS通知を使用する。 | NARR-F-024、NARR-F-043〜NARR-F-047 |
| Capability・認可 | WebViewへcredential、HTTP、audio、deviceを公開せず、microphone Capabilityを付与しない。 | NARR-F-034〜NARR-F-037、NARR-F-056 |
| アップデート・互換性 | model、voice、data notice、setting schemaをreleaseごとに検証し、migration失敗時は旧設定を守る。 | NARR-F-031、NARR-F-039、NARR-F-041、NARR-F-049〜NARR-F-052 |

## 画面・UI

画面レイアウト、表示状態、操作フローは各画面詳細仕様を正本とし、この文書では画面IDと要件IDの対応だけを管理する。

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-002` | コーディングワークスペース | NARR-F-001〜NARR-F-030、NARR-F-043〜NARR-F-048、NARR-F-052〜NARR-F-055 | 新規 | [S-002 コーディングワークスペース](../../screen-design/S-002_coding-workspace.md) |
| `S-004` | 設定・診断 | NARR-F-031〜NARR-F-056 | 新規 | [S-004 設定・診断](../../screen-design/S-004_settings-diagnostics.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | Speech API、credential、audio deviceをRustへ閉じ、request前にworkspace・generation・redactionを検証する。WebViewへkey、任意URL、audio byte、microphone権限を渡さない。 |
| 権限 | TTSはユーザーのkey保存とAI音声確認後だけ有効化する。音声障害はCodexのFull access、main turn、support turnの権限と状態を変更しない。 |
| プライバシー | OpenAIへredacted 1文だけを送り、標準retentionとZDR境界を表示する。localにはtranscriptを明示削除まで保存し、audioとkeyをSQLiteへ保存しない。 |
| 監査・ログ | narration event ID、workspace/session内部参照、generation、importance、language、transcript、TTS status、voice、開始・終了UTC、provider request ID、短いerror codeを保存し、key、audio、raw response、path、生IDをlogへ出さない。 |
| 性能 | NARR-F-055をrelease gateとし、audioはplaying＋next 1件、memory 2 MiB以下、同時stream 1件とする。外部API latencyはNARR-F-046のtimeoutで上限を設ける。 |
| 信頼性・復旧 | 重要eventへ決定論的fallbackを持ち、全音声障害をtext＋main expressionへ縮退する。古いgeneration、再起動前queue、中断発話を再生しない。 |
| アクセシビリティ | 全発話と同一textをaudio前にARIA statusへ表示し、keyboardでmute・設定・質問回答を操作できる。audio、Live2D、色だけを情報の唯一の伝達手段にしない。 |
| 多言語・地域 | 日本語と英語を提供する。固定role名、model、voice、error codeは翻訳せず、時刻はUTC保存・OS timezone表示とする。 |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) | Rust trust boundary、tray、Quit、通知、credential store、SQLite、3OS契約を適用する。 | 解決済み | key、audio、lifecycleを安全に扱えない |
| [codex-main-session要件](../codex-main-session/requirements.md) | main event、AskUserQuestion、secret分類、workspace相関を提供する。 | Draft | 質問待ちとmain phaseを実況できない |
| [support-agent-orchestration要件](../support-agent-orchestration/requirements.md) | Narrator role、構造化output、失敗縮退、stale判定を提供する。 | Draft | model生成実況を利用できずfallbackだけになる |
| [Live2Dコンパニオン要件](../live2d-companion/requirements.md) | main semantic expression、TTS request ID、mouth envelope、text縮退を提供する。 | Draft | expressionとlip-syncを表示できないがtext・audioは継続可能 |
| [アクティビティ履歴要件](../activity-history/requirements.md) | transcript eventを保存しaudio byteを保存しない。 | Draft | 再起動後に過去transcriptを表示できない |
| OpenAI Platform | Speech APIを利用できるproject、API key、billing、`gpt-4o-mini-tts-2025-12-15` accessが必要である。 | runtime検証 | text＋expressionへ縮退する |
| OS audio・credential | 既定output deviceとOS credential storeが利用可能である。 | runtime検証 | text＋expressionへ縮退する |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| なし | 本文の1人実況、event-driven queue、固定Speech API、text＋expression fallbackでハッカソン版を実装する | 仕様責任者レビューでS-002・S-004の双方向IDとlive API smoke evidenceを確認する | いいえ |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [要件定義基準](../../rules/requirements-definition-standards.md) | 1挙動1ID、受け入れ条件、desktop境界、異常系の記述基準 |
| [ID管理ルール](../../rules/id-management-rules.md) | `NARR` Prefix、要件ID、画面IDの正本 |
| [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) | credential、Quit、通知、text fallback、3OS共通契約 |
| [OpenAI Realtime and audio guide](https://developers.openai.com/api/docs/guides/audio) | request-based Speech APIとRealtimeの選択境界 |
| [OpenAI Text to speech guide](https://developers.openai.com/api/docs/guides/text-to-speech) | AI音声表示、voice、chunked streaming、PCM・WAV、languageの公式仕様 |
| [OpenAI Create speech API](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create) | endpoint、dated model、input、voice、format、streamのrequest contract |
| [OpenAI Data controls](https://developers.openai.com/api/docs/guides/your-data#storage-requirements-and-retention-controls-per-endpoint) | `/v1/audio/speech`のtraining、abuse monitoring、application state、ZDR境界 |

外部資料は2026-07-16に確認した。

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Not Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 未合意 |
| 残る非ブロック論点 | S-002・S-004からの逆参照、live Speech API smoke evidence、仕様責任者合意 |

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
