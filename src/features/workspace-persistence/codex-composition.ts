import { workspaceHistoryCommands } from "@/lib/contracts"

import {
  CodexWorkspaceSessionAdapter,
  DemoCodexTransport,
  TauriCodexTransport,
  type CodexHistoryEvent,
  type CodexTransport,
  type CodexWorkspaceSessionSnapshot,
} from "@/features/codex"
import { PersistentWorkspaceViewAdapter } from "@/features/workspace-persistence/adapter"
import { composeTurnInstruction } from "@/features/workspace-persistence/turn-context"
import type { WorkspaceHistoryTransport } from "@/features/workspace-persistence/transport"
import type {
  SendTurnRequest,
  WorkspaceAdapterState,
  WorkspaceCodexState,
  WorkspaceCreateRequest,
  WorkspaceTransitionRequest,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"

function publicCodexState(
  snapshot: CodexWorkspaceSessionSnapshot,
): WorkspaceCodexState {
  return {
    activeWorkspaceId: snapshot.activeWorkspaceId,
    generation: snapshot.generation,
    phase: snapshot.phase,
    connected: snapshot.connected,
    readiness: snapshot.readiness,
    pendingRequests: snapshot.pendingRequests,
    timeline: snapshot.timeline,
    errorCode: snapshot.errorCode,
  }
}

class WorkspaceHistoryCodexSink {
  constructor(private readonly transport: WorkspaceHistoryTransport) {}

  async append(event: CodexHistoryEvent): Promise<void> {
    await this.transport.request(workspaceHistoryCommands.appendDomainEvent, {
      schemaVersion: event.schemaVersion,
      eventId: event.eventId,
      workspaceId: event.workspaceId,
      sessionId: event.sessionId,
      producer: event.producer,
      kind: event.kind,
      occurredAt: event.occurredAt,
      payload: event.payload,
    })
  }
}

export class CodexComposedWorkspaceViewAdapter implements WorkspaceViewAdapter {
  readonly connected = true
  readonly hydrationMode: "native" | "demo"

  private readonly history: PersistentWorkspaceViewAdapter
  private readonly codex: CodexWorkspaceSessionAdapter
  private workspaceTransition: {
    readonly key: string
    readonly operation: Promise<WorkspaceAdapterState>
  } | null = null
  private workspaceCancellation: {
    readonly key: string
    readonly operation: Promise<WorkspaceAdapterState>
  } | null = null

  constructor(
    historyTransport: WorkspaceHistoryTransport,
    codexTransport: CodexTransport,
  ) {
    this.hydrationMode = historyTransport.kind === "tauri" ? "native" : "demo"
    this.history = new PersistentWorkspaceViewAdapter(historyTransport)
    this.codex = new CodexWorkspaceSessionAdapter(
      codexTransport,
      new WorkspaceHistoryCodexSink(historyTransport),
    )
  }

  codexSnapshot = (): WorkspaceCodexState =>
    publicCodexState(this.codex.snapshot())

  subscribeCodex = (
    listener: (state: WorkspaceCodexState) => void,
  ): (() => void) =>
    this.codex.subscribe((snapshot) => listener(publicCodexState(snapshot)))

  async loadState(): Promise<WorkspaceAdapterState> {
    const state = await this.history.loadState()
    await this.activateCodex(state)
    return state
  }

  async selectWorkspace(workspaceId: string): Promise<WorkspaceAdapterState> {
    const state = await this.history.selectWorkspace(workspaceId)
    await this.activateCodex(state)
    return state
  }

  stopAndSwitchWorkspace(
    request: WorkspaceTransitionRequest,
  ): Promise<WorkspaceAdapterState> {
    if (this.workspaceCancellation !== null) {
      return Promise.reject(new Error("WORKSPACE-CANCEL-IN-PROGRESS"))
    }
    const key = `${request.fromWorkspaceId}:${request.toWorkspaceId}:${String(request.expectedGeneration)}`
    if (this.workspaceTransition !== null) {
      if (this.workspaceTransition.key === key) {
        return this.workspaceTransition.operation
      }
      return Promise.reject(new Error("WORKSPACE-TRANSITION-IN-PROGRESS"))
    }
    const operation = this.performWorkspaceTransition(request).finally(() => {
      if (this.workspaceTransition?.operation === operation) {
        this.workspaceTransition = null
      }
    })
    this.workspaceTransition = { key, operation }
    return operation
  }

  cancelWorkspace(
    workspaceId: string,
    expectedUpdatedAt: string,
    expectedGeneration: number | null = null,
  ): Promise<WorkspaceAdapterState> {
    if (this.workspaceTransition !== null) {
      return Promise.reject(new Error("WORKSPACE-TRANSITION-IN-PROGRESS"))
    }
    const key = `${workspaceId}:${expectedUpdatedAt}:${String(expectedGeneration)}`
    if (this.workspaceCancellation !== null) {
      if (this.workspaceCancellation.key === key) {
        return this.workspaceCancellation.operation
      }
      return Promise.reject(new Error("WORKSPACE-CANCEL-IN-PROGRESS"))
    }
    const operation = this.performWorkspaceCancellation(
      workspaceId,
      expectedUpdatedAt,
      expectedGeneration,
    ).finally(() => {
      if (this.workspaceCancellation?.operation === operation) {
        this.workspaceCancellation = null
      }
    })
    this.workspaceCancellation = { key, operation }
    return operation
  }

  async repairWorkspace(workspaceId: string): Promise<WorkspaceAdapterState> {
    const state = await this.history.repairWorkspace(workspaceId)
    await this.activateCodex(state)
    return state
  }

  async unregisterWorkspace(
    workspaceId: string,
  ): Promise<WorkspaceAdapterState> {
    const state = await this.history.unregisterWorkspace(workspaceId)
    if (state.activeWorkspaceId !== null) await this.activateCodex(state)
    return state
  }

  saveDraft(
    workspaceId: string,
    text: string,
    effort: "fast" | "max",
  ): Promise<void> {
    return this.history.saveDraft(workspaceId, text, effort)
  }

  async requestAddProject(): Promise<WorkspaceAdapterState> {
    const state = await this.history.requestAddProject()
    await this.activateCodex(state)
    return state
  }

  async requestAddWorkspace(
    request: WorkspaceCreateRequest,
  ): Promise<WorkspaceAdapterState> {
    const state = await this.history.requestAddWorkspace(request)
    await this.activateCodex(state)
    return state
  }

  captureContext(
    workspaceId: string,
    source: "files" | "git_diff" | "terminal_output",
  ) {
    return this.history.captureContext(workspaceId, source)
  }

  loadEditableContext(workspaceId: string) {
    return this.history.loadEditableContext(workspaceId)
  }

  saveProjectContext(
    workspaceId: string,
    expectedVersion: number,
    context: Parameters<
      PersistentWorkspaceViewAdapter["saveProjectContext"]
    >[2],
  ) {
    return this.history.saveProjectContext(
      workspaceId,
      expectedVersion,
      context,
    )
  }

  saveCharacterContext(
    workspaceId: string,
    expectedVersion: number,
    context: Parameters<
      PersistentWorkspaceViewAdapter["saveCharacterContext"]
    >[2],
  ) {
    return this.history.saveCharacterContext(
      workspaceId,
      expectedVersion,
      context,
    )
  }

  getTurnContextSnapshot(workspaceId: string) {
    return this.history.getTurnContextSnapshot(workspaceId)
  }

  async sendTurn(
    request: SendTurnRequest,
  ): Promise<{ readonly accepted: boolean }> {
    await this.codex.sendTurn({
      workspaceId: request.workspaceId,
      text: composeTurnInstruction(
        request.instruction,
        request.editableContextSnapshot,
      ),
      publicText: request.instruction,
      effort: request.effort === "fast" ? "low" : "max",
      attachmentHandles: request.attachments
        .filter((attachment) => attachment.valid)
        .map((attachment) => attachment.id),
    })
    return { accepted: true }
  }

  stopTurn(workspaceId: string): Promise<void> {
    return this.codex.stopTurn(workspaceId)
  }

  pickAttachments(workspaceId: string, existingHandles: readonly string[]) {
    return this.codex.pickAttachments(workspaceId, existingHandles)
  }

  registerAttachmentPaths(
    workspaceId: string,
    source: "drop" | "paste",
    paths: readonly string[],
    existingHandles: readonly string[],
  ) {
    return this.codex.registerAttachmentPaths(
      workspaceId,
      source,
      paths,
      existingHandles,
    )
  }

  respondPending(
    request: Parameters<CodexWorkspaceSessionAdapter["respondPending"]>[0],
  ): Promise<boolean> {
    return this.codex.respondPending(request)
  }

  answerFallbackDecision(
    request: Parameters<
      CodexWorkspaceSessionAdapter["answerFallbackDecision"]
    >[0],
  ): Promise<boolean> {
    return this.codex.answerFallbackDecision(request)
  }

  async deleteWorkspaceHistory(
    workspaceId: string,
  ): Promise<WorkspaceAdapterState> {
    const state = await this.history.deleteWorkspaceHistory(workspaceId)
    if (state.activeWorkspaceId !== null) await this.activateCodex(state)
    return state
  }

  private async activateCodex(state: WorkspaceAdapterState): Promise<void> {
    if (state.activeWorkspaceId === null) return
    const historyMode =
      state.history.mode === "ready" ||
      (this.hydrationMode === "demo" && state.history.mode === "ephemeral")
        ? "ready"
        : state.history.mode === "recovery_required"
          ? "recovery_required"
          : "read_only"
    try {
      await this.codex.activateWorkspace({
        workspaceId: state.activeWorkspaceId,
        historyMode,
      })
    } catch {
      // The Codex store already exposes a safe error code through subscribeCodex.
    }
  }

  private async performWorkspaceTransition(
    request: WorkspaceTransitionRequest,
  ): Promise<WorkspaceAdapterState> {
    const before = this.codex.snapshot()
    if (
      before.activeWorkspaceId !== request.fromWorkspaceId ||
      before.generation !== request.expectedGeneration ||
      request.fromWorkspaceId === request.toWorkspaceId
    ) {
      throw new Error("WORKSPACE-TRANSITION-STALE")
    }
    await this.codex.stopTurnAndWaitForTerminal({
      workspaceId: request.fromWorkspaceId,
      expectedGeneration: request.expectedGeneration,
    })

    let targetSelected = false
    try {
      const target = await this.history.selectWorkspace(request.toWorkspaceId)
      targetSelected = true
      await this.activateCodexStrict(target)
      return target
    } catch (error) {
      if (targetSelected) {
        try {
          const restored = await this.history.selectWorkspace(
            request.fromWorkspaceId,
          )
          await this.activateCodexStrict(restored)
        } catch {
          // Preserve the original transition failure; the next hydration retries restoration.
        }
      }
      throw error
    }
  }

  private async performWorkspaceCancellation(
    workspaceId: string,
    expectedUpdatedAt: string,
    expectedGeneration: number | null,
  ): Promise<WorkspaceAdapterState> {
    if (expectedGeneration !== null) {
      const before = this.codex.snapshot()
      if (
        before.activeWorkspaceId !== workspaceId ||
        before.generation !== expectedGeneration
      ) {
        throw new Error("WORKSPACE-CANCEL-STALE")
      }
      await this.codex.stopTurnAndWaitForTerminal({
        workspaceId,
        expectedGeneration,
      })
    }
    return this.history.cancelWorkspace(workspaceId, expectedUpdatedAt)
  }

  private async activateCodexStrict(
    state: WorkspaceAdapterState,
  ): Promise<void> {
    if (state.activeWorkspaceId === null) {
      throw new Error("WORKSPACE-ACTIVATION-MISSING")
    }
    const historyMode =
      state.history.mode === "ready" ||
      (this.hydrationMode === "demo" && state.history.mode === "ephemeral")
        ? "ready"
        : state.history.mode === "recovery_required"
          ? "recovery_required"
          : "read_only"
    await this.codex.activateWorkspace({
      workspaceId: state.activeWorkspaceId,
      historyMode,
    })
  }
}

export function createCodexComposedWorkspaceViewAdapter(
  historyTransport: WorkspaceHistoryTransport,
  codexTransport: CodexTransport = historyTransport.kind === "tauri"
    ? new TauriCodexTransport()
    : new DemoCodexTransport(),
): WorkspaceViewAdapter {
  return new CodexComposedWorkspaceViewAdapter(historyTransport, codexTransport)
}
