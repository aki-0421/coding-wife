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

  constructor(
    private readonly healthResponses: ResponseFactory<HealthCheckResponse>[],
    private readonly metadataResponses: ResponseFactory<RuntimeMetadata>[],
  ) {}

  request<K extends IpcCommand>(
    command: K,
    payload: IpcRequestMap[K],
  ): Promise<IpcResponseMap[K]> {
    void payload
    this.requestCounts[command] += 1

    const factory =
      command === ipcCommands.healthCheck
        ? this.healthResponses.shift()
        : this.metadataResponses.shift()

    if (!factory) {
      return Promise.reject(new Error("No scripted response"))
    }

    return factory() as Promise<IpcResponseMap[K]>
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

describe("App foundation shell", () => {
  it("keeps the localized loading state visible while runtime checks are pending", () => {
    render(
      <App
        localeStore={createLocalePreferenceStore("tauri")}
        transport={new PendingDemoTransport()}
      />,
    )

    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking the local runtime…",
    )
  })

  it("labels browser execution as demo mode instead of native success", async () => {
    render(
      <App
        localeStore={createLocalePreferenceStore("tauri")}
        transport={new DemoTransport()}
      />,
    )

    expect(await screen.findByText(/Runtime mode: Browser demo/i)).toBeVisible()
    expect(
      screen.getByText(
        "Demo mode does not connect to Codex, Git, Live2D, or local history.",
      ),
    ).toBeVisible()
    expect(screen.getAllByText("Not configured")).toHaveLength(4)
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

    expect(await screen.findByText("APP-IPC-UNAVAILABLE")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking the local runtime…",
    )

    await act(async () => {
      healthRetry.resolve(demoHealth)
      metadataRetry.resolve(demoMetadata)
      await Promise.all([healthRetry.promise, metadataRetry.promise])
    })

    expect(await screen.findByText(/Runtime mode: Browser demo/i)).toBeVisible()
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

    expect(await screen.findByText("APP-IPC-UNAVAILABLE")).toBeVisible()
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
})
