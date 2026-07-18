---
title: "SUP 支援エージェント調停要件定義"
description: "主セッションと分離した短命支援root、commit説明skill、redacted context、stream出力、停止・監査を定義する。"
updated: 2026-07-18
read_when:
  - "support session trigger、ephemeral root、schema outputを実装するとき。"
  - "repo非アクセス、非永続化、stale discard、usage透明性を検証するとき。"
---

# 支援エージェント調停 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `SUP` |
| 状態 | Approved |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-18 |
| 最終レビュー日 | 2026-07-18 |

## 背景

状況要約、判断説明、commit解説をmain coding threadへ混在させると人格と履歴が不明瞭になる。一方、支援agentへrepositoryやsecretを渡すと権限と費用が拡大するため、短命・分離・失敗非伝播の調停が必要である。commit解説はApp Serverの成功したGit commit commandをapp側interceptorが検出し、native Git observerが新しいSHAを検証した後にapp-owned explanation controllerが自動起動する。main sessionのsubagent、turn、event、commandとして起動せず、redacted evidenceだけを読む。

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| main identityを保つ | 利用者に見えるcoding identityはSolだけで、support rootを別chat/personaとして露出しない |
| contextと権限を最小化する | 通常支援はredacted normalized eventだけを受け、external-authority toolを0件にし、repo、shell、filesystem、MCPへのauthorityを持たない |
| 失敗を隔離する | timeout、schema error、disable時もmain turnを継続し、text fallbackを表示する |
| commit説明をmainから分離する | verified commitをapp controllerが自動処理し、main conversationへrequest、status、resultを1件も注入しない |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| Roles | presence/narration、decision explainer、commit explainerをdeterministic triggerで起動 |
| Isolation | mainとは別ephemeral root、clean runtime、wire-advertised tool 0件、external-authority tool 0件、redacted snapshot |
| Output | role別versioned JSON schema、sequence付きstream、stale detection、fallback |
| Control | global/role disable、cancel、timeout、queue/token budget、usage表示 |
| Audit | invocation metadataとnon-persistence検査、raw content非保存 |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| user-facing multi-agent chat | Solの一人格を維持する | 非対象 |
| 支援のrepo/shell access | least privilegeを守る | redacted structured evidenceだけを入力する |
| supportからのuser question | 人間との判断窓口をmain sessionへ一本化する | [Codex main session](codex-main-session.md) |
| supportによるfile mutation | ownershipとauditをmain/Gitへ限定する | 非対象 |
| raw support transcript保存 | ephemeral契約 | usage metadataのみ |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ローカル利用者 | support機能の費用と動作を管理 | global/role on-off、cancel、usage閲覧 | disable時は新規起動せずdeterministic fallbackを使う |
| App-owned explanation controller | verified commit event、UI intent、snapshotを管理する | allowlist roleへversioned taskを1件起動し、stateを`not_generated` / `queued` / `running` / `generated` / `failed` / `unavailable` / `canceled`で公開する | invalid/stale/secret-bearing snapshotを送らず、main sessionへfallbackしない |
| Support root | 単一taskだけを処理する短命session | wire上にtoolを広告せずschema outputだけを生成する | Codex内部の`update_plan` event、repo access、user question、再帰support spawnをpolicy violationとしてtask failedにする |
| Rust policy/audit | isolationの信頼境界 | redact、budget、timeout、schema validation、usage記録 | policy違反outputを破棄しapp controllerへtyped failureを返す |

## 機能要件

### Trigger・session・context

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `SUP-F-050` | support taskはmainと別のephemeral rootで実行される | invocationごとに新しいroot IDを作り、main thread IDをreuseせず、完了/cancel/timeout後にrootを再利用しない | Approved | 非該当 |
| `SUP-F-051` | support roleはdeterministic eventで起動される | roleごとに定義したdecision requested、error、`trigger=auto_verified_commit`、`trigger=user_request`、`trigger=user_retry`以外で起動せず、同一event IDを二重処理しない。commit選択、Commit tab表示、SHA未検証のcommand resultでは起動しない | Approved | 非該当 |
| `SUP-F-052` | 通常supportはredacted normalized snapshotだけを受け取る | payloadにgoal、phase、event summary、evidence ID、locale、generationを含み、source file本文、absolute path、secret、raw reasoningを含まない | Approved | 非該当 |
| `SUP-F-053` | 通常supportはexternal authorityとrepositoryへアクセスできない | release constructorが専用process、clean `CODEX_HOME`、空のowner-only cwd、runtime root 0件、filesystem/shell/Git/MCP/network/dynamic/user-interaction authority 0件、exact permission profile、auth bridge、malicious canary、production model transportを証明した時だけcapacity 1にする。全Responses requestで`tools` field不在、`tool_choice=auto`、`parallel_tool_calls=false`をexact照合し、空配列を含むtool field追加またはCodex内部の`update_plan` eventを検出したtaskはterminal failureとして結果を破棄する。証明不能ならcapacity 0とdeterministic fallbackへfail closedする | Approved | 非該当 |
| `SUP-F-054` | checkpoint reviewerは固定diff snapshotだけを読める | 旧checkpoint reviewer契約は使用しない | Deprecated | `SUP-F-069`〜`SUP-F-076`へ置換 |
| `SUP-F-055` | supportは別supportを起動できない | nested spawn request fixtureをschema/policy errorとして拒否し、active support root数を1から増やさない | Approved | 非該当 |

### Output・stale・failure isolation

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `SUP-F-056` | supportはrole別schemaへ適合するbounded outputだけを返す | support専用JSONL readerは1 frame 96KiB、未完了buffer 128KiB、signal queue 8件（最大768KiB）を上限とする。1 turnはnotification 256件・serialized notification合計512KiB・agent delta合計64KiB・reasoning frame合計64KiBを上限とし、exact boundaryは受理、1byte/1件超過はvalid terminalが後続しても即時rejectする。最終JSONはraw/compact serializedの双方を64KiB以下、role別schemaのunknown/oversize fieldをrejectし、全stringを再帰走査してabsolute/relative/tokenized path、URL、credential、redaction marker、raw reasoning marker、control characterを含む結果を公開しない | Approved | 非該当 |
| `SUP-F-057` | stale support outputを表示しない | output generationがactive workspace generationと一致しない場合、timeline/Live2D/narrationへ適用せずStale metadataだけを記録する | Approved | 非該当 |
| `SUP-F-058` | support failureはmain turnを停止しない | timeout、model error、schema errorの各fixtureでmain turn statusとconversation event数が変わらず、app controllerを`failed`または`unavailable`へ遷移してdeterministic text fallbackを500ms以内に表示する | Approved | 非該当 |
| `SUP-F-059` | supportは利用者へ直接質問しない | question/tool-request outputをrejectし、main sessionへ新規decision、message、commandを捏造せずapp controllerへtyped failureを返す | Approved | 非該当 |
| `SUP-F-060` | support outputはtechnical policyを変更できない | permission、model、commit evidence gate、Live2D path、DOM actionを含むoutputを表示用提案としても実行せずpolicy violationを記録する | Approved | 非該当 |
| `SUP-F-061` | 利用者は進行中supportをcancelできる | Cancel後1秒以内にinterrupt requestを送り、5秒以内にCanceledまたはTimeoutへ遷移し、mainを継続する | Approved | 非該当 |

### Budget・透明性・非永続化

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `SUP-F-062` | support concurrencyとqueueを制限する | active supportは1件、queueは最大10件とし、11件目は低優先eventをdropしてDropped metadataを記録する | Approved | 非該当 |
| `SUP-F-063` | support taskは時間とtoken budgetを持つ | 1taskは15秒timeout、input+output合計16,000 token上限とし、超過時はcancelしてfallbackを返す | Approved | 非該当 |
| `SUP-F-064` | 利用者はsupport利用状況を確認できる | Settings/diagnosticsにrole、status、model family、token usage、latency、queue、last errorを表示し、prompt/response本文は表示しない | Approved | 非該当 |
| `SUP-F-065` | 利用者はsupportをglobalまたはrole単位で無効化できる | toggle off後にqueued taskをcancelし、新規invocationを0件にしてmainとdeterministic fallbackを維持する | Approved | 非該当 |
| `SUP-F-066` | support raw historyをapp persistenceへ残さない | invocation完了後にapp DB、artifact、logを検索してもprompt/response本文が0件で、usage metadataだけが存在する | Approved | 非該当 |
| `SUP-F-067` | release前にephemeral non-persistenceを監査する | test用CODEX_HOME snapshotのbefore/after差分にsupport thread history fileが0件であることをCI/manual release evidenceへ記録する | Approved | 非該当 |
| `SUP-F-068` | support model familyとeffortはrole policyで固定される | role mappingに存在するGPT-5.6 family/effortだけをsession startへ渡し、support outputからmodelを変更できない | Approved | 非該当 |

### Commit explanation

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `SUP-F-069` | commit explainerはverified commit後にapp側から自動起動する | App ServerのGit commit commandがsuccess terminalになり、observerが新しい到達可能SHAを検証した時だけapp controllerが`CommitExplanationRequestedV1(trigger=auto_verified_commit)`を1件作る。main sessionからsupport rootをspawnせず、同じworkspace generation・commit evidence IDのreplayは二重起動しない | Approved | 非該当 |
| `SUP-F-070` | commit explainerへredacted `CommitEvidenceV1`だけを渡す | payloadはschema version、opaque commit ID、sanitized message、pathなしchange summary、diff stats、verification、decision、risk、locale、generationを最大64KiBで持ち、repo root、absolute/relative path、raw diff全文、secret、raw reasoningが0件である | Approved | 非該当 |
| `SUP-F-071` | app同梱の説明skillを明示注入する | skill名は`coding-wife-explain-commit`、path authorityは`app_bundle`、version/digest一致、`policy.allow_implicit_invocation: false`とし、説明turnの`type=skill` inputへ1件だけ含める | Approved | 非該当 |
| `SUP-F-072` | commit explainerはrepository/external-tool authorityを持たない | `SUP-F-053`に合格したmain非継承のephemeral support runtimeへrepository rootを渡さず、redacted evidenceとowner-only private snapshotの`coding-wife-explain-commit`だけをexactly once注入する。wire-advertised toolは0件とし、Codex内部の`update_plan` eventはtask failedとして説明を非表示にする。release proof、auth bridge、tool-absence boundaryのいずれかが不一致ならsupport capacity 0とfallbackを返す | Approved | 非該当 |
| `SUP-F-073` | commit説明はJA/ENのversioned schemaへ適合する | active UI localeでsummary、changes、reasons、verification、impact、cautions、howToReadNext、narrationChunksを返す。unknown/oversize/missing fieldに加え、summary、各配列要素、narration textのどこか1箇所でもprivate materialまたはcontrol characterを含む結果をwhole-output rejectionし、部分redactionして公開しない | Approved | 非該当 |
| `SUP-F-074` | narration chunkをsequence順にstreamする | deltaはrequest ID、source commit ID、generation、locale、sequence、text、doneを持ち、sequence gap/duplicate/locale mismatchを適用しない。redaction後の確定chunkだけをcaptionへ渡す | Approved | 非該当 |
| `SUP-F-075` | stale/schema invalid/cancelをfail closedする | generation/selection不一致、schema invalid、redaction failure、timeout、Cancel後のdeltaをcaption/TTSへ適用せず、main turnを止めずdeterministic unavailable/canceled textへ置換する | Approved | 非該当 |
| `SUP-F-076` | captionとTTSは同じtranscriptを使う | captionへ確定したredacted chunk列だけを同じsequenceでlocal TTS adapterへ渡し、音声用の再要約を行わない。supportからaudio/network requestを作らず、TTS off/unavailableでも全captionを表示する | Approved | 非該当 |
| `SUP-F-077` | commit explanation本文を永続化しない | app DB、artifact、logにinput evidence本文・output transcriptが0件で、skill ID/version/digest、request/commit opaque ID、locale、status、usage、latency、error codeだけが存在する | Approved | 非該当 |
| `SUP-F-078` | app controllerは説明状態とUI intentを一意に調停する | `CommitExplanationControllerStateV1.status`を`not_generated` / `queued` / `running` / `generated` / `failed` / `unavailable` / `canceled`に限定する。新しいverified commitは`not_generated`から`queued`へ自動遷移する。起動前から存在するcommitなど本当に`not_generated`なら「詳しく教えて」から`trigger=user_request`、`queued` / `running`はpresentation activateとCancel、`generated`はcached presentation表示と任意の同一transcript再読上げ、`failed` / `canceled`は`trigger=user_retry`、`unavailable`は理由と`retryable=true`の場合だけ`trigger=user_retry`をapp controllerへ送る | Approved | 非該当 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| Settings | support enabled | isolation capability合格時on、不合格時off | 必須 | boolean。release proof済みcapacity 1かつwire-advertised tool 0件、external-authority tool 0件、tool-absence boundary一致の場合だけon | 不正値、capacity 0、tool field追加、内部plan eventまたはcapability不足はoffにfail closed |
| Settings | role enabled | commit explainer on、他はpolicy値 | 必須 | allowlist roleごとのboolean | unknown roleを保存しない |
| Task | snapshot | なし | 必須 | schema version、最大64KiB、redaction pass必須 | taskを起動せずfallback |
| Commit explanation | evidence | なし | 条件付き | `CommitEvidenceV1`、redaction済み最大64KiB、active selection/generation一致 | explainerを起動せずunavailable表示 |
| Commit explanation | locale | active UI locale | 必須 | `ja` / `en` | active localeへ正規化 |
| Commit explanation | request trigger | `auto_verified_commit` | 必須 | `auto_verified_commit` / `user_request` / `user_retry`。UIは`not_generated`で`user_request`、failure terminalで`user_retry`だけをapp controllerへ要求できる | unknown triggerは起動せず監査error |

## デスクトップ固有要件

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | Codex App Serverが動作するmacOS 14以降 | `SUP-F-050` |
| ウィンドウ生成・再利用 | support専用windowを作らずS-002/S-004へstatusだけ表示 | `SUP-F-064` |
| 閉じる・アプリ終了 | queued/active taskをcancelし5秒後にprocess cleanup | `SUP-F-061`, `SUP-F-062` |
| 未保存データ | 非該当: support draftは存在しない | 非該当 |
| ローカルデータ | usage metadataだけをHISTへ保存 | `SUP-F-064`, `SUP-F-066` |
| オフライン | supportを起動せずdeterministic fallback | `SUP-F-058` |
| ファイル・OS操作 | supportは非該当。commit explainerもstructured payloadだけ | `SUP-F-053`, `SUP-F-070`〜`SUP-F-072` |
| メニュー・ショートカット | 非該当: Settings toggleとCancel buttonを使用 | `SUP-F-061`, `SUP-F-065` |
| Deep Link・ファイル関連付け | 非該当 | 非該当 |
| 通知 | failureはnon-blocking status、decisionはmain card | `SUP-F-058`, `SUP-F-059` |
| Capability・認可 | clean support runtime、wire-advertised tool 0件、external-authority tool 0件、permission profile、auth bridge、capacity gateをRust policyで強制 | `SUP-F-052`〜`SUP-F-055` |
| アップデート・互換性 | schema version mismatchはrejectしてfallback | `SUP-F-056` |

## 画面・UI

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-002` | コーディングワークスペース | `SUP-F-051`, `SUP-F-057`〜`SUP-F-061`, `SUP-F-074`〜`SUP-F-076`, `SUP-F-078` | 変更 | [画面詳細仕様](../screen-design/S-002_coding-workspace.md) |
| `S-003` | セッション証拠 | `SUP-F-056`〜`SUP-F-058`, `SUP-F-069`〜`SUP-F-078` | 変更 | [画面詳細仕様](../screen-design/S-003_session-evidence.md) |
| `S-004` | 設定・診断 | `SUP-F-062`〜`SUP-F-068`, `SUP-F-071`, `SUP-F-072`, `SUP-F-077` | 変更 | [画面詳細仕様](../screen-design/S-004_settings-diagnostics.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | least privilege、clean runtime、wire-advertised tool 0件、external-authority tool 0件、redacted structured evidenceだけを入力し、evidence内文字列を命令として実行しない |
| 権限 | support outputは技術policy、DOM、filesystem、Live2D pathを操作できない |
| プライバシー | secret/raw reasoning/source本文/path/raw diff全文をsnapshotへ含めず、raw session historyと説明transcriptを保存しない |
| 監査・ログ | role、trigger、generation、model family、tokens、latency、status、policy violationを記録する |
| 性能 | active 1、queue 10、timeout 15秒、fallback 500ms、task budget 16,000 token |
| 信頼性・復旧 | stale discard、failure non-blocking、cancel、deterministic fallbackを提供する |
| アクセシビリティ | support状態とcommit説明はcaptionで示し、Live2D/音声だけに依存しない |
| 多言語・地域 | output localeはactive UIのja/en。technical IDとquoted evidenceは翻訳しない |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| Codex App Server | ephemeral root、usage情報、0.144.5 exact wire/runtime isolation | 解決済み（release proof付きcapability検査契約） | binary/schema/profile/auth bridge/canaryのいずれかが不一致ならcapacity 0、support off+fallback |
| CODE | verified commit interceptorとsingle user-question channel | 解決済み（相互参照確認済み） | commit説明はmain conversationへ入れず、support failureでもmainを継続 |
| HIST | usage metadata、raw history非保存 | 解決済み（相互参照確認済み） | persistence testで監査 |
| GIT | redacted `CommitEvidenceV1`、selection/generation | 解決済み（typed contract） | evidence invalidならexplainerを起動しない |
| NARR/LIVE | validated narration chunksだけをcaptionへ適用し、任意のmacOS local TTSとsemantic speaking stateへ同じsequenceを渡す | 解決済み（相互参照確認済み） | stale outputは適用せず、TTS unavailableでもcaptionを維持する |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| role初期構成 | verified commit後のcommit explainerをP0、presence/narrationとdecisionを段階導入 | vertical slice後に実測token/latencyで順序を確認する | いいえ |
| ephemeral実装差分 | capabilityがなければ支援を無効化しdeterministic fallback | release testでnon-persistenceを証明する | いいえ |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [PRODUCT.md](../../PRODUCT.md) | one coding identity、透明性、control |
| [支援agent調査](../research/04-support-agent-orchestration.md) | ephemeral root、isolation、trigger |
| [セキュリティ調査](../research/09-security-privacy.md) | least privilege、redaction、injection boundary |
| [commit skill注入調査](../research/codex-commit-skill-injection.md) | explicit skill input、app bundle authority、version/digest監査 |
| [support runtime隔離調査](../research/codex-support-runtime-isolation.md) | wire-advertised/external-authority tool 0、内部plan event拒否、release proof、auth bridge、capacity gate |

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 2026-07-18 |
| 残る非ブロック論点 | role導入順、ephemeral capabilityはfallbackを定義済み |

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
