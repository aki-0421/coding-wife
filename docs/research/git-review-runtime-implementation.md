---
title: Git review runtime 実装・検証ガイド
description: Git baseline、hunk ownership、temporary index checkpoint、review pack、compare、安全な restore を実装・変更・検証するための責務と不変条件。
updated: 2026-07-18
read_when:
  - Git baseline、ownership gate、automatic checkpoint、review pack を実装または変更するとき。
  - Commit tab の diff、compare、revert checkpoint、recovery branch を接続または検証するとき。
  - Git 操作の crash recovery、外部変更、ユーザー index 保護を調査するとき。
---

# Git review runtime 実装・検証ガイド

## 目的と境界

Git review runtime は、Codex の「完了した」という申告ではなく、観測した repository 状態と構造化 evidence から checkpoint 可否を決める Rust 側の信頼境界である。対象は登録済み local worktree に限定し、次だけを行う。

- session/work unit 開始時に HEAD、branch/detached、実 index、tracked、untracked の baseline を取得する。
- baseline、現在状態、AI file event chain を照合し、owned hunk と保護対象を分類する。
- Scope、Ownership、Verification、Risk の 4 gate がすべて Pass の時だけ local checkpoint を作る。
- checkpoint の実差分から redacted review pack を作り、HIST sink へ追記する。
- checkpoint 間の summary、file list、file 単位 lazy diff を read-only で返す。
- 二段階確認後だけ revert 相当の新 commit または checkout しない recovery branch を作る。

WebView は workspace ID、work unit ID、checkpoint ID、file ID、confirm token だけを渡す。canonical path、Git executable path、Git argument 配列、index path、ref update command は Rust 内で解決する。manual stage/commit、push、merge、force、rebase、hard reset、checkout discard、clean、remote ref update は実装しない。

## ファイル責務

| path | 責務 |
|---|---|
| `src-tauri/src/git_review/types.rs` | versioned IPC/domain DTO、gate、manifest、pack、restore preview/result |
| `src-tauri/src/git_review/error.rs` | operation と recoverability を持つ安全な error envelope |
| `src-tauri/src/git_review/runner.rs` | compile-time allowlist の Git operation と bounded process 実行 |
| `src-tauri/src/git_review/repository.rs` | canonical root/metadata identity、unsupported state、baseline/current fingerprint |
| `src-tauri/src/git_review/ownership.rs` | file event chain、hunk classification、3-way synthesis、limit/secret/LFS policy |
| `src-tauri/src/git_review/checkpoint.rs` | temporary index/object store、commit-tree、object promotion、CAS ref update |
| `src-tauri/src/git_review/review_pack.rs` | 実 commit 由来 summary、redaction、HIST event、lazy diff/compare |
| `src-tauri/src/git_review/restore.rs` | impact preview、one-shot token、revert tree、recovery ref、compensation |
| `src-tauri/src/git_review/service.rs` | workspace/work unit state、single mutation lock、idempotency、crash reconciliation |
| `src/lib/contracts/git-review.ts` | WebView が利用できる exact-key contract と parser |

`src-tauri/src/lib.rs` の Tauri command 登録、`src/lib/contracts/index.ts` の再 export、Evidence UI は共有ファイルの所有権を移管された段階で接続する。専用 module と contract の test は登録前から実行可能に保つ。

## 脅威

| 脅威 | 防御 |
|---|---|
| user の staged/unstaged/untracked を checkpoint に混入 | baseline content/fingerprint と current/file event chain を照合し、real index を stage に使わない |
| 同一 file の外部編集または overlapping hunk | event の before/after hash chain と 3-way synthesis が一致しない時は Unowned で停止 |
| WebView から任意 Git command/ref/path を注入 | command enum と Rust 内の argument builder、relative path/ref/SHA validation |
| `.git`、symlink、submodule、bare、LFS 経由の境界越え | canonical root/metadata identity を毎 mutation 前に再検証し、unsupported state を read-only にする |
| external HEAD/index race | baseline/current fingerprint を gate 前、object 作成後、CAS 直前に再照合する |
| timeout/output bomb/orphan process | 既存 bounded runner の timeout、stdout/stderr limit、process group termination を再利用する |
| hook/config による任意 code execution | porcelain/plumbing command だけを使い、hooks を起動しない。custom executable、alias、pager、prompt を無効化する |
| secret/path が review pack、stderr、DB に残る | persist 前に workspace/home/credential pattern を redact し、raw process output を event に入れない |
| confirm token の replay/対象差替え | token は operation、workspace、target SHA、current fingerprint、expiry に bind し、一度だけ consume する |
| checkpoint/revert 中の crash | prepared → objects_ready → ref_updated → history_complete の durable boundary を記録し、ref の CAS 結果から再分類する |

## repository と baseline の不変条件

1. root は登録時の canonical root、device、inode と一致する regular worktree である。
2. `.git` marker、resolved git dir、common dir、HEAD は symlink ではなく、owner/mode policy を満たす。
3. bare repository、submodule root、merge/rebase/cherry-pick/revert/bisect 中、sparse index、Git LFS pointer mutation は checkpoint/restore を Blocked にする。
4. baseline は full HEAD SHA、symbolic branch または detached、index entry hash、status hash、staged/unstaged/untracked item fingerprintを持つ。
5. baseline の private file bytes は ownership synthesis に必要な範囲だけ app-private operation state に置き、IPC、log、HIST payload に出さない。
6. baseline と current の最大対象は 500 files、合計 50 MiB、50,000 changed lines で、超過は summary を偽装せず Blocked にする。

## ownership model

AI file event は `eventId`、repo-relative path、operation、before content hash、after content hash、observed HEAD/index fingerprint を持つ。複数 event は同じ path 内で `previous.after == next.before` の chain になり、最後の `after` が current file と一致しなければならない。

分類は次の通りである。

- `owned`: baseline から current への変化を完全な event chain が説明する。
- `pre_existing`: baseline 前から存在し、checkpoint へ入れない user change。
- `external`: baseline 後の変化を event chain が説明しない。
- `overlap`: HEAD → baseline と baseline → current の 3-way synthesis が競合する。
- `unowned`: external、overlap、不完全 event、unsupported file の総称。

pre-existing change は常に unowned data として表示し、temporary index へ入れない。ただし、別 path または同一 file の非重複領域で baseline から不変なら保護対象として隔離できる。external drift、overlap、event path 内の説明不能な byte は Ownership gate を Fail にする。

text file は `ours=HEAD content / base=baseline worktree content / theirs=current content` の 3-way synthesis で checkpoint 用内容を作る。これにより同一 file の非重複 user change を除外し、AI hunk だけを HEAD へ適用できる。binary、symlink、submodule、LFS pointer は pre-existing change と同時に安全分離できないため fail closed とする。

## 4 gate

| Gate | Pass | Blocked |
|---|---|---|
| Scope | objective 1〜500文字、acceptance 1〜20件、event 1件以上、上限内 | 欠落、対象外 path、空 diff、500 files/50 MiB/50k lines超過 |
| Ownership | event chain、current hash、3-way synthesis、HEAD/index identity が一致 | external、overlap、unknown、symlink/submodule/LFS、race |
| Verification | 1件以上の required check がすべて passed で fingerprint が fresh | 0件、failed/skipped/inconclusive、stale |
| Risk | low/medium、または高 risk の対象・影響・可逆性に bind した approval | secret/auth/permission/migration/data/Git history の未承認、禁止 operation |

`Needs review` は Pass ではない。4件すべてが `pass` の時だけ checkpoint preparation を開始する。

## temporary index checkpoint

1. private temporary directoryを owner-only で作り、index、object directory、baseline material を置く。
2. `GIT_INDEX_FILE` を temporary index、`GIT_OBJECT_DIRECTORY` を temporary object directory、repository object directory を alternate に固定する。
3. HEAD tree を temporary index へ読み、owned synthesis だけを blob/update-index へ反映する。
4. staged tree が baseline HEAD と異なり、manifest と一致することを再検証する。
5. repository の `user.name` / `user.email` が存在し、message が英語 Conventional Commits summary + 英語 bullet であることを検証する。
6. `write-tree` と `commit-tree` で parent=observed HEAD の unsigned local commit を temporary object directoryへ作る。hooks、pager、editor、network は起動しない。
7. HEAD/index/repository identity を再確認し、新しい loose object を repository object store へ content-addressed copy する。
8. symbolic branch または detached HEAD を expected old SHA 付き `update-ref` で一度だけ CAS 更新する。
9. review pack を実 commit から生成して HIST へ追記し、terminal state にする。

real index の byte/entry fingerprint と worktree content は checkpoint の成功・失敗で直接変更しない。CAS 失敗時は HEAD/ref も不変で、temporary files は削除する。object promotion 後の失敗では到達不能 object が残り得るが、source/index/worktree/ref は不変であり、cleanup/reconcile対象として記録する。

## review pack と read API

pack は schema version、checkpoint/work unit/workspace ID、SHA、parent SHA、objective、acceptance、message、scope、owned/pre-existing/unowned manifest、diff stat、verification、decisions、failed attempts、known risks、restore guidance、operation stateを持つ。path は repo-relative、private absolute path と secret value は redaction 後にも保存しない。

HIST へは fixed schema の `git.review_pack.recorded` event として追記し、同じ event ID の exact replay だけを idempotent とする。checkpoint ref 更新後に persistence が失敗した場合は `ref_updated_history_pending` として成功完了を表示せず、同じ pack digest で retry する。

read API は次の順に分離する。

1. pack list/summary: SHA、gate、file/test/risk count。
2. pack detail/file list: relative path、status、ownership、add/delete count。
3. lazy file diff: checkpoint parent と checkpoint の選択 file だけ、最大 1 MiB の sanitized chunk。
4. compare: 同一 repository の2 checkpointについて file/test/decision/risk 差を返し、HEAD/index/worktreeを変更しない。

## restore

restore は必ず preview と confirm の二段階である。

### revert checkpoint

preview は target commit、current HEAD、dirty/index/untracked、target path、予想 add/delete、conflict、repository identityを再取得する。dirty、stale、conflict、unowned、unsupported、target が single-parent commit でない場合は token を発行しない。

confirm は one-shot token を先に consume し、target tree の逆変更を current HEAD へ3-wayで適用した treeを作り、parent=current HEAD の新 commitを作る。元 commit は削除しない。source/index/worktreeを破壊する hard reset、checkout discard は使わない。安全に worktree parity を保証できない環境では current branch を変更せず、revert commit object と recovery guidance を返す fail-closed policy とする。

### recovery branch

preview は target SHA と既定 `recovery/<short-sha>` を示し、`check-ref-format --branch`、ref 不在、object type commit を検証する。confirm は `refs/heads/<name>` を zero-old CAS で作り、checkout、HEAD、index、worktree、remote を変更しない。

cancel は token を破棄するだけで Git process を起動せず、全 fingerprint を維持する。replay、expiry、fingerprint drift は新しい preview を要求する。

## crash boundary と idempotency

| state | durable fact | restart classification |
|---|---|---|
| `prepared` | baseline/gates/pack intent digest | ref unchangedなら safe retry、state driftなら Blocked |
| `objects_ready` | temporary/new object IDs | ref unchangedなら unreachable object cleanup後 retry |
| `ref_updated` | expected old/new/ref | ref==newなら history retry、refが別値なら external race |
| `history_complete` | pack event sequence/digest | exact request replayは同じ結果を返す |
| `failed` | error code、observed fingerprints |自動 retry/自動 mutationをしない |

checkpoint の `clientRequestId` と work unit ID は同じ payload digest の exact replay だけを受理する。異なる payload の再利用は conflict である。restore token は terminal resultを返した後も再実行しない。

## 検証

Rust integration test は必ず `/tmp` の使い捨て repository で実施し、ユーザー repositoryを渡さない。

| scenario | 証明すること |
|---|---|
| clean + AI create/update/delete | tree、parent、message、author、SHA、pack が一致する |
| staged/unstaged/untracked pre-existing | protected content が commit treeへ入らず real index/worktree fingerprintが保たれる |
| same file non-overlap / overlap |非重複だけを synthesisし、重複は Unownedで停止する |
| external file/HEAD/index race | CAS前に検出し mutation しない |
| bare/submodule/LFS/symlink | read-only reasonを返し checkpoint/restoreしない |
| identity/hook/signing policy不足 | commitを作成済みと表示せず ref/index/worktreeを保つ |
| 500 files/50 MiB/50k lines |境界内だけ処理し、超過前に Blockedにする |
| secret/home path fixture | pack/event/diff/errorに raw値がない |
| compare/lazy diff | read-onlyで、指定file以外を返さない |
| revert/recovery/cancel/replay |二段階token、new commit/ref、checkoutなし、再実行なし |
| crash after prepare/object/ref | journalと実refから一意に再分類できる |
| timeout/output/process tree | bounded runnerが全childを終了し raw stderrを永続化しない |

主要 command:

```bash
cargo test --manifest-path src-tauri/Cargo.toml git_review
cargo test --manifest-path src-tauri/Cargo.toml --test git_review_integration
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm exec vitest run src/lib/contracts/git-review.test.ts
agent-docs lint
```

## 安全に変更するための注意

- Git command を追加する時は string argument を IPC から渡さず、operation enum、最大出力、timeout、environment、mutation classification、test を同じ変更に含める。
- baseline/public DTOへ file content、absolute path、index path、stderr を追加しない。
- gateを UI boolean だけで解除しない。approval は target、risk、fingerprintへ bindする。
- checkpoint/restore の success は ref と persisted pack の双方を再確認するまで通知しない。
- unsupported状態を便利な fallback command で続行しない。
- integration test は current repositoryを使わず、fixtureごとに新しい temp directoryを作る。

## 意図的な非対象

- push、fetch、merge、rebase、force、remote ref/notes。
- hard reset、checkout discard、clean、stash。
- manual stage/commit、任意 hunk editor、任意 Git argument。
- submodule/LFS mutation、octopus/merge commit revert、worktree自動作成。
- support reviewer に repository、filesystem、shell、追加toolを与えること。
