import { describe, expect, it, vi } from "vitest"
import {
  type CodexEventCallbacks,
  type CodexTransport,
  DemoCodexTransport,
} from "@/features/codex"
import { CodexComposedWorkspaceViewAdapter } from "@/features/workspace-persistence/codex-composition"
import { DemoWorkspaceHistoryTransport } from "@/features/workspace-persistence/demo-transport"
import {
  type CodexCommand,
  type CodexEvent,
  type CodexRequestMap,
  type CodexResponseMap,
  codexCommands,
  parseCodexDiagnostic,
  parseCodexEvent,
} from "@/lib/contracts"
import fixture from "@/test/fixtures/codex-runtime.v1.json"

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

class CompositionCodexTransport implements CodexTransport {
  readonly kind = "demo"
  readonly calls: {
    readonly command: CodexCommand
    readonly request: unknown
  }[] = []
  readonly threadFailures = new Map<string, Error>()
  connectGate: Promise<void> | null = null
  turnStartGate: Promise<void> | null = null
  interruptFailure: Error | null = null
  private callbacks: CodexEventCallbacks | null = null

  request<K extends CodexCommand>(
    command: K,
    request: CodexRequestMap[K],
  ): Promise<CodexResponseMap[K]> {
    this.calls.push({ command, request })
    switch (command) {
      case codexCommands.connect:
        {
          if (this.connectGate !== null) {
            return this.connectGate.then(
              () =>
                parseCodexDiagnostic(fixture.diagnostic) as CodexResponseMap[K],
            )
          }
        }
        return Promise.resolve(
          parseCodexDiagnostic(fixture.diagnostic) as CodexResponseMap[K],
        )
      case codexCommands.threadStart:
      case codexCommands.threadResume:
        {
          const failure = this.threadFailures.get(
            (
              request as
                | CodexRequestMap["codex_thread_start"]
                | CodexRequestMap["codex_thread_resume"]
            ).workspaceId,
          )
          if (failure !== undefined) return Promise.reject(failure)
        }
        return Promise.resolve(fixture.thread as CodexResponseMap[K])
      case codexCommands.turnStart:
        return this.turnStartGate === null
          ? Promise.resolve(fixture.turn as CodexResponseMap[K])
          : this.turnStartGate.then(() => fixture.turn as CodexResponseMap[K])
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
        if (this.interruptFailure !== null) {
          return Promise.reject(this.interruptFailure)
        }
        return Promise.resolve({ accepted: true } as CodexResponseMap[K])
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
  it("hydrates native workspace state before Codex activation completes", async () => {
    const history = new DemoWorkspaceHistoryTransport()
    const codex = new CompositionCodexTransport()
    let releaseConnect!: () => void
    codex.connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve
    })
    const adapter = new CodexComposedWorkspaceViewAdapter(
      {
        kind: "tauri",
        request: (command, request) => history.request(command, request),
      },
      codex,
    )

    const state = await adapter.loadState()

    expect(state.activeWorkspaceId).not.toBeNull()
    expect(adapter.codexSnapshot()).toMatchObject({
      activeWorkspaceId: state.activeWorkspaceId,
      connected: false,
      phase: "connecting",
    })
    await vi.waitFor(() => {
      expect(
        codex.calls.filter((call) => call.command === codexCommands.connect),
      ).toHaveLength(1)
    })

    releaseConnect()
    await vi.waitFor(() => {
      expect(adapter.codexSnapshot()).toMatchObject({
        activeWorkspaceId: state.activeWorkspaceId,
        connected: true,
        phase: "blocked",
      })
    })
  })

  it("single-flights concurrent activation for the same workspace", async () => {
    const history = new DemoWorkspaceHistoryTransport()
    const codex = new CompositionCodexTransport()
    let releaseConnect!: () => void
    codex.connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve
    })
    const adapter = new CodexComposedWorkspaceViewAdapter(history, codex)
    const initial = await history.request("workspace_list", undefined)
    const workspaceId = initial.activeWorkspaceId
    if (workspaceId === null) throw new Error("active fixture workspace")
    const loading = adapter.loadState()

    await vi.waitFor(() => {
      expect(
        codex.calls.filter((call) => call.command === codexCommands.connect),
      ).toHaveLength(1)
    })
    const firstRecheck = adapter.recheckWorkspace(workspaceId)
    const secondRecheck = adapter.recheckWorkspace(workspaceId)
    await vi.waitFor(() => {
      expect(
        codex.calls.filter((call) => call.command === codexCommands.connect),
      ).toHaveLength(1)
    })

    releaseConnect()
    await expect(
      Promise.all([loading, firstRecheck, secondRecheck]),
    ).resolves.toHaveLength(3)
    expect(
      codex.calls.filter((call) => call.command === codexCommands.connect),
    ).toHaveLength(1)
  })

  it("activates the selected workspace and composes send, attachment, live, and HIST state", async () => {
    const history = new DemoWorkspaceHistoryTransport()
    const codex = new CompositionCodexTransport()
    const adapter = new CodexComposedWorkspaceViewAdapter(history, codex)
    const state = await adapter.loadState()
    const workspaceId = state.activeWorkspaceId
    if (workspaceId === null) throw new Error("active fixture workspace")

    expect(adapter.codexSnapshot()).toMatchObject({
      activeWorkspaceId: workspaceId,
      connected: true,
      generation: fixture.thread.generation,
      phase: "ready",
      readiness: {
        fastServiceTier: "priority",
        supportedReasoningEfforts: expect.arrayContaining(["low", "max"]),
        experimentalModesAvailable: true,
      },
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
        effort: "off",
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
    expect(turnStartRequest.effort).toBeNull()
    expect(turnStartRequest.serviceTier).toBeNull()
    expect(turnStartRequest.planMode).toBe(false)
    expect(turnStartRequest.goalObjective).toBeNull()
    expect(turnStartRequest.attachmentHandles).toEqual([])
    expect(turnStartRequest.text).toContain("CODING_WIFE_UNTRUSTED_CONTEXT_V1")
    expect(turnStartRequest.text).toContain(
      "CODING_WIFE_AUTHORITATIVE_USER_INSTRUCTION_V1",
    )

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
    await vi.waitFor(() => {
      expect(nativeReadOnly.codexSnapshot()).toMatchObject({
        connected: true,
        phase: "blocked",
      })
    })
    await expect(
      nativeReadOnly.sendTurn({
        workspaceId,
        instruction: "Must remain blocked",
        effort: "off",
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
            answers: {
              scope: { type: "other", text: "Keep the public API unchanged" },
            },
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

  it("selects the target immediately and activates it after the old turn is terminal", async () => {
    const history = new DemoWorkspaceHistoryTransport()
    const historyRequest = vi.spyOn(history, "request")
    const codex = new CompositionCodexTransport()
    const adapter = new CodexComposedWorkspaceViewAdapter(history, codex)
    const state = await adapter.loadState()
    const fromWorkspaceId = state.activeWorkspaceId
    if (fromWorkspaceId === null) throw new Error("active fixture workspace")
    const toWorkspaceId = "sol-desktop"
    await adapter.sendTurn({
      workspaceId: fromWorkspaceId,
      instruction: "Finish the owned turn before switching.",
      effort: "off",
      attachments: [],
      contextSnapshots: [],
      editableContextSnapshot:
        await adapter.getTurnContextSnapshot(fromWorkspaceId),
    })
    const running = parseCodexEvent(fixture.events[0])
    const pending = parseCodexEvent(fixture.events[1])
    if (running.kind !== "turn_status" || pending.kind !== "pending_request") {
      throw new Error("turn fixtures")
    }
    expect(adapter.codexSnapshot()).toMatchObject({
      activeWorkspaceId: fromWorkspaceId,
      phase: "running",
    })

    await expect(adapter.selectWorkspace(toWorkspaceId)).resolves.toMatchObject(
      {
        activeWorkspaceId: toWorkspaceId,
      },
    )
    expect(
      codex.calls.filter(
        ({ command }) => command === codexCommands.turnInterrupt,
      ),
    ).toHaveLength(0)
    expect(adapter.codexSnapshot()).toMatchObject({
      activeWorkspaceId: fromWorkspaceId,
      phase: "running",
      pendingRequests: [],
    })

    codex.emit({ ...pending, workspaceId: fromWorkspaceId })
    expect(adapter.codexSnapshot()).toMatchObject({
      activeWorkspaceId: fromWorkspaceId,
      phase: "waiting",
      pendingRequests: [
        expect.objectContaining({ pendingId: "pending_handle_fixture" }),
      ],
    })

    codex.emit({
      ...running,
      workspaceId: fromWorkspaceId,
      eventId: "event-composition-terminal",
      sequence: 3,
      payload: { ...running.payload, status: "interrupted" },
    })
    await vi.waitFor(() =>
      expect(adapter.codexSnapshot()).toMatchObject({
        activeWorkspaceId: toWorkspaceId,
        phase: "ready",
        pendingRequests: [],
      }),
    )
    const historyCalls = historyRequest.mock.calls
    const terminalAppendIndex = historyCalls.findIndex(
      ([command, request]) =>
        command === "history_append_domain_event" &&
        isRecord(request) &&
        request.eventId === "event-composition-terminal",
    )
    const targetSelectIndex = historyCalls.findIndex(
      ([command, request]) =>
        command === "workspace_select" &&
        isRecord(request) &&
        request.workspaceId === toWorkspaceId,
    )
    expect(terminalAppendIndex).toBeGreaterThanOrEqual(0)
    expect(targetSelectIndex).toBeGreaterThanOrEqual(0)
    expect(targetSelectIndex).toBeLessThan(terminalAppendIndex)
  })

  it("keeps the source execution owned while turn start is still in flight", async () => {
    const history = new DemoWorkspaceHistoryTransport()
    const codex = new CompositionCodexTransport()
    let releaseTurnStart!: () => void
    codex.turnStartGate = new Promise<void>((resolve) => {
      releaseTurnStart = resolve
    })
    const adapter = new CodexComposedWorkspaceViewAdapter(history, codex)
    const state = await adapter.loadState()
    const fromWorkspaceId = state.activeWorkspaceId
    if (fromWorkspaceId === null) throw new Error("active fixture workspace")
    const toWorkspaceId = "sol-desktop"

    const sending = adapter.sendTurn({
      workspaceId: fromWorkspaceId,
      instruction: "Keep ownership before the turn response arrives.",
      effort: "off",
      attachments: [],
      contextSnapshots: [],
      editableContextSnapshot:
        await adapter.getTurnContextSnapshot(fromWorkspaceId),
    })
    await vi.waitFor(() =>
      expect(codex.calls.at(-1)?.command).toBe(codexCommands.turnStart),
    )

    await expect(adapter.selectWorkspace(toWorkspaceId)).resolves.toMatchObject(
      { activeWorkspaceId: toWorkspaceId },
    )
    expect(
      codex.calls.filter(({ command }) => command === codexCommands.connect),
    ).toHaveLength(1)

    releaseTurnStart()
    await expect(sending).resolves.toEqual({ accepted: true })
    expect(adapter.codexSnapshot()).toMatchObject({
      activeWorkspaceId: fromWorkspaceId,
      phase: "running",
    })

    const running = parseCodexEvent(fixture.events[0])
    if (running.kind !== "turn_status") throw new Error("turn fixture")
    codex.emit({
      ...running,
      workspaceId: fromWorkspaceId,
      eventId: "event-in-flight-terminal",
      payload: { ...running.payload, status: "interrupted" },
    })
    await vi.waitFor(() =>
      expect(adapter.codexSnapshot()).toMatchObject({
        activeWorkspaceId: toWorkspaceId,
        phase: "ready",
      }),
    )
  })

  it("waits for exact terminal cleanup and history flush before canceling once", async () => {
    const history = new DemoWorkspaceHistoryTransport()
    const historyRequest = vi.spyOn(history, "request")
    const codex = new CompositionCodexTransport()
    const adapter = new CodexComposedWorkspaceViewAdapter(history, codex)
    const state = await adapter.loadState()
    const workspaceId = state.activeWorkspaceId
    if (workspaceId === null) throw new Error("active fixture workspace")
    const updatedAt = state.workspaces.find(
      (workspace) => workspace.id === workspaceId,
    )?.updatedAt
    if (updatedAt === undefined) throw new Error("active fixture revision")
    await adapter.sendTurn({
      workspaceId,
      instruction: "Cancel only after terminal cleanup.",
      effort: "off",
      attachments: [],
      contextSnapshots: [],
      editableContextSnapshot:
        await adapter.getTurnContextSnapshot(workspaceId),
    })
    const running = parseCodexEvent(fixture.events[0])
    if (running.kind !== "turn_status") throw new Error("turn fixture")
    codex.emit({ ...running, workspaceId })

    const first = adapter.cancelWorkspace(
      workspaceId,
      updatedAt,
      fixture.thread.generation,
    )
    const duplicate = adapter.cancelWorkspace(
      workspaceId,
      updatedAt,
      fixture.thread.generation,
    )
    expect(duplicate).toBe(first)
    await vi.waitFor(() =>
      expect(codex.calls.at(-1)?.command).toBe(codexCommands.turnInterrupt),
    )
    expect(
      historyRequest.mock.calls.filter(
        ([command]) => command === "workspace_cancel",
      ),
    ).toHaveLength(0)

    codex.emit({
      ...running,
      workspaceId,
      eventId: "event-cancel-terminal",
      sequence: 2,
      payload: { ...running.payload, status: "interrupted" },
    })
    const canceled = await first
    expect(
      canceled.workspaces.find((workspace) => workspace.id === workspaceId),
    ).toMatchObject({ id: workspaceId, lifecycle: "canceled" })

    const calls = historyRequest.mock.calls
    const terminalAppendIndex = calls.findIndex(
      ([command, request]) =>
        command === "history_append_domain_event" &&
        isRecord(request) &&
        request.eventId === "event-cancel-terminal",
    )
    const cancelIndex = calls.findIndex(
      ([command]) => command === "workspace_cancel",
    )
    expect(terminalAppendIndex).toBeGreaterThanOrEqual(0)
    expect(cancelIndex).toBeGreaterThan(terminalAppendIndex)
    expect(
      calls.filter(([command]) => command === "workspace_cancel"),
    ).toHaveLength(1)
  })

  it("archives an active workspace only after confirmed terminal cleanup and history flush", async () => {
    const history = new DemoWorkspaceHistoryTransport()
    const historyRequest = vi.spyOn(history, "request")
    const codex = new CompositionCodexTransport()
    const adapter = new CodexComposedWorkspaceViewAdapter(history, codex)
    const state = await adapter.loadState()
    const workspaceId = state.activeWorkspaceId
    if (workspaceId === null) throw new Error("active fixture workspace")
    await adapter.sendTurn({
      workspaceId,
      instruction: "Archive only after the exact turn stops.",
      effort: "off",
      attachments: [],
      contextSnapshots: [],
      editableContextSnapshot:
        await adapter.getTurnContextSnapshot(workspaceId),
    })
    const running = parseCodexEvent(fixture.events[0])
    if (running.kind !== "turn_status") throw new Error("turn fixture")
    codex.emit({ ...running, workspaceId })

    await expect(adapter.archiveWorkspace(workspaceId)).rejects.toThrow(
      "WORKSPACE-ARCHIVE-ACTIVE",
    )
    expect(
      historyRequest.mock.calls.filter(
        ([command]) => command === "workspace_archive",
      ),
    ).toHaveLength(0)
    expect(
      codex.calls.filter(
        ({ command }) => command === codexCommands.turnInterrupt,
      ),
    ).toHaveLength(0)

    const first = adapter.archiveWorkspace(
      workspaceId,
      fixture.thread.generation,
    )
    const duplicate = adapter.archiveWorkspace(
      workspaceId,
      fixture.thread.generation,
    )
    expect(duplicate).toBe(first)
    await vi.waitFor(() =>
      expect(codex.calls.at(-1)?.command).toBe(codexCommands.turnInterrupt),
    )
    expect(
      historyRequest.mock.calls.filter(
        ([command]) => command === "workspace_archive",
      ),
    ).toHaveLength(0)

    codex.emit({
      ...running,
      workspaceId,
      eventId: "event-archive-terminal",
      sequence: 2,
      payload: { ...running.payload, status: "interrupted" },
    })
    const archived = await first
    expect(
      archived.workspaces.some((workspace) => workspace.id === workspaceId),
    ).toBe(false)

    const calls = historyRequest.mock.calls
    const terminalAppendIndex = calls.findIndex(
      ([command, request]) =>
        command === "history_append_domain_event" &&
        isRecord(request) &&
        request.eventId === "event-archive-terminal",
    )
    const archiveIndex = calls.findIndex(
      ([command]) => command === "workspace_archive",
    )
    expect(terminalAppendIndex).toBeGreaterThanOrEqual(0)
    expect(archiveIndex).toBeGreaterThan(terminalAppendIndex)
  })

  it("keeps the workspace when confirmed archive interruption fails", async () => {
    const history = new DemoWorkspaceHistoryTransport()
    const historyRequest = vi.spyOn(history, "request")
    const codex = new CompositionCodexTransport()
    const adapter = new CodexComposedWorkspaceViewAdapter(history, codex)
    const state = await adapter.loadState()
    const workspaceId = state.activeWorkspaceId
    if (workspaceId === null) throw new Error("active fixture workspace")
    await adapter.sendTurn({
      workspaceId,
      instruction: "Keep this workspace if stopping fails.",
      effort: "off",
      attachments: [],
      contextSnapshots: [],
      editableContextSnapshot:
        await adapter.getTurnContextSnapshot(workspaceId),
    })
    const running = parseCodexEvent(fixture.events[0])
    if (running.kind !== "turn_status") throw new Error("turn fixture")
    codex.emit({ ...running, workspaceId })
    codex.interruptFailure = new Error("CODEX-INTERRUPT-FAILED")

    await expect(
      adapter.archiveWorkspace(workspaceId, fixture.thread.generation),
    ).rejects.toThrow("CODEX-INTERRUPT-FAILED")
    expect(
      historyRequest.mock.calls.filter(
        ([command]) => command === "workspace_archive",
      ),
    ).toHaveLength(0)
    const after = await history.request("workspace_list", undefined)
    expect(
      after.workspaces.some(
        (workspace) => workspace.workspaceId === workspaceId,
      ),
    ).toBe(true)
  })

  it("keeps lifecycle unchanged when interrupt acknowledgement fails", async () => {
    const history = new DemoWorkspaceHistoryTransport()
    const historyRequest = vi.spyOn(history, "request")
    const codex = new CompositionCodexTransport()
    const adapter = new CodexComposedWorkspaceViewAdapter(history, codex)
    const state = await adapter.loadState()
    const workspaceId = state.activeWorkspaceId
    if (workspaceId === null) throw new Error("active fixture workspace")
    const workspace = state.workspaces.find(
      (candidate) => candidate.id === workspaceId,
    )
    if (workspace?.updatedAt === undefined)
      throw new Error("active fixture workspace")
    await adapter.sendTurn({
      workspaceId,
      instruction: "Preserve lifecycle on interrupt failure.",
      effort: "off",
      attachments: [],
      contextSnapshots: [],
      editableContextSnapshot:
        await adapter.getTurnContextSnapshot(workspaceId),
    })
    const running = parseCodexEvent(fixture.events[0])
    if (running.kind !== "turn_status") throw new Error("turn fixture")
    codex.emit({ ...running, workspaceId })
    codex.interruptFailure = new Error("CODEX-INTERRUPT-FAILED")

    await expect(
      adapter.cancelWorkspace(
        workspaceId,
        workspace.updatedAt,
        fixture.thread.generation,
      ),
    ).rejects.toThrow("CODEX-INTERRUPT-FAILED")
    expect(
      historyRequest.mock.calls.filter(
        ([command]) => command === "workspace_cancel",
      ),
    ).toHaveLength(0)
    const after = await history.request("workspace_list", undefined)
    expect(
      after.workspaces.find(
        (candidate) => candidate.workspaceId === workspaceId,
      ),
    ).toMatchObject({ workspaceId, lifecycle: workspace.lifecycle })
  })

  it("keeps the selected workspace when delayed Codex activation fails", async () => {
    const history = new DemoWorkspaceHistoryTransport()
    const historyRequest = vi.spyOn(history, "request")
    const codex = new CompositionCodexTransport()
    const adapter = new CodexComposedWorkspaceViewAdapter(history, codex)
    const state = await adapter.loadState()
    const fromWorkspaceId = state.activeWorkspaceId
    if (fromWorkspaceId === null) throw new Error("active fixture workspace")
    const toWorkspaceId = "sol-desktop"
    await adapter.sendTurn({
      workspaceId: fromWorkspaceId,
      instruction: "Keep the old workspace active on failure.",
      effort: "max",
      attachments: [],
      contextSnapshots: [],
      editableContextSnapshot:
        await adapter.getTurnContextSnapshot(fromWorkspaceId),
    })
    const running = parseCodexEvent(fixture.events[0])
    if (running.kind !== "turn_status") throw new Error("turn fixture")
    codex.emit({ ...running, workspaceId: fromWorkspaceId })

    codex.threadFailures.set(
      toWorkspaceId,
      Object.assign(new Error("target unavailable"), {
        code: "CODEX-TARGET-UNAVAILABLE",
      }),
    )
    await expect(adapter.selectWorkspace(toWorkspaceId)).resolves.toMatchObject(
      {
        activeWorkspaceId: toWorkspaceId,
      },
    )
    codex.emit({
      ...running,
      workspaceId: fromWorkspaceId,
      eventId: "event-restored-terminal",
      sequence: 2,
      payload: { ...running.payload, status: "interrupted" },
    })

    await vi.waitFor(() =>
      expect(
        codex.calls.some(
          ({ command, request }) =>
            command === codexCommands.threadStart &&
            isRecord(request) &&
            request.workspaceId === toWorkspaceId,
        ),
      ).toBe(true),
    )
    const selected = await history.request("workspace_list", undefined)
    expect(selected.activeWorkspaceId).toBe(toWorkspaceId)
    expect(
      historyRequest.mock.calls
        .filter(([command]) => command === "workspace_select")
        .map(([, request]) => (isRecord(request) ? request.workspaceId : null)),
    ).toEqual([toWorkspaceId])
  })

  it("deduplicates safe quit and flushes the exact terminal event before the draft", async () => {
    const history = new DemoWorkspaceHistoryTransport()
    const historyRequest = vi.spyOn(history, "request")
    const codex = new CompositionCodexTransport()
    const adapter = new CodexComposedWorkspaceViewAdapter(history, codex)
    const state = await adapter.loadState()
    const workspaceId = state.activeWorkspaceId
    if (workspaceId === null) throw new Error("active fixture workspace")
    await adapter.sendTurn({
      workspaceId,
      instruction: "Finish before quitting.",
      effort: "off",
      attachments: [],
      contextSnapshots: [],
      editableContextSnapshot:
        await adapter.getTurnContextSnapshot(workspaceId),
    })
    const running = parseCodexEvent(fixture.events[0])
    if (running.kind !== "turn_status") throw new Error("turn fixture")
    codex.emit({ ...running, workspaceId })

    const request = {
      workspaceId,
      expectedGeneration: fixture.thread.generation,
      draftText: "Keep this exact draft",
      draftEffort: "max" as const,
    }
    const first = adapter.prepareAppQuit(request)
    const duplicate = adapter.prepareAppQuit(request)
    expect(duplicate).toBe(first)
    await vi.waitFor(() =>
      expect(
        codex.calls.filter(
          ({ command }) => command === codexCommands.turnInterrupt,
        ),
      ).toHaveLength(1),
    )
    expect(
      historyRequest.mock.calls.some(
        ([command]) => command === "workspace_save_draft",
      ),
    ).toBe(false)

    codex.emit({
      ...running,
      workspaceId,
      eventId: "event-safe-quit-terminal",
      sequence: 2,
      payload: { ...running.payload, status: "interrupted" },
    })
    await expect(first).resolves.toBeUndefined()

    const calls = historyRequest.mock.calls
    const terminalIndex = calls.findIndex(
      ([command, payload]) =>
        command === "history_append_domain_event" &&
        isRecord(payload) &&
        payload.eventId === "event-safe-quit-terminal",
    )
    const draftIndex = calls.findIndex(
      ([command, payload]) =>
        command === "workspace_save_draft" &&
        isRecord(payload) &&
        payload.text === "Keep this exact draft",
    )
    expect(terminalIndex).toBeGreaterThanOrEqual(0)
    expect(draftIndex).toBeGreaterThan(terminalIndex)
  })

  it("does not flush or mutate the draft when safe quit terminalization fails", async () => {
    const history = new DemoWorkspaceHistoryTransport()
    const historyRequest = vi.spyOn(history, "request")
    const codex = new CompositionCodexTransport()
    const adapter = new CodexComposedWorkspaceViewAdapter(history, codex)
    const state = await adapter.loadState()
    const workspaceId = state.activeWorkspaceId
    if (workspaceId === null) throw new Error("active fixture workspace")
    await adapter.sendTurn({
      workspaceId,
      instruction: "Keep running on interrupt failure.",
      effort: "off",
      attachments: [],
      contextSnapshots: [],
      editableContextSnapshot:
        await adapter.getTurnContextSnapshot(workspaceId),
    })
    const running = parseCodexEvent(fixture.events[0])
    if (running.kind !== "turn_status") throw new Error("turn fixture")
    codex.emit({ ...running, workspaceId })
    codex.interruptFailure = new Error("interrupt unavailable")

    await expect(
      adapter.prepareAppQuit({
        workspaceId,
        expectedGeneration: fixture.thread.generation,
        draftText: "Must not persist after failure",
        draftEffort: "off",
      }),
    ).rejects.toThrow("interrupt unavailable")
    expect(
      historyRequest.mock.calls.some(
        ([command]) => command === "workspace_save_draft",
      ),
    ).toBe(false)
  })
})
