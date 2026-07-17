# Coding Wife

Coding Wife is a macOS desktop workspace for supervising long-running Codex work through structured evidence, recoverable checkpoints, and a Live2D companion.

This repository currently contains the application foundation only. The browser build is always an explicitly labeled demo transport: it does not connect to Codex, Git, Live2D, or local history, and it never presents those integrations as successful.

## Prerequisites

- macOS 14 or later for the supported desktop target
- Node.js compatible with Vite 8 and Corepack
- pnpm 10.12.2 (pinned by `packageManager`)
- rustup; `rust-toolchain.toml` selects Rust 1.88.0 with Clippy and rustfmt
- Xcode is required only when producing signed or bundled macOS artifacts; Command Line Tools are sufficient for the no-bundle checks below

No environment variables or secrets are required. See `.env.example`.

## Set up and run

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` opens the browser demo. Run the native shell with:

```bash
pnpm tauri dev
```

## Verify

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
git diff --check
```

The frontend checks cover strict TypeScript, linting, the localized foundation shell, demo-mode honesty, and the production Vite bundle. The Rust checks cover the minimal typed command allowlist and ensure every future integration is still reported as `not_configured`.

## Architecture boundaries

- `src/app/` composes application-wide providers and the root shell.
- `src/features/` owns feature state and behavior. Localization and runtime transport are the only implemented features.
- `src/components/ui/` contains shadcn interaction primitives. Product layout belongs in feature components, not in these primitives.
- `src/lib/contracts/` is the versioned TypeScript contract for domain events and IPC payloads.
- `src-tauri/` is the trusted native boundary. Only `health_check` and `get_runtime_metadata` are exposed today; no generic shell, filesystem, process, or Git command is available.

The Tauri transport calls that read-only command allowlist. The browser transport returns `demo_only` and `not_configured` states. Locale persistence is intentionally session-only in Tauri until the Rust settings store exists; only browser demo mode uses the `coding-wife:demo:*` Web Storage namespace.

## Intentionally not implemented yet

The main workspace layout, Codex supervisor, Live2D renderer and custom-model import, SQLite history, Git ownership/checkpoint service, and production settings persistence belong to later work units. Their approved behavior is specified under `docs/requirements/` and `docs/screen-design/`.
