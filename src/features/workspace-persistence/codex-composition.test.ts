import { describe, expect, it, vi } from "vitest"

import {
  codexCommands,
  parseCodexDiagnostic,
  type CodexCommand,
  type CodexEvent,
  type CodexRequestMap,
  type CodexResponseMap,
} from "@/lib/contracts"
import fixture from "@/test/fixtures/codex-runtime.v1.json"

import {
  DemoCodexTransport,
  type CodexEventCallbacks,
  type CodexTransport,
} from "@/features/codex"
import { CodexComposedWorkspaceViewAdapter } from "@/features/workspace-persistence/codex-composition"
import { DemoWorkspaceHistoryTransport } from "@/features/workspace-persistence/demo-transport"

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

class CompositionCodexTransport implements CodexTransport {
  readonly kind = "demo"
  readonly calls: {
    readonly command: CodexCommand
    readonly request: unknown
  }[] = []
  private callbacks: CodexEventCallbacks | null = null

  request<K extends CodexCommand>(
    command: K,
    request: CodexRequestMap[K],
  ): Promise<CodexResponseMap[K]> {
    this.calls.push({ command, request })
    switch (command) {
      case codexCommands.connect:
        return Promise.resolve(
          parseCodexDiagnostic(fixture.diagnostic) as CodexResponseMap[K],
        )
      case codexCommands.threadStart:
      case codexCommands.threadResume:
        return Promise.resolve(fixture.thread as CodexResponseMap[K])
      case codexCommands.turnStart:
        return Promise.resolve(fixture.turn as CodexResponseMap[K])
      case codexCommands.pickAttachments:
        return Promise.resolve({
          items: [
            {
              schemaVersion: 1,
              handle: "attachment-550e8400-e29b-41d4-a716-446655440000",
              name: "notes.txt",
              relativePath: "notes.txt",
              sizeBytes: 12,
              kind: "file",
              source: "picker",
              expiresAt: "2026-07-18T00:30:00.000Z",
            },
          ],
          rejections: [],
        } as unknown as CodexResponseMap[K])
      case codexCommands.registerAttachmentPaths:
        return Promise.resolve({
          items: [],
          rejections: [],
        } as unknown as CodexResponseMap[K])
      case codexCommands.turnInterrupt:
      case codexCommands.respondPending:
        return Promise.resolve({ accepted: true } as CodexResponseMap[K])
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

describe("CodexComposedWorkspaceViewAdapter", () => {
  it("activates the selected workspace and composes send, attachment, live, and HIST state", async () => {
    const history = new DemoWorkspaceHistoryTransport()
    const codex = new CompositionCodexTransport()
    const adapter = new CodexComposedWorkspaceViewAdapter(history, codex)
    const state = await adapter.loadState()
    const workspaceId = state.activeWorkspaceId
    if (workspaceId === null) throw new Error("active fixture workspace")

    expect(adapter.codexSnapshot()).toMatchObject({
      connected: true,
      phase: "ready",
      readiness: { fastAvailable: true, maxAvailable: true },
    })
    await expect(
      adapter.pickAttachments(workspaceId, []),
    ).resolves.toMatchObject({
      items: [{ name: "notes.txt", relativePath: "notes.txt" }],
    })
    const editableContextSnapshot =
      await adapter.getTurnContextSnapshot(workspaceId)
    await expect(
      adapter.sendTurn({
        workspaceId,
        instruction: "Run the focused checks.",
        effort: "fast",
        attachments: [],
        contextSnapshots: [],
        editableContextSnapshot,
      }),
    ).resolves.toEqual({ accepted: true })
    const turnStartRequest = codex.calls.find(
      (call) => call.command === codexCommands.turnStart,
    )?.request
    if (
      !isRecord(turnStartRequest) ||
      typeof turnStartRequest.text !== "string"
    ) {
      throw new Error("Expected a typed turn start request")
    }
    expect(turnStartRequest.effort).toBe("low")
    expect(turnStartRequest.attachmentHandles).toEqual([])
    expect(turnStartRequest.text).toContain("CODING_WIFE_CONTEXT_SNAPSHOT_V1")

    codex.emit({
      schemaVersion: 1,
      eventId: "event-composition-message",
      workspaceId,
      generation: fixture.thread.generation,
      sequence: 1,
      occurredAt: "2026-07-18T00:01:00.000Z",
      kind: "agent_message_completed",
      payload: { itemHandle: "item-composition", text: "Checks passed." },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(adapter.codexSnapshot().timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "assistant",
          text: "Checks passed.",
        }),
      ]),
    )
    const persisted = await history.request("workspace_select", {
      workspaceId,
    })
    expect(persisted.timeline.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "code.user.instruction.accepted" }),
        expect.objectContaining({ kind: "code.message.completed" }),
      ]),
    )
    const acceptedInstruction = persisted.timeline.items.find(
      (item) => item.kind === "code.user.instruction.accepted",
    )
    expect(acceptedInstruction?.payload).toMatchObject({
      text: "Run the focused checks.",
    })
  })

  it("keeps turn start blocked when native history is not write-ready", async () => {
    const history = new DemoWorkspaceHistoryTransport()
    const codex = new CompositionCodexTransport()
    const adapter = new CodexComposedWorkspaceViewAdapter(history, codex)
    const state = await adapter.loadState()
    const workspaceId = state.activeWorkspaceId
    if (workspaceId === null) throw new Error("active fixture workspace")

    const nativeReadOnly = new CodexComposedWorkspaceViewAdapter(
      {
        kind: "tauri",
        request: (command, request) => history.request(command, request),
      },
      codex,
    )
    await nativeReadOnly.loadState()
    expect(nativeReadOnly.codexSnapshot()).toMatchObject({
      connected: false,
      phase: "blocked",
    })
    await expect(
      nativeReadOnly.sendTurn({
        workspaceId,
        instruction: "Must remain blocked",
        effort: "fast",
        attachments: [],
        contextSnapshots: [],
        editableContextSnapshot:
          await nativeReadOnly.getTurnContextSnapshot(workspaceId),
      }),
    ).rejects.toThrow("CODEX-TURN-PREFLIGHT-BLOCKED")
  })

  it("keeps the interactive App Server demo connected through rich history", async () => {
    vi.useFakeTimers()
    try {
      const adapter = new CodexComposedWorkspaceViewAdapter(
        new DemoWorkspaceHistoryTransport(),
        new DemoCodexTransport(),
      )
      const state = await adapter.loadState()
      const workspaceId = state.activeWorkspaceId
      if (workspaceId === null) throw new Error("active demo workspace")

      await adapter.sendTurn({
        workspaceId,
        instruction: "demo:workflow",
        effort: "max",
        attachments: [],
        contextSnapshots: [],
        editableContextSnapshot:
          await adapter.getTurnContextSnapshot(workspaceId),
      })
      await vi.advanceTimersByTimeAsync(600)
      for (let iteration = 0; iteration < 16; iteration += 1) {
        await Promise.resolve()
      }

      const waiting = adapter.codexSnapshot()
      expect(waiting).toMatchObject({ connected: true, phase: "waiting" })
      expect(waiting.timeline.map((event) => event.kind)).toEqual(
        expect.arrayContaining([
          "user",
          "assistant",
          "plan",
          "tool",
          "file",
          "diff",
          "decision",
        ]),
      )
      const decision = waiting.pendingRequests.find(
        (request) => request.kind === "user_input",
      )
      if (decision === undefined) throw new Error("demo decision")
      await expect(
        adapter.respondPending({
          workspaceId,
          pendingId: decision.pendingId,
          response: {
            type: "user_input",
            answers: { scope: ["Keep the public API unchanged"] },
          },
        }),
      ).resolves.toBe(true)
      await Promise.resolve()

      const approval = adapter
        .codexSnapshot()
        .pendingRequests.find((request) => request.kind !== "user_input")
      if (approval === undefined) throw new Error("demo approval")
      await expect(
        adapter.respondPending({
          workspaceId,
          pendingId: approval.pendingId,
          response: { type: "approval", decision: "approve_once" },
        }),
      ).resolves.toBe(true)
      await Promise.resolve()
      expect(adapter.codexSnapshot()).toMatchObject({
        connected: true,
        phase: "completed",
        errorCode: null,
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
