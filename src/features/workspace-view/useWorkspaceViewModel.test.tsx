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
      fastServiceTier: "priority",
      supportedReasoningEfforts: ["low", "max"],
      experimentalModesAvailable: true,
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
    readonly selection?: Promise<WorkspaceAdapterState>
    readonly context?: Promise<WorkspaceTurnContextSnapshot>
  } = {},
) {
  const snapshot = options.snapshot ?? codexState()
  const selectWorkspace = vi.fn((workspaceId: string) =>
    options.selection === undefined
      ? Promise.resolve(state(workspaceId))
      : options.selection,
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
    selectWorkspace,
    sendTurn,
    getTurnContextSnapshot: () =>
      options.context === undefined
        ? Promise.resolve(contextSnapshot())
        : options.context,
  }
  return { adapter, selectWorkspace, sendTurn }
}

describe("useWorkspaceViewModel workspace transitions", () => {
  it("switches the view immediately while the old workspace keeps running", async () => {
    const fixture = adapterFixture()
    const { result } = renderHook(() => useWorkspaceViewModel(fixture.adapter))
    await waitFor(() => expect(result.current.adapterStatus).toBe("ready"))
    expect(result.current.turnState).toBe("running")

    await act(async () => {
      result.current.setSelectedWorkspaceId("workspace-b")
      await Promise.resolve()
    })
    expect(fixture.selectWorkspace).toHaveBeenCalledWith("workspace-b")
    expect(result.current.selectedWorkspaceId).toBe("workspace-b")
    expect(result.current.turnState).toBe("idle")
    expect(result.current.backgroundExecutionWorkspace).toMatchObject({
      id: "workspace-a",
      name: "workspace-a",
    })
    expect(result.current.selectedDraft).toMatchObject({
      text: "",
      effort: "max",
    })
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

  it("preserves the draft and exposes a safe error when turn start fails", async () => {
    const fixture = adapterFixture()
    fixture.sendTurn.mockRejectedValueOnce(
      Object.assign(new Error("raw transport detail"), {
        code: "CODEX-TURN-PREFLIGHT-BLOCKED",
      }),
    )
    const { result } = renderHook(() => useWorkspaceViewModel(fixture.adapter))
    await waitFor(() => expect(result.current.adapterStatus).toBe("ready"))

    await act(async () => {
      await expect(result.current.sendTurn()).resolves.toBe(false)
    })

    expect(result.current.turnState).toBe("idle")
    expect(result.current.selectedDraft.text).toBe("Preserve this draft.")
    expect(result.current.notice).toEqual({
      tone: "error",
      message: "CODEX-TURN-PREFLIGHT-BLOCKED",
    })
  })

  it("does not expose an unsafe turn start error", async () => {
    const fixture = adapterFixture()
    fixture.sendTurn.mockRejectedValueOnce(
      new Error("/\u0055sers/private/.codex/auth.json"),
    )
    const { result } = renderHook(() => useWorkspaceViewModel(fixture.adapter))
    await waitFor(() => expect(result.current.adapterStatus).toBe("ready"))

    await act(async () => {
      await expect(result.current.sendTurn()).resolves.toBe(false)
    })

    expect(result.current.selectedDraft.text).toBe("Preserve this draft.")
    expect(result.current.notice?.message).toBe("CODEX-TURN-START-FAILED")
  })

  it("rechecks the active repository on window focus and restores native anchor state", async () => {
    const initial: WorkspaceAdapterState = {
      ...state(),
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

  it("keeps the latest rapid target while older selection results are stale", async () => {
    const selection = deferred<WorkspaceAdapterState>()
    const fixture = adapterFixture({ selection: selection.promise })
    const { result } = renderHook(() => useWorkspaceViewModel(fixture.adapter))
    await waitFor(() => expect(result.current.adapterStatus).toBe("ready"))

    act(() => {
      result.current.setSelectedWorkspaceId("workspace-b")
      result.current.setSelectedWorkspaceId("workspace-c")
    })
    expect(fixture.selectWorkspace).toHaveBeenNthCalledWith(1, "workspace-b")
    expect(fixture.selectWorkspace).toHaveBeenNthCalledWith(2, "workspace-c")
    expect(result.current.selectedWorkspaceId).toBe("workspace-c")

    await act(async () => {
      selection.resolve(state("workspace-c"))
      await selection.promise
    })
    expect(result.current.selectedWorkspaceId).toBe("workspace-c")
  })

  it("rolls the view back when selection persistence fails", async () => {
    const selection = deferred<WorkspaceAdapterState>()
    const fixture = adapterFixture({ selection: selection.promise })
    const { result } = renderHook(() => useWorkspaceViewModel(fixture.adapter))
    await waitFor(() => expect(result.current.adapterStatus).toBe("ready"))
    act(() => result.current.setSelectedWorkspaceId("workspace-b"))
    expect(result.current.selectedWorkspaceId).toBe("workspace-b")

    await act(async () => {
      selection.reject(new Error("WORKSPACE-SELECT-FAILED"))
      await selection.promise.catch(() => undefined)
    })

    expect(result.current.selectedWorkspaceId).toBe("workspace-a")
    expect(result.current.selectedDraft.text).toBe("Preserve this draft.")
    expect(result.current.notice).toEqual({
      tone: "error",
      message: "WORKSPACE-SELECT-FAILED",
    })
  })

  it("switches during context capture and invalidates the stale send", async () => {
    const context = deferred<WorkspaceTurnContextSnapshot>()
    const fixture = adapterFixture({
      snapshot: codexState("ready"),
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
    expect(result.current.selectedWorkspaceId).toBe("workspace-b")
    expect(result.current.turnState).toBe("idle")
    await act(async () => {
      context.resolve(contextSnapshot())
      await expect(sending).resolves.toBe(false)
    })
    expect(fixture.sendTurn).not.toHaveBeenCalled()
    expect(result.current.selectedDraft.text).toBe("")
  })

  it("blocks a second turn while another workspace owns the active execution", async () => {
    const fixture = adapterFixture()
    const { result } = renderHook(() => useWorkspaceViewModel(fixture.adapter))
    await waitFor(() => expect(result.current.adapterStatus).toBe("ready"))
    await act(async () => {
      result.current.setSelectedWorkspaceId("workspace-b")
      await Promise.resolve()
    })

    await act(async () => {
      await expect(result.current.sendTurn()).resolves.toBe(false)
    })
    expect(fixture.sendTurn).not.toHaveBeenCalled()
    expect(result.current.notice).toEqual({
      tone: "neutral",
      message: "CODEX-OTHER-WORKSPACE-ACTIVE",
    })
  })
})
