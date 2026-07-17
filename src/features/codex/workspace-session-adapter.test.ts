import { describe, expect, it, vi } from "vitest"

import {
  codexCommands,
  parseCodexDiagnostic,
  parseCodexEvent,
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
} from "@/features/codex/workspace-session-adapter"

class FakeCodexTransport implements CodexTransport {
  readonly kind = "demo"
  readonly calls: { command: CodexCommand; request: unknown }[] = []
  diagnostic = parseCodexDiagnostic(fixture.diagnostic)
  interrupt = Promise.resolve({ accepted: true })
  turnFailure: Error | null = null
  private callbacks: CodexEventCallbacks | null = null

  request<K extends CodexCommand>(
    command: K,
    request: CodexRequestMap[K],
  ): Promise<CodexResponseMap[K]> {
    this.calls.push({ command, request })
    switch (command) {
      case codexCommands.connect:
        return Promise.resolve(this.diagnostic as CodexResponseMap[K])
      case codexCommands.threadStart:
      case codexCommands.threadResume:
        return Promise.resolve(fixture.thread as CodexResponseMap[K])
      case codexCommands.pickAttachments:
      case codexCommands.registerAttachmentPaths:
        return Promise.resolve({
          items: [],
          rejections: [],
        } as unknown as CodexResponseMap[K])
      case codexCommands.turnStart:
        if (this.turnFailure !== null) return Promise.reject(this.turnFailure)
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
      readiness: { fastAvailable: true, maxAvailable: true },
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
      attachmentHandles: [],
    })
    expect(history.events).toHaveLength(1)
    expect(history.events[0]).toMatchObject({
      eventId: "message-fixture-id",
      kind: "code.user.instruction.accepted",
      payload: { generation: 7 },
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

  it("fails closed when model/list does not provide both Fast and Max", async () => {
    const { adapter, transport } = adapterFixture()
    transport.diagnostic = {
      ...transport.diagnostic,
      maxAvailable: false,
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
      readiness: { fastAvailable: true, maxAvailable: false },
    })
    expect(transport.calls.map(({ command }) => command)).toEqual([
      codexCommands.connect,
    ])
  })

  it("persists delayed old-workspace events without mixing them into the active view", async () => {
    const { adapter, history, transport } = adapterFixture()
    await adapter.activateWorkspace({
      workspaceId: "workspace-fixture",
      historyMode: "ready",
    })
    const current = parseCodexEvent(fixture.events[0])
    transport.emit(current)
    transport.emit(
      parseCodexEvent({
        ...fixture.events[2],
        eventId: "event-old-workspace",
        workspaceId: "workspace-old",
        generation: 6,
      }),
    )
    await Promise.all([
      adapter.flushHistory("workspace-fixture"),
      adapter.flushHistory("workspace-old"),
    ])

    expect(history.events.map(({ workspaceId }) => workspaceId)).toEqual([
      "workspace-fixture",
      "workspace-old",
    ])
    expect(adapter.snapshot().timeline).toEqual([
      expect.objectContaining({ workspaceId: "workspace-fixture" }),
    ])
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
})
