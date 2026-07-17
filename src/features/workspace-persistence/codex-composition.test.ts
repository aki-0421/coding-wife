import { describe, expect, it } from "vitest"

import {
  codexCommands,
  parseCodexDiagnostic,
  type CodexCommand,
  type CodexEvent,
  type CodexRequestMap,
  type CodexResponseMap,
} from "@/lib/contracts"
import fixture from "@/test/fixtures/codex-runtime.v1.json"

import type { CodexEventCallbacks, CodexTransport } from "@/features/codex"
import { CodexComposedWorkspaceViewAdapter } from "@/features/workspace-persistence/codex-composition"
import { DemoWorkspaceHistoryTransport } from "@/features/workspace-persistence/demo-transport"

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
    await expect(
      adapter.sendTurn({
        workspaceId,
        instruction: "Run the focused checks.",
        effort: "fast",
        attachments: [],
        contextSnapshots: [],
      }),
    ).resolves.toEqual({ accepted: true })
    expect(
      codex.calls.find((call) => call.command === codexCommands.turnStart),
    ).toMatchObject({
      request: { effort: "low", attachmentHandles: [] },
    })

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
      }),
    ).rejects.toThrow("CODEX-TURN-PREFLIGHT-BLOCKED")
  })
})
