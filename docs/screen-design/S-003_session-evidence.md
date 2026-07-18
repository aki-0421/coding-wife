---
title: "S-003 セッション証拠 画面詳細仕様"
description: "main Codexが作ったcommitのlist、metadata、diff、gate evidenceと、安全なcommit説明導線をread-onlyで提供する。"
updated: 2026-07-18
read_when:
  - "Commit tab、Git observer、commit evidence list/detail/diffを実装するとき。"
  - "『詳しく教えて』、説明caption、説明cancel/fallbackを実装するとき。"
---

# S-003 セッション証拠 画面詳細仕様

| 項目 | 内容 |
|---|---|
| screen ID | `S-003` |
| tab label | `Commit`。main Codexが作った履歴を確認するread-only入口 |
| route | main shell内のCommit tab。別windowを作らない |
| 状態 | Approved |
| 最終レビュー日 | 2026-07-18 |

## 画面の目的

利用者が、main Codexの作業を「完了したという主張」だけで判断せず、commit単位のmetadata、変更量、sanitized diff、verification、decision、riskから確認できるようにする。commit producerは`coding-wife-commit-work`を毎turn受け取るmain Codexであり、本画面とnative Git backendはGit状態を変更しない。

専門的なcommitは、App ServerのGit commit command成功とread-only SHA検証をapp側interceptorが相関した直後に、app-owned explanation controllerが自動で説明生成へenqueueする。main sessionのsubagent、turn、event、commandとしては起動しない。起動前から存在したcommitなど本当に`not_generated`の選択には「詳しく教えて」を表示し、app controllerへ`user_request`を送る。生成済み説明はcached presentationを表示・任意で再読上げし、失敗時だけapp controllerへ`user_retry`する。path/raw diff/secretを除去した`CommitEvidenceV1`だけをisolated supportへ送り、`coding-wife-explain-commit`から返る日本語/英語の説明をcharacter captionへstreamする。TTSは任意で、captionと同じ文だけを検証済みmacOS local `/usr/bin/say` adapterで読む。外部TTS provider、API key、network送信は使用しない。

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| Commit list | SHA prefix、subject、time、author、parents、work unit相関、観測状態 |
| Commit detail | message、metadata、file summary、lazy diff、verification、decision、risk、skill audit |
| Read-only refresh | active表示、terminal work unit、明示refreshでnative observerを起動 |
| Explanation | verified commit自動trigger、app-owned controller state、manual fallback/retry、cached presentation、Cancel、streamed caption、deterministic fallback |
| Empty/error states | no commits、unavailable repo、stale snapshot、binary/oversize diff、offline support |

### 含めない

| 非対象 | 理由 | 代替 |
|---|---|---|
| Commit / Stage button | commit producerをmain Codexへ一本化する | main work turnでskillに従ってcommit |
| automatic checkpoint | native Git mutationを行わない | terminal work unit後のread-only new commit detection |
| Revert / Restore / Reset | index/ref/worktreeを変更する | 外部Git client、またはmain Codexへ別途明示依頼 |
| Recovery branch | ref mutationになる | 外部Git client |
| Push / Merge / Rebase / Force | remoteまたは共有履歴を変更する | 外部Git workflow |
| raw terminal / arbitrary Git args | trust boundaryを守る | typed read-only observer command |
| raw diff全文のsupport送信 | privacyとprompt injection面を限定する | pathなしstructured evidence |

## 表示契機と終了

| 項目 | 内容 |
|---|---|
| 表示契機 | S-002のCommit tab、新規commit観測link、review-ready link、restart後の履歴閲覧 |
| active前提 | workspace IDとworkspace generationが存在すること。repository unavailableでも保存済みevidenceは表示する |
| native read開始 | tabがvisibleになった時、明示Refresh、terminal work unit受理時だけ。hidden force-mounted panelは0回 |
| 正常終了 | selection/filter/scrollを保存してChatへ戻る。Git状態は不変 |
| explanation終了 | completed/canceled/unavailableをcaptionとbutton statusへ反映。Git状態とmain turnは不変 |

## アクター

| アクター | 入力 | 操作 | 権限境界 |
|---|---|---|---|
| 利用者 | selection、filter、app controller state | inspect、Refresh、presentation表示、詳しく教えて、retry、Cancel、Chatへ戻る | Git mutationなし。説明intentをmain sessionへ送らない |
| Main Codex | commit、verification、decision、risk、commit不能理由 | 通常work turn中にcommitしterminal reportを返す | UIからnative代行commitを要求しない |
| Rust Git observer | validated repository ID、generation、opaque evidence ID | HEAD/status/history/diffをread-only観測しHISTへ追記 | arbitrary args/path、index/object/ref/worktree writeなし |
| App-side interceptor / explanation controller | success commit command、verified SHA、UI intent | 自動enqueue、state公開、presentation、cancel、`user_request` / `user_retry` | main thread/turn/subagent/event/commandを作らない |
| Commit explainer | redacted `CommitEvidenceV1` | JA/EN schemaとnarration chunksを返す | repo/cwd/path/tool/raw diff/raw reasoningなし |

## 情報優先順位

1. observer policy violation、repository mismatch、stale generation、invalid evidence。
2. verification Fail/Unknown、Risk Needs review、known caution。
3. selected commit identity、message、work unit相関。
4. file summary、line count、sanitized diff。
5. decision、verification detail、skill injection audit。
6. commit explanationとsupport usage status。

`Done`や緑色だけで成功を表現しない。commitが存在すること、work unitが成功したこと、verificationがPassであることは別の事実として表示する。

## レイアウト

sidebarと81px headerはS-002と同じ位置を維持し、Commit tabをactiveにする。main bodyはlist/detail splitとする。

| 領域 | 標準幅・高さ | 内容 | resize時 |
|---|---|---|---|
| observer bar | body上64px | repository state、last observed、Fresh/Stale、Refresh、filter | 2行wrap可 |
| commit list | 300px | commit row、work unit/status badge、empty/loading | 960〜1279pxは280px、200% zoomはdrawer |
| detail | 残幅 | header、tabs、evidence、diff、explanation action | 最低560pxを優先 |
| character caption portal | viewport右下またはglobal Companion領域 | streamed explanation、status、Cancel、mute | canvasがhiddenでもHTML captionを維持 |

960px未満はcommit listをmodalでないdrawerへ移し、detailを全幅にする。caption portalはdetailを覆わないようbottom insetと最大幅を調整する。200% text zoomで横scrollを要求せず、diff code blockだけ内部scrollを許す。

## コンポーネント

### Observer bar

| 要素 | 表示 | 操作 |
|---|---|---|
| Repository state | branchまたは`Detached`、HEAD prefix、Fresh/Stale/Unavailable | textとicon、色だけにしない |
| Last observed | locale formatの時刻、reason | tooltipにsource event ID |
| Filter | All / This work unit / Needs attention | selectionを保持してfilter |
| Refresh | read-only observationを明示要求 | running中disabled、`aria-busy` |

`Refresh`はGit fetchではなくlocal observationであることをaccessible nameとhelper textで示す。

### Commit list

各rowは次のDOM順にする。

1. subject（1〜2行）。
2. SHA prefixとauthored time。
3. work unit labelまたは`Uncorrelated`。
4. Verification / Riskのtext badge。
5. changed file / line summary。

row全体をsingle selection controlとし、内部へmutation actionを置かない。keyboardはArrow Up/Downで移動、Enter/Spaceで選択する。selectionはSHA文字列ではなく`commitEvidenceId`で保持し、refresh後に同一IDが無ければ最新へ戻さず未選択を表示する。

### Detail header

| 項目 | 内容 |
|---|---|
| Subject/body | commit message原文。Conventional Commits summaryと英語bulletを翻訳しない |
| Identity | full SHAはcopy可能なread-only text、author、authored/committed time、parents |
| Correlation | work unit ID、turn ID、source terminal event、observation before/after |
| Producer | `Main Codex`または`External/Uncorrelated`。`App checkpoint`とは表示しない |
| Actions | controller stateに応じた`詳しく教えて`、presentation表示・再読上げ、`Retry`、`Cancel`。Commit/Restore/Branchは存在しない |

actionはactive selection、Freshなworkspace generation、valid redaction、同じcommit evidence IDのcontroller stateへ束縛する。`not_generated`なら「詳しく教えて」からapp controllerへ`trigger=user_request`、`queued` / `running`ならpresentation activateとCancel、`generated`ならcached presentation表示と任意の同一transcript再読上げ、`failed` / `canceled`なら`trigger=user_retry`、`unavailable`なら理由と`retryable=true`の場合だけ`trigger=user_retry`を表示する。disabled時は理由をbutton近傍のtextで示し、どのactionもmain sessionへ送らない。

### Detail tabs

| tab | 内容 |
|---|---|
| Overview | message、work unit objective/acceptance、change stats、known cautions |
| Changes | file summary、change kind、line count、lazy diff |
| Evidence | Scope/Ownership/Verification/Risk、tests、decisions、failed attempts、skill injection audit |

tab切替はdata reloadを要求せず、同じselectionのprojectionを切り替える。diff本文だけ明示loadする。

### Gate evidence

| Gate | 表示する根拠 | Unknown条件 |
|---|---|---|
| Scope | work unit objective/acceptanceとcommit相関 | work unit correlationなし |
| Ownership | pre-existing summary、main report、changed file count | baseline observationなし |
| Verification | command/check名、result、duration、source event | verification evidenceなし |
| Risk | classified risk、decision、known caution | risk evidenceなし |

gateはnative commitの前提条件ではなく、既に観測したcommitの評価である。Fail/Unknown/Needs reviewでもcommitを削除・変更せず、attention orderを上げる。

### Changesとdiff

file rowはopaque `fileEvidenceId`、表示用redacted path、change kind、added/deleted lines、binary/oversize flagを持つ。WebViewはraw filesystem pathやGit argsをnativeへ返さない。

| state | 表示 |
|---|---|
| text | context付きunified diff、line number、addition/deletion text label |
| binary | `Binary file — preview unavailable`、size summary |
| oversize | statsと`Diff is too large to display safely`。本文load actionなし |
| invalid UTF-8 | statsとencoding unavailable |
| stale | 前回snapshotをdim表示し、Refresh導線。自動再試行しない |
| error | file row内のtyped reason。他fileは閲覧可能 |

### Commit explanation

success commit commandと新しいSHAの検証後、app-owned controllerは`not_generated`から`queued`へ遷移し、`CommitExplanationRequestedV1(trigger=auto_verified_commit)`を発行する。既存commitのmanual fallbackは`trigger=user_request`、terminal failure後のretryは`trigger=user_retry`とし、UIはapp controllerへintentを送るだけでsupport runtimeを直接開始しない。いずれも次を満たす`CommitEvidenceV1`だけを渡す。

- opaque commit IDとsanitized commit message。
- pathなしのchange kind/countとdiff stats。
- verification、decision、risk、work unit summary。
- locale、workspace generation、selection version。
- 最大64KiB、secret scan pass、raw diff全文/absolute・relative path/raw reasoningなし。

isolated support turnには`coding-wife-explain-commit`をexplicit skill inputで1件注入する。deltaはrequest ID、source commit ID、generation、locale、sequence、text、doneを検証後、characterのvisible HTML captionへ逐次適用する。request、status、delta、result、failureをmain conversationへ注入しない。

構造化説明の順序は次とする。

1. 要約 / Summary。
2. 変更点 / Changes。
3. 理由 / Why。
4. 検証 / Verification。
5. 影響 / Impact。
6. 注意 / Cautions。
7. 次の見方 / What to inspect next。

TTS enabled時だけ、captionへ確定した同一chunkを同じsequenceでlocal adapterのstdinへ渡す。TTS off/mute/binary・voice・audio device unavailableでもcaptionを省略しない。selection変更、workspace切替、Cancel、stale/schema invalid後のdeltaはcaption/TTS queueへ適用せず、active process groupも100ms以内に停止する。

説明本文はHISTへ保存しない。status、skill ID/version/digest、opaque commit/request ID、locale、usage、latency、error codeだけを保存する。

## 状態

| 状態 | 条件 | UI | 許可操作 | 遷移 |
|---|---|---|---|---|
| 初期loading | active表示、cached listなし | skeleton、observer status | Chat、Settings | list/error/empty |
| Empty | 観測済みcommit 0件 | `まだ観測されたコミットはありません`、main turnでのcommit方針説明 | Refresh、Chat | commit observed |
| 通常 | 1件以上 | list、selection、detail、gate、commit単位のcontroller state | inspect、Refresh、state別action | selection/refresh/explanation |
| Stale | raceまたはgeneration変更 | stale banner、last evidence | Refresh、Chat | fresh/error |
| Observer unavailable | repo/Git/policy/error | 保存済みevidence、typed reason | Retry、Settings、Chat | fresh/error |
| Diff loading | fileを明示選択 | row skeleton、Cancel | Cancel、別file | loaded/error |
| Explanation not_generated | 起動前から存在したcommit、または自動enqueue前 | `詳しく教えて`と自動生成対象か否かのtext | `user_request`、inspect | queued/unavailable |
| Explanation queued/running | `auto_verified_commit` / `user_request` / `user_retry`受理後 | status、presentation activate、caption portal、Cancel | presentation、Cancel、read-only inspect | generated/failed/canceled/unavailable |
| Explanation generated | done受理、current runtimeにcached presentationあり | explanation表示、同一transcriptの任意再読上げ | presentation、inspect | selection/new request |
| Explanation failed/canceled | model/schema/timeout、またはCancel terminal | deterministic reason、Retry | `user_retry`、inspect | queued/unavailable |
| Explanation unavailable | support off/offline/redaction/capability error | deterministic reason。`retryable=true`の場合だけRetry | inspect、Settings、条件付き`user_retry` | queued/unavailable |

support unavailableはcommit evidenceを隠さず、main turnのstatusを変えない。

## 操作仕様

| 操作 | 前提 | 成功 | Cancel | 失敗 | 要件ID |
|---|---|---|---|---|---|
| Commit tabを開く | workspace valid | cached evidence表示後read-only observe | Chatへ戻る | cached evidence+reason | `GIT-F-073`, `GIT-F-084`, `GIT-F-088` |
| Refresh | active、observer idle | new observationとlist projection | in-flight read cancel | Stale/Unavailable、Git不変 | `GIT-F-074`, `GIT-F-078` |
| commit選択 | valid evidence ID | detail表示 | 非該当 | selection解除、list維持 | `GIT-F-084` |
| file diff表示 | valid file evidence ID | lazy diff表示 | requestだけ停止 | typed row error | `GIT-F-085` |
| verified commit自動説明 | success commit command、新しいSHAとevidence検証済み | app controllerが`not_generated`→`queued`、background explanation開始 | controller Cancelでterminal化 | failed/unavailable caption、main不変 | `CODE-F-077`〜`CODE-F-079`, `GIT-F-090`〜`GIT-F-096` |
| 詳しく教えて | `not_generated`、active selection、redaction pass | app controllerへ`trigger=user_request`、background explanation開始 | Cancelでterminal化 | unavailable caption、main不変 | `GIT-F-090`〜`GIT-F-096` |
| 説明表示・再読上げ | `queued` / `running` / `generated`のpresentationあり | cached/streaming presentationをactivateし、任意で同じtranscriptを再読上げ | presentationを閉じても生成継続 | captionを維持しTTSだけunavailable | `GIT-F-093`, `GIT-F-094`, `GIT-F-096` |
| 説明Retry | `failed` / `canceled`、または`unavailable`かつ`retryable=true` | app controllerへ`trigger=user_retry` | request前ならstate不変 | reasonを更新しmain不変 | `GIT-F-095`, `GIT-F-096`, `SUP-F-078` |
| 説明Cancel | active request | 1秒以内interrupt、以後delta破棄 | 非該当 | 5秒後timeout terminal | `SUP-F-075`, `NARR-F-081` |

## Typed command / event境界

### Read-only Git command

| command | 入力 | 出力 | 禁止 |
|---|---|---|---|
| `observe_git_repository` | workspace ID、generation、reason、client request ID | `GitObservationResultV1` | Git args/path/ref/index/object contentのWebView指定 |
| `list_commit_evidence` | workspace ID、generation、cursor、limit、filter | paged `CommitEvidenceSummaryV1` | mutation flag |
| `read_commit_evidence` | workspace ID、generation、commit evidence ID | `CommitEvidenceDetailV1` | raw repository path |
| `read_commit_diff_file` | workspace ID、generation、commit/file evidence ID、context limit | `CommitDiffFileV1` | raw path、arbitrary revision range |

native command surfaceにcheckpoint、commit、stage、restore、revert、branch、update-ref相当を置かない。

### Explanation event

| event | producer | consumer | 必須field |
|---|---|---|---|
| `commit_explanation_requested` | app-owned explanation controller | support runtime | schema version、request ID、workspace generation、commit evidence ID、locale、trigger=`auto_verified_commit` / `user_request` / `user_retry` |
| `commit_explanation_controller_state` | app-owned explanation controller | EvidenceView/caption | commit evidence ID、generation、request ID、exact status、trigger、retryable、presentation available、updatedAt、error code |
| `commit_explanation_presentation_requested` | EvidenceView | app-owned explanation controller | commit evidence ID、generation、mode=`show` / `replay_narration` |
| `commit_explanation_started` | support runtime | app-owned explanation controller/caption | request ID、skill audit、startedAt |
| `commit_explanation_delta` | support runtime | app-owned explanation controller/caption/TTS policy | request ID、commit ID、generation、locale、sequence、text、done |
| `commit_explanation_terminal` | support runtime | app-owned explanation controller/HIST metadata | request ID、status、usage、latency、error code |
| `commit_explanation_cancel_requested` | EvidenceView | app-owned explanation controller | request ID、generation、reason |

## 保存と復元

| data | 保存先 | 保存契機 | 復元 | 非保存 |
|---|---|---|---|---|
| Git observation | HIST | active/terminal/refresh後のvalidated snapshot | list/status projection | raw command output |
| Commit evidence | HIST + content hash | observationとwork unit相関後 | list/detail/gates | secret、unsafe raw diff |
| Skill injection audit | HIST | turn request確定時 | Evidence/Diagnostics | skill本文全文 |
| UI preference | app settings | filter/tab/selection change | 次回active表示 | scroll中間delta |
| Explanation metadata | HIST | support terminal | status/usage/diagnostics | evidence本文、transcript、audio |

## Desktop lifecycle

| 項目 | 仕様 |
|---|---|
| 生成・再利用 | 同じmain windowとworkspace selectionを維持してCommit tabへ切替える |
| 非active | hidden force-mounted panelはobserverやUI由来requestを起動しない。ただしapp-side interceptorがverified commitを受けた自動説明は画面visibilityと独立して継続する |
| リサイズ | detail優先、list drawer化。captionはdetail actionを覆わない |
| close | observer read、support、local TTS process group/queueをbounded cancel。Git transaction待機なし |
| restart | persisted evidenceとInterrupted explanation metadataを表示し、自動support再開しない |
| offline | local evidenceを表示し、explanationはUnavailable caption |

## アクセシビリティ

- focus順はobserver bar、commit list、detail header、tabs、file list、diff、state別説明action、caption Cancelとする。
- listはsingle-select semantics、detail headingはselection変更時にprogrammatic focusを奪わない。
- status、gate、change kind、riskを色だけで伝えない。
- diffのaddition/deletionはtext labelとscreen reader向け説明を持つ。
- explanation captionはvisible HTMLで、polite live regionを基本とし、error/cancelだけassertiveにする。
- TTS off/mute/audio deviceなしでも同じ説明を読める。
- 200% text zoomでaction、blocking reason、captionを欠落させない。

## 性能・境界値

| fixture | 基準 |
|---|---|
| commit 0件 | empty stateを1秒以内に表示 |
| commit 1,000件 | 初回50件をpaged表示し、scrollをblockしない |
| 500 files / 50,000 lines | summary 5秒以内、diffは1fileずつlazy load |
| binary / invalid UTF-8 / oversize | 本文をWebView/supportへ渡さずtyped state |
| explanation evidence | redaction後64KiB以下。超過はsupport 0件、unavailable caption |
| rapid selection 20回 | 最後のselectionだけactive、旧delta/diffはcancel/discard |

## トレーサビリティ

| 要件ID | 本画面での実現 | 参照 |
|---|---|---|
| `GIT-F-072`〜`GIT-F-078` | read-only observer、before/after、new commit、pre-existing、freshness | [Git observer要件](../requirements/git-review-harness.md) |
| `GIT-F-079`〜`GIT-F-083` | main skill auditとproducer表示 | [Git observer要件](../requirements/git-review-harness.md) |
| `GIT-F-084`〜`GIT-F-089` | list/detail/diff/gates/performance | [Git observer要件](../requirements/git-review-harness.md) |
| `CODE-F-077`〜`CODE-F-079` | success commit command検出、SHA検証、main conversation分離 | [Codex main要件](../requirements/codex-main-session.md) |
| `GIT-F-090`〜`GIT-F-096` | 自動説明、manual fallback/retry、controller state、redaction、caption、TTS、fail closed | [Git observer要件](../requirements/git-review-harness.md) |
| `SUP-F-069`〜`SUP-F-078` | app-owned isolated commit explainer、state、stream schema | [Support要件](../requirements/support-agent-orchestration.md) |
| `NARR-F-078`〜`NARR-F-081` | same-transcript caption/TTS | [Audio要件](../requirements/audio-commentary.md) |

## レビュー・着手判定

- [x] Commit tabをread-only evidence画面として定義した。
- [x] native commit/checkpoint/restore/recovery/branchを削除した。
- [x] list、selection、metadata、diff、gateの正常・空・error・stale・oversizeを定義した。
- [x] verified commit後の自動説明、`not_generated`のmanual fallback、failure retry、cached presentationを定義した。
- [x] commit説明をmain conversationから分離し、app-owned controllerへ限定した。
- [x] supportへ渡すredacted evidenceと禁止data/authorityを定義した。
- [x] streamed caption、same-transcript TTS、cancel/stale/schema invalidを定義した。
- [x] hidden panel、restart、offline、responsive、accessibilityを定義した。

実装着手可。
