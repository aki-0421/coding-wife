import { describe, expect, it, vi } from "vitest"

import {
  appLifecycleCommands,
  appLifecycleDemoEvents,
  appLifecycleEventChannels,
} from "@/features/app-lifecycle/contracts"
import {
  DemoAppLifecycleGateway,
  TauriAppLifecycleGateway,
} from "@/features/app-lifecycle/gateway"

const closeRequest = {
  schemaVersion: 1 as const,
  requestId: "app-quit-550e8400-e29b-41d4-a716-446655440000",
  workspaceId: "workspace-550e8400-e29b-41d4-a716-446655440000",
  workspaceGeneration: 4,
}

const cleanupFailure = {
  schemaVersion: 1 as const,
  requestId: closeRequest.requestId,
  attempt: 1,
  errorCode: "APP-QUIT-CLEANUP-INCOMPLETE" as const,
}

describe("TauriAppLifecycleGateway", () => {
  it("listens on the dedicated channel and rejects malformed payloads", async () => {
    const registered: { receive?: (payload: unknown) => void } = {}
    const listener = vi.fn()
    const dispose = vi.fn()
    const gateway = new TauriAppLifecycleGateway({
      listen: (channel, callback) => {
        expect(channel).toBe(appLifecycleEventChannels.closeRequested)
        registered.receive = callback
        return Promise.resolve(dispose)
      },
    })

    await expect(gateway.listenCloseRequested(listener)).resolves.toBe(dispose)
    const receive = registered.receive
    if (receive === undefined) throw new Error("listener was not registered")
    receive({ ...closeRequest, privatePath: "/Users/private" })
    receive(closeRequest)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(closeRequest)
  })

  it("listens for sanitized cleanup failure recovery without process details", async () => {
    const registered: { receive?: (payload: unknown) => void } = {}
    const listener = vi.fn()
    const dispose = vi.fn()
    const gateway = new TauriAppLifecycleGateway({
      listen: (channel, callback) => {
        expect(channel).toBe(appLifecycleEventChannels.cleanupFailed)
        registered.receive = callback
        return Promise.resolve(dispose)
      },
    })

    await expect(gateway.listenCleanupFailed(listener)).resolves.toBe(dispose)
    const receive = registered.receive
    if (receive === undefined) throw new Error("listener was not registered")
    receive({ ...cleanupFailure, service: "history" })
    receive(cleanupFailure)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(cleanupFailure)
  })

  it("sends an exact request and does not expose raw native errors", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("/Users/private/token=secret"))
    const gateway = new TauriAppLifecycleGateway({ invoke })

    await gateway.cancelQuit(closeRequest.requestId)
    expect(invoke).toHaveBeenNthCalledWith(1, appLifecycleCommands.cancelQuit, {
      request: {
        schemaVersion: 1,
        requestId: closeRequest.requestId,
      },
    })
    await gateway.retryCleanup(closeRequest.requestId)
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      appLifecycleCommands.retryCleanup,
      {
        request: {
          schemaVersion: 1,
          requestId: closeRequest.requestId,
        },
      },
    )
    await expect(gateway.confirmQuit(closeRequest.requestId)).rejects.toEqual(
      expect.objectContaining({
        code: "APP-LIFECYCLE-IPC-UNAVAILABLE",
        message: "APP-LIFECYCLE-IPC-UNAVAILABLE",
      }),
    )
  })
})

describe("DemoAppLifecycleGateway", () => {
  it("provides a strict browser-only close intent harness", async () => {
    const gateway = new DemoAppLifecycleGateway()
    const listener = vi.fn()
    const action = vi.fn()
    window.addEventListener(appLifecycleDemoEvents.action, action)
    const cleanupListener = vi.fn()
    const dispose = await gateway.listenCloseRequested(listener)
    const disposeCleanup = await gateway.listenCleanupFailed(cleanupListener)
    try {
      window.dispatchEvent(
        new CustomEvent(appLifecycleDemoEvents.closeRequested, {
          detail: closeRequest,
        }),
      )
      expect(listener).toHaveBeenCalledWith(closeRequest)
      window.dispatchEvent(
        new CustomEvent(appLifecycleDemoEvents.cleanupFailed, {
          detail: cleanupFailure,
        }),
      )
      expect(cleanupListener).toHaveBeenCalledWith(cleanupFailure)
      await gateway.confirmQuit(closeRequest.requestId)
      await gateway.retryCleanup(closeRequest.requestId)
      expect(action).toHaveBeenCalledTimes(2)
    } finally {
      dispose()
      disposeCleanup()
      window.removeEventListener(appLifecycleDemoEvents.action, action)
    }
  })
})
