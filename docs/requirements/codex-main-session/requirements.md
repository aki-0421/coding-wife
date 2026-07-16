---
title: "Codexメインセッション 要件定義"
description: "Sol固定main threadとAskUserQuestionの要件。"
updated: 2026-07-16
last_verified: 2026-07-16
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
| ユーザー判断を会話内で完結する | mainの`AskUserQuestion`を1〜3問の選択式または自由入力として表示し、回答、timeout、解決済み、遅延回答を一意に処理できる |
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
| ユーザー質問 | mainの`item/tool/requestUserInput`を`AskUserQuestion`として扱う |
| 診断 | 未login、model、policy、schema、sidecar、resume、入力の失敗を区別する |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| Codex CLIのinstall、update、downgrade | protocolを0.144.5へ固定し、ユーザー環境を変更しないため | 設定・診断の導入案内 |
| アプリ独自login、token処理 | 既存Codex認証を正本にするため | Codex公式login flow |
| 0.144.5以外のCodex CLI、別modelへのfallback | schemaと実行結果の再現性を優先するため | 将来の互換性更新 |
| WebSocket、Unix socket、daemon、proxy | stdio JSONLへ限定するため | 将来拡張 |
| model・sandbox・approval変更UI | 固定実行契約を保つため | 非対象 |
| support roleの実行、model選択、履歴 | mainと別root threadの責務を分離するため | [support-agent-orchestration要件](../support-agent-orchestration/requirements.md) |
| worktreeの作成、検証、削除 | workspace境界の責務を分離するため | [workspace-sessions要件](../workspace-sessions/requirements.md) |
| diff、test、review、commit、push、PR、mergeの自動化 | Git outcomeをSolとユーザー指示の結果として扱うため | [git-review-harness要件](../git-review-harness/requirements.md) |
| skills・MCP・plugins・appsの設定変更 | effective環境の継承へ範囲を限定するため | Codex CLIまたは将来機能 |
| remote画像、汎用file添付 | 0.144.5の入力境界へ限定するため | InlineImage / LocalImage |
| 質問fallback | native `item/tool/requestUserInput`だけを検証するため | 将来更新 |

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
| CODE-F-004 | アプリはCodex CLIの既存login状態をmain sessionへ継承する。 | login済みのCLIでApp Serverを開始すると追加の資格情報入力なしにaccount状態を取得でき、利用中の認証方式とworkspace名だけを表示する。 | Draft | 非該当 |
| CODE-F-005 | アプリはCodexのauth file、API key、access token、refresh tokenを読み取りまたは複製しない。 | auth fileを直接開くI/OとtokenをSQLite、Web Storage、設定、環境変数、診断logへ書く処理が存在せず、認証状態はApp Serverの公開responseからだけ取得するcontract testが合格する。 | Draft | 非該当 |
| CODE-F-006 | 未login時はmain sessionを開始せずCodex公式login flowへ案内する。 | account状態が未loginなら`codex login`の実行案内と`再診断`を表示し、アプリ内にpassword、API key、tokenの入力欄を表示しない。 | Draft | 非該当 |
| CODE-F-007 | アプリは解決済み0.144.5 executableを`app-server --stdio`の子プロセスとして起動する。 | Rustがstdin/stdoutをJSONL専用pipe、stderrを秘匿化済み診断streamとして分離し、WebSocket、Unix socket、daemon、proxy listenerを起動しない。 | Draft | 非該当 |
| CODE-F-008 | App Server接続は1回の`initialize`で`capabilities.experimentalApi: true`を宣言してから`initialized`を送る。 | handshake前のmethod送信がなく、capability欠落、再initialize、experimental API拒否のいずれかを受信した場合は接続を互換性失敗として終了する。 | Draft | 非該当 |
| CODE-F-009 | App Server wire型の正本は、実行する0.144.5から生成したstableとexperimentalのJSON SchemaおよびTypeScript生成物とする。 | `generate-json-schema`と`generate-ts`を通常・`--experimental`の両方で実行でき、生成物を手編集せずadapterの入力型、request、response、notification検証へ使用する。 | Draft | 非該当 |
| CODE-F-010 | adapterはstableとexperimental schemaに対するcontract testを実行する。 | `initialize`、`thread/start`、`thread/resume`、`turn/start`、`item/tool/requestUserInput`、`serverRequest/resolved`の正常fixtureと不正fixtureがCIで検証され、生成物との差分があればCIが失敗する。 | Draft | 非該当 |
| CODE-F-011 | runtime messageが生成schemaまたは相関契約と一致しない場合はfail closedにする。 | 不正JSON、未知の必須field欠落、型不一致、未知request ID、thread/turn/item相関不一致を受信した場合、対象turnを中断表示にしてsidecar再起動を提示し、推測したdefault値で継続しない。 | Draft | 非該当 |

### main threadと固定実行契約

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| CODE-F-012 | session開始前に`model/list`で`gpt-5.6-sol`の利用可否を検証する。 | exact model IDが利用可能な場合だけ開始でき、未掲載または利用不可なら別modelへfallbackせず設定・診断へ理由を表示する。 | Draft | 非該当 |
| CODE-F-013 | sessionごとにmainの永続root threadを1つだけ保持する。 | 新規sessionは`ephemeral: false`でroot thread IDを保存し、複数turn、window close、明示Quit後の再開で同じthread IDを使用する。 | Draft | 非該当 |
| CODE-F-014 | `thread/start`はmainの固定実行契約を明示して送信する。 | requestに`model: "gpt-5.6-sol"`、session専用worktreeのabsolute `cwd`、`sandbox: "danger-full-access"`、`approvalPolicy: "never"`を含め、model fallbackを許可しない。 | Draft | 非該当 |
| CODE-F-015 | `thread/resume`は保存済みroot thread IDとmainの固定実行契約を明示して送信する。 | requestに保存済み`threadId`、`gpt-5.6-sol`、同じabsolute worktree `cwd`、`danger-full-access`、`never`を含め、history注入、rollout path指定、新規threadへの暗黙切替を行わない。 | Draft | 非該当 |
| CODE-F-016 | 全`turn/start`はmainの固定実行契約を再指定する。 | 各requestに同じabsolute worktree `cwd`、`model: "gpt-5.6-sol"`、`sandboxPolicy`のfull access、`approvalPolicy: "never"`を含み、前turnの暗黙状態だけへ依存しない。 | Draft | 非該当 |
| CODE-F-017 | App Serverが返すeffective実行設定を固定契約と照合する。 | `thread/start`、`thread/resume`のresponseと`thread/settings/updated`のmodel、cwd、sandbox、approvalのいずれかが要求値と異なる場合、対象threadを利用不可にしてturnを送信または継続しない。 | Draft | 非該当 |
| CODE-F-018 | model、sandbox、approval policyはread-only表示とし変更UIを提供しない。 | S-002とS-004に固定値と理由を表示し、picker、toggle、自由入力、設定保存APIが存在しない。 | Draft | 非該当 |
| CODE-F-019 | 組織policyがFull accessまたはapproval neverを禁止する場合はmain sessionをfail closedにする。 | effective requirementsを開始前と再開前に確認し、`danger-full-access`または`never`が許可されなければsidecar接続状態を維持してもthread/turnを開始せず、管理者へ確認する設定名を表示する。 | Draft | 非該当 |
| CODE-F-020 | `approval: never`のmainで通常のtool approval停止を作成しない。 | command、file change、network、MCPのapproval requestを受信した場合は固定契約違反として対象turnを停止し、approval選択UIを表示して実行を許可しない。 | Draft | 非該当 |
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
| CODE-F-033 | mainはsession worktreeのeffective instruction sourcesを継承する。 | `thread/start`または`thread/resume`の`instructionSources`を正として、読み込まれた`AGENTS.md`ごとにscope、source path、適用中状態をS-004へ表示し、アプリ独自の内容で置換しない。 | Draft | 非該当 |
| CODE-F-034 | mainはユーザー、repository、system、adminとアプリ同梱のeffective skillsを継承する。 | worktreeを指定した`skills/list`の全pageを表示し、各skillのname、scope、source path、enabled、load errorまたは無効理由を確認できる。 | Draft | 非該当 |
| CODE-F-035 | mainはeffective MCP server構成を継承する。 | main threadを指定した`mcpServerStatus/list`の全pageを表示し、各serverのname、startup/auth status、tool数、resource数、利用不能理由を確認でき、アプリが別のMCP設定へ上書きしない。 | Draft | 非該当 |
| CODE-F-036 | mainはeffective pluginsとappsを継承する。 | worktreeを指定した`plugin/list`とmain threadを指定した`app/list`の全pageを表示し、source、installed、enabled、admin availability、accessible、load errorを確認できる。 | Draft | 非該当 |
| CODE-F-037 | アプリはskillsの実行順を固定しない。 | 固定順序のqueueまたは全turnへの強制Skill item注入が存在せず、明示選択を除くskill利用はCodexのeffective instructionと現在taskに委ねられる。 | Draft | 非該当 |

### AskUserQuestion

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| CODE-F-038 | 製品の`AskUserQuestion`はmain root threadの`item/tool/requestUserInput`だけを受け付ける。 | requestのthreadId、turnId、itemIdが実行中mainと一致する場合だけS-002へ表示し、supportまたは未知threadからのrequestはprotocol errorで拒否してユーザー質問UIを作らない。 | Draft | 非該当 |
| CODE-F-039 | 1 requestで1〜3問だけを受け付ける。 | questionsが1、2、3件なら表示でき、0件または4件以上なら回答UIを作らず対象turnを互換性失敗として停止する。 | Draft | 非該当 |
| CODE-F-040 | 各質問は2〜3個の相互排他的選択肢とfree-form `Other`、またはfree-form入力として表示する。 | optionsが2〜3件ならlabelとdescriptionを表示して単一選択と`Other`入力を提供し、optionsがnullなら1つのfree-form入力を提供し、1件または4件以上のoptionsを拒否する。 | Draft | 非該当 |
| CODE-F-041 | `isSecret: true`の回答を秘密入力として扱う。 | 入力中はmask表示し、clipboard copy、SQLite、Web Storage、draft、timeline本文、TTS、OS通知、診断logへ残さず、送信時に対応requestへ1回だけ回答値を渡してUI memoryを消去する。 | Draft | 非該当 |
| CODE-F-042 | `autoResolutionMs`はnull、60,000〜240,000 msだけを受け付ける。 | nullは無期限。範囲内は残り時間を表示し、満了時に全questionの空answersを1回送る。範囲外はturnを停止する。 | Draft | 非該当 |
| CODE-F-043 | AskUserQuestion表示中は回答または解決までmain turnを待機させる。 | 対象sessionを`回答待ち`と表示し、同じmainへの新規prompt送信を無効化し、timeoutなしでユーザー回答がない間は自動回答、自動interrupt、自動再送を行わない。 | Draft | 非該当 |
| CODE-F-044 | AskUserQuestionの回答と解決をrequest ID単位で一度だけ処理する。 | 回答response送信後または`serverRequest/resolved`受信後にcardを解決済みへ変更し、後着したclick、Enter、timeout、別window eventから同じresponseを再送しない。 | Draft | 非該当 |
| CODE-F-045 | `approval: never`とAskUserQuestionを別の停止種別として扱う。 | 通常tool approval UIが一切なくてもAskUserQuestionは表示・回答でき、質問card、status、通知で`承認`という語を使用しない。 | Draft | 非該当 |

### 障害、境界、復旧

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| CODE-F-046 | sidecar切断時は実行中main turnを中断扱いにする。 | EOF、child exit、不正streamのいずれかを検出すると`sidecar切断`とexit分類を表示し、SQLite履歴、thread ID、worktree、非秘密draftを保持して自動再起動・自動再送を行わない。 | Draft | 非該当 |
| CODE-F-047 | `thread/resume`失敗時は同じsessionを利用不可にして診断を表示する。 | thread not found、rollout破損、cwd不一致、worktree欠落、権限不足、schema不一致を区別し、新規root threadへ暗黙に置換せず、ユーザーが再診断または新規session作成を選ぶまでturnを拒否する。 | Draft | 非該当 |
| CODE-F-048 | turn入力の境界違反では非秘密draftを保持する。 | CODE-F-024〜CODE-F-031の検証失敗時にApp Server request数が増えず、修正対象、実際値、許容境界を項目直下へ表示し、修正後にユーザーが再送できる。 | Draft | 非該当 |
| CODE-F-049 | offline時はmain turnを開始しない。 | network unavailableを検出すると非秘密入力をdraftとして保持し、再接続後も自動送信せずユーザーの明示送信を待つ。 | Draft | 非該当 |
| CODE-F-050 | Codex秘密を分類し永続化と表示から除外する。 | auth file内容、API key、access token、refresh token、cookie、secret AskUserQuestion回答、credentialを含むremote URL、secret環境変数値を秘密として扱い、値をSQLite、Web Storage、永続log、clipboard診断、OS通知へ出さないredaction testが合格する。 | Draft | 非該当 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| turn | InputItem | 空 | 必須 | 5種を合計1件以上 | 非秘密draftを保持する |
| Text | text | 空 | 条件付き | UTF-8合計1〜65,536 bytes | byte数と上限を表示する |
| InlineImage | data URL | なし | 任意 | PNG・JPEG・WebP、base64、CODE-F-029の境界 | 違反境界を表示する |
| LocalImage | path | なし | 任意 | 選択済みabsolute regular file、CODE-F-029の境界 | 再選択を表示する |
| Skill | name / path | なし | 任意 | enabled catalog entry、absolute `SKILL.md`、明示選択 | 再読込または選択解除 |
| Mention | name / path | なし | 任意 | 利用可能なapp / plugin、明示選択 | 理由を表示し解除する |
| AskUserQuestion | questions | 非該当 | server request受信時に必須 | 1〜3問。各問は2〜3択+Other、またはfree-form | main turnを互換性失敗として停止する |
| AskUserQuestion | autoResolutionMs | null | 任意 | nullまたは60,000〜240,000 ms | main turnを互換性失敗として停止する |
| AskUserQuestion | secret answer | 空 | 条件付き | memoryだけで保持し1回送信 | 保持せず再入力を求める |

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
| 対象OS・OS差分 | 共通仕様どおり。3OSでversion gateとstdio contract testを行う | CODE-F-001〜CODE-F-011 |
| ウィンドウ生成・再利用 | 共通`main`を再利用し質問windowを作らない | CODE-F-038〜CODE-F-045 |
| 閉じる・アプリ終了 | closeでは継続し、Quitではinterrupt後にsidecarを終了する | CODE-F-013、CODE-F-043、CODE-F-046 |
| 未保存データ | 非秘密draftだけをSQLiteへ保存する | CODE-F-041、CODE-F-046、CODE-F-048〜CODE-F-050 |
| ローカルデータ | thread対応、turn状態、schema version、非秘密metadataを保存する | CODE-F-005、CODE-F-009、CODE-F-013、CODE-F-050 |
| オフライン | 保存済みsessionとtimelineは閲覧できるが、新規turnを送信しない | CODE-F-049 |
| ファイル・OS操作 | executableとLocalImageをRustで検証し、cancelでは変更しない | CODE-F-001、CODE-F-028 |
| メニュー・ショートカット | S-002の画面詳細仕様どおり | CODE-F-022、CODE-F-024、CODE-F-043 |
| Deep Link・ファイル関連付け | 非該当: main session入力に使用しない | CODE-F-024 |
| 通知 | 共通3イベントだけを通知し秘密値を含めない | CODE-F-041、CODE-F-043、CODE-F-050 |
| Capability・認可 | WebViewへprocess・shell・任意file読取を公開しない | CODE-F-005、CODE-F-007、CODE-F-032 |
| アップデート・互換性 | 0.144.5とschema contract test合格をgateにする | CODE-F-002、CODE-F-003、CODE-F-009〜CODE-F-011 |

## 画面・UI

画面のレイアウト、表示状態、操作フローは各画面詳細仕様を正本とする。

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-001` | セッションダッシュボード | CODE-F-006、CODE-F-012〜CODE-F-015、CODE-F-047 | 参照 | [S-001 セッションダッシュボード](../../screen-design/S-001_session-dashboard.md) |
| `S-002` | コーディングワークスペース | CODE-F-016〜CODE-F-032、CODE-F-038〜CODE-F-049 | 変更 | [S-002 コーディングワークスペース](../../screen-design/S-002_coding-workspace.md) |
| `S-003` | セッション証跡 | CODE-F-023、CODE-F-044、CODE-F-046、CODE-F-050 | 参照 | [S-003 セッション証跡](../../screen-design/S-003_session-evidence.md) |
| `S-004` | 設定・診断 | CODE-F-001〜CODE-F-012、CODE-F-017〜CODE-F-020、CODE-F-033〜CODE-F-037、CODE-F-046〜CODE-F-050 | 変更 | [S-004 設定・診断](../../screen-design/S-004_settings-diagnostics.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | auth/tokenを読取・複製せず、remote imageを拒否し、全IPC入力をRustで再検証する。mainは明示同意後だけ`danger-full-access`かつ`never`で実行する |
| 権限 | model、sandbox、approvalをUIで変更できない。組織policyが固定契約を禁止する場合は権限を弱めて継続せずfail closedにする |
| プライバシー | prompt、画像、skill、mention、secretを含む質問回答がOpenAIへ送信されることを同意時に表示する。秘密は永続化しない |
| 監査・ログ | executable version、schema fingerprint、thread/turn/item ID、event種別、status、短いerror codeを記録する。auth/token、secret回答、prompt本文、response本文、code、file内容、absolute pathを永続logへ記録しない |
| 性能 | Rustがeventを受信してからS-002の状態へ反映するまでをmacOS実機でp95 200 ms以内とする。Textだけの上限検証をp95 100 ms以内、上限内画像10件の検証をp95 2秒以内とする |
| 信頼性・復旧 | request IDとthread/turn/item相関を一意に管理し、sidecar切断とresume失敗で自動再送・暗黙の新規thread作成を行わない |
| アクセシビリティ | keyboardだけでprompt送信、画像削除、skill・mention選択、AskUserQuestion回答、interrupt、緊急停止を実行できる。secret入力のmask状態をaccessible nameで通知する |
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
| [OpenAI Codex App Server公式資料](https://developers.openai.com/codex/app-server) | stdio JSONL、initialize、thread / turn、schema生成、experimental APIの公式契約 |
| [OpenAI Codex Authentication公式資料](https://developers.openai.com/codex/auth) | Codex CLIの既存login、login状態、credential保存の公式境界 |
| [openai/codex 0.144.5 App Server README](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/app-server/README.md) | 対応versionのmethod、入力、remote image拒否、request解決順序、schema生成の根拠 |
| [openai/codex 0.144.5 thread protocol](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) | start / resumeのmodel、cwd、sandbox、approvalとeffective responseの型 |
| [openai/codex 0.144.5 turn protocol](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/app-server-protocol/src/protocol/v2/turn.rs) | `UserInput` unionと全turn overrideの型 |
| [openai/codex 0.144.5 request user input protocol](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/app-server-protocol/src/protocol/v2/item.rs) | 質問、Other、secret、timeout、回答responseのwire型 |
| [openai/codex 0.144.5 request_user_input tool spec](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/core/src/tools/handlers/request_user_input_spec.rs) | 1〜3問、2〜3択、Other、60〜240秒の境界 |
| [openai/codex 0.144.5 remote image validation](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/app-server/src/image_url.rs) | remote HTTP(S)画像拒否とdata URL利用の根拠 |

外部資料は2026-07-16に0.144.5の生成schemaとsourceへ照合した。

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
