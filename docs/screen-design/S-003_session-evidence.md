---
title: "S-003 セッション証拠 画面詳細仕様"
description: "main Codexが作ったcommitのlist、metadata、diff、gate evidenceと、安全なcommit説明導線をread-onlyで提供する。"
updated: 2026-07-18
read_when:
  - "Commit tab、Git observer、commit evidence list/detail/diffを実装するとき。"
  - "『詳しく教えて』、説明caption、説明cancel/fallbackを実装するとき。"
screen_id: "S-003"
status: "Approved"
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

専門的なcommitは、App ServerのGit commit command成功とread-only SHA検証をapp側interceptorが相関した直後に、app-owned explanation controllerがbackground説明生成へenqueueする。background生成だけではpresentation intent、caption、live region、TTSを一切開始しない。main sessionのsubagent、turn、event、commandとしても起動しない。起動前から存在したcommitなど本当に`not_generated`の選択には「詳しく教えて」を表示し、app controllerへ`user_request`と同じselectionに束縛したpresentation intentを送る。生成済み説明は同じ1操作でcacheからpresentationし、失敗時だけ`user_retry`する。path/raw diff/secretを除去した`CommitEvidenceV1`だけをisolated supportへ送り、`coding-wife-explain-commit`から返る日本語/英語の説明は明示intentがcurrentの時だけcharacter captionへstreamする。TTSは任意で、visible captionと同じ文だけを検証済みmacOS local `/usr/bin/say` adapterで読む。外部TTS provider、API key、network送信は使用しない。

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| Commit list | SHA prefix、subject、time、author、parents、work unit相関、観測状態 |
| Commit detail | message、metadata、file summary、lazy diff、verification、decision、risk、skill audit |
| Read-only refresh | active表示、terminal work unit、明示refreshでnative observerを起動 |
| Explanation | verified commitのbackground生成trigger、app-owned controller state、明示presentation intent、manual fallback/retry、cached presentation、生成Cancel、streamed caption、deterministic fallback |
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
| explanation終了 | background生成のcompleted/canceled/unavailableはbutton statusへ反映し、明示presentationがcurrentの時だけcaption/live regionへ反映する。Git状態とmain turnは不変 |

## アクター

| アクター | 入力 | 操作 | 権限境界 |
|---|---|---|---|
| 利用者 | selection、filter、app controller state | inspect、Refresh、presentation表示/Close、詳しく教えて、retry、生成Cancel、Chatへ戻る | Git mutationなし。説明intentをmain sessionへ送らない |
| Main Codex | commit、verification、decision、risk、commit不能理由 | 通常work turn中にcommitしterminal reportを返す | UIからnative代行commitを要求しない |
| Rust Git observer | validated repository ID、generation、opaque evidence ID | HEAD/status/history/diffをread-only観測しHISTへ追記 | arbitrary args/path、index/object/ref/worktree writeなし |
| App-side interceptor / explanation controller | success commit command、verified SHA、UI intent | background enqueue、state公開、intent-scoped presentation、生成cancel、`user_request` / `user_retry` | main thread/turn/subagent/event/commandを作らない |
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
| Actions | controller stateに応じた`詳しく教えて`、presentation表示・再読上げ、`Retry`、`Cancel explanation generation`。Commit/Restore/Branchは存在しない |

actionはactive selection、Freshなworkspace generation、valid redaction、同じcommit evidence IDのcontroller stateへ束縛する。`not_generated`なら「詳しく教えて」からapp controllerへ`trigger=user_request`とpresentation intentを同時送信し、`queued` / `running`なら同じ「詳しく教えて」をpresent-on-complete intentとしてrebindして`Cancel explanation generation`も表示し、`generated`なら同じ1回でcached presentationを表示して任意の同一transcript再読上げを提供する。`failed` / `canceled`なら`trigger=user_retry`、`unavailable`なら理由と`retryable=true`の場合だけ`trigger=user_retry`を表示する。selection / locale / workspace / main Stop / `Close explanation`はintent epochを先に失効させ、後着event/responseを再表示しないが、background jobとruntime cacheは維持する。queued/running jobと同request cacheを無効化するのは確認済み`Cancel explanation generation`だけである。disabled時は理由をbutton近傍のja/en textで示し、どのactionもmain sessionへ送らない。

App rootはnative explanation adapterとNarrationControllerを各1個だけ所有する。WorkspaceShellはselected workspace ID、同workspaceへ接続した実Codex generation、UI localeが揃った時だけ両controllerへscopeを設定し、EvidenceViewへ同じgenerationを渡す。adapterはscope invokeを単一writerで直列化し、latest desired scopeへcoalesceして適用完了まではevent/responseを閉じる。固定値generation、別workspaceの直前snapshot、tab visibility、並列invokeの完了順をscope根拠にしない。

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

success commit commandと新しいSHAの検証後、app-owned controllerは`not_generated`から`queued`へ遷移し、`CommitExplanationRequestedV1(trigger=auto_verified_commit)`をbackground生成として発行する。既存commitのmanual fallbackは`trigger=user_request`、terminal failure後のretryは`trigger=user_retry`とし、UIはapp controllerへintentを送るだけでsupport runtimeを直接開始しない。いずれも次を満たす`CommitEvidenceV1`だけを渡す。

- opaque commit IDとsanitized commit message。
- pathなしのchange kind/countとdiff stats。
- verification、decision、risk、work unit summary。
- locale、workspace generation、selection version。
- 最大64KiB、secret scan pass、raw diff全文/absolute・relative path/raw reasoningなし。

isolated support turnには`coding-wife-explain-commit`をexplicit skill inputで1件注入する。deltaはrequest ID、source commit ID、generation、locale、sequence、text、doneを検証後、characterのvisible HTML captionへ逐次適用する。request、status、delta、result、failureをmain conversationへ注入しない。

native presentation eventは最新controller stateとworkspace ID、workspace generation、commit evidence ID、request ID、selection version、presentation intent epoch、trigger、localeがexact一致し、commit evidence IDからfull SHAを一意に復元できる場合だけNarration sourceへ変換する。`started`、1-origin連続chunk、`terminal`の順を守り、duplicate、stale、scope mismatch、schema mismatchはpresentation generationを増やさず破棄する。NarrationControllerのpresentation generationはactivate単位のlocal counterであり、native workspace generationとは別物である。

#### background生成とpresentation intent

`PresentationIntentV1`はintent ID/epoch、workspace ID/generation、commit evidence ID/full SHA、request ID、selection version、trigger、localeを一つのkeyとして所有する。controllerの生成stateとpresentation stateを混同しない。

| state | 画面契約 | action / recovery |
|---|---|---|
| `not_generated` | empty helperと`詳しく教えて / Explain this commit`。caption/live region/TTS 0件 | 1回の操作で`user_request`とintentを作る。redaction不成立時はdisabled理由を表示 |
| background `queued` / `running`、intentなし | `準備中 / Preparing in background`をCommit detailだけへ表示。caption/live region/TTS 0件 | `詳しく教えて`でpresent-on-complete。`生成をキャンセル / Cancel generation`は確認後だけjobを止める |
| background `queued` / `running`、intentあり | 対象commitのloading captionを表示し、検証済みchunkからstream | `説明を閉じる / Close explanation`でintentだけrevoke。job/cacheは継続 |
| `generated`、intentなし | `説明の準備ができました / Explanation ready`。caption/live region/TTS 0件 | `詳しく教えて`1回でcacheをsequence順にpresentation |
| active presentation | visible HTML captionが正本。TTSはcaption paint ack後の同一chunkだけ | Close、selection/locale/workspace/main Stopでintent revoke。再表示は新epoch |
| `failed` / `canceled` / `unavailable` | localized code、保持evidence、retry可否。Git/main state不変 | retryable時だけ`再試行 / Retry`。生成cancel後は新requestまで旧cache replay不可 |
| stale / scope mismatch | 旧caption/TTSを即時停止し、後着chunkを破棄 | current selectionのactionへ戻る。自動reopenしない |

background statusは`aria-live`へ流さない。明示intent後の通常chunk/completionだけをpolite、blocking errorだけをassertiveに1回通知する。

構造化説明の順序は次とする。

1. 要約 / Summary。
2. 変更点 / Changes。
3. 理由 / Why。
4. 検証 / Verification。
5. 影響 / Impact。
6. 注意 / Cautions。
7. 次の見方 / What to inspect next。

TTS enabled時だけ、captionへ確定した同一chunkを同じsequenceでlocal adapterのstdinへ渡す。TTS off/mute/binary・voice・audio device unavailableでもcaptionを省略しない。selection/locale/workspace変更、main Stop、`Close explanation`、stale/schema invalid後のdeltaはcaption/TTS queueへ適用せず、active process groupも100ms以内に停止するがbackground job/cacheは維持する。`Cancel explanation generation`だけはjobをterminal化し、同requestの後着delta/cache replayも破棄する。

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
| Explanation not_generated | 起動前から存在したcommit、またはbackground enqueue前 | `詳しく教えて`とbackground生成対象か否かのtext | `user_request` + presentation intent、inspect | queued/unavailable |
| Explanation queued/running | `auto_verified_commit` / `user_request` / `user_retry`受理後 | background status、「詳しく教えて」、`Cancel explanation generation`。明示intent前はcaption/live region/TTS 0件 | present-on-complete intent、生成Cancel、read-only inspect | generated/failed/canceled/unavailable |
| Explanation generated | done受理、current runtimeにcached presentationあり | 「詳しく教えて」1回でexplanation表示、同一transcriptの任意再読上げ | presentation、inspect | selection/new request |
| Explanation failed/canceled | model/schema/timeout、または生成Cancel terminal | deterministic reason、Retry | `user_retry`、inspect | queued/unavailable |
| Explanation unavailable | support off/offline/redaction/capability error | deterministic reason。`retryable=true`の場合だけRetry | inspect、Settings、条件付き`user_retry` | queued/unavailable |

support unavailableはcommit evidenceを隠さず、main turnのstatusを変えない。

## 操作仕様

| 操作 | 前提 | 成功 | Cancel | 失敗 | 要件ID |
|---|---|---|---|---|---|
| Commit tabを開く | workspace valid | cached evidence表示後read-only observe | Chatへ戻る | cached evidence+reason | `GIT-F-073`, `GIT-F-084`, `GIT-F-088` |
| Refresh | active、observer idle | new observationとlist projection | in-flight read cancel | Stale/Unavailable、Git不変 | `GIT-F-074`, `GIT-F-078` |
| commit選択 | valid evidence ID | detail表示 | 非該当 | selection解除、list維持 | `GIT-F-084` |
| file diff表示 | valid file evidence ID | lazy diff表示 | requestだけ停止 | typed row error | `GIT-F-085` |
| verified commit background説明生成 | success commit command、新しいSHAとevidence検証済み | app controllerが`not_generated`→`queued`、background job開始。presentation event/caption/live region/TTSは0件 | `Cancel explanation generation`確認後だけterminal化 | failed/unavailable status、main不変 | `CODE-F-077`〜`CODE-F-079`, `GIT-F-090`〜`GIT-F-096` |
| 詳しく教えて | `not_generated` / `queued` / `running` / `generated`、active selection、redaction pass | `user_request` / `user_retry`または既存requestへのpresent-on-complete intentをexact selectionへ束縛し、cache hitを含め1回で表示 | `Close explanation`はintentだけ失効、background job/cache維持 | unavailable caption、main不変 | `GIT-F-090`〜`GIT-F-096` |
| 説明表示・再読上げ | current intentと`queued` / `running` / `generated` stateがexact一致 | cached/streaming presentationをactivateし、任意で同じtranscriptを再読上げ | presentationを閉じても生成とcacheは継続し、late eventで再openしない | captionを維持しTTSだけunavailable | `GIT-F-093`, `GIT-F-094`, `GIT-F-096` |
| 説明Retry | `failed` / `canceled`、または`unavailable`かつ`retryable=true` | app controllerへ`trigger=user_retry` | request前ならstate不変 | reasonを更新しmain不変 | `GIT-F-095`, `GIT-F-096`, `SUP-F-078` |
| 説明生成Cancel | queued/running request、確認済み | 1秒以内interrupt、同requestをterminal化し以後delta/cache replay破棄 | `戻る / Back`でjob、intent、selection不変 | 5秒後timeout terminal、main不変 | `SUP-F-075`, `NARR-F-081` |

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
| `commit_explanation_controller_state` | app-owned explanation controller | EvidenceView/caption | commit evidence ID、generation、request ID、selection version、exact status、trigger、retryable、presentation available、active時のintent ID/epoch、updatedAt、error code |
| `commit_explanation_presentation_requested` | EvidenceView | app-owned explanation controller | commit evidence ID、generation、request ID、selection version、locale、intent ID/epoch、mode=`show` / `replay_narration` |
| `commit_explanation_started` | support runtime | app-owned explanation controller/caption | request ID、skill audit、startedAt |
| `commit_explanation_delta` | support runtime | app-owned explanation controller/caption/TTS policy | request ID、commit ID、generation、locale、sequence、text、done |
| `commit_explanation_terminal` | support runtime | app-owned explanation controller/HIST metadata | request ID、status、usage、latency、error code |
| `commit_explanation_cancel_requested` | EvidenceView | app-owned explanation controller | request ID、generation、reason |

公開`commit_explanation_request`が受理するtriggerは`user_request` / `user_retry`だけである。`auto_verified_commit`はsuccess commit commandとexact SHA proofを相関したRust内部handoffだけが作れ、WebViewから同triggerを渡した場合はinvoke前とnative commandの両方で拒否する。requestを持つcontroller stateはcancel照合用selection versionも返す。

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
| 非active | hidden force-mounted panelはobserverやUI由来requestを起動しない。ただしapp-side interceptorがverified commitを受けたbackground説明生成は画面visibilityと独立して継続する |
| リサイズ | detail優先、list drawer化。captionはdetail actionを覆わない |
| close | UI intent/caption/TTSを先にrevokeし、共通shutdown契約でobserver、support controller/process group、audio queue、writerを順序付きbounded cleanupする。Git状態を変更しない |
| restart | persisted evidenceとInterrupted explanation metadataを表示し、自動support再開しない |
| offline | local evidenceを表示し、explanationはUnavailable caption |

## アクセシビリティ

- focus順はobserver bar、commit list、detail header、tabs、file list、diff、`詳しく教えて` / Retry / 生成Cancel、caption Close / replay / muteとする。
- listはsingle-select semanticsとし、通常のselection変更ではdetail headingへprogrammatic focusを移さない。focusがrevokeされたcaption内にあった場合だけnew detail headingへ移す。
- status、gate、change kind、riskを色だけで伝えない。
- diffのaddition/deletionはtext labelとscreen reader向け説明を持つ。
- `詳しく教えて`後はtriggerへfocusを維持し、caption portalをstatusとして関連付ける。`Close explanation`後はそのexact triggerへ戻し、selection/locale/workspace変更でfocused captionが消失した場合だけnew detail headingへfocusを置く。
- 生成Cancel確認は`戻る / Back`を初期focusにしてfocus trapし、EscapeはBackと同じにする。Back後は生成Cancel trigger、成功後はRetryまたはdetail headingへfocusを返す。
- explanation captionはvisible HTMLで、明示intent後だけpolite live regionを使い、error/cancelはassertiveに1回だけ通知する。background生成statusは読み上げない。
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
| `GIT-F-090`〜`GIT-F-096` | background説明生成、明示presentation、manual fallback/retry、controller state、redaction、caption、TTS、fail closed | [Git observer要件](../requirements/git-review-harness.md) |
| `SUP-F-069`〜`SUP-F-078` | app-owned isolated commit explainer、state、stream schema | [Support要件](../requirements/support-agent-orchestration.md) |
| `NARR-F-078`〜`NARR-F-089` | explicit intent、same-transcript caption/TTS、dismiss/cancel分離、exact key、focus-safe presentation | [Audio要件](../requirements/audio-commentary.md) |

## レビュー・着手判定

- [x] Commit tabをread-only evidence画面として定義した。
- [x] native commit/checkpoint/restore/recovery/branchを削除した。
- [x] list、selection、metadata、diff、gateの正常・空・error・stale・oversizeを定義した。
- [x] verified commit後のbackground説明生成と明示presentationを分離し、`not_generated`のmanual fallback、failure retry、cached presentationを定義した。
- [x] commit説明をmain conversationから分離し、app-owned controllerへ限定した。
- [x] supportへ渡すredacted evidenceと禁止data/authorityを定義した。
- [x] happy/loading/empty/error/disabled/recovery、ja/en、keyboard順、focus return、live region、same-transcript TTS、生成cancel/stale/schema invalidを定義した。
- [x] hidden panel、restart、offline、responsive、accessibilityを定義した。

実装着手可。
