# Tauri WebdriverIO patterns

Read this reference only when a scenario needs IPC access, error-state mocking, screenshots, or
window sizing beyond the startup smoke.

## Real IPC

```ts
interface RuntimeMetadata {
  readonly schemaVersion: number
  readonly runtime: "tauri"
}

const metadata = await browser.tauri.execute(
  async ({ core }): Promise<RuntimeMetadata> =>
    core.invoke<RuntimeMetadata>("get_runtime_metadata"),
)

expect(metadata.runtime).toBe("tauri")
```

Prefer clicking the UI control that invokes a command. Use direct IPC when the contract itself is
the assertion or when a read-only result helps diagnose the visible failure.

## Narrow IPC mock

```ts
const mock = await browser.tauri.mock("read_only_command")
await mock.mockRejectedValue({ code: "fixture_error" })

// Perform the user action after installing the mock, then assert the visible error.
```

Restore or reset mocks before the next scenario. Never present a mocked scenario as backend
integration evidence.

## Stable selectors

```ts
const settings = await $('button[aria-label="App settings"]')
await settings.waitForClickable()
await settings.click()
```

Prefer role/name or label selectors. Avoid generated class names, DOM position, and copy that is
unrelated to the behavior under test.

## Window sizes

```ts
import { setLogicalWindowSize } from "./support/window"

const metrics = await setLogicalWindowSize({ width: 1280, height: 800 })
expect(metrics.viewport).toEqual({ width: 1280, height: 800 })
```

WebdriverIO reports physical pixels on macOS, while the acceptance sizes and CSS viewport use
logical pixels. The helper converts through `window.devicePixelRatio` and verifies the resulting
CSS viewport. On a 2x Retina display, a logical 960 x 640 capture is a 1920 x 1280 PNG. The app
enforces a 960 x 640 logical minimum. Test smaller effective layouts only when the product contract
explicitly supplies an in-app mechanism; a browser-only viewport is not native evidence.

## Manual screenshot

The shared config saves screenshots after failed tests. Capture an additional checkpoint only when
it explains the defect:

```ts
await browser.saveScreenshot("tmp/desktop-qa/reproduction.png")
```

Keep all images in the ignored QA directory.
