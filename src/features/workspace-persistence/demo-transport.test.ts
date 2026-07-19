import { describe, expect, it } from "vitest"

import { workspaceHistoryCommands } from "@/lib/contracts/workspace-history"

import { DemoWorkspaceHistoryTransport } from "@/features/workspace-persistence/demo-transport"

describe("DemoWorkspaceHistoryTransport", () => {
  it("reports preview memory as ephemeral instead of native persistence", async () => {
    const transport = new DemoWorkspaceHistoryTransport()

    await expect(
      transport.request(workspaceHistoryCommands.list, undefined),
    ).resolves.toMatchObject({
      history: {
        mode: "ephemeral",
        errorCode: null,
        backupName: null,
      },
    })
  })

  it("keeps deterministic workspace-local drafts across selection", async () => {
    const transport = new DemoWorkspaceHistoryTransport()
    const initial = await transport.request(
      workspaceHistoryCommands.list,
      undefined,
    )
    const firstId = initial.activeWorkspaceId
    if (firstId === null || initial.draft === null)
      throw new Error("demo fixture")

    await transport.request(workspaceHistoryCommands.saveDraft, {
      workspaceId: firstId,
      text: "workspace-local draft",
      effort: "max",
      expectedRevision: initial.draft.revision,
    })
    const otherId = initial.workspaces.find(
      (workspace) => workspace.workspaceId !== firstId,
    )?.workspaceId
    if (otherId === undefined) throw new Error("demo fixture")
    await transport.request(workspaceHistoryCommands.select, {
      workspaceId: otherId,
    })
    const restored = await transport.request(workspaceHistoryCommands.select, {
      workspaceId: firstId,
    })

    expect(restored.draft).toMatchObject({
      text: "workspace-local draft",
      effort: "max",
      revision: 1,
    })
  })

  it("keeps versioned summaries and timeline anchors workspace-local", async () => {
    const transport = new DemoWorkspaceHistoryTransport()
    const initial = await transport.request(
      workspaceHistoryCommands.list,
      undefined,
    )
    const workspaceId = initial.activeWorkspaceId
    const anchored = initial.timeline.items[0]
    if (workspaceId === null || anchored === undefined) {
      throw new Error("demo fixture")
    }
    await transport.request(workspaceHistoryCommands.saveTimelineAnchor, {
      workspaceId,
      eventId: anchored.eventId,
      sequence: anchored.sequence,
      offset: -8,
    })
    await transport.request(workspaceHistoryCommands.appendDomainEvent, {
      schemaVersion: 1,
      eventId: "event-demo-summary",
      workspaceId,
      sessionId: null,
      producer: "code",
      kind: "code.message.completed",
      occurredAt: "2026-07-18T00:10:00.000Z",
      payload: {
        semanticVersion: 1,
        generation: 1,
        sourceSequence: 2,
        itemHandle: "item-demo-summary",
        text: "Demo summary",
      },
    })
    const restored = await transport.request(workspaceHistoryCommands.recheck, {
      workspaceId,
      acceptObservedHead: false,
    })
    expect(restored.resumeState).toMatchObject({
      workspaceId,
      lastSummary: { eventId: "event-demo-summary", text: "Demo summary" },
      timelineAnchor: {
        eventId: anchored.eventId,
        sequence: anchored.sequence,
        offset: -8,
        revision: 1,
      },
    })
  })

  it("unregisters a project as metadata without deleting its preserved state", async () => {
    const transport = new DemoWorkspaceHistoryTransport()
    const selectedProject = await transport.request(
      workspaceHistoryCommands.pickRegister,
      undefined,
    )
    const workspaceId = selectedProject.state.activeWorkspaceId
    if (workspaceId === null || selectedProject.state.draft === null) {
      throw new Error("demo fixture")
    }
    await transport.request(workspaceHistoryCommands.saveDraft, {
      workspaceId,
      text: "Preserve this draft",
      effort: "max",
      expectedRevision: selectedProject.state.draft.revision,
    })

    const remaining = await transport.request(
      workspaceHistoryCommands.unregister,
      { workspaceId },
    )

    expect(remaining.workspaces).toHaveLength(3)
    expect(remaining.activeWorkspaceId).not.toBe(workspaceId)
    await expect(
      transport.request(workspaceHistoryCommands.select, { workspaceId }),
    ).rejects.toMatchObject({ code: "WORKSPACE-NOT-FOUND" })
  })

  it("creates sessions idempotently and records lifecycle events", async () => {
    const transport = new DemoWorkspaceHistoryTransport()
    const initial = await transport.request(
      workspaceHistoryCommands.list,
      undefined,
    )
    const fromWorkspaceId = initial.activeWorkspaceId
    if (fromWorkspaceId === null) throw new Error("demo fixture")
    const request = {
      fromWorkspaceId,
      name: "Demo persisted session",
      goal: "Exercise the adapter",
      clientRequestId: "request-demo-create",
    }

    const created = await transport.request(
      workspaceHistoryCommands.createSession,
      request,
    )
    const duplicate = await transport.request(
      workspaceHistoryCommands.createSession,
      request,
    )

    expect(created.activeWorkspaceId).toBe(duplicate.activeWorkspaceId)
    expect(duplicate.workspaces).toHaveLength(initial.workspaces.length + 1)
    expect(duplicate.draft?.text).toBe("Exercise the adapter")
    expect(duplicate.timeline.items.at(-1)).toMatchObject({
      kind: "work.workspace.lifecycle.changed",
      payload: { lifecycle: "backlog" },
    })
  })

  it("requires the dedicated cancellation command", async () => {
    const transport = new DemoWorkspaceHistoryTransport()
    const initial = await transport.request(
      workspaceHistoryCommands.list,
      undefined,
    )
    const workspace = initial.workspaces.find(
      (candidate) => candidate.workspaceId === initial.activeWorkspaceId,
    )
    if (workspace === undefined) throw new Error("demo fixture")

    await expect(
      transport.request(workspaceHistoryCommands.updateLifecycle, {
        workspaceId: workspace.workspaceId,
        lifecycle: "canceled",
        expectedUpdatedAt: workspace.updatedAt,
      }),
    ).rejects.toMatchObject({
      code: "WORKSPACE-CANCEL-COMMAND-REQUIRED",
      operation: workspaceHistoryCommands.updateLifecycle,
    })
    await expect(
      transport.request(workspaceHistoryCommands.cancel, {
        workspaceId: workspace.workspaceId,
        expectedUpdatedAt: workspace.updatedAt,
      }),
    ).resolves.toMatchObject({ lifecycle: "canceled" })
  })

  it("bounds context snapshots and rejects stale draft revisions", async () => {
    const transport = new DemoWorkspaceHistoryTransport()
    const initial = await transport.request(
      workspaceHistoryCommands.list,
      undefined,
    )
    const workspaceId = initial.activeWorkspaceId
    if (workspaceId === null || initial.draft === null)
      throw new Error("demo fixture")

    await transport.request(workspaceHistoryCommands.saveDraft, {
      workspaceId,
      text: "first write",
      effort: "fast",
      expectedRevision: initial.draft.revision,
    })
    await expect(
      transport.request(workspaceHistoryCommands.saveDraft, {
        workspaceId,
        text: "stale write",
        effort: "fast",
        expectedRevision: initial.draft.revision,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE-DRAFT-CONFLICT" })

    for (let index = 0; index < 12; index += 1) {
      await transport.request(workspaceHistoryCommands.saveContextSnapshot, {
        workspaceId,
        source: "git_diff",
      })
    }
    const state = await transport.request(
      workspaceHistoryCommands.list,
      undefined,
    )
    expect(state.contextSnapshots).toHaveLength(10)
    expect(state.contextSnapshots[0]).toMatchObject({
      snapshotId: "context-demo-3",
      label: "Working tree diff",
      contentHash:
        "934aadecee30255e357b415c0ee74ea27cf91af64a9b5ba7d0636dcb02273755",
    })
  })

  it("rejects terminal output without a trusted producer like native mode", async () => {
    const transport = new DemoWorkspaceHistoryTransport()
    const state = await transport.request(
      workspaceHistoryCommands.list,
      undefined,
    )
    if (state.activeWorkspaceId === null) throw new Error("demo fixture")

    await expect(
      transport.request(workspaceHistoryCommands.saveContextSnapshot, {
        workspaceId: state.activeWorkspaceId,
        source: "terminal_output",
      }),
    ).rejects.toMatchObject({
      code: "WORKSPACE-CONTEXT-SOURCE-UNAVAILABLE",
      operation: workspaceHistoryCommands.saveContextSnapshot,
      recoverable: true,
    })
  })

  it("keeps versioned editable context isolated and rejects stale saves", async () => {
    const transport = new DemoWorkspaceHistoryTransport()
    const state = await transport.request(
      workspaceHistoryCommands.list,
      undefined,
    )
    const workspaceId = state.activeWorkspaceId
    const otherWorkspaceId = state.workspaces.find(
      (workspace) => workspace.workspaceId !== workspaceId,
    )?.workspaceId
    if (workspaceId === null || otherWorkspaceId === undefined) {
      throw new Error("demo fixture")
    }
    const initial = await transport.request(
      workspaceHistoryCommands.loadEditableContext,
      { workspaceId },
    )
    const saved = await transport.request(
      workspaceHistoryCommands.saveProjectContext,
      {
        workspaceId,
        expectedVersion: initial.project.version,
        context: {
          ...initial.project.context,
          goal: "Persist this workspace only",
        },
      },
    )
    expect(saved).toMatchObject({ version: 2 })
    const normalized = await transport.request(
      workspaceHistoryCommands.saveProjectContext,
      {
        workspaceId,
        expectedVersion: saved.version,
        context: {
          ...saved.context,
          technicalReferences: ["./docs//guide.md"],
        },
      },
    )
    expect(normalized).toMatchObject({
      version: 3,
      context: { technicalReferences: ["docs/guide.md"] },
    })
    await expect(
      transport.request(workspaceHistoryCommands.saveProjectContext, {
        workspaceId,
        expectedVersion: initial.project.version,
        context: initial.project.context,
      }),
    ).rejects.toMatchObject({
      code: "WORKSPACE-PROJECT-CONTEXT-CONFLICT",
    })
    await expect(
      transport.request(workspaceHistoryCommands.loadEditableContext, {
        workspaceId: otherWorkspaceId,
      }),
    ).resolves.toMatchObject({ project: { version: 1 } })
    await expect(
      transport.request(workspaceHistoryCommands.getTurnContextSnapshot, {
        workspaceId,
      }),
    ).resolves.toMatchObject({
      workspaceId,
      projectVersion: 3,
      characterVersion: 1,
    })
  })

  it("uses native-compatible canonical content and snapshot SHA-256 values", async () => {
    const transport = new DemoWorkspaceHistoryTransport()
    const state = await transport.request(
      workspaceHistoryCommands.list,
      undefined,
    )
    const workspaceId = state.activeWorkspaceId
    if (workspaceId === null) throw new Error("demo fixture")
    const initial = await transport.request(
      workspaceHistoryCommands.loadEditableContext,
      { workspaceId },
    )
    const context = { ...initial.project.context, goal: "Ship it" }

    const saved = await transport.request(
      workspaceHistoryCommands.saveProjectContext,
      {
        workspaceId,
        expectedVersion: initial.project.version,
        context,
      },
    )
    expect(saved.contentHash).toBe(
      "d896fd57cecd520a3f6c0c4cf11885484d21ca0096b155fd127f493552280dbc",
    )
    const snapshot = await transport.request(
      workspaceHistoryCommands.getTurnContextSnapshot,
      { workspaceId },
    )
    expect(snapshot.snapshotHash).toBe(
      "b795b4a4c6c7f5791b0c175c8a5f304b0c0b83a7ab127019a8546748632bf35a",
    )

    const sameContent = await transport.request(
      workspaceHistoryCommands.saveProjectContext,
      {
        workspaceId,
        expectedVersion: saved.version,
        context,
      },
    )
    expect(sameContent.contentHash).toBe(saved.contentHash)
    const differentContent = await transport.request(
      workspaceHistoryCommands.saveProjectContext,
      {
        workspaceId,
        expectedVersion: sameContent.version,
        context: { ...context, goal: "Ship something else" },
      },
    )
    expect(differentContent.contentHash).toBe(
      "b7075b4a0979d60a764a8be795d06b3be3343d57a199f0b73c9ce03172743a9c",
    )
  })
})
