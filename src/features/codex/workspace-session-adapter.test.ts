import { describe, expect, it, vi } from "vitest"

import {
  codexCommands,
  parseCodexDiagnostic,
  parseCodexEvent,
  parseThreadResponse,
  type CodexCommand,
  type CodexEvent,
  type CodexRequestMap,
  type CodexResponseMap,
} from "@/lib/contracts"
import fixture from "@/test/fixtures/codex-runtime.v1.json"

import type { CodexHistoryEvent } from "@/features/codex/event-projection"
import type {
  CodexEventCallbacks,
  CodexTransport,
} from "@/features/codex/transport"
import {
  CodexWorkspaceSessionAdapter,
  type CodexHistorySink,
  type CodexSessionClock,
  type CodexTurnLifecycleSink,
} from "@/features/codex/workspace-session-adapter"

const threadFixture = parseThreadResponse(fixture.thread)

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class FakeCodexTransport implements CodexTransport {
  readonly kind = "demo"
  readonly calls: { command: CodexCommand; request: unknown }[] = []
  diagnostic = parseCodexDiagnostic(fixture.diagnostic)
  interrupt = Promise.resolve({ accepted: true })
  turnResponse: Promise<CodexResponseMap["codex_turn_start"]> | null = null
  subscribeFailure: (Error & { readonly code?: string }) | null = null
  readonly connectResponses = new Map<
    string,
    Promise<CodexResponseMap["codex_connect"]>
  >()
  readonly threadResponses = new Map<
    string,
    Promise<CodexResponseMap["codex_thread_start"]>
  >()
  turnFailure: Error | null = null
  private callbacks: CodexEventCallbacks | null = null

  request<K extends CodexCommand>(
    command: K,
    request: CodexRequestMap[K],
  ): Promise<CodexResponseMap[K]> {
    this.calls.push({ command, request })
    switch (command) {
      case codexCommands.connect:
        return (this.connectResponses.get(
          (request as CodexRequestMap["codex_connect"]).workspaceId,
        ) ?? Promise.resolve(this.diagnostic)) as Promise<CodexResponseMap[K]>
      case codexCommands.threadStart:
      case codexCommands.threadResume:
        return (this.threadResponses.get(
          (
            request as
              | CodexRequestMap["codex_thread_start"]
              | CodexRequestMap["codex_thread_resume"]
          ).workspaceId,
        ) ?? Promise.resolve(threadFixture)) as Promise<CodexResponseMap[K]>
      case codexCommands.pickAttachments:
      case codexCommands.registerAttachmentPaths:
        return Promise.resolve({
          items: [],
          rejections: [],
        } as unknown as CodexResponseMap[K])
      case codexCommands.turnStart:
        if (this.turnFailure !== null) return Promise.reject(this.turnFailure)
        if (this.turnResponse !== null) {
          return this.turnResponse as Promise<CodexResponseMap[K]>
        }
        return Promise.resolve(fixture.turn as CodexResponseMap[K])
      case codexCommands.turnInterrupt:
        return this.interrupt as Promise<CodexResponseMap[K]>
      case codexCommands.respondPending:
        return Promise.resolve(fixture.accepted as CodexResponseMap[K])
      case codexCommands.answerFallbackDecision:
        return Promise.resolve(fixture.turn as CodexResponseMap[K])
      default:
        throw new Error(`Unexpected command ${command}`)
    }
  }

  subscribe(callbacks: CodexEventCallbacks): Promise<() => void> {
    if (this.subscribeFailure !== null) {
      return Promise.reject(this.subscribeFailure)
    }
    this.callbacks = callbacks
    return Promise.resolve(() => {
      this.callbacks = null
    })
  }

  emit(event: CodexEvent): void {
    this.callbacks?.onEvent(event)
  }
}

class MemoryHistorySink implements CodexHistorySink {
  readonly events: CodexHistoryEvent[] = []

  append(event: CodexHistoryEvent): Promise<void> {
    this.events.push(event)
    return Promise.resolve()
  }
}

function adapterFixture(
  options: {
    readonly clock?: CodexSessionClock
    readonly turnLifecycleSink?: CodexTurnLifecycleSink
  } = {},
) {
  const transport = new FakeCodexTransport()
  const history = new MemoryHistorySink()
  const adapter = new CodexWorkspaceSessionAdapter(transport, history, {
    createId: () => "fixture-id",
    ...options,
  })
  return { adapter, history, transport }
}

describe("CodexWorkspaceSessionAdapter", () => {
  it("records event subscription failures against the activating workspace", async () => {
    const { adapter, transport } = adapterFixture()
    transport.subscribeFailure = Object.assign(
      new Error("CODEX-IPC-UNAVAILABLE"),
      { code: "CODEX-IPC-UNAVAILABLE" },
    )

    await expect(
      adapter.activateWorkspace({
        workspaceId: "workspace-fixture",
        historyMode: "ready",
      }),
    ).rejects.toMatchObject({ code: "CODEX-IPC-UNAVAILABLE" })
    expect(adapter.snapshot()).toMatchObject({
      activeWorkspaceId: "workspace-fixture",
      phase: "failed",
      connected: false,
      errorCode: "CODEX-IPC-UNAVAILABLE",
      readiness: {
        ready: false,
        reasonCode: "CODEX-IPC-UNAVAILABLE",
      },
    })
    expect(transport.calls).toEqual([])
  })

  it("connects an opaque workspace, starts a thread, and accepts one turn before clear", async () => {
    const { adapter, history, transport } = adapterFixture()
    await expect(
      adapter.activateWorkspace({
        workspaceId: "workspace-fixture",
        historyMode: "ready",
      }),
    ).resolves.toMatchObject({
      activeWorkspaceId: "workspace-fixture",
      connected: true,
      phase: "ready",
      readiness: {
        fastServiceTier: "priority",
        supportedReasoningEfforts: expect.arrayContaining(["low", "max"]),
        experimentalModesAvailable: true,
      },
    })

    await expect(
      adapter.sendTurn({
        workspaceId: "workspace-fixture",
        text: "Run the focused tests.",
        effort: "max",
        attachmentHandles: [],
      }),
    ).resolves.toEqual({
      accepted: true,
      clientUserMessageId: "message-fixture-id",
      turnHandle: "turn_handle_fixture",
    })
    await adapter.flushHistory("workspace-fixture")

    expect(transport.calls.map(({ command }) => command)).toEqual([
      codexCommands.connect,
      codexCommands.threadStart,
      codexCommands.turnStart,
    ])
    expect(transport.calls[2]?.request).toEqual({
      workspaceId: "workspace-fixture",
      threadHandle: "thread_handle_fixture",
      clientUserMessageId: "message-fixture-id",
      text: "Run the focused tests.",
      effort: "max",
      serviceTier: null,
      planMode: false,
      goalObjective: null,
      attachmentHandles: [],
    })
    expect(history.events).toHaveLength(1)
    expect(history.events[0]).toMatchObject({
      eventId: "message-fixture-id",
      kind: "code.user.instruction.accepted",
      payload: { generation: 7 },
    })
  })

  it("sends reasoning, Fast, Plan, and Goals as independent turn controls", async () => {
    const { adapter, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })

    await adapter.sendTurn({
      workspaceId: "workspace-fixture",
      text: "Deliver the bounded release task.",
      effort: "high",
      serviceTier: "priority",
      planMode: true,
      goalObjective: "Deliver the bounded release task.",
      attachmentHandles: [],
    })

    expect(transport.calls.at(-1)?.request).toMatchObject({
      effort: "high",
      serviceTier: "priority",
      planMode: true,
      goalObjective: "Deliver the bounded release task.",
    })
  })

  it("bounds turn text by Unicode scalar values", async () => {
    const oversized = adapterFixture()
    await oversized.adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    await expect(
      oversized.adapter.sendTurn({
        workspaceId: "workspace-fixture",
        text: "😀".repeat(32_001),
        effort: "low",
        attachmentHandles: [],
      }),
    ).rejects.toThrow("CODEX-TURN-PREFLIGHT-BLOCKED")

    const exact = adapterFixture()
    await exact.adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    await expect(
      exact.adapter.sendTurn({
        workspaceId: "workspace-fixture",
        text: "😀".repeat(32_000),
        effort: "low",
        attachmentHandles: [],
      }),
    ).resolves.toMatchObject({ accepted: true })
  })

  it("keeps the composed 80,000 scalar boundary independent from public text", async () => {
    const exact = adapterFixture()
    await exact.adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    await expect(
      exact.adapter.sendTurn({
        workspaceId: "workspace-fixture",
        text: "😀".repeat(80_000),
        publicText: "Run it.",
        effort: "low",
        attachmentHandles: [],
      }),
    ).resolves.toMatchObject({ accepted: true })

    const oversized = adapterFixture()
    await oversized.adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    await expect(
      oversized.adapter.sendTurn({
        workspaceId: "workspace-fixture",
        text: "😀".repeat(80_001),
        publicText: "Run it.",
        effort: "low",
        attachmentHandles: [],
      }),
    ).rejects.toThrow("CODEX-TURN-PREFLIGHT-BLOCKED")
  })

  it("rejects unsafe controls in public and composed turn text before transport", async () => {
    for (const [text, publicText] of [
      ["safe composed text", "unsafe\0instruction"],
      ["unsafe\u0007composed text", "safe instruction"],
      ["unsafe\rcomposed text", "safe instruction"],
      ["unsafe\u0085composed text", "safe instruction"],
    ] as const) {
      const fixture = adapterFixture()
      await fixture.adapter.activateWorkspace({
        workspaceId: "workspace-fixture",
        historyMode: "ready",
      })
      await expect(
        fixture.adapter.sendTurn({
          workspaceId: "workspace-fixture",
          text,
          publicText,
          effort: "low",
          attachmentHandles: [],
        }),
      ).rejects.toThrow("CODEX-TURN-PREFLIGHT-BLOCKED")
      expect(
        fixture.transport.calls.some(
          ({ command }) => command === codexCommands.turnStart,
        ),
      ).toBe(false)
    }

    const normalized = adapterFixture()
    await normalized.adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    await expect(
      normalized.adapter.sendTurn({
        workspaceId: "workspace-fixture",
        text: "first line\n\tsecond line",
        effort: "low",
        attachmentHandles: [],
      }),
    ).resolves.toMatchObject({ accepted: true })
  })

  it("emits one authoritative terminal work-unit event for a completed owned turn", async () => {
    const recordTerminal = vi.fn()
    const { adapter, transport } = adapterFixture({
      turnLifecycleSink: { recordTerminal },
    })
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    await adapter.sendTurn({
      workspaceId: "workspace-fixture",
      text: "Create the reviewable change.",
      effort: "max",
      attachmentHandles: [],
    })
    const running = parseCodexEvent(fixture.events[0])
    if (running.kind !== "turn_status") throw new Error("turn fixture")
    const completed: CodexEvent = {
      ...running,
      eventId: "event-owned-completed",
      payload: { ...running.payload, status: "completed" },
    }

    transport.emit(completed)
    transport.emit(completed)

    expect(recordTerminal).toHaveBeenCalledTimes(1)
    expect(recordTerminal).toHaveBeenCalledWith({
      schemaVersion: 1,
      workUnitId: "message-fixture-id",
      workspaceId: "workspace-fixture",
      generation: 7,
      threadHandle: fixture.thread.threadHandle,
      turnHandle: fixture.turn.turnHandle,
      terminalStatus: "completed",
      sourceEventId: "event-owned-completed",
      sourceSequence: 1,
      occurredAt: running.occurredAt,
      objective: "Create the reviewable change.",
      effort: "max",
      attachmentCount: 0,
    })
  })

  it("reuses only the thread handle this composition owns", async () => {
    const { adapter, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })

    expect(transport.calls.map(({ command }) => command)).toEqual([
      codexCommands.connect,
      codexCommands.threadStart,
      codexCommands.connect,
      codexCommands.threadResume,
    ])
    expect(transport.calls.at(-1)?.request).toEqual({
      workspaceId: "workspace-fixture",
      threadHandle: "thread_handle_fixture",
    })
  })

  it("accepts an attachment-only turn and records only safe attachment metadata", async () => {
    const { adapter, history, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    const attachmentHandle = "attachment-00000000-0000-4000-8000-000000000001"

    await adapter.sendTurn({
      workspaceId: "workspace-fixture",
      text: "",
      effort: "low",
      attachmentHandles: [attachmentHandle],
    })
    await adapter.flushHistory("workspace-fixture")

    expect(transport.calls.at(-1)).toEqual({
      command: codexCommands.turnStart,
      request: {
        workspaceId: "workspace-fixture",
        threadHandle: "thread_handle_fixture",
        clientUserMessageId: "message-fixture-id",
        text: "",
        effort: "low",
        serviceTier: null,
        planMode: false,
        goalObjective: null,
        attachmentHandles: [attachmentHandle],
      },
    })
    expect(history.events.at(-1)).toMatchObject({
      kind: "code.user.instruction.accepted",
      payload: { text: "", attachmentCount: 1 },
    })
    expect(JSON.stringify(history.events)).not.toContain(attachmentHandle)
  })

  it("routes picker, drop, and paste candidates through typed native commands", async () => {
    const { adapter, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })

    await adapter.pickAttachments("workspace-fixture", [])
    await adapter.registerAttachmentPaths(
      "workspace-fixture",
      "drop",
      ["/workspace-fixture/notes.txt"],
      [],
    )
    await adapter.registerAttachmentPaths(
      "workspace-fixture",
      "paste",
      ["/workspace-fixture/demo.png"],
      [],
    )

    expect(transport.calls.slice(-3)).toEqual([
      {
        command: codexCommands.pickAttachments,
        request: { workspaceId: "workspace-fixture", existingHandles: [] },
      },
      {
        command: codexCommands.registerAttachmentPaths,
        request: {
          workspaceId: "workspace-fixture",
          source: "drop",
          paths: ["/workspace-fixture/notes.txt"],
          existingHandles: [],
        },
      },
      {
        command: codexCommands.registerAttachmentPaths,
        request: {
          workspaceId: "workspace-fixture",
          source: "paste",
          paths: ["/workspace-fixture/demo.png"],
          existingHandles: [],
        },
      },
    ])
  })

  it("supports an explicitly owned resume handle without adopting a listed thread", async () => {
    const { adapter, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
      resumeThreadHandle: "thread_handle_fixture",
    })

    expect(transport.calls.map(({ command }) => command)).toEqual([
      codexCommands.connect,
      codexCommands.threadResume,
    ])
    expect(transport.calls[1]?.request).toEqual({
      workspaceId: "workspace-fixture",
      threadHandle: "thread_handle_fixture",
    })
  })

  it("fails closed when model/list does not provide reasoning levels", async () => {
    const { adapter, transport } = adapterFixture()
    transport.diagnostic = {
      ...transport.diagnostic,
      supportedReasoningEfforts: [],
      health: "effort_unavailable",
      errorCode: "CODEX-EFFORT-UNAVAILABLE",
    }

    await expect(
      adapter.activateWorkspace({
        workspaceId: "workspace-fixture",
        historyMode: "ready",
      }),
    ).resolves.toMatchObject({
      connected: false,
      phase: "blocked",
      errorCode: "CODEX-EFFORT-UNAVAILABLE",
      readiness: {
        fastServiceTier: "priority",
        supportedReasoningEfforts: [],
      },
    })
    expect(transport.calls.map(({ command }) => command)).toEqual([
      codexCommands.connect,
    ])
  })

  it("interrupts an accepted stale turn without mutating the newly active workspace", async () => {
    const recordTerminal = vi.fn()
    const { adapter, history, transport } = adapterFixture({
      turnLifecycleSink: { recordTerminal },
    })
    await adapter.activateWorkspace({
      workspaceId: "workspace-a",
      historyMode: "ready",
    })
    const pendingTurn = deferred<CodexResponseMap["codex_turn_start"]>()
    transport.turnResponse = pendingTurn.promise

    const sending = adapter.sendTurn({
      workspaceId: "workspace-a",
      text: "Run the old workspace task.",
      effort: "low",
      attachmentHandles: [],
    })
    await vi.waitFor(() =>
      expect(transport.calls.at(-1)?.command).toBe(codexCommands.turnStart),
    )
    transport.threadResponses.set(
      "workspace-b",
      Promise.resolve({
        ...threadFixture,
        threadHandle: "thread-handle-b",
        generation: 8,
      }),
    )
    await adapter.activateWorkspace({
      workspaceId: "workspace-b",
      historyMode: "ready",
    })

    pendingTurn.resolve(fixture.turn)
    await expect(sending).rejects.toMatchObject({
      code: "CODEX-WORKSPACE-SWITCHED",
    })
    await adapter.flushHistory("workspace-a")

    expect(adapter.snapshot()).toMatchObject({
      activeWorkspaceId: "workspace-b",
      phase: "ready",
      connected: true,
      threadHandle: "thread-handle-b",
      generation: 8,
      errorCode: null,
      timeline: [],
    })
    expect(transport.calls.at(-1)).toEqual({
      command: codexCommands.turnInterrupt,
      request: {
        workspaceId: "workspace-a",
        threadHandle: fixture.thread.threadHandle,
        turnHandle: fixture.turn.turnHandle,
      },
    })
    expect(history.events).toEqual([
      expect.objectContaining({
        workspaceId: "workspace-a",
        kind: "code.user.instruction.accepted",
      }),
    ])
    await expect(
      adapter.sendTurn({
        workspaceId: "workspace-b",
        text: "Must wait for the old terminal event.",
        effort: "low",
        attachmentHandles: [],
      }),
    ).rejects.toThrow("CODEX-TURN-PREFLIGHT-BLOCKED")

    const oldRunning = parseCodexEvent(fixture.events[0])
    if (oldRunning.kind !== "turn_status") throw new Error("turn fixture")
    transport.emit({
      ...oldRunning,
      eventId: "event-old-turn-terminal",
      workspaceId: "workspace-a",
      sequence: 2,
      payload: { ...oldRunning.payload, status: "interrupted" },
    })
    expect(recordTerminal).toHaveBeenCalledTimes(1)
    expect(recordTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 1,
        workUnitId: "message-fixture-id",
        workspaceId: "workspace-a",
        generation: 7,
        threadHandle: fixture.thread.threadHandle,
        turnHandle: fixture.turn.turnHandle,
        terminalStatus: "interrupted",
        sourceEventId: "event-old-turn-terminal",
        objective: "Run the old workspace task.",
        effort: "low",
        attachmentCount: 0,
      }),
    )
    transport.turnResponse = null

    await expect(
      adapter.sendTurn({
        workspaceId: "workspace-b",
        text: "Start only after terminal ownership is recorded.",
        effort: "low",
        attachmentHandles: [],
      }),
    ).resolves.toMatchObject({ accepted: true })
    expect(adapter.snapshot()).toMatchObject({
      activeWorkspaceId: "workspace-b",
      phase: "running",
      errorCode: null,
    })
  })

  it("ignores a stale turn/start error after switching workspaces", async () => {
    const { adapter, history, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-a",
      historyMode: "ready",
    })
    const pendingTurn = deferred<CodexResponseMap["codex_turn_start"]>()
    transport.turnResponse = pendingTurn.promise
    const sending = adapter.sendTurn({
      workspaceId: "workspace-a",
      text: "This request will fail late.",
      effort: "max",
      attachmentHandles: [],
    })
    await vi.waitFor(() =>
      expect(transport.calls.at(-1)?.command).toBe(codexCommands.turnStart),
    )
    await adapter.activateWorkspace({
      workspaceId: "workspace-b",
      historyMode: "ready",
    })

    pendingTurn.reject(
      Object.assign(new Error("late failure"), {
        code: "CODEX-OLD-TURN-REJECTED",
      }),
    )
    await expect(sending).rejects.toMatchObject({
      code: "CODEX-OLD-TURN-REJECTED",
    })

    expect(adapter.snapshot()).toMatchObject({
      activeWorkspaceId: "workspace-b",
      phase: "ready",
      connected: true,
      errorCode: null,
    })
    expect(history.events).toEqual([])
    expect(
      transport.calls.filter(
        ({ command }) => command === codexCommands.turnInterrupt,
      ),
    ).toEqual([])
  })

  it("keeps the last of two rapid workspace switches authoritative", async () => {
    const { adapter, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-a",
      historyMode: "ready",
    })
    const delayedConnect = deferred<CodexResponseMap["codex_connect"]>()
    transport.connectResponses.set("workspace-b", delayedConnect.promise)
    const switchingToB = adapter.activateWorkspace({
      workspaceId: "workspace-b",
      historyMode: "ready",
    })
    await vi.waitFor(() =>
      expect(transport.calls).toContainEqual({
        command: codexCommands.connect,
        request: { workspaceId: "workspace-b" },
      }),
    )
    await adapter.activateWorkspace({
      workspaceId: "workspace-c",
      historyMode: "ready",
    })
    transport.threadResponses.set(
      "workspace-d",
      Promise.resolve({
        ...threadFixture,
        threadHandle: "thread-handle-d",
        generation: 10,
      }),
    )
    await adapter.activateWorkspace({
      workspaceId: "workspace-d",
      historyMode: "ready",
    })
    delayedConnect.resolve(transport.diagnostic)
    await switchingToB

    expect(adapter.snapshot()).toMatchObject({
      activeWorkspaceId: "workspace-d",
      phase: "ready",
      connected: true,
      threadHandle: "thread-handle-d",
      generation: 10,
      errorCode: null,
    })
  })

  it("persists delayed old-workspace events without mixing them into the active view", async () => {
    const { adapter, history, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-a",
      historyMode: "ready",
    })
    const current = parseCodexEvent(fixture.events[0])
    transport.emit({ ...current, workspaceId: "workspace-a" })
    await adapter.activateWorkspace({
      workspaceId: "workspace-b",
      historyMode: "ready",
    })
    transport.emit(
      parseCodexEvent({
        ...fixture.events[2],
        eventId: "event-old-workspace",
        workspaceId: "workspace-a",
      }),
    )
    await Promise.all([
      adapter.flushHistory("workspace-a"),
      adapter.flushHistory("workspace-b"),
    ])

    expect(history.events.map(({ workspaceId }) => workspaceId)).toEqual([
      "workspace-a",
      "workspace-a",
    ])
    expect(adapter.snapshot()).toMatchObject({
      activeWorkspaceId: "workspace-b",
      phase: "ready",
      timeline: [],
      errorCode: null,
    })
    expect(adapter.sessionStore.snapshot()).toMatchObject({
      workspaceId: "workspace-b",
      events: [],
    })
  })

  it("does not accept or persist a user instruction when turn/start fails", async () => {
    const { adapter, history, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    transport.turnFailure = Object.assign(new Error("rejected"), {
      code: "CODEX-TURN-REJECTED",
    })

    await expect(
      adapter.sendTurn({
        workspaceId: "workspace-fixture",
        text: "Keep this draft.",
        effort: "low",
        attachmentHandles: [],
      }),
    ).rejects.toMatchObject({ code: "CODEX-TURN-REJECTED" })
    await adapter.flushHistory("workspace-fixture")
    expect(history.events).toEqual([])
    expect(adapter.snapshot()).toMatchObject({
      connected: true,
      errorCode: "CODEX-TURN-REJECTED",
    })
  })

  it("sends interrupt immediately and reports the five-second ack boundary", async () => {
    let timeoutCallback: (() => void) | null = null
    const clock: CodexSessionClock = {
      now: () => "2026-07-18T00:00:00Z",
      setTimeout: (callback) => {
        timeoutCallback = callback
        return 1
      },
      clearTimeout: vi.fn(),
    }
    const { adapter, transport } = adapterFixture({ clock })
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    await adapter.sendTurn({
      workspaceId: "workspace-fixture",
      text: "Run until stopped.",
      effort: "low",
      attachmentHandles: [],
    })
    transport.interrupt = new Promise(() => undefined)

    const stopping = adapter.stopTurn("workspace-fixture")
    expect(transport.calls.at(-1)?.command).toBe(codexCommands.turnInterrupt)
    expect(adapter.snapshot().phase).toBe("stopping")
    if (timeoutCallback === null) throw new Error("timeout was not scheduled")
    ;(timeoutCallback as () => void)()

    await expect(stopping).rejects.toMatchObject({
      code: "CODEX-INTERRUPT-ACK-TIMEOUT",
    })
    expect(adapter.snapshot()).toMatchObject({
      phase: "failed",
      connected: true,
      errorCode: "CODEX-INTERRUPT-ACK-TIMEOUT",
    })
  })

  it("keeps stopping after an ack until the terminal event arrives", async () => {
    const { adapter, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    await adapter.sendTurn({
      workspaceId: "workspace-fixture",
      text: "Stop at the boundary.",
      effort: "low",
      attachmentHandles: [],
    })

    await adapter.stopTurn("workspace-fixture")
    expect(adapter.snapshot().phase).toBe("stopping")
    const running = parseCodexEvent(fixture.events[0])
    if (running.kind !== "turn_status") throw new Error("turn fixture")
    transport.emit({
      ...running,
      eventId: "event-interrupted",
      payload: { ...running.payload, status: "interrupted" },
    })

    expect(adapter.snapshot().phase).toBe("interrupted")
  })

  it("waits for the exact terminal event and pending-request cleanup before returning", async () => {
    const { adapter, history, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    await adapter.sendTurn({
      workspaceId: "workspace-fixture",
      text: "Stop only at the owned terminal boundary.",
      effort: "low",
      attachmentHandles: [],
    })
    const running = parseCodexEvent(fixture.events[0])
    const pending = parseCodexEvent(fixture.events[1])
    if (running.kind !== "turn_status" || pending.kind !== "pending_request") {
      throw new Error("turn fixtures")
    }
    transport.emit(running)
    transport.emit(pending)

    let settled = false
    const stopping = adapter
      .stopTurnAndWaitForTerminal({
        workspaceId: "workspace-fixture",
        expectedGeneration: 7,
      })
      .then(() => {
        settled = true
      })
    await vi.waitFor(() =>
      expect(transport.calls.at(-1)?.command).toBe(codexCommands.turnInterrupt),
    )
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(adapter.snapshot()).toMatchObject({
      activeWorkspaceId: "workspace-fixture",
      phase: "stopping",
      pendingRequests: [
        expect.objectContaining({ pendingId: "pending_handle_fixture" }),
      ],
    })

    transport.emit({
      ...running,
      eventId: "event-exact-terminal",
      sequence: 3,
      payload: { ...running.payload, status: "interrupted" },
    })
    await stopping

    expect(adapter.snapshot()).toMatchObject({
      activeWorkspaceId: "workspace-fixture",
      generation: 7,
      threadHandle: fixture.thread.threadHandle,
      turnHandle: fixture.turn.turnHandle,
      phase: "interrupted",
      pendingRequests: [],
    })
    expect(adapter.sessionStore.snapshot()).toMatchObject({
      workspaceId: "workspace-fixture",
      generation: 7,
      activeThreadHandle: fixture.thread.threadHandle,
      activeTurnHandle: fixture.turn.turnHandle,
      turnStatus: "interrupted",
      pendingRequests: [],
    })
    expect(history.events.at(-1)).toMatchObject({
      eventId: "event-exact-terminal",
      kind: "code.session.status.changed",
      payload: { status: "interrupted" },
    })
  })

  it("keeps a completed source fallback available until an explicit transition", async () => {
    const { adapter, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    await adapter.sendTurn({
      workspaceId: "workspace-fixture",
      text: "Offer a bounded continuation.",
      effort: "low",
      attachmentHandles: [],
    })
    const running = parseCodexEvent(fixture.events[0])
    const pending = parseCodexEvent(fixture.events[1])
    if (running.kind !== "turn_status" || pending.kind !== "pending_request") {
      throw new Error("turn fixtures")
    }
    const fallback = parseCodexEvent({
      ...pending,
      eventId: "event-transition-fallback",
      payload: {
        request: {
          pendingId: "decision-transition",
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
    transport.emit(running)
    transport.emit(fallback)
    transport.emit({
      ...running,
      eventId: "event-transition-source-completed",
      sequence: fallback.sequence + 1,
      payload: { ...running.payload, status: "completed" },
    })

    expect(adapter.sessionStore.snapshot()).toMatchObject({
      turnStatus: "completed",
      pendingRequests: [
        expect.objectContaining({ pendingId: "decision-transition" }),
      ],
    })
    const interruptsBefore = transport.calls.filter(
      ({ command }) => command === codexCommands.turnInterrupt,
    ).length
    await expect(
      adapter.stopTurnAndWaitForTerminal({
        workspaceId: "workspace-fixture",
        expectedGeneration: 7,
      }),
    ).resolves.toBeUndefined()
    expect(
      transport.calls.filter(
        ({ command }) => command === codexCommands.turnInterrupt,
      ),
    ).toHaveLength(interruptsBefore)

    await adapter.activateWorkspace({
      workspaceId: "workspace-other",
      historyMode: "ready",
    })
    expect(adapter.sessionStore.snapshot()).toMatchObject({
      workspaceId: "workspace-other",
      pendingRequests: [],
    })
    await expect(
      adapter.answerFallbackDecision({
        workspaceId: "workspace-fixture",
        decisionHandle: "decision-transition",
        optionId: "option-yes",
      }),
    ).resolves.toBe(false)
    expect(
      transport.calls.filter(
        ({ command }) => command === codexCommands.answerFallbackDecision,
      ),
    ).toHaveLength(0)
  })

  it("waits for an in-flight turn start before interrupting its accepted identity", async () => {
    const { adapter, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    const pendingTurn = deferred<CodexResponseMap["codex_turn_start"]>()
    transport.turnResponse = pendingTurn.promise
    const sending = adapter.sendTurn({
      workspaceId: "workspace-fixture",
      text: "Accept this turn before stopping it.",
      effort: "max",
      attachmentHandles: [],
    })
    await vi.waitFor(() =>
      expect(transport.calls.at(-1)?.command).toBe(codexCommands.turnStart),
    )

    const stopping = adapter.stopTurnAndWaitForTerminal({
      workspaceId: "workspace-fixture",
      expectedGeneration: 7,
    })
    expect(
      transport.calls.some(
        ({ command }) => command === codexCommands.turnInterrupt,
      ),
    ).toBe(false)

    pendingTurn.resolve(fixture.turn)
    await expect(sending).resolves.toMatchObject({ accepted: true })
    await vi.waitFor(() =>
      expect(transport.calls.at(-1)).toEqual({
        command: codexCommands.turnInterrupt,
        request: {
          workspaceId: "workspace-fixture",
          threadHandle: fixture.thread.threadHandle,
          turnHandle: fixture.turn.turnHandle,
        },
      }),
    )
    const running = parseCodexEvent(fixture.events[0])
    if (running.kind !== "turn_status") throw new Error("turn fixture")
    transport.emit({
      ...running,
      eventId: "event-pending-start-terminal",
      payload: { ...running.payload, status: "interrupted" },
    })

    await expect(stopping).resolves.toBeUndefined()
    expect(adapter.snapshot()).toMatchObject({
      phase: "interrupted",
      turnHandle: fixture.turn.turnHandle,
    })
  })

  it("rejects a stale generation without interrupting any turn", async () => {
    const { adapter, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    await adapter.sendTurn({
      workspaceId: "workspace-fixture",
      text: "Keep the current generation active.",
      effort: "low",
      attachmentHandles: [],
    })

    await expect(
      adapter.stopTurnAndWaitForTerminal({
        workspaceId: "workspace-fixture",
        expectedGeneration: 8,
      }),
    ).rejects.toMatchObject({ code: "CODEX-TURN-IDENTITY-STALE" })
    expect(
      transport.calls.filter(
        ({ command }) => command === codexCommands.turnInterrupt,
      ),
    ).toHaveLength(0)
    expect(adapter.snapshot()).toMatchObject({
      activeWorkspaceId: "workspace-fixture",
      generation: 7,
      phase: "running",
    })
  })

  it("fails closed if a different turn becomes active before terminalization", async () => {
    const { adapter, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    await adapter.sendTurn({
      workspaceId: "workspace-fixture",
      text: "Stop only this exact turn.",
      effort: "low",
      attachmentHandles: [],
    })
    const running = parseCodexEvent(fixture.events[0])
    if (running.kind !== "turn_status") throw new Error("turn fixture")
    transport.emit(running)
    const stopping = adapter.stopTurnAndWaitForTerminal({
      workspaceId: "workspace-fixture",
      expectedGeneration: 7,
    })
    await vi.waitFor(() =>
      expect(transport.calls.at(-1)?.command).toBe(codexCommands.turnInterrupt),
    )

    transport.emit({
      ...running,
      eventId: "event-different-turn-terminal",
      sequence: 2,
      payload: {
        ...running.payload,
        turnHandle: "turn_handle_different",
        status: "interrupted",
      },
    })

    await expect(stopping).rejects.toMatchObject({
      code: "CODEX-TURN-IDENTITY-CHANGED",
    })
  })
})
