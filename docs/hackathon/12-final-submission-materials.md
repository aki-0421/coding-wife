---
title: Coding Wife Final Submission Materials
description: Paste-ready English copy, judge instructions, a three-model demo script, claim-to-evidence map, and final external values for the Coding Wife OpenAI Build Week submission.
updated: 2026-07-22
read_when:
  - Preparing, reviewing, or entering the final Coding Wife submission in Devpost.
  - Recording the public demo video or capturing final submission media.
  - Freezing the current release and running the anonymous judge-path smoke test.
last_verified: 2026-07-22 JST
---

# Coding Wife final submission materials

This is the current handoff for the OpenAI Build Week submission. It describes the implemented three-model product and keeps values that can only be known after publication visibly marked `PENDING`. Review the English description aloud and make only factual, voice-preserving edits before pasting it into Devpost.

Authority order:

1. [Official Rules](https://openai.devpost.com/rules)
2. The frozen current build and its verified behavior
3. The root [README](../../README.md) and [testing guide](../testing.md)
4. This handoff

## 1. Submission field map

| Devpost field | Value |
|---|---|
| Project title | **Coding Wife** |
| Tagline | **A Live2D coding partner powered by Sol, Luna, and Terra—with reviewable commits built in.** |
| Track | **Developer Tools** |
| Repository | https://github.com/aki-0421/coding-wife |
| Primary full three-model judge platform | macOS 14+ Apple Silicon |
| Packaging previews | Windows 11 x64 and Ubuntu 22.04 / Debian 12-compatible Linux x64; install-smoked artifacts only, without a production Luna/Terra parity claim |
| Current macOS Apple Silicon judge release URL and SHA-256 | `PENDING` |
| Demo video URL | `PENDING` |
| Primary Codex Session ID | `PENDING` |
| Devpost project URL | `PENDING` |
| Entrant / team record | `PENDING` |
| Submission state and confirmation evidence | `PENDING` |
| Frozen source commit | `PENDING` |
| Logged-out anonymous smoke result | `PENDING` |

The public repository, Developer Tools track, product title, MIT license, and implemented model roles are settled facts rather than placeholders.

### Conditional form fields

- **Hosted demo:** Not applicable unless one is actually published. The current macOS 14+ Apple Silicon test build is the no-rebuild full-flow judge path.
- **Judge account:** Not applicable; Coding Wife has no application account system.
- **Screenshots / gallery:** Provide them only if the logged-in Devpost form requests or benefits from them. They are not a substitute for the video.
- **Private repository access:** Not applicable while the repository remains public.

## 2. Paste-ready English description

### Problem

Coding agents can write and test substantial changes, but developers still have to reconstruct what happened from chat, terminal output, file edits, and Git history. That review burden grows as a session gets longer. At the same time, a purely transactional agent interface can make long coding sessions feel isolating instead of collaborative.

### What we built

Coding Wife is a bilingual desktop workspace that turns a Codex coding session into a focused pair-programming experience. The main session can perform real repository work, a Live2D character reacts to each live completed progress message that passes strict privacy screening, and the Git tab presents the resulting commit through a familiar GitHub-style changes view.

Three GPT-5.6 models act as one bounded orchestration pipeline:

1. **GPT-5.6 Sol (`gpt-5.6-sol`)** runs the main Codex session. It understands the repository request, plans the work, uses tools, edits code, verifies the result, and creates the commit.
2. **GPT-5.6 Luna (`gpt-5.6-luna`)** is an isolated, zero-tool presence director. After each eligible live completed Sol progress message, it receives only a bounded sanitized excerpt and returns a short validated reaction. That reaction drives the visible caption, Live2D expression and motion, and optional OpenAI text-to-speech. Unsafe code-, path-, diff-, or secret-like text is rejected instead of narrated.
3. **GPT-5.6 Terra (`gpt-5.6-terra`)** is an isolated, zero-tool commit explainer. For a newly verified main-session commit, the native controller starts Terra silently in the background with bounded read-only Git evidence; **Explain changes** then presents the cache or joins that running job. For an existing commit with no generated explanation, the action can start a bounded `user_request`; after a failed generation, it can start a bounded `user_retry`. Terra never joins the write-capable main session.

The workspace chat removes speaker labels, timestamps, and decorative execution status so the work stays readable. Tool rows show the tool kind and executed command; success is visually quiet, while failures receive a restrained red treatment. The **Commit changes** tab follows the information density of GitHub's commit view: choose a commit, search and select a file, inspect additions and deletions, and read a unified diff with old and new line numbers. It intentionally omits internal orchestration properties that do not help a developer review code.

### Why the model orchestration matters

The three roles have different authority and latency needs. Sol needs the complete coding context and tools. Luna needs a fast, privacy-bounded signal for human presence, but no repository tools. Terra needs only verified immutable Git evidence: the native controller starts generation automatically and silently for a newly verified main-session commit, while explicit action can present or join that job, request a missing explanation for an existing commit, or retry after failure. Keeping those roles isolated makes the experience more expressive without giving presentation features coding authority or mixing support output into the main work history.

Deterministic TypeScript and Rust contracts pin each exact model, validate inputs and outputs, bound scalar sizes, redact unsafe content, deduplicate live events, and fail closed on unsupported protocol data. The WebView has typed native commands rather than generic shell, filesystem, or Git authority. Optional speech is off unless configured; its API key stays behind the native boundary and generated audio is deleted after playback.

### How Codex helped build it

We used Codex throughout the Build Week work to turn written product and trust-boundary specifications into the React and Tauri implementation, connect the frontend to native IPC, diagnose protocol and event-ordering failures, build focused regression tests, and run real desktop QA. Codex also helped us iterate on the chat and Git review interfaces against the product goal instead of treating the app as a one-shot code generation exercise.

Human decisions remained explicit. We chose three isolated model roles instead of one all-powerful agent, kept the main session as the only write-capable role, restricted Luna to sanitized completed-message excerpts, restricted Terra to read-only commit evidence, and made the Live2D character a presentation companion rather than a technical authority. We also chose a GitHub-like review surface so developers can evaluate the actual patch without reading internal agent metadata.

### Impact and limitations

Coding Wife aims to reduce the mental work of following and reviewing a long coding session while making the experience feel more like working beside a teammate. It combines a usable coding workspace, continuous Live2D presence, and concise commit review in one local app. We have not yet run a controlled productivity study, so we claim a demonstrated workflow improvement rather than a measured time-saving percentage.

The primary current full three-model judge target is macOS 14+ on Apple Silicon. It requires a compatible authenticated local Codex installation and a writable Git repository. Windows 11 x64 and Ubuntu 22.04 / Debian 12-compatible Linux x64 artifacts are packaging previews with install or extraction smoke evidence; they do not carry an equivalent production Luna/Terra workflow guarantee. Optional OpenAI TTS requires a user-supplied API key and playback is macOS-only. The app does not provide cloud sync or remote collaboration. The frozen macOS release notes must state the exact signing and notarization status.

## 3. Judge testing instructions

### Recommended no-rebuild path

1. On a macOS 14+ Apple Silicon machine, download the **current macOS submission release** from the URL entered in Devpost and verify its published SHA-256.
2. Follow the macOS installation and bounded Gatekeeper note attached to that release.
3. Launch Coding Wife and add a disposable writable Git repository.
4. Start a workspace and send: `Add a short Usage section to README.md, verify the change, and commit it.`
5. While Sol works, confirm that each eligible completed progress message produces a short Luna caption and a matching Live2D expression or motion. Speech is optional and should occur only if TTS was configured; unsafe excerpts are expected to remain silent.
6. When this new main-session commit becomes reachable and verified, confirm the app starts Terra silently in the background, then open **Commit changes** and inspect a changed file in the unified diff.
7. Select **Explain changes** and confirm that, in this fresh-commit path, it presents a cached explanation or waits for the already-running Terra job.

Expected result for this fresh-commit test: Sol completes real repository work, Luna keeps the character visibly responsive without gaining tools, verification of the new main-session commit starts one silent Terra background job, the Git tab shows the reviewable patch, and **Explain changes** presents or joins that job's result.

The already-public `v0.1.5` release is an **older preview**. It proves that public distribution exists, but it must not be used as evidence for the current three-model orchestration, completed-message reactions, distilled chat UI, or GitHub-style Commit changes UX. Publish and link a current frozen release before submission.

### Source path

Use this path on macOS 14+ Apple Silicon to inspect the implementation or run the current full-flow checkout:

```bash
git clone https://github.com/aki-0421/coding-wife.git
cd coding-wife
corepack enable
pnpm install --frozen-lockfile
pnpm tauri:dev
```

Create a disposable repository if needed:

```bash
JUDGE_REPO_PATH="$(mktemp -d)"
git -C "$JUDGE_REPO_PATH" init -b main
printf '# Judge fixture\n' >"$JUDGE_REPO_PATH/README.md"
git -C "$JUDGE_REPO_PATH" add README.md
git -C "$JUDGE_REPO_PATH" \
  -c user.name="Build Week Judge" \
  -c user.email="judge@example.invalid" \
  commit -m "chore: seed judge fixture"
printf '%s\n' "$JUDGE_REPO_PATH"
```

No application account or bundled OpenAI API key is required for the core Codex path. The judge's local Codex installation must already be compatible and authenticated. Never test against a repository containing private or valuable work.

## 4. Exact 2:50 demo plan and English voiceover

The final video must remain under 3:00 and contain clear English audio. Record the current macOS 14+ Apple Silicon native build on a disposable repository. Configure optional macOS-only TTS before recording and never show its key. Cut loading and typing pauses rather than speeding up the explanatory moments.

| Time | Screen action | Exact English voiceover |
|---:|---|---|
| 0:00–0:12 | Show the clean workspace with Live2D visible. | “Coding Wife is a Live2D coding partner for developers who want agent work to feel collaborative and stay easy to review.” |
| 0:12–0:28 | Enter the README task and send it in the main session. | “I give the main session a real repository task: add a Usage section, verify it, and commit the result. GPT-5.6 Sol is the only role with coding tools and write authority.” |
| 0:28–0:58 | Show Sol planning and completing the first progress message. Keep the caption and character large enough to read. | “As Sol works, the app converts its activity into a focused timeline. There are no speaker labels, timestamps, or success badges competing with the actual work.” |
| 0:58–1:22 | Show two eligible completed progress messages. For each, capture Luna caption plus expression or motion; let one optional TTS reaction play. | “Each safe completed Sol message triggers a separate GPT-5.6 Luna turn. Luna sees only a bounded sanitized excerpt, has no tools, and returns a short reaction that drives the caption, Live2D expression, motion, and optional speech.” |
| 1:22–1:35 | Show a tool row and, if available, a rehearsed failed command with the restrained red background. | “Tool activity is reduced to its type and command. Successful execution stays quiet; a failure is the only state that receives a warning background.” |
| 1:35–2:00 | Open **Commit changes**, choose the commit and one file, then scroll a small unified diff. | “After Sol commits, the Git tab uses the information density of GitHub’s commit changes view: commit summary, changed files, additions and deletions, and a unified diff with old and new line numbers.” |
| 2:00–2:18 | Note that verification of this new main-session commit already started Terra silently, then select **Explain changes** and show the cached or running result. | “In this fresh-commit demo, when the new main-session commit became reachable and verified, the native controller started Terra silently in the background. Explain changes presents that cache, or waits for the same running job, without granting write access.” |
| 2:18–2:36 | Show a simple three-role architecture card or readable code snippets containing all three model IDs. | “Sol builds, Luna maintains presence, and Terra reduces review effort. Typed TypeScript and Rust contracts pin all three models, validate their inputs and outputs, redact unsafe text, and fail closed.” |
| 2:36–2:50 | Show a short commit/test montage, then a platform-accurate closing card. | “We used Codex to implement, debug, test, and QA this pipeline, while humans chose its trust boundaries. The full judge path targets macOS 14 on Apple Silicon; Windows and Linux packages are install-smoked previews.” |

### Recording acceptance

- Show the current UI, not an older preview or fixture presented as production.
- Show Sol, Luna, and Terra doing their actual distinct jobs.
- Capture at least two eligible completed-message Luna reactions; avoid token-stream chatter.
- Keep the Git shot on subject, changed files, line statistics, and diff. Do not narrate removed internal properties.
- For this fresh-commit demo, state that verification of the new main-session commit starts Terra silently in the background. Show **Explain changes** presenting cached output or joining the running job; do not describe it as the trigger for this demo's first Terra handoff.
- Do not describe Sol as the commit explainer.
- Remove keys, tokens, email, notifications, personal paths, private repository names, and unrelated trademarks.
- Use a Public YouTube video as the safest setting. The July 22 update says an Unlisted link is acceptable, while the Official Rules require the video to be publicly visible and the FAQ says public; Public avoids that conflict.
- Verify duration, audio, visibility, and playback while logged out.

## 5. Three-model architecture

| Role | Exact model | Input boundary | Output used by the product | Authority |
|---|---|---|---|---|
| Main coding session | `gpt-5.6-sol` | User task, approved context, repository/tool results | Plans, completed messages, edits, verification, commit | Write-capable within the bounded Codex session |
| Presence director | `gpt-5.6-luna` | Live-only bounded sanitized excerpt from each eligible completed main message | Validated short utterance and presentation cue | Zero tools; no repository authority |
| Commit explainer | `gpt-5.6-terra` | Bounded read-only evidence: native auto-dispatch for a newly verified main-session commit, `user_request` for an existing ungenerated commit, or `user_retry` after failure | Silent cached explanation; explicit action can present or join a job, request missing output, or retry | Zero tools; no repository authority |

The main process, Luna support runtime, and Terra support runtime are distinct. Presentation output does not become technical evidence, and support output does not enter the write-capable session history.

## 6. Claim-to-evidence map

| Submission claim | Repository evidence | Verification to cite or capture |
|---|---|---|
| Sol performs the real coding workflow | `src/lib/contracts/codex.ts`; `src-tauri/src/codex/types.rs`; native Codex protocol, supervisor, and workspace adapters | Main-session contract/integration tests and the recorded disposable-repository run |
| Each eligible completed main message can drive Luna presence | `src-tauri/src/codex/presence.rs`; `src-tauri/src/codex/support.rs`; `src-tauri/resources/skills/coding-wife-direct-presence/SKILL.md`; frontend narration contracts | FIFO, dedupe, live-only, sanitization, caption, motion, expression, and TTS tests; video 0:58–1:22 |
| A newly verified main-session commit starts Terra silently; explicit action presents or joins that job, starts `user_request` for an existing ungenerated commit, or starts `user_retry` after failure | `src-tauri/src/codex/commit_explanation.rs`; `src-tauri/src/codex/support_isolation.rs`; Git review explanation adapter | Auto-generation, silent cache, running-job join, `user_request`, `user_retry`, presentation, and isolation tests; video 2:00–2:18 |
| The three exact GPT-5.6 models are pinned | `src-tauri/src/codex/types.rs`; matching TypeScript contracts and tests | Model-routing and construction tests; architecture shot |
| The chat favors content over metadata | workspace timeline components and `src/features/workspace-view/WorkspaceShell.test.tsx` | UI tests and real Tauri screenshots showing no names, times, or success checks |
| Commit review follows a GitHub-style changes hierarchy | `src/features/git-review/`; `src/features/workspace-view/WorkspaceShell.test.tsx`; read-only native Git review | Commit/file selection, search, lazy diff, line-number, compact-layout, and real IPC QA evidence; video 1:35–2:00 |
| The WebView lacks generic shell/Git authority | Tauri capabilities, typed IPC commands, native repository boundary checks | Transport, request-validation, and repository-boundary tests |
| Live2D and third-party terms are explicit | `src-tauri/resources/legal/THIRD-PARTY-NOTICES.md`; bundled character notices; lock-derived dependency notices | Supply-chain and notice-generation checks |
| The repository is openly licensed | Root `LICENSE` | Anonymous repository check |

## 7. Freeze and artifact record

Do not treat a checksum from an earlier commit as final proof. Freeze the source first, build the current release from that exact source, then calculate and publish every immutable identity again.

Current **non-final reference values** are useful only for detecting unexpected drift:

| Reference | Current non-final value |
|---|---|
| Dependency inventory JSON SHA-256 | `4deac169342e641417b28220eb8bcd7a4ddf091f7ee00c163960fd6dac93fb8e` |
| Dependency notice Markdown SHA-256 | `57938516b9718607a3d7c165e085481e4cb3effc0ccad53586a4383eecb8a6e2` |
| Cargo lock SHA-256 | `e566d36ea3d61d7ab5f94e72eca701fc5f33e8f2d1dd0bbbddb7d476fd060c82` |
| Dependency inventory counts | 397 npm packages; 235 effective Cargo normal dependencies |

Recalculate after the final freeze; a match does not replace release verification.

Final external record:

| Artifact | Frozen identity |
|---|---|
| Source commit | `PENDING` |
| Current macOS Apple Silicon full-flow release and artifact SHA-256 | `PENDING` |
| Video URL, duration, visibility, and master SHA-256 | `PENDING` |
| Primary Codex Session ID | `PENDING` |
| Devpost URL and submitted confirmation | `PENDING` |
| Entrant / team record | `PENDING` |
| Anonymous repository, release, video, and submission smoke | `PENDING` |

## 8. Final anonymous smoke

- [ ] Open the Devpost project while logged out and confirm it is marked submitted.
- [ ] Open https://github.com/aki-0421/coding-wife without a maintainer session and confirm the frozen commit, README, MIT license, and notices are visible.
- [ ] On macOS 14+ Apple Silicon, download the current submission release without authentication, verify its SHA-256, install it, and complete the primary flow without rebuilding.
- [ ] Confirm the macOS release shows the same Sol/Luna flow, automatic silent Terra generation for the newly verified main-session commit, explicit explanation presentation, and Git review behavior claimed in the fresh-commit video demo.
- [ ] Treat Windows and Linux artifacts only as install-smoked packaging previews; do not record their presence as proof of production Luna/Terra parity.
- [ ] Play the YouTube video while logged out; confirm it is under 3:00, has audible English narration, and contains no private data.
- [ ] Confirm every Devpost link resolves and every factual field matches the frozen source and release.
- [ ] Confirm the primary Session ID was copied from the representative thread and accepted by the form.
- [ ] Confirm the entrant or every team member is correct and all required invitations were accepted before the deadline.

## Official sources reverified on 2026-07-22 JST

- https://openai.devpost.com/rules
- https://openai.devpost.com/details/faqs
- https://openai.devpost.com/
- https://openai.devpost.com/details/dates
- https://openai.devpost.com/updates/45402-deadline-tomorrow-last-minute-tips
- https://openai.com/build-week/
