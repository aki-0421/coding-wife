---
title: "Codexメインセッション 要件定義"
description: "Sol固定main threadとAskUserQuestionの要件。"
updated: 2026-07-17
last_verified: 2026-07-17
status: "Draft"
prefix: "CODE"
read_when:
  - "Codex App Serverとの接続、main thread、turn入力、AskUserQuestionを実装または検証するとき。"
  - "Codex CLIの対応version、認証、model、sandbox、approval、schema互換性の失敗動作を確認するとき。"
---
# Codexメインセッション 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `CODE` |
| 状態 | Draft |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-16 |
| 最終レビュー日 | 未レビュー |

## 背景

既存Codex CLIのlogin、`AGENTS.md`、skills、MCP、pluginsを継承し、専用worktreeでSolと対話する。App Serverのwire contractと固定権限を検証し、version、policy、入力、sidecarの失敗時は安全側で停止する。

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| 既存Codex環境を再利用する | 対応するユーザー導入済みCodex CLIと既存loginを使い、アプリが認証情報を読み取りまたは複製せずmain sessionを開始できる |
| main sessionの実行契約を固定する | 新規開始、再開、全turnで`gpt-5.6-sol`、session専用worktree、`danger-full-access`、`approval: never`が観測でき、不一致時は実行を拒否する |
| ユーザー判断を会話内で完結する | 0.144.5の組込みtoolが生成できる1〜3問・各2〜3択+`Other`だけを`AskUserQuestion`として表示し、回答、timeout、解決済み、遅延回答を一意に処理できる |
| wire互換性を保証する | 0.144.5のstable / experimental schemaに対するcontract testが合格する |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| Codex接続 | ユーザー導入済み0.144.5を子プロセスにし、stdio JSONLだけで通信する |
| main thread | sessionごとの永続root threadを専用worktreeで実行する |
| 実行契約 | `gpt-5.6-sol`、`danger-full-access`、`approval: never`、absolute `cwd`を開始、再開、全turnで強制する |
| turn入力 | App Server 0.144.5の`UserInput` unionであるText、InlineImage、LocalImage、Skill、Mentionを扱う |
| Codex環境 | effective `AGENTS.md`、skills、MCP、plugins、apps、同梱skillsを継承・表示する |
| ユーザー質問 | mainの組込み`request_user_input`に相関する`item/tool/requestUserInput`だけを`AskUserQuestion`として扱う |
| 診断 | 未login、model、policy、schema、sidecar、resume、入力の失敗を区別する |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| CLI更新、独自login、token処理 | 0.144.5と既存認証を正本にする | 公式導入・login案内 |
| 別version・model fallback | schemaと結果を再現する | 将来更新 |
| socket、daemon、proxy | stdio JSONLへ限定する | 将来拡張 |
| model・sandbox・approval変更UI | 固定契約を守る | 非対象 |
| support role | mainと責務を分ける | [support要件](../support-agent-orchestration/requirements.md) |
| worktree管理 | workspace境界を分ける | [workspace要件](../workspace-sessions/requirements.md) |
| Git自動化 | Git outcomeをSolのturnへ限定する | [Git要件](../git-review-harness/requirements.md) |
| Codex環境の設定変更 | effective環境を継承する | CLI・将来機能 |
| remote画像、汎用file | 0.144.5入力へ限定する | InlineImage / LocalImage |
| 質問fallback | native requestだけを扱う | 将来更新 |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ユーザー | アプリとCodex CLIの利用者 | session・turn・質問・停止・SolへのGit指示 | 非秘密入力を保持し拒否理由を表示する |
| main agent（Sol） | 永続`gpt-5.6-sol` root thread | Full accessのtool実行と質問 | 固定契約不一致では実行しない |
| Tauri / Rust adapter | process、schema、入力、秘密の信頼境界 | sidecarと検証済みJSONLを調停する | 不正messageを診断eventにする |
| React WebView | 非特権UI | 検証済みcommand / eventを扱う | process、auth、shell、未検証path操作を拒否する |
| 組織管理者 | managed requirementsの主体 | model・sandbox・approval・loginを制約する | Full access / never禁止時はfail closedにする |

## 機能要件

### Codex実行ファイル、認証、wire contract

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| CODE-F-001 | アプリはOSの実行pathからユーザー導入済み`codex`を解決する。 | 起動診断でcanonical executable pathと`codex --version`の結果を表示し、未検出時はApp Serverを起動しない。 | Draft | 非該当 |
| CODE-F-002 | アプリはCodex CLI 0.144.5だけを対応versionとして受け入れる。 | versionが完全一致した場合だけ互換と表示し、0.144.4、0.144.6、解析不能な出力ではsession開始・再開を拒否する。 | Draft | 非該当 |
| CODE-F-003 | アプリはCodex CLIをinstall、update、downgradeしない。 | 未検出またはversion不一致の診断操作を行ってもfilesystemとpackage managerに変更がなく、公式導入手順への案内だけを表示する。 | Draft | 非該当 |
| CODE-F-004 | アプリはCodex CLIの既存login状態をmain sessionへ継承する。 | `account/read`の`account.type`、ChatGPT時のnullable `email`と`planType`、`requiresOpenaiAuth`だけを認証診断へ使用する。workspace名を返却値として表示せず、追加資格情報を要求しない。 | Draft | 非該当 |
| CODE-F-005 | アプリはCodexのauth file、API key、access token、refresh tokenを読み取りまたは複製しない。 | auth fileを直接開くI/OとtokenをSQLite、Web Storage、設定、環境変数、診断logへ書く処理が存在せず、認証状態はApp Serverの公開responseからだけ取得するcontract testが合格する。 | Draft | 非該当 |
| CODE-F-006 | 未login時はmain sessionを開始せずCodex公式login flowへ案内する。 | account状態が未loginなら`codex login`の実行案内と`再診断`を表示し、アプリ内にpassword、API key、tokenの入力欄を表示しない。 | Draft | 非該当 |
| CODE-F-007 | アプリは解決済み0.144.5 executableを`app-server --stdio`のmanaged process treeとして起動する。 | Rustがstdin/stdoutをJSONL pipe、stderrを1 MiB上限の秘匿化ringへ常時drainし、macOS/Linuxは専用process group、Windowsは`KILL_ON_JOB_CLOSE` Job Objectへ実行前に登録する。listenerを追加しない。 | Draft | 非該当 |
| CODE-F-008 | App Server接続は1回の`initialize`後に`initialized`を送る。 | `capabilities`へ`experimentalApi: true`、`requestAttestation: false`、`mcpServerOpenaiFormElicitation: false`を送り、responseの`userAgent`、`codexHome`、`platformFamily`、`platformOs`だけを検証する。capabilityはresponseにechoされると仮定せず、対象methodのcontract testで判定する。 | Draft | 非該当 |
| CODE-F-009 | App Server wire型の正本は、実行する0.144.5から生成したstableとexperimentalのJSON SchemaおよびTypeScript生成物とする。 | `generate-json-schema`と`generate-ts`を通常・`--experimental`の両方で実行でき、生成物を手編集せずadapterの入力型、request、response、notification検証へ使用する。 | Draft | 非該当 |
| CODE-F-010 | adapterはstableとexperimental schemaに対するcontract testを実行する。 | `initialize`、thread/turn、`serverRequest/resolved`に加え、生成`ServerRequest` unionのstable 10 method・experimental 11 methodと未知methodをmain/support/unknown thread fixtureで検証し、未処理variantまたは生成差分でCIを失敗させる。 | Draft | 非該当 |
| CODE-F-011 | runtime messageが生成schemaまたは相関契約と一致しない場合はfail closedにする。 | raw envelopeから`id`と`method`を先に取得し、既知methodの型不一致は`-32602`、未知request methodは`-32601`のJSON-RPC errorを同じIDへ返す。相関turnをinterruptし、response不能または非質問handlerが1秒でterminalにならなければ接続を閉じ、未解決requestを残さない。 | Draft | 非該当 |

### main threadと固定実行契約

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| CODE-F-012 | session開始前に`model/list`で`gpt-5.6-sol`の利用可否を検証する。 | exact model IDが利用可能な場合だけ開始でき、未掲載または利用不可なら別modelへfallbackせず設定・診断へ理由を表示する。 | Draft | 非該当 |
| CODE-F-013 | sessionごとにmainの永続root threadを1つだけ保持する。 | 新規sessionは`ephemeral: false`でroot thread IDを保存し、複数turn、window close、明示Quit後の再開で同じthread IDを使用する。 | Draft | 非該当 |
| CODE-F-014 | `thread/start`はmainの固定実行契約を明示して送信する。 | requestに`model: "gpt-5.6-sol"`、`allowProviderModelFallback: false`、absolute `cwd`、`sandbox: "danger-full-access"`、`approvalPolicy: "never"`、`ephemeral: false`を含める。 | Draft | 非該当 |
| CODE-F-015 | `thread/resume`は保存済みroot thread IDとmainの固定実行契約を明示して送信する。 | 保存ID、model、cwd、sandbox、approvalに`excludeTurns: true`を加え、`history`、`path`、`initialTurnsPage`を送らない。表示履歴はSQLiteからpage取得し、新規threadへ切り替えない。 | Draft | 非該当 |
| CODE-F-016 | 全`turn/start`はmainの固定実行契約を再指定する。 | 各requestにabsolute `cwd`、`model: "gpt-5.6-sol"`、`sandboxPolicy: {"type":"dangerFullAccess"}`、`approvalPolicy: "never"`を含め、同worktreeのturn lease取得前は送信しない。 | Draft | 非該当 |
| CODE-F-017 | App Serverが返すeffective実行設定を固定契約と照合する。 | `thread/start`、`thread/resume`のresponseと`thread/settings/updated`のmodel、cwd、sandbox、approvalのいずれかが要求値と異なる場合、対象threadを利用不可にしてturnを送信または継続しない。 | Draft | 非該当 |
| CODE-F-018 | model、sandbox、approval policyはread-only表示とし変更UIを提供しない。 | S-002とS-004に固定値と理由を表示し、picker、toggle、自由入力、設定保存APIが存在しない。 | Draft | 非該当 |
| CODE-F-019 | 組織policyがFull accessまたはapproval neverを禁止する場合はmain sessionをfail closedにする。 | effective requirementsを開始前と再開前に確認し、`danger-full-access`または`never`が許可されなければsidecar接続状態を維持してもthread/turnを開始せず、管理者へ確認する設定名を表示する。 | Draft | 非該当 |
| CODE-F-020 | `approval: never`のmainで通常のtool approval停止を作成しない。 | command/file approvalは`decline`、legacy approvalは`denied`、permission approvalは空のgranted subsetを即時応答して対象turnをinterruptする。approval UI・通知・黙示許可は0件とする。 | Draft | 非該当 |
| CODE-F-021 | 初回Full access同意が完了するまでsidecarとmain sessionを起動しない。 | [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md#初回明示同意)のrisk、固定権限、緊急停止、非rollbackを表示し、同意拒否またはwindow closeではchild processが存在しない。 | Draft | 非該当 |
| CODE-F-022 | 緊急停止はmainの実行中turnをinterruptし新規turnを拒否する。 | S-002またはtrayから実行すると対象turnが中断表示になり、明示的な再開まで送信できず、既存のfile変更とGit操作を取り消さない。 | Draft | 非該当 |
| CODE-F-023 | Git outcomeはユーザー指示を受けたSolのturnだけが決定する。 | main turn完了を契機とする自動commit、push、PR作成、mergeが発生せず、Git操作を指示したturnの結果だけがtimelineへ記録される。 | Draft | 非該当 |

### turn入力

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| CODE-F-024 | `turn/start.input`はText、InlineImage、LocalImage、Skill、Mentionのいずれかを1件以上含む。 | 0件では送信せず項目直下にエラーを表示し、1件以上の全itemが0.144.5 generated schemaへ適合した場合だけApp Serverへ送る。 | Draft | 非該当 |
| CODE-F-025 | Text itemの本文をUTF-8合計64 KiB以下に制限する。 | 複数TextのUTF-8 byte長合計が1〜65,536 bytesなら送信でき、0 bytesまたは65,537 bytes以上ならdraftを保持して上限を表示する。 | Draft | 非該当 |
| CODE-F-026 | InlineImageはbase64で符号化した画像data URLだけを受け入れる。 | `data:image/png;base64,`、`data:image/jpeg;base64,`、`data:image/webp;base64,`のいずれかで始まり、base64 decode、宣言MIMEとmagic bytesの一致、画像decodeが成功した場合だけ`type: "image"`へ変換する。 | Draft | 非該当 |
| CODE-F-027 | remote HTTP(S)画像を拒否する。 | InlineImageのschemeが大文字小文字を問わず`http`または`https`ならApp Serverへ送信せず、data URLまたはLocalImageへの変更を表示する。 | Draft | 非該当 |
| CODE-F-028 | LocalImageはユーザーが選択したabsolute pathの通常fileだけを受け入れる。 | canonical pathがabsoluteで、存在、readable、regular file、PNG・JPEG・WebPのmagic bytesを満たす場合だけ`type: "localImage"`へ変換し、relative path、directory、socket、読取不能fileを拒否する。 | Draft | 非該当 |
| CODE-F-029 | 1 turnの画像入力を10件、各20 MiB、decode後合計50 MiB、縦横各1〜8,192 pxに制限する。 | InlineImageとLocalImageの合計が全境界以内なら送信でき、件数、各byte数、合計byte数、width、heightのいずれかが上限を超える場合は全turnを送信せず違反項目を表示する。 | Draft | 非該当 |
| CODE-F-030 | Skill itemはeffective catalogにあるskillの明示呼び出しだけを送信する。 | ユーザーがskillを選択した時だけ、catalogの`name`とabsolute `SKILL.md` pathが一致する`type: "skill"`を作り、未登録path、file名が`SKILL.md`でないpath、自動推測による明示item追加を拒否する。 | Draft | 非該当 |
| CODE-F-031 | Mention itemはeffective catalogにあるappまたはpluginの明示mentionだけを送信する。 | ユーザーが候補を選択した時だけ、catalogの`name`とapp/plugin pathが一致する`type: "mention"`を作り、任意scheme、未導入plugin path、無効なentryを拒否する。 | Draft | 非該当 |
| CODE-F-032 | Rust adapterはgenerated schemaとアプリ固有境界の両方でturn入力を検証する。 | WebViewだけの検証を迂回したIPCでもCODE-F-024〜CODE-F-031の違反をRust側が拒否し、不正inputをstdoutへ書かないcontract testが合格する。 | Draft | 非該当 |

### effective Codex環境の継承

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| CODE-F-033 | mainはsession worktreeのeffective instruction sourcesを継承する。 | responseの`instructionSources: path[]`を順序付きloaded pathとしてだけ表示し、scope・enabled・適用結果を推定しない。worktree外pathはbasenameと`external`表示へredactし、内容を置換しない。 | Draft | 非該当 |
| CODE-F-034 | mainはeffective skillsを継承する。 | `skills/list`の`data[].cwd`、`skills[].name|description|path|scope|enabled`と`errors`だけを表示する。pagination、admin availability、load statusを返却fieldとして捏造しない。 | Draft | 非該当 |
| CODE-F-035 | mainはeffective MCP server構成を継承する。 | `mcpServerStatus/list`を`nextCursor: null`まで取得し、`name`、`serverInfo`、`authStatus`、tools/resources/templates件数だけを表示する。startup状態は通知を受信した場合だけ別表示する。 | Draft | 非該当 |
| CODE-F-036 | mainはeffective pluginsとappsを継承する。 | CLIの継承動作は変更しない。`app/list`はbest-effort診断、`plugin/list`は0.144.5でproduction client非推奨のため呼ばず`診断対象外`と表示し、いずれも起動・main session・release gateにしない。 | Draft | 非該当 |
| CODE-F-037 | アプリはskillsの実行順を固定しない。 | 固定順序のqueueまたは全turnへの強制Skill item注入が存在せず、明示選択を除くskill利用はCodexのeffective instructionと現在taskに委ねられる。 | Draft | 非該当 |

### AskUserQuestion

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| CODE-F-038 | 製品の`AskUserQuestion`はmainの組込み`request_user_input` originだけを受け付ける。 | thread/turnが実行中mainと一致し、item registryに同じ`itemId`の`mcpToolCall`または`dynamicToolCall`がなく、CODE-F-039〜CODE-F-042へ適合する場合だけS-002へ表示する。 | Draft | 非該当 |
| CODE-F-039 | 1 requestで1〜3問だけを受け付ける。 | questionsが1、2、3件なら表示でき、0件または4件以上なら回答UIを作らず対象turnを互換性失敗として停止する。 | Draft | 非該当 |
| CODE-F-040 | 各質問を2〜3択とclient追加のfree-form `Other`として表示する。 | `options`が2〜3件、`isOther: true`、各label/descriptionが存在する場合だけradio groupと`Other`入力を作る。`options: null`または空はUIを作らない。 | Draft | 非該当 |
| CODE-F-041 | 組込みtoolから生成不能な質問とapp approvalをユーザー質問にしない。 | `isSecret: true`、`isOther: false`、free-form-only、または同じitemの`mcpToolCall.appContext`/`pluginId`相関を検出したら`-32004` error後にturnをinterruptし、secret入力・Accept/Decline UIを作らない。 | Draft | 非該当 |
| CODE-F-042 | `autoResolutionMs`はnullまたは正規化済み60,000〜240,000 msだけを扱う。 | nullは無期限。範囲内は残り時間を表示し、満了時は全question IDへ`answers: []`を1回返す。範囲外受信は0.144.5組込みtool由来でない互換性失敗として停止する。 | Draft | 非該当 |
| CODE-F-043 | AskUserQuestion表示中はmain turnとworktree turn leaseを保持する。 | 回答、timeout、interrupt後のturn terminalまで同worktreeのmain/support `turn/start`を0件にし、null timeoutでは自動回答・自動interrupt・自動再送を行わない。 | Draft | 非該当 |
| CODE-F-044 | AskUserQuestionの回答と解決をrequest ID単位で一度だけ処理する。 | 全question IDへ`{answers:{<id>:{answers:[<選択labelまたはOther本文>]}}}`を1回返す。送信または`serverRequest/resolved`後は解決済みにし、後着eventを再送しない。 | Draft | 非該当 |
| CODE-F-045 | 全App Server server requestをmethod別に必ず解決する。 | AskUserQuestionは1秒以内にUI可否を決め、回答/timeout時に応答する。他methodは表どおり1秒以内にresponse/errorを1回返し、ユーザーmodal・通知・未解決requestを作らない。 | Draft | 非該当 |

#### Server request routing（0.144.5）

| Method | Response / fail-closed動作 |
|---|---|
| `item/tool/requestUserInput` | CODE-F-038〜044適合mainだけ回答。support・unknown・app approvalは`-32004`後にinterrupt |
| `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` | `decision: "decline"`後に相関turnをinterrupt |
| `item/permissions/requestApproval` | `{permissions:{}, scope:"turn"}`後に相関turnをinterrupt |
| `mcpServer/elicitation/request` | `{action:"decline", content:null, _meta:null}`。UIなし |
| `item/tool/call` | `{contentItems:[], success:false}`後にinterrupt |
| `account/chatgptAuthTokens/refresh` | external providerがないため`-32004`。値を扱わない |
| `attestation/generate` | `requestAttestation:false`のため`-32004` |
| experimental `currentTime/read` | loaded threadだけ`{currentTimeAt:<UTC Unix整数秒>}`、unknownは`-32602` |
| legacy `applyPatchApproval` / `execCommandApproval` | `decision:"denied"`後に相関turnをinterrupt |
| union外method | 同じIDへ`-32601`後、接続を互換性失敗化 |

### 障害、境界、復旧

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| CODE-F-046 | sidecar切断時は実行中main turnを中断扱いにする。 | EOF、child exit、不正streamのいずれかを検出すると`sidecar切断`とexit分類を表示し、SQLite履歴、thread ID、worktree、非秘密draftを保持して自動再起動・自動再送を行わない。 | Draft | 非該当 |
| CODE-F-047 | `thread/resume`失敗時は同じsessionを利用不可にして診断を表示する。 | thread not found、rollout破損、cwd不一致、worktree欠落、権限不足、schema不一致を区別し、新規root threadへ暗黙に置換せず、ユーザーが再診断または新規session作成を選ぶまでturnを拒否する。 | Draft | 非該当 |
| CODE-F-048 | turn入力の境界違反では非秘密draftを保持する。 | CODE-F-024〜CODE-F-031の検証失敗時にApp Server request数が増えず、修正対象、実際値、許容境界を項目直下へ表示し、修正後にユーザーが再送できる。 | Draft | 非該当 |
| CODE-F-049 | offline時はmain turnを開始しない。 | network unavailableを検出すると非秘密入力をdraftとして保持し、再接続後も自動送信せずユーザーの明示送信を待つ。 | Draft | 非該当 |
| CODE-F-050 | Codex秘密を分類し永続化と表示から除外する。 | auth file内容、API key、access/refresh token、cookie、credential付きremote URL、secret環境変数値をSQLite、Web Storage、永続log、clipboard診断、OS通知へ出さないredaction testが合格する。 | Draft | 非該当 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| turn | InputItem | 空 | 必須 | 5種を合計1件以上 | 非秘密draftを保持する |
| Text | text | 空 | 条件付き | UTF-8合計1〜65,536 bytes | byte数と上限を表示する |
| InlineImage | data URL | なし | 任意 | PNG・JPEG・WebP、base64、CODE-F-029の境界 | 違反境界を表示する |
| LocalImage | path | なし | 任意 | 選択済みabsolute regular file、CODE-F-029の境界 | 再選択を表示する |
| Skill | name / path | なし | 任意 | enabled catalog entry、absolute `SKILL.md`、明示選択 | 再読込または選択解除 |
| Mention | name / path | なし | 任意 | 利用可能なapp / plugin、明示選択 | 理由を表示し解除する |
| AskUserQuestion | questions | 非該当 | server request受信時に必須 | 1〜3問。各問2〜3択、`isOther: true`、`isSecret: false` | main turnを互換性失敗として停止する |
| AskUserQuestion | autoResolutionMs | null | 任意 | nullまたは60,000〜240,000 ms | main turnを互換性失敗として停止する |

### main開始・再開デシジョンテーブル

| CLI 0.144.5 | login | Sol | Full access / never許可 | schema | 結果 |
|---|---|---|---|---|---|
| はい | 済 | 利用可 | 許可 | 一致 | mainを開始または再開する |
| いいえ | 任意 | 任意 | 任意 | 任意 | version診断で停止する |
| はい | 未 | 任意 | 任意 | 任意 | 公式login flow案内で停止する |
| はい | 済 | 利用不可 | 任意 | 一致 | model診断で停止しfallbackしない |
| はい | 済 | 利用可 | 禁止 | 一致 | 組織policy診断で停止する |
| はい | 済 | 利用可 | 許可 | 不一致 | 互換性診断で停止する |

## デスクトップ固有要件

[デスクトップ共通仕様](../../screen-design/desktop-common-specification.md)との差分または、この機能固有の契約を書く。

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| OS差分 | 3OSでversion / stdio contract test | CODE-F-001〜CODE-F-011 |
| window | `main`を再利用し質問windowなし | CODE-F-038〜CODE-F-045 |
| close / Quit | closeは継続、Quitはinterruptして終了 | CODE-F-013、CODE-F-043、CODE-F-046 |
| 未保存・local | 非秘密draft、thread/turn/schema metadataだけ保存 | CODE-F-005、CODE-F-009、CODE-F-013、CODE-F-046、CODE-F-048〜CODE-F-050 |
| offline | 閲覧のみ、新規turnなし | CODE-F-049 |
| file / OS | executableとLocalImageをRust検証 | CODE-F-001、CODE-F-028 |
| menu / key | S-002を正本とする | CODE-F-022、CODE-F-024、CODE-F-043 |
| Deep Link | 非該当 | CODE-F-024 |
| 通知 | 共通3イベント、秘密値なし | CODE-F-041、CODE-F-043、CODE-F-050 |
| Capability | WebViewへprocess / shell / 任意fileを公開しない | CODE-F-005、CODE-F-007、CODE-F-032 |
| 互換性 | 0.144.5 schema contractをgateにする | CODE-F-002、CODE-F-003、CODE-F-009〜CODE-F-011 |

## 画面・UI

画面のレイアウト、表示状態、操作フローは各画面詳細仕様を正本とする。

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-001` | セッションダッシュボード | CODE-F-006、CODE-F-012〜CODE-F-015、CODE-F-021、CODE-F-047 | 参照 | [S-001 セッションダッシュボード](../../screen-design/S-001_session-dashboard.md) |
| `S-002` | コーディングワークスペース | CODE-F-016〜CODE-F-032、CODE-F-038〜CODE-F-049 | 変更 | [S-002 コーディングワークスペース](../../screen-design/S-002_coding-workspace.md) |
| `S-003` | セッション証跡 | CODE-F-023、CODE-F-044、CODE-F-046、CODE-F-050 | 参照 | [S-003 セッション証跡](../../screen-design/S-003_session-evidence.md) |
| `S-004` | 設定・診断 | CODE-F-001〜CODE-F-012、CODE-F-017〜CODE-F-020、CODE-F-033〜CODE-F-037、CODE-F-046〜CODE-F-050 | 変更 | [S-004 設定・診断](../../screen-design/S-004_settings-diagnostics.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | auth/tokenを読取・複製せず、remote imageを拒否し、全IPC入力をRustで再検証する。mainは明示同意後だけ`danger-full-access`かつ`never`で実行する |
| 権限 | model、sandbox、approvalをUIで変更できない。組織policyが固定契約を禁止する場合は権限を弱めて継続せずfail closedにする |
| プライバシー | prompt、画像、skill、mention、質問回答がOpenAIへ送信されることを同意時に表示する。認証秘密は永続化しない |
| 監査・ログ | version、schema fingerprint、thread/turn/item ID、event、status、error codeを記録する。auth/token、prompt/response/code/file本文、absolute pathは記録しない |
| 性能 | Rustがeventを受信してからS-002の状態へ反映するまでをmacOS実機でp95 200 ms以内とする。Textだけの上限検証をp95 100 ms以内、上限内画像10件の検証をp95 2秒以内とする |
| 信頼性・復旧 | request IDとthread/turn/item相関を一意に管理し、sidecar切断とresume失敗で自動再送・暗黙の新規thread作成を行わない |
| アクセシビリティ | keyboardだけでprompt送信、画像削除、skill・mention選択、AskUserQuestionのradio/Other回答、interrupt、緊急停止を実行できる |
| 多言語・地域 | UI文言とerrorを日本語・英語で提供する。protocol field、model ID、version、pathは変換せず、時刻はUTC保存・OS timezone表示とする |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| Codex CLI | ユーザー導入済み0.144.5と既存loginを使用する | 解決済み | 未導入、version不一致、未loginではmain利用不可 |
| Codex App Server schema | 実行版からstable / experimentalを生成しwire正本とする | 解決済み | 生成失敗またはcontract不一致ではrelease・起動不可 |
| OpenAI account / model | accountで`gpt-5.6-sol`が利用可能である | runtime検証 | 利用不可ならmain利用不可。fallbackなし |
| 組織policy | `danger-full-access`と`approval: never`が許可される | runtime検証 | 禁止時はmain利用不可 |
| [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) | sidecar lifecycle、同意、緊急停止、保存、通知、3OS境界 | 解決済み | 共通契約と不一致なら実装不可 |
| [workspace-sessions要件](../workspace-sessions/requirements.md) | session専用worktreeのabsolute pathと再開可否を提供する | Draft | valid worktreeがなければthread開始・再開不可 |
| [support-agent-orchestration要件](../support-agent-orchestration/requirements.md) | supportからの質問拒否とmainへの質問候補返却を定義する | Draft | main-only質問境界の統合検証不可 |
| [activity-history要件](../activity-history/requirements.md) | turnと質問の非秘密metadataをtimelineへ保存する | Draft | 証跡表示不可。main turn自体は実行可能 |
| [git-review-harness要件](../git-review-harness/requirements.md) | Git操作結果とreview evidenceを扱う | Draft | Git証跡統合不可。main chat自体は実行可能 |

## 未確定事項

本機能の着手を妨げる未確定事項はない。runtimeで変動するlogin、model可用性、組織policyは未確定仕様ではなく開始・再開時の診断gateとして扱う。

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [App Server公式資料](https://developers.openai.com/codex/app-server) | stdio、lifecycle、schema |
| [Authentication公式資料](https://developers.openai.com/codex/auth) | 既存loginとcredential境界 |
| [0.144.5 App Server README](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/app-server/README.md) | methodとschema生成 |
| [0.144.5 thread / turn protocol](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) | thread契約（turn型は同directory） |
| [0.144.5 request user input wire](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/app-server-protocol/src/protocol/v2/item.rs) | 質問request / response型 |
| [0.144.5 request_user_input spec](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/core/src/tools/handlers/request_user_input_spec.rs) | 到達可能な質問境界 |
| [0.144.5 image validation](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/app-server/src/image_url.rs) | remote画像拒否 |

外部資料は2026-07-17にlocal 0.144.5のstable/experimental生成schema、TypeScript、実App Server、tag sourceへ照合した。

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Not Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 未合意 |
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
- [ ] 仕様責任者がレビューし、合意した。
