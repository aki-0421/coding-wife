import {
  parsePersistedTimelineEvent,
  parseWorkspaceHistoryResponse,
  workspaceHistoryCommands,
  type AppendDomainEventRequest,
  type PersistedContextSnapshot,
  type PersistedTimelineEvent,
  type PersistedTimelinePage,
  type PersistedProjectSummary,
  type PersistedWorkspaceDraft,
  type PersistedWorkspaceSummary,
  type WorkspaceHistoryCommand,
  type WorkspaceHistoryRequestMap,
  type WorkspaceHistoryResponseMap,
  type WorkspaceLastSummary,
  type WorkspaceStateSnapshot,
  type WorkspaceTimelineAnchor,
} from "@/lib/contracts/workspace-history"
import {
  bundledHiyoriCharacterContextPreset,
  parseCharacterContext,
  normalizeProjectContextForSave,
  type ProjectContext,
  type VersionedCharacterContext,
  type VersionedProjectContext,
  type WorkspaceTurnContextSnapshot,
} from "@/lib/contracts/workspace-context"

import {
  WorkspaceHistoryBoundaryError,
  type WorkspaceHistoryTransport,
} from "@/features/workspace-persistence/transport"

const baseTimestamp = Date.parse("2026-07-18T00:00:00.000Z")
const defaultProjectHash =
  "e0da727f2381a1c290ddcb74bdb52b44b0ec890559443d795f29731d68fe1323"
const defaultCharacterHash =
  "7607f6f22a12f0abed924b078a0e1b202c87e993d67f4346a0c0a2682a1004af"

const defaultProjectContext: ProjectContext = {
  goal: "",
  constraints: "",
  definitionOfDone: [],
  technicalReferences: [],
  userNotes: "",
}

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
    githubRepository: "aki-0421/coding-wife",
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

export class DemoWorkspaceHistoryTransport
  implements WorkspaceHistoryTransport
{
  readonly kind = "demo"
  private projects: PersistedProjectSummary[] = [
    {
      schemaVersion: 1,
      projectId: "project-demo",
      name: "coding-wife",
      githubRepository: "aki-0421/coding-wife",
      health: "ready",
      workspaceCount: 3,
      createdAt: new Date(baseTimestamp).toISOString(),
      updatedAt: new Date(baseTimestamp + 2 * 60_000).toISOString(),
    },
  ]
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
      "feature/live2d-character",
      "in_progress",
      "test_failed",
      2,
    ),
  ]
  private activeWorkspaceId = "build-live2d-desktop-app"
  private readonly unregisteredWorkspaces: PersistedWorkspaceSummary[] = []
  private readonly hiddenProjects: PersistedProjectSummary[] = []
  private readonly hiddenWorkspaces: PersistedWorkspaceSummary[] = []
  private readonly drafts = new Map<string, PersistedWorkspaceDraft>(
    this.workspaces.map((workspace) => [
      workspace.workspaceId,
      emptyDraft(workspace.workspaceId, workspace.updatedAt),
    ]),
  )
  private readonly contexts = new Map<string, PersistedContextSnapshot[]>()
  private readonly projectContexts = new Map<string, VersionedProjectContext>()
  private readonly characterContexts = new Map<
    string,
    VersionedCharacterContext
  >([
    [
      "builtin:hiyori_pro",
      {
        schemaVersion: 1,
        packId: "builtin:hiyori_pro",
        version: 1,
        contentHash: defaultCharacterHash,
        updatedAt: new Date(baseTimestamp).toISOString(),
        context: bundledHiyoriCharacterContextPreset,
      },
    ],
  ])
  private readonly events = new Map<string, PersistedTimelineEvent[]>()
  private readonly lastSummaries = new Map<string, WorkspaceLastSummary>()
  private readonly timelineAnchors = new Map<string, WorkspaceTimelineAnchor>()
  private readonly requestWorkspaces = new Map<string, string>()
  private readonly deleteTokens = new Map<string, string>()
  private clock = 180
  private workspaceCounter = 0
  private contextCounter = 0
  private eventCounter = 0
  private requestQueue: Promise<void> = Promise.resolve()
  private demoSetupActive = false
  private demoSetupGitReady = false

  constructor(
    private readonly options: {
      readonly projectSetup?: "git" | "github"
    } = {},
  ) {
    this.demoSetupGitReady = options.projectSetup === "github"
    for (const workspace of this.workspaces) {
      if (!this.projectContexts.has(workspace.projectId)) {
        this.projectContexts.set(
          workspace.projectId,
          this.defaultProjectContext(workspace.projectId, workspace.updatedAt),
        )
      }
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
    const response = this.requestQueue.then(async () => {
      try {
        const value = await this.handle(command, request)
        return parseWorkspaceHistoryResponse(command, value)
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error("Demo history request failed")
      }
    })
    this.requestQueue = response.then(
      () => undefined,
      () => undefined,
    )
    return response
  }

  private async handle<K extends WorkspaceHistoryCommand>(
    command: K,
    request: WorkspaceHistoryRequestMap[K],
  ): Promise<unknown> {
    switch (command) {
      case workspaceHistoryCommands.list:
        return this.state()
      case workspaceHistoryCommands.pickRegister:
        return this.pickRegister()
      case workspaceHistoryCommands.initializeProjectGit:
        return this.initializeProjectGit(
          request as WorkspaceHistoryRequestMap["workspace_project_setup_git_init"],
        )
      case workspaceHistoryCommands.setupProjectGithub:
        return this.setupProjectGithub(
          request as WorkspaceHistoryRequestMap["workspace_project_setup_github"],
        )
      case workspaceHistoryCommands.cancelProjectSetup:
        return this.cancelProjectSetup(
          request as WorkspaceHistoryRequestMap["workspace_project_setup_cancel"],
        )
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
      case workspaceHistoryCommands.recheck:
        this.workspace(
          (request as WorkspaceHistoryRequestMap["workspace_recheck"])
            .workspaceId,
          command,
        )
        return this.state()
      case workspaceHistoryCommands.repair:
        return this.repair(
          (request as WorkspaceHistoryRequestMap["workspace_repair"])
            .workspaceId,
        )
      case workspaceHistoryCommands.unregister:
        return this.unregister(
          (request as WorkspaceHistoryRequestMap["workspace_unregister"])
            .projectId,
        )
      case workspaceHistoryCommands.archive:
        return this.archive(
          (request as WorkspaceHistoryRequestMap["workspace_archive"])
            .workspaceId,
        )
      case workspaceHistoryCommands.updateLifecycle:
        return this.updateLifecycle(
          request as WorkspaceHistoryRequestMap["workspace_update_lifecycle"],
        )
      case workspaceHistoryCommands.cancel:
        return this.cancelWorkspace(
          request as WorkspaceHistoryRequestMap["workspace_cancel"],
        )
      case workspaceHistoryCommands.saveDraft:
        return this.saveDraft(
          request as WorkspaceHistoryRequestMap["workspace_save_draft"],
        )
      case workspaceHistoryCommands.saveTimelineAnchor:
        return this.saveTimelineAnchor(
          request as WorkspaceHistoryRequestMap["workspace_save_timeline_anchor"],
        )
      case workspaceHistoryCommands.saveContextSnapshot:
        return this.saveContext(
          request as WorkspaceHistoryRequestMap["workspace_save_context_snapshot"],
        )
      case workspaceHistoryCommands.getProjectContext:
        return this.projectContext(
          (request as WorkspaceHistoryRequestMap["project_context_get"])
            .projectId,
          command,
        )
      case workspaceHistoryCommands.saveProjectContext:
        return this.saveProjectContext(
          request as WorkspaceHistoryRequestMap["project_context_save"],
        )
      case workspaceHistoryCommands.getCharacterContext:
        return this.characterContext(
          request as WorkspaceHistoryRequestMap["app_character_context_get"],
        )
      case workspaceHistoryCommands.saveCharacterContext:
        return this.saveCharacterContext(
          request as WorkspaceHistoryRequestMap["app_character_context_save"],
        )
      case workspaceHistoryCommands.getTurnContextSnapshot:
        return this.turnContextSnapshot(
          (
            request as WorkspaceHistoryRequestMap["workspace_get_turn_context_snapshot"]
          ).workspaceId,
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
    const active = this.workspaces.find(
      (workspace) => workspace.workspaceId === this.activeWorkspaceId,
    )
    return {
      schemaVersion: 1,
      history: {
        schemaVersion: 1,
        mode: "ephemeral",
        errorCode: null,
        backupName: null,
      },
      projects: [...this.projects],
      workspaces: [...this.workspaces],
      activeWorkspaceId: active?.workspaceId ?? null,
      draft:
        active === undefined
          ? null
          : (this.drafts.get(active.workspaceId) ?? null),
      contextSnapshots:
        active === undefined
          ? []
          : [...(this.contexts.get(active.workspaceId) ?? [])],
      timeline:
        active === undefined
          ? {
              schemaVersion: 1,
              items: [],
              nextBeforeSequence: null,
            }
          : this.timeline({
              workspaceId: active.workspaceId,
              beforeSequence: null,
              limit: 200,
              search: null,
            }),
      resumeState:
        active === undefined ||
        (!this.lastSummaries.has(active.workspaceId) &&
          !this.timelineAnchors.has(active.workspaceId))
          ? null
          : {
              schemaVersion: 1,
              workspaceId: active.workspaceId,
              lastSummary: this.lastSummaries.get(active.workspaceId) ?? null,
              timelineAnchor:
                this.timelineAnchors.get(active.workspaceId) ?? null,
            },
    }
  }

  private pickRegister(): WorkspaceHistoryResponseMap["workspace_pick_register"] {
    if (this.options.projectSetup !== undefined) {
      this.demoSetupActive = true
      return this.projectSetupResponse()
    }
    return this.completeProjectRegistration("aki-0421/selected-project")
  }

  private projectSetupResponse(): WorkspaceHistoryResponseMap["workspace_pick_register"] {
    return {
      schemaVersion: 1,
      outcome: "setup_required",
      state: this.state(),
      setup: {
        schemaVersion: 1,
        setupId: "project-setup-demo",
        folderName: "new-companion-tool",
        gitStatus: this.demoSetupGitReady ? "ready" : "not_initialized",
        githubOwnerStatus: this.demoSetupGitReady ? "ready" : "not_checked",
        githubOwners: this.demoSetupGitReady
          ? ["aki-0421", "openai-build-week"]
          : [],
        suggestedRepositoryName: "new-companion-tool",
      },
    }
  }

  private initializeProjectGit(
    request: WorkspaceHistoryRequestMap["workspace_project_setup_git_init"],
  ): WorkspaceHistoryResponseMap["workspace_project_setup_git_init"] {
    this.requireDemoSetup(request.setupId)
    this.demoSetupGitReady = true
    return this.projectSetupResponse()
  }

  private setupProjectGithub(
    request: WorkspaceHistoryRequestMap["workspace_project_setup_github"],
  ): WorkspaceHistoryResponseMap["workspace_project_setup_github"] {
    this.requireDemoSetup(request.setupId)
    if (
      !this.demoSetupGitReady ||
      !["aki-0421", "openai-build-week"].includes(request.owner) ||
      request.repository.trim().length === 0
    ) {
      throw this.error(
        "PROJECT-SETUP-INVALID",
        workspaceHistoryCommands.setupProjectGithub,
        true,
      )
    }
    this.demoSetupActive = false
    return this.completeProjectRegistration(
      `${request.owner}/${request.repository.trim()}`,
    )
  }

  private cancelProjectSetup(
    request: WorkspaceHistoryRequestMap["workspace_project_setup_cancel"],
  ): WorkspaceHistoryResponseMap["workspace_project_setup_cancel"] {
    this.requireDemoSetup(request.setupId)
    this.demoSetupActive = false
    return {
      schemaVersion: 1,
      outcome: "canceled",
      state: this.state(),
      setup: null,
    }
  }

  private requireDemoSetup(setupId: string): void {
    if (!this.demoSetupActive || setupId !== "project-setup-demo") {
      throw this.error(
        "PROJECT-SETUP-NOT-FOUND",
        workspaceHistoryCommands.cancelProjectSetup,
        true,
      )
    }
  }

  private completeProjectRegistration(
    githubRepository: string | null = null,
  ): WorkspaceHistoryResponseMap["workspace_pick_register"] {
    const existing = this.projects.find(
      (project) => project.projectId === "project-demo-selected",
    )
    if (existing === undefined) {
      const timestamp = this.timestamp()
      const hiddenProject = this.hiddenProjects.find(
        (project) => project.projectId === "project-demo-selected",
      )
      if (hiddenProject === undefined) {
        this.projects = [
          ...this.projects,
          {
            schemaVersion: 1,
            projectId: "project-demo-selected",
            name: "selected-project",
            githubRepository,
            health: "ready",
            workspaceCount: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ]
        this.projectContexts.set(
          "project-demo-selected",
          this.defaultProjectContext("project-demo-selected", timestamp),
        )
      } else {
        const restoredWorkspaces = this.hiddenWorkspaces.filter(
          (workspace) => workspace.projectId === hiddenProject.projectId,
        )
        this.projects = [
          ...this.projects,
          {
            ...hiddenProject,
            workspaceCount: restoredWorkspaces.length,
            updatedAt: timestamp,
          },
        ]
        this.workspaces = [...this.workspaces, ...restoredWorkspaces]
        this.hiddenProjects.splice(
          this.hiddenProjects.indexOf(hiddenProject),
          1,
        )
        for (const workspace of restoredWorkspaces) {
          this.hiddenWorkspaces.splice(
            this.hiddenWorkspaces.indexOf(workspace),
            1,
          )
        }
      }
    }
    return {
      schemaVersion: 1,
      outcome: "selected",
      state: this.state(),
      setup: null,
    }
  }

  private createSession(
    request: WorkspaceHistoryRequestMap["workspace_create_session"],
  ): WorkspaceStateSnapshot {
    const existingId = this.requestWorkspaces.get(request.clientRequestId)
    if (existingId !== undefined) {
      return this.select(existingId, workspaceHistoryCommands.createSession)
    }
    const project = this.projects.find(
      (candidate) => candidate.projectId === request.projectId,
    )
    if (project === undefined) {
      throw this.error(
        "PROJECT-NOT-FOUND",
        workspaceHistoryCommands.createSession,
        false,
      )
    }
    this.workspaceCounter += 1
    const workspaceId = `workspace-demo-session-${String(this.workspaceCounter)}`
    const timestamp = this.timestamp()
    const workspace: PersistedWorkspaceSummary = {
      schemaVersion: 1,
      workspaceId,
      projectId: project.projectId,
      repository: project.name,
      githubRepository: project.githubRepository,
      name: request.name,
      branch: `coding-wife/demo-${String(this.workspaceCounter)}`,
      head: "0123456789ab",
      detached: false,
      lifecycle: "backlog",
      attention: null,
      health: "ready",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSelectedAt: timestamp,
    }
    this.workspaces = [...this.workspaces, workspace]
    this.drafts.set(workspaceId, emptyDraft(workspaceId, timestamp))
    this.projects = this.projects.map((candidate) =>
      candidate.projectId === project.projectId
        ? {
            ...candidate,
            workspaceCount: candidate.workspaceCount + 1,
            updatedAt: timestamp,
          }
        : candidate,
    )
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

  private repair(workspaceId: string): WorkspaceStateSnapshot {
    const workspace = this.workspace(
      workspaceId,
      workspaceHistoryCommands.repair,
    )
    const updatedAt = this.timestamp()
    this.workspaces = this.workspaces.map((candidate) =>
      candidate.projectId === workspace.projectId
        ? { ...candidate, health: "ready", updatedAt }
        : candidate,
    )
    this.activeWorkspaceId = workspaceId
    return this.state()
  }

  private unregister(projectId: string): WorkspaceStateSnapshot {
    const project = this.projects.find(
      (candidate) => candidate.projectId === projectId,
    )
    const removed = this.workspaces.filter(
      (candidate) => candidate.projectId === projectId,
    )
    this.unregisteredWorkspaces.push(...removed)
    if (project !== undefined) this.hiddenProjects.push(project)
    this.hiddenWorkspaces.push(...removed)
    this.workspaces = this.workspaces.filter(
      (candidate) => candidate.projectId !== projectId,
    )
    this.projects = this.projects.filter(
      (candidate) => candidate.projectId !== projectId,
    )
    if (
      removed.some(
        (candidate) => candidate.workspaceId === this.activeWorkspaceId,
      )
    ) {
      this.activeWorkspaceId = this.workspaces[0]?.workspaceId ?? ""
    }
    return this.state()
  }

  private archive(workspaceId: string): WorkspaceStateSnapshot {
    const workspace = this.workspace(
      workspaceId,
      workspaceHistoryCommands.archive,
    )
    this.workspaces = this.workspaces.filter(
      (candidate) => candidate.workspaceId !== workspaceId,
    )
    this.projects = this.projects.map((project) =>
      project.projectId === workspace.projectId
        ? {
            ...project,
            workspaceCount: Math.max(0, project.workspaceCount - 1),
            updatedAt: this.timestamp(),
          }
        : project,
    )
    this.drafts.delete(workspaceId)
    this.contexts.delete(workspaceId)
    this.events.delete(workspaceId)
    this.activeWorkspaceId =
      this.activeWorkspaceId === workspaceId
        ? (this.workspaces[0]?.workspaceId ?? "")
        : this.activeWorkspaceId
    return this.state()
  }

  private updateLifecycle(
    request: WorkspaceHistoryRequestMap["workspace_update_lifecycle"],
  ): PersistedWorkspaceSummary {
    if (request.lifecycle === "canceled") {
      throw this.error(
        "WORKSPACE-CANCEL-COMMAND-REQUIRED",
        workspaceHistoryCommands.updateLifecycle,
        false,
      )
    }
    return this.applyLifecycle(
      request.workspaceId,
      request.lifecycle,
      request.expectedUpdatedAt,
      workspaceHistoryCommands.updateLifecycle,
    )
  }

  private cancelWorkspace(
    request: WorkspaceHistoryRequestMap["workspace_cancel"],
  ): PersistedWorkspaceSummary {
    return this.applyLifecycle(
      request.workspaceId,
      "canceled",
      request.expectedUpdatedAt,
      workspaceHistoryCommands.cancel,
    )
  }

  private applyLifecycle(
    workspaceId: string,
    lifecycle: PersistedWorkspaceSummary["lifecycle"],
    expectedUpdatedAt: string,
    command:
      | typeof workspaceHistoryCommands.updateLifecycle
      | typeof workspaceHistoryCommands.cancel,
  ): PersistedWorkspaceSummary {
    const current = this.workspace(workspaceId, command)
    if (current.updatedAt !== expectedUpdatedAt) {
      throw this.error("WORKSPACE-REVISION-CONFLICT", command, true)
    }
    const updated = {
      ...current,
      lifecycle,
      updatedAt: this.timestamp(),
    }
    this.replaceWorkspace(updated)
    this.pushEvent(
      this.event(workspaceId, "work", "work.workspace.lifecycle.changed", {
        lifecycle,
      }),
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

  private saveTimelineAnchor(
    request: WorkspaceHistoryRequestMap["workspace_save_timeline_anchor"],
  ): WorkspaceTimelineAnchor {
    this.workspace(
      request.workspaceId,
      workspaceHistoryCommands.saveTimelineAnchor,
    )
    const exact = (this.events.get(request.workspaceId) ?? []).some(
      (event) =>
        event.eventId === request.eventId &&
        event.sequence === request.sequence,
    )
    if (!exact) {
      throw this.error(
        "WORKSPACE-TIMELINE-ANCHOR-STALE",
        workspaceHistoryCommands.saveTimelineAnchor,
        true,
      )
    }
    const current = this.timelineAnchors.get(request.workspaceId)
    const anchor: WorkspaceTimelineAnchor = {
      schemaVersion: 1,
      workspaceId: request.workspaceId,
      eventId: request.eventId,
      sequence: request.sequence,
      offset: request.offset,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: this.timestamp(),
      wasClamped: false,
    }
    this.timelineAnchors.set(request.workspaceId, anchor)
    return anchor
  }

  private async saveContext(
    request: WorkspaceHistoryRequestMap["workspace_save_context_snapshot"],
  ): Promise<PersistedContextSnapshot> {
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
    const content = `demo ${request.source}`
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
      byteCount: new TextEncoder().encode(content).byteLength,
      contentHash: await this.sha256Text(
        content,
        workspaceHistoryCommands.saveContextSnapshot,
      ),
    }
    const contexts = [
      ...(this.contexts.get(request.workspaceId) ?? []),
      snapshot,
    ]
    this.contexts.set(request.workspaceId, contexts.slice(-10))
    return snapshot
  }

  private async saveProjectContext(
    request: WorkspaceHistoryRequestMap["project_context_save"],
  ): Promise<WorkspaceHistoryResponseMap["project_context_save"]> {
    const current = this.projectContext(
      request.projectId,
      workspaceHistoryCommands.saveProjectContext,
    )
    if (current.version !== request.expectedVersion) {
      throw this.error(
        "PROJECT-CONTEXT-CONFLICT",
        workspaceHistoryCommands.saveProjectContext,
        true,
      )
    }
    const context = normalizeProjectContextForSave(request.context)
    const updated: VersionedProjectContext = {
      schemaVersion: 1,
      projectId: request.projectId,
      version: current.version + 1,
      contentHash: await this.canonicalJsonHash(
        context,
        workspaceHistoryCommands.saveProjectContext,
      ),
      updatedAt: this.timestamp(),
      context,
    }
    this.projectContexts.set(request.projectId, updated)
    return updated
  }

  private async saveCharacterContext(
    request: WorkspaceHistoryRequestMap["app_character_context_save"],
  ): Promise<WorkspaceHistoryResponseMap["app_character_context_save"]> {
    const current = await this.characterContext({
      packId: request.packId,
      displayName: request.context.displayName,
    })
    if (current.version !== request.expectedVersion) {
      throw this.error(
        "APP-CHARACTER-CONTEXT-CONFLICT",
        workspaceHistoryCommands.saveCharacterContext,
        true,
      )
    }
    const context = parseCharacterContext(request.context)
    const updated: VersionedCharacterContext = {
      schemaVersion: 1,
      packId: request.packId,
      version: current.version + 1,
      contentHash: await this.canonicalJsonHash(
        context,
        workspaceHistoryCommands.saveCharacterContext,
      ),
      updatedAt: this.timestamp(),
      context,
    }
    this.characterContexts.set(request.packId, updated)
    return updated
  }

  private async characterContext(
    request: WorkspaceHistoryRequestMap["app_character_context_get"],
  ): Promise<VersionedCharacterContext> {
    const current = this.characterContexts.get(request.packId)
    if (current !== undefined) return current
    const context = parseCharacterContext({
      displayName: request.displayName,
      tone: "neutral",
      toneNotes: "",
      speechDensity: "key_events",
      behavior: "",
      prohibitedExpressions: [],
    })
    return {
      schemaVersion: 1,
      packId: request.packId,
      version: 1,
      contentHash: await this.canonicalJsonHash(
        context,
        workspaceHistoryCommands.getCharacterContext,
      ),
      updatedAt: new Date(baseTimestamp).toISOString(),
      context,
    }
  }

  private async turnContextSnapshot(
    workspaceId: string,
  ): Promise<WorkspaceTurnContextSnapshot> {
    const workspace = this.workspace(
      workspaceId,
      workspaceHistoryCommands.getTurnContextSnapshot,
    )
    const project = this.projectContext(
      workspace.projectId,
      workspaceHistoryCommands.getTurnContextSnapshot,
    )
    const character = await this.characterContext({
      packId: "builtin:hiyori_pro",
      displayName: "桃瀬ひより",
    })
    return {
      schemaVersion: 1,
      workspaceId,
      projectVersion: project.version,
      projectHash: project.contentHash,
      characterPackId: character.packId,
      characterVersion: character.version,
      characterHash: character.contentHash,
      snapshotHash: await this.canonicalJsonHash(
        {
          projectVersion: project.version,
          projectHash: project.contentHash,
          characterPackId: character.packId,
          characterVersion: character.version,
          characterHash: character.contentHash,
        },
        workspaceHistoryCommands.getTurnContextSnapshot,
      ),
      capturedAt: this.timestamp(),
      project: project.context,
      character: character.context,
    }
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
    this.deleteTokens.delete(request.token)
    this.workspace(request.workspaceId, workspaceHistoryCommands.delete)
    const updatedAt = this.timestamp()
    this.drafts.set(
      request.workspaceId,
      emptyDraft(request.workspaceId, updatedAt),
    )
    this.contexts.delete(request.workspaceId)
    this.events.delete(request.workspaceId)
    this.lastSummaries.delete(request.workspaceId)
    this.timelineAnchors.delete(request.workspaceId)
    this.activeWorkspaceId = request.workspaceId
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
    if (
      event.producer === "code" &&
      event.kind === "code.message.completed" &&
      typeof event.payload.text === "string"
    ) {
      this.lastSummaries.set(request.workspaceId, {
        schemaVersion: 1,
        workspaceId: request.workspaceId,
        eventId: event.eventId,
        sequence: event.sequence,
        text: event.payload.text,
        updatedAt: event.occurredAt,
      })
    }
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

  private projectContext(
    projectId: string,
    operation: WorkspaceHistoryCommand,
  ): VersionedProjectContext {
    const project = [...this.projects, ...this.hiddenProjects].find(
      (candidate) => candidate.projectId === projectId,
    )
    const context = this.projectContexts.get(projectId)
    if (project === undefined || context === undefined) {
      throw this.error("PROJECT-NOT-FOUND", operation, false)
    }
    return context
  }

  private defaultProjectContext(
    projectId: string,
    updatedAt: string,
  ): VersionedProjectContext {
    return {
      schemaVersion: 1,
      projectId,
      version: 1,
      contentHash: defaultProjectHash,
      updatedAt,
      context: defaultProjectContext,
    }
  }

  private canonicalJsonHash(
    value: unknown,
    operation: WorkspaceHistoryCommand,
  ): Promise<string> {
    return this.sha256Text(JSON.stringify(value), operation)
  }

  private async sha256Text(
    value: string,
    operation: WorkspaceHistoryCommand,
  ): Promise<string> {
    if (globalThis.crypto?.subtle === undefined) {
      throw this.error("WORKSPACE-CONTEXT-HASH-UNAVAILABLE", operation, true)
    }
    try {
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value),
      )
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")
    } catch {
      throw this.error("WORKSPACE-CONTEXT-HASH-UNAVAILABLE", operation, true)
    }
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
