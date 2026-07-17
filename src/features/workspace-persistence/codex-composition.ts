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
import type { WorkspaceHistoryTransport } from "@/features/workspace-persistence/transport"
import type {
  SendTurnRequest,
  WorkspaceAdapterState,
  WorkspaceCodexState,
  WorkspaceCreateRequest,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"

function publicCodexState(
  snapshot: CodexWorkspaceSessionSnapshot,
): WorkspaceCodexState {
  return {
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

  async sendTurn(
    request: SendTurnRequest,
  ): Promise<{ readonly accepted: boolean }> {
    await this.codex.sendTurn({
      workspaceId: request.workspaceId,
      text: request.instruction,
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
}

export function createCodexComposedWorkspaceViewAdapter(
  historyTransport: WorkspaceHistoryTransport,
  codexTransport: CodexTransport = historyTransport.kind === "tauri"
    ? new TauriCodexTransport()
    : new DemoCodexTransport(),
): WorkspaceViewAdapter {
  return new CodexComposedWorkspaceViewAdapter(historyTransport, codexTransport)
}
