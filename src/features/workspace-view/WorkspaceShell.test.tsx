import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { App } from "@/app/App"
import type { LocalePreferenceStore } from "@/features/localization"
import { DemoTransport } from "@/features/runtime"
import type {
  SendTurnRequest,
  WorkspaceAdapterState,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"

const englishLocaleStore: LocalePreferenceStore = {
  persistence: "session-only",
  read: () => "en",
  write: () => true,
}

function renderWorkspace(adapter?: WorkspaceViewAdapter) {
  return render(
    <App
      localeStore={englishLocaleStore}
      transport={new DemoTransport()}
      {...(adapter ? { workspaceAdapter: adapter } : {})}
    />,
  )
}

describe("WorkspaceShell", () => {
  it("labels the workspace mark with the localized product name", () => {
    renderWorkspace()

    expect(
      screen.getByRole("img", { name: "Coding Wife workspace" }),
    ).toBeVisible()
  })

  it("supports keyboard tab cycling and the workspace filter shortcut", async () => {
    renderWorkspace()

    const chatTab = screen.getByRole("tab", { name: /Chat/ })
    const commitTab = screen.getByRole("tab", { name: "Commit" })
    expect(chatTab).toHaveAttribute("aria-selected", "true")

    fireEvent.keyDown(window, { ctrlKey: true, key: "Tab" })
    expect(commitTab).toHaveAttribute("aria-selected", "true")

    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const filter = await screen.findByRole("textbox", {
      name: "Filter workspaces",
    })
    await waitFor(() => expect(filter).toHaveFocus())
  })

  it("keeps composer drafts scoped to their workspace", () => {
    renderWorkspace()

    const composer = screen.getByPlaceholderText(
      "Ask Codex to plan, build, explain, or fix anything…",
    )
    fireEvent.change(composer, {
      target: { value: "Keep this draft with the Live2D workspace" },
    })

    const workspaceNavigation = screen.getByRole("navigation", {
      name: "Workspaces",
    })
    fireEvent.click(
      within(workspaceNavigation).getByRole("button", {
        name: "coding-wife/sol-desktop, main, Done",
      }),
    )
    expect(composer).toHaveValue("")

    fireEvent.click(
      within(workspaceNavigation).getByRole("button", {
        name: /coding-wife\/build-live2d-desktop-app/,
      }),
    )
    expect(composer).toHaveValue("Keep this draft with the Live2D workspace")
  })

  it("persists a pending draft when selection changes inside the debounce window", async () => {
    const saveDraft = vi.fn().mockResolvedValue(undefined)
    const stateFor = (activeWorkspaceId: string): WorkspaceAdapterState => ({
      workspaces: [
        {
          id: "workspace-a",
          repository: "fixture",
          name: "workspace-a",
          branch: "main",
          lifecycle: "in_progress",
        },
        {
          id: "workspace-b",
          repository: "fixture",
          name: "workspace-b",
          branch: "main",
          lifecycle: "backlog",
        },
      ],
      activeWorkspaceId,
      draft: {
        text: "",
        effort: "fast",
        revision: 0,
        contextSnapshots: [],
      },
      timeline: [],
      history: { mode: "ready", errorCode: null, backupName: null },
    })
    const adapter: WorkspaceViewAdapter = {
      loadState: () => Promise.resolve(stateFor("workspace-a")),
      saveDraft,
      selectWorkspace: (workspaceId) => Promise.resolve(stateFor(workspaceId)),
    }

    renderWorkspace(adapter)
    const composer = await screen.findByPlaceholderText(
      "Ask Codex to plan, build, explain, or fix anything…",
    )
    const workspaceNavigation = screen.getByRole("navigation", {
      name: "Workspaces",
    })
    await waitFor(() =>
      expect(
        within(workspaceNavigation).getByRole("button", {
          name: /fixture\/workspace-a/,
        }),
      ).toBeVisible(),
    )
    fireEvent.change(composer, { target: { value: "Keep draft A" } })
    fireEvent.click(
      within(workspaceNavigation).getByRole("button", {
        name: /fixture\/workspace-b/,
      }),
    )

    await waitFor(() =>
      expect(saveDraft).toHaveBeenCalledWith(
        "workspace-a",
        "Keep draft A",
        "fast",
      ),
    )
    expect(saveDraft).not.toHaveBeenCalledWith("workspace-b", "", "fast")
  })

  it("hydrates the persisted draft and timeline before saving later edits", async () => {
    const restoredState: WorkspaceAdapterState = {
      workspaces: [
        {
          id: "workspace-restored",
          repository: "coding-wife",
          name: "restored-session",
          branch: "feature/history",
          lifecycle: "in_progress",
          health: "ready",
          updatedAt: "2026-07-18T00:01:00.000Z",
        },
      ],
      activeWorkspaceId: "workspace-restored",
      draft: {
        text: "Restored after reload",
        effort: "max",
        revision: 4,
        contextSnapshots: [],
      },
      timeline: [
        {
          id: "event-restored",
          sequence: 9,
          producer: "code",
          kind: "code.session.status.changed",
          occurredAt: "2026-07-18T00:00:45.000Z",
          status: "failed",
          errorCode: "CODEX-TURN-FAILED",
        },
      ],
      history: { mode: "ready", errorCode: null, backupName: null },
    }
    const saveDraft = vi.fn().mockResolvedValue(undefined)
    const captureContext = vi.fn().mockResolvedValue({
      id: "context-restored",
      source: "git_diff" as const,
      label: "Working tree diff",
      capturedAt: "2026-07-18T00:02:00.000Z",
      byteCount: 42,
    })
    const adapter: WorkspaceViewAdapter = {
      connected: false,
      loadState: () => Promise.resolve(restoredState),
      saveDraft,
      captureContext,
    }

    renderWorkspace(adapter)

    const composer = await screen.findByPlaceholderText(
      "Ask Codex to plan, build, explain, or fix anything…",
    )
    await waitFor(() => expect(composer).toHaveValue("Restored after reload"))
    expect(screen.getByText("code.session.status.changed")).toBeVisible()
    expect(screen.getByText("CODEX-TURN-FAILED")).toBeVisible()

    fireEvent.change(composer, { target: { value: "Persist this edit" } })
    await waitFor(() =>
      expect(saveDraft).toHaveBeenLastCalledWith(
        "workspace-restored",
        "Persist this edit",
        "max",
      ),
    )

    fireEvent.click(screen.getByRole("button", { name: "Context" }))
    fireEvent.click(screen.getByRole("button", { name: "Git diff" }))
    await waitFor(() =>
      expect(captureContext).toHaveBeenCalledWith(
        "workspace-restored",
        "git_diff",
      ),
    )
    expect(
      screen.queryByRole("button", { name: "Git diff" }),
    ).not.toBeInTheDocument()
    expect(
      await screen.findByRole("button", {
        name: "Remove attachment: Working tree diff",
      }),
    ).toBeVisible()
  })

  it("opens compact navigation from the selected workspace and restores focus", async () => {
    const user = userEvent.setup()
    renderWorkspace()

    const selectedWorkspaceTrigger = screen.getByRole("button", {
      name: "Switch workspace: coding-wife/build-live2d-desktop-app",
    })
    await user.click(selectedWorkspaceTrigger)

    const dialog = await screen.findByRole("dialog", { name: "Workspaces" })
    expect(selectedWorkspaceTrigger).toHaveAttribute("aria-expanded", "true")

    fireEvent.keyDown(dialog, { code: "Escape", key: "Escape" })
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Workspaces" }),
      ).not.toBeInTheDocument(),
    )
    await waitFor(() => expect(selectedWorkspaceTrigger).toHaveFocus())

    await user.click(selectedWorkspaceTrigger)
    const reopenedDialog = await screen.findByRole("dialog", {
      name: "Workspaces",
    })
    await user.click(
      within(reopenedDialog).getByRole("button", {
        name: "coding-wife/sol-desktop, main, Done",
      }),
    )

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Workspaces" }),
      ).not.toBeInTheDocument(),
    )
    expect(
      screen.getByRole("button", {
        name: "Switch workspace: coding-wife/sol-desktop",
      }),
    ).toHaveFocus()
  })

  it("clears only accepted turns and exposes a stop action", async () => {
    const requests: SendTurnRequest[] = []
    const stoppedWorkspaceIds: string[] = []
    const adapter: WorkspaceViewAdapter = {
      connected: true,
      sendTurn(request) {
        requests.push(request)
        return Promise.resolve({ accepted: true })
      },
      stopTurn(workspaceId) {
        stoppedWorkspaceIds.push(workspaceId)
        return Promise.resolve()
      },
    }

    renderWorkspace(adapter)
    expect(await screen.findByText("Ready")).toBeVisible()

    const composer = screen.getByPlaceholderText(
      "Ask Codex to plan, build, explain, or fix anything…",
    )
    fireEvent.change(composer, {
      target: { value: "Run the bounded implementation" },
    })
    const send = screen.getByRole("button", { name: "Send" })
    expect(send).toBeEnabled()
    fireEvent.click(send)

    expect(requests).toEqual([
      {
        attachments: [],
        contextSnapshots: [],
        effort: "fast",
        instruction: "Run the bounded implementation",
        workspaceId: "build-live2d-desktop-app",
      },
    ])
    await waitFor(() => expect(composer).toHaveValue(""))

    const stop = await screen.findByRole("button", { name: "Stop" })
    fireEvent.click(stop)
    expect(stoppedWorkspaceIds).toEqual(["build-live2d-desktop-app"])
    expect(await screen.findByRole("button", { name: "Send" })).toBeDisabled()
  })
})
