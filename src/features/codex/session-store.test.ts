import { describe, expect, it, vi } from "vitest"

import { CodexSessionClient } from "@/features/codex/client"
import { CodexSessionStore } from "@/features/codex/session-store"
import type { CodexTransport } from "@/features/codex/transport"
import {
  parseCodexEvent,
  type CodexPendingResponseRequest,
} from "@/lib/contracts"
import fixture from "@/test/fixtures/codex-runtime.v1.json"

const fixtureEvents = fixture.events.map(parseCodexEvent)

describe("CodexSessionStore", () => {
  it("drops duplicates, stale generations, and out-of-order events", () => {
    const store = new CodexSessionStore()
    const first = fixtureEvents[0]
    const second = fixtureEvents[1]
    if (first === undefined || second === undefined) throw new Error("fixture")

    expect(store.apply(first)).toBe("applied")
    expect(store.apply(first)).toBe("duplicate")
    expect(store.apply({ ...second, sequence: 1 })).toBe("out_of_order")
    expect(store.apply({ ...second, generation: 6 })).toBe("stale")
    expect(store.snapshot().events).toHaveLength(1)
  })

  it("atomically resets transient state when generation advances", () => {
    const store = new CodexSessionStore()
    for (const event of fixtureEvents) store.apply(event)
    expect(store.snapshot().pendingRequests).toHaveLength(1)

    const next = fixtureEvents[0]
    if (next === undefined) throw new Error("fixture")
    expect(
      store.apply({
        ...next,
        eventId: "event-generation-8",
        generation: 8,
        sequence: 1,
      }),
    ).toBe("generation_advanced")
    expect(store.snapshot()).toMatchObject({
      generation: 8,
      lastSequence: 1,
      pendingRequests: [],
    })
  })

  it("allows exactly one response for each pending request", async () => {
    const request = {
      workspaceId: "workspace-fixture",
      pendingId: "pending_handle_fixture",
      response: { type: "approval", decision: "reject" },
    } satisfies CodexPendingResponseRequest
    const store = new CodexSessionStore()
    const pending = fixtureEvents[1]
    if (pending === undefined) throw new Error("fixture")
    store.apply(pending)

    const requestMock = vi.fn().mockResolvedValue({ accepted: true })
    const transport = {
      kind: "demo",
      request: requestMock,
      subscribe: () => Promise.resolve(() => undefined),
    } as CodexTransport
    const client = new CodexSessionClient(transport, store)

    await expect(client.respondPending(request)).resolves.toBe(true)
    await expect(client.respondPending(request)).resolves.toBe(false)
    expect(requestMock).toHaveBeenCalledOnce()
  })
})
