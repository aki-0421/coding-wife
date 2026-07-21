# Coding Wife

> A Live2D pair-programming workspace that turns long-running Codex sessions into bounded decisions, reviewable commits, and human-readable evidence.

Coding Wife is an OpenAI Build Week entry for the **Developer Tools** track. It is a bilingual desktop workspace for developers who delegate substantial coding work to Codex but still need to understand, steer, and review that work.

## Problem

Long-running coding agents produce a story spread across chat, plans, tool calls, approval prompts, file changes, test output, and Git. Reconstructing that story is expensive: the developer must discover what changed, why it changed, what was verified, and which decisions still belong to a human.

## Solution

Coding Wife keeps the real coding session, human intervention points, and review evidence in one React 19 and Tauri 2 desktop app. GPT-5.6 Sol performs repository work, while isolated GPT-5.6 Terra and Luna roles turn verified commits and live session events into concise explanations and character presence. Rust owns the trust boundary; the Live2D character owns presentation, never technical authority.

## Two-minute judge path

On macOS 14 or later with Apple Silicon, after launching the current source build:

1. Select **Add project** and choose a current-user-owned, writable Git repository. A disposable repository is recommended.
2. Send: “Add a Usage section to README.md with one example command, run a relevant verification, and commit the result.”
3. Review any bounded decision or approval request before continuing. Use **Stop** if the scope no longer matches your intent.
4. Watch completed Codex messages become short Luna captions, expressions, and motions beside the conversation. Speech is optional.
5. Open **Commit** and inspect the resulting change in the GitHub-style file navigator and unified diff.
6. Choose **Explain changes** to present Terra’s redacted explanation of the verified commit.

The model task itself may take longer than two minutes. The judge path is intentionally one narrow workflow: request, intervene, inspect the commit, and understand the result.

## What the product does

- Runs a real, authenticated local Codex App Server session against a selected Git project.
- Streams assistant messages, plans, tool activity, file changes, decisions, approvals, failures, and completion through versioned contracts.
- Keeps decisions bounded: the user can choose an option, provide a short alternative, approve or reject a scoped operation, or interrupt the turn.
- Persists normalized and redacted workspace state in local SQLite so a session can recover without storing raw reasoning.
- Shows read-only Git evidence through a GitHub-inspired commit changes experience: commit identity, changed files, diff statistics, and one lazy-loaded unified diff.
- Presents session presence through a validated Live2D character, visible HTML captions, expression and motion cues, and optional caption-matched speech.
- Supports the same product UI in English and Japanese.

## GPT-5.6 orchestration

The three models are one app-owned pipeline, not three user-facing chat personas.

| Role | Exact model | Job | Authority |
| --- | --- | --- | --- |
| Main coder | **gpt-5.6-sol** | Understands the request, plans, uses coding tools, edits the selected repository, verifies work, asks bounded questions, and creates a reviewable commit. | The only write-capable role; it uses the selected local Codex workspace authority. |
| Commit explainer | **gpt-5.6-terra** | Receives bounded, pathless, redacted evidence only after the app verifies a new reachable commit, then returns a strict structured explanation. | Zero external authority and no main-session writeback. |
| Presence director | **gpt-5.6-luna** | Reacts to each completed main-agent message and selected semantic events with one short caption and semantic cue for expression, motion, and optional speech. | Zero external authority and no main-session writeback. |

Terra and Luna receive no repository root and have no shell, file, Git, MCP, network, dynamic-tool, user-interaction, or main-session writeback authority. They run in separate short-lived support processes with bounded inputs and strict output schemas. A failed support role does not stop Sol, fabricate a chat event, or weaken the deterministic UI fallback.

Luna does not narrate streaming tokens, raw tool output, code, diffs, paths, URLs, or secrets. Terra does not receive a raw diff. Both roles fail closed on stale scope, schema mismatch, private material, or an unverified runtime.

The detailed contract is documented in [GPT-5.6 role orchestration](docs/research/gpt-5-6-role-orchestration.md).

## Architecture

~~~mermaid
flowchart LR
    U[Developer] --> UI[React 19 workspace]
    UI --> IPC[Typed Tauri IPC]
    IPC --> R[Rust trust boundary]
    R --> C[Local Codex App Server]
    C --> S[GPT-5.6 Sol]
    R --> X[Isolated support runtime]
    X --> T[GPT-5.6 Terra]
    X --> L[GPT-5.6 Luna]
    R --> DB[(Redacted local SQLite)]
    R --> G[Read-only Git observer]
    T --> P[Caption presentation]
    L --> P
    P --> H[Live2D expression and motion]
    P -. optional .-> A[Native OpenAI speech]
~~~

- [Frontend features](src/features/) compose the workspace, conversation, commit review, narration, settings, and Live2D presentation.
- [TypeScript contracts](src/lib/contracts/) validate every WebView-facing command and event.
- [Rust services](src-tauri/src/) supervise Codex, enforce repository and process boundaries, normalize events, persist history, observe Git, and manage optional speech.
- [Reviewed app skills](src-tauri/resources/skills/) are bundled resources with version and digest checks; they are not arbitrary repository instructions.

## Human control and review

### Bounded intervention

The WebView cannot invoke a generic shell, arbitrary filesystem operation, or arbitrary Git command. It can send only typed requests. Rust revalidates workspace identity, generation, active-turn state, limits, and allowed operations before anything reaches Codex or native storage.

Decisions and approvals remain explicit UI objects with scope and alternatives. Interrupt is a first-class action, not a prompt convention.

### GitHub-style commit changes

The Commit tab deliberately avoids internal observer, gate, producer, persistence, and risk properties. Its primary surface mirrors the information density of GitHub commit changes:

- commit subject, author, relative time, short SHA, file count, additions, and deletions;
- searchable changed-file navigation;
- one selected file loaded on demand;
- old and new line numbers, hunk headers, additions, deletions, and context;
- failure shown as a restrained error state rather than a false success badge.

The app-owned Git service is read-only. Sol may create a commit through its reviewed work unit; the observer verifies and explains that result but cannot stage, restore, revert, branch, or commit.

### Live2D is presentation-only

The character can make long work feel like pair programming, but it cannot approve a command, change a policy, declare verification successful, or hide an error. Captions remain visible HTML, and every consequential state also exists outside the canvas. Reduced-motion and text-only fallbacks preserve the workflow.

## Trust, privacy, and speech

- Core coding uses the user’s authenticated local Codex installation. Coding Wife does **not** require an application OPENAI_API_KEY, an env file, or a database server.
- Codex requests necessarily send the selected instruction and approved context through the user’s Codex/OpenAI service. This is not an offline model.
- The frontend receives normalized, bounded, redacted semantic events through typed IPC. Raw private reasoning is neither rendered nor stored as workspace history.
- SQLite is local and app-owned. Support prompts, support responses, Luna captions, Terra transcripts, credentials, generated audio, and raw tool streams are excluded from durable history.
- Optional TTS is **off by default**. It uses **gpt-4o-mini-tts** only after a user enters an OpenAI API key in App Settings.
- The TTS key is stored by the native app in owner-readable private settings and is never returned to the WebView. Only the already validated visible caption is sent to the fixed Speech endpoint.
- Native audio playback is implemented and end-to-end tested only on the current macOS judge target. Captions remain an independent fallback in current source, but the Windows/Linux v0.1.5 previews do not claim current Terra/Luna behavior.
- Temporary speech audio is bounded, played by the native layer, and deleted on completion, cancellation, mute, workspace switch, or app exit.

See the approved [audio commentary contract](docs/requirements/audio-commentary.md) for the exact provider and fallback boundary.

## Run the current Build Week source

The full current three-model judging path targets **macOS 14 or later on Apple Silicon**. The Windows and Linux assets described below are older packaging previews and are not equivalent production-path substitutes for this source workflow.

### Prerequisites

- macOS 14 or later on Apple Silicon
- Node.js 22.12.0 or later and Corepack
- pnpm 10.12.2, pinned by the repository
- rustup; [rust-toolchain.toml](rust-toolchain.toml) selects the Rust toolchain
- Xcode Command Line Tools
- a compatible local Codex installation authenticated with ChatGPT or the user’s Codex configuration
- access to **gpt-5.6-sol**, **gpt-5.6-terra**, and **gpt-5.6-luna**
- a current-user-owned, writable Git repository for a real coding turn

### Install and launch

~~~bash
git clone https://github.com/aki-0421/coding-wife.git
cd coding-wife
corepack enable
pnpm install --frozen-lockfile
pnpm tauri:dev
~~~

No environment file is required. Do not put a TTS credential in the repository or in [.env.example](.env.example); configure it in **App Settings > Audio** only if speech is needed.

For a disposable judge project, initialize a small repository, create one seed commit, and select that directory through **Add project**. The app does not require proprietary sample data.

## Testing

Common focused checks are:

~~~bash
pnpm typecheck
pnpm test
pnpm test:desktop
~~~

The desktop suite drives the real Tauri application, WKWebView, IPC, and Rust backend on macOS. Release-candidate gates and platform-specific build requirements are intentionally separate from routine development checks.

See [Testing Coding Wife](docs/testing.md) for CI coverage, desktop QA, packaging targets, installer verification, unsigned-package warnings, and the full release-candidate sequence.

## Public release and current source

[Coding Wife v0.1.5](https://github.com/aki-0421/coding-wife/releases/tag/v0.1.5) is public and includes SHA-256 sidecars for:

| Packaging target | Published artifact |
| --- | --- |
| macOS Apple Silicon | DMG |
| Windows x64 | NSIS setup executable |
| Ubuntu/Debian-compatible Linux x64 | Debian package and AppImage |

**v0.1.5 is an older preview, not the exact Build Week judging build.** It predates 48 subsequent implementation commits that added Terra/Luna orchestration and the latest Chat and Commit interfaces. Use the current repository source and the launch steps above to evaluate the exact workflow described in this README.

Packaging availability is broader than end-to-end QA:

| Target | Published v0.1.5 package evidence | Current three-model judge path | Optional TTS playback |
| --- | --- | --- | --- |
| macOS 14+ Apple Silicon | DMG built, mounted, and verified | Yes, current source with real Tauri/WKWebView E2E | Yes |
| Windows 11 x64 | Preview installer install/uninstall smoke | No equivalent production Terra/Luna path guarantee | No |
| Ubuntu 22.04 / Debian 12 x64 | Preview package install/extract smoke | No equivalent production Terra/Luna path guarantee | No |

All v0.1.5 artifacts are older previews and do not contain the current Terra/Luna implementation. Their existence and package smoke results are not a claim of full three-model behavioral equivalence. The packages are free of paid signing identities. macOS uses an ad-hoc integrity seal and is not notarized; Windows and Linux packages are unsigned. Verify the release URL, matching checksum, and reviewed source before using a downloaded preview. Bounded installation guidance is in [docs/testing.md](docs/testing.md).

## Built during OpenAI Build Week

This repository was initialized during the Build Week submission period. Its early commits, also made during that period, established the repository, product thesis, research, requirements, and screen specifications; the runnable product followed in later Build Week commits. Coding Wife is not presented as a pre-existing product.

| Early Build Week foundation | Later Build Week runnable implementation |
| --- | --- |
| Repository setup, product thesis, research, requirements, and screen specifications | React/Tauri application, local Codex integration, typed IPC, SQLite recovery, bounded decisions and approvals, read-only Git review, Live2D runtime, three-model orchestration, bilingual UI, QA, packaging, and submission documentation |

The commit history preserves the individual specification, implementation, review, and QA units without embedding a soon-stale final SHA in this README.

## How Codex helped build Coding Wife

Codex agents converted written product contracts into the React and Rust implementation, traced protocol behavior across App Server boundaries, wrote focused tests and fixtures, diagnosed lifecycle and privacy failures, ran real desktop QA, and reviewed high-risk orchestration changes. Commits were kept small enough to show those units.

Humans retained the consequential choices:

- select a developer-supervision problem instead of building another generic chat client;
- give only Sol repository-writing authority;
- keep Terra and Luna isolated, ephemeral, redacted, and unable to write back;
- use typed IPC instead of exposing shell, filesystem, or Git primitives to the WebView;
- require verified commits before explanation and explicit UI decisions before consequential actions;
- make Live2D and audio enjoyable but never authoritative;
- keep optional speech disabled by default and its credential behind the native boundary;
- prefer a narrow, reviewable workflow over unfinished feature breadth.

## Why it fits the judging criteria

| Criterion | Evidence in the product |
| --- | --- |
| Technological implementation | Real Codex App Server supervision, exact GPT-5.6 role routing, strict TypeScript/Rust contracts, isolated support runtimes, SQLite recovery, Git verification, and native desktop QA |
| Design | One coherent request-to-commit path, bounded human intervention, quiet operation rows, GitHub-style review, bilingual UI, accessibility fallbacks, and character presence |
| Potential impact | Reduces the time developers spend reconstructing and reviewing long agent sessions while preserving responsibility |
| Quality of the idea | Treats orchestration, evidence, and a human-like companion as one workflow rather than adding a mascot to a terminal clone |

## Honest limitations

- The current three-model Build Week source must be built locally; the public v0.1.5 installers are an older preview.
- Real coding requires a compatible authenticated Codex installation and availability of all three exact GPT-5.6 models. Unsupported or rerouted roles fail closed.
- The full current three-model judge target and primary end-to-end desktop QA environment are macOS 14+ on Apple Silicon. Windows and Linux v0.1.5 artifacts have packaging smoke evidence, not equivalent production Terra/Luna validation.
- Optional OpenAI speech playback is macOS-only today. Captions, expression cues, and the core coding workflow do not depend on speech.
- Published packages are not backed by paid platform signing identities or notarization.
- Workspace history is local; there is no account, cloud sync, remote collaboration, or automatic backup service.
- Imported Live2D packs remain subject to their creators’ rights and the Live2D terms.

## License and notices

Project-owned code is available under the [MIT License](LICENSE).

Third-party software and character assets retain their own terms:

- [Generated dependency inventory and attributions](src-tauri/resources/legal/THIRD-PARTY-DEPENDENCIES.md)
- [Packaged third-party notice index](src-tauri/resources/legal/THIRD-PARTY-NOTICES.md)
- [Bundled Hiyori model notice](src-tauri/resources/characters/builtin-hiyori/NOTICE.txt)

The project license does not replace the OpenAI, Live2D Cubism SDK, Hiyori model, or dependency-specific terms.
