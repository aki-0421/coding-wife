import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { App } from "@/app/App"
import { createLocalePreferenceStore } from "@/features/localization"
import {
  DemoTransport,
  RuntimeProvider,
  useRuntime,
  type AppTransport,
} from "@/features/runtime"
import {
  IpcBoundaryError,
  ipcCommands,
  type HealthCheckResponse,
  type IpcCommand,
  type IpcRequestMap,
  type IpcResponseMap,
  type RuntimeMetadata,
} from "@/lib/contracts"

class PendingDemoTransport implements AppTransport {
  readonly kind = "demo"

  request<K extends IpcCommand>(
    command: K,
    payload: IpcRequestMap[K],
  ): Promise<IpcResponseMap[K]> {
    void command
    void payload
    return new Promise(() => undefined)
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })

  return {
    promise,
    resolve(value) {
      resolvePromise?.(value)
    },
  }
}

const demoHealth: HealthCheckResponse = {
  schemaVersion: 1,
  runtime: "demo",
  foundationState: "demo_only",
}

const demoMetadata: RuntimeMetadata = {
  schemaVersion: 1,
  runtime: "demo",
  appVersion: "demo",
  platform: "browser",
  architecture: "web",
  integrations: {
    codex: "not_configured",
    git: "not_configured",
    live2d: "not_configured",
    history: "not_configured",
  },
}

const unavailableError = {
  code: "APP-IPC-UNAVAILABLE",
  operation: ipcCommands.healthCheck,
  recoverable: true,
  userMessageKey: "foundation.error",
} as const

type ResponseFactory<T> = () => Promise<T>

class ScriptedDemoTransport implements AppTransport {
  readonly kind = "demo"
  readonly requestCounts = {
    health_check: 0,
    get_runtime_metadata: 0,
  }
  readonly activeRequestCounts = {
    health_check: 0,
    get_runtime_metadata: 0,
  }
  readonly maximumActiveRequestCounts = {
    health_check: 0,
    get_runtime_metadata: 0,
  }

  constructor(
    private readonly healthResponses: ResponseFactory<HealthCheckResponse>[],
    private readonly metadataResponses: ResponseFactory<RuntimeMetadata>[],
  ) {}

  request<K extends IpcCommand>(
    command: K,
    payload: IpcRequestMap[K],
  ): Promise<IpcResponseMap[K]> {
    void payload

    const factory =
      command === ipcCommands.healthCheck
        ? this.healthResponses.shift()
        : this.metadataResponses.shift()

    if (!factory) {
      return Promise.reject(new Error("No scripted response"))
    }

    this.requestCounts[command] += 1
    this.activeRequestCounts[command] += 1
    this.maximumActiveRequestCounts[command] = Math.max(
      this.maximumActiveRequestCounts[command],
      this.activeRequestCounts[command],
    )

    const response = factory() as Promise<IpcResponseMap[K]>
    return response.finally(() => {
      this.activeRequestCounts[command] -= 1
    })
  }
}

function DuplicateRefreshProbe() {
  const { refresh, state } = useRuntime()

  return (
    <div>
      <span>{state.status}</span>
      {state.status === "error" ? (
        <button
          onClick={() => {
            refresh()
            refresh()
          }}
          type="button"
        >
          Retry twice
        </button>
      ) : null}
    </div>
  )
}

describe("App workspace shell", () => {
  it("keeps the localized loading state visible while runtime checks are pending", () => {
    render(
      <App
        localeStore={createLocalePreferenceStore("tauri")}
        transport={new PendingDemoTransport()}
      />,
    )

    expect(screen.getByText("Checking runtime")).toBeVisible()
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
  })

  it("labels browser execution as demo mode instead of native success", async () => {
    render(
      <App
        localeStore={createLocalePreferenceStore("tauri")}
        transport={new DemoTransport()}
      />,
    )

    expect(await screen.findByText("Preview only")).toBeVisible()
    expect(screen.getByText("Demo memory")).toBeVisible()
    expect(screen.queryByText(/Codex and Git are not connected/)).toBeNull()
    expect(
      document.querySelector('[data-character-stage-default="app-live2d"]'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText("Live2D renderer pending"),
    ).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
  })

  it("retries an initial IPC error through loading to success", async () => {
    const healthRetry = createDeferred<HealthCheckResponse>()
    const metadataRetry = createDeferred<RuntimeMetadata>()
    const transport = new ScriptedDemoTransport(
      [
        () => Promise.reject(new IpcBoundaryError(unavailableError)),
        () => healthRetry.promise,
      ],
      [() => Promise.resolve(demoMetadata), () => metadataRetry.promise],
    )

    render(
      <App
        localeStore={createLocalePreferenceStore("tauri")}
        transport={transport}
      />,
    )

    expect(
      await screen.findByText("The local runtime could not be reached"),
    ).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(screen.getByText("Checking runtime")).toBeVisible()

    await act(async () => {
      healthRetry.resolve(demoHealth)
      metadataRetry.resolve(demoMetadata)
      await Promise.all([healthRetry.promise, metadataRetry.promise])
    })

    expect(await screen.findByText("Preview only")).toBeVisible()
  })

  it("keeps the recovery operation after a retry fails again", async () => {
    const transport = new ScriptedDemoTransport(
      [
        () => Promise.reject(new IpcBoundaryError(unavailableError)),
        () => Promise.reject(new IpcBoundaryError(unavailableError)),
      ],
      [
        () => Promise.resolve(demoMetadata),
        () => Promise.resolve(demoMetadata),
      ],
    )

    render(
      <App
        localeStore={createLocalePreferenceStore("tauri")}
        transport={transport}
      />,
    )

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }))

    expect(
      await screen.findByText("The local runtime could not be reached"),
    ).toBeVisible()
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled()
    expect(transport.requestCounts.health_check).toBe(2)
  })

  it("deduplicates refresh calls while a runtime request is queued", async () => {
    const healthRetry = createDeferred<HealthCheckResponse>()
    const metadataRetry = createDeferred<RuntimeMetadata>()
    const transport = new ScriptedDemoTransport(
      [
        () => Promise.reject(new IpcBoundaryError(unavailableError)),
        () => healthRetry.promise,
      ],
      [() => Promise.resolve(demoMetadata), () => metadataRetry.promise],
    )

    render(
      <RuntimeProvider transport={transport}>
        <DuplicateRefreshProbe />
      </RuntimeProvider>,
    )

    fireEvent.click(await screen.findByRole("button", { name: "Retry twice" }))

    expect(screen.getByText("loading")).toBeVisible()
    expect(transport.requestCounts).toEqual({
      health_check: 2,
      get_runtime_metadata: 2,
    })

    await act(async () => {
      healthRetry.resolve(demoHealth)
      metadataRetry.resolve(demoMetadata)
      await Promise.all([healthRetry.promise, metadataRetry.promise])
    })

    expect(await screen.findByText("ready")).toBeVisible()
  })

  it("coalesces a pending sibling command across repeated retries", async () => {
    const pendingMetadata = createDeferred<RuntimeMetadata>()
    const transport = new ScriptedDemoTransport(
      [
        () => Promise.reject(new IpcBoundaryError(unavailableError)),
        () => Promise.resolve(demoHealth),
      ],
      [() => pendingMetadata.promise],
    )

    render(
      <RuntimeProvider transport={transport}>
        <DuplicateRefreshProbe />
      </RuntimeProvider>,
    )

    fireEvent.click(await screen.findByRole("button", { name: "Retry twice" }))

    expect(screen.getByText("loading")).toBeVisible()
    expect(transport.requestCounts).toEqual({
      health_check: 2,
      get_runtime_metadata: 1,
    })
    expect(transport.maximumActiveRequestCounts).toEqual({
      health_check: 1,
      get_runtime_metadata: 1,
    })

    await act(async () => {
      pendingMetadata.resolve(demoMetadata)
      await pendingMetadata.promise
    })

    expect(await screen.findByText("ready")).toBeVisible()
  })
})
