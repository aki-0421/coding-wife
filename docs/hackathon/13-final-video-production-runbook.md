---
title: Coding Wife Final Video Production Runbook
description: Defines the exact 165-second English demo, safe live repository scenario, capture sequence, narration, captions, edit pipeline, screenshots, and acceptance gates for the OpenAI Build Week submission video.
updated: 2026-07-22
read_when:
  - Recording, editing, validating, or publishing the final Coding Wife OpenAI Build Week demo video.
  - Rehearsing the Sol, Luna, Terra, Live2D, Commit changes, and Explain changes proof chain.
  - Generating submission narration, captions, screenshots, or final video evidence.
last_verified: 2026-07-22 JST
source_of_truth: https://openai.devpost.com/rules
---

# Coding Wife final video production runbook

This document is the single production source of truth for the final submission video. Do not improvise claims, timing, narration, model roles, or the demo task during capture. If this runbook conflicts with an older shot list, use this runbook. If it conflicts with the [Official Rules](https://openai.devpost.com/rules), use the Official Rules and update this document before recording.

## 1. Hard submission and production contract

The Official Rules require a clear working-project demo with audio, publicly visible on YouTube, explaining what was built and how Codex and GPT-5.6 were used. The video must be **less than three minutes**. Coding Wife is submitted to the **Developer Tools** track, whose working project must be installable on its intended platform and testable without rebuilding from scratch.

| Property | Final contract |
|---|---|
| Story duration | Exactly **165 seconds / 2:45** on the edit timeline |
| Safety ceiling | Target must remain at or below **175 seconds / 2:55** after any emergency adjustment; **180 seconds is never acceptable** |
| Language | English narration and English burned captions; matching English SRT |
| Working proof | One causal repository run from a real Sol task through Luna reactions, a verified commit, Commit changes, and one bounded Terra evidence sequence for that selected commit: one `user_request` followed by one `user_retry`, both rejected before generation and recorded as fail-closed unavailable results |
| Required technology proof | Meaningful Codex use in construction and real runtime use of `gpt-5.6-sol`, `gpt-5.6-luna`, and `gpt-5.6-terra` |
| Judge platform claim | macOS 14+ on Apple Silicon |
| Raster | 1920×1080, square pixels, 30 fps constant frame rate |
| Video | H.264 High profile, `yuv420p`, web-faststart |
| Audio | AAC stereo, 48 kHz; narration approximately −16 LUFS integrated; true peak at or below −1.5 dBTP |
| Captions | English captions burned into the master plus a separate UTF-8 SRT |
| Music | None |
| Rights | Show only the Coding Wife product, authorized bundled character assets, and submission-owned text/graphics; do not show GitHub pages, logos, or other unrelated third-party footage |
| Privacy | No API key, token, email, personal path, notification, private URL, private repository name, or personal Git identity in any frame, audio file, subtitle, log, or evidence artifact |
| Publication | Upload the accepted master to YouTube and use **Public** visibility, the conservative interpretation of the Official Rules |

The story is optimized for the equally weighted judging criteria:

- **Technological Implementation:** shots 2, 4, 7, and 8 prove the real Codex path and isolated three-model orchestration.
- **Design:** shots 1, 3, 4, and 6 show one coherent pair-programming and review experience rather than a technical dashboard.
- **Potential Impact:** shots 1, 6, and 7 show how the product reduces the effort of following and reviewing agent work.
- **Quality of the Idea:** shots 4 and 8 show that a human-like character, review reduction, and authority separation are one product workflow.

## 2. Artifact layout and immutable filenames

All working files remain outside Git under the already ignored `tmp/` directory:

```text
tmp/submission-video/
├── raw/
├── audio/
├── captions/
├── render/
└── evidence/
```

Required final files:

| Artifact | Exact path |
|---|---|
| Burned-caption master | `tmp/submission-video/render/coding-wife-openai-build-week-2026-master.mp4` |
| YouTube caption file | `tmp/submission-video/captions/coding-wife-openai-build-week-2026-en.srt` |
| Shot edit decision list | `tmp/submission-video/evidence/edit-decision-list.tsv` |
| TTS manifest | `tmp/submission-video/evidence/tts-manifest.json` |
| Media inspection report | `tmp/submission-video/evidence/media-inspection.md` |
| Every-frame OCR result | `tmp/submission-video/evidence/privacy-ocr.ndjson` |
| Screenshot 1 | `tmp/submission-video/evidence/screenshots/screenshot-01-workspace.png` |
| Screenshot 2 | `tmp/submission-video/evidence/screenshots/screenshot-02-luna-presence.png` |
| Screenshot 3 | `tmp/submission-video/evidence/screenshots/screenshot-03-commit-changes.png` |
| Screenshot 4 | `tmp/submission-video/evidence/screenshots/screenshot-04-terra-fail-closed.png` |
| Final checksums | `tmp/submission-video/evidence/checksums.sha256` |

Before any key or recording work, `git check-ignore -q tmp/.env` and `git check-ignore -q tmp/submission-video` must both succeed. Never stage anything below `tmp/`.

## 3. Safe disposable demo repository

### 3.1 Repository identity

Create a new repository for every proof-chain take under a system temporary directory such as `/tmp/coding-wife-demo.XXXXXX`. The app may show only the neutral basename **coding-wife-demo** or an equally non-personal label. Do not record the terminal or reveal the absolute directory.

Set repository-local identity before the seed commit:

```text
user.name = Build Week Demo
user.email = demo@example.invalid
default branch = main
```

Do not inherit or display the operator's global Git name or email. Confirm the author is `Build Week Demo` before opening the repository in Coding Wife.

### 3.2 Seed project

The seed is a dependency-free Node.js ESM project that uses the built-in test runner. It contains only these files:

`package.json`:

```json
{
  "name": "coding-wife-build-week-demo",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

`src/greeting.mjs`:

```js
export function greet(name) {
  return `Hello, ${name}!`
}
```

`test/greeting.test.mjs`:

```js
import assert from "node:assert/strict"
import test from "node:test"

import { greet } from "../src/greeting.mjs"

test("formats a name", () => {
  assert.equal(greet("Ada"), "Hello, Ada!")
})
```

Create one seed commit with subject `chore: seed greeting demo`. Confirm `npm test` passes and the worktree is clean before adding the project to Coding Wife.

### 3.3 Exact live prompt

Paste this exact prompt into the accepted native app:

> Update the greeting helper so it trims names and throws TypeError for empty input. Add tests for both cases, run npm test, and commit as feat: validate greeting names. Send one short path-free, code-free progress update before editing and one after verification.

Expected proof, not prerecorded output:

- Sol changes the greeting implementation and its test.
- `greet(" Ada ")` returns `Hello, Ada!`.
- whitespace-only input throws `TypeError`.
- `npm test` passes.
- Sol creates the commit `feat: validate greeting names`.
- At least two eligible completed, path-free Sol messages produce distinct Luna caption/expression/motion reactions.
- The native observer verifies the new reachable main-session commit.
- Commit changes shows the same commit and its real unified diff.
- Explain changes starts one isolated, bounded `user_request` Terra job for that selected existing commit. The accepted evidence then records one bounded `user_retry` for the same commit. The provider rejects both unsupported events before generation, the product records analysis as unavailable, and tool/write authority remains zero.

Shots 1 through 6 must come from this **same repository run and same resulting commit**. Shot 7 must target that exact resulting commit, even if the native app must relaunch into an anonymous review copy to recover the verified Git state. Waiting may be cut, but agent output from unrelated proof-chain takes must not be combined.

## 4. Exact 165-second shot table

Word counts use whitespace-delimited words. The exact narration contains **293 words** across **9 shots**.

| Shot | In–out | Duration | Words | Exact English narration | Primary screen state |
|---:|---:|---:|---:|---|---|
| 1 | 0:00–0:10 | 10s | 18 | Coding Wife is a Live2D pair-programming workspace that keeps real agent work collaborative, understandable, and ready to review. | Clean English workspace; Live2D and empty composer visible |
| 2 | 0:10–0:28 | 18s | 32 | Here, I give the main session a real task in a disposable repository: improve a greeting helper, add tests, verify them, and commit. GPT-5.6 Sol alone receives coding tools and write authority. | Paste exact prompt and send it to the real main session |
| 3 | 0:28–0:46 | 18s | 28 | Sol plans and edits through the authenticated local Codex runtime. The timeline keeps the work itself in focus: no speaker names, no timestamps, and no decorative success badges. | Sol planning, progress, and distilled tool activity |
| 4 | 0:46–1:14 | 28s | 47 | Every eligible completed Sol message starts a separate GPT-5.6 Luna turn. Luna receives only a bounded, sanitized excerpt and has no tools. Its validated reaction drives the visible caption, optional speech, Live2D expression, and motion, creating a responsive pair-programming presence without exposing code, paths, diffs, or secrets. | Two real completed-message Luna reactions with matching Live2D behavior |
| 5 | 1:14–1:30 | 16s | 30 | The verification passes and Sol creates a reviewable commit. Tool rows show only their type and command; successful work stays visually quiet, while failures alone receive a restrained red background. | Passing verification, quiet tool rows, final result, and commit |
| 6 | 1:30–1:54 | 24s | 36 | In Commit changes, the result follows a familiar code-review order: commit summary, changed files, additions and deletions, then one unified diff with old and new line numbers. Review stays centered on the patch, not orchestration metadata. | Same commit in Commit changes; file navigation and real diff |
| 7 | 1:54–2:16 | 22s | 44 | Terra receives a bounded, read-only commit review request with no tools. In this take, the provider rejects that unsupported event before generation. Coding Wife records the unavailable analysis, keeps write and tool authority at zero, and fails closed without joining Sol’s main coding session. | Same verified commit and real diff behind a factual Terra request/audit overlay showing unavailable, zero-tool, zero-write, fail-closed handling |
| 8 | 2:16–2:33 | 17s | 35 | The three roles form one bounded pipeline: Sol builds, Luna maintains presence, and Terra stays strictly review-only. Typed TypeScript and Rust contracts pin each model, validate inputs and outputs, redact private material, and fail closed. | Accepted native app remains visible behind a simple three-role authority overlay |
| 9 | 2:33–2:45 | 12s | 23 | Codex helped us implement, debug, test, and QA the product; humans chose the trust boundaries. Coding Wife targets macOS 14 on Apple Silicon. | Product hero and platform-accurate closing card |

### Machine-readable shot manifest

The following JSON block is the canonical input for TTS and edit automation. `startSeconds` is inclusive, `endSeconds` is exclusive, and each narration string must be sent to TTS unchanged.

```json
[
  {
    "shot": 1,
    "start": "00:00:00.000",
    "end": "00:00:10.000",
    "startSeconds": 0,
    "endSeconds": 10,
    "durationSeconds": 10,
    "wordCount": 18,
    "audioFile": "audio/01-hook.wav",
    "narration": "Coding Wife is a Live2D pair-programming workspace that keeps real agent work collaborative, understandable, and ready to review."
  },
  {
    "shot": 2,
    "start": "00:00:10.000",
    "end": "00:00:28.000",
    "startSeconds": 10,
    "endSeconds": 28,
    "durationSeconds": 18,
    "wordCount": 32,
    "audioFile": "audio/02-real-task.wav",
    "narration": "Here, I give the main session a real task in a disposable repository: improve a greeting helper, add tests, verify them, and commit. GPT-5.6 Sol alone receives coding tools and write authority."
  },
  {
    "shot": 3,
    "start": "00:00:28.000",
    "end": "00:00:46.000",
    "startSeconds": 28,
    "endSeconds": 46,
    "durationSeconds": 18,
    "wordCount": 28,
    "audioFile": "audio/03-focused-timeline.wav",
    "narration": "Sol plans and edits through the authenticated local Codex runtime. The timeline keeps the work itself in focus: no speaker names, no timestamps, and no decorative success badges."
  },
  {
    "shot": 4,
    "start": "00:00:46.000",
    "end": "00:01:14.000",
    "startSeconds": 46,
    "endSeconds": 74,
    "durationSeconds": 28,
    "wordCount": 47,
    "audioFile": "audio/04-luna-presence.wav",
    "narration": "Every eligible completed Sol message starts a separate GPT-5.6 Luna turn. Luna receives only a bounded, sanitized excerpt and has no tools. Its validated reaction drives the visible caption, optional speech, Live2D expression, and motion, creating a responsive pair-programming presence without exposing code, paths, diffs, or secrets."
  },
  {
    "shot": 5,
    "start": "00:01:14.000",
    "end": "00:01:30.000",
    "startSeconds": 74,
    "endSeconds": 90,
    "durationSeconds": 16,
    "wordCount": 30,
    "audioFile": "audio/05-verified-commit.wav",
    "narration": "The verification passes and Sol creates a reviewable commit. Tool rows show only their type and command; successful work stays visually quiet, while failures alone receive a restrained red background."
  },
  {
    "shot": 6,
    "start": "00:01:30.000",
    "end": "00:01:54.000",
    "startSeconds": 90,
    "endSeconds": 114,
    "durationSeconds": 24,
    "wordCount": 36,
    "audioFile": "audio/06-commit-changes.wav",
    "narration": "In Commit changes, the result follows a familiar code-review order: commit summary, changed files, additions and deletions, then one unified diff with old and new line numbers. Review stays centered on the patch, not orchestration metadata."
  },
  {
    "shot": 7,
    "start": "00:01:54.000",
    "end": "00:02:16.000",
    "startSeconds": 114,
    "endSeconds": 136,
    "durationSeconds": 22,
    "wordCount": 44,
    "audioFile": "audio/07-terra-explanation.wav",
    "narration": "Terra receives a bounded, read-only commit review request with no tools. In this take, the provider rejects that unsupported event before generation. Coding Wife records the unavailable analysis, keeps write and tool authority at zero, and fails closed without joining Sol’s main coding session."
  },
  {
    "shot": 8,
    "start": "00:02:16.000",
    "end": "00:02:33.000",
    "startSeconds": 136,
    "endSeconds": 153,
    "durationSeconds": 17,
    "wordCount": 35,
    "audioFile": "audio/08-role-boundaries.wav",
    "narration": "The three roles form one bounded pipeline: Sol builds, Luna maintains presence, and Terra stays strictly review-only. Typed TypeScript and Rust contracts pin each model, validate inputs and outputs, redact private material, and fail closed."
  },
  {
    "shot": 9,
    "start": "00:02:33.000",
    "end": "00:02:45.000",
    "startSeconds": 153,
    "endSeconds": 165,
    "durationSeconds": 12,
    "wordCount": 23,
    "audioFile": "audio/09-codex-and-platform.wav",
    "narration": "Codex helped us implement, debug, test, and QA the product; humans chose the trust boundaries. Coding Wife targets macOS 14 on Apple Silicon."
  }
]
```

## 5. Shot-by-shot capture and edit contract

### Shot 1 — Product hook

- **Production operation:** Bring the English Coding Wife workspace to the front with the disposable project selected. Leave the composer empty. Let the character complete at least one natural idle motion.
- **Raw capture requirement:** At least 12 continuous seconds at the final window size, beginning after rendering and fonts settle. No loading skeleton or setup dialog.
- **Edit:** Use a full-app frame. Begin on the product rather than black. A subtle 2% digital push is allowed, but the composer, conversation area, and full character must remain visible.
- **Privacy risk:** Sidebar project labels, window title, menu bar, Dock, notifications, and another application behind the window.
- **Success/fallback:** If any personal label or desktop surface appears, discard the clip. Reframe or reset the disposable app state; do not blur private data into an accepted take.

### Shot 2 — Real task and Sol authority

- **Production operation:** Focus the composer, paste the exact prompt from section 3.3, leave it readable for two seconds, then send once.
- **Raw capture requirement:** Start five seconds before composer focus and continue through confirmation that a real turn is running. Preserve the send action and first live state transition.
- **Edit:** Cut idle typing time, not the submitted prompt or send action. Keep the prompt readable long enough to establish the concrete repository task.
- **Privacy risk:** Clipboard manager popups, input method overlays, personal recent prompts, model settings, or the temporary absolute path.
- **Success/fallback:** If the prompt differs, sends twice, targets another project, or Sol is not the exact main model, discard the whole proof-chain take and reseed.

### Shot 3 — Focused Codex timeline

- **Production operation:** Allow Sol to plan and begin editing. Scroll only enough to keep the newest completed message and tool-kind rows visible.
- **Raw capture requirement:** Capture the first eligible completed progress message, at least one tool row, and the transition into repository work. All content must originate from the current live turn.
- **Edit:** Remove model waiting while preserving causal order. Use a restrained crop toward the conversation; keep enough of the character pane visible to bridge into shot 4.
- **Privacy risk:** A completed message may include a path, file alias, URL, code block, secret-like token, or a private repository label.
- **Success/fallback:** Use only a path-free, code-free completed update. If no safe update appears, discard the proof-chain take and repeat; never stage or fabricate an assistant message.

### Shot 4 — Luna and Live2D presence

- **Production operation:** Do not click through the reaction. Let two distinct eligible completed Sol messages each produce a visible Luna caption and matching expression or motion.
- **Raw capture requirement:** For each reaction, retain at least one second before caption appearance and three seconds after the character cue begins. The two reactions must be caused by two distinct live completions in this proof chain.
- **Edit:** Intercut the two reactions in arrival order. A maximum 108% crop may favor the character and caption, but the related completed Sol message must remain identifiable. The narration track is the only recorded audio; optional product speech is described but need not be captured.
- **Privacy risk:** Unsafe Luna output, clipped captions, stale/hydrated replay represented as live, or the character covering material needed to understand causality.
- **Success/fallback:** Both captions must be fully readable and visibly paired with expression or motion. If either is missing, stale, duplicated, clipped, or unsafe, discard the proof-chain take and start over.

### Shot 5 — Verification and commit

- **Production operation:** Keep the live turn visible through passing tests, the final path-free progress update, and successful commit completion.
- **Raw capture requirement:** Capture the real verification tool row, the completed result, and the real commit identity. Do not expose raw terminal output through another application.
- **Edit:** Preserve the actual order. Successful tool rows remain visually quiet. Do not manufacture a failure solely to demonstrate the red failure background.
- **Privacy risk:** Personal author identity, absolute paths in a final message, a failed test, or a commit created outside the recorded turn.
- **Success/fallback:** Confirm a clean worktree, passing tests, and subject `feat: validate greeting names`. A failed or missing commit invalidates the proof chain; do not replace it with a commit from another take.

### Shot 6 — Commit changes review

- **Production operation:** Open the **Commit** tab, select the new commit if needed, show the subject and aggregate statistics, choose each changed file, and scroll one real unified diff.
- **Raw capture requirement:** At least 30 seconds covering commit identity, changed-file navigation, additions/deletions, hunk header, and old/new line numbers. The displayed commit must be the exact shot-5 commit.
- **Edit:** Use one full-width review view and one crop no tighter than 112% for diff readability. Keep horizontal scrolling inside the diff only. Never insert a GitHub screenshot or logo.
- **Privacy risk:** Another repository's history, author email, absolute path, internal observer properties, or stale evidence from a previous workspace.
- **Success/fallback:** Refresh once if the verified commit is not yet visible. If it still does not appear, or the selected evidence is stale or from another commit, discard the proof-chain take.

### Shot 7 — Terra boundary and fail-closed audit

- **Production operation:** Begin with the verified fresh commit selected. Select **Explain changes** to start one bounded `user_request` Terra job for that existing commit. After its typed unavailable result, perform one bounded `user_retry` for the same commit and retain that terminal result. Do not retry again.
- **Raw capture requirement:** Capture the selected commit, the `user_request`, its unavailable result, the single `user_retry`, and its unavailable result. Both accepted attempts end with `CODEX-SUPPORT-POLICY-VIOLATION`, zero generated tokens, zero tool authority, and zero write authority because the provider rejects each unsupported event before generation.
- **Edit:** Keep the same real commit and diff as the primary visual. Add a clearly labeled submission-owned **Capture audit** overlay stating `bounded user request`, `provider event unsupported`, `analysis unavailable`, `tools: none`, `writes: none`, and `fail closed`. The actual unavailable state may appear briefly as evidence but must not become the hero screen. Do not imply a generated review or automatic background handoff.
- **Privacy risk:** Raw provider payloads, identifiers, paths, code, diff text copied into an overlay, secrets, or an unsupported claim that Terra generated a review.
- **Success/fallback:** The take is valid only if one bounded `user_request` and one bounded `user_retry` target the same selected verified commit, Terra stays read-only and tool-free, and both typed failures are truthfully recorded. Do not perform a further retry. If the commit changes, either action duplicates, or any write/tool authority is granted, reject the take.

### Shot 8 — Three-role authority summary

- **Production operation:** Hold the accepted native app on the commit review and character state. No new runtime action is needed.
- **Raw capture requirement:** At least 18 stable seconds from the accepted app state. This may be recorded separately after the live proof chain is secured.
- **Edit:** Dim the app no more than 25% and add a simple submission-owned text overlay labeled **One bounded pipeline** with exactly these rows: `gpt-5.6-sol — builds — write-capable main session`; `gpt-5.6-luna — presence — zero tools`; `gpt-5.6-terra — review — zero tools`. Label the graphic **Architecture** so it is not mistaken for a product screen.
- **Privacy risk:** Wrong model ID, implied tool access for a support role, a generic “GPT-5.6” alias, or overlaying unsupported claims.
- **Success/fallback:** Compare all three rows with the frozen source contract before render. Regenerate the overlay from this text if any character differs; do not patch it visually after export.

### Shot 9 — Codex contribution and CTA

- **Production operation:** Return to a clean full-product hero with the accepted disposable workspace. Let the character remain visible.
- **Raw capture requirement:** At least 14 stable seconds. A still frame from the accepted take is allowed only if a subtle, non-looping digital push preserves a natural closing image.
- **Edit:** Add only submission-owned text: **Coding Wife**, **Developer Tools**, **macOS 14+ · Apple Silicon**, and **Review agent work. Keep the human in charge.** End on the product, not black.
- **Privacy risk:** An outdated release number, Windows/Linux parity claim, personal repository URL, or signing/notarization claim not frozen for submission.
- **Success/fallback:** Remove any external value that is not final. The closing card must not claim a current release URL or status until that artifact is frozen.

## 6. Narration generation contract

Generate one WAV per shot with the standard Node.js `fetch` implementation and this fixed API contract:

| Field | Value |
|---|---|
| Endpoint | `POST https://api.openai.com/v1/audio/speech` |
| Model | `gpt-4o-mini-tts` |
| Voice | `marin` |
| Response format | `wav` |
| Input | Exact narration for that shot from section 4 |
| Instructions | `Narrate in clear, warm, confident English for a technical product demo. Keep a natural measured pace, pronounce model IDs clearly, and do not add, omit, or paraphrase words.` |

Exact source filenames:

| Shot | Source WAV | Timeline slot |
|---:|---|---:|
| 1 | `audio/01-hook.wav` | 10s |
| 2 | `audio/02-real-task.wav` | 18s |
| 3 | `audio/03-focused-timeline.wav` | 18s |
| 4 | `audio/04-luna-presence.wav` | 28s |
| 5 | `audio/05-verified-commit.wav` | 16s |
| 6 | `audio/06-commit-changes.wav` | 24s |
| 7 | `audio/07-terra-explanation.wav` | 22s |
| 8 | `audio/08-role-boundaries.wav` | 17s |
| 9 | `audio/09-codex-and-platform.wav` | 12s |

Secret handling is non-negotiable:

1. Confirm `tmp/.env` is ignored.
2. Let the Node process read only the `OPENAI_API_KEY` entry from `tmp/.env` directly into memory. Do not `source` the file.
3. Do not place the key in a command argument, exported shell environment, script source, log, screenshot, manifest, database, or Git object.
4. Disable shell tracing. Never print request headers, the environment, the parsed key, or the full error request.
5. Save only the WAV body. Record model, voice, filename, byte count, duration, sample rate, and SHA-256 in `evidence/tts-manifest.json`.
6. If an API call fails, record only HTTP status, safe request identifier if present, and shot number. Retry that shot without logging the response body.

Each WAV must finish at least 0.5 seconds before its shot ends. Add 0.35–0.5 seconds of lead-in silence, pad the tail, and trim the slotted copy to the exact shot duration. A tempo adjustment between 0.96× and 1.06× is acceptable; outside that range, regenerate the shot instead of clipping words. Do not concatenate TTS before per-shot duration and transcript checks pass.

## 7. Exact English SRT

Create `captions/coding-wife-openai-build-week-2026-en.srt` with this exact UTF-8 content. Line wrapping may be adjusted only if words, punctuation, cue times, and cue order remain unchanged.

```srt
1
00:00:00,500 --> 00:00:09,500
Coding Wife is a Live2D pair-programming workspace that keeps real agent work
collaborative, understandable, and ready to review.

2
00:00:10,500 --> 00:00:21,500
Here, I give the main session a real task in a disposable repository:
improve a greeting helper, add tests, verify them, and commit.

3
00:00:21,500 --> 00:00:27,500
GPT-5.6 Sol alone receives coding tools and write authority.

4
00:00:28,500 --> 00:00:35,500
Sol plans and edits through the authenticated local Codex runtime.

5
00:00:35,500 --> 00:00:45,500
The timeline keeps the work itself in focus: no speaker names,
no timestamps, and no decorative success badges.

6
00:00:46,500 --> 00:00:53,500
Every eligible completed Sol message starts a separate GPT-5.6 Luna turn.

7
00:00:53,500 --> 00:01:00,000
Luna receives only a bounded, sanitized excerpt and has no tools.

8
00:01:00,000 --> 00:01:06,500
Its validated reaction drives the visible caption, optional speech,
Live2D expression, and motion,

9
00:01:06,500 --> 00:01:13,500
creating a responsive pair-programming presence without exposing
code, paths, diffs, or secrets.

10
00:01:14,500 --> 00:01:20,500
The verification passes and Sol creates a reviewable commit.

11
00:01:20,500 --> 00:01:29,500
Tool rows show only their type and command; successful work stays visually quiet,
while failures alone receive a restrained red background.

12
00:01:30,500 --> 00:01:39,000
In Commit changes, the result follows a familiar code-review order:
commit summary, changed files, additions and deletions,

13
00:01:39,000 --> 00:01:47,000
then one unified diff with old and new line numbers.

14
00:01:47,000 --> 00:01:53,500
Review stays centered on the patch, not orchestration metadata.

15
00:01:54,500 --> 00:02:01,500
Terra receives a bounded, read-only commit review request with no tools.

16
00:02:01,500 --> 00:02:08,500
In this take, the provider rejects that unsupported event before generation.

17
00:02:08,500 --> 00:02:15,500
Coding Wife records the unavailable analysis, keeps write and tool authority at zero,
and fails closed without joining Sol’s main coding session.

18
00:02:16,500 --> 00:02:23,500
The three roles form one bounded pipeline: Sol builds, Luna maintains presence,
and Terra stays strictly review-only.

19
00:02:23,500 --> 00:02:32,500
Typed TypeScript and Rust contracts pin each model, validate inputs and outputs,
redact private material, and fail closed.

20
00:02:33,500 --> 00:02:40,000
Codex helped us implement, debug, test, and QA the product;
humans chose the trust boundaries.

21
00:02:40,000 --> 00:02:44,500
Coding Wife targets macOS 14 on Apple Silicon.
```

The concatenated SRT cue text, after replacing line breaks with spaces, must exactly reproduce the 293-word narration in section 4. No caption may overlap another cue or extend beyond 2:45.

## 8. Rehearsal and capture procedure

### 8.1 Operator lockout period

From the start of the first WDIO rehearsal until all raw takes and the four screenshot source states are secured, do not ask the user any question. The operator is assumed unavailable during recording. Follow the abort/retry rules in this document and continue autonomously.

### 8.2 WDIO rehearsal

Use the repository's `tauri-wdio-debug` workflow and embedded WebDriver against the QA-specific Tauri binary. Rehearsal must use the real WKWebView, typed IPC, Rust backend, authenticated Codex runtime, and a disposable clone of the exact seed. Do not use a browser-only demo transport or fixture output as production proof.

Rehearse and record selectors/coordinates for:

1. Bring the Coding Wife window forward and confirm English locale.
2. Select the disposable repository.
3. Focus the composer, enter the exact prompt, and send once.
4. Keep the newest completed message and character caption visible without excessive scrolling.
5. Open Commit, select the same commit, select each changed file, and scroll the diff.
6. Select Explain changes, confirm the bounded `user_request` pathway, retain its typed unavailable result, perform one `user_retry` for the same commit, and retain the second unavailable result without retrying again.
7. Restore the clean hero state.

Save the reproducible sequence, viewport, selector names, and safe coordinate fallbacks to `evidence/rehearsal-map.json`. The rehearsal is successful only when one causal repository run produces Sol work, two Luna reactions, the verified commit, and the matching diff, and when the Terra evidence sequence for that exact commit records its terminal generated-or-unavailable results without granting tool or write authority. The accepted take records one `user_request` followed by one `user_retry`; both become unavailable before generation.

WDIO must own the QA binary lifecycle. If interrupted, terminate only the QA processes it started. Never stop the user's production `pnpm tauri:dev` process or terminate Coding Wife processes indiscriminately.

### 8.3 Native app preparation and recorded fallback

Attempt final recording first with the real production development launch:

```bash
pnpm tauri:dev
```

If a fresh isolated `tauri:dev` app remains unable to send despite Codex diagnostics reporting ready, retain that failure evidence and use the repository's QA-specific debug Tauri binary as the recording fallback. The fallback is acceptable only when it is built from the frozen product source, runs the real WKWebView, typed Tauri IPC, Rust backend, authenticated Codex runtime, and disposable Git repository, and does not use demo transport or fabricated agent output. The accepted 2026-07-22 take used this fallback after two isolated `tauri:dev` attempts reproduced a disabled Send action.

Before recording:

- Freeze and record the source commit in `evidence/capture-manifest.json`.
- Use macOS 14+ on Apple Silicon.
- Confirm the accepted native app is English and the exact three models are available.
- Confirm Live2D renders, captions fit, expression/motion mappings work, and the Commit changes diff is readable.
- Configure optional product TTS before capture if desired, but never show its key or settings screen. Screen capture itself remains silent.
- Enable Do Not Disturb. Close Mail, Calendar, password managers, chat apps, private terminals, browser windows, and notification sources.
- Hide the Dock and menu bar if they could reveal unrelated applications or personal data.
- Set the Coding Wife window to a repeatable 16:9 recording area. Rehearse at the same size.
- Place the cursor over the next action before each operation; avoid idle cursor movement.

Use AppleScript/System Events only for the rehearsed window activation, clicks, typing, scrolling, and tab changes. Do not use AppleScript to modify the repository or fabricate UI state.

### 8.4 Silent screen recording

Use macOS `/usr/sbin/screencapture` in video mode. Include the cursor, exclude microphone/system input, and constrain the intended display:

```bash
/usr/sbin/screencapture -v -V 480 -D 1 -C -x \
  tmp/submission-video/raw/live-flow-take-01.mov
```

Do not add `-g` or `-G`. Start capture before the clean hero, run the rehearsed proof chain, then stop after the Terra request reaches its typed terminal result. Capture shots 8 and 9 as separate stable holds if needed:

```text
raw/architecture-hold-take-01.mov
raw/closing-hold-take-01.mov
```

Record raw event markers in `evidence/edit-decision-list.tsv` using source file, raw in, raw out, final shot number, final in, final out, and reason. Do not rely on memory when cutting model latency.

### 8.5 Immediate take acceptance

Discard the proof-chain take and reseed when any of these occurs:

- the wrong source build, model, workspace, repository, prompt, or Git identity is used;
- fewer than two safe completed-message Luna reactions are visible;
- a Luna caption is clipped, duplicated, stale, or not paired with expression/motion;
- tests fail or the expected commit is absent;
- Commit changes does not show the same commit and real diff;
- Explain changes does not record one bounded `user_request` followed by one bounded `user_retry` for the same selected verified commit, or either terminal unavailable result is not retained for the audit overlay;
- Terra receives tools or write access, the selected commit changes, or the review-request scope is unrelated;
- a key, email, personal path, notification, private URL, private repository label, or unrelated app appears even briefly;
- an app crash, rendering corruption, missing character, cursor error, or unrecoverable visual pause damages the proof.

Do not combine Sol, Git, and Terra evidence that targets unrelated resulting commits. A relaunch or anonymous review copy is acceptable only when the selected commit identity remains the exact verified Sol result.

## 9. Edit and encode pipeline

Use FFmpeg 7.1.1. Preserve the exact shot boundaries in section 4.

### 9.1 Picture edit

1. Cut the accepted raw sources according to `evidence/edit-decision-list.tsv`.
2. For each shot, normalize to 1920×1080, square pixels, and 30 fps with scale-to-fit and padding only when necessary.
3. Use hard cuts for the live proof chain. A restrained six-frame dissolve is permitted only at 2:16 and 2:33, and it must occur **inside** the adjacent fixed shot durations rather than lengthening the master.
4. Keep digital crops at or below the per-shot limits. Never crop out the context that proves which message, commit, or request audit is active.
5. Add only the submission-owned overlays defined for shots 8 and 9.
6. Do not speed up character motion, tool execution, scrolling, or caption appearance. Cut waiting instead.

Canonical full-frame normalization:

```text
scale=1920:1080:force_original_aspect_ratio=decrease,
pad=1920:1080:(ow-iw)/2:(oh-ih)/2,
setsar=1,fps=30
```

### 9.2 Narration assembly

For each shot:

1. Verify source WAV transcript and duration.
2. Add 0.35–0.5 seconds lead silence.
3. Apply only the allowed tempo correction if needed.
4. Pad and trim to the exact shot duration.
5. Concatenate the nine slotted WAVs in shot order to exactly 165 seconds.

Run FFmpeg `loudnorm` as a measured two-pass operation on the assembled narration with `I=-16`, `TP=-1.5`, and `LRA=7`. Save both pass results in `evidence/loudnorm-pass-1.json` and `evidence/loudnorm-pass-2.json`. Do not add BGM or recorded application audio.

### 9.3 Captions and master encode

Burn the exact SRT after picture lock. Use a high-contrast two-line-safe style inside the title-safe area, with a translucent dark background or outline, and keep captions clear of Luna/Terra product captions whenever possible. Product captions must remain visible long enough to be understood even when the English subtitle is present.

Encode the final master with these effective settings:

```text
-c:v libx264 -profile:v high -pix_fmt yuv420p -preset slow -crf 18
-r 30 -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart
```

Apply a final `-t 165` only after confirming it does not cut narration or the final caption. The accepted duration should resolve between 164.90 and 165.10 seconds because of container/audio frame rounding.

## 10. Four submission screenshots

Extract these frames from the accepted final master, not directly from an unedited raw take:

| Screenshot | Master timestamp | Required visual proof |
|---:|---:|---|
| 1 | 00:00:06.000 | Clean full workspace, Live2D character, readable conversation/composer layout, no private desktop content |
| 2 | 00:01:02.000 | Completed Sol message, Luna caption, and expressive character state visible together |
| 3 | 00:01:43.000 | Same real commit in Commit changes with file navigation, `+/-`, and old/new line-number diff |
| 4 | 00:02:07.000 | Same real commit and diff behind the factual Terra request/audit overlay showing unavailable, zero-tool, zero-write, fail-closed handling |

If the exact frame lands during a blink, cursor transition, caption fade, or obstructed state, move by at most ±0.5 seconds while remaining inside the same shot and record the final timestamp in `evidence/media-inspection.md`.

All screenshots must be 1920×1080 PNGs. Run the same OCR/privacy scan used for video frames and visually inspect each at 100% scale.

## 11. Final inspection and acceptance gates

No master is accepted until every gate below is recorded in `evidence/media-inspection.md`.

### 11.1 Media structure with `ffprobe`

- duration is 164.90–165.10 seconds, below the 175-second production ceiling, and absolutely below 180 seconds;
- width 1920, height 1080, sample aspect ratio 1:1;
- constant 30 fps;
- H.264 video, High profile, `yuv420p`;
- AAC stereo audio at 48,000 Hz;
- one video stream and one audio stream;
- no unexpected data, attachment, or subtitle stream in the burned-caption master;
- `faststart` is present and the file decodes from beginning to end with no error.

Save full JSON output as `evidence/ffprobe-master.json`.

### 11.2 Audio with `loudnorm` and waveform checks

- measured integrated loudness is −16 LUFS ±1 LU;
- measured true peak is at or below −1.5 dBTP;
- no clipped sample, truncated word, duplicate sentence, missing shot, or unexpected application audio;
- narration order and wording exactly match the nine shot scripts;
- each sentence aligns with the demonstrated screen action;
- the final sentence ends before 2:45.

Run `silencedetect` as a diagnostic. Intentional pauses are acceptable; a missing narration segment is not.

### 11.3 Black-frame and visual continuity scan

Run FFmpeg `blackdetect` across the full master with a 0.10-second minimum. No unexplained black interval is accepted. Also inspect the first frame, last frame, every cut, both optional dissolves, and all extracted scene-change frames for:

- blank render, flash frame, frozen loading state, or dropped/corrupted frame;
- cursor teleport or accidental click highlight;
- unreadable product or burned captions;
- cropped character face, clipped caption, or obscured code-review evidence;
- content from an unrelated application.

### 11.4 Every-frame privacy and OCR scan

Decode all approximately 4,950 frames in bounded batches and run local OCR over the **entire 1920×1080 frame**, not only the intended app region. Append frame number, timestamp, recognized text hash, and regex findings to `evidence/privacy-ocr.ndjson`; do not preserve sensitive OCR text in logs.

Flag and inspect every match for:

- `OPENAI_API_KEY`, `sk-`, `Bearer`, `ghp_`, `AKIA`, JWT-like strings, or other credential shapes;
- email-address patterns;
- `/Users/`, `/home/`, `file://`, volume paths, or shell prompts;
- `http://` or `https://` URLs not explicitly approved for the submission;
- `.env`, password-manager text, private hostnames, UUID-like session values, or notification text;
- the operator's personal name, handle, home directory, or private repository names.

Process frames in batches and delete decoded scratch frames after each batch. OCR every frame even when adjacent frames are visually identical. In addition, generate 1 fps contact sheets and all scene-change frames for human inspection at full resolution. One private frame invalidates the master; return to the source take or edit and repeat the complete scan.

### 11.5 Content and rules review

- the video clearly demonstrates a working native project rather than slides alone;
- audio explains what was built, how Codex contributed, and how GPT-5.6 is used;
- Sol, Luna, and Terra exact model IDs and distinct authority are accurate;
- Luna is tied to safe live completed messages, not token streaming or replay;
- Terra starts only from the recorded explicit Explain changes action for the selected verified commit;
- Explain changes is described as one bounded `user_request` followed by one bounded `user_retry` for the same commit; both provider rejections and the unavailable analysis are stated plainly, with no generated-review claim;
- Terra remains tool-free and read-only, and the recorded audit shows zero generated tokens and zero tool/write authority;
- the Commit UI displays user-relevant commit review information, not internal orchestration properties;
- the primary platform claim is macOS 14+ on Apple Silicon;
- no older release is shown or implied to contain the current three-model flow;
- no copyrighted music, unlicensed third-party footage, GitHub screenshot/logo, or unrelated trademark asset is present;
- burned captions and the SRT reproduce the exact narration and remain English-only.

### 11.6 Checksums and evidence record

After all gates pass:

1. Calculate `shasum -a 256` for the final MP4, SRT, four PNG screenshots, and nine source WAV files.
2. Save normalized results to `evidence/checksums.sha256` without absolute paths.
3. Record the frozen application source SHA, disposable seed SHA, resulting demo commit SHA, master duration, codecs, loudness, true peak, privacy scan result, and final master SHA-256 in `evidence/media-inspection.md`.
4. Re-run `git status --short` and confirm no video, audio, screenshot, key, or generated evidence file is tracked.
5. Keep the accepted master unchanged for YouTube upload. If it is re-encoded, repeat every inspection and generate a new checksum.

## 12. Final production exit criteria

Production is complete only when all statements are true:

- [x] One accepted causal repository run proves Sol → two Luna reactions → verified commit → Commit changes, and one bounded Terra `user_request` followed by one bounded `user_retry` for that commit is truthfully recorded as unavailable before generation with zero tool/write authority.
- [x] The final master is 1920×1080, 30 fps, H.264/AAC 48 kHz, and 2:45 long.
- [x] English narration is complete, synchronized, approximately −16 LUFS, and at or below −1.5 dBTP.
- [x] English captions are burned in and the separate SRT matches them exactly.
- [x] Four 1920×1080 submission screenshots were extracted from the accepted master.
- [x] Full-frame every-frame OCR/privacy scanning, black-frame scanning, human contact-sheet review, and media probing passed.
- [x] No secret, personal data, notification, private URL, private repository, or unrelated third-party asset appears.
- [x] Final SHA-256 values and the complete acceptance record exist under `tmp/submission-video/evidence/`.
- [x] The master is ready to upload to a Public YouTube entry and remains below the Official Rules' three-minute limit.

## 13. Accepted production record

The accepted local production artifacts are immutable. Uploading the master to YouTube and recording its public URL remain external submission steps; no public URL is claimed here.

| Artifact | Accepted identity |
|---|---|
| Burned-caption master | `tmp/submission-video/render/coding-wife-openai-build-week-2026-master.mp4`; SHA-256 `81feb8eb068c4e3f087845beff2b8bc94c95364786c1ac750ecc8ba57d86b94b` |
| Master media | 165.000 seconds; 1920×1080; constant 30 fps; H.264 High `yuv420p`; AAC stereo 48 kHz; faststart |
| Master audio | −16.05 LUFS integrated; −4.30 dBTP true peak |
| English SRT | `tmp/submission-video/captions/coding-wife-openai-build-week-2026-en.srt`; SHA-256 `c6a49d706887bacf1e34b95efbd7b4af4cc9e3916949351a32dced71eab7353d` |
| Inspection record | `tmp/submission-video/evidence/media-inspection.md`; overall result PASS |
| Checksum manifest | `tmp/submission-video/evidence/checksums.sha256`; verification PASS |

The accepted capture uses a repository-owned desktop-QA native Tauri binary after two fresh isolated `pnpm tauri:dev` launches retained the prompt but left Send disabled. The fallback ran the real WKWebView, typed Tauri IPC, Rust backend, authenticated Codex runtime, and disposable Git repository; it did not use demo transport or fabricated agent output. Product source at capture had no code difference from the QA binary's product commit `042e114`.

The causal demo begins at seed commit `baeb62d` and ends at real Sol commit `d68adc0` (`feat: validate greeting names`), with two changed files, 19 additions, one deletion, and all three Node tests passing. Two distinct safe Luna reactions drive visible captions and Live2D behavior. For the same verified commit, the accepted Terra evidence records one `user_request` followed by one `user_retry`; both terminate unavailable with `CODEX-SUPPORT-POLICY-VIOLATION` before generation. No generated Terra review is shown or claimed, and Terra retains zero tool and write authority.

| Screenshot | Timestamp | SHA-256 |
|---|---:|---|
| `tmp/submission-video/evidence/screenshots/screenshot-01-workspace.png` | 6.500s | `0862c592687802b2012cb404ca50d9ae9475dcf2b267b036edcb1c6fca0b14a4` |
| `tmp/submission-video/evidence/screenshots/screenshot-02-luna-presence.png` | 61.500s | `fd2c81bba1b90f5139920389cd1213ed69b792343df1c4cba8614fd4e5b6f054` |
| `tmp/submission-video/evidence/screenshots/screenshot-03-commit-changes.png` | 103.500s | `d0b0f7b627901e5fc20dc1da7241c753c3369af70efc4546c4d5abb20f9ea7bb` |
| `tmp/submission-video/evidence/screenshots/screenshot-04-terra-fail-closed.png` | 127.000s | `c9979f4db50ba9debad242cbe38147f3b6c6818aaae2b2b509cbbf5d9f93aa5f` |

Final inspection decoded all 4,950 frames, found zero black intervals, and produced 4,950/4,950 full-frame OCR evidence rows with zero high-risk findings. Exact-key scanning, non-media-box scanning, metadata scanning, full-resolution screenshot review, shot-boundary review, contact-sheet review, and full decode all passed. The four selected screenshots are 1920×1080 and each passed an independent OCR privacy scan.

## Official sources reverified on 2026-07-22 JST

- https://openai.devpost.com/rules
- https://openai.devpost.com/
- https://openai.devpost.com/details/faqs
- https://openai.devpost.com/updates/45402-deadline-tomorrow-last-minute-tips

Repository contracts consulted:

- [Submission requirements](./03-submission-requirements.md)
- [Demo video plan](./08-demo-video-plan.md)
- [Final submission checklist](./10-final-submission-checklist.md)
- [Sources, conflicts, and open questions](./11-sources-and-open-questions.md)
- [Final submission materials](./12-final-submission-materials.md)
- [GPT-5.6 role orchestration](../research/gpt-5-6-role-orchestration.md)
- [Commit UI contract](../screen-design/S-003_session-evidence.md)
- [Root README](../../README.md)
