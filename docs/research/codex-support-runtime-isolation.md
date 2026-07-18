---
title: "Codex support runtime の実効権限ゼロ隔離調査"
description: "Codex 0.144.5 の専用 App Server で、モデル通信を維持したまま repository、shell、file、MCP、network 権限を持たない support turn を成立させる条件と実測を記録する。"
updated: 2026-07-18
last_verified: 2026-07-18
read_when:
  - "コミット解説などの support session を実装、再検証、または診断するとき。"
  - "Codex CLI、permission profile、support 用認証 bridge、wire tool-absence boundary を変更するとき。"
---

# Codex support runtime の実効権限ゼロ隔離調査

## 結論

Codex CLI 0.144.5 では、メインと別の App Server process、clean `CODEX_HOME`、空の実行環境、固定 permission profile、wire request の実測を組み合わせることで、support runtime を条件付きで実動できる。

production と同じ `gpt-5.6-sol`、effort `low`、完全な`CommitExplanationV1` output schemaを使った実wireでは、Responses requestの`tools` field自体が存在しなかった。`tools=[]`とは区別し、`tool_choice="auto"`、`parallel_tool_calls=false`と組み合わせたexact envelopeを合格条件にする。したがって権限境界は次の三つに分ける。

1. **wire-advertised tool 0**: 全Responses requestで`tools` fieldが不在である。空配列、unknown/additional tool、schema付きtoolへの変化をすべて拒否する。
2. **external-authority tool 0**: repository、shell、file、MCP、network、browser、image generation、plugin、subagent、user interactionを行えるtoolは0件である。
3. **Codex internal event policy**: wireへ広告されていなくても、modelが`update_plan`を返すと0.144.5 App Serverは`turn/plan/updated`を発火できる。このeventはexternal authorityを持たないが、app policyが即terminal failureとして結果を破棄し、main sessionは継続する。

release constructor は後述の native preflight をすべて通った時だけ support capacity を 1 にする。一つでも検証できない、またはtool field、tool choice、parallel flag、model、effort、output schemaが変わった場合はcapacityを0にし、決定的なunavailableを返す。開発版、release版、実機smokeでこのfail-closed条件を変えない。

本書は [Codex App Server 接続契約](codex-app-server-integration.md)にあった 0.144.x support isolation の No-Go 結論を、0.144.5 exact binary/source と追加 probe に基づいて更新する。

## 調査対象と一次証拠

### 公式資料

最終確認日は 2026-07-18 である。[OAI-08](SOURCES.md#oai-08)を一次証拠とした。

- Permission profile は Codex がローカルで実行する command の filesystem / network 境界である。connector、MCP、built-in browser、Computer Use、Codex cloud は別の制御が必要である。
- macOS では Seatbelt profile で強制し、選択 policy を強制できない場合は unsandboxed 実行へ落とさず command を拒否する。
- filesystem table の missing / empty は restricted のままで startup warning を出す。network は `enabled = false` が既定である。
- App Server の `thread/start.environments=[]` は environment access を無効にし、`runtimeWorkspaceRoots=[]` は `:workspace_roots` の runtime root を空にする。

Permission profile は beta である。文書だけを永続的な互換性保証にせず、binary、generated schema、実 wire を release constructor で再確認する。

### 0.144.5 exact source

公式 tag `rust-v0.144.5` の peeled commit は `87db9bc18ba5bc82c1cb4e4381b44f693ee35623` である。次を確認した。

| source contract | 0.144.5 の挙動 | 製品判断 |
| --- | --- | --- |
| `features.shell_tool` | stable、既定 true | clean config で explicit false |
| shell tool type | `shell_tool=false` なら `Disabled` | shell handler を登録しない |
| environment-dependent tools | environment 0 件なら shell、apply_patch、view_image を登録しない | thread / turn の双方で `environments=[]` |
| core utility | `PlanHandler` は内部handlerとして残る | production wireではtoolを広告しない。`turn/plan/updated`が発火したらapp policyでterminal rejection |
| request user input | config 未指定は enabled | explicit disabled |
| MCP resource / runtime tools | MCP context がある時だけ登録 | clean `CODEX_HOME` に MCP 定義を置かず、orchestrator MCP も off |
| dynamic tools | request の列挙分だけ登録 | `dynamicTools=[]` |
| collaboration tools | multi-agent feature に依存 | multi-agent / fanout off |
| orchestrator skill tools | orchestrator skill provider が有効な時に登録 | orchestrator skills off。明示 skill input だけを別経路で注入 |
| thread response | active permission profile、runtime roots、approval policy を返す | request と exact 一致しない時は fail closed |

`web_search="disabled"`、apps、plugins、image generation、goals、request permissions、bundled skill discovery も explicit off にする。未指定値の既定へ依存しない。

### ローカル実体

| 項目 | 実測値 |
| --- | --- |
| OS / architecture | macOS 26.2（Build 25C56）/ arm64 |
| CLI | `/opt/homebrew/bin/codex` |
| canonical binary | `/opt/homebrew/Caskroom/codex/0.144.5/codex-aarch64-apple-darwin` |
| version | `codex-cli 0.144.5` |
| binary SHA-256 | `5e29ab10ca1171be158f7335dd6bd8ce1aaf9af1556939db36a5ee338be6f5f2` |
| canonical generated-schema fingerprint | `efea5c6649ccbae7e26af47874bca302e0803d6db80571d57cd55841890dddbc` |
| exact official source | `rust-v0.144.5` / `87db9bc18ba5bc82c1cb4e4381b44f693ee35623` |

schema fingerprintはrelative file pathとsemantic JSONから計算する。object keyだけを再帰的にsortし、array順序、`required`順序、値型は保持する。0.144.5のschema generatorが同じ意味のobjectを異なるkey順で出力してもfingerprintが揺れず、意味が変われば不一致になる。binaryは512MiB、hash phaseは20秒、schema file/treeと生成commandも個別上限を持ち、EOF・identityを再検証する。

## clean support configuration

probe は owner-only `0700` run directory の下に、`0700` の `codex-home`、空 workspace、temporary directory を作った。`config.toml` は `0600` とした。main の config、MCP、plugins、skills catalog、hooks、workspace instruction を継承していない。

中核設定は次のとおりである。

~~~toml
approval_policy = "never"
default_permissions = "coding-wife-support-zero"
web_search = "disabled"

[shell_environment_policy]
inherit = "none"
ignore_default_excludes = false

[tools.experimental_request_user_input]
enabled = false

[orchestrator.skills]
enabled = false

[orchestrator.mcp]
enabled = false

[skills]
include_instructions = false

[skills.bundled]
enabled = false

[features]
shell_tool = false
multi_agent = false
apps = false
plugins = false
image_generation = false
goals = false
enable_fanout = false
request_permissions = false
default_mode_request_user_input = false

[permissions.coding-wife-support-zero]
description = "No tool authority support runtime"

[permissions.coding-wife-support-zero.filesystem]
":minimal" = "read"

[permissions.coding-wife-support-zero.network]
enabled = false
~~~

`:minimal` は shell が再出現した場合の OS sandbox probe を成立させるための runtime path 読取だけである。repository、main `CODEX_HOME`、support `CODEX_HOME`、support workspace を filesystem grant に含めない。tool command の network は disabled である。Responses model transport は App Server host process が行い、この command sandbox の network permission とは分離する。

thread / turn の outbound field は次を必須にする。

~~~text
thread/start:
  ephemeral = true
  approvalPolicy = never
  permissions = coding-wife-support-zero
  environments = []
  runtimeWorkspaceRoots = []
  dynamicTools = []
  selectedCapabilityRoots = []
  cwd = <empty owner-only support workspace>

turn/start:
  approvalPolicy = never
  permissions = coding-wife-support-zero
  environments = []
  runtimeWorkspaceRoots = []
  outputSchema = <exact app-owned schema>
~~~

App Server は `cwd` を必須の absolute path として返すため「cwd 文字列 0」にはできない。代わりに repository と無関係な空の `0700` workspace を唯一の cwd とし、runtime workspace root は 0 件にする。

## mock Responses wire probe

### production-equivalent正常probe

clean `CODEX_HOME` の App Server をloopbackのmock Responses providerへ接続した。model IDはproductionと同じ`gpt-5.6-sol`、effortは`low`、skillは検証済みbytesをprivate run directoryへ`0600`で複製したsnapshot、output formatは完全な`CommitExplanationV1` schemaである。mock transportはrequest bodyを捕捉し、schema-validな日本語assistant messageをSSEで返した。実authやrepository内容は使用していない。

結果:

| assertion | 結果 |
| --- | --- |
| initialize / initialized | pass |
| thread active permission profile | `{id: coding-wife-support-zero, extends: null}` |
| thread approval policy | `never` |
| thread runtime workspace roots | `[]` |
| Responses transport | shell拒否後を含む2 request、schema-valid explanationでturn `completed` |
| wire model / effort | `gpt-5.6-sol` / `low` |
| wire `parallel_tool_calls` | `false` |
| wire `tool_choice` | `auto` |
| wire `tools` | field不在、advertised tool 0件 |
| tool-absence audit fingerprint | `d80288c65b8499fb7955ab8447dbcf86d925420f50a01570d26d28e776d8a393` |
| full output schema SHA-256 | `c01cb830b87c827b22842342f0410657b259ccbd113e3db05bd988ff48e4f3c9` |

tool-absence fingerprintは監査用sentinel `{"toolsField":"absent"}` のSHA-256であり、wireにこのobjectを送るものではない。release preflightは実requestで`tools` keyが存在しないことを直接検査するため、`tools=[]`も不一致である。全captured requestでmodel、tool choice、parallel flag、完全なoutput schemaもexact一致させる。

### malicious model fixture

advertised tool 0件の同じproduction envelopeで、mock modelが未広告の`shell_command` function callを返し、次を一つのcommandで試みるfixtureを実行した。

- repository canary file の読取。
- support `CODEX_HOME` 内 auth canary file の読取。
- loopback HTTP canary への接続。
- support workspace への marker 作成。

App Server はcommandを実行せず、次のmodel requestへ`unsupported call: shell_command`を返した。その後にschema-valid explanationが完了した。canary markerのmodel requestへの混入、HTTP request、filesystem markerはすべて0件だった。

### internal update_plan policy probe

正常probeと別turnでmock modelが`update_plan` function callを返した。`tools` fieldは引き続き不在だったが、0.144.5 App Serverは`unsupported call`ではなく`turn/plan/updated`を発火した。これはsource上のinternal `PlanHandler`と一致する。app policyはこのeventをexpected rejectionとして検出し、assistant resultを公開せずsupport processを停止した。main history、main turn、public explanation、repository/auth/network/write canaryはいずれも0件だった。

### permission profile の OS enforcement probe

同じ profile を `codex sandbox -P coding-wife-support-zero` へ直接適用し、上記 command を実行した。shell process 自体は起動したが、repository/auth canary の本文、HTTP canary、write marker はいずれも得られず、exit code 1 だった。これは tool 非登録とは独立した defense-in-depth である。

このprobeは「一度偶然tool callが無かった」という消極的証拠ではない。実wireのtool field不在、未広告shell callの拒否、internal plan eventのapp側terminal rejection、Seatbelt policyの拒否を別turnで確認している。

## release constructor の証明順

support runtime の release constructor は次を順番に実行する。途中失敗時は support process を残さず capacity 0 を返す。

1. Codex binary をno-follow / canonical path / owner / write mode / executable / version / SHA-256 / generated schemaで再検証する。binary hashは512MiB・20秒、schema生成と読取はfile/tree/command上限でfail closedする。
2. binary SHA-256、canonical generated-schema fingerprint `efea5c66…dddbc`、OS buildをkeyにnative isolation preflightを実行する。未検証cacheを成功扱いしない。
3. `0700` probe run directory と clean `CODEX_HOME` を作り、`0600` config と loopback mock providerを使う。auth は probe に渡さない。
4. 検証済みexplain skill bytesをprobe rootへprivate snapshotし、productionと同じmodel、effort、skill、full output schemaのexact thread / turnを開始する。`activePermissionProfile`、approval、runtime roots、ephemeral、model、providerを照合する。
5. 全captured Responses requestで`tools` field不在、`tool_choice=auto`、`parallel_tool_calls=false`、`model=gpt-5.6-sol`、full output schema hash `c01cb830…f3c9`を照合する。空配列を含むtool field追加を拒否する。
6. 正常turnでmalicious shell callがunsupportedになり、schema-valid explanationが完了し、read 0、write 0、network 0であることを確認する。
7. 別turnでinternal `update_plan` eventを発火させ、app policyがterminal rejectionし、main history/public result/canaryを変更しないことを確認する。
8. probe process groupの消滅を確認して全temporary fileを破棄する。
9. production用の別`0700` run directory、clean `CODEX_HOME`、空workspaceを新規作成する。
10. auth bridge、production config、同じ検証済みbytesから作るowner-only explain skill snapshot、実model transportを準備する。
11. production thread responseを再びexact照合した時だけcapacity 1とする。

preflight を test-only にしない。release constructor の native integration test は、成功、binary/schema/tool/profile mismatch、unsafe directory、unsafe auth、transport failure、cleanup failureを含める。

## auth bridge

main config を継承せずに既存 ChatGPT login を使うため、host だけが既存 auth file を production support `CODEX_HOME` へ一時複製する。この処理は Codex の認証内容をアプリ機能として解釈するものではなく、専用 App Server の transport credential を最小範囲で橋渡しする例外である。

必須条件:

1. source path は native が解決し、WebView、model、skill input から受け取らない。
2. source は no-follow open、regular file、current UID、exact `0600`、bounded size を要求する。open 前後の device / inode / metadata が変わったら拒否する。
3. directory chain も symlink、owner、group/world write を検査する。
4. 内容は bounded memory で一度だけ読み、JSON object として構文検証する。token、email、key、field value は log、audit、error、model input、WebViewへ出さない。
5. destination は `0700` run directory 内で、no-follow、exclusive create、`0600` temporary file、flush / fsync、atomic rename、directory fsync を使う。
6. App Server child は `env_clear` し、host transport に必要な PATH、HOME、CODEX_HOME、TMPDIR、locale、明示的な proxy / certificate だけを allowlist する。tool command は別途 `shell_environment_policy.inherit=none` のため auth/proxy environment を継承しない。
7. support process の停止後に run directory 全体を削除する。crash 後の startup cleanup も同じ owner / mode / root containment 検査を通った stale directory だけを対象にする。

source が存在しない、keychain 等で file bridge が不要な認証方式、metadata が安全でない、copy / cleanup が失敗する場合は推測せず capacity 0 にする。将来 App Server が安定した host-owned in-memory token API を公開した場合は、temporary auth file よりその経路を優先して再調査する。

## explain skill と入力境界

support turnへ渡すskillはapp bundle内の`coding-wife-explain-commit`だけである。bundle/resource directoryとskill fileについてcanonical containment、trusted owner、group/world非writable、regular file、link count、device/inode/mtime/sizeを検査し、no-follow descriptorから最大量を読んでdigestを照合する。検証済みbytesは各owner-only private run directoryへexclusive create・`0600`・fsyncでsnapshotし、そのimmutable private pathだけを`UserInput::Skill`としてexactly once注入する。bundle sourceが検証後に変化しても進行中runtimeのskill bytesは変わらない。

clean `CODEX_HOME` の skill catalog と bundled skills は無効であるため、model が列挙・検索・読取できる skill tool はない。main 用 `coding-wife-commit-work` は support input に入れず、support skill は main input に入れない。app-owned skill file の host-side読取は、repository/tool filesystem authority とは別の検証済み application authority とする。

support input は commit-keyed の schema 検証済み snapshot だけとし、raw repository path、raw auth、raw process environment、main reasoning、raw JSON-RPC を含めない。

## runtime event policy

support thread は main thread と同じ event policy を使わない。次を一つでも受けたら support task を cancel / failed にし、assistant result を表示・保存しない。

- `turn/plan/updated` など `update_plan` 実行を示す event。
- command、file change、MCP、dynamic tool、web、image generation、plugin、subagent、request user input、approvalに関する item / request / event。
- allowlist 外の server-initiated request。
- output schema 違反、model/provider/profile/root/approval の不一致。
- unknown terminal-affecting event。

support task の失敗は main turn、main process、Git state、commit evidence を変更しない。UI は決定的な unavailable / failed state と再試行可否だけを表示し、partial model text を出さない。

保存できる監査情報は、binary / schema / tool / skill の短縮 fingerprint、profile ID、task role、commit key、開始・終了時刻、terminal class、canary pass/fail である。raw config、auth、prompt、response、stderr、absolute path は保存しない。

## stream resource boundary と公開前検査

最終`CommitExplanationV1`はraw JSONとcompact serialized JSONをともに64KiB以下とする。一方、App Serverの`item/completed` notificationは、このJSONを`item.text` stringとして包み、JSON内の引用符を再escapeする。通常の64KiB上限出力にnotification envelopeとescape増分を加えても受理できるheadroomとして、support専用JSONL frameを96KiB、未完了bufferを128KiBに固定した。main coding sessionの16MiB/32MiB reader境界は変更しない。

readerはraw line境界に加え、parse後のcompact `byte_count`も96KiB以下かsignal enqueue前に再検査する。signal queueは8件なので、queue内frameは最大768KiBである。turn consumerは各notificationを取り出した直後、methodを適用する前に次のaggregate budgetを加算する。

- notificationは最大256件、compact serialized bytes合計512KiB。
- `item/agentMessage/delta`のtext bytes合計64KiB。
- `item/reasoning/*`のframe bytes合計64KiB。

各境界はexact値を受理し、1byteまたは1件の超過時点でfail closedする。後続にschema-validな`item/completed`と`turn/completed`があっても公開しない。これにより、JSON parse前、signal待機中、turn集約中の三段階でresident dataを有限にする。

schema validation後は`CommitEvidenceV1`と共有するpublic-material scannerを全stringへ再帰適用し、support input固有のURL、backslash、redaction検査も再適用する。absolute/relative/tokenized path、credential、raw reasoning marker、URL、redaction marker、NULを含むcontrol characterのいずれかがsummary、各配列要素、narration textを含む任意のslotにあればwhole outputを破棄する。partial redactionしたmodel textは公開しない。

## 実装判定

**Conditional Go** とする。0.144.5 のこの host では release-capable な隔離構成を実測できた。ただし次のいずれかで直ちに capacity 0 へ戻す。

- Codex binary、version、hash、generated schema、OS sandbox behavior が変わった。
- wireの`tools` field不在、`tool_choice=auto`、`parallel_tool_calls=false`、model、effort、full output schemaのいずれかが変わった。
- `turn/plan/updated`などinternal `update_plan` eventが発火した。
- profile、approval、root、environment、ephemeral の応答を exact 照合できない。
- clean `CODEX_HOME`、auth bridge、run-directory cleanup を安全に作れない。
- malicious fixture で repository/auth/network/write のいずれかが観測された。
- model transport または strict output schema が成立しない。

permission profile の制約は model service への送信を止めるものではない。support が追加 model 利用であること、送信する commit evidence の種別、停止方法、利用量を設定・診断画面で開示する。
