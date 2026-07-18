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
3. Run hooks normally. Never use `--no-verify`, force, amend, history rewriting, or destructive Git recovery.
4. Create no empty commit. If there is no owned staged diff, report that there is nothing to commit.
5. Create no repeated commit. If the intended work is already committed, report the existing commit instead of committing or amending again.

## Report the Result

Report the commit SHA and subject, the committed owned paths, verification results, and any protected or unresolved changes. If a safe isolated commit is impossible, leave Git history unchanged and report the exact safe reason.
