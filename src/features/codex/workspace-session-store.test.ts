import { describe, expect, it } from "vitest"

import {
  parseCodexDiagnostic,
  parseCodexEvent,
  type CodexDiagnostic,
} from "@/lib/contracts"
import fixture from "@/test/fixtures/codex-runtime.v1.json"

import { CodexEventProjector } from "@/features/codex/event-projection"
import { CodexSessionStore } from "@/features/codex/session-store"
import {
  CodexWorkspaceSessionStore,
  evaluateCodexReadiness,
} from "@/features/codex/workspace-session-store"

const readyDiagnostic = parseCodexDiagnostic(fixture.diagnostic)

describe("evaluateCodexReadiness", () => {
  it("requires history, Sol, advertised reasoning, account, and core capabilities", () => {
    expect(evaluateCodexReadiness(readyDiagnostic, "ready")).toEqual({
      ready: true,
      fastServiceTier: "priority",
      supportedReasoningEfforts: [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ],
      experimentalModesAvailable: true,
      reasonCode: null,
    })
    const withoutReasoning = {
      ...readyDiagnostic,
      supportedReasoningEfforts: [],
    } satisfies CodexDiagnostic
    expect(evaluateCodexReadiness(withoutReasoning, "ready")).toMatchObject({
      ready: false,
      fastServiceTier: "priority",
      supportedReasoningEfforts: [],
      reasonCode: "CODEX-EFFORT-UNAVAILABLE",
    })
    expect(evaluateCodexReadiness(readyDiagnostic, "read_only")).toMatchObject({
      ready: false,
      reasonCode: "HIST-WRITER-NOT-READY",
    })
  })
})

describe("CodexWorkspaceSessionStore", () => {
  it("keeps an active workspace and generation isolated while projecting events", () => {
    const session = new CodexSessionStore()
    const store = new CodexWorkspaceSessionStore()
    const projector = new CodexEventProjector()
    session.activateWorkspace("workspace-fixture")
    store.beginActivation("workspace-fixture", "ready")
    store.applyDiagnostic(readyDiagnostic)
    store.markThreadReady("thread_handle_fixture", 7)

    const current = parseCodexEvent(fixture.events[0])
    expect(session.apply(current)).toBe("applied")
    store.syncSession(session.snapshot())
    const projection = projector.project(current)
    if (projection.timeline === null) throw new Error("timeline fixture")
    expect(store.applyTimeline(projection.timeline)).toBe(true)

    const other = parseCodexEvent({
      ...fixture.events[0],
      eventId: "event-other",
      workspaceId: "workspace-other",
      generation: 8,
    })
    expect(session.apply(other)).toBe("workspace_mismatch")
    const otherProjection = projector.project(other)
    if (otherProjection.timeline === null) throw new Error("timeline fixture")
    expect(store.applyTimeline(otherProjection.timeline)).toBe(false)
    expect(store.snapshot()).toMatchObject({
      activeWorkspaceId: "workspace-fixture",
      generation: 7,
      phase: "running",
      timeline: [{ workspaceId: "workspace-fixture" }],
    })
  })

  it("lets a terminal event replace stopping without treating the ack as terminal", () => {
    const session = new CodexSessionStore()
    const store = new CodexWorkspaceSessionStore()
    session.activateWorkspace("workspace-fixture")
    store.beginActivation("workspace-fixture", "ready")
    store.applyDiagnostic(readyDiagnostic)
    store.markThreadReady("thread_handle_fixture", 7)

    const running = parseCodexEvent(fixture.events[0])
    if (running.kind !== "turn_status") throw new Error("turn fixture")
    expect(session.apply(running)).toBe("applied")
    store.syncSession(session.snapshot())
    store.markStopping()
    expect(store.snapshot().phase).toBe("stopping")

    expect(
      session.apply({
        ...running,
        eventId: "event-interrupted",
        sequence: running.sequence + 1,
        payload: { ...running.payload, status: "interrupted" },
      }),
    ).toBe("applied")
    store.syncSession(session.snapshot())
    expect(store.snapshot().phase).toBe("interrupted")
  })

  it("exposes operation and history failures as the current readiness reason", () => {
    const store = new CodexWorkspaceSessionStore()
    store.beginActivation("workspace-fixture", "ready")
    store.markOperationError("CODEX-IPC-UNAVAILABLE")

    expect(store.snapshot()).toMatchObject({
      phase: "failed",
      connected: false,
      errorCode: "CODEX-IPC-UNAVAILABLE",
      readiness: {
        ready: false,
        reasonCode: "CODEX-IPC-UNAVAILABLE",
      },
    })

    store.markHistoryFailure("HIST-WRITER-NOT-READY")
    expect(store.snapshot()).toMatchObject({
      errorCode: "HIST-WRITER-NOT-READY",
      readiness: {
        ready: false,
        reasonCode: "HIST-WRITER-NOT-READY",
      },
    })
  })

  it("keeps app connectivity when only the selected workspace thread fails", () => {
    const store = new CodexWorkspaceSessionStore()
    store.beginActivation("workspace-a", "ready")
    store.applyDiagnostic(readyDiagnostic)
    store.markThreadReady("thread-a", 7)

    store.beginActivation("workspace-b", "ready")
    store.markWorkspaceThreadError("CODEX-SERVER-ERROR")

    expect(store.snapshot()).toMatchObject({
      activeWorkspaceId: "workspace-b",
      phase: "failed",
      connected: true,
      generation: null,
      errorCode: "CODEX-SERVER-ERROR",
      readiness: {
        ready: true,
        reasonCode: null,
      },
    })
  })

  it("preserves the selected workspace timeline during automatic recovery", () => {
    const store = new CodexWorkspaceSessionStore()
    const projector = new CodexEventProjector()
    store.beginActivation("workspace-fixture", "ready")
    store.applyDiagnostic(readyDiagnostic)
    store.markThreadReady("thread_handle_fixture", 7)
    const projection = projector.project(parseCodexEvent(fixture.events[0]))
    if (projection.timeline === null) throw new Error("timeline fixture")
    store.applyTimeline(projection.timeline)

    store.beginRecovery("workspace-fixture", "ready")

    expect(store.snapshot()).toMatchObject({
      activeWorkspaceId: "workspace-fixture",
      phase: "connecting",
      connected: false,
      generation: null,
      threadHandle: null,
      timeline: [{ sourceEventId: projection.timeline.sourceEventId }],
    })
  })
})
