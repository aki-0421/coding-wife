import {
  workspaceHistoryCommands,
  type PersistedContextSnapshot,
  type PersistedTimelinePage,
  type PersistedWorkspaceDraft,
  type WorkspaceStateSnapshot,
} from "@/lib/contracts/workspace-history"
import type {
  CharacterContext,
  ProjectContext,
  VersionedCharacterContext,
  VersionedProjectContext,
  WorkspaceEditableContext,
  WorkspaceTurnContextSnapshot,
} from "@/lib/contracts/workspace-context"
import { PersistedCodexEventProjector } from "@/features/workspace-persistence/codex-event-projector"
import {
  WorkspaceHistoryBoundaryError,
  type WorkspaceHistoryTransport,
} from "@/features/workspace-persistence/transport"
import type {
  ContextSnapshotItem,
  ReasoningEffort,
  WorkspaceAdapterState,
  WorkspaceAdapterTimelinePage,
  WorkspaceCreateRequest,
  WorkspaceTimelineItem,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"

function contextItem(snapshot: PersistedContextSnapshot): ContextSnapshotItem {
  return {
    id: snapshot.snapshotId,
    source: snapshot.source,
    label: snapshot.label,
    capturedAt: snapshot.capturedAt,
    byteCount: snapshot.byteCount,
  }
}

function timelineStatus(payload: Readonly<Record<string, unknown>>): {
  readonly status: string
  readonly errorCode?: string
} {
  const status = ["status", "lifecycle", "level"]
    .map((key) => payload[key])
    .find((value): value is string => typeof value === "string")
  const errorCode =
    typeof payload.errorCode === "string" ? payload.errorCode : undefined
  return {
    status: status ?? "recorded",
    ...(errorCode === undefined ? {} : { errorCode }),
  }
}

export function projectWorkspaceState(
  state: WorkspaceStateSnapshot,
): WorkspaceAdapterState {
  const projectedTimeline = projectTimelinePage(state.timeline)
  return {
    projects: state.projects.map((project) => ({
      id: project.projectId,
      name: project.name,
      ...(project.githubRepository === null
        ? {}
        : { githubRepository: project.githubRepository }),
      health: project.health,
      workspaceCount: project.workspaceCount,
      updatedAt: project.updatedAt,
    })),
    workspaces: state.workspaces.map((workspace) => ({
      id: workspace.workspaceId,
      projectId: workspace.projectId,
      repository: workspace.repository,
      ...(workspace.githubRepository === null
        ? {}
        : { githubRepository: workspace.githubRepository }),
      name: workspace.name,
      branch: workspace.branch,
      lifecycle: workspace.lifecycle,
      ...(workspace.attention === null
        ? {}
        : { attention: workspace.attention }),
      health: workspace.health,
      updatedAt: workspace.updatedAt,
    })),
    activeWorkspaceId: state.activeWorkspaceId,
    draft:
      state.draft === null
        ? null
        : {
            text: state.draft.text,
            effort: state.draft.effort,
            revision: state.draft.revision,
            contextSnapshots: state.contextSnapshots.map(contextItem),
          },
    timeline: projectedTimeline.timeline,
    lastSummary:
      state.resumeState?.lastSummary === undefined ||
      state.resumeState.lastSummary === null
        ? null
        : {
            eventId: state.resumeState.lastSummary.eventId,
            sequence: state.resumeState.lastSummary.sequence,
            text: state.resumeState.lastSummary.text,
            updatedAt: state.resumeState.lastSummary.updatedAt,
          },
    timelineAnchor:
      state.resumeState?.timelineAnchor === undefined ||
      state.resumeState.timelineAnchor === null
        ? null
        : {
            eventId: state.resumeState.timelineAnchor.eventId,
            sequence: state.resumeState.timelineAnchor.sequence,
            offset: state.resumeState.timelineAnchor.offset,
            revision: state.resumeState.timelineAnchor.revision,
            wasClamped: state.resumeState.timelineAnchor.wasClamped,
          },
    nextBeforeSequence: projectedTimeline.nextBeforeSequence,
    history: {
      mode: state.history.mode,
      errorCode: state.history.errorCode,
      backupName: state.history.backupName,
    },
  }
}

export function projectTimelinePage(
  page: PersistedTimelinePage,
): WorkspaceAdapterTimelinePage {
  const codexProjector = new PersistedCodexEventProjector()
  const projectedTimeline = new Map<string, WorkspaceTimelineItem>()
  for (const event of [...page.items].sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    const semantic = codexProjector.project(event)
    if (semantic !== null) {
      projectedTimeline.set(`semantic:${semantic.stableId}`, semantic)
      continue
    }
    projectedTimeline.set(`history:${event.eventId}`, {
      id: event.eventId,
      sequence: event.sequence,
      producer: event.producer,
      kind: "history",
      domainKind: event.kind,
      occurredAt: event.occurredAt,
      ...timelineStatus(event.payload),
    })
  }
  return {
    timeline: [...projectedTimeline.values()],
    nextBeforeSequence: page.nextBeforeSequence,
  }
}

export class PersistentWorkspaceViewAdapter implements WorkspaceViewAdapter {
  readonly connected = false
  readonly hydrationMode: "native" | "demo"
  private readonly drafts = new Map<
    string,
    Pick<PersistedWorkspaceDraft, "text" | "effort" | "revision">
  >()
  private readonly draftQueues = new Map<string, Promise<void>>()
  private readonly deletingWorkspaces = new Set<string>()
  private requestCounter = 0

  constructor(private readonly transport: WorkspaceHistoryTransport) {
    this.hydrationMode = transport.kind === "tauri" ? "native" : "demo"
  }

  async loadState(): Promise<WorkspaceAdapterState> {
    return this.absorb(
      await this.transport.request(workspaceHistoryCommands.list, undefined),
    )
  }

  async selectWorkspace(workspaceId: string): Promise<WorkspaceAdapterState> {
    return this.absorb(
      await this.transport.request(workspaceHistoryCommands.select, {
        workspaceId,
      }),
    )
  }

  async recheckWorkspace(
    workspaceId: string,
    acceptObservedHead = false,
  ): Promise<WorkspaceAdapterState> {
    return this.absorb(
      await this.transport.request(workspaceHistoryCommands.recheck, {
        workspaceId,
        acceptObservedHead,
      }),
    )
  }

  async cancelWorkspace(
    workspaceId: string,
    expectedUpdatedAt: string,
  ): Promise<WorkspaceAdapterState> {
    await this.transport.request(workspaceHistoryCommands.cancel, {
      workspaceId,
      expectedUpdatedAt,
    })
    return this.absorb(
      await this.transport.request(workspaceHistoryCommands.list, undefined),
    )
  }

  async repairWorkspace(workspaceId: string): Promise<WorkspaceAdapterState> {
    return this.absorb(
      await this.transport.request(workspaceHistoryCommands.repair, {
        workspaceId,
      }),
    )
  }

  async unregisterProject(projectId: string): Promise<WorkspaceAdapterState> {
    return this.absorb(
      await this.transport.request(workspaceHistoryCommands.unregister, {
        projectId,
      }),
    )
  }

  async archiveWorkspace(workspaceId: string): Promise<WorkspaceAdapterState> {
    this.drafts.delete(workspaceId)
    return this.absorb(
      await this.transport.request(workspaceHistoryCommands.archive, {
        workspaceId,
      }),
    )
  }

  async requestAddProject(): Promise<WorkspaceAdapterState> {
    const response = await this.transport.request(
      workspaceHistoryCommands.pickRegister,
      undefined,
    )
    return this.absorb(response.state)
  }

  async requestAddWorkspace(
    request: WorkspaceCreateRequest,
  ): Promise<WorkspaceAdapterState> {
    this.requestCounter += 1
    const clientRequestId =
      this.transport.kind === "demo"
        ? `demo-workspace-create-${String(this.requestCounter)}`
        : `workspace-create-${globalThis.crypto.randomUUID()}`
    return this.absorb(
      await this.transport.request(workspaceHistoryCommands.createSession, {
        projectId: request.projectId,
        name: request.name,
        clientRequestId,
      }),
    )
  }

  async saveDraft(
    workspaceId: string,
    text: string,
    effort: ReasoningEffort,
  ): Promise<void> {
    if (this.deletingWorkspaces.has(workspaceId)) return
    const previousQueue = this.draftQueues.get(workspaceId) ?? Promise.resolve()
    const nextQueue = previousQueue
      .catch(() => undefined)
      .then(async () => {
        let current = this.drafts.get(workspaceId)
        if (current === undefined) {
          const state = await this.transport.request(
            workspaceHistoryCommands.select,
            { workspaceId },
          )
          this.absorb(state)
          current = this.drafts.get(workspaceId)
        }
        if (
          current === undefined ||
          (current.text === text && current.effort === effort)
        ) {
          return
        }
        try {
          this.rememberDraft(
            await this.transport.request(workspaceHistoryCommands.saveDraft, {
              workspaceId,
              text,
              effort,
              expectedRevision: current.revision,
            }),
          )
        } catch (error) {
          if (
            !(error instanceof WorkspaceHistoryBoundaryError) ||
            error.code !== "WORKSPACE-DRAFT-CONFLICT"
          ) {
            throw error
          }
          const refreshed = await this.transport.request(
            workspaceHistoryCommands.select,
            { workspaceId },
          )
          this.absorb(refreshed)
          const latest = this.drafts.get(workspaceId)
          if (latest === undefined) throw error
          this.rememberDraft(
            await this.transport.request(workspaceHistoryCommands.saveDraft, {
              workspaceId,
              text,
              effort,
              expectedRevision: latest.revision,
            }),
          )
        }
      })
    this.draftQueues.set(workspaceId, nextQueue)
    try {
      await nextQueue
    } finally {
      if (this.draftQueues.get(workspaceId) === nextQueue) {
        this.draftQueues.delete(workspaceId)
      }
    }
  }

  async saveTimelineAnchor(
    workspaceId: string,
    eventId: string,
    sequence: number,
    offset: number,
  ): Promise<void> {
    await this.transport.request(workspaceHistoryCommands.saveTimelineAnchor, {
      workspaceId,
      eventId,
      sequence,
      offset,
    })
  }

  async loadTimelinePage(
    workspaceId: string,
    beforeSequence: number,
  ): Promise<WorkspaceAdapterTimelinePage> {
    return projectTimelinePage(
      await this.transport.request(workspaceHistoryCommands.listTimeline, {
        workspaceId,
        beforeSequence,
        limit: 200,
        search: null,
      }),
    )
  }

  async captureContext(
    workspaceId: string,
    source: ContextSnapshotItem["source"],
  ): Promise<ContextSnapshotItem> {
    return contextItem(
      await this.transport.request(
        workspaceHistoryCommands.saveContextSnapshot,
        { workspaceId, source },
      ),
    )
  }

  loadEditableContext(workspaceId: string): Promise<WorkspaceEditableContext> {
    return this.transport.request(
      workspaceHistoryCommands.loadEditableContext,
      {
        workspaceId,
      },
    )
  }

  loadCharacterContext(): Promise<VersionedCharacterContext> {
    return this.transport.request(
      workspaceHistoryCommands.getCharacterContext,
      undefined,
    )
  }

  saveProjectContext(
    workspaceId: string,
    expectedVersion: number,
    context: ProjectContext,
  ): Promise<VersionedProjectContext> {
    return this.transport.request(workspaceHistoryCommands.saveProjectContext, {
      workspaceId,
      expectedVersion,
      context,
    })
  }

  saveCharacterContext(
    expectedVersion: number,
    context: CharacterContext,
  ): Promise<VersionedCharacterContext> {
    return this.transport.request(
      workspaceHistoryCommands.saveCharacterContext,
      { expectedVersion, context },
    )
  }

  getTurnContextSnapshot(
    workspaceId: string,
  ): Promise<WorkspaceTurnContextSnapshot> {
    return this.transport.request(
      workspaceHistoryCommands.getTurnContextSnapshot,
      { workspaceId },
    )
  }

  async deleteWorkspaceHistory(
    workspaceId: string,
  ): Promise<WorkspaceAdapterState> {
    if (this.deletingWorkspaces.has(workspaceId)) {
      throw new Error("WORKSPACE-DELETE-IN-PROGRESS")
    }
    this.deletingWorkspaces.add(workspaceId)
    try {
      await this.draftQueues.get(workspaceId)?.catch(() => undefined)
      const challenge = await this.transport.request(
        workspaceHistoryCommands.issueDeleteChallenge,
        { workspaceId },
      )
      const state = this.absorb(
        await this.transport.request(workspaceHistoryCommands.delete, {
          workspaceId,
          token: challenge.token,
        }),
      )
      this.drafts.delete(workspaceId)
      this.draftQueues.delete(workspaceId)
      return state
    } finally {
      this.deletingWorkspaces.delete(workspaceId)
    }
  }

  private absorb(state: WorkspaceStateSnapshot): WorkspaceAdapterState {
    if (state.draft !== null) this.rememberDraft(state.draft)
    return projectWorkspaceState(state)
  }

  private rememberDraft(draft: PersistedWorkspaceDraft): void {
    this.drafts.set(draft.workspaceId, {
      text: draft.text,
      effort: draft.effort,
      revision: draft.revision,
    })
  }
}
