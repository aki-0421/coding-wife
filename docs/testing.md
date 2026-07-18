---
title: "Testing Coding Wife"
description: "Judge-facing setup, verification, macOS release packaging, installation, and Gatekeeper instructions for Coding Wife."
updated: 2026-07-19
read_when:
  - "Reproducing the hackathon build or verifying Coding Wife on macOS."
  - "Changing release commands, the DMG layout, or repository quality gates."
---

# Testing Coding Wife

## Supported release target

The verified MVP target is macOS 14 or later on Apple Silicon. Windows, Linux, and Intel Mac artifacts are not claimed as supported. The current hackathon artifact uses an ad-hoc signature to seal its complete app resources, but it is not Developer ID signed or Apple-notarized; build it from the reviewed source whenever possible.

## Install dependencies

```bash
corepack enable
pnpm install --frozen-lockfile
cargo fetch --locked --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin
```

The explicit Cargo fetch installs the locked Apple Silicon registry metadata before the quality sequence switches its license generator to offline mode. No application API key is required. A compatible, authenticated local Codex installation is required for the production conversation path.

## Run the development build

```bash
pnpm dev
```

Run the native shell with:

```bash
pnpm tauri dev
```

## Run the quality gates

Start from a clean committed checkout, then run the repository-owned sequence:

```bash
git status --short
pnpm quality:check
git status --short
```

Both status commands must print nothing. `pnpm quality:check` refuses a dirty checkout and runs every expensive gate synchronously in this order: `format:check`, the offline locked-dependency license check, `test:clean-checkout`, `typecheck`, `build`, `live2d:verify`, Rust format, Clippy with warnings denied, Rust tests, deterministic `agent-docs` lint, the production Tauri build, and the final repository diff check. Frontend and Cargo workloads never overlap. The command checks the worktree again after the build and stops at the first failed gate. Running an individual command is partial validation only and is not release-candidate evidence.

The dependency-license gate compares committed and packaged JSON/Markdown notices byte-for-byte with the complete pnpm declared `dependencies` closure and the effective Cargo runtime graph. The Cargo graph comes from color-disabled `LC_ALL=C cargo tree --locked --offline --target aarch64-apple-darwin --edges normal`; every displayed package is resolved to one exact metadata package ID, and ambiguous output, malformed SPDX expressions, stale output, or missing, unknown, forbidden, or unapproved license/source/integrity metadata fails closed. It uses only the lockfiles, installed package metadata, and local Cargo registry sources. The npm closure is intentionally conservative package-manager classification and is not presented as a Vite bundle module inventory.

The Rust gate uses the committed lockfile and libtest `--test-threads=1`. Several native integration tests deliberately enforce real wall-clock budgets while running Git, SQLite, and local process fixtures; serial suite scheduling prevents unrelated fixtures from consuming one another's product budgets. Concurrency behavior remains covered inside the individual tests with controlled tasks and peak counters. The gate does not extend, retry, ignore, or remove any timeout or performance assertion.

`pnpm test:clean-checkout` creates a detached temporary worktree from `HEAD`, installs the pinned lockfile, and proves lint, tests, type checking, and Live2D preparation do not depend on ignored Framework output.

`pnpm check:diff` checks committed changes from `origin/develop...HEAD`, staged changes, unstaged changes, and untracked files for whitespace errors and unresolved conflict markers. Its committed-diff policy also rejects generated/build paths, private-state paths, newly added machine-local checkout or home paths, and binary files outside the explicit application asset allowlist. CI passes the Pull Request base commit to the same command. Use `pnpm check:diff -- --working-tree` for local whitespace checks when the base ref is intentionally unavailable.

The command excludes only `src-tauri/resources/characters/builtin-hiyori/NOTICE.txt` from whitespace diagnostics because that third-party notice must retain its approved bytes. It independently verifies that the worktree path is a regular file with the pinned SHA-256. If `HEAD` or the selected base contains the notice, the Git index must also contain exactly one stage-zero entry at that path with mode `100644` and the same byte-exact regular blob. This rejects cached deletion, staged content drift, mode changes, renames, and symlink replacement even when the worktree file still looks canonical. A canonical untracked or staged addition remains valid when the selected tracked baselines do not contain the notice. Files at every other path remain checked. Failure output contains safe scope codes rather than diff lines, secrets, or absolute paths. The command never modifies the notice, index, or worktree.

## Build the macOS artifact

Build and verify both the Tauri app bundle and the repository-owned DMG:

```bash
pnpm release:macos
```

The commands are intentionally split for diagnosis:

```bash
pnpm release:macos:app
pnpm release:macos:dmg
pnpm release:macos:verify
```

Tauri produces only `Coding Wife.app`. The app command builds in a fresh private target, keeps raw tool output in a mode-`0700` work directory, checks that locked dependency notices are current and packaged legal files are byte-identical, excludes the development-only demo runtime, signs nested executable code first, and seals the complete app with a timestamp-free ad-hoc signature. It full-verifies the private and same-filesystem ready copies before atomically publishing the app and its run manifest. This integrity seal does not provide a Developer ID identity and does not prove notarization.

The DMG command stages only that sealed app with an `/Applications` symlink, creates a compressed read-only image with `hdiutil`, and performs full product verification in two independent read-only mounts without Finder or AppleScript. Each mount checks its exact plist-reported device, two-entry root, write rejection, app root mode, architecture, Mach-O macOS platform and minimum version, bundle metadata, byte-exact legal resources, required Hiyori/skill resources, signature and no-ticket classification, runtime markers, sorted inventory, and forbidden demo/source-map/private/quarantine/credential content. Absolute, escaping, or broken app symlinks and private POSIX, Windows-drive, or UNC paths in entry names, link targets, or file bytes are rejected.

App build, DMG build, canonical verification, and the combined command share one finite-wait host-global release lock. Candidate artifacts remain private until every check passes. Atomic publish writes a UUID run manifest next to each artifact; verification rejects an app, DMG, or manifest left from a different run. On handled failure, INT, or TERM, the current run leaves no mount, candidate, ready, backup, new final artifact, or lock; a prior artifact is restored with its prior identity.

Canonical verification snapshots the final DMG into private storage while holding the lock, checks the final path's device/inode/size/SHA-256 before and after the copy and again after verification, and runs `hdiutil` only against the snapshot. The reported byte size and SHA-256 therefore describe the exact bytes that passed the independent mount verification; a path swap or in-place modification fails closed.

Compressed DMG filesystem metadata is not required to be byte-identical across separate builds. Reproducibility means both mounted images reproduce the sealed app inventory. Freeze and publish only the final candidate's recorded byte size and SHA-256.

The final artifacts and their run identities are:

```text
src-tauri/target/release/bundle/macos/Coding Wife.app
src-tauri/target/release/bundle/macos/Coding Wife.app.release.json
src-tauri/target/release/bundle/dmg/Coding-Wife.dmg
src-tauri/target/release/bundle/dmg/Coding-Wife.dmg.release.json
```

Run the packaging test without compiling the real application:

```bash
pnpm test:release
```

This creates a minimal real arm64 Mach-O product fixture, applies the ad-hoc seal, exercises the real app verifier and CLI, builds and independently mounts a real DMG twice, injects failures and signals, attempts path swaps and private-path fixtures, and verifies lock, mount, temporary-prefix, and atomic-publish cleanup.

## Install and launch

1. Open `Coding-Wife.dmg` on a macOS 14+ test Mac.
2. Drag `Coding Wife.app` to Applications.
3. Launch Coding Wife from Applications.
4. Confirm the bundled Hiyori model renders, add or create a Git project, pass the Codex preflight, complete one primary turn, inspect its commit, and quit the app.

The hackathon artifact is ad-hoc signed for resource integrity, but it is not Developer ID signed or notarized. The ad-hoc signature does not identify a trusted distributor. Apple warns that running software without a trusted signature and notarization can expose the computer and personal information to malware. Proceed only after verifying the repository source, commit, frozen artifact SHA-256, and artifact provenance.

If Gatekeeper blocks this reviewed local build, first try to open the app once. Then open **System Settings > Privacy & Security**, scroll down, choose **Open Anyway**, and confirm **Open** in the warning. This creates an exception for that app. Do not disable Gatekeeper or remove quarantine attributes globally. See Apple's [current safety guidance](https://support.apple.com/en-us/102445).

## Release evidence still required

Before external judging, record a fresh-profile or second-Mac install and first-launch smoke. Developer ID signing, notarization, stapling, Intel/universal packaging, and automatic updates are outside the current MVP artifact and must not be claimed as complete.
