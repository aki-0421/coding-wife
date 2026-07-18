import { describe, expect, it, vi } from "vitest"

import { CodexSessionClient } from "@/features/codex/client"
import { CodexSessionStore } from "@/features/codex/session-store"
import type { CodexTransport } from "@/features/codex/transport"
import {
  parseCodexEvent,
  type CodexFallbackDecisionRequest,
  type CodexPendingResponseRequest,
} from "@/lib/contracts"
import fixture from "@/test/fixtures/codex-runtime.v1.json"

const fixtureEvents = fixture.events.map(parseCodexEvent)

describe("CodexSessionStore", () => {
  it("rejects a future-generation event from a non-active workspace", () => {
    const store = new CodexSessionStore()
    const first = fixtureEvents[0]
    if (first === undefined) throw new Error("fixture")
    store.activateWorkspace("workspace-fixture")

    expect(
      store.apply({
        ...first,
        eventId: "event-other-workspace",
        workspaceId: "workspace-other",
        generation: first.generation + 1,
      }),
    ).toBe("workspace_mismatch")
    expect(store.snapshot()).toMatchObject({
      workspaceId: "workspace-fixture",
      generation: null,
      events: [],
    })
  })

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
    for (const event of fixtureEvents.slice(0, 3)) store.apply(event)
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

  it("allows exactly one kind-matched response for each pending request", async () => {
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

    await expect(
      client.respondPending({
        ...request,
        response: {
          type: "user_input",
          answers: { choice: ["Continue"] },
        },
      }),
    ).resolves.toBe(false)
    const [first, second] = await Promise.all([
      client.respondPending(request),
      client.respondPending(request),
    ])
    expect([first, second].sort()).toEqual([false, true])
    await expect(client.respondPending(request)).resolves.toBe(false)
    expect(requestMock).toHaveBeenCalledOnce()
  })

  it("keeps fallback decisions after the source turn and claims one continuation", async () => {
    const pending = fixtureEvents[1]
    const running = fixtureEvents[0]
    if (
      pending?.kind !== "pending_request" ||
      running?.kind !== "turn_status"
    ) {
      throw new Error("fixture")
    }
    const fallback = parseCodexEvent({
      ...pending,
      eventId: "event-fallback",
      sequence: 1,
      payload: {
        request: {
          pendingId: "decision-fixture",
          kind: "user_input",
          responseKind: "fallback_decision",
          operation: "decision_fallback",
          targetAlias: "active_turn",
          reason: "Choose a bounded continuation.",
          questions: [
            {
              id: "decision",
              header: "Decision",
              question: "Continue?",
              options: [
                { id: "option-yes", label: "Yes", description: "Continue" },
                { id: "option-no", label: "No", description: "Stop" },
              ],
            },
          ],
          allowedDecisions: [],
          decisionContext: {
            schemaVersion: 1,
            category: "user_decision",
            targetKind: "active_turn",
            targetAlias: "active_turn",
            effect: "continue_turn",
            scope: "turn",
            risk: "medium",
            reversibility: "unknown",
            recommendation: "option-yes",
            evidence: ["Choose the bounded continuation for this turn."],
            uncertainty: "limited_context",
          },
        },
      },
    })
    const store = new CodexSessionStore()
    store.apply(fallback)
    store.apply({
      ...running,
      eventId: "event-source-completed",
      sequence: 2,
      payload: { ...running.payload, status: "completed" },
    })
    expect(store.snapshot().pendingRequests).toHaveLength(1)

    const requestMock = vi.fn().mockResolvedValue({
      threadHandle: "thread_handle_fixture",
      turnHandle: "turn_decision_fixture",
    })
    const client = new CodexSessionClient(
      {
        kind: "demo",
        request: requestMock,
        subscribe: () => Promise.resolve(() => undefined),
      } as CodexTransport,
      store,
    )
    const request = {
      workspaceId: "workspace-fixture",
      decisionHandle: "decision-fixture",
      optionId: "option-yes",
    } satisfies CodexFallbackDecisionRequest

    await expect(
      client.answerFallbackDecision({ ...request, optionId: "unknown" }),
    ).resolves.toBe(false)
    const [first, second] = await Promise.all([
      client.answerFallbackDecision(request),
      client.answerFallbackDecision(request),
    ])
    expect([first, second].sort()).toEqual([false, true])
    expect(requestMock).toHaveBeenCalledOnce()
    expect(requestMock).toHaveBeenCalledWith(
      "codex_answer_fallback_decision",
      request,
    )
    expect(store.snapshot().pendingRequests).toHaveLength(0)
  })

  it("removes a fallback decision only after an explicit terminal event", () => {
    const pending = fixtureEvents[1]
    const running = fixtureEvents[0]
    const resolved = fixtureEvents[3]
    if (
      pending?.kind !== "pending_request" ||
      running?.kind !== "turn_status" ||
      resolved?.kind !== "pending_request_resolved"
    ) {
      throw new Error("fixture")
    }
    const store = new CodexSessionStore()
    store.apply(
      parseCodexEvent({
        ...pending,
        eventId: "event-fallback",
        sequence: 1,
        payload: {
          request: {
            pendingId: "decision-fixture",
            kind: "user_input",
            responseKind: "fallback_decision",
            operation: "decision_fallback",
            targetAlias: "active_turn",
            reason: null,
            questions: [
              {
                id: "decision",
                header: "Decision",
                question: "Continue?",
                options: [
                  { id: "option-a", label: "A", description: "First" },
                  { id: "option-b", label: "B", description: "Second" },
                ],
              },
            ],
            allowedDecisions: [],
            decisionContext: {
              schemaVersion: 1,
              category: "user_decision",
              targetKind: "active_turn",
              targetAlias: "active_turn",
              effect: "continue_turn",
              scope: "turn",
              risk: "medium",
              reversibility: "unknown",
              recommendation: null,
              evidence: ["No recommendation was supplied by the source."],
              uncertainty: "limited_context",
            },
          },
        },
      }),
    )
    store.apply({
      ...running,
      eventId: "event-source-completed",
      sequence: 2,
      payload: { ...running.payload, status: "completed" },
    })
    expect(store.snapshot().pendingRequests).toHaveLength(1)
    store.apply({
      ...resolved,
      eventId: "event-decision-expired",
      sequence: 3,
      payload: { pendingId: "decision-fixture", status: "expired" },
    })
    expect(store.snapshot().pendingRequests).toHaveLength(0)
  })
})
