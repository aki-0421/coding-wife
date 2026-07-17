import {
  workspaceHistoryCommands,
  type PersistedContextSnapshot,
  type PersistedWorkspaceDraft,
  type WorkspaceStateSnapshot,
} from "@/lib/contracts/workspace-history"
import { DemoWorkspaceHistoryTransport } from "@/features/workspace-persistence/demo-transport"
import {
  TauriWorkspaceHistoryTransport,
  WorkspaceHistoryBoundaryError,
  type WorkspaceHistoryTransport,
} from "@/features/workspace-persistence/transport"
import type {
  ContextSnapshotItem,
  ReasoningEffort,
  WorkspaceAdapterState,
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
  return {
    workspaces: state.workspaces.map((workspace) => ({
      id: workspace.workspaceId,
      repository: workspace.repository,
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
    timeline: state.timeline.items.map<WorkspaceTimelineItem>((event) => ({
      id: event.eventId,
      sequence: event.sequence,
      producer: event.producer,
      kind: event.kind,
      occurredAt: event.occurredAt,
      ...timelineStatus(event.payload),
    })),
    history: {
      mode: state.history.mode,
      errorCode: state.history.errorCode,
      backupName: state.history.backupName,
    },
  }
}

export class PersistentWorkspaceViewAdapter implements WorkspaceViewAdapter {
  readonly connected = false
  private readonly drafts = new Map<
    string,
    Pick<PersistedWorkspaceDraft, "text" | "effort" | "revision">
  >()
  private readonly draftQueues = new Map<string, Promise<void>>()
  private requestCounter = 0

  constructor(private readonly transport: WorkspaceHistoryTransport) {}

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
        fromWorkspaceId: request.fromWorkspaceId,
        name: request.name,
        goal: request.goal,
        clientRequestId,
      }),
    )
  }

  async saveDraft(
    workspaceId: string,
    text: string,
    effort: ReasoningEffort,
  ): Promise<void> {
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

  async deleteWorkspaceHistory(
    workspaceId: string,
  ): Promise<WorkspaceAdapterState> {
    const challenge = await this.transport.request(
      workspaceHistoryCommands.issueDeleteChallenge,
      { workspaceId },
    )
    return this.absorb(
      await this.transport.request(workspaceHistoryCommands.delete, {
        workspaceId,
        token: challenge.token,
      }),
    )
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

export function createWorkspaceViewAdapter(
  runtimeKind: "tauri" | "demo",
): WorkspaceViewAdapter {
  const transport =
    runtimeKind === "tauri"
      ? new TauriWorkspaceHistoryTransport()
      : new DemoWorkspaceHistoryTransport()
  return new PersistentWorkspaceViewAdapter(transport)
}
