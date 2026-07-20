---
name: tauri-wdio-debug
description: Debug, inspect, test, and perform QA on the real Coding Wife Tauri desktop application with WebdriverIO and its embedded WebDriver. Use for macOS app-window interaction, WDIO specs, Tauri IPC checks, frontend or Rust log capture, screenshots, native viewport checks, UI bug reproduction, or replacement of browser-only automation for Coding Wife behavior.
---

# Tauri WebdriverIO debugging

Use the repository-owned WebdriverIO setup. It launches the compiled Tauri debug binary and
drives React inside its real WKWebView. Do not substitute Chrome, the Vite-only frontend, or
browser-only automation for desktop evidence.

## Read first

Read [the desktop QA contract](../../../docs/research/tauri-desktop-qa.md) before changing or
running the harness. Read [Testing Coding Wife](../../../docs/testing.md) when the task includes
release evidence or installation claims.

Only run local tests or builds when the user asks for debugging, QA, verification, or another
case allowed by `AGENTS.md`. Implementing the harness alone does not authorize a desktop build.

## Standard run

Run all committed desktop scenarios:

```bash
pnpm test:desktop
```

The command builds `src-tauri/target/debug/coding-wife` with the `desktop-qa` feature and QA-only
Tauri config, then starts and stops it through WebdriverIO.

For repeated investigation, build once and select one spec:

```bash
VITE_DESKTOP_QA=true pnpm exec tauri build \
  --debug \
  --no-bundle \
  --features desktop-qa \
  --config src-tauri/tauri.qa.conf.json
pnpm exec wdio run wdio.conf.ts --spec /absolute/path/to/scenario.spec.ts
```

Put durable regression scenarios in `e2e/desktop/`. Put one-off agent scenarios in
`.context/desktop-qa/` so they remain untracked. Always use an absolute path with `--spec` for a
scenario outside `e2e/desktop/`.

## Scenario rules

1. State the user-visible behavior and expected result before writing the spec.
2. Prefer semantic roles, accessible names, and existing stable attributes. Add `data-testid`
   only when the UI has no stable semantic selector.
3. Wait for the exact state transition with `waitForDisplayed`, `waitUntil`, or an assertion.
   Do not use arbitrary pauses to hide a race.
4. Use `browser.tauri.execute()` only for bounded, read-only diagnostics or an explicit IPC
   assertion. Exercise the UI path when the behavior is user-facing.
5. Treat `browser.tauri.mock()` as a separate error-state scenario. A mocked command does not
   prove the real Rust path.
6. Keep `maxInstances` at 1. Use `CODING_WIFE_WDIO_PORT` only when a caller needs an explicit
   port; Conductor workspaces otherwise derive it from `CONDUCTOR_PORT`.
7. Verify 1470 x 836, 1280 x 800, and the native minimum 960 x 640 logical pixels when layout is
   in scope. Use `setLogicalWindowSize` from `e2e/desktop/support/window.ts`; raw
   `browser.setWindowSize(960, 640)` produces a 480 x 320 CSS viewport on a 2x Retina display.
   Do not claim a 480px viewport as native 960px Tauri evidence.

Use explicit imports in specs:

```ts
import { $, browser, expect } from "@wdio/globals"
```

## Safety boundaries

- The harness redirects app data to `tmp/desktop-qa/app-data-<port>`. Treat another app-data
  path as a configuration failure.
- Create Git fixtures only under `/tmp` or the ignored repository `tmp/` directory. Never select
  a user's real repository during automated QA.
- Do not enable `desktop-qa`, `withGlobalTauri`, the WDIO frontend bridge, or `wdio:*`
  capabilities in a production or release build.
- Do not automate macOS permission dialogs, file pickers, Dock, or menu bar with this harness.
  Report that Appium Mac2 or XCTest is required for those OS-owned surfaces.
- Do not terminate every Coding Wife process. WebdriverIO owns its launched process. If an
  interrupted run leaks a process, identify the exact QA binary and PID before stopping it.

## Evidence and diagnosis

The config captures frontend and backend logs and saves failure screenshots under
`tmp/desktop-qa/`. Report:

- the exact spec and window size;
- whether the real IPC path or a mock ran;
- the visible failure and relevant frontend/backend error;
- the screenshot path when one was created;
- whether WebdriverIO shut down the QA app cleanly.

Do not commit files under `tmp/` or `.context/`. Do not report a desktop scenario as passed when
it was not run.

For less common WebdriverIO APIs, read [Tauri patterns](reference/tauri-patterns.md).
