import { workspaceHistoryCommands } from "@/lib/contracts"

import type { CodexHistoryEvent } from "@/features/codex/event-projection"
import type { CodexTransport } from "@/features/codex/transport"
import { CodexWorkspaceSessionAdapter } from "@/features/codex/workspace-session-adapter"
import type { CodexWorkspaceSessionSnapshot } from "@/features/codex/workspace-session-store"
import { PersistentWorkspaceViewAdapter } from "@/features/workspace-persistence/adapter"
import { composeTurnInstruction } from "@/features/workspace-persistence/turn-context"
import type { WorkspaceHistoryTransport } from "@/features/workspace-persistence/transport"
import type {
  AppQuitPreparationRequest,
  ProjectRegistrationResult,
  ReasoningEffort,
  SendTurnRequest,
  WorkspaceAdapterState,
  WorkspaceAdapterTimelinePage,
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

function hasActiveMainSession(
  snapshot: CodexWorkspaceSessionSnapshot,
  workspaceId: string,
): boolean {
  return (
    snapshot.activeWorkspaceId === workspaceId &&
    (["running", "waiting", "stopping"].includes(snapshot.phase) ||
      snapshot.pendingRequests.length > 0)
  )
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
  private workspaceArchive: {
    readonly key: string
    readonly operation: Promise<WorkspaceAdapterState>
  } | null = null
  private appQuitPreparation: {
    readonly key: string
    readonly operation: Promise<void>
  } | null = null
  private codexActivation: {
    readonly key: string
    readonly operation: Promise<void>
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

  async recheckWorkspace(
    workspaceId: string,
    acceptObservedHead = false,
  ): Promise<WorkspaceAdapterState> {
    const state = await this.history.recheckWorkspace(
      workspaceId,
      acceptObservedHead,
    )
    const workspace = state.workspaces.find(
      (candidate) => candidate.id === workspaceId,
    )
    if (workspace?.health === "ready") await this.activateCodex(state)
    return state
  }

  stopAndSwitchWorkspace(
    request: WorkspaceTransitionRequest,
  ): Promise<WorkspaceAdapterState> {
    if (this.workspaceCancellation !== null || this.workspaceArchive !== null) {
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

  prepareAppQuit(request: AppQuitPreparationRequest): Promise<void> {
    const key = `${request.workspaceId}:${String(request.expectedGeneration)}`
    if (this.appQuitPreparation !== null) {
      if (this.appQuitPreparation.key === key) {
        return this.appQuitPreparation.operation
      }
      return Promise.reject(new Error("APP-QUIT-PREPARATION-IN-PROGRESS"))
    }
    if (
      this.workspaceTransition !== null ||
      this.workspaceCancellation !== null ||
      this.workspaceArchive !== null
    ) {
      return Promise.reject(
        new Error("APP-QUIT-WORKSPACE-MUTATION-IN-PROGRESS"),
      )
    }
    const operation = this.performAppQuitPreparation(request).finally(() => {
      if (this.appQuitPreparation?.operation === operation) {
        this.appQuitPreparation = null
      }
    })
    this.appQuitPreparation = { key, operation }
    return operation
  }

  cancelWorkspace(
    workspaceId: string,
    expectedUpdatedAt: string,
    expectedGeneration: number | null = null,
  ): Promise<WorkspaceAdapterState> {
    if (this.workspaceTransition !== null || this.workspaceArchive !== null) {
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

  async unregisterProject(projectId: string): Promise<WorkspaceAdapterState> {
    const state = await this.history.unregisterProject(projectId)
    if (state.activeWorkspaceId !== null) await this.activateCodex(state)
    return state
  }

  archiveWorkspace(
    workspaceId: string,
    expectedGeneration: number | null = null,
  ): Promise<WorkspaceAdapterState> {
    if (
      this.workspaceTransition !== null ||
      this.workspaceCancellation !== null ||
      this.appQuitPreparation !== null
    ) {
      return Promise.reject(new Error("WORKSPACE-ARCHIVE-MUTATION-IN-PROGRESS"))
    }
    const key = `${workspaceId}:${String(expectedGeneration)}`
    if (this.workspaceArchive !== null) {
      if (this.workspaceArchive.key === key) {
        return this.workspaceArchive.operation
      }
      return Promise.reject(new Error("WORKSPACE-ARCHIVE-IN-PROGRESS"))
    }
    const operation = this.performWorkspaceArchive(
      workspaceId,
      expectedGeneration,
    ).finally(() => {
      if (this.workspaceArchive?.operation === operation) {
        this.workspaceArchive = null
      }
    })
    this.workspaceArchive = { key, operation }
    return operation
  }

  saveDraft(
    workspaceId: string,
    text: string,
    effort: ReasoningEffort,
  ): Promise<void> {
    return this.history.saveDraft(workspaceId, text, effort)
  }

  saveTimelineAnchor(
    workspaceId: string,
    eventId: string,
    sequence: number,
    offset: number,
  ): Promise<void> {
    return this.history.saveTimelineAnchor(
      workspaceId,
      eventId,
      sequence,
      offset,
    )
  }

  loadTimelinePage(
    workspaceId: string,
    beforeSequence: number,
  ): Promise<WorkspaceAdapterTimelinePage> {
    return this.history.loadTimelinePage(workspaceId, beforeSequence)
  }

  async requestAddProject(): Promise<ProjectRegistrationResult> {
    return this.history.requestAddProject()
  }

  initializeProjectGit(setupId: string): Promise<ProjectRegistrationResult> {
    return this.history.initializeProjectGit(setupId)
  }

  setupProjectGithub(
    setupId: string,
    owner: string,
    repository: string,
  ): Promise<ProjectRegistrationResult> {
    return this.history.setupProjectGithub(setupId, owner, repository)
  }

  cancelProjectSetup(setupId: string): Promise<void> {
    return this.history.cancelProjectSetup(setupId)
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

  loadProjectContext(projectId: string) {
    return this.history.loadProjectContext(projectId)
  }

  loadCharacterContext(packId: string, displayName: string) {
    return this.history.loadCharacterContext(packId, displayName)
  }

  saveProjectContext(
    projectId: string,
    expectedVersion: number,
    context: Parameters<
      PersistentWorkspaceViewAdapter["saveProjectContext"]
    >[2],
  ) {
    return this.history.saveProjectContext(projectId, expectedVersion, context)
  }

  saveCharacterContext(
    packId: string,
    expectedVersion: number,
    context: Parameters<
      PersistentWorkspaceViewAdapter["saveCharacterContext"]
    >[2],
  ) {
    return this.history.saveCharacterContext(packId, expectedVersion, context)
  }

  getTurnContextSnapshot(workspaceId: string) {
    return this.history.getTurnContextSnapshot(workspaceId)
  }

  async sendTurn(
    request: SendTurnRequest,
  ): Promise<{ readonly accepted: boolean }> {
    const readiness = this.codex.snapshot().readiness
    await this.codex.sendTurn({
      workspaceId: request.workspaceId,
      text: composeTurnInstruction(
        request.instruction,
        request.editableContextSnapshot,
      ),
      publicText: request.instruction,
      effort: request.effort === "off" ? null : request.effort,
      serviceTier: request.fastMode ? readiness.fastServiceTier : null,
      planMode: request.planMode ?? false,
      goalObjective: request.goalMode ? request.instruction.trim() : null,
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
    const current = this.codex.snapshot()
    if (
      current.activeWorkspaceId === state.activeWorkspaceId &&
      current.historyMode === historyMode &&
      current.connected &&
      current.readiness.ready &&
      current.threadHandle !== null
    ) {
      return
    }
    const key = `${state.activeWorkspaceId}:${historyMode}`
    if (this.codexActivation?.key === key) {
      await this.codexActivation.operation
      return
    }
    const operation = this.codex
      .activateWorkspace({
        workspaceId: state.activeWorkspaceId,
        historyMode,
      })
      .then(() => undefined)
      .catch(() => {
        // The Codex store already exposes a safe error code through subscribeCodex.
      })
      .finally(() => {
        if (this.codexActivation?.operation === operation) {
          this.codexActivation = null
        }
      })
    this.codexActivation = { key, operation }
    await operation
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

  private async performWorkspaceArchive(
    workspaceId: string,
    expectedGeneration: number | null,
  ): Promise<WorkspaceAdapterState> {
    const before = this.codex.snapshot()
    const activeMainSession = hasActiveMainSession(before, workspaceId)
    if (expectedGeneration === null) {
      if (activeMainSession) {
        throw new Error("WORKSPACE-ARCHIVE-ACTIVE")
      }
    } else {
      if (
        before.activeWorkspaceId !== workspaceId ||
        before.generation !== expectedGeneration
      ) {
        throw new Error("WORKSPACE-ARCHIVE-STALE")
      }
      if (activeMainSession) {
        await this.codex.stopTurnAndWaitForTerminal({
          workspaceId,
          expectedGeneration,
        })
      }
    }
    const state = await this.history.archiveWorkspace(workspaceId)
    if (state.activeWorkspaceId !== null) await this.activateCodex(state)
    return state
  }

  private async performAppQuitPreparation(
    request: AppQuitPreparationRequest,
  ): Promise<void> {
    const before = this.codex.snapshot()
    if (
      before.activeWorkspaceId !== request.workspaceId ||
      before.generation !== request.expectedGeneration
    ) {
      throw new Error("APP-QUIT-TURN-IDENTITY-STALE")
    }
    await this.codex.stopTurnAndWaitForTerminal({
      workspaceId: request.workspaceId,
      expectedGeneration: request.expectedGeneration,
    })
    await this.history.saveDraft(
      request.workspaceId,
      request.draftText,
      request.draftEffort,
    )
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
