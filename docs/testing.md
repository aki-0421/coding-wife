---
title: "Testing Coding Wife"
description: "Judge-facing setup, verification, macOS release packaging, installation, and Gatekeeper instructions for Coding Wife."
updated: 2026-07-18
read_when:
  - "Reproducing the hackathon build or verifying Coding Wife on macOS."
  - "Changing release commands, the DMG layout, or repository quality gates."
---

# Testing Coding Wife

## Supported release target

The verified MVP target is macOS 14 or later on Apple Silicon. Windows, Linux, and Intel Mac artifacts are not claimed as supported. The current hackathon artifact is unsigned and not notarized; build it from the reviewed source whenever possible.

## Install dependencies

```bash
corepack enable
pnpm install --frozen-lockfile
```

No application API key is required. A compatible, authenticated local Codex installation is required for the production conversation path.

## Run the development build

```bash
pnpm dev
```

Run the native shell with:

```bash
pnpm tauri dev
```

## Run the quality gates

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build --debug --no-bundle
agent-docs lint
pnpm check:diff
```

`pnpm check:diff` checks committed changes from `origin/develop...HEAD`, staged changes, unstaged changes, and untracked files. CI passes the Pull Request base commit to the same command. Use `pnpm check:diff -- --working-tree` for local work when the base ref is intentionally unavailable.

The command excludes only `src-tauri/resources/characters/builtin-hiyori/NOTICE.txt` from whitespace diagnostics because that third-party notice must retain its approved bytes. It independently verifies the pinned SHA-256 and requires the path to remain a regular file, so modifying, deleting, renaming, or replacing the notice fails. Files at every other path remain checked. Failure output contains safe scope codes rather than diff lines, secrets, or absolute paths. The command never modifies the notice or the Git worktree.

## Build the macOS artifact

Build and verify both the Tauri app bundle and the repository-owned DMG:

```bash
pnpm release:macos
```

The commands are intentionally split for diagnosis:

```bash
pnpm release:macos:app
pnpm release:macos:dmg
```

Tauri produces only `Coding Wife.app`. The second command stages that bundle with an `/Applications` symlink, creates a compressed read-only DMG with `hdiutil`, mounts it without Finder or AppleScript, verifies its contents and write rejection, detaches it, and only then replaces the final artifact.

The final artifact is:

```text
src-tauri/target/release/bundle/dmg/Coding-Wife.dmg
```

Run the packaging test without compiling the real application:

```bash
pnpm test:release
```

This creates a synthetic tiny `.app`, builds a real DMG, mounts it read-only, checks the app and Applications link, unmounts it, and verifies cleanup and fail-closed argument behavior.

## Install and launch

1. Open `Coding-Wife.dmg` on a macOS 14+ test Mac.
2. Drag `Coding Wife.app` to Applications.
3. Launch Coding Wife from Applications.
4. Confirm the bundled Hiyori model renders, add or create a Git project, pass the Codex preflight, complete one primary turn, inspect its commit, and quit the app.

The hackathon artifact is not signed or notarized. Apple warns that running unsigned and unnotarized software can expose the computer and personal information to malware. Proceed only after verifying the repository source, commit, and artifact provenance.

If Gatekeeper blocks this reviewed local build, first try to open the app once. Then open **System Settings > Privacy & Security**, scroll down, choose **Open Anyway**, and confirm **Open** in the warning. This creates an exception for that app. Do not disable Gatekeeper or remove quarantine attributes globally. See Apple's [current safety guidance](https://support.apple.com/en-us/102445).

## Release evidence still required

Before external judging, record a fresh-profile or second-Mac install and first-launch smoke. Signing, notarization, stapling, Intel/universal packaging, and automatic updates are outside the current MVP artifact and must not be claimed as complete.
