import { describe, expect, it, vi } from "vitest"

import { SupportControlsController } from "@/features/support-controls/controller"
import type { SupportControlSnapshotV1 } from "@/features/support-controls/contracts"
import {
  DemoSupportControlsGateway,
  SupportControlsBoundaryError,
  type SupportControlsGateway,
} from "@/features/support-controls/transport"

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

describe("SupportControlsController", () => {
  it("serializes desired changes against the latest accepted version", async () => {
    const controller = new SupportControlsController(
      new DemoSupportControlsGateway(),
    )
    expect(await controller.initialize()).toBe(true)
    const first = controller.update({ globalEnabled: false })
    const second = controller.update({ commitExplainerEnabled: false })
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: {
        settings: {
          version: 3,
          globalEnabled: false,
          commitExplainerEnabled: false,
        },
        effectiveState: "user_disabled",
      },
    })
    controller.dispose()
  })

  it("refetches the persisted off snapshot after disable cleanup errors", async () => {
    const demo = new DemoSupportControlsGateway()
    let failAfterPersist = true
    const gateway: SupportControlsGateway = {
      kind: "demo",
      get: () => demo.get(),
      update: async (request) => {
        const snapshot = await demo.update(request)
        if (failAfterPersist) {
          failAfterPersist = false
          throw new SupportControlsBoundaryError({
            code: "CODEX-SUPPORT-DISABLE-INCOMPLETE",
            operation: "support_settings_update",
            recoverable: true,
            userMessageKey: "support.error.generic",
          })
        }
        return snapshot
      },
    }
    const controller = new SupportControlsController(gateway)
    expect(await controller.initialize()).toBe(true)
    expect(
      await controller.update({
        globalEnabled: false,
        commitExplainerEnabled: false,
      }),
    ).toBe(false)
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      errorCode: "CODEX-SUPPORT-DISABLE-INCOMPLETE",
      snapshot: {
        settings: {
          version: 2,
          globalEnabled: false,
          commitExplainerEnabled: false,
        },
        effectiveState: "user_disabled",
      },
    })

    await expect(
      controller.update({ commitExplainerEnabled: true }),
    ).resolves.toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: { settings: { version: 3 } },
    })
  })

  it("ignores a pending initialization after its mount lease is released", async () => {
    const pending = deferred<SupportControlSnapshotV1>()
    const gateway: SupportControlsGateway = {
      kind: "demo",
      get: () => pending.promise,
      update: vi.fn(),
    }
    const controller = new SupportControlsController(gateway)
    const listener = vi.fn()
    controller.subscribe(listener)
    const lease = controller.activate()
    const initialize = controller.initialize()
    controller.deactivate(lease)
    pending.resolve(await new DemoSupportControlsGateway().get())

    await expect(initialize).resolves.toBe(false)
    expect(listener).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toEqual({
      status: "loading",
      snapshot: null,
      errorCode: null,
    })
  })

  it("does not refetch or publish when an update settles after unmount", async () => {
    const initial = await new DemoSupportControlsGateway().get()
    const pending = deferred<SupportControlSnapshotV1>()
    const get = vi.fn().mockResolvedValue(initial)
    const gateway: SupportControlsGateway = {
      kind: "demo",
      get,
      update: () => pending.promise,
    }
    const controller = new SupportControlsController(gateway)
    const lease = controller.activate()
    await controller.initialize()
    const listener = vi.fn()
    controller.subscribe(listener)
    const update = controller.update({ globalEnabled: false })
    await vi.waitFor(() => {
      expect(controller.getSnapshot().status).toBe("saving")
    })
    const notificationsAtUnmount = listener.mock.calls.length
    controller.deactivate(lease)
    pending.reject(new SupportControlsBoundaryError())

    await expect(update).resolves.toBe(false)
    expect(listener).toHaveBeenCalledTimes(notificationsAtUnmount)
    expect(get).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().status).toBe("saving")
  })
})
