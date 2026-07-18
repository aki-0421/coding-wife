---
title: "GIT Gitレビュー観測要件定義"
description: "main Codexが作るcommitをnative backendがread-only観測し、commit evidence、skill監査、説明導線を提供する。"
updated: 2026-07-18
read_when:
  - "Git observer、commit evidence、Commit tabを実装するとき。"
  - "commit skill注入、work unitとcommitの相関、native Git権限を検証するとき。"
---

# Gitレビュー観測 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `GIT` |
| 状態 | Approved |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-18 |
| 最終レビュー日 | 2026-07-18 |

## 背景

レビュー可能なcommitは必要だが、アプリ内のnative Git serviceがindex、object、ref、worktreeを変更すると、main coding sessionとの二重producerになり、既存変更の混入、履歴競合、crash recoveryの複雑さを生む。commit producerはversioned skillを毎turn受け取るmain Codex sessionへ一本化し、native backendはGit状態と履歴を読むobserverに限定する。

Commit画面は「アプリがcheckpointを作る場所」ではない。main Codexが通常作業中に作ったcommitと、work unitの検証・判断・リスクを相関して確認するread-only evidence画面である。平易なcommit説明は、App Serverのcommit command成功とread-only SHA検証をapp側interceptorが相関した直後に、main sessionとは独立したapp-owned explanation controllerが自動生成する。

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| producerを一つにする | commitは`coding-wife-commit-work`を明示注入されたmain Codexだけが作り、native command surfaceにGit mutationが0件である |
| 利用者変更を保護する | turn前から存在したstaged/unstaged/untrackedを観測・表示し、main skillが無関係な変更をcommitしない |
| evidenceを確認可能にする | commit list、選択、metadata、sanitized diff、verification/decision/risk evidenceをread-only表示する |
| 説明を安全に補う | verified commit後にredacted `CommitEvidenceV1`を隔離supportへ自動で渡し、JA/EN説明をcaptionへstreamする。UI retryもmainではなくapp controllerへ送る |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| Read-only observation | HEAD、branch/detached、status、pre-existing change、commit list/metadata、diff、new commit detection |
| Correlation | work unit、turn、source event、commit SHA、verification、decision、risk、skill injection auditのHIST相関 |
| Main commit skill | app bundle内の`coding-wife-commit-work`、version/digest、各main turnへの明示注入 |
| Commit evidence | list/select、metadata、file summary、sanitized lazy diff、gate evidence、empty/error/stale state |
| Commit explanation | verified commit trigger、redacted structured evidence、app-owned controller、isolated support、streamed caption、optional same-transcript TTS |

### 含めない

| 非対象 | 理由 | 扱い |
|---|---|---|
| native commit / checkpoint | main Codexとproducerが競合する | `coding-wife-commit-work`を受けたmain Codexが通常作業中に実行 |
| stage / index write | 利用者のstagingを変更し得る | observerはstatusだけ読む |
| commit-tree / ref update / branch作成 | repository履歴mutationになる | native commandとして実装しない |
| revert / restore / recovery branch | Git状態を変えるUIをMVPに含めない | 外部Git clientまたは利用者がmain Codexへ明示依頼 |
| push / merge / force / rebase | remoteまたは共有履歴を変える | 外部Git workflow |
| manual commit button | producer方針を迂回する | Commit tabはread-only |
| raw repository contentのsupport送信 | least privilegeとsecret保護 | redacted `CommitEvidenceV1`だけを送る |

## アクターと権限

| アクター | 説明 | 許可する操作 | 禁止・失敗時 |
|---|---|---|---|
| ローカル利用者 | repository所有者・reviewer | evidence閲覧、commit選択、生成済み説明の表示・再読上げ、support cancel、失敗時retry | Commit tabからGit mutationやmain sessionへの説明依頼を送れない |
| Main Codex session | 唯一のcommit producer | app同梱skillに従う通常のstage/commit、verification、結果報告 | unsafe時はforceせず理由を報告する |
| Rust Git observer | native Git trust boundary | validated repositoryのread-only inspectとHIST evidence append | mutation commandを公開・実行しない |
| App-side commit interceptor / explanation controller | success command terminal、verified SHA、UI intent | verified commit後の自動enqueue、state公開、cancel、show、replay、`user_request` / `user_retry` | main thread/turn/subagent/event/commandを作らない |
| Commit explainer support | 短命の説明生成者 | redacted structured evidenceからJA/EN schemaを生成 | repo/path/tool/raw diffへアクセスしない |

## 機能要件

### Read-only observer

| 要件ID | 要件 | 受け入れ条件 | 状態 |
|---|---|---|---|
| `GIT-F-072` | native Git backendは完全なread-only observerである | command/API一覧と実行traceにindex/object/ref/worktreeを変更する操作が0件で、`commit-tree`、`update-ref`、`checkout`、`reset`、`revert`、`branch`、`add`、`commit`、`push`をWebView入力から実行できない | Approved |
| `GIT-F-073` | observerはwork unit開始時の状態を記録する | main turn開始前にHEAD SHA、branch/detached、staged/unstaged/untracked summary、status fingerprint、observedAtを`GitObservationV1`としてHISTへ追記する。取得失敗はturnを止めず観測Unavailableを記録する | Approved |
| `GIT-F-074` | observerはterminal work unit後にread-only refreshする | completed/failed/interrupted/canceledの全terminal eventで状態を再取得し、before/after observationを同じworkspace generation・work unit・source eventへ相関する。refreshはGit状態を変更しない | Approved |
| `GIT-F-075` | observerはmain Codexが作った新規commitを検出する | before HEADからafter HEADへ到達可能な新規commitをdeterministic orderで列挙し、0件、1件、複数件、HEAD移動/分岐を区別する。検出結果を「appが作成した」と表示しない | Approved |
| `GIT-F-076` | observerはpre-existing changeを明示する | turn前から存在したstaged/unstaged/untracked/deleted/type-changedを分類し、after statusでも追跡する。path表示はUI内に限定し、support payloadではpathを除去する | Approved |
| `GIT-F-077` | repository設定をprocess authorityとして信頼しない | observerのfixtureでfsmonitor、hooks、pager、editor、diff/filter driver、credential/network helperを設定してもmarker processが0件である。固定環境とowner-controlled private configでread-only plumbingを実行する | Approved |
| `GIT-F-078` | freshnessとraceを検出する | observation前後のHEAD/status fingerprintが一致した時だけsnapshotをFreshにし、読み取り中の変更はStaleとして返す。Staleでもretry以外のGit操作を行わない | Approved |

### Commit skillとproducer契約

| 要件ID | 要件 | 受け入れ条件 | 状態 |
|---|---|---|---|
| `GIT-F-079` | appはversioned main commit skillを同梱する | resource名は`coding-wife-commit-work`、path authorityは`app_bundle`、`SKILL.md`と`agents/openai.yaml`を含み、`policy.allow_implicit_invocation: false`である。repositoryとuser Codex homeへfileを作らない | Approved |
| `GIT-F-080` | main skillを各main turnへ明示注入する | `turn/start.input`へ`type=skill`、name、bundle pathを1件含める。runtimeにskill inputが無い場合だけ同一version本文をthread developer instructionsへ注入し、二重注入しない。証明できないturnはdraftを保持して開始しない | Approved |
| `GIT-F-081` | skill注入はidempotentかつ監査可能である | `CommitSkillInjectionV1`にskill ID/version/content digest/path authority/injection mode/workspace generation/work unit/client request IDを持ち、同じturn retryは同一digestのexact replayとなる | Approved |
| `GIT-F-082` | main skillはcommit品質と安全境界を規定する | 適切なreview粒度、英語Conventional Commits summary、変更と意図の英語body bullets、pre-existing変更保護、verification結果報告を指示し、安全にcommitできない場合はforceせず理由を報告する | Approved |
| `GIT-F-083` | terminal work unitはcommitの有無を正確に扱う | commit 0件でもwork unit terminalを成功/失敗状態に従って記録し、未commitをapp failureと断定しない。mainの「commit不能」報告があれば理由をevidenceへ相関する | Approved |

### Commit evidence画面

| 要件ID | 要件 | 受け入れ条件 | 状態 |
|---|---|---|---|
| `GIT-F-084` | Commit tabはcommit listとselectionをread-only表示する | current repositoryの観測済みcommitを新しい順で表示し、選択SHA、subject、author、authored time、parents、work unit相関を表示する。mutation button/shortcutが0件である | Approved |
| `GIT-F-085` | 選択commitのdiffを安全に表示する | file change kindとline countを先に表示し、file diffをlazy loadする。binary/oversize/invalid UTF-8は本文を返さずtyped stateを表示し、repository外pathを開かない | Approved |
| `GIT-F-086` | gateは観測evidenceとして表示する | Scope、Ownership、Verification、RiskをPass/Fail/Unknown/Needs reviewで表示し、source event ID、実行test、decision、known riskを参照できる。gateはnative commit可否を制御せず、main commitを後から評価する | Approved |
| `GIT-F-087` | evidenceはHISTの確定状態だけを表示する | commit observation、skill audit、verification/decision/risk相関をappendして再読できた時だけPersisted表示にし、pending/invalid/oversizeはUnknownまたはUnavailableとする | Approved |
| `GIT-F-088` | 非active panelはnative observationを開始しない | force-mountedだがhiddenのCommit tabはGit readを0件とし、active表示、明示refresh、terminal work unitだけがobserverを起動する | Approved |
| `GIT-F-089` | 大規模repositoryでも段階表示する | 500 filesまたは50,000 changed linesまでsummaryを5秒以内に表示し、本文は1fileずつcancel可能にloadする | Approved |

### 自動commit説明フロー

| 要件ID | 要件 | 受け入れ条件 | 状態 |
|---|---|---|---|
| `GIT-F-090` | verified commitはapp側から自動説明を起動する | App ServerのGit commit commandがsuccess terminalになり、`GIT-F-075`のobserverが新しいSHAとcommit evidence IDを検証した時だけapp controllerが`CommitExplanationRequestedV1(trigger=auto_verified_commit)`を1件作る。commit選択、Commit tab表示、SHA未検証結果では起動せず、main conversationへrequestを送らない | Approved |
| `GIT-F-091` | supportへはredacted `CommitEvidenceV1`だけを渡す | SHAのopaque ID、sanitized subject/body、pathなしfile summary、diff統計、verification、decision、risk、locale、generationを最大64KiBで渡し、absolute/relative path、raw diff全文、secret、raw reasoningを0件にする | Approved |
| `GIT-F-092` | commit説明skillをisolated supportへ明示注入する | resource名`coding-wife-explain-commit`、path authority`app_bundle`、implicit invocation offの検証済みbytesをowner-only private snapshotへ複製し、説明turnにだけ1件注入する。`SUP-F-053`のclean runtimeとcapacity gateを必須にし、wire-advertised/external-authority toolは0件とする。tool field追加またはCodex内部の`update_plan` eventではtaskをfailedにし説明を適用しない | Approved |
| `GIT-F-093` | 説明はJA/ENのversioned schemaでstreamする | UI localeと一致する要約、変更点、理由、検証、影響、注意、次の見方と、同じ内容の短いnarration chunksをsequence付きで返し、character captionへ逐次表示する | Approved |
| `GIT-F-094` | TTSは同じredacted transcriptだけを読む | TTS有効時だけcaptionと同じ確定chunkを同順で読み、追加要約やraw evidenceを音声用に再生成しない。TTS off/unavailableでもcaptionは残る | Approved |
| `GIT-F-095` | invalid/stale/cancelはfail closedする | redaction/schema/generation検査失敗、timeout、Cancel後のchunkをcaption/TTS/HIST本文へ適用せず、決定的なunavailable/canceled textを表示する | Approved |
| `GIT-F-096` | Commit UIはapp controllerの状態にだけ従う | `CommitExplanationControllerStateV1.status`は`not_generated` / `queued` / `running` / `generated` / `failed` / `unavailable` / `canceled`のexact unionとする。新しいverified commitは`not_generated`から`queued`へ自動遷移する。起動前から存在するcommitなど本当に`not_generated`なら「詳しく教えて」から`trigger=user_request`、`queued` / `running`はpresentation activateとCancel、`generated`はcached presentation表示と任意の同一transcript再読上げ、`failed` / `canceled`は`trigger=user_retry`、`unavailable`は理由と`retryable=true`の場合だけ`trigger=user_retry`をapp controllerへ要求する。selectionだけでrequestを作らない | Approved |

## 廃止要件

以前のnative checkpoint/restore設計は本仕様で明示的に廃止する。

| 旧要件ID | 状態 | 廃止理由・後継 |
|---|---|---|
| `GIT-F-043`〜`GIT-F-049` | Deprecated | native ownership/staging gateを廃止。観測は`GIT-F-073`〜`GIT-F-078`、evidence gateは`GIT-F-086` |
| `GIT-F-050`〜`GIT-F-055` | Deprecated | automatic checkpoint/native commitを廃止。producerは`GIT-F-079`〜`GIT-F-083` |
| `GIT-F-056`〜`GIT-F-062` | Deprecated | compare/revert/recovery branch/native mutationをMVPから削除。read-only detailは`GIT-F-084`〜`GIT-F-089` |
| `GIT-F-063`〜`GIT-F-067` | Deprecated | 旧mutation前提の性能/isolation/fingerprintを置換。後継は`GIT-F-077`〜`GIT-F-089` |
| `GIT-F-068`〜`GIT-F-070` | Deprecated | mutation journal、ref compensation、restore transactionを削除。後継なし |
| `GIT-F-071` | Deprecated | 旧manifest分類を`GIT-F-076`へ統合 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| Commit list | selected SHA | 最新の観測済みcommit | 条件付き | repository内のvalid commit object、opaque IDとして扱う | selectionを解除しUnavailable表示 |
| Diff | selected file evidence ID | なし | 条件付き | listが返したopaque IDだけ、raw pathをWebView入力へ戻さない | detailだけerror |
| Explanation | locale | active UI locale | 必須 | `ja` / `en` | active localeへ正規化 |
| Explanation | controller state | `not_generated` | 必須 | exact status union、workspace generation・commit evidence ID一致 | stale stateを表示へ適用しない |
| Explanation | request trigger | `auto_verified_commit` | 条件付き | app interceptorは`auto_verified_commit`、UIは`not_generated`で`user_request`、failure terminalで`user_retry`だけ。single active request | unknown triggerを起動せず理由表示 |

restore SHA、branch name、restore confirmation、commit messageの入力欄は存在しない。

## デスクトップ固有要件

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | macOS 14以降のuser-installed Gitをread-only診断する | `GIT-F-072`〜`GIT-F-078` |
| ウィンドウ生成・再利用 | S-003をmain window tabとして再利用する | `GIT-F-084` |
| 閉じる・アプリ終了 | observer readはcancelし、support/TTSはbounded cancelする。Git transaction待機はない | `GIT-F-088`, `GIT-F-095`, `GIT-F-096` |
| 未保存データ | staged/unstaged/untrackedを変更・破棄しない | `GIT-F-072`, `GIT-F-076` |
| ローカルデータ | observation/evidence/skill auditはHIST、skillsはapp bundleへ保存する | `GIT-F-079`〜`GIT-F-087` |
| オフライン | local evidence閲覧は継続し、support explanationはUnavailable captionにする | `GIT-F-084`〜`GIT-F-096` |
| ファイル・OS操作 | validated repositoryのread-only Git inspectだけをRustへ許可する | `GIT-F-072`, `GIT-F-077` |
| メニュー・ショートカット | commit/restore/branch shortcutを提供しない | `GIT-F-084` |
| 通知 | 新規commit観測、observer error、説明cancelをtextで示す | `GIT-F-075`, `GIT-F-095` |
| Capability・認可 | arbitrary Git argsとpathをWebViewから受けない | `GIT-F-072`, `GIT-F-085` |
| アップデート・互換性 | Codex schema変更時にskill injection capabilityを再検証する | `GIT-F-080`, `GIT-F-081` |

## 画面・UI

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-002` | コーディングワークスペース | `GIT-F-073`〜`GIT-F-083`, `GIT-F-090`〜`GIT-F-096` | 変更 | [画面詳細仕様](../screen-design/S-002_coding-workspace.md) |
| `S-003` | セッション証拠 | `GIT-F-072`〜`GIT-F-096` | 変更 | [画面詳細仕様](../screen-design/S-003_session-evidence.md) |
| `S-004` | 設定・診断 | `GIT-F-077`, `GIT-F-079`〜`GIT-F-081`, `GIT-F-092` | 変更 | [画面詳細仕様](../screen-design/S-004_settings-diagnostics.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | native Git surfaceはread-only、arbitrary args/pathなし。repo config由来processを起動しない |
| 権限 | main Codexだけが通常作業権限の範囲でcommitし、observerとsupportはmutation authorityを持たない |
| プライバシー | supportへpath/raw diff/secret/raw reasoningを送らず、caption/TTSは同じredacted transcriptを使う |
| 監査・ログ | observation、new commit correlation、request trigger、skill ID/version/digest/mode、controller statusを記録する。raw support transcriptは永続化しない |
| 性能 | 500 files/50,000 lines summaryを5秒、説明の最初のcaptionを起動後3秒目標で表示する |
| 信頼性・復旧 | observer failureはmainを止めずUnavailable、skill注入failureはturn前fail closed、support failureはcaption fallback |
| アクセシビリティ | commit/gate/statusを色だけで表現せず、captionは音声設定に関係なく表示する |
| 多言語・地域 | UI/captionはja/en、commit messageとtechnical IDは原文表示する |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| Codex App Server | `UserInput.type=skill`、thread developer instructions、turn lifecycle | 解決済み（version-specific schema検査） | injectionを証明できなければturn開始不可 |
| CODE | main turn、work unit、terminal authority、skill injection runtime | 解決済み（typed contractを共有） | observerはcommitを作らずUnavailable相関 |
| HIST | observation/evidence/skill auditのappend/replay | 解決済み（typed event） | persistence失敗はGitを変えずUnknown表示 |
| CODE/SUP/NARR | success command interception、verified commit、app-owned isolated explanation、caption、optional same-transcript TTS | 解決済み（typed request/state/delta contract） | deterministic caption fallback。main conversationへfallbackしない |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [PRODUCT.md](../../PRODUCT.md) | evidence、reviewability、one coding identity |
| [commit skill注入調査](../research/codex-commit-skill-injection.md) | version-specific App Server skill inputとfallback |
| [Git・review調査](../research/07-review-harness-and-git.md) | commit粒度とreview evidence |
| [支援agent要件](support-agent-orchestration.md) | isolated explanationとredaction |
| [音声・caption要件](audio-commentary.md) | caption優先とsame-transcript TTS |

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 2026-07-18 |
| 残る非ブロック論点 | 大規模merge commitの表示順はfixtureで調整する |

## 着手可チェック

- [x] native Gitを完全read-onlyと定義した。
- [x] main Codexを唯一のcommit producerと定義した。
- [x] skill名、version/digest、app bundle authority、毎turn注入を定義した。
- [x] Commit tabからmutation/restore/recoveryを削除した。
- [x] empty、stale、oversize、offline、cancel、schema invalidを定義した。
- [x] verified commit後の自動説明、app-owned controller state、UI retry、redaction、isolation、caption、TTS境界を定義した。
- [x] 要件IDと画面仕様の相互参照を定義した。
