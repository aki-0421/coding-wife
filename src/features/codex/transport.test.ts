import { describe, expect, it, vi } from "vitest"

import {
  CodexBoundaryError,
  DemoCodexTransport,
  TauriCodexTransport,
  type CodexEventRegistrar,
} from "@/features/codex/transport"
import { codexCommands, type CodexEvent } from "@/lib/contracts"
import fixture from "@/test/fixtures/codex-runtime.v1.json"

describe("TauriCodexTransport", () => {
  it("parses native responses and passes only the typed request", async () => {
    const invoker = vi.fn((_command, request) => {
      expect(request).toEqual({ workspaceId: "workspace-fixture" })
      return Promise.resolve(fixture.diagnostic)
    })
    const transport = new TauriCodexTransport(invoker)

    await expect(
      transport.request(codexCommands.connect, {
        workspaceId: "workspace-fixture",
      }),
    ).resolves.toEqual(fixture.diagnostic)
    expect(invoker).toHaveBeenCalledOnce()
  })

  it("normalizes malformed and raw native failures", async () => {
    const malformed = new TauriCodexTransport(() =>
      Promise.resolve({ health: "ready" }),
    )
    await expect(
      malformed.request(codexCommands.getDiagnostic, undefined),
    ).rejects.toMatchObject({
      code: "CODEX-IPC-CONTRACT-MISMATCH",
      recoverable: false,
      detailRef: "codex-runtime-v1",
    })

    const failed = new TauriCodexTransport(() =>
      Promise.reject(new Error("/Users/private token=secret")),
    )
    await expect(
      failed.request(codexCommands.probe, undefined),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "CODEX-IPC-UNAVAILABLE",
        operation: codexCommands.probe,
      }),
    )
  })

  it("quarantines malformed events without forwarding their payload", async () => {
    let nativeHandler: ((payload: unknown) => void) | null = null
    const registrar: CodexEventRegistrar = (handler) => {
      nativeHandler = handler
      return Promise.resolve(() => undefined)
    }
    const transport = new TauriCodexTransport(
      () => Promise.resolve(fixture.accepted),
      registrar,
    )
    const onEvent = vi.fn()
    const onContractError = vi.fn()
    await transport.subscribe({ onEvent, onContractError })

    if (nativeHandler === null) throw new Error("listener was not registered")
    const emit = nativeHandler as (payload: unknown) => void
    emit(fixture.events[0])
    emit({ ...fixture.events[0], schemaVersion: 99 })

    expect(onEvent).toHaveBeenCalledOnce()
    expect(onContractError).toHaveBeenCalledWith(expect.any(CodexBoundaryError))
    expect(onContractError.mock.calls[0]?.[0]).toMatchObject({
      code: "CODEX-IPC-CONTRACT-MISMATCH",
      operation: "codex_event",
    })
  })
})

describe("DemoCodexTransport", () => {
  it("emits a deterministic successful turn without support sessions", async () => {
    const transport = new DemoCodexTransport()
    const events: unknown[] = []
    await transport.subscribe({
      onEvent: (event) => events.push(event),
      onContractError: vi.fn(),
    })

    await expect(
      transport.request(codexCommands.turnStart, {
        workspaceId: "demo-workspace",
        threadHandle: "demo-thread-1",
        clientUserMessageId: "message-1",
        text: "Run the demo.",
        effort: "low",
        attachmentHandles: [],
      }),
    ).resolves.toEqual({
      threadHandle: "demo-thread-1",
      turnHandle: "demo-turn-1",
    })
    await Promise.resolve()

    expect(events).toHaveLength(3)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "agent_message_completed",
          generation: 1,
        }),
      ]),
    )
  })

  it("scripts rich activity, bounded decisions, and one-time approvals", async () => {
    vi.useFakeTimers()
    try {
      const transport = new DemoCodexTransport()
      const events: CodexEvent[] = []
      await transport.subscribe({
        onEvent: (event) => events.push(event),
        onContractError: vi.fn(),
      })

      await transport.request(codexCommands.turnStart, {
        workspaceId: "workspace-rich-demo",
        threadHandle: "demo-thread-1",
        clientUserMessageId: "message-rich",
        text: "demo:workflow",
        effort: "max",
        attachmentHandles: [],
      })
      await vi.advanceTimersByTimeAsync(600)

      expect(events.map((event) => event.kind)).toEqual([
        "turn_status",
        "plan_updated",
        "agent_message_delta",
        "agent_message_delta",
        "item_status",
        "tool_output",
        "file_change",
        "diff_updated",
        "pending_request",
      ])
      expect(
        events.every((event) => event.workspaceId === "workspace-rich-demo"),
      ).toBe(true)

      await expect(
        transport.request(codexCommands.respondPending, {
          workspaceId: "workspace-rich-demo",
          pendingId: "demo-turn-1-decision",
          response: {
            type: "user_input",
            answers: { scope: ["Keep the public API unchanged"] },
          },
        }),
      ).resolves.toEqual({ accepted: true })
      await Promise.resolve()
      expect(events.at(-1)).toMatchObject({
        kind: "pending_request",
        payload: {
          request: {
            pendingId: "demo-turn-1-approval",
            allowedDecisions: ["approve_once", "reject", "stop"],
          },
        },
      })

      await transport.request(codexCommands.respondPending, {
        workspaceId: "workspace-rich-demo",
        pendingId: "demo-turn-1-approval",
        response: { type: "approval", decision: "approve_once" },
      })
      await Promise.resolve()
      expect(events.at(-1)).toMatchObject({
        kind: "turn_status",
        payload: { status: "completed" },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("blocks unknown requests, interrupts crashes, and returns opaque demo attachments", async () => {
    vi.useFakeTimers()
    try {
      const transport = new DemoCodexTransport()
      const events: CodexEvent[] = []
      await transport.subscribe({
        onEvent: (event) => events.push(event),
        onContractError: vi.fn(),
      })

      const attachment = await transport.request(
        codexCommands.pickAttachments,
        { workspaceId: "workspace-demo", existingHandles: [] },
      )
      expect(attachment.items[0]).toMatchObject({
        handle: "attachment-00000000-0000-4000-8000-000000000001",
        relativePath: "attachments/demo-evidence.md",
      })
      expect(JSON.stringify(attachment)).not.toMatch(/\/Users\//u)

      await transport.request(codexCommands.turnStart, {
        workspaceId: "workspace-demo",
        threadHandle: "demo-thread-1",
        clientUserMessageId: "message-unknown",
        text: "demo:unknown",
        effort: "low",
        attachmentHandles: [],
      })
      await vi.advanceTimersByTimeAsync(300)
      expect(
        events.some((event) => event.kind === "protocol_unsupported"),
      ).toBe(true)
      expect(
        events.some(
          (event) =>
            event.kind === "turn_status" &&
            event.payload.status === "interrupted",
        ),
      ).toBe(true)
      expect(events.some((event) => event.kind === "pending_request")).toBe(
        false,
      )

      const beforeCrash = events.length
      await transport.request(codexCommands.turnStart, {
        workspaceId: "workspace-demo",
        threadHandle: "demo-thread-1",
        clientUserMessageId: "message-crash",
        text: "demo:crash",
        effort: "low",
        attachmentHandles: [],
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(
        events
          .slice(beforeCrash)
          .filter((event) => event.kind === "turn_status"),
      ).toHaveLength(2)
      const diagnostic = events
        .slice(beforeCrash)
        .find((event) => event.kind === "diagnostic")
      expect(diagnostic).toMatchObject({
        kind: "diagnostic",
        payload: {
          code: "CODEX-APP-SERVER-EXITED",
          willRetry: false,
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
