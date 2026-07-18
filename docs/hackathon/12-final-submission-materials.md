---
title: Coding Wife Final Submission Materials
description: Paste-ready English copy, judging instructions, video script, field map, evidence ledger, and final smoke checklist for the Coding Wife OpenAI Build Week submission.
updated: 2026-07-18
read_when:
  - Preparing, reviewing, or entering the final Coding Wife submission in Devpost.
  - Recording the public demo video or capturing final submission screenshots.
  - Running the anonymous judge-path smoke test and freezing submission artifacts.
last_verified: 2026-07-18 JST
---

# Coding Wife Final Submission Materials

This is the managed handoff document for the final OpenAI Build Week submission. It consolidates the current repository evidence into English copy without claiming unfinished external artifacts. It does not authorize an external upload, Devpost edit, `/feedback` submission, or publication.

Use the following authority order when a value conflicts:

1. the current Official Rules;
2. the current working build and its verified behavior;
3. the root [README](../../README.md) and [testing guide](../testing.md);
4. this document.

Published rules were reverified on 2026-07-18 JST; see [Submission Requirements](./03-submission-requirements.md). Unverified logged-in fields and external artifacts remain `PENDING`.

## 1. Submission control panel

| Item | Prepared value | Final status |
|---|---|---|
| Product name in the current app and repository | `Coding Wife` | Ready as the recommended title; owner confirmation is `PENDING` |
| Recommended track | `Developer Tools` | Final Devpost selection and owner confirmation are `PENDING` |
| Exact production model | `gpt-5.6-sol` | Implemented in TypeScript and Rust contracts |
| Supported release target | macOS 14 or later on Apple Silicon | Implemented; independent install smoke is `PENDING` |
| Public repository | Candidate recorded in README: `https://github.com/aki-0421/coding-wife` | Final public and anonymous-access verification is `PENDING` |
| Public demo video | `PENDING` | Must be a public YouTube video shorter than 3:00 |
| Public demo or downloadable artifact URL | `PENDING` | No public binary or hosted production demo is currently recorded |
| Primary Codex `/feedback` Session ID | `PENDING` | Must come from the actual primary build thread |
| Team and representative | `PENDING` | Team entries require eligibility, representative sign-off, and accepted invitations before the deadline |
| Submission deadline | 2026-07-22 09:00 JST | Reverify against the Official Rules before submission |

### Project title candidates

| Priority | Candidate | Rationale | Decision |
|---:|---|---|---|
| 1 | **Coding Wife** | Matches the app bundle, repository, screenshots, and current README. | Recommended |
| 2 | **Coding Wife: Codex Mission Control** | Adds immediate category context but changes the current product title. | `PENDING` |
| 3 | **Coding Wife: Reviewable Agent Workspaces** | Emphasizes the evidence and review workflow but is less concise. | `PENDING` |

### Tagline candidates

| Priority | Candidate | Decision |
|---:|---|---|
| 1 | **Supervise long-running Codex work, approve bounded decisions, and review evidence from one local macOS workspace.** | Recommended |
| 2 | **A local macOS command center for reviewable Codex work.** | Short alternative |
| 3 | **Turn agentic coding sessions into bounded decisions, durable evidence, and inspectable commits.** | Outcome-focused alternative |

### Track owner confirmation

| Confirmation | Value |
|---|---|
| Recommended track | Developer Tools |
| Why it fits | The primary user is a developer supervising an agentic coding workflow, and the product improves implementation review, intervention, and evidence inspection. |
| Final Devpost track | `PENDING` |
| Final owner / representative | `PENDING` |
| Confirmed at | `PENDING` |
| Confirmation evidence | `PENDING` — Devpost draft screenshot or exported submission record |

Do not select another track without updating the title, description, video narration, and field map together.

## 2. Paste-ready Devpost English description

The following copy describes the current build. Trim it only after the logged-in Devpost form reveals its actual character limit.

### Problem and audience

Coding Wife is for developers who supervise long-running Codex work. Today, they often reconstruct a session from chat, terminal output, file changes, tests, Git history, and approval prompts spread across disconnected surfaces. As a session grows, it becomes harder to answer four basic questions: what changed, why it changed, whether it was verified, and where a human decision is still required.

### What we built

Coding Wife is a bilingual macOS desktop command center for that workflow. It connects to a compatible, authenticated local Codex App Server, restores durable workspace context, and turns model activity into a structured, redacted timeline. A developer can send a task, choose reasoning effort, provide approved attachments, answer explicit decisions, approve or reject bounded operations, interrupt the active turn, and inspect the resulting commit without giving the WebView generic shell, filesystem, or Git authority.

The core workflow is:

1. Register a current-user-owned, writable Git project and select a local workspace.
2. Send an instruction with a versioned project and character-context snapshot.
3. Review normalized plan, assistant, tool, file, test, Git, decision, diagnostic, and completion evidence as the work runs.
4. Make bounded decisions instead of granting invisible standing approval.
5. Inspect the completed commit through a separate read-only Git evidence service.
6. Request a structured commit explanation; captions and optional local speech appear only after an explicit presentation action.

Workspace metadata, drafts, context versions, and semantic events are retained in local SQLite. The selected Git repository remains the source of truth for the actual code. The included Live2D companion communicates status and optional speech, but it has no authority over technical policy, safety, verification, or approval.

### Why GPT-5.6 Sol is essential

The exact production model is `gpt-5.6-sol`. Through the local Codex App Server, it interprets an open-ended repository request, reasons about unfamiliar code, plans work, uses coding tools, edits files, runs verification, handles user decisions, and produces a reviewable commit. A separate zero-tool support turn can explain a completed commit from bounded, redacted evidence.

Deterministic code enforces identity, schema, persistence, redaction, and presentation boundaries, but it cannot replace the repository reasoning and tool use required to complete an unfamiliar coding task. TypeScript and Rust both pin the model. The native preflight verifies the authenticated binary, model availability, protocol compatibility, repository boundary, and supported effort levels. Versioned contracts, scalar limits, structured output, redaction, retries, and fail-closed handling prevent unsupported protocol data from silently reaching the UI.

### How Codex helped build it

We used Codex coding agents to translate written product and trust-boundary contracts into the React 19 and Tauri 2 implementation, connect TypeScript and Rust IPC, diagnose race and recovery failures, create focused and regression tests, and harden privacy, accessibility, packaging, and supply-chain behavior. The commit history preserves implementation and review units rather than presenting Codex as a single code-generation step.

Humans retained the consequential decisions. We chose the authenticated local Codex App Server instead of putting an application API key in the WebView. We kept the WebView behind typed IPC and withheld generic shell, arbitrary filesystem, and arbitrary Git commands. We separated the write-capable main Codex work unit from the app-owned read-only Git observer. We also separated background commit-explanation generation from explicit caption and speech presentation, kept local speech disabled by default, and made the no-credential browser demo visibly deterministic rather than presenting fixture output as model work.

### Potential impact and novelty

Coding Wife turns an agentic coding session into a reviewable work record: one place for the request, plan, bounded decisions, verification, commit evidence, and recovery state. This can reduce the manual reconstruction developers perform before they trust or continue long-running work. The impact has not yet been measured in a user study, so the current claim is a concrete workflow improvement rather than a quantified productivity result.

The distinctive combination is a local developer command center with normalized semantic evidence, durable recovery, explicit intervention, a read-only Git review boundary, and a separately gated explanation layer. The Live2D companion adds presence and status without becoming a policy source or hiding the equivalent text UI.

### Honest limitations

The supported release target is macOS 14 or later on Apple Silicon. Real GPT work requires a compatible, authenticated local Codex installation and a current-user-owned writable Git repository. The browser interaction demo is synthetic and does not call GPT, read or write Git, use native SQLite, or persist after restart. The current app is unsigned and not notarized, and no public binary URL or checksum is recorded yet. There is no cloud sync, remote collaboration, automatic backup, Intel Mac support, Windows support, or Linux support. A project license, public video, public artifact, primary Codex Session ID, final team record, and independent install evidence remain `PENDING` until separately completed and verified.

## 3. Judge testing instructions

### Access status

| Access path | Account or credential | Current status |
|---|---|---|
| Deterministic browser interaction demo | None | Available from a development checkout; visibly marked as non-production |
| Production native path | The judge's compatible authenticated local Codex installation | Available from source on the supported macOS target |
| Public downloadable DMG | None planned for download; Gatekeeper warning still applies | URL and checksum are `PENDING` |
| Hosted production demo | `PENDING` | No hosted production instance is currently claimed |
| Judge test account | `PENDING` | Not required for either documented local path |

### Supported platform and prerequisites

| Requirement | Supported value |
|---|---|
| Native operating system | macOS 14 or later |
| Native architecture | Apple Silicon |
| Node.js | 22.12.0 or later |
| Package manager | pnpm 10.12.2 through Corepack |
| Rust | 1.88.0, selected by `rust-toolchain.toml` |
| Native build tools | Xcode Command Line Tools and rustup |
| Production model access | A compatible authenticated local Codex installation with `gpt-5.6-sol` available |
| Judge project | A current-user-owned, writable Git repository; use the disposable fixture below |
| Application environment variables | None |
| Application API key | None; the app uses the user's authenticated local Codex installation |

Windows, Linux, Intel Mac, signing, notarization, stapling, automatic updates, and a hosted production service are not supported claims for this submission.

### Path A: two-minute deterministic interaction demo

This path verifies the judge-visible interaction without external credentials. It does not prove a live GPT call or native persistence.

```bash
git clone PENDING_FINAL_REPOSITORY_URL
cd coding-wife
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:1420/?demoAppServer=1> and:

1. Keep the preselected workspace.
2. Enter `demo:success` in the composer and select **Send**.
3. At the decision, select **One bounded unit**, then **Send answer**.
4. Select **Approve once** for the simulated focused verification command.
5. Inspect the normalized plan, tool, file, decision, and completion events.
6. Open **Commit**, inspect the evidence, and explicitly request or show the commit explanation.

Expected result: the timeline completes, the deterministic commit appears, and its explanation is not captioned or spoken until an explicit user action. The UI labels this path as a preview. It uses in-memory fixtures, performs no Git write, makes no GPT call, and resets on restart.

### Path B: production GPT-5.6 Sol path

Create a disposable judge repository:

```bash
JUDGE_REPO_PATH="$(mktemp -d /tmp/coding-wife-judge.XXXXXX)"
git -C "$JUDGE_REPO_PATH" init -b main
printf '# Judge fixture\n' >"$JUDGE_REPO_PATH/README.md"
git -C "$JUDGE_REPO_PATH" add README.md
git -C "$JUDGE_REPO_PATH" \
  -c user.name="Build Week Judge" \
  -c user.email="judge@example.invalid" \
  commit -m "chore: seed judge fixture"
printf '%s\n' "$JUDGE_REPO_PATH"
```

Start the native app from the Coding Wife checkout:

```bash
pnpm tauri dev
```

Then:

1. Select **Add project** and choose the printed disposable repository path.
2. Use the selected workspace or create a named workspace.
3. Send: `Add a Usage section to README.md with one example command, run a relevant verification, and commit the result.`
4. Review every decision and approve only the operation you intend to allow.
5. After completion, inspect **Commit > Evidence** and explicitly request the commit explanation.

Expected result: preflight confirms the exact model and supported capabilities; the timeline records normalized evidence; a real commit appears in the disposable repository; and the explanation is presented only after explicit intent. Missing authentication, model availability, repository ownership, or protocol compatibility must produce a diagnostic instead of synthetic production data.

### Repository quality gates

Run every command in [Testing Coding Wife](../testing.md) against the frozen commit. Final pass/fail output and the tested commit are `PENDING`; the same guide defines release packaging and bounded Gatekeeper handling.

## 4. Public demo video package

### Recording contract

- Target duration: **2:45 (165 seconds)**.
- Hard requirement: the final public YouTube render must be **shorter than 3:00** and include audible English voiceover.
- Record the native production workflow only after it passes on a disposable repository with `gpt-5.6-sol` visible in sanitized preflight evidence.
- If a deterministic fixture is shown, retain the visible preview label and state that it is synthetic. Never narrate fixture output as GPT output.
- Show no API keys, auth tokens, personal email, notifications, private repository URLs, machine-specific home paths, or unrelated third-party marks.
- Use no music or third-party footage unless rights are documented. Voiceover-only is acceptable.
- Replace every `PENDING` closing-card value before export. Reject the render if a placeholder remains.

### 2:45 shot list and exact English voiceover

| Time | Duration | Shot and on-screen action | English voiceover |
|---:|---:|---|---|
| 0:00–0:08 | 8s | Clean title card over the English workspace UI. Show `Coding Wife` and `Developer Tools candidate`; do not show an unconfirmed award or track badge. | “Coding Wife is a local macOS command center for developers supervising long-running Codex work.” |
| 0:08–0:20 | 12s | Rapid, readable cuts within the app: chat, activity evidence, a decision, and Commit. Keep all text sanitized. | “Today, developers reconstruct a session across chat, terminal output, file changes, tests, and Git. That makes it easy to miss what changed and where human judgment is still required.” |
| 0:20–0:32 | 12s | Settle on the full workspace with the timeline, composer, tabs, and companion visible. | “Our Developer Tools project turns one coding session into a durable bilingual workspace with structured evidence, bounded decisions, and inspectable commits.” |
| 0:32–0:45 | 13s | Start the verified native run on a disposable repository. Show sanitized preflight evidence containing `gpt-5.6-sol`; hide local paths beyond the fixture name. | “This is the production native path on a disposable repository. Preflight verifies the authenticated local Codex installation, repository boundary, and exact model: GPT-5.6 Sol.” |
| 0:45–0:59 | 14s | Enter the README Usage task and send it. Briefly show the selected Fast or Max effort and the immutable context indicator. | “I ask it to update the README, run a relevant check, and commit. Coding Wife sends the instruction with a versioned, validated context snapshot, never generic shell access from the WebView.” |
| 0:59–1:14 | 15s | Show the plan and bounded decision. Choose **One bounded unit** and submit the answer. | “GPT-5.6 Sol interprets the unfamiliar repository, builds a plan, and pauses at a bounded decision. I choose one bounded unit; the agent cannot silently decide for me.” |
| 1:14–1:29 | 15s | Show the exact verification approval card. Select **Approve once**, then show tool, file, test, and completion events arriving. | “The proposed verification command appears with approve-once and reject controls. After I approve it, the timeline records tools, files, tests, and completion as normalized evidence rather than raw private reasoning.” |
| 1:29–1:45 | 16s | Open **Commit** and show full SHA, work correlation, changed files, gate result, and risks. | “The completed commit now appears in the read-only Git evidence view. I can inspect its identity, correlation, changed files, verification result, and known risks without granting the observer write authority.” |
| 1:45–2:01 | 16s | Let background generation finish without an overlay, then select **Show explanation** once. Show caption; keep speech off unless a clean local voice demonstration was rehearsed. | “A separate zero-tool support turn generates a redacted commit explanation in the background. Captions and optional local speech remain silent until I explicitly select Show explanation.” |
| 2:01–2:19 | 18s | Cut between the architecture diagram and readable snippets that pin `gpt-5.6-sol` in TypeScript and Rust. Avoid scrolling through dense code. | “GPT-5.6 Sol is essential for planning, repository tool use, editing, verification, and this bounded explanation. Typed TypeScript and Rust contracts pin the model, validate schemas, redact output, and fail closed on unsupported protocol shapes.” |
| 2:19–2:33 | 14s | Show a concise commit-history or test-result montage with private identifiers removed. Overlay three labels: contracts, race recovery, regression tests. | “We used Codex agents to translate written contracts into React and Tauri, diagnose race and recovery failures, and build regression tests. Humans chose the trust boundaries, approval model, and explicit presentation policy.” |
| 2:33–2:45 | 12s | Closing card with the final project, repository, and testing links. Include `macOS 14+ · Apple Silicon · authenticated local Codex required`. | “The result makes agent work reviewable without removing human responsibility. This Apple Silicon macOS release requires authenticated local Codex. Repository and testing instructions are in the submission.” |

### Video capture and publication record

| Item | Value |
|---|---|
| Recording owner | `PENDING` |
| Voiceover owner or approved voice | `PENDING` |
| Native production run commit | `PENDING` |
| Disposable demo repository commit | `PENDING` |
| Local master filename | `PENDING` |
| Final duration | `PENDING` — must be less than 3:00 |
| Master SHA-256 | `PENDING` |
| Public YouTube URL | `PENDING` |
| YouTube visibility | `PENDING` — must be Public, not Unlisted or Private |
| Logged-out playback verification | `PENDING` |
| English audio verification | `PENDING` |
| Placeholder scan | `PENDING` |
| Rights/privacy review | `PENDING` |

## 5. Devpost field map

The public pages do not expose every logged-in form label or character limit. Create a draft early, map the actual labels to this table, and leave any unseen optional field marked `PENDING_FORM_CONFIRMATION` rather than guessing.

| Devpost value or form area | Published requirement | Prepared source | Final value / status |
|---|---|---|---|
| Project title | Required project identity | Title candidates in section 1 | `PENDING` |
| Tagline / short summary | Confirm actual field and limit | Tagline candidates in section 1 | `PENDING_FORM_CONFIRMATION` |
| Track | Exactly one track | Developer Tools recommendation and owner block | `PENDING` |
| English project description | Required | Paste-ready section 2 | Ready; final form-length check is `PENDING` |
| Public demo video URL | Required public YouTube video under 3:00 | Section 4 | `PENDING` |
| Repository URL | Required | README candidate plus anonymous verification | `PENDING_FINAL_REPOSITORY_URL` |
| Live demo / try-it URL | Confirm actual field | No hosted production demo is claimed | `PENDING_FORM_CONFIRMATION` |
| Download / artifact URL | Developer tool testing access | Release ledger in section 6 | `PENDING` |
| Testing instructions | Required for developer tools | Section 3 | Ready; final URL substitution is `PENDING` |
| Supported platforms | Required for developer tools | Section 3 | macOS 14+ on Apple Silicon |
| Installation prerequisites | Required for developer tools | Section 3 | Ready |
| Judge credentials | Required only if the chosen access path needs them | No account needed for documented local paths | `PENDING_FORM_CONFIRMATION` |
| Primary Codex `/feedback` Session ID | Required | Actual primary Codex build thread only | `PENDING` |
| Team members | Required for a team entry; invitations must be accepted before the deadline | Final team roster and accepted invitation evidence | `PENDING` |
| Team representative | Required by rules | Owner confirmation | `PENDING` |
| Built with / technology tags | If shown | Codex, `gpt-5.6-sol`, React, TypeScript, Tauri, Rust, SQLite, Live2D | `PENDING_FORM_CONFIRMATION` |
| Screenshots / gallery | If shown | Screenshot ledger in section 6 | `PENDING_FORM_CONFIRMATION` |
| Cover image / thumbnail | If shown | Final approved screenshot or composed cover | `PENDING_FORM_CONFIRMATION` |
| Project license | Required before a public repository submission | Repository-level license review | `PENDING` |
| Prior work / Build Week boundary | Required for an existing project | README Build Week section and audit boundary | Ready; final commit range is `PENDING` |
| Private repository invitations | Required before the deadline only if repository remains private | `testing@devpost.com` and `build-week-event@openai.com` | `PENDING` if the final repository is private; otherwise not applicable |
| Submission/project URL | Generated externally | Save after draft creation and after submit | `PENDING` |
| Submission confirmation/export | Operational evidence | Screenshot or PDF after final submit | `PENDING` |

## 6. Submission artifact ledger

| Artifact | Expected identity or path | SHA-256 / immutable identity | External location | Status |
|---|---|---|---|---|
| Source submission snapshot | Final repository `HEAD` | `PENDING` — final Git commit SHA | `PENDING_FINAL_REPOSITORY_URL` | `PENDING` |
| Audit boundary | `fbd7be97fe3805f916bb2cbe6f78f842caee3630` | Git commit identity | Repository history | Recorded; not a claim about the official period start |
| macOS DMG | `src-tauri/target/release/bundle/dmg/Coding-Wife.dmg` | `PENDING` | `PENDING_PUBLIC_DEMO_OR_ARTIFACT_URL` | Build/publication/install smoke `PENDING` |
| Video master | `PENDING` | `PENDING` | Local controlled storage | `PENDING` |
| Public video | Same approved bytes as the final master where platform processing permits comparison | Local master SHA-256 `PENDING` | `PENDING_PUBLIC_VIDEO_URL` | `PENDING` |
| Screenshot S01 | English workspace and normalized timeline | `PENDING` | Devpost gallery `PENDING` | `PENDING` |
| Screenshot S02 | Bounded decision and approve/reject controls | `PENDING` | Devpost gallery `PENDING` | `PENDING` |
| Screenshot S03 | Read-only commit evidence | `PENDING` | Devpost gallery `PENDING` | `PENDING` |
| Screenshot S04 | Explicit commit explanation caption | `PENDING` | Devpost gallery `PENDING` | `PENDING` |
| Devpost final record | Final confirmation screenshot or PDF | `PENDING` | Controlled submission archive | `PENDING` |
| `/feedback` record | Session ID, capture time, and related commit range | `PENDING` | Devpost private field / controlled evidence log | `PENDING` |

Generate and record immutable identities only after the artifacts are frozen:

```bash
git rev-parse HEAD
shasum -a 256 src-tauri/target/release/bundle/dmg/Coding-Wife.dmg
shasum -a 256 PENDING_VIDEO_MASTER_PATH
shasum -a 256 PENDING_SCREENSHOT_PATH
```

Do not paste a checksum copied from a different build, renamed draft, transcoded download, or earlier screenshot.

## 7. Claim-to-evidence map

| Submission claim | Code or configuration evidence | Verification evidence | Video / screenshot proof | Freeze status |
|---|---|---|---|---|
| Production pins `gpt-5.6-sol` | `src/lib/contracts/codex.ts`; `src-tauri/src/codex/types.rs`; `src-tauri/src/codex/protocol.rs` | TypeScript contract tests; Rust Codex protocol and integration tests | Video 0:32–0:45 and 2:01–2:19 | Final gate and shot `PENDING` |
| WebView has a typed native boundary rather than generic shell authority | `src/features/codex/workspace-session-adapter.ts`; `src-tauri/src/codex/commands.rs`; Tauri capabilities and CSP | Transport, adapter, request-validation, and native command tests | Video 0:45–0:59 | Final gate `PENDING` |
| Activity becomes normalized, redacted, durable evidence | `src-tauri/src/codex/normalizer.rs`; `src-tauri/src/codex/redaction.rs`; `src-tauri/src/workspace_history/`; `src/features/codex/event-projection.ts` | Normalizer, redaction, projection, history, recovery, and persistence tests | Video 1:14–1:29; S01 | Final gate and S01 `PENDING` |
| Human decisions are bounded and interruptible | `src-tauri/src/codex/decision.rs`; `src/features/codex/workspace-session-adapter.ts`; workspace view controls | Decision, pending-response, Stop, recovery, and workspace transition tests | Video 0:59–1:29; S02 | Final gate and S02 `PENDING` |
| App-owned Git review is read-only | `src-tauri/src/git_review/`; `src/features/git-review/`; typed Git review contracts | Git runner, repository boundary, evidence, integration, store, and transport tests | Video 1:29–1:45; S03 | Final gate and S03 `PENDING` |
| Commit explanation is isolated and explicitly presented | `src-tauri/src/codex/commit_explanation.rs`; `src-tauri/src/codex/support_isolation.rs`; `src/features/git-review/commit-explanation-adapter.ts`; narration policy | Support isolation, commit explanation, intent-race, narration, and demo composition tests | Video 1:45–2:01; S04 | Final gate and S04 `PENDING` |
| Production history is local SQLite; browser demo is deterministic | `src-tauri/src/workspace_history/store.rs`; explicit demo transport/runtime selection in `src/app/` and `src/features/git-review/demo-transport.ts` | Workspace history tests and App demo tests | Path A preview label plus native Path B | Final smoke `PENDING` |
| Release target is macOS 14+ Apple Silicon | `src-tauri/tauri.conf.json`; release scripts; `docs/testing.md` | Release-script tests, debug native build, final DMG/install smoke | Closing card | Final DMG/install smoke `PENDING` |
| Live2D is presentation-only and optional speech is local | Character runtime and context contracts; `src-tauri/src/narration/`; `/usr/bin/say` policy | Character security, supply-chain, narration policy, caption, and settings tests | Main workspace and optional caption shot | Final gate `PENDING` |
| Build Week work is separable from the audit boundary | Root README; Git history after `fbd7be97fe3805f916bb2cbe6f78f842caee3630` | `git diff --stat` and `git log` for the frozen range | Codex/test montage 2:19–2:33 | Final submission commit `PENDING` |

The evidence map identifies where to verify a claim; it does not turn a pending gate or artifact into a completed one.

## 8. Anonymous smoke test

Run this after the source commit, README, DMG, video, screenshots, and Devpost draft are frozen. Use a tester who did not prepare the submission when possible.

### A. Anonymous public-link smoke

- [ ] Open the final Devpost URL in a logged-out private browser window.
- [ ] Confirm the title, tagline, track, English description, and limitations match the frozen build.
- [ ] Open the repository URL without a maintainer session.
- [ ] Confirm the repository resolves to the frozen submission commit.
- [ ] Confirm a repository-level license is present and approved.
- [ ] Play the YouTube video while logged out.
- [ ] Confirm YouTube visibility is **Public**.
- [ ] Confirm the duration is less than 3:00, English voiceover is audible, and no placeholder or private data appears.
- [ ] Open every screenshot at full size and check legibility, English context, and privacy.
- [ ] Open the public DMG or demo URL if one is submitted; confirm it is free and unrestricted for judging.

### B. Fresh-checkout deterministic path

- [ ] Clone the public repository into a new directory.
- [ ] Run `corepack enable` and `pnpm install --frozen-lockfile`.
- [ ] Run `pnpm dev` and open `http://127.0.0.1:1420/?demoAppServer=1`.
- [ ] Complete Path A using only the English instructions in section 3.
- [ ] Confirm the preview label is visible and no text implies the fixture called GPT or wrote Git.
- [ ] Confirm the commit explanation is silent until explicit presentation.
- [ ] Restart and confirm the deterministic fixture does not claim persistence.

### C. Fresh native production path

- [ ] Use a macOS 14+ Apple Silicon machine or a clean test profile.
- [ ] Verify a compatible local Codex installation is authenticated without exposing credentials.
- [ ] Create the disposable repository from section 3.
- [ ] Run `pnpm tauri dev` from the frozen source commit.
- [ ] Add only the disposable repository.
- [ ] Confirm preflight reports `gpt-5.6-sol` and supported capabilities.
- [ ] Complete Path B and inspect the real resulting commit.
- [ ] Exercise one bounded decision, one approve/reject control, and Stop where safe.
- [ ] Confirm the Git evidence observer performs no write.
- [ ] Confirm commit explanation generation does not speak or caption until explicit intent.
- [ ] Quit and relaunch; verify the documented local recovery behavior.

### D. DMG install smoke, if submitted

- [ ] Build `Coding-Wife.dmg` from the frozen source commit with `pnpm release:macos`.
- [ ] Record its SHA-256 before upload.
- [ ] Download the public artifact into a clean location and record its SHA-256.
- [ ] Confirm the downloaded checksum matches the recorded artifact.
- [ ] Open the DMG, drag the app to Applications, and launch it.
- [ ] Follow only the bounded System Settings **Open Anyway** process if Gatekeeper blocks the unsigned app.
- [ ] Do not disable Gatekeeper or remove quarantine globally.
- [ ] Confirm the built-in Hiyori model renders and the first native workspace flow starts.

### E. Final repository and form integrity

- [ ] Run every quality gate listed in section 3 against the frozen commit.
- [ ] Record command, timestamp, platform, commit SHA, and concise pass/fail result.
- [ ] Run a secret/privacy scan appropriate to the repository before publication.
- [ ] Confirm no `.env`, key, token, credential, personal path, private URL, or private prompt is committed or visible in media.
- [ ] Execute `/feedback` in the actual primary build thread and copy the returned Session ID exactly once.
- [ ] Confirm the Session ID in Devpost matches the controlled evidence record.
- [ ] For a team entry, confirm all team members and the representative are correct, and every team invitation was accepted before the deadline.
- [ ] Save the final confirmation page and submission URL.

### Smoke sign-off record

| Field | Value |
|---|---|
| Frozen source commit | `PENDING` |
| Tester | `PENDING` |
| Test machine / profile | `PENDING` |
| Started at | `PENDING` |
| Completed at | `PENDING` |
| Path A result | `PENDING` |
| Path B result | `PENDING` |
| DMG result | `PENDING` |
| Public links result | `PENDING` |
| Quality-gate result | `PENDING` |
| Privacy/rights review | `PENDING` |
| Blocking findings | `PENDING` |
| Final Go / No-Go owner | `PENDING` |
| Final decision | `PENDING` |

No-Go if any required field, external URL, owner confirmation, Session ID, public video check, repository license, or anonymous judge path remains `PENDING` at submission time.
