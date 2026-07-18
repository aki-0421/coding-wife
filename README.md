# Coding Wife

Coding Wife is a macOS desktop workspace for supervising long-running Codex work through structured evidence, recoverable checkpoints, and a Live2D companion.

The current increment includes the bilingual workspace UI, a typed and fail-closed Codex App Server boundary, and the bundled Hiyori Live2D companion. The default browser workspace is still an explicitly labeled preview: it renders the real bundled Live2D model, but uses deterministic workspace data and does not claim a live Codex, Git, or history connection. The native Codex supervisor, transport, and workspace store are implemented and tested, but are not yet injected into the default `WorkspaceShell` as an end-to-end production workflow.

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

The normal app renders the bundled Hiyori companion. For an isolated renderer diagnostic, open `/live2d-preview.html` from the Vite development server.

## Verify

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm live2d:verify
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build --debug --no-bundle
agent-docs lint
pnpm check:diff
```

The frontend checks cover strict TypeScript, linting, the localized workspace, preview-mode honesty, the Codex contracts and state stores, the Live2D renderer and supply chain, and the production Vite bundle. The Rust checks cover the runtime metadata boundary and the constrained Codex App Server supervisor and command surface.

`pnpm check:diff` checks `origin/develop...HEAD`, staged changes, unstaged changes, and untracked files without printing diff contents or absolute paths. Use `pnpm check:diff -- --working-tree` when the base ref is intentionally unavailable. The command excludes only the canonical Hiyori `NOTICE.txt` from whitespace checks and separately requires its pinned byte-exact SHA-256, so modifying, deleting, renaming, or replacing the notice still fails.

## Build the macOS artifact

```bash
pnpm release:macos
```

Tauri creates `Coding Wife.app`; the repository release script then creates and mounts a read-only DMG without Finder automation before publishing it. See [the full testing instructions](docs/testing.md) for the artifact path, synthetic packaging smoke, installation steps, and the unsigned/unnotarized MVP boundary.

## Architecture boundaries

- `src/app/` composes application-wide providers and the root shell.
- `src/features/` owns feature state and behavior, including the workspace, localization, runtime transport, Codex client/store, and Live2D renderer.
- `src/components/ui/` contains shadcn interaction primitives. Product layout belongs in feature components, not in these primitives.
- `src/lib/contracts/` is the versioned TypeScript contract for domain events and IPC payloads.
- `src-tauri/` is the trusted native boundary. It exposes `health_check`, `get_runtime_metadata`, and the reviewed Codex workspace/App Server commands; no generic shell, arbitrary filesystem/process, or Git command is available.

`src/test/fixtures/runtime-foundation.v1.json` is the shared Rust/TypeScript IPC fixture. Update it together with both parsers and contract tests whenever the foundation schema version changes; malformed or mismatched native responses must remain fail-closed.

The browser runtime transport returns `demo_only` and `not_configured` integration states, while the bundled Live2D renderer runs entirely within the reviewed frontend asset boundary. Locale persistence is intentionally session-only in Tauri until the Rust settings store exists; only browser demo mode uses the `coding-wife:demo:*` Web Storage namespace.

The release attribution entry point is `src-tauri/resources/legal/THIRD-PARTY-NOTICES.md`. It links the byte-exact Cubism SDK/Core/Framework licenses, redistributable-file list, pinned upstream metadata and checksums, and the bundled Hiyori notice. `pnpm live2d:verify`, the Vite production build, and the Tauri resource configuration all enforce this notice set.

## Intentionally not implemented yet

Custom Live2D model import and selection, SQLite history, the Git ownership/checkpoint service, production settings persistence, and injection of the native Codex adapter into the default workspace remain future work. Their approved behavior is specified under `docs/requirements/` and `docs/screen-design/`.
