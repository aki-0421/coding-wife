---
title: "Codex commit interceptor・support controller実装ガイド"
description: "main App Serverのcommit commandを非公開で相関し、検証済みcommitだけをisolated support説明へ渡すruntime境界を記録する。"
updated: 2026-07-18
read_when:
  - "main Codex turnとGit観測をwork unit単位で接続するとき。"
  - "commit説明controller、support queue、cancel、cache、native eventを変更するとき。"
---

# Codex commit interceptor・support controller実装ガイド

## 適用仕様

上位要件は[git-review-harness](../requirements/git-review-harness.md)の`GIT-F-073`〜`GIT-F-075`、`GIT-F-090`〜`GIT-F-096`と、[support-agent-orchestration](../requirements/support-agent-orchestration.md)の`SUP-F-069`〜`SUP-F-072`、`SUP-F-078`である。Git observerのread-only境界は[Git review runtime実装・検証ガイド](git-review-runtime-implementation.md)、isolated processのrelease・auth・tool proofは[Codex runtime実装ガイド](codex-runtime-implementation.md)を正本とする。

## trusted commit相関

1. main work unit の `turn/start` wire request より前に、App Server adapter が `observe_git_repository` を `work_unit_started` reason で呼び、before observation を保存する。この観測失敗は main turn を拒否せず、当該 work unit の commit 相関と自動説明だけを無効化する。
2. raw `item/started` が同じ workspace generation・thread・turn の `commandExecution` であり、bounded command classifier が Git commit 候補と判定した時だけ、native interceptor がその時点の full HEAD を一時取得する。command、output、cwd、候補 HEAD は history、main event、WebViewへ保存・公開しない。
3. 対応する raw `item/completed` が `source=agent`、`status=completed`、`exitCode=0` をすべて満たす時だけ、native read-only observer が現在の full HEAD を取得する。started 時点と異なる、到達可能な exact SHA だけを、workspace generation・work unit・thread・turn・item に束縛した非公開の `TrustedCommitProof` にする。substring一致、output中の短縮SHA、失敗、decline、exit code欠落、HEAD不変から proof を作らない。
4. completed / failed / interrupted / canceled の全 terminal event で internal terminal observer を1回呼ぶ。before HEAD が after HEAD の ancestor である場合だけ、その範囲の新規 commit を最大100件まで列挙し、同じ terminal call に渡された opaque proof の exact SHA と一致する commit だけを `main_codex` と相関する。proofのない新規 commitをmain Codex作成と推測しない。
5. proof済み commit ごとに evidence を生成し、`git.commit_evidence.recorded` として workspace history へ追記する。work unit correlation と terminal observation も別 event として保存する。terminal eventの重複、並べ替え、stale generation、process restartは同じ proof を再適用しない。
6. exact SHA と commit evidence ID の組が検証できた時だけ、app-owned controller が `auto_verified_commit` を1件 enqueueする。commit選択、Commit tab表示、raw command result、SHA proofだけでは自動起動しない。

raw command classifierは自動説明の権限根拠ではない。候補抽出に失敗した時は自動説明を省略し、文字列一致だけをproducer proofへ昇格しない。Git executableを起動してcommitを代行するfallbackも持たない。

## app-owned controller

Commit explanation controllerの状態は`not_generated` / `queued` / `running` / `generated` / `failed` / `unavailable` / `canceled`の7種に限定する。triggerは`auto_verified_commit` / `user_request` / `user_retry`だけである。

controller は workspace generation と commit evidence ID の組を cache / dedupe key にする。単一の isolated support taskだけを`running`にし、残りはbounded queueへ置く。同じkeyの`queued` / `running` / `generated` replayは新規taskを作らず、生成済みpresentationを再利用する。後のcommit選択から同じkeyを要求した場合は、state、queued task、active taskまたはcached presentationの公開identityを最新request ID、selection version、triggerへ再束縛する。すでに実行中のsupport request IDはnative内部だけで保持し、最新公開identityからのCancelをその実taskへ対応付ける。active taskのcancelは実際のsupport `turn/interrupt`を待ち、timeout時もinterruptしてからterminal化する。workspace generationの変更、stale completion、process restart後の古いtaskを現在状態へ適用しない。

controllerのstate / presentation eventはcommit explanation専用channelだけへ流す。main Codex conversation、main `CodexEvent`、workspace conversation historyへsupport request、delta、outputを追加しない。永続cacheは持たず、restart後は安全な`not_generated`から再開する。

support入力はnative Git serviceが作成し、path / secret scannerと64 KiB上限を通過した`CommitEvidenceV1`だけである。repository root、raw diff、relative / absolute path、Git authority、shell、filesystem、MCP、network、main thread handleはsupport runtimeへ渡さない。

## production composition

### Rust ownership

1. Tauri setupは`GitReviewService`と`CommitExplanationController`を作り、両方を所有するnative-only main work-unit runtimeを`CodexSupervisor`へ1回だけattachする。
2. runtimeはmain turn wire送信前にbefore observationを取り、同じleaseにcommand candidate / proof / terminalを束縛する。terminal observerが返した`TrustedVerifiedCommit`ごとにredacted `CommitEvidenceV1`を作り、active scopeのlocaleでinternal enqueueする。
3. `CommitExplanationController::enqueue_verified_commit`だけが`trigger=auto_verified_commit`を受理する。公開`commit_explanation_request`は`user_request` / `user_retry`以外を`CODEX-SUPPORT-AUTO-TRIGGER-FORBIDDEN`で拒否する。
4. controllerのactive scopeはworkspace ID、workspace generation、localeである。scope変更は別workspaceを含む旧queued / running taskをterminal cancelし、late completionをcache / eventへ適用しない。

### WebView adapterとApp lifetime

1. native adapterは5 commandと`coding-wife://commit-explanation-state` / `coding-wife://commit-explanation-presentation`を購読し、stateをworkspace generation + commit evidence IDでmemory cacheする。購読完了前の`get_state`でnative snapshotを取得し、event到着後は同期`getState`を更新してからsubscriberへ通知する。
2. adapterはstate / presentationのschema、request ID、selection version、trigger、locale、full commit SHAをexactに検証する。public `request()`へ`auto_verified_commit`が渡された場合はinvoke前に拒否する。
3. App rootはadapterと`NarrationController`を各1個だけ生成し、同じadapterをCommit UI controllerと`CommitNarrationConsumerPort` sourceへ渡す。React再render、tab切替、force-mounted panelでinstanceやnative listenerを増やさない。
4. `WorkspaceShell`はselected workspaceと、そのworkspaceに一致する実Codex generationが揃った時だけadapter / narrationへ`setScope`する。adapterはnative writeをApp-lifetimeの単一writerへ集約し、進行中Aの後にB/Cが来た場合はA完了後にlatest Cだけを適用する。latest desired scopeとnative applied scopeが一致するまではstate/presentation event、hydrate、requestを閉じる。workspace switch、generation rollback、locale連打、reverse completion、dispose中responseは古いscopeを再適用しない。

### presentationとStop

native controllerは`auto_verified_commit`成功時にgenerated state/cacheだけを更新し、presentation eventを発行しない。WebView adapterは`user_request` / `user_retry`または明示Showを受けた時にpresentation intent epochを進め、workspace ID、generation、commit evidence ID、selection version、request ID、locale、triggerを固定する。queued/runningへのdedupe合流は同じintentへrebindし、generated cache hitはその1回の操作から即座にnative `present`する。

native presentationの`commitEvidenceId=commit-<full SHA>`からfull SHAを取り出し、上記identityとintent epochが最新controller stateに一致した時だけNarration sourceへ次を同期順で発行する。native event受信時、invoke response受信時、Narration activation直前の各点で同じepochを再検査する。

1. `started`
2. schema済み`narrationChunks`を1-origin連続`chunk`
3. `terminal(status=completed)`

NarrationController側のpresentation generationはこのsource keyのactivateごとに増やす。native workspace generationをpresentation generationとして再利用しない。duplicate presentation eventは同一source key + mode + payload digestで1回に集約し、mismatch、stale、cancel後、revoked intentのeventは捨てる。selection / workspace / locale / Stop / Closeはadapterのintent epochを同期的に失効させてからcaption/TTSをdismissする。再度の明示Showだけが新epochでcacheを再提示できる。

S-002の実Stopはmain `turn/interrupt`と`NarrationController.dismissPresentation("turn_stop")`を同時に開始する。これはvisible caption / TTSを閉じるだけで、app-owned support generationへcancelを送らない。producer cancelはS-003の明示Cancel、workspace/generation scope変更、timeout、App closeだけに限定する。

adapter/controller/cache/narration chunkはmemory-onlyである。App restart後にsupport taskを再開せず、main historyとsupport text persistenceは常に0件にする。

## 検証マトリクス

- 正常系: started candidate → successful completed → exact new reachable SHA → terminal evidenceの順で、`auto_verified_commit`を1件だけenqueueする。
- command失敗、exit code欠落、HEAD不変、forged output SHA、substringだけ、completed-before-started、duplicate notificationではenqueueしない。
- unrelated external commitが同じwork unit中に存在しても、opaque proofのexact SHA以外を`main_codex`にしない。
- stale workspace generation、wrong thread / turn / item、terminal重複、App Server restart後のlate eventはstateを変更しない。
- queueはsingle active、上限超過はsafe unavailable、cancel / timeoutはsupport interruptを実行し、late resultを適用しない。
- controller eventを購読しない状態でもmain turnは完了でき、main session history / eventにsupport内容が0件である。
- native public requestで`auto_verified_commit`を送ってもpre-wire / native両方で拒否され、trusted terminal successだけがauto stateを`queued` / `running` / `generated`へ進める。
- workspace switch / generation変更 / restart後のlate state・presentationは適用せず、同一presentation eventのduplicateでcaption chunkやTTSを二重再生しない。
- main Stopは`turn_stop`でcaption / TTSを閉じるがsupport generationは継続し、後から同じgenerated stateをS-003で明示表示できる。

主要command:

```bash
cargo test --manifest-path src-tauri/Cargo.toml main_work_unit
cargo test --manifest-path src-tauri/Cargo.toml commit_explanation
cargo test --manifest-path src-tauri/Cargo.toml --test codex_supervisor -- --test-threads=1
cargo fmt --manifest-path src-tauri/Cargo.toml --check
agent-docs lint
```
