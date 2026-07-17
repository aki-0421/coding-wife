---
title: "Codex App Server 接続契約と実装設計"
description: "Coding Wife がローカル Codex App Server を安全に起動し、固定モデルの主セッション、承認、構造化意思決定、レビュー、診断を扱うための版管理された接続契約を定義する。"
updated: 2026-07-18
last_verified: 2026-07-18
read_when:
  - "Codex App Server のプロセス管理、JSON-RPC、スレッド、ターン、承認、レビュー、診断を実装または変更するとき。"
  - "Codex CLI を更新し、プロトコル互換性とサポートセッションの隔離可否を再検証するとき。"
---

# Codex App Server 接続契約と実装設計

## 結論

2026-07-18 時点のローカル Codex CLI では、Coding Wife の主セッションに必要な次の経路を実装できる。

- stdio 上の JSONL による initialize / initialized。
- model/list による gpt-5.6-sol と low / max の実行時確認。
- thread/list、thread/start、thread/resume によるワークスペース単位の会話管理。
- turn/start、turn/interrupt と、turn / item 通知による実行制御。
- 3 種類の現行承認要求、実験的な requestUserInput、動的ツール要求への双方向応答。
- review/start によるインラインまたは分離レビュー。
- account/read、config/read とローカルプロセス情報を用いた、秘密を返さない診断。

ただし、Codex App Server 自体が実験機能であり、サーバーは交渉済み capability を initialize 応答へ列挙しない。したがって、CLI の版文字列だけを信用せず、その CLI 自身が生成した実験 API スキーマの fingerprint、initialize の成否、model/list の結果を組み合わせた feature detection が必要である。

サポートエージェントは現状 No-Go とする。ephemeral thread が rollout 一覧へ残らないことは確認できたが、同じ thread は絶対 cwd と 1 個の runtime workspace root を持った。dynamicTools を空にしても Codex 組み込みの shell、file、MCP 等が 0 個になることは証明できない。承認済み要件の「tool 0、cwd なし、ファイル・shell・MCP なし」を満たす明示的な thread 単位 allowlist も、今回の生成スキーマにはない。隔離 capability を将来証明できるまで、サポートセッション数は 0、決定的なローカル集約をフォールバックとする。

## 上位仕様と適用順

本書は次を実装可能な接続契約へ落とし込む補足調査である。

- ../../PRODUCT.md
- ../../DESIGN.md
- ../requirements/codex-main-session.md
- ../requirements/support-agent-orchestration.md
- ../requirements/activity-history.md
- ../screen-design/S-002_coding-workspace.md
- ../screen-design/S-003_session-evidence.md
- ../screen-design/S-004_settings-diagnostics.md
- ../screen-design/desktop-common-specification.md

競合時は Approved の要件・画面設計を優先する。特に、既存の 03-codex-integration.md にある requestUserInput から動的ツールや MCP elicitation へ順次フォールバックする案は採用しない。CODE-F-067 に従い、native requestUserInput が利用できない場合は通常の assistant 最終出力に含む版管理済み decision schema だけを許可する。自由文から質問や承認を推測しない。

## 調査方法と一次証拠

### 公式資料

最終確認日はすべて 2026-07-18 である。

| 資料 | 確認した内容 |
| --- | --- |
| OpenAI Codex App Server: <https://learn.chatgpt.com/docs/app-server> | JSON-RPC 2.0 から jsonrpc ヘッダーを省いた wire 形式、stdio JSONL、initialize / initialized、実験 API opt-in、版ごとのスキーマ生成 |
| OpenAI Codex App Server: <https://developers.openai.com/codex/app-server> | App Server を rich client 統合に使う位置づけ |
| OpenAI Codex models: <https://learn.chatgpt.com/docs/models> | gpt-5.6-sol の位置づけ、reasoning effort、Max と Ultra の意味 |
| OpenAI Codex source: <https://github.com/openai/codex/tree/main/codex-rs/app-server> | App Server が公開 Codex 実装の一部であること |

公式資料でも App Server と experimentalApi は変更可能性があると明記されている。個々の method と field の正本には、実際に起動するローカル CLI が生成したスキーマを使った。

### ローカル実体

PATH で最初に解決された実体:

- コマンド: /opt/homebrew/bin/codex
- canonical binary: /opt/homebrew/Caskroom/codex/0.144.5/codex-aarch64-apple-darwin
- codex --version: codex-cli 0.144.5
- SHA-256: 5e29ab10ca1171be158f7335dd6bd8ce1aaf9af1556939db36a5ee338be6f5f2
- 形式: Mach-O 64-bit arm64

PATH 上に別実体も存在した:

- コマンド: $HOME/Library/Application Support/com.conductor.app/bin/codex
- canonical version: codex-cli 0.144.1
- SHA-256: 29915529b97697def1a957b0505e770aa6a45744435d62fc263e98d7619e167a

この 2 本で experimental TypeScript schema を生成して再帰比較した結果、671 ファイルが一致した。版が近くても常に一致する保証にはならないため、実装は canonical path、CLI version、schema fingerprint を一組として扱う。

### スキーマ生成

確認に使ったコマンド:

~~~text
codex app-server generate-json-schema --out <temp>/json-stable
codex app-server generate-json-schema --experimental --out <temp>/json-experimental
codex app-server generate-ts --out <temp>/ts-stable
codex app-server generate-ts --experimental --out <temp>/ts-experimental
~~~

0.144.5 の主要 fingerprint:

| 生成物 | SHA-256 |
| --- | --- |
| experimental JSON Schema v2 bundle | 3fee65961a60bfe1fbbd5e36131ca9390f6b740d178e58e9ee155b4fa6ce5e62 |
| experimental ClientRequest.ts | ba1f52da673f4a64b730dcdf5c89a87ea45a82b4dc7c8686bde530a677ddb6a7 |
| experimental ServerRequest.ts | 1c5837adbfbdd005f387478ba87840808d1353b47b82dcf63739a78bb1c8d3be |
| experimental ServerNotification.ts | 9ed1f223e22f54dff50a57ba15a2e4046b516401dfdd14c0deac8ac3363c37b8 |
| experimental ThreadStartParams.ts | e0e0945689a416da27140bd466276a79e33d61539af1ad7ccaeb0dc792fb59a4 |
| experimental TurnStartParams.ts | b876212f33e15754db8242ce9367318c6ee3a96686216663a37869c40a8b3d7f |

stable と experimental の生成差分も確認した。dynamicTools、environments、runtimeWorkspaceRoots、allowProviderModelFallback 等の ThreadStartParams field は experimental 出力にのみ現れる。一方、ServerRequest の union には requestUserInput と item/tool/call が stable 出力にも含まれるが、requestUserInput の型コメント自体は EXPERIMENTAL である。ファイルの存在だけを capability の証明にしてはいけない。

### 読み取り専用の実接続確認

実アカウント情報、メール、設定値、CODEX_HOME の絶対パスは出力せず、必要な真偽値だけを投影した。

| 確認 | 0.144.5 の結果 |
| --- | --- |
| initialize、experimentalApi=true | 成功。user agent は 0.144.5、platformFamily=unix、platformOs=macos |
| account/read、refreshToken=false | account が存在し、OpenAI auth が必要であることだけ確認 |
| model/list、includeHidden=true | 8 件。gpt-5.6-sol が非 hidden で存在 |
| Sol の supportedReasoningEfforts | low、medium、high、xhigh、max、ultra |
| Sol の service tier | priority が列挙された。defaultServiceTier は null |
| config/read、includeLayers=false | 成功。値は公開せず、主要設定の有無だけ確認 |
| initialize 前の model/list | JSON-RPC code -32600、Not initialized 分類 |
| 同じ接続で initialize を再送 | code -32600、Already initialized 分類 |
| experimentalApi=false で experimental field を送信 | code -32600、experimental capability required 分類 |
| ephemeral thread/start | thread.ephemeral=true |
| ephemeral thread の thread/list | 対象 thread は列挙されなかった |
| 同じ ephemeral thread の cwd | 要求した絶対 workspace path が返った |
| 同じ ephemeral thread の runtimeWorkspaceRoots | 1 件 |
| stderr | 上記 probe では 0 byte |

0.144.1 でも initialize と model/list が成功し、Sol と同じ 6 effort を返した。モデルカタログはアカウント、時点、provider によって変わり得るため、この結果を製品へ固定値として埋め込まない。

## Coding Wife App Server Contract v1

### 目的

Rust 内部に wire protocol を閉じ込め、WebView へは Coding Wife 固有の型付き IPC と正規化済み DomainEvent だけを渡す。生成された OpenAI の巨大 union をそのままフロントエンド公開 API にしない。

CompatibilitySnapshotV1 は最低限次を持つ。

~~~text
adapterVersion: 1
binary:
  canonicalPathHash
  cliVersion
  executableSha256
schema:
  experimentalBundleSha256
  generatedBySameBinary
initialize:
  experimentalApiRequested
  experimentalApiAccepted
capabilities:
  coreLifecycle
  modelDiscovery
  nativeRequestUserInput
  dynamicTools
  permissionsApproval
  detachedReview
  ephemeralThread
  supportIsolation
~~~

各 capability は supported、unavailable、unverified の 3 値にする。supportIsolation は、必要条件をすべて証明した場合だけ supported にできる。型が存在する、エラーが出なかった、1 回 tool event が無かった、という消極的証拠では supported にしない。

### バイナリ選択

1. ユーザーが保存した明示パスがあればそれだけを候補にする。
2. 無ければ Rust 側で PATH と既知の安全なインストール位置を列挙する。GUI アプリの PATH とログイン shell の PATH が異なることを前提にする。
3. symlink を canonicalize し、通常ファイル、実行可能性、所有・書き込み権限、版、hash を確認する。
4. 同名の別バイナリへ黙って切り替えない。選択実体が消えた場合は診断状態を unavailable にする。
5. hash や schema fingerprint が変わったら capability cache を破棄し、再 probe する。

アプリは Codex auth ファイルを直接読まない。認証状態は account/read で取得し、ログイン開始が必要な場合だけ App Server の account/login/start を別要件として実装する。

### プロセス所有

- Rust が codex app-server --listen stdio:// を直接 spawn する。
- analytics-default-enabled は指定せず、App Server の既定 off を維持する。
- stdout は JSONL protocol 専用、stderr は診断専用として別 task で読む。
- stdin 書き込みは単一 writer task に直列化する。
- active workspace generation を全 request、pending call、normalized event に関連付ける。
- workspace 切替時は進行中 turn を止め、旧 generation の通知を UI と履歴へ流さない。
- schema に shutdown method は無い。終了は stdin close、最大 2 秒待機、SIGTERM、残り時間で待機、起動から 5 秒以内に process tree を強制終了する。

子プロセスへ渡す環境変数は allowlist 化する。ただし主 Codex がユーザーの開発ツールを実行できるよう、PATH、HOME、SHELL、locale、temporary directory、明示された CODEX_HOME と必要な proxy / certificate 変数は保持できる設計にする。値はログへ出さず、shell profile を暗黙 source しない。CODEX_ACCESS_TOKEN 等を許可する場合も名称だけを診断し、値は絶対に保持・表示しない。

### framing と resource limit

wire message は jsonrpc field を省いた JSON-RPC 2.0 で、stdio では 1 行 1 JSON object である。

推奨する防御値:

- 1 行: 16 MiB。超過時は protocol violation として接続を停止する。
- 未完行 buffer: 32 MiB。
- pending client request: 128。
- UI 通知 queue: 1,024。delta は itemId 単位で coalesce する。
- stderr ring buffer: redaction 前 64 KiB、診断保存時はさらに allowlist 投影する。
- initialize timeout: 5 秒。
- 通常 request timeout: 15 秒。turn 実行全体には固定 timeout を設けない。
- interrupt acknowledgement: 5 秒、その後の terminal notification: 10 秒。

これらは OpenAI の protocol 定数ではなく Coding Wife v1 の推奨値であり、fixture と負荷試験で調整する。上限超過した message の raw 本文は履歴へ残さない。

## JSON-RPC lifecycle

### 接続状態

~~~text
disconnected
  -> probing
  -> spawning
  -> initializing
  -> ready
  -> thread_ready
  -> turn_running
       -> waiting_for_approval
       -> waiting_for_decision
       -> interrupting
  -> thread_ready
  -> stopping
  -> disconnected
~~~

どの状態からも binary_missing、protocol_mismatch、auth_required、model_unavailable、transport_lost へ遷移できる。transport_lost 後に user turn を自動再送しない。

### 初期化順

1. 選択バイナリで --version と experimental schema generation を probe する。
2. App Server を spawn する。
3. initialize を 1 回だけ送る。
4. 実験 surface が必要で、schema probe が対応を示した場合は capabilities.experimentalApi=true を送る。requestAttestation は v1 では false。
5. initialize response を検証する。codexHome は Rust 内でも path alias に変換し、WebView へ渡さない。
6. initialized notification を送る。ローカル生成型に合わせ、params は送らない。
7. model/list を pagination 完了まで読む。
8. account/read を refreshToken=false で読む。
9. 必要な診断だけ config/read から allowlist 投影し、元 response は破棄する。
10. thread を resume または start する。

initialize response は accepted capability 一覧を返さない。experimentalApi=true の initialize 成功は実験 surface 全体の存在証明ではないため、method / field ごとの schema probe を併用する。experimental initialize が拒否された場合、同じ接続で再 initialize せず process を再起動し、stable core のみで初期化する。

### request / response correlation

- client request id は Rust が単調増加する u64 として採番する。
- server request id は string または number のまま lossless に保持し、応答時に同じ型と値を返す。
- response id が pending map に無い場合は unsupported response として隔離する。
- 同じ server request id の再送には、処理中なら同じ UI request を共有し、解決済みなら保存した同一応答を返す。異なる params なら protocol violation とする。
- JSON-RPC error の message と data は UI へそのまま出さず、code と method から内部 error code へ写像する。

## 固定モデルと reasoning preset

### preflight

model/list を全ページ取得し、id または model が厳密に gpt-5.6-sol の 1 件を選ぶ。次をすべて満たさなければ新しい turn を開始しない。

- gpt-5.6-sol が存在する。
- supportedReasoningEfforts に low が存在する。
- supportedReasoningEfforts に max が存在する。

UI の Fast は effort=low、Max は effort=max である。OpenAI 製品の Fast mode は service tier を変える別機能なので混同しない。Coding Wife は model、service tier、Ultra を切り替えない。

### outbound rule

- thread/start では model=gpt-5.6-sol を送る。
- experimental field が使える場合は allowProviderModelFallback=false を送る。
- turn/start でも model=gpt-5.6-sol と、選択 preset に対応する effort を毎回送る。
- serviceTier は thread/start と turn/start の双方で省略し、ユーザー設定を変更しない。
- collaborationMode と multiAgentMode は送らない。
- thread/start / resume response の model が一致しなければ turn を開始しない。
- model/rerouted で toModel が gpt-5.6-sol 以外になったら即座に turn/interrupt し、model_unavailable として終える。

ローカル probe では ephemeral thread/start response の reasoningEffort がユーザー既定の xhigh だった。thread 作成だけでは Fast / Max を固定できないため、effort は各 turn/start で必須にする。

## thread 管理

### 永続マッピング

Coding Wife の workspace record に、少なくとも次を保存する。

- workspaceId
- canonical workspace root の非可逆 ID
- Codex threadId
- thread を作成した CLI version と schema fingerprint
- model=gpt-5.6-sol
- 最後に確認した thread status と updatedAt

Codex の rollout path は unstable field であり、正本キーにしない。絶対 path を WebView や一般ログへ保存しない。

### 再接続

1. 保存済み threadId があれば thread/resume を第一候補にする。
2. threadId、model、cwd、approvalPolicy、sandbox、excludeTurns=true を送り、必要なら initialTurnsPage で直近 turn だけを得る。
3. response の threadId、model、canonical cwd を照合する。
4. 不一致、not found、互換性エラーの場合は既存 user input を再送せず、再接続失敗として UI に出す。

thread/list は復旧診断と一覧表示に使い、workspace cwd の exact filter と pagination を使う。cwd が同じという理由だけで最新 thread を自動採用しない。他クライアントが作った thread を誤接続するためである。

### 新規開始

thread/start の v1 allowlist:

- model
- allowProviderModelFallback
- cwd
- runtimeWorkspaceRoots
- approvalPolicy
- sandbox
- ephemeral=false
- environments
- dynamicTools
- threadSource

config、baseInstructions、developerInstructions、permissions profile 等をユーザー設定から無差別転送しない。response では model、cwd、approvalPolicy、sandbox、thread.ephemeral=false を検証する。

dynamicTools は thread/start にしか登録 field がなく、thread/resume には再登録 field が無い。再開後も登録が保たれることを公式資料と fixture で証明できるまでは、永続 main thread で dynamic tool を必須機能にしない。

## turn lifecycle

### turn/start

必須または v1 で使う field:

- threadId
- clientUserMessageId
- input
- model=gpt-5.6-sol
- effort=low または max
- outputSchema

clientUserMessageId は workspace 内で一意な UUID とし、送信ボタンの二重操作を同じ user message として抑止する。ただし App Server 切断後に同じ request を自動再送しない。

添付は承認済み要件に従う。

- workspace root 内の画像だけ localImage。
- その他の workspace file は mention。
- root 外、symlink escape、存在しない path は送らない。
- WebView から受け取った path は Rust で canonicalize し直す。

### terminal authority

- turn/start response と turn/started は開始確認である。
- item/completed が各 item の確定値である。
- turn/completed の status が turn の唯一の terminal authority である。
- turn/interrupt response は中断受付でしかない。status=interrupted の turn/completed を待つ。
- error notification の willRetry=true は中間状態であり、単独で failed にしない。
- transport が落ちて terminal notification を受け取れなかった場合は connection_lost を合成するが、completed や interrupted を捏造しない。

## server-initiated request

### 許可する承認 method

v1 が UI を出してよい承認 method は次の 3 個だけである。

- item/commandExecution/requestApproval
- item/fileChange/requestApproval
- item/permissions/requestApproval

生成 union に残る applyPatchApproval と execCommandApproval は legacy として扱い、v1 では許可しない。

共通検証:

- request id、threadId、turnId、itemId が現在の active generation と一致する。
- startedAtMs が安全な整数である。
- path は workspace alias へ変換し、raw absolute path を UI へ渡さない。
- availableDecisions がある場合、UI はその部分集合しか返さない。
- session scope や acceptForSession は明示選択時だけ返す。
- permissions 応答は要求された network / file system permission の部分集合に限定する。
- request 解決前に workspace が切り替わった場合は拒否し、旧 UI を閉じる。

unknown server request、未知 decision variant、params 不正では許可 UI を出さない。同じ id へ JSON-RPC method not found または invalid params error を返し、関連 turn を interrupt する。黙って accept、空 response、最も近い既知 enum への丸めはしない。

### requestUserInput

wire method は item/tool/requestUserInput で、型は EXPERIMENTAL である。使用条件:

1. 同じ binary の experimental schema に method と必要 field がある。
2. initialize で experimentalApi=true が受理された。
3. active thread / turn / item と request id を照合できる。
4. question schema が Coding Wife の UI 制約を満たす。

v1 は 1〜3 問、重複しない id、非空の header / question、2〜3 個の選択肢だけを受理する。secret input、選択肢の無い自由入力、未知 field に依存する質問、曖昧な Other は fail-closed にする。回答は question id から answers 配列への exact map とし、表示ラベル以外の値を合成しない。

不正 request では回答 UI を出さず、同じ id へ invalid params error を返して turn を interrupt する。autoResolutionMs があっても、v1 はユーザー選択を勝手に推定しない。

native requestUserInput が unavailable の場合は、turn/start の outputSchema に CodingWifeDecisionEnvelopeV1 の discriminated union を設定する。

~~~text
schemaVersion: 1
kind: result | decision_request
message: string
decision_request の場合:
  decisionId: string
  question: string
  options:
    - id: string
      label: string
      description: string
  allowFreeform: false
~~~

assistant の最終出力がこの schema を完全に満たす場合だけ decision UI を出す。Markdown、コードブロック、自然文から JSON らしき部分を抽出しない。approval はこの envelope で代替しない。

### dynamic tools

thread/start.dynamicTools は experimental field、実行要求は item/tool/call である。v1 の registry は次を強制する。

- tool 名、namespace、JSON Schema、handler を compile-time allowlist へ登録する。
- arguments を tool 固有 schema で検証してから handler を呼ぶ。
- threadId、turnId、callId の一意性と active generation を検証する。
- handler timeout、output size、画像 URL scheme を制限する。
- response は contentItems と success だけを返す。
- 未登録 tool、未知 namespace、不正 arguments は失敗 response にし、外部 command や任意 IPC へ変換しない。

protocol adapter 自体は汎用 shell、任意ファイル、任意 Tauri command を dynamic tool として登録しない。製品機能が具体的な意味 API を必要とするときだけ、別要件、脅威分析、fixture を追加する。dynamic tool を requestUserInput や approval のフォールバックにはしない。

## review/start

ローカル schema の契約:

- params: threadId、target、任意 delivery。
- target: uncommittedChanges、baseBranch、commit、custom。
- delivery: inline または detached。
- response: turn と reviewThreadId。

主セッションのレビューは、会話を汚染しにくい detached を既定にする。target は可能なら baseBranch または commit の構造化 variant を使い、custom instructions へ巨大 diff を埋め込まない。reviewThreadId の通知も通常 thread と同じ normalizer へ入れるが、main と review の役割を分ける。

固定 reviewer support session の代替として review/start を使ってはいけない。detached review も thread であり、tool 0、cwd なしを証明しない。最大 1 MiB の exact diff を受ける固定 reviewer は support isolation gate が通るまで 0 件とし、Git diff の決定的検証だけを実行する。

## event normalization

App Server notification には workspace 全体の単調 sequence が無い。Rust adapter が受信順に workspace generation ごとの sequence を付ける。source timestamp がある場合は別 field に保持し、occurredAt は adapter 受信時刻にする。

| wire | DomainEvent v1 | 永続化 |
| --- | --- | --- |
| thread/started、thread/status/changed | code.thread.status.changed | threadId を内部 alias 化して保存 |
| turn/started | code.session.status.changed=running、code.turn.started | 保存 |
| item/started | code.item.status.changed | type と alias だけ保存 |
| item/agentMessage/delta | code.message.delta | UI 用 in-memory、一定間隔で coalesce。raw delta は履歴へ逐次保存しない |
| item/completed agentMessage | code.message.completed | redaction 後の最終 text を保存 |
| turn/plan/updated | code.plan.updated | 構造化 step だけ保存 |
| turn/diff/updated | code.diff.updated | evidence store へ bounded に保存。一般ログへ出さない |
| command output delta | code.tool.output.delta | redaction 済み bounded 表示だけ。履歴は command category、status、exit code |
| fileChange/patchUpdated | code.file_change.updated | workspace-relative path と change kind |
| 3 種 approval request | code.approval.requested | method、対象 alias、選択結果。raw command / absolute cwd は保存しない |
| requestUserInput | code.decision.requested | 検証済み option と選択結果 |
| item/completed | code.item.completed | completed payload の allowlist 投影 |
| turn/completed | code.session.status.changed | completed / interrupted / failed を terminal 保存 |
| error、warning | code.session.diagnostic | error class、willRetry、detailRef |
| model/rerouted | code.model.violation | from / to model と reason。即 interrupt |
| 未知 notification / item / enum | code.protocol.unsupported | method hash、byte count、detailRef のみ |

reasoning item の summary / content、reasoning delta、rawResponseItem は WebView と永続履歴へ渡さない。experimentalRawEvents は false のままにする。unknown payload も raw のまま表示・保存しない。

delta を連結した値が completed item と一致するとは限らない。plan schema 自身もその非一致を許容しているため、確定履歴は item/completed と turn/completed を正本にする。

未知 notification はアプリ全体を即 crash させないが、影響する thread / turn の ingestion を一時停止し、unsupported placeholder と detailRef を出す。terminal 状態に影響し得る未知 method の場合は再接続まで turn を安全側で停止する。

## health と diagnostics

### 状態

CodexHealthV1:

- binary_missing
- binary_untrusted
- schema_unsupported
- initializing
- auth_required
- model_unavailable
- effort_unavailable
- ready
- disconnected
- protocol_mismatch

ready 条件:

- canonical binary が検証済み。
- initialize / initialized が成功。
- account/read が利用可能。
- model/list に Sol、low、max が存在。
- core lifecycle method が schema probe に存在。
- stdout reader と stdin writer が稼働。

nativeRequestUserInput、dynamicTools、detachedReview、supportIsolation は ready とは別の capability として表示する。supportIsolation が unavailable でも主セッションを止めない。

### 安全な診断 payload

WebView へ返してよいもの:

- app error code
- checkedAt
- operation
- recoverable
- CLI version
- binary source category
- schema fingerprint の先頭短縮値
- capability の 3 値
- model / effort の有無
- child state
- last successful handshake time
- detailRef

返してはいけないもの:

- auth token、API key、email
- config 全体、MCP env、instruction 本文
- CODEX_HOME と workspace の絶対 path
- raw stderr、raw JSON-RPC、raw prompt / response
- reasoning text

config/read は effective config と origins / layers を含み得る。Rust 内で modelConfigured 等の allowlist 真偽値へ投影し、元 object を WebView、履歴、通常ログへ渡さない。account/read も accountPresent、auth kind、requiresOpenaiAuth の安全な分類だけにする。

## failure と recovery

| 失敗 | 検出 | 動作 |
| --- | --- | --- |
| executable 不在 / 実行不可 | spawn 前 | binary_missing。別実体へ黙って fallback しない |
| hash / schema 変更 | startup probe | capability cache 破棄。未確認 advanced capability を無効化 |
| initialize timeout | 5 秒 | child 終了、1 回だけ新 process で再試行 |
| Not initialized / Already initialized | -32600 分類 | client state bug。自動 turn 再送なし |
| experimental rejection | -32600 分類 | process 再起動、stable core。advanced capability unavailable |
| auth 無し / unauthorized | account/read または TurnError | auth_required。login guidance |
| Sol 無し | model/list | model_unavailable。別 model へ変更しない |
| low / max 無し | model/list | effort_unavailable。該当 preset を隠すのでなく session を開始しない |
| model reroute | model/rerouted | interrupt、model_unavailable |
| malformed / oversized JSONL | parser / limit | protocol_mismatch、raw payload 破棄、child 再起動 |
| unknown server request | request allowlist | fail-closed error、turn interrupt |
| approval / decision response timeout | app timer | cancel / error、turn interrupt。許可を推定しない |
| child crash / EOF | reader | disconnected。pending を connection_lost、turn 自動再送なし |
| duplicate response / request | id map | 同一なら idempotent、内容差なら protocol_mismatch |
| interrupt ack のみ | response | terminal と扱わず turn/completed を待つ |
| review 失敗 | review turn terminal | main turn と gate を変更せず review_failed |
| support isolation 未証明 | capability probe | support session 0、決定的 fallback |

restart loop は指数 backoff と jitter を使い、短時間の連続 crash 3 回で自動 restart を止める。ユーザーが再確認を選ぶまで無限再起動しない。

## privacy と隔離

- Codex の auth lifecycle を再実装せず、auth.json を読まない。
- main prompt と assistant final message は製品要件に従って保存できるが、raw protocol、reasoning、support prompt / response は保存しない。
- stderr は秘密・絶対 path・token pattern を redaction してから bounded ring に入れる。
- thread / turn / item id は内部 alias に変換し、必要な相関だけ保存する。
- 添付 path は Rust で workspace containment を確認する。
- App Server の stdout をブラウザ console へ出さない。
- review diff は 1 MiB 上限、一般ログへ出さない。
- support audit は CODEX_HOME の前後 metadata hash を比較し、新規 rollout、session DB row、log 増分を検出する。ただし監査が通っても tool 0 の明示証明なしには capability を supported にしない。

## 実装とsupport gate

0.144.xのsupport隔離は未証明で`unavailable`とする。ファイル責務、fixture、通常gate、live smoke、隔離の実測表は[Codex runtime実装ガイド](codex-runtime-implementation.md)を正本とする。

## 採用判断

- 主 Codex セッション: Go。0.144.1 / 0.144.5 の今回の schema と実接続で必要 core を確認した。
- gpt-5.6-sol + Fast(low) / Max(max): Go。ただし起動ごとの model/list gate が必須。
- native requestUserInput: Conditional Go。experimentalApi、schema、厳密 validator、fail-closed が条件。
- dynamic tools: Mechanism only。汎用 tool は登録せず、具体的な意味 API ごとに追加審査する。
- detached review: Go。main thread と reviewThreadId を分離して追跡する。
- ephemeral support / fixed reviewer support: No-Go。tool 0、cwd なしを証明できない。
- transport 自動再送: No-Go。切断後の user turn は自動 replay しない。

次回再検証は Codex binary の canonical path、version、hash、experimental schema fingerprint のいずれかが変わった時、またはリリース候補作成時に行う。
