---
title: "サポートエージェントオーケストレーション 要件定義"
description: "7つの固定support roleをmain sessionごとのephemeral root threadとしてオンデマンド実行し、同一worktreeで安全に協働する要件。"
updated: 2026-07-16
last_verified: 2026-07-16
status: "Draft"
prefix: "SUP"
read_when:
  - "Planner、Narrator、Decision Explainer、Risk Sentinel、QA、Detached Reviewer、Checkpoint Curatorを実装または検証するとき。"
  - "support threadのephemeral lifecycle、model mapping、AskUserQuestion境界、同一worktreeの競合制御を確認するとき。"
---
# サポートエージェントオーケストレーション 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `SUP` |
| 状態 | Draft |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-16 |
| 最終レビュー日 | 未レビュー |

## 背景

1つのmain sessionだけで計画、説明、リスク検出、検証、独立レビュー、証跡整理を兼務すると、実装主体と検証主体の文脈が混ざり、ユーザーが作業根拠を追いにくい。mainと同じ専用worktreeを観測できる独立したsupport roleを、作業を妨げない一時threadとして調停する必要がある。

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| 責務分離 | 固定7 roleを別root threadで実行し、全roleの出力と縮退をE2E確認できる |
| オンデマンド支援 | Sol、event、skillが要求したroleだけを起動する |
| 一時履歴と証跡 | raw履歴を残さず、assignment、実model・effort、status、summary、evidence参照を確認できる |
| 競合防止 | base fingerprintとGit lockにより他agentの変更を上書きしない |
| main非阻害 | support失敗時もmainを継続し、status、代替、再試行可否を返す |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| 7 role | Planner、Narrator、Decision Explainer、Risk Sentinel、QA、Detached Reviewer、Checkpoint Curator |
| 実行 | Sol・event・skill駆動、role別ephemeral root、同一worktree、Full access・never固定 |
| model | `model/list`全page、同梱preset、modality、effortによる解決とfallback |
| context・質問・証跡 | 毎assignmentの構造化context、support質問拒否、main向け質問候補、HIST summary |
| 競合・障害 | file fingerprint、session Git lock、timeout、crash回復、空・error・stale状態 |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| main対話、repository・worktree lifecycle | 責務分離 | [codex-main-session要件](../codex-main-session/requirements.md)、[workspace-sessions要件](../workspace-sessions/requirements.md) |
| role追加・削除、設定変更UI | 7 roleと固定契約の統合を優先 | ハッカソン後 |
| workflow・skill固定順、毎turn全role起動 | triggerとtaskへ委ねる | 非対象 |
| support質問overlay・OS通知 | ユーザー質問はmainだけ | [codex-main-session要件](../codex-main-session/requirements.md) |
| rollout、raw response・reasoning、secret保存 | ephemeralと秘密保護 | summaryとevidence参照だけ保存 |
| 自動commit・push・PR・merge、evidence正本 | Git outcomeと履歴の責務分離 | [activity-history要件](../activity-history/requirements.md)、[git-review-harness要件](../git-review-harness/requirements.md) |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ユーザー | main利用者 | status、summary、model evidence、競合の閲覧 | 固定role・実行設定の変更を拒否 |
| main agent（Sol） | assignment要求元 | task・context指定、結果採否、main質問作成 | 不正入力の失敗結果を受けmain継続 |
| 7 support role | 一時支援thread | role内のtool実行と構造化出力 | ユーザー対話、自動Git outcome、秘密保存を拒否 |
| Rust orchestrator | 信頼境界 | trigger、thread、model、context、lock、証跡調停 | 対象assignmentだけを失敗化 |
| React WebView | 非特権UI | 結果表示とmainへの再試行要求 | 任意thread・model・path・Git入力を拒否 |
| App Server | 0.144.5実行系 | schema適合thread・turn・event | 設定・schema不一致でroleを利用不可化 |

## 機能要件

### role catalogとassignment

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| SUP-F-001 | support role catalogを固定7 roleに限定する。 | runtime catalogが`planner`、`narrator`、`decision_explainer`、`risk_sentinel`、`qa`、`detached_reviewer`、`checkpoint_curator`の7件と一致し、追加、削除、重複を拒否する。 | Draft | 非該当 |
| SUP-F-002 | ハッカソン提出物へ7 roleすべてを含める。 | macOS E2Eで各roleへ1件以上のassignmentを実行し、7件すべてでrole固有の検証済みoutputまたは定義済み縮退statusをS-002とS-003から確認できる。 | Draft | 非該当 |
| SUP-F-003 | assignment sourceをSol、正規化event、skill triggerの3種類に限定する。 | 作成済みassignmentの`source`が`main`、`event`、`skill`のいずれかで、source IDと選択roleを記録し、UI操作やtimerだけをsourceとするassignmentを作成しない。 | Draft | 非該当 |
| SUP-F-004 | workflowとskillへ固定順序または全role一括起動を適用しない。 | triggerのないmain turnでassignmentが0件であり、単一roleのtriggerではそのroleだけを作成し、アプリ定義のrole順queueまたは全skill強制実行が存在しない。 | Draft | 非該当 |
| SUP-F-005 | 同じmain sessionの同一role assignmentを直列化する。 | 1 roleにつき`running`が最大1件で、2件目は`queued`になり、別roleはfile・Git競合条件を満たさない限り並行して`running`へ遷移できる。 | Draft | 非該当 |
| SUP-F-006 | mainが`AskUserQuestion`回答待ちの間は新しいsupport assignmentを禁止する。 | 待機開始前に`running`だったsupportは完了またはinterruptまで継続し、待機開始後のSol、event、skill triggerは回答後までassignmentを作成せず`deferred` source eventとして保持する。 | Draft | 非該当 |
| SUP-F-007 | 各assignmentへ検証済み構造化contextを1件関連付ける。 | contextにassignment ID、main session ID、role、source、task、snapshot、evidence refs、許可対象pathを含め、main会話全文に依存せずrole turnを開始できる。 | Draft | 非該当 |
| SUP-F-008 | assignment contextの境界違反をmodel送信前に拒否する。 | UTF-8 JSONが256 KiB以下、evidence refsが0〜100件、許可対象pathが0〜100件で、session IDとsnapshotが有効な場合だけ送信し、違反時は値を推測せず`insufficient_context`または`context_too_large`を返す。 | Draft | 非該当 |
| SUP-F-009 | support assignmentの失敗でmain turnを停止しない。 | supportが`failed`、`interrupted`、`conflicted`、`stale`、`insufficient_context`、`unavailable`のいずれになってもmainのturn statusがsupportを理由に失敗へ変わらず、代替または再試行可否がmainへ返る。 | Draft | 非該当 |

### root threadとephemeral履歴

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| SUP-F-010 | main sessionとroleの組ごとに別のApp Server root threadをオンデマンド作成する。 | 最初のassignmentまでrole threadが存在せず、7 roleを起動した場合は相互に異なる7 thread IDを持ち、main threadまたは別support threadの子threadにならない。 | Draft | 非該当 |
| SUP-F-011 | 全support root threadを`ephemeral: true`で開始する。 | `thread/start` requestへ`ephemeral: true`を明示し、responseの`thread.ephemeral`が`true`、`thread.path`が`null`である場合だけturnを送信する。 | Draft | 非該当 |
| SUP-F-012 | 全support root threadへ固定実行契約を指定する。 | `thread/start`へ実model、mainと同じcanonical `cwd`・Git common directory、`sandbox: "danger-full-access"`、`approvalPolicy: "never"`を指定し、ユーザー設定で上書きしない。 | Draft | 非該当 |
| SUP-F-013 | supportのeffective実行設定を要求値と照合する。 | responseと設定更新eventのmodel、cwd、sandbox、approval、ephemeralの1項目でも要求値と異なる場合は対象roleを`unavailable`にし、mainを継続して不一致項目を表示する。 | Draft | 非該当 |
| SUP-F-014 | 同一App Server process内ではroleのephemeral root threadを連続assignmentへ再利用する。 | 同じmain session・roleの2件目以降が同じthread IDを使用し、各turnで最新の構造化contextを再投入し、前assignmentの暗黙contextだけに依存しない。 | Draft | 非該当 |
| SUP-F-015 | アプリまたはApp Server再起動後にsupport threadを再開しない。 | 再起動前のsupport thread IDへ`thread/resume`、`thread/fork`、rollout path指定を行わず、次のassignmentで新しい`ephemeral: true` root threadを作成する。 | Draft | 非該当 |
| SUP-F-016 | supportの生のCodex履歴をlocal永続領域へ残さない。 | support実行の前後でCodex rollout file、support prompt、raw response、raw reasoningがSQLite、Web Storage、application log、artifact storeへ新規保存されず、release E2Eの履歴監査が合格する。 | Draft | 非該当 |
| SUP-F-017 | support履歴の永続化を検出したroleを停止する。 | rollout file、再開可能なsupport thread、raw payloadの永続保存を1件でも検出すると対象roleの新規assignmentを禁止し、`support_history_persisted`、影響、main継続、公開gate失敗を表示する。 | Draft | 非該当 |
| SUP-F-018 | HISTへsupport assignmentの構造化証跡だけを保存する。 | assignment ID、role、actual model、actual effort、status、秘匿化summary、evidence refs、開始・終了UTCを保存し、再起動後のS-003で同じ値を確認できる。 | Draft | 非該当 |
| SUP-F-019 | supportの永続証跡からsecretと生内容を除外する。 | API key、token、credential、prompt全文、main応答全文、raw reasoning、source全文、command全文、絶対pathがSUP-F-018のrecord、error、通知、診断copyへ含まれない。 | Draft | 非該当 |

### modelとreasoning effortの解決

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| SUP-F-020 | support model解決前に`model/list`の全pageを取得する。 | `cursor`未指定の先頭pageから`nextCursor: null`まで取得し、途中pageの失敗またはcursor循環ではcatalogを確定せず全roleを`unavailable`にして再診断を提示する。 | Draft | 非該当 |
| SUP-F-021 | support候補をpicker-visibleかつ必要modality対応modelへ限定する。 | `includeHidden: false`で取得したentryを再度`hidden: false`かつroleが要求する`text`を`inputModalities`に含む条件で絞り、hiddenまたはtext非対応entryを選択しない。 | Draft | 非該当 |
| SUP-F-022 | 同梱role mapping preset `build-week-support-v1`を使用する。 | 7 roleすべてに次表のmodel ID、effort、required modalityが1件ずつ存在し、preset IDと内容をread-onlyで確認できる。 | Draft | 非該当 |
| SUP-F-023 | presetのmodel IDからcatalog entryの実modelとsupported effortを解決する。 | roleのmodel IDと`entry.id`を完全一致させ、`entry.model`をApp Server requestへ渡し、preset effortが`entry.supportedReasoningEfforts[].reasoningEffort`に存在する場合だけ指定する。 | Draft | 非該当 |
| SUP-F-024 | preset mappingを解決できない場合はApp Server既定modelへfallbackして警告する。 | 候補内の先頭`isDefault: true`、なければ先頭entryを選び、supportedなdefault effort、なければ先頭supported effortを使い`support_model_fallback`を表示する。 | Draft | 非該当 |
| SUP-F-025 | fallback先にsupported effortがない場合は対象roleを実行しない。 | fallback entryの`defaultReasoningEffort`がsupported一覧になく、supported一覧も空の場合、effortを推測せず`support_model_unavailable`を返し、mainを継続する。 | Draft | 非該当 |
| SUP-F-026 | assignmentごとに実際のmodel解決結果を証跡へ残す。 | preset ID、requested model ID、catalog `entry.model`、actual effort、fallback有無、fallback reasonをassignmentへ関連付け、S-002とS-003で確認できる。 | Draft | 非該当 |
| SUP-F-027 | support model fallbackをmainへ適用しない。 | supportでSUP-F-024が発生してもmainの`gpt-5.6-sol`、thread ID、turn設定が変わらず、main model欠落時は[CODE-F-012](../codex-main-session/requirements.md#main-threadと固定実行契約)どおりsession開始を停止する。 | Draft | 非該当 |

#### 同梱role mapping preset

| Role ID | 表示名 | Model ID | Effort | Required modality |
|---|---|---|---|---|
| `planner` | Planner | `gpt-5.6-terra` | `medium` | `text` |
| `narrator` | Narrator | `gpt-5.6-luna` | `low` | `text` |
| `decision_explainer` | Decision Explainer | `gpt-5.6-terra` | `medium` | `text` |
| `risk_sentinel` | Risk Sentinel | `gpt-5.6-sol` | `high` | `text` |
| `qa` | QA | `gpt-5.6-terra` | `medium` | `text` |
| `detached_reviewer` | Detached Reviewer | `gpt-5.6-sol` | `high` | `text` |
| `checkpoint_curator` | Checkpoint Curator | `gpt-5.6-terra` | `medium` | `text` |

### role固有の振る舞い

| 要件ID | Role・責務 | Trigger・入力 | 観測可能な出力 | role境界 | 失敗時縮退 | 状態 | 廃止 |
|---|---|---|---|---|---|---|---|
| SUP-F-028 | Planner: 次の作業案を構造化する | Sol依頼、goal変更、plan失効、skill trigger。goal、制約、plan、evidence refs | 順序付きstep、依存、完了条件、未解決質問 | source fileとGitを変更せず最終方針を決めない | `planner_unavailable`を返しSolのplanを維持 | Draft | 非該当 |
| SUP-F-029 | Narrator: 重要な状態変化を実況する | phase変更、test完了、失敗、判断待ち、checkpoint、skill trigger。秘匿化event | 1〜2文text、importance、speech eligibility、evidence refs | TTSを直接実行せず感情を事実としない | event typeから決定論的status textを表示 | Draft | 非該当 |
| SUP-F-030 | Decision Explainer: mainの選択肢の影響を説明する | main質問、Sol依頼、skill trigger。元質問・選択肢、証拠参照 | 選択肢別の影響、risk、可逆性、推奨元、質問候補 | 選択肢を改変せずユーザーへ質問しない | 元のmain質問を変更せず表示 | Draft | 非該当 |
| SUP-F-031 | Risk Sentinel: 変更と検証のriskを評価する | 危険path、権限、削除、migration、依存、検証弱化、反復失敗。diff・test・policy | severity、finding、根拠、影響、推奨action | source修正とrisk受容を行わない | `risk_scan_unavailable`と未評価範囲を返す | Draft | 非該当 |
| SUP-F-032 | QA: 受け入れ条件の検証を実行・評価する | Sol依頼、checkpoint、skill trigger。要件、変更範囲、許可test、既存証拠 | command種別、exit status、合否、未検証範囲、evidence refs | source修正、test弱化、Git outcomeを行わない | 合格を推測せず再試行command候補を返す | Draft | 非該当 |
| SUP-F-033 | Detached Reviewer: 独立snapshotをreviewする | Sol依頼、高risk、重要checkpoint、skill trigger。固定revisionのdiff、要件、test | severity、finding、file・line、再現条件、evidence refsまたは`no_findings` | 修正、commit、指摘の自動採用を行わない | `review_not_completed`を表示しmainを継続 | Draft | 非該当 |
| SUP-F-034 | Checkpoint Curator: checkpointを再表示可能に整理する | checkpoint、commit、main完了、skill trigger。goal、decision、diff、test、commit、review参照 | 目的、変更、影響、検証、残課題 | Gitとevidence正本を変更しない | 元evidenceを保持しsummary欠落を表示 | Draft | 非該当 |

### AskUserQuestion境界

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| SUP-F-035 | support threadからの`AskUserQuestion`を拒否する。 | support threadに相関する`item/tool/requestUserInput`をApp Server protocol errorで解決し、support turnをユーザー回答待ちへ遷移させない。 | Draft | 非該当 |
| SUP-F-036 | supportの質問意図をmain向け質問候補として返す。 | role outputの`question_candidates`へ質問、理由、選択肢候補、evidence refsを格納してassignmentを`completed`または`needs_main_decision`にし、Solが採用した場合だけmainの新しい質問になる。 | Draft | 非該当 |
| SUP-F-037 | supportの質問候補からoverlayとOS通知を作成しない。 | question candidate受信時にS-002のmain回答overlay、`回答待ち`status、OS通知が0件で、support result cardとtimeline summaryだけを表示する。 | Draft | 非該当 |

### 同一worktreeの競合制御

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| SUP-F-038 | 書き込み可能なassignmentは対象pathのbase fingerprintを保持する。 | fileごとにcanonical relative path、存在有無、内容SHA-256をmodel turn開始前に記録し、新規fileは`absent`、rename・deleteはsourceとdestinationの両方を記録する。 | Draft | 非該当 |
| SUP-F-039 | file書き込み直前にbase fingerprintを再照合する。 | 現在fingerprintがassignmentの期待値と一致する場合だけ書き込み、成功後は同assignmentの期待値を新hashへ更新し、不一致では書き込まず`write_conflict`、対象path、現在revisionをmainへ返す。 | Draft | 非該当 |
| SUP-F-040 | 異なるfileへの書き込みを並行実行できる。 | 2 assignmentのcanonical target setが交差せず、Git排他対象操作を含まない場合は同時に`running`へ遷移でき、片方のfile lockがもう片方を待機させない。 | Draft | 非該当 |
| SUP-F-041 | 書き込み先を事前列挙できないtool実行をsession write lockで直列化する。 | generator、formatter、test commandのtarget setを確定できない場合、mainと7 supportで共有するsession write lockを取得した時だけ実行し、取得できなければcommandを開始しない。 | Draft | 非該当 |
| SUP-F-042 | Git index、branch、commit、worktree変更操作をsession単位exclusive lockで直列化する。 | lock ownerをsession ID、main turnまたはsupport assignment ID、operation IDで記録し、同じsessionでは同時ownerが最大1件、別sessionのlockとは独立する。 | Draft | 非該当 |
| SUP-F-043 | session exclusive lockの取得timeoutを30秒にする。 | 30秒以内に取得できないsupport operationは外部commandを開始せず`git_lock_timeout`、現在ownerのroleまたはmain、代替、再試行可を返し、main turnを停止しない。 | Draft | 非該当 |
| SUP-F-044 | exclusive lock owner crash後にGit実体を検証して回復する。 | owner turn切断時に子Git processが存在すればlockを奪わず、process終了後にpre-operationのHEAD、branch、index hash、worktree list、Git operation markerと照合する。全一致時だけapp lockを解放し、不一致または`.lock`残存時は自動削除せず`git_recovery_required`をmainへ返す。 | Draft | 非該当 |
| SUP-F-045 | 古いsnapshotを参照するsupport結果を現在状態へ適用しない。 | resultのmain turn ID、Git HEADまたはdirty fingerprint、event sequenceのいずれかが現在対象と異なる場合、resultを`stale`にしてUI判断、narration、review合否へ適用せず、evidenceへstale理由だけを保存する。 | Draft | 非該当 |

### 空状態、異常、停止

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| SUP-F-046 | triggerがないroleを`idle`として扱う。 | 新規main sessionでsupport threadとassignmentが0件のままS-002へ「必要時に起動」と表示し、空状態をerror、未導入、model欠落として表示しない。 | Draft | 非該当 |
| SUP-F-047 | role必須contextがないassignmentをmodelへ送信しない。 | role contractの必須fieldまたはevidence snapshotが欠落している場合、threadを作成せず`insufficient_context`、欠落field、Solが補う入力、再試行可を返す。 | Draft | 非該当 |
| SUP-F-048 | support output schema不正を最大1回だけ自動再試行する。 | 初回outputがrole schemaに適合しない場合は同じsnapshotへ修正要求を1回送り、2回目も不正ならraw outputを表示・保存せず`invalid_output`と代替をmainへ返す。 | Draft | 非該当 |
| SUP-F-049 | 緊急停止、明示Quit、sidecar切断で実行中support turnをinterruptする。 | 対象assignmentを`interrupted`にし、完了済み構造化evidenceだけを保存し、再起動後に自動resume、自動再送、自動Git操作を行わない。 | Draft | 非該当 |

## 入力項目要件

ユーザーがsupport設定を直接入力するフォームは提供しない。次はSol、event adapter、skill triggerからRust orchestratorへ渡す内部入力である。

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| assignment | role | なし | 必須 | SUP-F-001の7 role IDのいずれか | `unknown_role`をmainへ返しthreadを作成しない |
| assignment | source | なし | 必須 | `main`、`event`、`skill`とsource ID | `invalid_source`を返す |
| assignment | task | なし | 必須 | UTF-8、1〜16,384 bytes、secretを含めない | 入力を永続化せず違反箇所をmainへ返す |
| context | snapshot | なし | 必須 | main turn ID、Git HEADまたはdirty fingerprint、event sequence、作成UTC | `insufficient_context`を返す |
| context | evidence refs | 空配列 | 任意 | 0〜100件。HISTまたはGITが解決できるID | 解決不能IDを列挙して送信しない |
| context | target paths | 空配列 | 条件付き | 0〜100件、canonical relative path、main session worktree内 | containment違反を拒否する |
| execution | model・effort・sandbox・approval | presetと固定契約 | ユーザー入力不可 | SUP-F-012、SUP-F-022〜SUP-F-025で自動解決 | read-only値と失敗理由を表示する |

## デスクトップ固有要件

[デスクトップ共通仕様](../../screen-design/desktop-common-specification.md)との差分だけを次に定義する。

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | macOSは7 role、ephemeral監査、並行assignment、lock recoveryを実機E2Eで検証する。Windows・Ubuntuは同じ状態機械、path、process終了をCIで検証する。 | SUP-F-002、SUP-F-010〜SUP-F-019、SUP-F-038〜SUP-F-049 |
| ウィンドウ生成・再利用 | 共通仕様どおり単一`main`を再利用し、support専用windowとWebViewを作成しない。 | SUP-F-003〜SUP-F-009 |
| 閉じる・アプリ終了 | window closeでは実行中supportを継続する。明示QuitではSUP-F-049どおりinterruptし、ephemeral threadを保存・resumeしない。 | SUP-F-015、SUP-F-049 |
| 未保存データ | supportの構造化outputは完了時にtransaction保存し、途中raw outputは保存しない。worktreeのfile変更はfilesystemを正本としてrollbackしない。 | SUP-F-016〜SUP-F-019、SUP-F-038〜SUP-F-045 |
| ローカルデータ | assignment metadataはSQLite、Git・file fingerprintは実worktree、ephemeral thread contextはmemoryを正本とする。 | SUP-F-007、SUP-F-014〜SUP-F-019、SUP-F-038〜SUP-F-045 |
| オフライン | 保存済みsupport summaryとevidenceは閲覧できる。新規model turnを開始せず`unavailable`を返し、再接続後も自動再送しない。 | SUP-F-009、SUP-F-018、SUP-F-049 |
| ファイル・OS操作 | mainと同じcanonical worktreeだけを使用し、base fingerprint、containment、file target set、session lockをRust側で照合する。 | SUP-F-012、SUP-F-038〜SUP-F-045 |
| メニュー・ショートカット | support固有menuとglobal shortcutを追加しない。再試行と結果閲覧はS-002、S-003のkeyboard操作で行う。 | SUP-F-009、SUP-F-026、SUP-F-046〜SUP-F-049 |
| Deep Link・ファイル関連付け | 非該当: support assignmentを外部schemeまたはfile open eventから作成しない。 | SUP-F-003 |
| 通知 | support完了、失敗、質問候補ではOS通知を送らず、S-002とS-003のtext表示だけを更新する。 | SUP-F-037 |
| Capability・認可 | WebViewは任意thread、path、model、Git commandを送れない。`danger-full-access`はCodex sidecar権限でありTauri Capabilityがsandbox化しない事実を表示する。 | SUP-F-007、SUP-F-012、SUP-F-038〜SUP-F-044 |
| アップデート・互換性 | Codex 0.144.5 generated schemaとpreset IDを保存し、schemaまたはpreset変更時も既存assignment evidenceのactual model・effortを保持する。 | SUP-F-011〜SUP-F-019、SUP-F-020〜SUP-F-027 |

## 画面・UI

画面レイアウト、表示状態、操作フローは各画面詳細仕様を正本とし、この文書では画面IDと要件IDの対応だけを管理する。

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-002` | コーディングワークスペース | SUP-F-001〜SUP-F-015、SUP-F-020〜SUP-F-037、SUP-F-045〜SUP-F-049 | 新規 | [S-002 コーディングワークスペース](../../screen-design/S-002_coding-workspace.md) |
| `S-003` | セッション証跡 | SUP-F-016〜SUP-F-019、SUP-F-026、SUP-F-028〜SUP-F-034、SUP-F-038〜SUP-F-045、SUP-F-048、SUP-F-049 | 新規 | [S-003 セッション証跡](../../screen-design/S-003_session-evidence.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | Full accessの到達範囲を表示し、role instruction、worktree照合、secret除外、fingerprint、lockを適用する。外部文とrepository内容は観測dataとして扱う。 |
| 権限 | roleとmodel・effort・sandbox・approvalを変更不可にする。QAは許可済み検証、他roleは読み取りだけとし、supportへGit outcomeを許可しない。 |
| プライバシー | contextがOpenAIへ送信され得ることを表示する。raw contextは処理後に破棄し、HISTへSUP-F-018のfieldだけを保存する。 |
| 監査・ログ | assignment、role、source、実model・effort、fallback、status、UTC、summary、evidence refs、error codeを記録し、生内容、secret、絶対pathを除外する。 |
| 性能 | 8 CPU core・16 GBのmacOSで1,000 event/分を入力し、model・tool待ちを除くstatus更新p95を250 ms以下、cache済みmodel解決p95を50 ms以下とする。読み取りassignmentを3件並行実行できる。 |
| 信頼性・復旧 | support失敗をmainへ伝播させない。schemaだけ最大1回再試行し、owner crash時はGit実体がpre-operation snapshotと一致する場合だけlockを解放する。 |
| アクセシビリティ | role、status、summary、warning、conflict、再試行をtext表示し、S-002とS-003をkeyboard操作できる。 |
| 多言語・地域 | 日本語・英語を提供する。canonical IDとerror codeは翻訳せず、UTC保存・OS timezone表示とする。 |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) | sidecar、固定Full access、Quit、緊急停止、SQLite、通知、3OS境界を適用する。 | 解決済み | 共通契約と不一致ならsupportを開始できない |
| [codex-main-session要件](../codex-main-session/requirements.md) | main root thread、Sol固定model、AskUserQuestion、sidecar 0.144.5 contractを提供する。 | Draft | assignment sourceと質問候補をmainへ返せない |
| [workspace-sessions要件](../workspace-sessions/requirements.md) | mainと7 supportへ同じcanonical session worktreeを割り当てる。 | Draft | SUP-F-012と競合制御を検証できない |
| [activity-history要件](../activity-history/requirements.md) | assignment metadata、summary、model、status、evidence refsを保存・表示する。 | Draft間で整合確認予定 | SUP-F-018とS-003の再表示を検証できない |
| [git-review-harness要件](../git-review-harness/requirements.md) | diff、test、review、commit evidenceとGit operation分類を提供する。 | Draft間で整合確認予定 | QA、Reviewer、Curatorのevidenceとlock対象を解決できない |
| Codex App Server 0.144.5 | `model/list`、`thread/start`、`ephemeral`、turn event、`review/start`のgenerated schemaを使用する。 | 解決済み: 公式sourceを2026-07-16確認 | version不一致ではsupportを開始できない |
| `build-week-support-v1` | 7 roleのmodel ID、effort、required modalityをアプリへ同梱する。 | 解決済み: 本文で固定 | 欠落時はSUP-F-024のfallback警告になる |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| なし | 本文の固定7 role、preset、ephemeral lifecycle、競合契約でハッカソン版を実装する | 仕様責任者レビューで共通仕様とHIST・GIT要件の相互参照だけを確認する | いいえ |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [要件定義基準](../../rules/requirements-definition-standards.md) | 1挙動1ID、受け入れ条件、desktop境界、異常系の記述基準 |
| [ID管理ルール](../../rules/id-management-rules.md) | `SUP` Prefix、要件ID、画面IDの正本 |
| [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) | App Server、Full access、AskUserQuestion、Quit、通知、SQLiteの共通契約 |
| [OpenAI Codex App Server](https://developers.openai.com/codex/app-server) | `model/list`のpagination・visibility・modality・reasoning effort、thread lifecycle、event、reviewの公式仕様 |
| [OpenAI Codex App Server 0.144.5 source](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/app-server/README.md) | 対応versionのApp Server method、model catalog、ephemeral threadの公式source |
| [OpenAI Codex 0.144.5 ThreadStartParams](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) | `model`、`cwd`、`approvalPolicy`、`sandbox`、`ephemeral`のwire fieldの公式source |

外部資料は2026-07-16に確認した。

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Not Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 未合意 |
| 残る非ブロック論点 | HIST・GIT要件とのID対応を確認する |

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
