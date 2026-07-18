import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { App } from "@/app/App"
import type { CommitExplanationAppRuntime } from "@/features/git-review"
import type { LocalePreferenceStore } from "@/features/localization"
import {
  createNarrationGateway,
  NarrationController,
} from "@/features/narration"
import { DemoTransport } from "@/features/runtime"
import type {
  WorkspaceAdapterState,
  WorkspaceCodexState,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"

class FakeCommitExplanationRuntime implements CommitExplanationAppRuntime {
  readonly sourceSubscribers = new Set<(event: unknown) => void>()
  readonly narrationSource = {
    subscribe: (listener: (event: unknown) => void) => {
      this.sourceSubscribers.add(listener)
      return () => this.sourceSubscribers.delete(listener)
    },
  }
  readonly request = vi.fn(() => Promise.resolve())
  readonly cancel = vi.fn(() => Promise.resolve())
  readonly present = vi.fn(() => Promise.resolve())
  readonly getState = vi.fn(() => null)
  readonly subscribe = vi.fn(() => () => undefined)
  readonly setScope = vi.fn(() => Promise.resolve())
  readonly start = vi.fn(() => Promise.resolve())
  readonly dispose = vi.fn(() => undefined)
  readonly setPresentationActivator = vi.fn(() => undefined)
}

const localeStore: LocalePreferenceStore = {
  persistence: "session-only",
  read: () => "en",
  write: () => true,
}

const loadedWorkspace: WorkspaceAdapterState = {
  workspaces: [
    {
      id: "workspace-native",
      repository: "native-repository",
      name: "native-workspace",
      branch: "main",
      lifecycle: "in_progress",
    },
  ],
  activeWorkspaceId: "workspace-native",
  draft: {
    text: "",
    effort: "fast",
    revision: 0,
    contextSnapshots: [],
  },
  timeline: [],
  history: { mode: "ready", errorCode: null, backupName: null },
}

function codexState(phase: WorkspaceCodexState["phase"]): WorkspaceCodexState {
  return {
    activeWorkspaceId: "workspace-native",
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

describe("App commit explanation composition", () => {
  it("owns one runtime, scopes it to the real Codex generation, and keeps Stop out of support cancellation", async () => {
    const runtime = new FakeCommitExplanationRuntime()
    const narrationController = new NarrationController(
      createNarrationGateway("demo"),
    )
    const dismissPresentation = vi.spyOn(
      narrationController,
      "dismissPresentation",
    )
    const codexListeners = new Set<(state: WorkspaceCodexState) => void>()
    let resolveStop: (() => void) | undefined
    const pendingStop = new Promise<void>((resolve) => {
      resolveStop = resolve
    })
    const stopTurn = vi.fn(() => pendingStop)
    const adapter: WorkspaceViewAdapter = {
      connected: true,
      hydrationMode: "native",
      loadState: () => Promise.resolve(loadedWorkspace),
      codexSnapshot: () => codexState("ready"),
      subscribeCodex(listener) {
        codexListeners.add(listener)
        return () => codexListeners.delete(listener)
      },
      stopTurn,
    }

    const view = render(
      <App
        commitExplanationRuntime={runtime}
        localeStore={localeStore}
        narrationController={narrationController}
        transport={new DemoTransport()}
        workspaceAdapter={adapter}
      />,
    )

    await waitFor(() => expect(runtime.start).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(runtime.setScope).toHaveBeenCalledWith({
        schemaVersion: 1,
        workspaceId: "workspace-native",
        workspaceGeneration: 7,
        locale: "en",
      }),
    )
    expect(runtime.sourceSubscribers).toHaveLength(1)
    expect(runtime.setPresentationActivator).toHaveBeenCalledWith(
      expect.any(Function),
    )

    view.rerender(
      <App
        commitExplanationRuntime={runtime}
        localeStore={localeStore}
        narrationController={narrationController}
        transport={new DemoTransport()}
        workspaceAdapter={adapter}
      />,
    )
    expect(runtime.start).toHaveBeenCalledOnce()

    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }))
    fireEvent.click(screen.getByRole("radio", { name: "日本語" }))
    await waitFor(() =>
      expect(runtime.setScope).toHaveBeenLastCalledWith({
        schemaVersion: 1,
        workspaceId: "workspace-native",
        workspaceGeneration: 7,
        locale: "ja",
      }),
    )
    expect(dismissPresentation).toHaveBeenCalledWith("workspace_switch")

    dismissPresentation.mockClear()
    act(() => {
      for (const listener of codexListeners) listener(codexState("running"))
    })
    fireEvent.click(await screen.findByRole("tab", { name: /チャット/ }))
    fireEvent.click(await screen.findByRole("button", { name: "停止" }))
    await waitFor(() => expect(stopTurn).toHaveBeenCalledOnce())
    expect(dismissPresentation).toHaveBeenCalledWith("turn_stop")
    expect(runtime.cancel).not.toHaveBeenCalled()

    resolveStop?.()
    await act(async () => pendingStop)
    view.unmount()
    expect(runtime.dispose).toHaveBeenCalledOnce()
    expect(runtime.setPresentationActivator).toHaveBeenLastCalledWith(null)
  })
})
