import { describe, expect, it, vi } from "vitest"

import {
  CodexBoundaryError,
  DemoCodexTransport,
  TauriCodexTransport,
  type CodexEventRegistrar,
} from "@/features/codex/transport"
import { codexCommands } from "@/lib/contracts"
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
})
