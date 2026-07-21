---
title: Git review runtime 実装・検証ガイド
description: main Codex が作成した commit を read-only で観測し、commit evidence、lazy diff、app-owned 説明導線を安全に変更・検証するためのガイド。
updated: 2026-07-22
read_when:
  - Git observer、work unit correlation、commit evidence を実装または変更するとき。
  - Commit tab の compact list、file filter、unified lazy diff、内部保持する4 gateを接続または検証するとき。
  - commit 説明 controller、pathless evidence、履歴永続化の境界を変更するとき。
---

# Git review runtime 実装・検証ガイド

## 目的と権限境界

Git review runtime は、main Codex session が作成した local commit を native 側で観測し、レビュー可能な証拠へ変換する。Git の producer は main Codex だけであり、この runtime と Commit tab は次の read-only operation に限定する。

- 登録済み workspace の HEAD、branch、index、status、既存変更を観測する。
- work unit 開始時と terminal 時の観測を比較し、その間に増えた commit を相関する。
- commit identity、変更概要、Scope / Ownership / Verification / Risk の 4 gate、判断、失敗、既知リスク、commit skill 注入監査を保存する。
- commit list、detail、選択した1 file の sanitized diff、説明用の pathless evidence を返す。

commit、stage、restore、revert、compare checkpoint、branch/ref 更新、checkout、reset、clean、push は実装しない。WebView から Git executable、任意 argument、absolute path、ref、raw object access を指定できない。

## データフロー

1. work unit 開始時、App Server adapter が `observe_git_repository` を `work_unit_started` reason で呼び、before observation を保存する。
2. main Codex がcommit commandを完了するか、`node_repl/js` resultへversioned commit proof markerを返す。runtimeはcommandを代行せず、raw JavaScript・arguments・result contentを解釈しない。
3. commandまたはmarkerのintentを、candidate開始時のworkspace repository identity・before HEADとcompletion時のcurrent HEAD・reachabilityへexact照合してopaque proofにする。marker単独またはHEAD差分単独はproofにしない。
4. terminal event で `observe_terminal_work_unit` を呼ぶ。before HEAD が after HEAD の ancestor である場合だけ、その範囲の新規 commit を最大100件まで列挙する。
5. opaque proofのexact SHAと一致するcommitごとにevidenceを生成し、`git.commit_evidence.recorded`としてworkspace historyへ追記する。proofのないcommitは`external_uncorrelated`のままにする。work unit correlationとterminal observationも別eventとして保存する。
6. Commit tab は list → detail → 選択 file diff の順で読み、diff bytes を先読みしない。
7. 説明が必要な時だけ `prepare_commit_explanation_evidence` で pathless `CommitEvidenceV1` を作り、app-owned `CommitExplanationController` へ渡す。

履歴にない既存 commit も閲覧できるが、producer は `external_uncorrelated`、4 gate は `unknown` として扱う。推測で work unit へ結び付けない。

## ファイル責務

| path | 責務 |
|---|---|
| `src-tauri/src/git_review/commands.rs` | 6個の versioned Tauri read command |
| `src-tauri/src/git_review/service.rs` | workspace 解決、観測、相関、idempotency、list/detail/diff/explanation 調停 |
| `src-tauri/src/git_review/runner.rs` | compile-time allowlist の read-only Git command と bounded output |
| `src-tauri/src/git_review/repository.rs` | repository 観測、fingerprint、ID/path validation |
| `src-tauri/src/git_review/evidence.rs` | commit metadata、file summary、4 gate、redaction、lazy diff、pathless projection |
| `src-tauri/src/git_review/history.rs` | `git.*` domain event の追記・再読込 |
| `src/lib/contracts/git-review.ts` | exact-key IPC parser、説明 request/state/presentation contract |
| `src/features/git-review/transport.ts` | Tauri 境界と private native error の安全な正規化 |
| `src/features/git-review/store.ts` | active view observation、filter、selection、stale response 破棄、lazy diff |
| `src/features/git-review/EvidenceView.tsx` | compact commit drawer、changes-only layout、controller state subscription |
| `src/features/git-review/components/` | compact commit list、selected identity、file navigator、unified diff projection |

## native observer の不変条件

- workspace ID は登録済み canonical root にだけ解決する。WebView が filesystem path を渡すことはない。
- runner は read-only operation enum から argument を組み立てる。pager、prompt、optional lock、system/global config の影響を無効化し、stdout/stderr を上限内に制限する。
- observation は full HEAD、symbolic reference/detached、index/status/repository fingerprint、pre-existing staged/unstaged/untracked summary を持つ。file content と absolute path は持たない。
- 同じ `clientRequestId` と同じ payload digest は同じ結果を返す。異なる payload の ID 再利用は `GIT-REQUEST-IDEMPOTENCY-CONFLICT` で拒否する。
- before HEAD から after HEAD が fast-forward ancestry でない場合は相関を停止する。diverged history を新規 commit として偽装しない。
- evidence、event、diff、error envelope には workspace root、home path、credential、secret、raw Git stderr を残さない。

## read API と UI state

| command | 返すもの | 注意 |
|---|---|---|
| `observe_git_repository` | 現在の `GitObservation` | Commit view が active の時と明示 refresh 時だけ |
| `observe_terminal_work_unit` | after observation、work unit correlation、新規 commit summary | terminal event と before observation が一致する場合だけ |
| `list_commit_evidence` | cursor 付き summary | `all`、`this_work_unit`、`needs_attention` |
| `read_commit_evidence` | 選択 commit の detail | persisted correlation を優先し、未相関 commit は live read |
| `read_commit_diff_file` | 選択 file の sanitized diff | binary / oversize / invalid UTF-8 は状態だけ返す |
| `prepare_commit_explanation_evidence` | pathless `CommitEvidenceV1` | relative path、diff content、absolute pathを含めない |

Commit tabはbranch/HEAD/Fresh/観測理由・時刻/filter/read-only badgeと監査propertyを通常表示せず、changesを唯一の主面にする。restore、checkpoint、compare、revert、delete 等の mutation action を追加しない。commit listは常にcompact triggerから開くdrawerとし、optionはArrowUp / ArrowDownで選択する。

detail取得後は先頭fileを自動選択し、その1 fileだけをlazy loadする。desktopはlocal path filter付きfile navigator、primary surfaceが760px以下または200% text zoom時はcompact file selectorを使う。frontend parserはhunk headerからold/new line numberを採番し、Git metadata headerを除外してaddition/deletion/contextをmarkerと背景の両方で表す。backend contract、HIST、4 gate、verification、decision、risk、skill auditの収集は削除しない。

selection、filter、active workspace が変わった後に返った古い detail/diff は generation check で破棄する。view を離れても app-owned の説明生成自体は cancel しない。表示対象だけを現在の workspace generation と commit evidence ID でscopeする。

## app-owned commit explanation

Commit explanation は main conversation の turn、command、eventへ流さない。UI は `CommitExplanationController` の observable state とだけ接続する。

- trigger は `auto_verified_commit | user_request | user_retry` の完全な union である。
- state は `not_generated | queued | running | generated | failed | unavailable | canceled` の7状態である。
- controller は `request` / `cancel` / `present` の Promise が解決する前に observable state を更新する。
- `not_generated` の「詳しく教えて」は `user_request`、retryable な `failed` / `canceled` / `unavailable` は `user_retry` を送る。
- `queued` / `running` は表示と明示 cancel、`generated` は cached presentation と optional narration replay を提供する。
- retry 不可の `unavailable` は安全な理由だけを表示し、操作を無効化する。

verified commit の自動 trigger は commit command 成功と SHA 検証後に app-side interceptor が発火する。Git review store はそれを推測または代理送信しない。

## 永続化と障害時動作

workspace history が writable でなければ、新しい observation/evidence を成功扱いにしない。append-only event kind は次の3つである。

- `git.observation.recorded`
- `git.work_unit.observed`
- `git.commit_evidence.recorded`

native failure は `code`、`operation`、`recoverable`、`userMessageKey`、optional `detailRef` だけの envelope へ正規化する。raw errorとinternal error codeを通常UI、timeline、clipboardへ出さない。観測またはdiffが失敗しても、取得済みの commit changes は閲覧可能なままにする。

## 検証

主要 command:

```bash
cargo test --manifest-path src-tauri/Cargo.toml git_review
cargo fmt --manifest-path src-tauri/Cargo.toml --check
pnpm exec tsc --noEmit
pnpm exec vitest run src/lib/contracts/git-review.test.ts src/lib/contracts/domain-event.test.ts src/lib/contracts/workspace-history.test.ts src/features/git-review/store.test.ts src/features/git-review/transport.test.ts src/features/git-review/EvidenceView.test.tsx src/features/workspace-view/WorkspaceShell.test.tsx
pnpm exec biome lint src/features/git-review src/lib/contracts/git-review.ts --error-on-warnings
agent-docs lint
```

Rust testは`/tmp`の使い捨てrepositoryを使い、実workspaceのindex/worktree/ref fingerprintが変化しないことを検証する。UI変更後はWebdriverIOで実Tauri windowを1470×836、1280×800、960×640にして操作し、compact commit drawer、selected identity、file path filter、最初の1 fileだけのlazy diff、old/new line number、hunk/addition/deletion/context、file keyboard移動、compact selector、mutation/internal property非露出、frontend/backend errorを確認する。

## 安全に変更するための注意

- Git operation を追加する時は runner enum、argument builder、output limit、mutation-negative test を同じ変更に含める。
- path、diff content、secret を `CommitEvidenceV1` に追加しない。説明に必要な情報は aggregate と redacted evidence で表現する。
- `unknown` / `needs_review` / `fail` を UI で `pass` に昇格しない。
- commit 説明の lifecycle を main session store に統合しない。
- list/detail/diffを一括取得せず、選択 file の diff だけを遅延取得する。
- unsupported repository state に mutation fallback を追加しない。

## 意図的な非対象

- app/native runtime による commit、stage、restore、revert、branch/ref update。
- push、fetch、merge、rebase、force、remote operation。
- arbitrary Git command、hunk editor、checkpoint comparison。
- support runtime への repository、filesystem、shell、MCP、network access。
- main conversation への commit explanation の注入。
