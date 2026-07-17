import { describe, expect, it, vi } from "vitest"

import {
  workspaceHistoryCommands,
  type WorkspaceStateSnapshot,
} from "@/lib/contracts/workspace-history"
import fixture from "@/test/fixtures/workspace-history.v1.json"

import {
  PersistentWorkspaceViewAdapter,
  projectWorkspaceState,
} from "@/features/workspace-persistence/adapter"
import { DemoWorkspaceHistoryTransport } from "@/features/workspace-persistence/demo-transport"
import { TauriWorkspaceHistoryTransport } from "@/features/workspace-persistence/transport"

describe("PersistentWorkspaceViewAdapter", () => {
  it("projects strict native state without exposing project linkage paths", () => {
    const projected = projectWorkspaceState(
      fixture.state as WorkspaceStateSnapshot,
    )

    expect(projected.workspaces[0]).toEqual({
      id: "workspace-fixture",
      repository: "fixture-repository",
      name: "Fixture workspace",
      branch: "main",
      lifecycle: "in_progress",
      attention: "test_failed",
      health: "ready",
      updatedAt: "2026-07-18T00:01:00.000Z",
    })
    expect(projected.timeline[0]).toMatchObject({
      producer: "code",
      status: "failed",
    })
    expect(JSON.stringify(projected)).not.toMatch(/canonical|gitdir|\/Users\//i)
  })

  it("serializes rapid draft writes and restores the latest workspace-local value", async () => {
    const adapter = new PersistentWorkspaceViewAdapter(
      new DemoWorkspaceHistoryTransport(),
    )
    const initial = await adapter.loadState()
    expect(initial.history).toEqual({
      mode: "ephemeral",
      errorCode: null,
      backupName: null,
    })
    const workspaceId = initial.activeWorkspaceId
    if (workspaceId === null) throw new Error("demo fixture")

    await Promise.all([
      adapter.saveDraft(workspaceId, "first", "fast"),
      adapter.saveDraft(workspaceId, "second", "max"),
      adapter.saveDraft(workspaceId, "latest", "max"),
    ])
    const restored = await adapter.selectWorkspace(workspaceId)

    expect(restored.draft).toMatchObject({ text: "latest", effort: "max" })
  })

  it("supports project registration, session creation, context, and confirmed deletion", async () => {
    const adapter = new PersistentWorkspaceViewAdapter(
      new DemoWorkspaceHistoryTransport(),
    )
    const initial = await adapter.loadState()
    const selected = await adapter.requestAddProject()
    const projectWorkspaceId = selected.activeWorkspaceId
    if (projectWorkspaceId === null) throw new Error("demo fixture")
    const created = await adapter.requestAddWorkspace({
      fromWorkspaceId: projectWorkspaceId,
      name: "Adapter session",
      goal: "Persist adapter state",
      repository: "selected-project",
      branch: "main",
    })
    const createdId = created.activeWorkspaceId
    if (createdId === null) throw new Error("demo fixture")

    await expect(
      adapter.captureContext(createdId, "git_diff"),
    ).resolves.toMatchObject({
      source: "git_diff",
      label: "Working tree diff",
    })
    const afterDelete = await adapter.deleteWorkspaceHistory(createdId)

    expect(initial.workspaces).toHaveLength(3)
    expect(
      afterDelete.workspaces.some((workspace) => workspace.id === createdId),
    ).toBe(false)
  })

  it("rehydrates persisted native state in a fresh adapter after reload", async () => {
    let nativeState = structuredClone(fixture.state) as WorkspaceStateSnapshot
    const invoker = (command: string, request: unknown): Promise<unknown> => {
      if (command === workspaceHistoryCommands.list) {
        return Promise.resolve(nativeState)
      }
      if (command === workspaceHistoryCommands.saveDraft) {
        const draftRequest = request as {
          readonly workspaceId: string
          readonly text: string
          readonly effort: "fast" | "max"
          readonly expectedRevision: number
        }
        const updated = {
          ...nativeState.draft!,
          text: draftRequest.text,
          effort: draftRequest.effort,
          revision: draftRequest.expectedRevision + 1,
          updatedAt: "2026-07-18T00:02:00.000Z",
        }
        nativeState = { ...nativeState, draft: updated }
        return Promise.resolve(updated)
      }
      if (command === workspaceHistoryCommands.select) {
        return Promise.resolve(nativeState)
      }
      return Promise.reject(new Error(`Unexpected command ${command}`))
    }
    const first = new PersistentWorkspaceViewAdapter(
      new TauriWorkspaceHistoryTransport(invoker),
    )
    await first.loadState()
    await first.saveDraft("workspace-fixture", "survives reload", "max")

    const reloaded = new PersistentWorkspaceViewAdapter(
      new TauriWorkspaceHistoryTransport(invoker),
    )
    await expect(reloaded.loadState()).resolves.toMatchObject({
      activeWorkspaceId: "workspace-fixture",
      draft: { text: "survives reload", effort: "max", revision: 3 },
    })
  })

  it("waits for an in-flight draft before deletion and purges the deleted cache", async () => {
    let resolveDraft!: (value: unknown) => void
    const commands: string[] = []
    const deletedState: WorkspaceStateSnapshot = {
      ...(fixture.state as WorkspaceStateSnapshot),
      workspaces: [],
      activeWorkspaceId: null,
      draft: null,
      contextSnapshots: [],
      timeline: { schemaVersion: 1, items: [], nextBeforeSequence: null },
    }
    const invoker = vi.fn((command: string): Promise<unknown> => {
      commands.push(command)
      if (command === workspaceHistoryCommands.list) {
        return Promise.resolve(fixture.state)
      }
      if (command === workspaceHistoryCommands.saveDraft) {
        return new Promise((resolve) => {
          resolveDraft = resolve
        })
      }
      if (command === workspaceHistoryCommands.issueDeleteChallenge) {
        return Promise.resolve(fixture.challenge)
      }
      if (command === workspaceHistoryCommands.delete) {
        return Promise.resolve(deletedState)
      }
      if (command === workspaceHistoryCommands.select) {
        return Promise.reject(
          Object.assign(new Error(fixture.error.code), fixture.error),
        )
      }
      return Promise.reject(new Error(`Unexpected command ${command}`))
    })
    const adapter = new PersistentWorkspaceViewAdapter(
      new TauriWorkspaceHistoryTransport(invoker),
    )
    await adapter.loadState()
    const save = adapter.saveDraft("workspace-fixture", "queued", "max")
    await vi.waitFor(() =>
      expect(commands).toContain(workspaceHistoryCommands.saveDraft),
    )

    const deletion = adapter.deleteWorkspaceHistory("workspace-fixture")
    await expect(
      adapter.saveDraft("workspace-fixture", "must not race", "fast"),
    ).resolves.toBeUndefined()
    expect(commands).not.toContain(
      workspaceHistoryCommands.issueDeleteChallenge,
    )

    resolveDraft({
      ...fixture.draft,
      text: "queued",
      revision: fixture.draft.revision + 1,
    })
    await save
    await expect(deletion).resolves.toMatchObject({ activeWorkspaceId: null })
    expect(commands).toEqual([
      workspaceHistoryCommands.list,
      workspaceHistoryCommands.saveDraft,
      workspaceHistoryCommands.issueDeleteChallenge,
      workspaceHistoryCommands.delete,
    ])

    await expect(
      adapter.saveDraft("workspace-fixture", "after deletion", "fast"),
    ).rejects.toMatchObject({ code: "WORKSPACE-NOT-FOUND" })
    expect(commands.at(-1)).toBe(workspaceHistoryCommands.select)
  })
})
