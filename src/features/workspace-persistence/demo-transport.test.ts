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
})
