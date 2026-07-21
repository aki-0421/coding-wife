---
name: coding-wife-commit-work
description: Safely create one reviewable Git commit for a cohesive completed work unit while protecting all pre-existing and unowned changes. Use when Coding Wife explicitly injects this skill into a main coding turn.
---

# Commit a Cohesive Work Unit

Create at most one commit for the cohesive work completed in the current turn.

## Protect Existing Work

1. Inspect `git status`, the unstaged diff, and the staged diff before staging anything.
2. Treat every change that predates the turn or is not proven to belong to the current work unit as unowned.
3. Never discard, overwrite, unstage, stage, or commit unowned changes.
4. Stop and report the conflict when an owned path also contains unowned edits or when existing staged changes make an isolated commit unsafe.

## Prepare the Commit

1. Confirm that the completed changes form one reviewable unit with a single purpose.
2. Run the relevant verification and record each check and result. Do not weaken, skip, or bypass a required check to manufacture success.
3. Stage only explicit owned paths with `git add -- <path>...`. Never use broad staging such as `git add .`, `git add -A`, or an unbounded directory path.
4. Inspect `git diff --cached --name-status`, `git diff --cached --stat`, the full staged diff, and `git diff --cached --check`.
5. Stop before committing if the staged path set or content differs from the owned work unit.

## Write the Commit

1. Use an English Conventional Commits subject such as `feat(scope): summary`.
2. Add English body bullets labeled `Changes`, `Intent`, and `Verification` that state what changed, why it changed, and which checks ran with their results.
3. Separate the subject, body, and every bullet with physical LF newline bytes. Never store the two literal characters `\n` as a substitute for a newline.
4. Construct the message with an owner-only temporary message file or multiple `git commit -m` arguments. Inspect the message bytes and lines before committing, and reject any literal `\n` sequence.
5. Run hooks normally. Never use `--no-verify`, force, amend, history rewriting, or destructive Git recovery.
6. Create no empty commit. If there is no owned staged diff, report that there is nothing to commit.
7. Create no repeated commit. If the intended work is already committed, report the existing commit instead of committing or amending again.
8. After committing, read the stored message with `git log -1 --format=%B`. Verify the subject, blank separator, and body bullets occupy distinct physical lines, inspect the resulting bytes, and reject any literal `\n` sequence before reporting success.

## Return a Typed Proof from node_repl

When the Git commit runs inside the `node_repl` `js` tool:

1. Immediately before the commit mutation, read the full HEAD with `git rev-parse --verify HEAD`. Preserve that exact lowercase SHA as `beforeHead`; use the literal value `unborn` only when the repository has no HEAD.
2. After the commit and all stored-message checks succeed, read the full resulting commit SHA with `git rev-parse --verify HEAD` as `commitSha`.
3. Before the `js` call returns, attach exactly this versioned marker with `nodeRepl.setResponseMeta({ codingWifeGitCommitProof: { schemaVersion: 1, operation: "git_commit", beforeHead, commitSha } })`.
4. Keep exactly those four fields inside `codingWifeGitCommitProof`. Do not put paths, commit output, diffs, credentials, or other repository data in the marker.
5. Do not attach the marker when the commit failed, HEAD did not change, either full SHA is unknown, stored-message verification failed, or the commit cannot be attributed to this work unit.

## Report the Result

Report the commit SHA and subject, the committed owned paths, verification results, and any protected or unresolved changes. If a safe isolated commit is impossible, leave Git history unchanged and report the exact safe reason.
