import { describe, expect, it, vi } from "vitest"

import { presenceDirectionEventChannel } from "@/features/narration/contracts"
import {
  TauriPresenceDirectionSource,
  type PresenceDirectionEventListener,
} from "@/features/narration/presence-source"

describe("TauriPresenceDirectionSource", () => {
  it("subscribes to the exact public channel and forwards payloads", async () => {
    let nativeListener: ((payload: unknown) => void) | undefined
    const dispose = vi.fn()
    const listen = vi.fn<PresenceDirectionEventListener>(
      (_channel, listener) => {
        nativeListener = listener
        return Promise.resolve(dispose)
      },
    )
    const consumer = vi.fn()
    const source = new TauriPresenceDirectionSource({ listen })

    const unsubscribe = source.subscribe(consumer)
    await Promise.resolve()
    nativeListener?.({ requestId: "request-1" })

    expect(listen).toHaveBeenCalledWith(
      presenceDirectionEventChannel,
      expect.any(Function),
    )
    expect(consumer).toHaveBeenCalledWith({ requestId: "request-1" })
    unsubscribe()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("disposes a listener that resolves after unsubscribe", async () => {
    let resolveListen: ((dispose: () => void) => void) | undefined
    const dispose = vi.fn()
    const listen = vi.fn<PresenceDirectionEventListener>(
      () =>
        new Promise((resolve) => {
          resolveListen = resolve
        }),
    )
    const source = new TauriPresenceDirectionSource({ listen })

    const unsubscribe = source.subscribe(vi.fn())
    unsubscribe()
    resolveListen?.(dispose)
    await Promise.resolve()

    expect(dispose).toHaveBeenCalledOnce()
  })
})
