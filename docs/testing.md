---
title: "Testing Coding Wife"
description: "Judge-facing setup, CI, three-platform release verification, installation, and unsigned-distribution instructions for Coding Wife."
updated: 2026-07-21
read_when:
  - "Reproducing the hackathon build or verifying Coding Wife on a supported desktop platform."
  - "Changing release commands, installer layouts, or repository quality gates."
---

# Testing Coding Wife

## Supported release target

The verified release targets are macOS 14 or later on Apple Silicon, Windows 11 x64, and Ubuntu 22.04 / Debian 12-compatible Linux x64. Intel Mac, Windows Arm, Linux Arm, store packages, and automatic updates are not claimed as supported. The free artifacts do not use paid distribution identities: macOS is ad-hoc signed and not notarized, while Windows and Linux packages are unsigned. Verify the matching SHA-256 sidecar and reviewed source before running a downloaded artifact.

## Install dependencies

```bash
corepack enable
pnpm install --frozen-lockfile
cargo fetch --locked --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin
```

The explicit Cargo fetch installs the locked Apple Silicon registry metadata before the quality sequence switches its license generator to offline mode. No application API key is required. A compatible, authenticated local Codex installation is required for the production conversation path.

## Continuous integration

GitHub Actions runs the repository CI for every Pull Request into `develop`, every push to `develop`, and manual dispatches. `CI / Frontend and repository` checks diff hygiene before dependency installation, then verifies formatting, managed documentation, lint, types, the PR-scoped test suite, and the production frontend build on Linux. After it passes, `CI / Native` verifies the locked dependency-license inventory plus Rust formatting, Clippy, and serial tests on a macOS 14 Apple Silicon runner. Both checks must be required by the `develop` branch ruleset.

PR CI intentionally does not run `pnpm quality:check`, clean-checkout reconstruction, any test behind `pnpm test:release`, a Tauri bundle, or DMG packaging. Release tests remain together because filesystem semantics such as symlink modes vary by runner OS. Those release-candidate checks remain in the canonical quality sequence below. CI has read-only repository permission and does not publish an app or DMG. See the [continuous integration specification](rules/continuous-integration.md) for the exact triggers, versions, cache policy, and release boundary.

The separate `Release installers` workflow runs only for a `v<version>` tag. Every platform job requires the tag commit to be in `develop` history and the tag to match the versions in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`. macOS runs the repository-owned DMG tests and seal verification; Windows silently installs and uninstalls the current-user NSIS setup; Linux installs and purges the Debian package and extracts the AppImage. Read-only jobs retain their verified artifacts for one day, and only the final aggregation job receives release write permission. It verifies the exact four artifacts and four SHA-256 sidecars before creating a draft and never makes the release public. See the [free GitHub Release distribution specification](rules/github-release-distribution.md) for the publication boundary.

## Run the development build

```bash
pnpm dev
```

Run the native shell with:

```bash
pnpm tauri:dev
```

## Run desktop QA

To let an AI agent or developer operate the real macOS Tauri window, build the
debug-only QA binary and run the WebdriverIO desktop scenarios:

```bash
pnpm test:desktop
```

This uses the embedded WebDriver inside the actual Tauri binary; it does not open
the Vite frontend in Chrome. The QA bridge, global Tauri API, and `wdio:*`
capabilities are enabled only by the QA config and Cargo feature, and a release
build with that feature is rejected. App data, logs, and failure screenshots stay
under the ignored `tmp/desktop-qa/` directory, with separate ports and data roots
for concurrent Conductor workspaces. Do not point a desktop scenario at a user's
real repository; create disposable fixtures under `/tmp` or the ignored `tmp/`
directory. See [AI agent Tauri desktop QA](research/tauri-desktop-qa.md) for the
debugging workflow and native-UI limitations.

## Run the release-candidate quality gates

Do not run this sequence as routine local-development validation. Pull Request validation belongs to CI. Run these release-specific checks only when the task is to prepare or verify a release candidate, or when the user explicitly requests them. Agents must also follow the local-validation policy in [`AGENTS.md`](../AGENTS.md).

Start from a clean committed checkout, then run the repository-owned sequence:

```bash
git status --short
pnpm quality:check
git status --short
```

Both status commands must print nothing. `pnpm quality:check` refuses a dirty checkout and runs every expensive gate synchronously in this order: `format:check`, the offline locked-dependency license check and its generator test, clean-checkout reconstruction, `typecheck`, `build`, the Live2D inventory check, `test:release`, Rust format, Clippy with warnings denied, Rust tests, deterministic `agent-docs` lint, `tauri:build`, and the final repository diff check. Frontend and Cargo workloads never overlap. The command checks the worktree again after the build and stops at the first failed gate. Running an individual command is partial validation only and is not release-candidate evidence.

The dependency-license gate compares committed and packaged JSON/Markdown notices byte-for-byte with the complete pnpm declared `dependencies` closure and the effective Cargo runtime graph. The Cargo graph comes from color-disabled `LC_ALL=C cargo tree --locked --offline --target aarch64-apple-darwin --edges normal`; every displayed package is resolved to one exact metadata package ID, and ambiguous output, malformed SPDX expressions, stale output, or missing, unknown, forbidden, or unapproved license/source/integrity metadata fails closed. It uses only the lockfiles, installed package metadata, and local Cargo registry sources. The npm closure is intentionally conservative package-manager classification and is not presented as a Vite bundle module inventory.

The Rust gate uses the committed lockfile and libtest `--test-threads=1`. Several native integration tests deliberately enforce real wall-clock budgets while running Git, SQLite, and local process fixtures; serial suite scheduling prevents unrelated fixtures from consuming one another's product budgets. Concurrency behavior remains covered inside the individual tests with controlled tasks and peak counters. The gate does not extend, retry, ignore, or remove any timeout or performance assertion.

`node scripts/live2d/clean-checkout-smoke.mjs` creates a detached temporary worktree from `HEAD`, installs the pinned lockfile, and proves lint, tests, type checking, and Live2D preparation do not depend on ignored Framework output.

`pnpm check:diff` checks committed changes from `origin/develop...HEAD`, staged changes, unstaged changes, and untracked files for whitespace errors and unresolved conflict markers. Its committed-diff policy also rejects generated/build paths, private-state paths, newly added machine-local checkout or home paths, and binary files outside the explicit application asset allowlist. CI passes the Pull Request base commit to the same command. Use `pnpm check:diff -- --working-tree` for local whitespace checks when the base ref is intentionally unavailable.

The command excludes only `src-tauri/resources/characters/builtin-hiyori/NOTICE.txt` from whitespace diagnostics because that third-party notice must retain its approved bytes. It independently verifies that the worktree path is a regular file with the pinned SHA-256. If `HEAD` or the selected base contains the notice, the Git index must also contain exactly one stage-zero entry at that path with mode `100644` and the same byte-exact regular blob. This rejects cached deletion, staged content drift, mode changes, renames, and symlink replacement even when the worktree file still looks canonical. A canonical untracked or staged addition remains valid when the selected tracked baselines do not contain the notice. Files at every other path remain checked. Failure output contains safe scope codes rather than diff lines, secrets, or absolute paths. The command never modifies the notice, index, or worktree.

## Build the macOS artifact

Build and verify both the Tauri app bundle and the repository-owned DMG:

```bash
pnpm release:macos
```

The implementation scripts remain directly available for diagnosis without expanding the package command surface:

```bash
bash scripts/release/build-macos-app.sh
bash scripts/release/build-macos-dmg.sh \
  --app "$PWD/src-tauri/target/release/bundle/macos/Coding Wife.app" \
  --output "$PWD/src-tauri/target/release/bundle/dmg/Coding-Wife.dmg" \
  --volume-name "Coding Wife" \
  --overwrite
bash scripts/release/verify-macos-release.sh \
  --app "$PWD/src-tauri/target/release/bundle/macos/Coding Wife.app" \
  --dmg "$PWD/src-tauri/target/release/bundle/dmg/Coding-Wife.dmg"
```

Tauri produces only `Coding Wife.app`. The app command builds in a fresh private target, keeps raw tool output in a mode-`0700` work directory and mode-`0600` log, checks that locked dependency notices are current and packaged legal files are byte-identical, excludes the development-only demo runtime, signs nested executable code first, and seals the complete app with a timestamp-free ad-hoc signature. It full-verifies the private and same-filesystem ready copies before publishing the app and its run manifest. The combined command supplies a private output, so the child app build never changes the canonical path. This integrity seal does not provide a Developer ID identity and does not prove notarization.

The DMG command stages only that sealed app with an `/Applications` symlink, creates a compressed read-only image with `hdiutil`, and performs full product verification in two independent read-only mounts without Finder or AppleScript. Each mount checks its exact plist-reported device, two-entry root, write rejection, app root mode, architecture, Mach-O macOS platform and minimum version, bundle metadata, byte-exact legal resources, required Hiyori/skill resources, signature and no-ticket classification, runtime markers, sorted inventory, and forbidden demo/source-map/private/quarantine/credential content. Absolute, escaping, or broken app symlinks and private POSIX, Windows-drive, or UNC paths at a string start or POSIX path-component boundary in entry names, link targets, or file bytes are rejected.

App build, DMG build, canonical verification, and the combined command share one finite-wait host-global release lock. The combined command builds all four app/DMG artifact and manifest candidates privately, verifies one run identity, and then publishes the four paths as one rollback-capable transaction. Existing content and absence are journaled in a same-filesystem private backup. A failure, HUP, INT, or TERM before commit restores the exact old four-path state; a new release leaves all four final paths absent. A later lock owner recovers one valid crash-stale journal before starting a build and rejects ambiguous or malformed recovery state with a finite safe diagnostic. Verification rejects mixed run identities.

Canonical verification snapshots the final DMG into private storage while holding the lock, checks the final path's device/inode/size/SHA-256 before and after the copy and again after verification, and runs `hdiutil` only against the snapshot. The reported byte size and SHA-256 therefore describe the exact bytes that passed the independent mount verification; a path swap or in-place modification fails closed.

Compressed DMG filesystem metadata is not required to be byte-identical across separate builds. Reproducibility means both mounted images reproduce the sealed app inventory. Freeze and publish only the final candidate's recorded byte size and SHA-256.

The final artifacts and their run identities are:

```text
src-tauri/target/release/bundle/macos/Coding Wife.app
src-tauri/target/release/bundle/macos/Coding Wife.app.release.json
src-tauri/target/release/bundle/dmg/Coding-Wife.dmg
src-tauri/target/release/bundle/dmg/Coding-Wife.dmg.release.json
```

When preparing or verifying a release candidate, run the packaging test without compiling the real application:

```bash
pnpm test:release
```

This creates a minimal real arm64 Mach-O product fixture, feeds it through a controlled Tauri-builder boundary, applies the ad-hoc seal, exercises the real app verifier and top-level release scripts, builds and independently mounts a real DMG twice, injects build/license/legal/publish failures and repeated signals, attempts path swaps and private-path fixtures, verifies exact four-path rollback and crash-stale recovery, and checks lock, process, mount, temporary-prefix, and transaction cleanup.

## Create a draft GitHub Release

First update all three application versions to the same SemVer value on `develop`. After the required CI checks pass for the exact commit, create and push the matching tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

Do not reuse or move an existing tag. The version-tag workflow creates or refreshes a draft named `Coding Wife v0.1.1` with exactly these assets:

```text
Coding-Wife-v0.1.1-macOS-arm64.dmg
Coding-Wife-v0.1.1-macOS-arm64.dmg.sha256
Coding-Wife-v0.1.1-Windows-x64-setup.exe
Coding-Wife-v0.1.1-Windows-x64-setup.exe.sha256
Coding-Wife-v0.1.1-Linux-x64.deb
Coding-Wife-v0.1.1-Linux-x64.deb.sha256
Coding-Wife-v0.1.1-Linux-x64.AppImage
Coding-Wife-v0.1.1-Linux-x64.AppImage.sha256
```

Download all eight draft assets into a clean directory and verify the exact bytes:

```bash
shasum -a 256 --check Coding-Wife-v0.1.1-*.sha256
```

Before changing the draft to public, review the bilingual release notes and complete a downloaded-artifact smoke on every available target. CI already performs package install/removal on each native runner, but it does not prove that Gatekeeper or SmartScreen allowed a human first launch without the documented bounded exception.

## Install and launch

### macOS

Open the DMG, drag `Coding Wife.app` to Applications, and launch it there. Confirm the bundled Hiyori model renders, add or create a Git project, pass the Codex preflight, complete one primary turn, inspect its commit, and quit the app.

The hackathon artifact is ad-hoc signed for resource integrity, but it is not Developer ID signed or notarized. The ad-hoc signature does not identify a trusted distributor. This limitation applies equally to a local build and the free GitHub Release asset. Apple warns that running software without a trusted signature and notarization can expose the computer and personal information to malware. Proceed only after verifying the repository source, commit, frozen artifact SHA-256, and artifact provenance.

If Gatekeeper blocks this reviewed local or downloaded artifact, first try to open the app once. Then open **System Settings > Privacy & Security**, scroll down, choose **Open Anyway**, and confirm **Open** in the warning. This creates an exception for that app. Do not disable Gatekeeper or remove quarantine attributes globally. See Apple's [current safety guidance](https://support.apple.com/en-us/102445).

### Windows

Run `Coding-Wife-v0.1.1-Windows-x64-setup.exe`; the NSIS package installs for the current user without administrator rights. If SmartScreen warns, first verify the release URL and SHA-256, then choose **More info > Run anyway** for this installer only. Do not disable SmartScreen globally. Launch Coding Wife from the installed shortcut and uninstall it through Windows Settings after the smoke.

### Linux

Open the `.deb` with the system software installer on a compatible Ubuntu/Debian desktop. The AppImage is a portable fallback rather than an installer; set its executable bit and run it. Both are unsigned, so verify the SHA-256 sidecar first. Confirm the installed or extracted app starts, then remove the Debian package through the system package manager.

## Release evidence still required

Before external judging, publish the reviewed draft URL and four checksums and record the available fresh-profile install and first-launch smokes. Developer ID signing, notarization, stapling, Windows code signing, Linux repository signing, unsupported architectures, and automatic updates are outside the current artifact and must not be claimed as complete.
