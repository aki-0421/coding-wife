---
title: Coding Wife Final Submission Materials
description: Paste-ready English copy, judge instructions, accepted 165-second demo evidence, a claim-to-evidence map, and final external values for the Coding Wife OpenAI Build Week submission.
updated: 2026-07-22
read_when:
  - Preparing, reviewing, or entering the final Coding Wife submission in Devpost.
  - Recording the public demo video or capturing final submission media.
  - Freezing the current release and running the anonymous judge-path smoke test.
last_verified: 2026-07-22 JST
---

# Coding Wife final submission materials

This is the current handoff for the OpenAI Build Week submission. It describes the implemented three-model product, records completed public artifacts, and keeps the remaining manual Devpost handoff values visibly marked `PENDING`. Review the English description aloud and make only factual, voice-preserving edits before pasting it into Devpost.

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
| Public source branch | https://github.com/aki-0421/coding-wife/tree/hackathon-submission-baseline |
| Primary full three-model judge platform | macOS 14+ Apple Silicon |
| Packaging previews | Windows 11 x64 and Ubuntu 22.04 / Debian 12-compatible Linux x64; install-smoked artifacts only, without a production Luna/Terra parity claim |
| Current macOS Apple Silicon judge release URL and SHA-256 | https://github.com/aki-0421/coding-wife/releases/tag/build-week-submission-2026-07-22 — `4f7e69832bf994d4a6935f95315532b52e6374b47fea9a48e23ac63a4322a27f` |
| Demo video URL | https://youtu.be/t3oyxB0aa9M |
| Primary Codex Session ID | **READY — verified private evidence; copy into Devpost without publishing it here** |
| Devpost project URL | `PENDING — entrant manual handoff` |
| Entrant / team record | `PENDING` |
| Submission state and confirmation evidence | `PENDING — entrant manual handoff` |
| Frozen product source commit | [`44d9aab779b9a66ed3f02d0016af061a71ba79c3`](https://github.com/aki-0421/coding-wife/tree/44d9aab779b9a66ed3f02d0016af061a71ba79c3) |
| Logged-out anonymous smoke result | Repository, immutable source, release, all three assets, checksum, manifest, byte identity, canonical DMG verification, install/first-launch smoke, and YouTube public playback/165-second duration: **PASS**. Devpost: `PENDING` |

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
3. **GPT-5.6 Terra (`gpt-5.6-terra`)** is an isolated, zero-tool commit explainer. The implemented controller can auto-dispatch bounded read-only evidence for a newly verified main-session commit; **Explain changes** can present or join that job, start `user_request` for an existing ungenerated commit, or start `user_retry` after failure. Terra never joins the write-capable main session. In the accepted video take, the provider rejects both the bounded `user_request` and its single `user_retry` before generation, so Coding Wife records analysis as unavailable and fails closed with zero tool or write authority. The video does not claim a generated Terra explanation.

The workspace chat removes speaker labels, timestamps, and decorative execution status so the work stays readable. Tool rows show the tool kind and executed command; success is visually quiet, while failures receive a restrained red treatment. The **Commit changes** tab follows the information density of GitHub's commit view: choose a commit, search and select a file, inspect additions and deletions, and read a unified diff with old and new line numbers. It intentionally omits internal orchestration properties that do not help a developer review code.

### Why the model orchestration matters

The three roles have different authority and latency needs. Sol needs the complete coding context and tools. Luna needs a fast, privacy-bounded signal for human presence, but no repository tools. Terra needs only verified immutable Git evidence. Its controller supports automatic silent dispatch for a newly verified main-session commit plus explicit presentation, request, and retry paths. Keeping those roles isolated makes the experience more expressive without giving presentation features coding authority or mixing support output into the main work history. The accepted take also demonstrates why that separation matters: an unsupported Terra provider event becomes a typed unavailable result instead of gaining authority, contaminating Sol's session, or being presented as generated review output.

Deterministic TypeScript and Rust contracts pin each exact model, validate inputs and outputs, bound scalar sizes, redact unsafe content, deduplicate live events, and fail closed on unsupported protocol data. The WebView has typed native commands rather than generic shell, filesystem, or Git authority. Optional speech is off unless configured; its API key stays behind the native boundary and generated audio is deleted after playback.

### How Codex helped build it

We used Codex throughout the Build Week work to turn written product and trust-boundary specifications into the React and Tauri implementation, connect the frontend to native IPC, diagnose protocol and event-ordering failures, build focused regression tests, and run real desktop QA. Codex also helped us iterate on the chat and Git review interfaces against the product goal instead of treating the app as a one-shot code generation exercise.

Human decisions remained explicit. We chose three isolated model roles instead of one all-powerful agent, kept the main session as the only write-capable role, restricted Luna to sanitized completed-message excerpts, restricted Terra to read-only commit evidence, and made the Live2D character a presentation companion rather than a technical authority. We also chose a GitHub-like review surface so developers can evaluate the actual patch without reading internal agent metadata.

### Impact and limitations

Coding Wife aims to reduce the mental work of following and reviewing a long coding session while making the experience feel more like working beside a teammate. It combines a usable coding workspace, continuous Live2D presence, and concise commit review in one local app. We have not yet run a controlled productivity study, so we claim a demonstrated workflow improvement rather than a measured time-saving percentage.

The primary current full three-model judge target is macOS 14+ on Apple Silicon. It requires a compatible authenticated local Codex installation and a writable Git repository. Windows 11 x64 and Ubuntu 22.04 / Debian 12-compatible Linux x64 artifacts are packaging previews with install or extraction smoke evidence; they do not carry an equivalent production Luna/Terra workflow guarantee. Optional OpenAI TTS requires a user-supplied API key and playback is macOS-only. The app does not provide cloud sync or remote collaboration. In the accepted capture environment, Terra's support event was not accepted by the provider, so that take proves the read-only fail-closed boundary but does not prove a generated commit explanation. The public macOS judge prerelease is ad-hoc signed, not Developer ID signed, and not notarized; its release notes provide a bounded per-app Gatekeeper **Open Anyway** path.

## 3. Judge testing instructions

### Recommended no-rebuild path

1. On a macOS 14+ Apple Silicon machine, download `Coding-Wife.dmg` from the [Build Week judge prerelease](https://github.com/aki-0421/coding-wife/releases/tag/build-week-submission-2026-07-22) and verify SHA-256 `4f7e69832bf994d4a6935f95315532b52e6374b47fea9a48e23ac63a4322a27f`.
2. The app is ad-hoc signed and not notarized. Try opening it once; if macOS blocks it, use **System Settings > Privacy & Security > Open Anyway** for Coding Wife only. Do not disable Gatekeeper or remove quarantine globally.
3. Launch Coding Wife and add a disposable writable Git repository.
4. Start a workspace and send: `Add a short Usage section to README.md, verify the change, and commit it.`
5. While Sol works, confirm that each eligible completed progress message produces a short Luna caption and a matching Live2D expression or motion. Speech is optional and should occur only if TTS was configured; unsafe excerpts are expected to remain silent.
6. When this new main-session commit becomes reachable and verified, open **Commit changes** and inspect a changed file in the unified diff. The implemented controller should attempt silent Terra dispatch for the newly verified commit when the connected provider accepts the support event.
7. Select **Explain changes**. On a compatible provider, confirm it presents cached output or joins the running Terra job. If the provider rejects the event, confirm the app records a typed unavailable result, grants no tools or write authority, and remains separate from Sol; one bounded retry may be attempted for the same commit.

Expected result: Sol completes real repository work, Luna keeps the character visibly responsive without gaining tools, and the Git tab shows the reviewable patch. Terra remains bounded to immutable read-only commit evidence. A compatible provider returns a validated explanation through the automatic or explicit path; an incompatible event is recorded as unavailable and fails closed with zero tool and write authority. The accepted video demonstrates the latter outcome for one `user_request` and one `user_retry` against the same verified commit.

The [Build Week judge prerelease](https://github.com/aki-0421/coding-wife/releases/tag/build-week-submission-2026-07-22) is the current no-rebuild path and points exactly to product source `44d9aab779b9a66ed3f02d0016af061a71ba79c3`. Repository default `develop` and the normal `v0.1.5` release are **older previews**; they must not be used as evidence for the current three-model orchestration, completed-message reactions, distilled chat UI, or GitHub-style Commit changes UX.

### Source path

Use this path on macOS 14+ Apple Silicon to inspect the implementation or run the current full-flow checkout:

```bash
git clone https://github.com/aki-0421/coding-wife.git
cd coding-wife
git checkout --detach 44d9aab779b9a66ed3f02d0016af061a71ba79c3
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

## 4. Accepted 2:45 demo record

The exact 165-second shot timing, 293-word English narration, screen operations, caption text, edit contract, and retry rules are frozen in the [final video production runbook](./13-final-video-production-runbook.md). Do not reuse the superseded 2:50 draft.

| Artifact | Accepted value |
|---|---|
| Master | `tmp/submission-video/render/coding-wife-openai-build-week-2026-master.mp4` |
| Master identity | 165.000 seconds; 1920×1080; constant 30 fps; H.264 High `yuv420p`; AAC stereo 48 kHz; SHA-256 `81feb8eb068c4e3f087845beff2b8bc94c95364786c1ac750ecc8ba57d86b94b` |
| Audio | OpenAI TTS, `gpt-4o-mini-tts`, `marin`, shot-synchronized WAV sources; −16.05 LUFS integrated; −4.30 dBTP true peak |
| Captions | Burned English captions plus `tmp/submission-video/captions/coding-wife-openai-build-week-2026-en.srt`; SHA-256 `c6a49d706887bacf1e34b95efbd7b4af4cc9e3916949351a32dced71eab7353d` |
| Screenshots | Four accepted 1920×1080 PNGs under `tmp/submission-video/evidence/screenshots/` |
| Inspection | `tmp/submission-video/evidence/media-inspection.md`; overall PASS |

The accepted causal run shows real Sol repository work through commit `d68adc0`, all three tests passing, two distinct Luna caption/Live2D reactions, and the same real diff in Commit changes. For Terra, it truthfully shows one bounded `user_request` followed by one bounded `user_retry`; both are rejected by the provider before generation and fail closed with no tools or writes. It does not show or claim a generated Terra review.

Two fresh isolated `pnpm tauri:dev` launches retained the exact prompt but left Send disabled. Production capture therefore used the repository-owned desktop-QA native Tauri binary with the real WKWebView, typed Tauri IPC, Rust backend, authenticated Codex runtime, and disposable Git repository. No demo transport or fabricated agent output was used. Final QA decoded all 4,950 frames, found zero black intervals, produced 4,950/4,950 privacy OCR evidence rows with zero high-risk findings, and passed full-resolution screenshot, subtitle, metadata, secret, and content review.

The accepted master is published at https://youtu.be/t3oyxB0aa9M with **Public** visibility, the conservative interpretation of the Official Rules. Anonymous playback, `isUnlisted=false`, and a 165-second duration were verified at 2026-07-22 08:11 JST. The YouTube title, description, and manually uploaded SRT state have not been verified and must not be claimed as complete.

## 5. Three-model architecture

| Role | Exact model | Input boundary | Output used by the product | Authority |
|---|---|---|---|---|
| Main coding session | `gpt-5.6-sol` | User task, approved context, repository/tool results | Plans, completed messages, edits, verification, commit | Write-capable within the bounded Codex session |
| Presence director | `gpt-5.6-luna` | Live-only bounded sanitized excerpt from each eligible completed main message | Validated short utterance and presentation cue | Zero tools; no repository authority |
| Commit explainer | `gpt-5.6-terra` | Bounded read-only evidence: native auto-dispatch for a newly verified main-session commit, `user_request` for an existing ungenerated commit, or `user_retry` after failure | Validated explanation when supported, or a typed unavailable result; the accepted video shows the fail-closed unavailable path | Zero tools; no repository authority |

The main process, Luna support runtime, and Terra support runtime are distinct. Presentation output does not become technical evidence, and support output does not enter the write-capable session history.

## 6. Claim-to-evidence map

| Submission claim | Repository evidence | Verification to cite or capture |
|---|---|---|
| Sol performs the real coding workflow | `src/lib/contracts/codex.ts`; `src-tauri/src/codex/types.rs`; native Codex protocol, supervisor, and workspace adapters | Main-session contract/integration tests and the recorded disposable-repository run |
| Each eligible completed main message can drive Luna presence | `src-tauri/src/codex/presence.rs`; `src-tauri/src/codex/support.rs`; `src-tauri/resources/skills/coding-wife-direct-presence/SKILL.md`; frontend narration contracts | FIFO, dedupe, live-only, sanitization, caption, motion, expression, and TTS tests; video 0:46–1:14 |
| Terra review stays bounded to immutable read-only commit evidence across automatic dispatch, `user_request`, `user_retry`, success, and unavailable outcomes | `src-tauri/src/codex/commit_explanation.rs`; `src-tauri/src/codex/support_isolation.rs`; Git review explanation adapter | Auto-generation, silent cache, running-job join, request, retry, presentation, and isolation tests; video 1:54–2:16 truthfully captures one request and one retry failing closed before generation |
| The three exact GPT-5.6 models are pinned | `src-tauri/src/codex/types.rs`; matching TypeScript contracts and tests | Model-routing and construction tests; architecture shot |
| The chat favors content over metadata | workspace timeline components and `src/features/workspace-view/WorkspaceShell.test.tsx` | UI tests and real Tauri screenshots showing no names, times, or success checks |
| Commit review follows a GitHub-style changes hierarchy | `src/features/git-review/`; `src/features/workspace-view/WorkspaceShell.test.tsx`; read-only native Git review | Commit/file selection, search, lazy diff, line-number, compact-layout, and real IPC QA evidence; video 1:30–1:54 |
| The WebView lacks generic shell/Git authority | Tauri capabilities, typed IPC commands, native repository boundary checks | Transport, request-validation, and repository-boundary tests |
| Live2D and third-party terms are explicit | `src-tauri/resources/legal/THIRD-PARTY-NOTICES.md`; bundled character notices; lock-derived dependency notices | Supply-chain and notice-generation checks |
| The repository is openly licensed | Root `LICENSE` | Anonymous repository check |

## 7. Freeze and artifact record

The product source was frozen before release publication. The public prerelease tag resolves exactly to that commit; its three assets were downloaded anonymously and compared with the accepted local artifacts.

Product-source reference values are useful for detecting unexpected drift:

| Reference | Frozen product-source value |
|---|---|
| Dependency inventory JSON SHA-256 | `4deac169342e641417b28220eb8bcd7a4ddf091f7ee00c163960fd6dac93fb8e` |
| Dependency notice Markdown SHA-256 | `57938516b9718607a3d7c165e085481e4cb3effc0ccad53586a4383eecb8a6e2` |
| Cargo lock SHA-256 | `e566d36ea3d61d7ab5f94e72eca701fc5f33e8f2d1dd0bbbddb7d476fd060c82` |
| Dependency inventory counts | 397 npm packages; 235 effective Cargo normal dependencies |

A match does not replace the public release verification recorded below.

Final external record:

| Artifact | Frozen identity |
|---|---|
| Frozen product source commit | [`44d9aab779b9a66ed3f02d0016af061a71ba79c3`](https://github.com/aki-0421/coding-wife/tree/44d9aab779b9a66ed3f02d0016af061a71ba79c3) |
| Current macOS Apple Silicon judge release | https://github.com/aki-0421/coding-wife/releases/tag/build-week-submission-2026-07-22; `Coding-Wife.dmg`; 22,433,345 bytes; SHA-256 `4f7e69832bf994d4a6935f95315532b52e6374b47fea9a48e23ac63a4322a27f` |
| Release verification | Public prerelease and exact tag target verified anonymously; all three assets downloaded; sidecar, manifest, byte identity, canonical DMG verification, and install/ten-second launch/graceful shutdown smoke PASS; release suite 39/39 PASS |
| Video URL, duration, visibility, and master SHA-256 | https://youtu.be/t3oyxB0aa9M; anonymous playback and `isUnlisted=false` verified at 2026-07-22 08:11 JST; YouTube duration 165 seconds; local accepted master `tmp/submission-video/render/coding-wife-openai-build-week-2026-master.mp4`; 165.000 seconds; SHA-256 `81feb8eb068c4e3f087845beff2b8bc94c95364786c1ac750ecc8ba57d86b94b` |
| English SRT | `tmp/submission-video/captions/coding-wife-openai-build-week-2026-en.srt`; SHA-256 `c6a49d706887bacf1e34b95efbd7b4af4cc9e3916949351a32dced71eab7353d` |
| Four submission screenshots | `tmp/submission-video/evidence/screenshots/`; accepted identities recorded in the [production runbook](./13-final-video-production-runbook.md#13-accepted-production-record) |
| Final media QA and checksums | `tmp/submission-video/evidence/media-inspection.md`; `tmp/submission-video/evidence/checksums.sha256`; PASS |
| Primary Codex Session ID | Verified against the representative thread and stored in private evidence; `/feedback` upload succeeded; Devpost field entry `PENDING` |
| Devpost URL and submitted confirmation | `PENDING` |
| Entrant / team record | `PENDING` |
| Anonymous repository, release, video, and submission smoke | Repository/source/release/downloaded DMG/Public YouTube playback, visibility, and duration: PASS. Submitted Devpost project: `PENDING` |

## 8. Final anonymous smoke

- [ ] Open the Devpost project while logged out and confirm it is marked submitted.
- [x] Open https://github.com/aki-0421/coding-wife without a maintainer session and confirm the frozen product commit, README, MIT license, and notices are visible.
- [x] On macOS 14+ Apple Silicon, download all three current submission release assets without authentication and verify the DMG sidecar, manifest, byte identity, and canonical package checks.
- [x] Install the anonymously downloaded DMG, launch the production app for ten seconds, and shut it down gracefully without rebuilding.
- [ ] Confirm the macOS release shows the same Sol/Luna and Git review behavior. Test Terra conditionally: accept a validated explanation when the connected provider supports the event, or verify a typed unavailable result with zero tool/write authority when it does not. Do not claim the video shows successful automatic Terra generation; it shows one `user_request` and one `user_retry` failing closed before generation.
- [x] Treat Windows and Linux artifacts only as install-smoked packaging previews; do not record their presence as proof of production Luna/Terra parity.
- [x] Open https://youtu.be/t3oyxB0aa9M while logged out and confirm public playback, `isUnlisted=false`, and a 165-second duration.
- [ ] Play the YouTube video while logged out; confirm it is under 3:00, has audible English narration, and contains no private data.
- [ ] Confirm every Devpost link resolves and every factual field matches the frozen source and release.
- [x] Confirm the primary Session ID was copied from the representative thread and stored only in private evidence; `/feedback` upload succeeded.
- [ ] Confirm the private Session ID was accepted by the Devpost form.
- [ ] Confirm the entrant or every team member is correct and all required invitations were accepted before the deadline.

## Official sources reverified on 2026-07-22 JST

- https://openai.devpost.com/rules
- https://openai.devpost.com/details/faqs
- https://openai.devpost.com/
- https://openai.devpost.com/details/dates
- https://openai.devpost.com/updates/45371-tuesday-last-minute-tips
- https://openai.com/build-week/
