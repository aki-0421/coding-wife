---
title: "NARR 音声実況要件定義"
description: "意味あるイベントの字幕優先実況、任意TTS、mute、rate limit、privacy、fallbackを定義する。"
updated: 2026-07-18
read_when:
  - "narration policy、TTS、mute、captionを実装するとき。"
  - "active workspace分離、stale破棄、local process境界を検証するとき。"
---

# 音声実況 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `NARR` |
| 状態 | Approved |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-18 |
| 最終レビュー日 | 2026-07-18 |

## 背景

利用者が別作業をしている間も、入力待ち、失敗、新規commit観測を短い音声で知れると状況把握負担が下がる。また「詳しく教えて」で生成したcommit説明をcharacter captionへstreamし、希望時だけ同じ文を読み上げれば、視覚・聴覚のどちらでも追える。ただし、頻繁な発話、古いworkspaceの音声、外部送信、音声だけの通知は集中とprivacyを損なう。MVPはmacOS同梱の`/usr/bin/say`だけをoptional local adapterとして使い、外部TTS provider、API key、音声fileを必要としない。

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| 意味ある状態だけを伝える | active workspaceの入力待ち、失敗、新規commit、明示要求したcommit説明を字幕として表示する |
| 音声を完全に任意にする | TTSはdefault offで、mute・offline・local adapter failureでも字幕と操作が残る |
| privacyと鮮度を守る | bounded redacted transcriptだけを検証済みlocal processのstdinへ渡し、network/secret/audio fileを0件にしてstale/old workspace audioを再生しない |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| Narration policy | meaningful event、priority、dedupe、rate limit、queue、stale generation |
| Transcript | ja/en textをaudioより先に表示、caption/live region |
| TTS | macOS local `/usr/bin/say`、voice/rate、bounded process、text fallback |
| Playback | active workspaceだけ、mute即時、unmute後の新規発話だけ |
| Privacy | redacted textだけをstdinへ渡し、network、secret、audio fileを使用しない |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| microphone / speech input | privacyとscopeを限定する | text composer |
| always-on voice | quiet-by-default原則 | event-driven narration |
| audio archive/export | transcriptを正本とする | [Activity history](activity-history.md) |
| character voice cloning | 権利・同意・安全範囲を増やさない | 非対象 |
| system-wide daemon / hotkey | app内active workspace processへ限定する | 非対象 |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ローカル利用者 | TTS設定と再生を管理 | enable、voice、rate、mute、test、disable、reset | binary/voice/audio device失敗時も字幕を維持する |
| Narration policy | validated eventから短文を選ぶ | priority、dedupe、queue、generation判定 | stale、duplicate、low-priority burstを破棄する |
| Local TTS adapter | root所有かつ非writableと再検証した`/usr/bin/say`をshellなしで起動するnative境界 | 明示enable中のbounded text、exact allowlist voice、validated rateだけを受ける | 検証失敗時はprocessを起動せずcaptionを維持する |
| Audio player | active workspaceの`/usr/bin/say` process groupを管理する | single playback、interrupt、mute | workspace切替・mute・stop・closeで100ms以内に停止する |

## 機能要件

### Transcriptとevent policy

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `NARR-F-057` | appは意味あるeventから短いtranscriptを作る | waiting_for_user、error、commit_observed、disconnectedで1〜240文字のja/en transcriptを生成し、通常tool rowごとには生成しない。commit説明は`NARR-F-078`の確定chunkを使う | Approved | 非該当 |
| `NARR-F-058` | transcriptはaudioより先に表示される | narration event受理から300ms以内にvisible caption/timeline textを表示し、その後にだけlocal TTS processを開始する | Approved | 非該当 |
| `NARR-F-059` | narrationはactive workspaceだけへ適用される | workspace B選択中にAのeventが届いてもBのcaption/Live2D/audioへ表示・再生せず、Aのtimeline metadataへ記録する | Approved | 非該当 |
| `NARR-F-060` | stale narrationを破棄する | transcript generationがactive workspace generationと一致しない場合、TTS processとplaybackを開始しない | Approved | 非該当 |
| `NARR-F-061` | duplicate narrationを抑制する | 同じsemantic typeと正規化textが30秒以内に再発した場合、2件目以降を音声queueへ追加しない | Approved | 非該当 |
| `NARR-F-062` | narrationは発話頻度を制限する | 発話開始間隔を8秒以上、1分あたり6件以下にし、超過したlow-priority eventをまとめて1件のsummaryにする | Approved | 非該当 |
| `NARR-F-063` | high-priority eventは低優先音声を中断できる | waiting_for_user/errorがplaying中のprogress narrationを停止し、caption表示後500ms以内にhigh-priority requestをqueue先頭へ置く | Approved | 非該当 |

### TTS設定・再生・fallback

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `NARR-F-064` | TTSは初回とreset後に無効である | fresh profileとReset Audio Settings後にTTS toggleがoffで、`say` process、network request、audio fileが0件になる | Approved | 非該当 |
| `NARR-F-065` | local TTS binaryを起動ごとに検証する | executableをexact `/usr/bin/say`に固定し、regular file、owner UID 0、group/other write bit 0をvoice列挙・test・発話の直前に再検証する。違反時はshell/processを起動しない | Approved | 非該当 |
| `NARR-F-066` | 利用者はvoiceとrateをpreviewできる | enableと検証済みvoice選択後にvisibleな固定sampleを再生し、rate倍率0.75〜1.25を基準180 words/minuteの135〜225へ変換する。cancel/timeout時に設定入力を保持する | Approved | 非該当 |
| `NARR-F-067` | local adapter失敗はtext fallbackになる | binary missing/tampered、voice unavailable、spawn/stdin/exit error、audio deviceなし、5秒test timeoutの各場合にaudio unavailableを表示し、captionとmain turnを維持する。offlineは失敗条件にしない | Approved | 非該当 |
| `NARR-F-068` | muteは現在の音声を即時停止する | mute操作後100ms以内にactive process groupを終了し、queueをclearし、captionを消去しない | Approved | 非該当 |
| `NARR-F-069` | unmuteは過去音声を再生しない | mute中に発生したeventをunmute後に再生せず、unmute後の次eventからだけqueueへ追加する | Approved | 非該当 |
| `NARR-F-070` | workspace切替とapp終了は再生を停止する | workspace switch、turn stop、app closeの各操作後100ms以内にactive process groupとqueueを停止し、旧workspace audioが再開しない | Approved | 非該当 |
| `NARR-F-071` | queueは古い音声を蓄積しない | waiting/queued合計を3件以下にし、4件目追加時は最古のlow-priority項目を破棄してmetadataを記録する | Approved | 非該当 |

### Privacy・accessibility・言語

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `NARR-F-072` | local processへredacted transcriptだけを渡す | scalar count 1〜240、NULなし、secret/path redaction済みtextをstdinだけへ書き、command line、environment、file、networkへ本文を渡さない。引数は`-v <exact allowlist voice> -r <validated integer>`だけで、shell、`-f`、`-o`、`-n`、`-a`を使用しない | Approved | 非該当 |
| `NARR-F-073` | generated audioを永続化しない | `say`のaudio outputをsystem outputへ直接再生し、temporary/output fileを作らず、app DB/artifact/logにaudio byteが残らない | Approved | 非該当 |
| `NARR-F-074` | narrationは音声なしでも理解できる | TTS off、mute、screen reader、audio deviceなしの各状態で同じtranscript、priority icon、workspaceを確認できる | Approved | 非該当 |
| `NARR-F-075` | appはja/enに対応するvoiceを選ぶ | 検証済みbinaryの`-v '?'`出力をboundedにparseし、`ja_JP`または`en_*`のinstalled voice名をexact allowlistとして候補表示する。保存voiceも発話直前のallowlistへ完全一致しなければTTSをdisabledにしてtext fallbackを使う | Approved | 非該当 |
| `NARR-F-076` | appはnarrationでnetwork/microphoneへアクセスしない | capability manifestとruntime testでnarration由来のnetwork request、microphone capability/requestが0件になる | Approved | 非該当 |
| `NARR-F-077` | 利用者はTTS testをcancelできる | test playbackまたは起動待ち中にCancelすると100ms以内にprocess groupを停止し、保存済み設定を変更しない | Approved | 非該当 |

### Commit explanation caption

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `NARR-F-078` | commit説明の確定chunkをcharacter captionへstreamする | redaction/schema検査済みdeltaをsequence順に1chunkずつvisible captionへ表示し、summary、changes、reasons、verification、impact、cautions、howToReadNextをja/enで追える。Live2D canvasだけへ描画しない | Approved | 非該当 |
| `NARR-F-079` | TTSはcaptionと同じchunkだけを読む | TTS enabledかつunmutedの時だけ、captionへ確定した同一text・同一sequenceをlocal adapterのstdinへ渡し、音声用の追加要約・言い換え・evidence再送を0件にする | Approved | 非該当 |
| `NARR-F-080` | TTS無効・失敗時もcaptionを維持する | TTS off、mute、binary/voice unavailable、process error、audio deviceなしの各状態で説明captionを全件表示し、説明request自体を失敗扱いにしない | Approved | 非該当 |
| `NARR-F-081` | stale/cancel後の説明を適用しない | workspace generation、selected commit、request IDの不一致、Cancel後のdeltaをcaption/live region/TTSへ適用せず、current captionをcanceled/unavailable textでterminal化する | Approved | 非該当 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| Audio | TTS enabled | off | 必須 | boolean | 不正値はoff |
| Audio | voice | locale既定 | 条件付き | 発話直前のinstalled exact allowlist候補 | TTS無効、caption維持 |
| Audio | rate | 1.0 | 必須 | 0.75〜1.25、0.05刻み。nativeでは180倍をroundした135〜225 words/minute | 1.0へ戻し理由表示 |
| Audio | mute | false | 必須 | boolean、workspace非依存global | 不正値はmutedへfail closed |

## デスクトップ固有要件

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | macOS 14以降のroot-owned `/usr/bin/say`とsystem audio output | `NARR-F-065`, `NARR-F-068` |
| ウィンドウ生成・再利用 | S-002のmuteとS-004設定を同一stateで再利用 | `NARR-F-068`, `NARR-F-069` |
| 閉じる・アプリ終了 | process groupとqueueをbounded cancelしaudio fileを残さない | `NARR-F-070`, `NARR-F-073` |
| 未保存データ | voice/rateの未保存入力はdialog cancelで破棄 | `NARR-F-066` |
| ローカルデータ | owner-only atomic settingsとtranscript metadataだけを保存し、audioはDB/fileへ保存しない | `NARR-F-064`, `NARR-F-073` |
| オフライン | local TTSを継続でき、network requestは常に0件 | `NARR-F-067` |
| ファイル・OS操作 | fixed system binaryをshellなしで起動し、temporary/output audio fileを作らない | `NARR-F-065`, `NARR-F-072`, `NARR-F-073` |
| メニュー・ショートカット | mute buttonは27px visual、24px以上hit area、aria-pressed | `NARR-F-068` |
| Deep Link・ファイル関連付け | 非該当 | 非該当 |
| 通知 | caption/live regionを正本、音声は補助 | `NARR-F-058`, `NARR-F-074` |
| Capability・認可 | narration network capabilityとmicrophoneを持たず、fixed `say` process/audio outputだけ | `NARR-F-064`, `NARR-F-072`, `NARR-F-076` |
| アップデート・互換性 | binary metadataとinstalled voice listを実行時に再検証 | `NARR-F-065`, `NARR-F-075` |

## 画面・UI

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-002` | コーディングワークスペース | `NARR-F-057`〜`NARR-F-063`, `NARR-F-068`〜`NARR-F-075` | 変更 | [画面詳細仕様](../screen-design/S-002_coding-workspace.md) |
| `S-003` | セッション証拠 | `NARR-F-078`〜`NARR-F-081` | 変更 | [画面詳細仕様](../screen-design/S-003_session-evidence.md) |
| `S-004` | 設定・診断 | `NARR-F-064`〜`NARR-F-077` | 変更 | [画面詳細仕様](../screen-design/S-004_settings-diagnostics.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | root-owned/non-writable binary再検証、shellなし、exact voice allowlist、validated rate、bounded stdinを強制する |
| 権限 | fixed local processとaudio outputだけ。network/microphone capabilityを持たない |
| プライバシー | default off、explicit enable、secret不要、audio非永続、source/path非送信 |
| 監査・ログ | transcript ID、event ID、priority、process status、latency、drop reasonを記録し、transcript本文/audio/stdout/raw stderrを記録しない |
| 性能 | caption 300ms、mute/stop 100ms、test timeout 5秒、queue 3件、発話間隔8秒 |
| 信頼性・復旧 | binary/voice/process/audio errorでcaption fallback、workspace switchで旧process group停止 |
| アクセシビリティ | visible caption、polite/assertive live regionのpriority分離、aria-pressed、音声非依存 |
| 多言語・地域 | ja/en transcriptとvoice filter、user content/pathは翻訳しない |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| SUP | validated narration summary | 解決済み（相互参照確認済み） | unavailable時はdeterministic transcript |
| GIT | selected commit、explanation request、redacted evidence | 解決済み（typed contract） | invalid/stale時はcaptionをfail closed |
| LIVE | lip-sync/operational state | 解決済み（相互参照確認済み） | renderer failureでもcaption/audio継続可能 |
| HIST | transcript/usage metadata、audio非保存 | 解決済み（相互参照確認済み） | persistence failureでもplayback後audio削除 |
| macOS local speech | `/usr/bin/say` metadata、installed voice list、system audio output | 解決済み（optional local境界） | unavailable時text fallback |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| installed voice差分 | `ja_JP` / `en_*`を実行時列挙しexact allowlist化、default off | release hostでvoice availabilityを再検証する | いいえ |
| lip-sync精度 | MVPはprocess playing中のsemantic speaking stateだけを連動し、失敗/停止時neutral | Hiyori実機QAで開始・停止遅延を確認する | いいえ |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [PRODUCT.md](../../PRODUCT.md) | quiet-by-default、音声非依存 |
| [DESIGN.md](../../DESIGN.md) | mute control、Live2D state、motion |
| [体験設計](../research/02-experience-design.md) | active workspaceとmeaningful narration |
| [セキュリティ調査](../research/09-security-privacy.md) | process、redaction、least privilege |
| [macOS local narration実測](../research/macos-local-narration-runtime.md) | `/usr/bin/say`のmetadata、stdin、voice、rate契約 |

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 2026-07-18 |
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
