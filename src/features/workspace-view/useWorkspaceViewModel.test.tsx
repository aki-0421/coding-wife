import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { WorkspaceTurnContextSnapshot } from "@/lib/contracts/workspace-context"
import type {
  WorkspaceAdapterState,
  WorkspaceCodexState,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"
import { useWorkspaceViewModel } from "@/features/workspace-view/useWorkspaceViewModel"

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function state(activeWorkspaceId = "workspace-a"): WorkspaceAdapterState {
  return {
    workspaces: [
      {
        id: "workspace-a",
        repository: "coding-wife",
        name: "workspace-a",
        branch: "feature/a",
        lifecycle: "in_progress",
      },
      {
        id: "workspace-b",
        repository: "coding-wife",
        name: "workspace-b",
        branch: "feature/b",
        lifecycle: "backlog",
      },
      {
        id: "workspace-c",
        repository: "coding-wife",
        name: "workspace-c",
        branch: "feature/c",
        lifecycle: "backlog",
      },
    ],
    activeWorkspaceId,
    draft: {
      text: activeWorkspaceId === "workspace-a" ? "Preserve this draft." : "",
      effort: "max",
      revision: 3,
      contextSnapshots: [],
    },
    timeline: [],
    history: { mode: "ready", errorCode: null, backupName: null },
  }
}

function codexState(
  phase: WorkspaceCodexState["phase"] = "running",
): WorkspaceCodexState {
  return {
    activeWorkspaceId: "workspace-a",
    generation: 7,
    phase,
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

function contextSnapshot(): WorkspaceTurnContextSnapshot {
  return {
    schemaVersion: 1,
    workspaceId: "workspace-a",
    projectVersion: 1,
    projectHash:
      "e0da727f2381a1c290ddcb74bdb52b44b0ec890559443d795f29731d68fe1323",
    characterPackId: "builtin:hiyori_pro",
    characterVersion: 1,
    characterHash:
      "0ab87e72a74abd7bebaaf2b5c4e568e6e3e4bae7e21febca76a6b079f6d33c8c",
    snapshotHash:
      "c84d287d3d716df45e08d627bb15ed4b94e27a9eebc257d635c889cfd6ac7365",
    capturedAt: "2026-07-18T00:00:00.000Z",
    project: {
      goal: "",
      constraints: "",
      definitionOfDone: [],
      technicalReferences: [],
      userNotes: "",
    },
    character: {
      displayName: "Sol",
      tone: "neutral",
      toneNotes: "",
      speechDensity: "key_events",
      behavior: "",
      prohibitedExpressions: [],
    },
  }
}

function adapterFixture(
  options: {
    readonly snapshot?: WorkspaceCodexState
    readonly transition?: Promise<WorkspaceAdapterState>
    readonly context?: Promise<WorkspaceTurnContextSnapshot>
  } = {},
) {
  const snapshot = options.snapshot ?? codexState()
  const stopAndSwitchWorkspace = vi.fn(() =>
    options.transition === undefined
      ? Promise.resolve(state("workspace-c"))
      : options.transition,
  )
  const sendTurn = vi.fn(() => Promise.resolve({ accepted: true }))
  const adapter: WorkspaceViewAdapter = {
    hydrationMode: "native",
    loadState: () => Promise.resolve(state()),
    codexSnapshot: () => snapshot,
    subscribeCodex: (listener) => {
      listener(snapshot)
      return () => undefined
    },
    stopAndSwitchWorkspace,
    sendTurn,
    getTurnContextSnapshot: () =>
      options.context === undefined
        ? Promise.resolve(contextSnapshot())
        : options.context,
  }
  return { adapter, sendTurn, stopAndSwitchWorkspace }
}

describe("useWorkspaceViewModel workspace transitions", () => {
  it("holds an active-turn selection and Go back preserves selection, turn, and draft", async () => {
    const fixture = adapterFixture()
    const { result } = renderHook(() => useWorkspaceViewModel(fixture.adapter))
    await waitFor(() => expect(result.current.adapterStatus).toBe("ready"))
    expect(result.current.turnState).toBe("running")

    act(() => result.current.setSelectedWorkspaceId("workspace-b"))
    expect(result.current.pendingWorkspaceTransition).toMatchObject({
      fromWorkspaceId: "workspace-a",
      toWorkspaceId: "workspace-b",
      expectedGeneration: 7,
      status: "confirming",
    })
    expect(result.current.selectedWorkspaceId).toBe("workspace-a")
    expect(result.current.selectedDraft).toMatchObject({
      text: "Preserve this draft.",
      effort: "max",
    })

    act(() => result.current.cancelWorkspaceTransition())
    expect(result.current.pendingWorkspaceTransition).toBeNull()
    expect(result.current.selectedWorkspaceId).toBe("workspace-a")
    expect(result.current.turnState).toBe("running")
    expect(result.current.selectedDraft.text).toBe("Preserve this draft.")
    expect(fixture.stopAndSwitchWorkspace).not.toHaveBeenCalled()
  })

  it("rechecks repository health immediately before Send and preserves a blocked draft", async () => {
    const ready = {
      ...state(),
      workspaces: state().workspaces.map((workspace) => ({
        ...workspace,
        health: "ready" as const,
      })),
    }
    const blocked: WorkspaceAdapterState = {
      ...ready,
      workspaces: ready.workspaces.map((workspace) =>
        workspace.id === "workspace-a"
          ? { ...workspace, health: "stale_branch" }
          : workspace,
      ),
    }
    const recheckWorkspace = vi.fn(() => Promise.resolve(blocked))
    const sendTurn = vi.fn(() => Promise.resolve({ accepted: true }))
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(ready),
      codexSnapshot: () => codexState("ready"),
      subscribeCodex: (listener) => {
        listener(codexState("ready"))
        return () => undefined
      },
      getTurnContextSnapshot: () => Promise.resolve(contextSnapshot()),
      recheckWorkspace,
      sendTurn,
    }
    const { result } = renderHook(() => useWorkspaceViewModel(adapter))
    await waitFor(() => expect(result.current.adapterStatus).toBe("ready"))

    await act(async () => {
      await expect(result.current.sendTurn()).resolves.toBe(false)
    })

    expect(recheckWorkspace).toHaveBeenCalledWith("workspace-a")
    expect(sendTurn).not.toHaveBeenCalled()
    expect(result.current.selectedDraft.text).toBe("Preserve this draft.")
    expect(result.current.selectedWorkspace?.health).toBe("stale_branch")
    expect(result.current.notice?.message).toBe(
      "WORKSPACE-REPOSITORY-stale_branch",
    )
  })

  it("rechecks the active repository on window focus and restores native anchor state", async () => {
    const initial: WorkspaceAdapterState = {
      ...state(),
      lastSummary: {
        eventId: "event-summary",
        sequence: 8,
        text: "Workspace summary",
        updatedAt: "2026-07-18T00:01:00.000Z",
      },
      timelineAnchor: {
        eventId: "event-anchor",
        sequence: 7,
        offset: -12,
        revision: 2,
        wasClamped: false,
      },
    }
    const missing: WorkspaceAdapterState = {
      ...initial,
      workspaces: initial.workspaces.map((workspace) =>
        workspace.id === "workspace-a"
          ? { ...workspace, health: "missing" }
          : workspace,
      ),
    }
    const recheckWorkspace = vi.fn(() => Promise.resolve(missing))
    const saveTimelineAnchor = vi.fn(() => Promise.resolve())
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(initial),
      codexSnapshot: () => codexState("ready"),
      subscribeCodex: () => () => undefined,
      recheckWorkspace,
      saveTimelineAnchor,
    }
    const { result } = renderHook(() => useWorkspaceViewModel(adapter))
    await waitFor(() => expect(result.current.adapterStatus).toBe("ready"))
    expect(result.current.lastSummary?.text).toBe("Workspace summary")
    expect(result.current.timelineAnchor).toMatchObject({
      eventId: "event-anchor",
      sequence: 7,
      offset: -12,
    })

    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    await waitFor(() =>
      expect(result.current.selectedWorkspace?.health).toBe("missing"),
    )
    expect(recheckWorkspace).toHaveBeenCalledWith("workspace-a")
    act(() => result.current.saveTimelineAnchor("event-anchor", 7, -4))
    expect(saveTimelineAnchor).toHaveBeenCalledWith(
      "workspace-a",
      "event-anchor",
      7,
      -4,
    )
  })

  it("loads bounded older pages until the persisted anchor is available", async () => {
    const latestEvent = {
      id: "event-latest",
      sequence: 250,
      producer: "code" as const,
      kind: "history" as const,
      domainKind: "code.tool.output",
      occurredAt: "2026-07-18T00:04:00.000Z",
      status: "completed",
    }
    const anchorEvent = {
      id: "event-anchor",
      sequence: 7,
      producer: "code" as const,
      kind: "history" as const,
      domainKind: "code.message.completed",
      occurredAt: "2026-07-18T00:00:07.000Z",
      status: "completed",
    }
    const initial: WorkspaceAdapterState = {
      ...state(),
      timeline: [latestEvent],
      timelineAnchor: {
        eventId: anchorEvent.id,
        sequence: anchorEvent.sequence,
        offset: 8,
        revision: 1,
        wasClamped: false,
      },
      nextBeforeSequence: 51,
    }
    const loadTimelinePage = vi.fn(() =>
      Promise.resolve({
        timeline: [anchorEvent],
        nextBeforeSequence: null,
      }),
    )
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(initial),
      codexSnapshot: () => codexState("ready"),
      subscribeCodex: () => () => undefined,
      loadTimelinePage,
    }
    const { result } = renderHook(() => useWorkspaceViewModel(adapter))

    await waitFor(() =>
      expect(result.current.timeline.map((event) => event.kind)).toHaveLength(
        2,
      ),
    )
    expect(loadTimelinePage).toHaveBeenCalledWith("workspace-a", 51)
    expect(
      result.current.timeline.some(
        (event) => event.kind === "history" && event.id === "event-anchor",
      ),
    ).toBe(true)
  })

  it("accepts an observed external HEAD only through the stale repository recovery action", async () => {
    const stale: WorkspaceAdapterState = {
      ...state(),
      workspaces: state().workspaces.map((workspace) => ({
        ...workspace,
        health: workspace.id === "workspace-a" ? "stale_branch" : "ready",
      })),
    }
    const ready: WorkspaceAdapterState = {
      ...stale,
      workspaces: stale.workspaces.map((workspace) => ({
        ...workspace,
        health: "ready",
      })),
    }
    const recheckWorkspace = vi.fn(() => Promise.resolve(ready))
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(stale),
      codexSnapshot: () => codexState("ready"),
      subscribeCodex: () => () => undefined,
      recheckWorkspace,
    }
    const { result } = renderHook(() => useWorkspaceViewModel(adapter))
    await waitFor(() => expect(result.current.adapterStatus).toBe("ready"))

    await act(async () => {
      await expect(result.current.repairSelectedWorkspace()).resolves.toEqual({
        ok: true,
      })
    })
    expect(recheckWorkspace).toHaveBeenCalledWith("workspace-a", true)
    expect(result.current.selectedWorkspace?.health).toBe("ready")
  })

  it("uses the latest rapid target and deduplicates confirm while the old workspace stays selected", async () => {
    const transition = deferred<WorkspaceAdapterState>()
    const fixture = adapterFixture({ transition: transition.promise })
    const { result } = renderHook(() => useWorkspaceViewModel(fixture.adapter))
    await waitFor(() => expect(result.current.adapterStatus).toBe("ready"))

    act(() => {
      result.current.setSelectedWorkspaceId("workspace-b")
      result.current.setSelectedWorkspaceId("workspace-c")
    })
    expect(result.current.pendingWorkspaceTransition).toMatchObject({
      toWorkspaceId: "workspace-c",
      status: "confirming",
    })

    let first!: Promise<boolean>
    let duplicate!: Promise<boolean>
    act(() => {
      first = result.current.confirmWorkspaceTransition("Switch failed")
      duplicate = result.current.confirmWorkspaceTransition("Switch failed")
    })
    expect(duplicate).toBe(first)
    expect(fixture.stopAndSwitchWorkspace).toHaveBeenCalledTimes(1)
    expect(fixture.stopAndSwitchWorkspace).toHaveBeenCalledWith({
      fromWorkspaceId: "workspace-a",
      toWorkspaceId: "workspace-c",
      expectedGeneration: 7,
    })
    expect(result.current.selectedWorkspaceId).toBe("workspace-a")
    expect(result.current.pendingWorkspaceTransition?.status).toBe("stopping")

    await act(async () => {
      transition.resolve(state("workspace-c"))
      await first
    })
    expect(result.current.selectedWorkspaceId).toBe("workspace-c")
    expect(result.current.pendingWorkspaceTransition).toBeNull()
  })

  it("keeps the old workspace and draft when stopping or activation fails", async () => {
    const transition = deferred<WorkspaceAdapterState>()
    const fixture = adapterFixture({ transition: transition.promise })
    const { result } = renderHook(() => useWorkspaceViewModel(fixture.adapter))
    await waitFor(() => expect(result.current.adapterStatus).toBe("ready"))
    act(() => result.current.setSelectedWorkspaceId("workspace-b"))

    let switching!: Promise<boolean>
    act(() => {
      switching = result.current.confirmWorkspaceTransition(
        "The original workspace remains active.",
      )
    })
    await act(async () => {
      transition.reject(new Error("terminal cleanup failed"))
      await switching
    })

    expect(result.current.selectedWorkspaceId).toBe("workspace-a")
    expect(result.current.selectedDraft.text).toBe("Preserve this draft.")
    expect(result.current.pendingWorkspaceTransition).toMatchObject({
      fromWorkspaceId: "workspace-a",
      toWorkspaceId: "workspace-b",
      status: "confirming",
    })
    expect(result.current.notice).toEqual({
      tone: "error",
      message: "The original workspace remains active.",
    })
  })

  it("holds selection during pending context capture and invalidates the stale send on confirm", async () => {
    const context = deferred<WorkspaceTurnContextSnapshot>()
    const transition = deferred<WorkspaceAdapterState>()
    const fixture = adapterFixture({
      snapshot: codexState("ready"),
      transition: transition.promise,
      context: context.promise,
    })
    const { result } = renderHook(() => useWorkspaceViewModel(fixture.adapter))
    await waitFor(() => expect(result.current.adapterStatus).toBe("ready"))

    let sending!: Promise<boolean>
    act(() => {
      sending = result.current.sendTurn()
    })
    expect(result.current.turnState).toBe("sending")
    act(() => result.current.setSelectedWorkspaceId("workspace-b"))
    expect(result.current.selectedWorkspaceId).toBe("workspace-a")
    expect(result.current.pendingWorkspaceTransition).toMatchObject({
      fromWorkspaceId: "workspace-a",
      toWorkspaceId: "workspace-b",
      status: "confirming",
    })

    let switching!: Promise<boolean>
    act(() => {
      switching = result.current.confirmWorkspaceTransition("Switch failed")
    })
    await act(async () => {
      context.resolve(contextSnapshot())
      await expect(sending).resolves.toBe(false)
    })
    expect(fixture.sendTurn).not.toHaveBeenCalled()
    expect(result.current.selectedDraft.text).toBe("Preserve this draft.")

    await act(async () => {
      transition.resolve(state("workspace-b"))
      await switching
    })
    expect(result.current.selectedWorkspaceId).toBe("workspace-b")
  })
})
