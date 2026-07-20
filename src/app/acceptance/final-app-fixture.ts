import type {
  AppCleanupFailedV1,
  AppLifecycleCleanupFailedListener,
  AppLifecycleCloseListener,
  AppLifecycleGateway,
  AppCloseRequestedV1,
} from "@/features/app-lifecycle"
import type { CodexSemanticTimelineEvent } from "@/features/codex"
import type {
  LocalePreferenceStore,
  SupportedLocale,
} from "@/features/localization"
import type {
  AttachmentRegistrationResponse,
  AttachmentSource,
} from "@/lib/contracts"
import type {
  CharacterContext,
  ProjectContext,
  VersionedCharacterContext,
  VersionedProjectContext,
  WorkspaceTurnContextSnapshot,
} from "@/lib/contracts/workspace-context"
import { bundledHiyoriCharacterContextPreset } from "@/lib/contracts/workspace-context"
import type {
  AppQuitPreparationRequest,
  ContextSnapshotItem,
  ReasoningEffort,
  SendTurnRequest,
  WorkspaceAdapterState,
  WorkspaceCodexState,
  WorkspaceCreateRequest,
  WorkspaceRecord,
  WorkspaceTransitionRequest,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"
import type { AcceptanceResourceSnapshot } from "@/app/acceptance/final-acceptance-harness"

const projectHash = "1".repeat(64)
const characterHash = "2".repeat(64)
const snapshotHash = "3".repeat(64)
const fixtureTime = "2026-07-19T00:00:00.000Z"

const emptyProjectContext: ProjectContext = {
  goal: "Ship a trustworthy local coding workspace.",
  constraints: "Keep Git observation read-only.",
  definitionOfDone: ["Focused acceptance tests pass"],
  technicalReferences: ["docs/requirements/desktop-shell.md"],
  userNotes: "",
}

const emptyCharacterContext: CharacterContext =
  bundledHiyoriCharacterContextPreset

interface StoredDraft {
  text: string
  effort: ReasoningEffort
  revision: number
  contextSnapshots: readonly ContextSnapshotItem[]
}

interface StoredContext {
  project: VersionedProjectContext
  character: VersionedCharacterContext
}

export class MemoryLocalePreferenceStore implements LocalePreferenceStore {
  readonly persistence = "session-only" as const

  constructor(public value: SupportedLocale) {}

  read(): SupportedLocale {
    return this.value
  }

  write(locale: SupportedLocale): boolean {
    this.value = locale
    return true
  }
}

function contextFor(projectId: string): StoredContext {
  return {
    project: {
      schemaVersion: 1,
      projectId,
      version: 1,
      contentHash: projectHash,
      updatedAt: fixtureTime,
      context: structuredClone(emptyProjectContext),
    },
    character: {
      schemaVersion: 1,
      packId: "builtin:hiyori_pro",
      version: 1,
      contentHash: characterHash,
      updatedAt: fixtureTime,
      context: structuredClone(emptyCharacterContext),
    },
  }
}

function initialCodexState(workspaceId: string): WorkspaceCodexState {
  return {
    activeWorkspaceId: workspaceId,
    generation: 1,
    phase: "ready",
    connected: true,
    readiness: {
      ready: true,
      fastAvailable: true,
      maxAvailable: true,
      reasonCode: null,
    },
    pendingRequests: [],
    timeline: [],
    errorCode: null,
  }
}

function timelineFor(
  request: SendTurnRequest,
  generation: number,
): readonly CodexSemanticTimelineEvent[] {
  const base = (sequence: number) => ({
    id: `acceptance-event-${String(sequence)}`,
    stableId: `${request.workspaceId}:${String(generation)}:acceptance:${String(sequence)}`,
    sourceEventId: `acceptance-event-${String(sequence)}`,
    workspaceId: request.workspaceId,
    generation,
    sourceSequence: sequence,
    occurredAt: `2026-07-19T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    durable: true,
  })
  return [
    {
      ...base(1),
      kind: "user",
      status: "accepted",
      text: request.instruction,
      effort: request.effort === "max" ? "max" : "low",
      attachmentCount: request.attachments.length,
    },
    {
      ...base(2),
      kind: "assistant",
      status: "completed",
      itemHandle: "acceptance-assistant",
      text: "Acceptance implementation completed with focused verification.",
    },
    {
      ...base(3),
      kind: "file",
      status: "completed",
      itemHandle: "acceptance-file",
      pathAlias: "<workspace>/src/acceptance.ts",
      changeKind: "update",
    },
    {
      ...base(4),
      kind: "completion",
      status: "completed",
      threadHandle: "thread-acceptance",
      turnHandle: "turn-acceptance",
    },
  ]
}

export class FinalAcceptanceWorkspaceFixture implements WorkspaceViewAdapter {
  readonly connected = true
  readonly hydrationMode = "demo" as const
  readonly sentTurns: SendTurnRequest[] = []
  readonly preparedQuitRequests: AppQuitPreparationRequest[] = []
  readonly repairedWorkspaceIds: string[] = []
  readonly savedProjectContexts: VersionedProjectContext[] = []
  readonly suppressedLateEvents: string[] = []
  retainedPrivatePathCount = 0
  restartCount = 0

  readonly #listeners = new Set<(state: WorkspaceCodexState) => void>()
  readonly #drafts = new Map<string, StoredDraft>()
  readonly #contexts = new Map<string, StoredContext>()
  readonly #characterContexts = new Map<string, VersionedCharacterContext>([
    ["builtin:hiyori_pro", contextFor("__app_character__").character],
  ])
  readonly #timeline = new Map<string, readonly CodexSemanticTimelineEvent[]>()
  readonly #attachmentPickerResponses: AttachmentRegistrationResponse[] = []
  #workspaces: WorkspaceRecord[]
  #activeWorkspaceId: string
  #codex: WorkspaceCodexState
  #workspaceSequence = 1

  constructor(workspaceCount = 2) {
    this.#workspaces = Array.from({ length: workspaceCount }, (_, index) => ({
      id:
        index === 0
          ? "workspace-primary"
          : `workspace-existing-${String(index)}`,
      repository: "coding-wife",
      projectId: "project-acceptance",
      name: index === 0 ? "primary" : `existing-${String(index)}`,
      branch: "develop",
      lifecycle: index === 0 ? "in_progress" : "backlog",
      health: "ready",
      updatedAt: fixtureTime,
    }))
    this.#activeWorkspaceId = this.#workspaces[0]?.id ?? "workspace-primary"
    this.#codex = initialCodexState(this.#activeWorkspaceId)
    for (const workspace of this.#workspaces) {
      this.#drafts.set(workspace.id, {
        text: "",
        effort: "fast",
        revision: 1,
        contextSnapshots: [],
      })
      if (!this.#contexts.has(workspace.projectId ?? "project-acceptance")) {
        this.#contexts.set(
          workspace.projectId ?? "project-acceptance",
          contextFor(workspace.projectId ?? "project-acceptance"),
        )
      }
      this.#timeline.set(workspace.id, [])
    }
  }

  get activeWorkspaceId(): string {
    return this.#activeWorkspaceId
  }

  get codexListenerCount(): number {
    return this.#listeners.size
  }

  queueAttachmentPickerResponse(
    response: AttachmentRegistrationResponse,
  ): void {
    this.#attachmentPickerResponses.push(structuredClone(response))
  }

  loadState = (): Promise<WorkspaceAdapterState> =>
    Promise.resolve(this.snapshot())

  codexSnapshot = (): WorkspaceCodexState => structuredClone(this.#codex)

  subscribeCodex = (
    listener: (state: WorkspaceCodexState) => void,
  ): (() => void) => {
    this.#listeners.add(listener)
    listener(this.codexSnapshot())
    return () => this.#listeners.delete(listener)
  }

  saveDraft = (
    workspaceId: string,
    text: string,
    effort: ReasoningEffort,
  ): Promise<void> => {
    const current = this.draft(workspaceId)
    this.#drafts.set(workspaceId, {
      ...current,
      text,
      effort,
      revision: current.revision + 1,
    })
    return Promise.resolve()
  }

  requestAddWorkspace = (
    request: WorkspaceCreateRequest,
  ): Promise<WorkspaceAdapterState> => {
    this.#workspaceSequence += 1
    const workspaceId = `workspace-acceptance-${String(this.#workspaceSequence)}`
    this.#workspaces = [
      ...this.#workspaces,
      {
        id: workspaceId,
        projectId: request.projectId,
        repository: "coding-wife",
        name: request.name,
        branch: `coding-wife/${workspaceId}`,
        lifecycle: "backlog",
        health: "ready",
        updatedAt: fixtureTime,
      },
    ]
    this.#drafts.set(workspaceId, {
      text: "",
      effort: "fast",
      revision: 1,
      contextSnapshots: [],
    })
    if (!this.#contexts.has(request.projectId)) {
      this.#contexts.set(request.projectId, contextFor(request.projectId))
    }
    this.#timeline.set(workspaceId, [])
    this.activate(workspaceId)
    return Promise.resolve(this.snapshot())
  }

  selectWorkspace = (workspaceId: string): Promise<WorkspaceAdapterState> => {
    this.requireWorkspace(workspaceId)
    this.activate(workspaceId)
    return Promise.resolve(this.snapshot())
  }

  stopAndSwitchWorkspace = (
    request: WorkspaceTransitionRequest,
  ): Promise<WorkspaceAdapterState> => {
    this.requireWorkspace(request.fromWorkspaceId)
    this.requireWorkspace(request.toWorkspaceId)
    this.activate(request.toWorkspaceId)
    return Promise.resolve(this.snapshot())
  }

  recheckWorkspace = (workspaceId: string): Promise<WorkspaceAdapterState> => {
    this.requireWorkspace(workspaceId)
    return Promise.resolve(this.snapshot())
  }

  repairWorkspace = (workspaceId: string): Promise<WorkspaceAdapterState> => {
    this.repairedWorkspaceIds.push(workspaceId)
    this.#workspaces = this.#workspaces.map((workspace) =>
      workspace.id === workspaceId
        ? { ...workspace, health: "ready" as const }
        : workspace,
    )
    return Promise.resolve(this.snapshot())
  }

  captureContext = (
    workspaceId: string,
    source: ContextSnapshotItem["source"],
  ): Promise<ContextSnapshotItem> => {
    this.requireWorkspace(workspaceId)
    return Promise.resolve({
      id: `context-${source}`,
      source,
      label: source === "git_diff" ? "Git diff" : "Workspace files",
      capturedAt: fixtureTime,
      byteCount: 128,
    })
  }

  pickAttachments = (
    workspaceId: string,
  ): Promise<AttachmentRegistrationResponse> => {
    this.requireWorkspace(workspaceId)
    const queued = this.#attachmentPickerResponses.shift()
    if (queued !== undefined) return Promise.resolve(structuredClone(queued))
    return Promise.resolve(
      this.attachmentResponse(
        "picker",
        "acceptance.png",
        "assets/acceptance.png",
        25 * 1024 * 1024,
      ),
    )
  }

  registerAttachmentPaths = (
    workspaceId: string,
    source: "drop" | "paste",
    paths: readonly string[],
  ): Promise<AttachmentRegistrationResponse> => {
    this.requireWorkspace(workspaceId)
    const candidate = paths[0]
    if (candidate === undefined)
      return Promise.resolve({ items: [], rejections: [] })
    if (/\.(?:command|exe|sh)$/iu.test(candidate)) {
      return Promise.resolve({
        items: [],
        rejections: [
          {
            candidateIndex: 0,
            code: "CODEX-ATTACHMENT-EXECUTABLE",
            recoverable: false,
          },
        ],
      })
    }
    const name = candidate.split(/[\\/]/u).at(-1) ?? "attachment"
    return Promise.resolve(
      this.attachmentResponse(source, name, `files/${name}`),
    )
  }

  loadProjectContext = (projectId: string): Promise<VersionedProjectContext> =>
    Promise.resolve(structuredClone(this.context(projectId).project))

  loadCharacterContext = (
    packId: string,
    displayName: string,
  ): Promise<VersionedCharacterContext> => {
    let current = this.#characterContexts.get(packId)
    if (current === undefined) {
      current = {
        ...contextFor("__app_character__").character,
        packId,
        context: { ...emptyCharacterContext, displayName },
      }
      this.#characterContexts.set(packId, current)
    }
    return Promise.resolve(structuredClone(current))
  }

  saveProjectContext = (
    projectId: string,
    expectedVersion: number,
    project: ProjectContext,
  ): Promise<VersionedProjectContext> => {
    const context = this.context(projectId)
    if (context.project.version !== expectedVersion) {
      return Promise.reject(new Error("PROJECT-CONTEXT-CONFLICT"))
    }
    const saved: VersionedProjectContext = {
      ...context.project,
      version: expectedVersion + 1,
      contentHash: "4".repeat(64),
      updatedAt: "2026-07-19T00:01:00.000Z",
      context: structuredClone(project),
    }
    this.#contexts.set(projectId, { ...context, project: saved })
    this.savedProjectContexts.push(structuredClone(saved))
    return Promise.resolve(structuredClone(saved))
  }

  saveCharacterContext = (
    packId: string,
    expectedVersion: number,
    character: CharacterContext,
  ): Promise<VersionedCharacterContext> => {
    const current = this.#characterContexts.get(packId)
    if (current === undefined || current.version !== expectedVersion) {
      return Promise.reject(new Error("APP-CHARACTER-CONTEXT-CONFLICT"))
    }
    const saved: VersionedCharacterContext = {
      ...current,
      version: expectedVersion + 1,
      contentHash: "5".repeat(64),
      updatedAt: "2026-07-19T00:01:00.000Z",
      context: structuredClone(character),
    }
    this.#characterContexts.set(packId, saved)
    return Promise.resolve(structuredClone(saved))
  }

  getTurnContextSnapshot = (
    workspaceId: string,
  ): Promise<WorkspaceTurnContextSnapshot> => {
    const workspace = this.#workspaces.find(
      (candidate) => candidate.id === workspaceId,
    )
    if (workspace === undefined) throw new Error("WORKSPACE-NOT-FOUND")
    const context = this.context(workspace.projectId ?? "project-acceptance")
    const character = this.#characterContexts.get("builtin:hiyori_pro")
    if (character === undefined) throw new Error("CHARACTER-CONTEXT-NOT-FOUND")
    return Promise.resolve({
      schemaVersion: 1,
      workspaceId,
      projectVersion: context.project.version,
      projectHash: context.project.contentHash,
      characterPackId: character.packId,
      characterVersion: character.version,
      characterHash: character.contentHash,
      snapshotHash,
      capturedAt: fixtureTime,
      project: structuredClone(context.project.context),
      character: structuredClone(character.context),
    })
  }

  sendTurn = (
    request: SendTurnRequest,
  ): Promise<{ readonly accepted: boolean }> => {
    this.requireWorkspace(request.workspaceId)
    if (request.workspaceId !== this.#activeWorkspaceId) {
      return Promise.resolve({ accepted: false })
    }
    this.sentTurns.push(structuredClone(request))
    this.#codex = { ...this.#codex, phase: "running" }
    this.publish()
    return Promise.resolve({ accepted: true })
  }

  stopTurn = (): Promise<void> => {
    this.#codex = { ...this.#codex, phase: "ready" }
    this.publish()
    return Promise.resolve()
  }

  prepareAppQuit = (request: AppQuitPreparationRequest): Promise<void> => {
    this.preparedQuitRequests.push(structuredClone(request))
    return Promise.resolve()
  }

  completeTurn(): void {
    const request = this.sentTurns.at(-1)
    if (request === undefined) throw new Error("No accepted turn to complete")
    const generation = this.#codex.generation ?? 1
    const timeline = timelineFor(request, generation)
    this.#timeline.set(request.workspaceId, timeline)
    this.#codex = { ...this.#codex, phase: "ready", timeline }
    this.publish()
  }

  markActiveRepositoryMissing(): void {
    this.#workspaces = this.#workspaces.map((workspace) =>
      workspace.id === this.#activeWorkspaceId
        ? { ...workspace, health: "missing" as const }
        : workspace,
    )
  }

  restart(): void {
    this.restartCount += 1
    this.#codex = {
      ...initialCodexState(this.#activeWorkspaceId),
      generation: (this.#codex.generation ?? 0) + 1,
      timeline: this.#timeline.get(this.#activeWorkspaceId) ?? [],
    }
  }

  publishLateEvent(workspaceId: string, generation: number): void {
    if (
      workspaceId !== this.#activeWorkspaceId ||
      generation !== this.#codex.generation
    ) {
      this.suppressedLateEvents.push(`${workspaceId}:${String(generation)}`)
      return
    }
    this.publish()
  }

  resourceSnapshot(lifecycleListeners = 0): AcceptanceResourceSnapshot {
    return {
      listeners: this.#listeners.size + lifecycleListeners,
      processes: 0,
      queuedTasks: this.#codex.phase === "running" ? 1 : 0,
    }
  }

  private snapshot(): WorkspaceAdapterState {
    const draft = this.draft(this.#activeWorkspaceId)
    return {
      workspaces: structuredClone(this.#workspaces),
      activeWorkspaceId: this.#activeWorkspaceId,
      draft: structuredClone(draft),
      timeline: [],
      lastSummary:
        (this.#timeline.get(this.#activeWorkspaceId)?.length ?? 0) > 0
          ? {
              eventId: "acceptance-event-4",
              sequence: 4,
              text: "Acceptance implementation completed with focused verification.",
              updatedAt: "2026-07-19T00:00:04.000Z",
            }
          : null,
      history: { mode: "ephemeral", errorCode: null, backupName: null },
    }
  }

  private activate(workspaceId: string): void {
    this.#activeWorkspaceId = workspaceId
    this.#codex = {
      ...initialCodexState(workspaceId),
      generation: (this.#codex.generation ?? 0) + 1,
      timeline: this.#timeline.get(workspaceId) ?? [],
    }
    this.publish()
  }

  private publish(): void {
    const snapshot = this.codexSnapshot()
    for (const listener of this.#listeners) listener(snapshot)
  }

  private requireWorkspace(workspaceId: string): void {
    if (!this.#workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw new Error("WORKSPACE-NOT-FOUND")
    }
  }

  private draft(workspaceId: string): StoredDraft {
    const draft = this.#drafts.get(workspaceId)
    if (draft === undefined) throw new Error("WORKSPACE-DRAFT-NOT-FOUND")
    return draft
  }

  private context(projectId: string): StoredContext {
    const existing = this.#contexts.get(projectId)
    if (existing !== undefined) return existing
    const context = contextFor(projectId)
    this.#contexts.set(projectId, context)
    return context
  }

  private attachmentResponse(
    source: AttachmentSource,
    name: string,
    relativePath: string,
    sizeBytes = 128,
  ): AttachmentRegistrationResponse {
    return {
      items: [
        {
          schemaVersion: 1,
          handle: `attachment-${source}-acceptance`,
          name,
          relativePath,
          sizeBytes,
          kind: name.endsWith(".png") ? "image" : "file",
          source,
          expiresAt: "2026-07-19T00:30:00.000Z",
        },
      ],
      rejections: [],
    }
  }
}

export class FinalAcceptanceLifecycleFixture implements AppLifecycleGateway {
  readonly confirmedRequestIds: string[] = []
  readonly canceledRequestIds: string[] = []
  readonly retriedRequestIds: string[] = []
  readonly #closeListeners = new Set<AppLifecycleCloseListener>()
  readonly #cleanupListeners = new Set<AppLifecycleCleanupFailedListener>()

  get listenerCount(): number {
    return this.#closeListeners.size + this.#cleanupListeners.size
  }

  listenCloseRequested(
    listener: AppLifecycleCloseListener,
  ): Promise<() => void> {
    this.#closeListeners.add(listener)
    return Promise.resolve(() => this.#closeListeners.delete(listener))
  }

  listenCleanupFailed(
    listener: AppLifecycleCleanupFailedListener,
  ): Promise<() => void> {
    this.#cleanupListeners.add(listener)
    return Promise.resolve(() => this.#cleanupListeners.delete(listener))
  }

  cancelQuit(requestId: string): Promise<void> {
    this.canceledRequestIds.push(requestId)
    return Promise.resolve()
  }

  confirmQuit(requestId: string): Promise<void> {
    this.confirmedRequestIds.push(requestId)
    return Promise.resolve()
  }

  retryCleanup(requestId: string): Promise<void> {
    this.retriedRequestIds.push(requestId)
    return Promise.resolve()
  }

  emitClose(request: AppCloseRequestedV1): void {
    for (const listener of this.#closeListeners) listener(request)
  }

  emitCleanupFailure(failure: AppCleanupFailedV1): void {
    for (const listener of this.#cleanupListeners) listener(failure)
  }
}
