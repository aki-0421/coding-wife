import {
  parsePersistedTimelineEvent,
  parseWorkspaceHistoryResponse,
  workspaceHistoryCommands,
  type AppendDomainEventRequest,
  type PersistedContextSnapshot,
  type PersistedTimelineEvent,
  type PersistedTimelinePage,
  type PersistedWorkspaceDraft,
  type PersistedWorkspaceSummary,
  type WorkspaceHistoryCommand,
  type WorkspaceHistoryRequestMap,
  type WorkspaceHistoryResponseMap,
  type WorkspaceStateSnapshot,
} from "@/lib/contracts/workspace-history"

import {
  WorkspaceHistoryBoundaryError,
  type WorkspaceHistoryTransport,
} from "@/features/workspace-persistence/transport"

const baseTimestamp = Date.parse("2026-07-18T00:00:00.000Z")

function demoWorkspace(
  workspaceId: string,
  name: string,
  branch: string,
  lifecycle: PersistedWorkspaceSummary["lifecycle"],
  attention: PersistedWorkspaceSummary["attention"],
  minute: number,
): PersistedWorkspaceSummary {
  const createdAt = new Date(baseTimestamp + minute * 60_000).toISOString()
  return {
    schemaVersion: 1,
    workspaceId,
    projectId: "project-demo",
    repository: "coding-wife",
    name,
    branch,
    head: "0123456789ab",
    detached: false,
    lifecycle,
    attention,
    health: "ready",
    createdAt,
    updatedAt: createdAt,
    lastSelectedAt: minute === 2 ? createdAt : null,
  }
}

function emptyDraft(
  workspaceId: string,
  updatedAt: string,
): PersistedWorkspaceDraft {
  return {
    schemaVersion: 1,
    workspaceId,
    text: "",
    effort: "fast",
    revision: 0,
    updatedAt,
  }
}

export class DemoWorkspaceHistoryTransport implements WorkspaceHistoryTransport {
  readonly kind = "demo"
  private workspaces: PersistedWorkspaceSummary[] = [
    demoWorkspace("sol-desktop", "sol-desktop", "main", "done", null, 0),
    demoWorkspace(
      "docs-driven-architecture",
      "docs-driven-architecture",
      "docs/history-kernel",
      "in_review",
      null,
      1,
    ),
    demoWorkspace(
      "build-live2d-desktop-app",
      "build-live2d-desktop-app",
      "feature/live2d-companion",
      "in_progress",
      "test_failed",
      2,
    ),
  ]
  private activeWorkspaceId = "build-live2d-desktop-app"
  private readonly drafts = new Map<string, PersistedWorkspaceDraft>(
    this.workspaces.map((workspace) => [
      workspace.workspaceId,
      emptyDraft(workspace.workspaceId, workspace.updatedAt),
    ]),
  )
  private readonly contexts = new Map<string, PersistedContextSnapshot[]>()
  private readonly events = new Map<string, PersistedTimelineEvent[]>()
  private readonly requestWorkspaces = new Map<string, string>()
  private readonly deleteTokens = new Map<string, string>()
  private clock = 180
  private workspaceCounter = 0
  private contextCounter = 0
  private eventCounter = 0

  constructor() {
    for (const workspace of this.workspaces) {
      this.events.set(workspace.workspaceId, [
        this.event(
          workspace.workspaceId,
          "work",
          "work.workspace.lifecycle.changed",
          {
            lifecycle: workspace.lifecycle,
          },
        ),
      ])
    }
  }

  request<K extends WorkspaceHistoryCommand>(
    command: K,
    request: WorkspaceHistoryRequestMap[K],
  ): Promise<WorkspaceHistoryResponseMap[K]> {
    try {
      const response = this.handle(command, request)
      return Promise.resolve(parseWorkspaceHistoryResponse(command, response))
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("Demo history request failed"),
      )
    }
  }

  private handle<K extends WorkspaceHistoryCommand>(
    command: K,
    request: WorkspaceHistoryRequestMap[K],
  ): unknown {
    switch (command) {
      case workspaceHistoryCommands.list:
        return this.state()
      case workspaceHistoryCommands.pickRegister:
        return this.pickRegister()
      case workspaceHistoryCommands.createSession:
        return this.createSession(
          request as WorkspaceHistoryRequestMap["workspace_create_session"],
        )
      case workspaceHistoryCommands.select:
        return this.select(
          (request as WorkspaceHistoryRequestMap["workspace_select"])
            .workspaceId,
          command,
        )
      case workspaceHistoryCommands.updateLifecycle:
        return this.updateLifecycle(
          request as WorkspaceHistoryRequestMap["workspace_update_lifecycle"],
        )
      case workspaceHistoryCommands.saveDraft:
        return this.saveDraft(
          request as WorkspaceHistoryRequestMap["workspace_save_draft"],
        )
      case workspaceHistoryCommands.saveContextSnapshot:
        return this.saveContext(
          request as WorkspaceHistoryRequestMap["workspace_save_context_snapshot"],
        )
      case workspaceHistoryCommands.listTimeline:
        return this.timeline(
          request as WorkspaceHistoryRequestMap["workspace_list_timeline"],
        )
      case workspaceHistoryCommands.issueDeleteChallenge:
        return this.issueDeleteChallenge(
          (
            request as WorkspaceHistoryRequestMap["workspace_issue_delete_challenge"]
          ).workspaceId,
        )
      case workspaceHistoryCommands.delete:
        return this.delete(
          request as WorkspaceHistoryRequestMap["workspace_delete"],
        )
      case workspaceHistoryCommands.appendDomainEvent:
        return this.appendDomainEvent(request as AppendDomainEventRequest)
    }
  }

  private state(): WorkspaceStateSnapshot {
    const active = this.workspace(
      this.activeWorkspaceId,
      workspaceHistoryCommands.list,
    )
    return {
      schemaVersion: 1,
      history: {
        schemaVersion: 1,
        mode: "ready",
        errorCode: null,
        backupName: null,
      },
      workspaces: [...this.workspaces],
      activeWorkspaceId: active.workspaceId,
      draft: this.drafts.get(active.workspaceId) ?? null,
      contextSnapshots: [...(this.contexts.get(active.workspaceId) ?? [])],
      timeline: this.timeline({
        workspaceId: active.workspaceId,
        beforeSequence: null,
        limit: 200,
        search: null,
      }),
    }
  }

  private pickRegister(): WorkspaceHistoryResponseMap["workspace_pick_register"] {
    const existing = this.workspaces.find(
      (workspace) =>
        workspace.workspaceId === "workspace-demo-selected-project",
    )
    if (existing === undefined) {
      const timestamp = this.timestamp()
      const workspace: PersistedWorkspaceSummary = {
        schemaVersion: 1,
        workspaceId: "workspace-demo-selected-project",
        projectId: "project-demo-selected",
        repository: "selected-project",
        name: "selected-project",
        branch: "main",
        head: "unborn",
        detached: false,
        lifecycle: "backlog",
        attention: null,
        health: "ready",
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSelectedAt: timestamp,
      }
      this.workspaces = [...this.workspaces, workspace]
      this.drafts.set(
        workspace.workspaceId,
        emptyDraft(workspace.workspaceId, timestamp),
      )
      this.events.set(workspace.workspaceId, [
        this.event(
          workspace.workspaceId,
          "work",
          "work.workspace.lifecycle.changed",
          {
            lifecycle: "backlog",
          },
        ),
      ])
    }
    this.activeWorkspaceId = "workspace-demo-selected-project"
    return { schemaVersion: 1, outcome: "selected", state: this.state() }
  }

  private createSession(
    request: WorkspaceHistoryRequestMap["workspace_create_session"],
  ): WorkspaceStateSnapshot {
    const existingId = this.requestWorkspaces.get(request.clientRequestId)
    if (existingId !== undefined) {
      return this.select(existingId, workspaceHistoryCommands.createSession)
    }
    const source = this.workspace(
      request.fromWorkspaceId,
      workspaceHistoryCommands.createSession,
    )
    this.workspaceCounter += 1
    const workspaceId = `workspace-demo-session-${String(this.workspaceCounter)}`
    const timestamp = this.timestamp()
    const workspace: PersistedWorkspaceSummary = {
      ...source,
      workspaceId,
      name: request.name,
      lifecycle: "backlog",
      attention: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSelectedAt: timestamp,
    }
    this.workspaces = [...this.workspaces, workspace]
    this.drafts.set(workspaceId, {
      ...emptyDraft(workspaceId, timestamp),
      text: request.goal,
    })
    this.events.set(workspaceId, [
      this.event(workspaceId, "work", "work.workspace.lifecycle.changed", {
        lifecycle: "backlog",
      }),
    ])
    this.requestWorkspaces.set(request.clientRequestId, workspaceId)
    this.activeWorkspaceId = workspaceId
    return this.state()
  }

  private select(
    workspaceId: string,
    operation: WorkspaceHistoryCommand,
  ): WorkspaceStateSnapshot {
    this.workspace(workspaceId, operation)
    this.activeWorkspaceId = workspaceId
    return this.state()
  }

  private updateLifecycle(
    request: WorkspaceHistoryRequestMap["workspace_update_lifecycle"],
  ): PersistedWorkspaceSummary {
    const current = this.workspace(
      request.workspaceId,
      workspaceHistoryCommands.updateLifecycle,
    )
    if (current.updatedAt !== request.expectedUpdatedAt) {
      throw this.error(
        "WORKSPACE-REVISION-CONFLICT",
        workspaceHistoryCommands.updateLifecycle,
        true,
      )
    }
    const updated = {
      ...current,
      lifecycle: request.lifecycle,
      updatedAt: this.timestamp(),
    }
    this.replaceWorkspace(updated)
    this.pushEvent(
      this.event(
        request.workspaceId,
        "work",
        "work.workspace.lifecycle.changed",
        {
          lifecycle: request.lifecycle,
        },
      ),
    )
    return updated
  }

  private saveDraft(
    request: WorkspaceHistoryRequestMap["workspace_save_draft"],
  ): PersistedWorkspaceDraft {
    const current = this.drafts.get(request.workspaceId)
    if (current === undefined) {
      throw this.error(
        "WORKSPACE-NOT-FOUND",
        workspaceHistoryCommands.saveDraft,
        false,
      )
    }
    if (current.revision !== request.expectedRevision) {
      throw this.error(
        "WORKSPACE-DRAFT-CONFLICT",
        workspaceHistoryCommands.saveDraft,
        true,
      )
    }
    const draft: PersistedWorkspaceDraft = {
      ...current,
      text: request.text,
      effort: request.effort,
      revision: current.revision + 1,
      updatedAt: this.timestamp(),
    }
    this.drafts.set(request.workspaceId, draft)
    return draft
  }

  private saveContext(
    request: WorkspaceHistoryRequestMap["workspace_save_context_snapshot"],
  ): PersistedContextSnapshot {
    this.workspace(
      request.workspaceId,
      workspaceHistoryCommands.saveContextSnapshot,
    )
    if (request.source === "terminal_output") {
      throw this.error(
        "WORKSPACE-CONTEXT-SOURCE-UNAVAILABLE",
        workspaceHistoryCommands.saveContextSnapshot,
        true,
      )
    }
    this.contextCounter += 1
    const digit = (this.contextCounter % 16).toString(16)
    const label = {
      files: "Repository files",
      git_diff: "Working tree diff",
    }[request.source]
    const snapshot: PersistedContextSnapshot = {
      schemaVersion: 1,
      snapshotId: `context-demo-${String(this.contextCounter)}`,
      workspaceId: request.workspaceId,
      source: request.source,
      label,
      capturedAt: this.timestamp(),
      byteCount: new TextEncoder().encode(`demo ${request.source}`).byteLength,
      contentHash: digit.repeat(64),
    }
    const contexts = [
      ...(this.contexts.get(request.workspaceId) ?? []),
      snapshot,
    ]
    this.contexts.set(request.workspaceId, contexts.slice(-10))
    return snapshot
  }

  private timeline(
    request: WorkspaceHistoryRequestMap["workspace_list_timeline"],
  ): PersistedTimelinePage {
    this.workspace(request.workspaceId, workspaceHistoryCommands.listTimeline)
    const search = request.search?.trim().toLocaleLowerCase() ?? ""
    const before = request.beforeSequence ?? Number.MAX_SAFE_INTEGER
    const matches = (this.events.get(request.workspaceId) ?? []).filter(
      (event) =>
        event.sequence < before &&
        (search.length === 0 ||
          `${event.kind} ${JSON.stringify(event.payload)}`
            .toLocaleLowerCase()
            .includes(search)),
    )
    const limit = Math.min(Math.max(request.limit, 1), 200)
    const items = matches.slice(-limit)
    const hasMore = matches.length > items.length
    return {
      schemaVersion: 1,
      items,
      nextBeforeSequence: hasMore ? (items[0]?.sequence ?? null) : null,
    }
  }

  private issueDeleteChallenge(
    workspaceId: string,
  ): WorkspaceHistoryResponseMap["workspace_issue_delete_challenge"] {
    this.workspace(workspaceId, workspaceHistoryCommands.issueDeleteChallenge)
    const token = `delete-demo-${workspaceId}`
    this.deleteTokens.set(token, workspaceId)
    return {
      schemaVersion: 1,
      workspaceId,
      token,
      expiresAt: new Date(
        baseTimestamp + (this.clock + 60) * 1_000,
      ).toISOString(),
    }
  }

  private delete(
    request: WorkspaceHistoryRequestMap["workspace_delete"],
  ): WorkspaceStateSnapshot {
    if (this.deleteTokens.get(request.token) !== request.workspaceId) {
      throw this.error(
        "WORKSPACE-DELETE-TOKEN-INVALID",
        workspaceHistoryCommands.delete,
        false,
      )
    }
    if (this.workspaces.length === 1) {
      throw this.error(
        "WORKSPACE-DEMO-EMPTY",
        workspaceHistoryCommands.delete,
        false,
      )
    }
    this.deleteTokens.delete(request.token)
    this.workspaces = this.workspaces.filter(
      (workspace) => workspace.workspaceId !== request.workspaceId,
    )
    this.drafts.delete(request.workspaceId)
    this.contexts.delete(request.workspaceId)
    this.events.delete(request.workspaceId)
    this.activeWorkspaceId =
      this.activeWorkspaceId === request.workspaceId
        ? (this.workspaces[0]?.workspaceId ?? "")
        : this.activeWorkspaceId
    return this.state()
  }

  private appendDomainEvent(
    request: AppendDomainEventRequest,
  ): WorkspaceHistoryResponseMap["history_append_domain_event"] {
    const existing = [...this.events.values()]
      .flat()
      .find((event) => event.eventId === request.eventId)
    if (existing !== undefined) {
      return { schemaVersion: 1, sequence: existing.sequence, inserted: false }
    }
    const event = this.event(
      request.workspaceId,
      request.producer,
      request.kind,
      request.payload,
      request.eventId,
      request.sessionId,
      request.occurredAt,
    )
    this.pushEvent(parsePersistedTimelineEvent(event))
    return { schemaVersion: 1, sequence: event.sequence, inserted: true }
  }

  private event(
    workspaceId: string,
    producer: string,
    kind: string,
    payload: Readonly<Record<string, unknown>>,
    eventId?: string,
    sessionId: string | null = null,
    occurredAt?: string,
  ): PersistedTimelineEvent {
    this.eventCounter += 1
    const sequence = (this.events.get(workspaceId)?.at(-1)?.sequence ?? 0) + 1
    return parsePersistedTimelineEvent({
      schemaVersion: 1,
      eventId: eventId ?? `event-demo-${String(this.eventCounter)}`,
      workspaceId,
      sessionId,
      sequence,
      producer,
      kind,
      occurredAt: occurredAt ?? this.timestamp(),
      payload,
    })
  }

  private pushEvent(event: PersistedTimelineEvent): void {
    const events = this.events.get(event.workspaceId) ?? []
    this.events.set(event.workspaceId, [...events, event])
  }

  private workspace(
    workspaceId: string,
    operation: WorkspaceHistoryCommand,
  ): PersistedWorkspaceSummary {
    const workspace = this.workspaces.find(
      (candidate) => candidate.workspaceId === workspaceId,
    )
    if (workspace === undefined) {
      throw this.error("WORKSPACE-NOT-FOUND", operation, false)
    }
    return workspace
  }

  private replaceWorkspace(workspace: PersistedWorkspaceSummary): void {
    this.workspaces = this.workspaces.map((candidate) =>
      candidate.workspaceId === workspace.workspaceId ? workspace : candidate,
    )
  }

  private timestamp(): string {
    this.clock += 1
    return new Date(baseTimestamp + this.clock * 1_000).toISOString()
  }

  private error(
    code: string,
    operation: WorkspaceHistoryCommand,
    recoverable: boolean,
  ): WorkspaceHistoryBoundaryError {
    return new WorkspaceHistoryBoundaryError({
      code,
      operation,
      recoverable,
      userMessageKey: "workspace.error.generic",
    })
  }
}
