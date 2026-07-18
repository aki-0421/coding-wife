import {
  act,
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
  WorkspaceCodexState,
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

function nativeWorkspaceState(
  contextSnapshots: NonNullable<
    WorkspaceAdapterState["draft"]
  >["contextSnapshots"] = [],
): WorkspaceAdapterState {
  return {
    workspaces: [
      {
        id: "workspace-native",
        repository: "native-repository",
        name: "restored-workspace",
        branch: "main",
        lifecycle: "in_progress",
      },
    ],
    activeWorkspaceId: "workspace-native",
    draft: {
      text: "",
      effort: "fast",
      revision: 0,
      contextSnapshots,
    },
    timeline: [],
    history: { mode: "ready", errorCode: null, backupName: null },
  }
}

function richCodexState(): WorkspaceCodexState {
  const decision = {
    pendingId: "pending-decision",
    responseKind: "native_server_request" as const,
    operation: "request/userInput",
    targetAlias: "current turn",
    reason: "Choose a reviewable scope before implementation continues.",
    kind: "user_input" as const,
    questions: [
      {
        id: "scope",
        header: "Scope",
        question: "How much should Codex change?",
        options: [
          {
            id: "bounded",
            label: "One bounded unit",
            description: "Finish and verify one reviewable change.",
          },
          {
            id: "hold",
            label: "Hold",
            description: "Wait without changing source or Git state.",
          },
        ],
      },
    ],
    allowedDecisions: [] as const,
    approvalContext: null,
  }
  const approval = {
    pendingId: "pending-approval",
    responseKind: "native_server_request" as const,
    operation: "item/commandExecution/requestApproval",
    targetAlias: "project test command",
    reason: "The command changes only generated test output.",
    kind: "command_approval" as const,
    questions: [] as const,
    allowedDecisions: ["approve_once", "reject", "stop"] as const,
    approvalContext: {
      schemaVersion: 1 as const,
      category: "command_execution" as const,
      targetKind: "workspace" as const,
      targetAlias: "project test command",
      scope: "command" as const,
      risk: "low" as const,
      reversibility: "reversible" as const,
      recommendation: "approve_once" as const,
      evidence: ["No network or repository history operation is requested."],
    },
  }
  const base = {
    workspaceId: "workspace-native",
    generation: 1,
    occurredAt: "2026-07-18T00:00:00.000Z",
    durable: true,
  }
  const longMessage = `${"Verified timeline detail. ".repeat(14)}\nAll checks passed.`
  return {
    phase: "waiting",
    connected: true,
    readiness: {
      ready: true,
      fastAvailable: true,
      maxAvailable: true,
      reasonCode: null,
    },
    pendingRequests: [decision, approval],
    timeline: [
      {
        ...base,
        id: "event-user",
        stableId: "user-turn",
        sourceEventId: "event-user",
        sourceSequence: 1,
        kind: "user",
        status: "completed",
        text: "Implement the bounded workspace integration.",
        effort: "low",
        attachmentCount: 1,
      },
      {
        ...base,
        id: "event-assistant",
        stableId: "assistant-message",
        sourceEventId: "event-assistant",
        sourceSequence: 2,
        kind: "assistant",
        status: "completed",
        itemHandle: "item-assistant",
        text: longMessage,
      },
      {
        ...base,
        id: "event-tool",
        stableId: "tool-run",
        sourceEventId: "event-tool",
        sourceSequence: 3,
        kind: "tool",
        status: "completed",
        itemHandle: "item-tool",
        toolKind: "commandExecution",
        excerpt: "46 focused tests passed",
      },
      {
        ...base,
        id: "event-decision",
        stableId: "decision-request",
        sourceEventId: "event-decision",
        sourceSequence: 4,
        kind: "decision",
        status: "waiting",
        request: decision,
      },
      {
        ...base,
        id: "event-approval",
        stableId: "approval-request",
        sourceEventId: "event-approval",
        sourceSequence: 5,
        kind: "approval",
        status: "waiting",
        request: approval,
      },
    ],
    errorCode: null,
  }
}

describe("WorkspaceShell", () => {
  it("shows only a non-mutating skeleton while native history is pending", async () => {
    let resolveState!: (state: WorkspaceAdapterState) => void
    const requestAddProject = vi.fn()
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () =>
        new Promise((resolve) => {
          resolveState = resolve
        }),
      requestAddProject,
    }

    renderWorkspace(adapter)

    expect(screen.getByText("Restoring workspace history")).toBeVisible()
    expect(
      screen.queryByText(/build-live2d-desktop-app/),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Add project" }),
    ).not.toBeInTheDocument()
    expect(requestAddProject).not.toHaveBeenCalled()

    await act(async () => {
      resolveState(nativeWorkspaceState())
      await Promise.resolve()
    })
    expect(
      await screen.findByPlaceholderText(
        "Ask Codex to plan, build, explain, or fix anything…",
      ),
    ).toBeVisible()
  })

  it("keeps native load failures separate from demo data and retries safely", async () => {
    const requestAddProject = vi.fn()
    const loadState = vi
      .fn<() => Promise<WorkspaceAdapterState>>()
      .mockRejectedValueOnce(new Error("/Users/private/history.sqlite3"))
      .mockResolvedValueOnce(nativeWorkspaceState())
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState,
      requestAddProject,
    }

    renderWorkspace(adapter)

    expect(
      await screen.findByText("Workspace history could not be restored"),
    ).toBeVisible()
    expect(screen.queryByText(/Users\/private/)).not.toBeInTheDocument()
    expect(
      screen.queryByText(/build-live2d-desktop-app/),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Add project" }),
    ).not.toBeInTheDocument()
    expect(requestAddProject).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(
      await screen.findByPlaceholderText(
        "Ask Codex to plan, build, explain, or fix anything…",
      ),
    ).toBeVisible()
    expect(loadState).toHaveBeenCalledTimes(2)
  })

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
          kind: "history",
          domainKind: "code.session.status.changed",
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

  it("keeps the latest ten captured context items in the UI", async () => {
    const contexts = Array.from({ length: 10 }, (_, index) => ({
      id: `context-${String(index)}`,
      source: "files" as const,
      label: `Snapshot ${String(index)}`,
      capturedAt: `2026-07-18T00:00:${String(index).padStart(2, "0")}.000Z`,
      byteCount: index + 1,
    }))
    const captureContext = vi.fn().mockResolvedValue({
      id: "context-new",
      source: "git_diff" as const,
      label: "Newest diff",
      capturedAt: "2026-07-18T00:01:00.000Z",
      byteCount: 42,
    })
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(nativeWorkspaceState(contexts)),
      captureContext,
    }

    renderWorkspace(adapter)
    expect(
      await screen.findByRole("button", {
        name: "Remove attachment: Snapshot 0",
      }),
    ).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Context" }))
    fireEvent.click(screen.getByRole("button", { name: "Git diff" }))

    expect(
      await screen.findByRole("button", {
        name: "Remove attachment: Newest diff",
      }),
    ).toBeVisible()
    expect(
      screen.queryByRole("button", {
        name: "Remove attachment: Snapshot 0",
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: "Remove attachment: Snapshot 1",
      }),
    ).toBeVisible()
  })

  it("uses the persisted history mode consistently in chat and diagnostics", async () => {
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(nativeWorkspaceState()),
      deleteWorkspaceHistory: () => Promise.resolve(nativeWorkspaceState()),
    }
    renderWorkspace(adapter)

    expect(
      await screen.findByText(
        "Codex and Git are not connected. Local workspace history is persisted and available.",
      ),
    ).toBeVisible()
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }))
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }))

    const localHistory = await screen.findByText("Local history")
    expect(localHistory.parentElement).toHaveTextContent("Persisted locally")
  })

  it("labels demo history as ephemeral and resets only preview memory", async () => {
    const ephemeralState: WorkspaceAdapterState = {
      ...nativeWorkspaceState(),
      history: { mode: "ephemeral", errorCode: null, backupName: null },
    }
    const deleteWorkspaceHistory = vi.fn().mockResolvedValue(ephemeralState)
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "demo",
      loadState: () => Promise.resolve(ephemeralState),
      deleteWorkspaceHistory,
    }
    const user = userEvent.setup()
    renderWorkspace(adapter)

    expect(
      await screen.findByText(
        "Codex and Git are not connected. Demo workspace activity is kept in memory and resets when this preview restarts.",
      ),
    ).toBeVisible()
    expect(screen.getByText("Demo memory")).toBeVisible()

    await user.click(screen.getByRole("tab", { name: "Settings" }))
    await user.click(screen.getByRole("button", { name: "Diagnostics" }))
    const localHistory = await screen.findByText("Local history")
    expect(localHistory.parentElement).toHaveTextContent("Demo memory")

    await user.click(screen.getByRole("button", { name: "History & privacy" }))
    expect(screen.getByText("Stored in demo memory")).toBeVisible()
    expect(
      screen.getByText(/Reloading restores the bundled demo/),
    ).toBeVisible()
    const reset = screen.getByRole("button", { name: "Reset demo history" })
    expect(reset).toBeEnabled()
    await user.click(reset)
    const dialog = await screen.findByRole("dialog", {
      name: "Reset this preview's demo history?",
    })
    expect(dialog).toHaveTextContent(
      "No repository files, commits, or branches",
    )
    await user.click(within(dialog).getByRole("button", { name: "Reset demo" }))
    await waitFor(() => expect(deleteWorkspaceHistory).toHaveBeenCalledOnce())
    await waitFor(() => expect(reset).toHaveFocus())
  })

  it("restores history action focus after Cancel, Escape, close, and confirm", async () => {
    const deleteWorkspaceHistory = vi
      .fn()
      .mockResolvedValue(nativeWorkspaceState())
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(nativeWorkspaceState()),
      deleteWorkspaceHistory,
    }
    const user = userEvent.setup()
    renderWorkspace(adapter)

    await user.click(await screen.findByRole("tab", { name: "Settings" }))
    await user.click(screen.getByRole("button", { name: "History & privacy" }))
    const trigger = screen.getByRole("button", {
      name: "Delete workspace history",
    })

    await user.click(trigger)
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    )
    await waitFor(() => expect(trigger).toHaveFocus())

    await user.click(trigger)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(trigger).toHaveFocus())

    await user.click(trigger)
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Close",
      }),
    )
    await waitFor(() => expect(trigger).toHaveFocus())

    await user.click(trigger)
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete history",
      }),
    )
    await waitFor(() => expect(deleteWorkspaceHistory).toHaveBeenCalledOnce())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it("closes compact settings navigation after selection, Escape, and outside click", async () => {
    const user = userEvent.setup()
    renderWorkspace()

    await user.click(screen.getByRole("tab", { name: "Settings" }))
    const navigationTrigger = screen
      .getAllByRole<HTMLButtonElement>("button", { name: "General" })
      .find((button) => button.dataset.slot === "popover-trigger")
    expect(navigationTrigger).toBeDefined()

    await user.click(navigationTrigger as HTMLButtonElement)
    const navigation = await waitFor(() => {
      const value = document.querySelector<HTMLElement>(
        '[data-slot="popover-content"] nav',
      )
      expect(value).not.toBeNull()
      return value as HTMLElement
    })
    const historyButton = within(navigation).getByRole("button", {
      name: "History & privacy",
    })
    historyButton.focus()
    await user.keyboard("{Enter}")

    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="popover-content"]'),
      ).not.toBeInTheDocument(),
    )
    expect(
      screen.getByRole("heading", { name: "History & privacy" }),
    ).toBeVisible()
    expect(navigationTrigger).toHaveFocus()

    await user.click(navigationTrigger as HTMLButtonElement)
    expect(
      document.querySelector('[data-slot="popover-content"]'),
    ).toBeInTheDocument()
    await user.keyboard("{Escape}")
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="popover-content"]'),
      ).not.toBeInTheDocument(),
    )
    expect(navigationTrigger).toHaveFocus()

    await user.click(navigationTrigger as HTMLButtonElement)
    expect(
      document.querySelector('[data-slot="popover-content"]'),
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole("heading", { name: "Settings & diagnostics" }),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="popover-content"]'),
      ).not.toBeInTheDocument(),
    )
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

  it("groups compact persistence and companion status without removing controls", async () => {
    const user = userEvent.setup()
    const { container } = renderWorkspace()
    const statusRegion = container.querySelector<HTMLElement>(
      "[data-chat-status-region]",
    )
    const persistenceStatus = container.querySelector<HTMLElement>(
      "[data-persistence-status]",
    )
    const companionStatus = container.querySelector<HTMLElement>(
      "[data-companion-status-mobile]",
    )

    expect(statusRegion).toContainElement(persistenceStatus)
    expect(statusRegion).toContainElement(companionStatus)
    expect(persistenceStatus).toHaveTextContent("Persisted locally")
    expect(companionStatus).toHaveTextContent("Disconnected")

    const mute = within(companionStatus as HTMLElement).getByRole("button", {
      name: "Mute companion",
    })
    await user.click(mute)
    expect(mute).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument()
    expect(
      screen.getByPlaceholderText(
        "Ask Codex to plan, build, explain, or fix anything…",
      ),
    ).toBeInTheDocument()
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
    expect(await screen.findByRole("button", { name: "Stop" })).toBeDisabled()
  })

  it("renders rich Codex events and submits bounded decisions and approvals", async () => {
    const snapshot = richCodexState()
    const respondPending = vi.fn().mockResolvedValue(true)
    const stopTurn = vi.fn().mockResolvedValue(undefined)
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(nativeWorkspaceState()),
      codexSnapshot: () => snapshot,
      subscribeCodex(listener) {
        listener(snapshot)
        return () => undefined
      },
      respondPending,
      stopTurn,
    }
    const user = userEvent.setup()

    const { container } = renderWorkspace(adapter)

    expect(await screen.findByText("You")).toBeVisible()
    expect(screen.getByText("Codex")).toBeVisible()
    expect(screen.getByText("Tool run")).toBeVisible()
    expect(screen.getByText("46 focused tests passed")).toBeVisible()
    expect(screen.getByText("Your decision is needed")).toBeVisible()
    expect(screen.getByText("Approval required")).toBeVisible()
    const approval = container.querySelector<HTMLElement>(
      '[data-event-kind="approval"]',
    )
    expect(approval).not.toBeNull()
    expect(
      within(approval as HTMLElement).getByText("Risk").parentElement,
    ).toHaveTextContent("low")
    expect(
      within(approval as HTMLElement).getByText("Reversibility").parentElement,
    ).toHaveTextContent("reversible")

    await user.click(screen.getByText("One bounded unit"))
    await user.click(screen.getByRole("button", { name: "Send answer" }))
    await waitFor(() =>
      expect(respondPending).toHaveBeenCalledWith({
        workspaceId: "workspace-native",
        pendingId: "pending-decision",
        response: {
          type: "user_input",
          answers: { scope: ["bounded"] },
        },
      }),
    )

    await user.click(screen.getByRole("button", { name: "Approve once" }))
    await waitFor(() =>
      expect(respondPending).toHaveBeenCalledWith({
        workspaceId: "workspace-native",
        pendingId: "pending-approval",
        response: { type: "approval", decision: "approve_once" },
      }),
    )

    expect(screen.getByRole("button", { name: "Reject" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Stop turn" })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Interrupt turn" }))
    await waitFor(() =>
      expect(stopTurn).toHaveBeenCalledWith("workspace-native"),
    )
  })

  it("expands and copies only rendered safe timeline details", async () => {
    const snapshot = richCodexState()
    const writeText = vi.fn().mockResolvedValue(undefined)
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(nativeWorkspaceState()),
      codexSnapshot: () => snapshot,
      subscribeCodex(listener) {
        listener(snapshot)
        return () => undefined
      },
    }
    const user = userEvent.setup()
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    const { container } = renderWorkspace(adapter)

    await screen.findByText("Your decision is needed")
    const assistant = container.querySelector<HTMLElement>(
      '[data-event-kind="assistant"]',
    )
    expect(assistant).not.toBeNull()
    const details = within(assistant as HTMLElement)
    const expand = details.getByRole("button", { name: "Show safe details" })
    expect(expand).toHaveAttribute("aria-expanded", "false")
    await user.click(expand)
    expect(expand).toHaveAttribute("aria-expanded", "true")

    await user.click(details.getByRole("button", { name: "Copy safe details" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    expect(writeText.mock.calls[0]?.[0]).toMatch(/All checks passed/u)
    expect(
      details.getByRole("button", { name: "Copy safe details" }),
    ).toHaveTextContent("Copied")
  })

  it("locks auto-scroll beyond 48px and counts new timeline updates", async () => {
    const snapshot = richCodexState()
    let publish!: (state: WorkspaceCodexState) => void
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(nativeWorkspaceState()),
      codexSnapshot: () => snapshot,
      subscribeCodex(listener) {
        publish = listener
        listener(snapshot)
        return () => undefined
      },
    }
    const user = userEvent.setup()
    const { container } = renderWorkspace(adapter)
    await screen.findByText("Your decision is needed")
    const viewport = container.querySelector<HTMLElement>(
      '.chat-pane [data-slot="scroll-area-viewport"]',
    )
    expect(viewport).not.toBeNull()
    Object.defineProperties(viewport as HTMLElement, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, value: 500, writable: true },
      scrollTo: {
        configurable: true,
        value: ({ top }: ScrollToOptions) => {
          ;(viewport as HTMLElement).scrollTop = Number(top ?? 0)
          fireEvent.scroll(viewport as HTMLElement)
        },
      },
    })
    fireEvent.scroll(viewport as HTMLElement)
    expect(await screen.findByRole("button", { name: "Latest" })).toBeVisible()

    const completion = {
      workspaceId: "workspace-native",
      generation: 1,
      occurredAt: "2026-07-18T00:01:00.000Z",
      durable: true,
      id: "event-completion",
      stableId: "turn-completion",
      sourceEventId: "event-completion",
      sourceSequence: 6,
      kind: "completion" as const,
      status: "completed",
      threadHandle: "thread-fixture",
      turnHandle: "turn-fixture",
    }
    act(() =>
      publish({
        ...snapshot,
        timeline: [...snapshot.timeline, completion],
      }),
    )

    const latest = await screen.findByRole("button", {
      name: "New updates: 1",
    })
    await user.click(latest)
    expect((viewport as HTMLElement).scrollTop).toBe(1000)
    expect(
      screen.queryByRole("button", { name: /New updates/u }),
    ).not.toBeInTheDocument()
  })

  it("keeps native picker and pasted paths behind opaque attachment handles", async () => {
    const readySnapshot: WorkspaceCodexState = {
      ...richCodexState(),
      phase: "ready",
      pendingRequests: [],
      timeline: [],
    }
    const pickAttachments = vi.fn().mockResolvedValue({
      items: [
        {
          schemaVersion: 1,
          handle: "attachment-picker",
          name: "requirements.md",
          relativePath: "docs/requirements.md",
          sizeBytes: 128,
          kind: "file",
          source: "picker",
          expiresAt: "2026-07-18T00:30:00.000Z",
        },
      ],
      rejections: [],
    })
    const registerAttachmentPaths = vi.fn().mockResolvedValue({
      items: [
        {
          schemaVersion: 1,
          handle: "attachment-paste",
          name: "pasted.png",
          relativePath: "assets/pasted.png",
          sizeBytes: 256,
          kind: "image",
          source: "paste",
          expiresAt: "2026-07-18T00:30:00.000Z",
        },
      ],
      rejections: [],
    })
    const sendTurn = vi.fn().mockResolvedValue({ accepted: true })
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(nativeWorkspaceState()),
      codexSnapshot: () => readySnapshot,
      subscribeCodex(listener) {
        listener(readySnapshot)
        return () => undefined
      },
      pickAttachments,
      registerAttachmentPaths,
      sendTurn,
    }
    const user = userEvent.setup()
    renderWorkspace(adapter)
    const composer = await screen.findByPlaceholderText(
      "Ask Codex to plan, build, explain, or fix anything…",
    )

    await user.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() =>
      expect(pickAttachments).toHaveBeenCalledWith("workspace-native", []),
    )
    expect(
      await screen.findByRole("button", {
        name: "Remove attachment: requirements.md",
      }),
    ).toBeVisible()

    fireEvent.paste(composer, {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/uri-list"
            ? "file:///Users/private/project/assets/pasted.png"
            : "",
      },
    })
    await waitFor(() =>
      expect(registerAttachmentPaths).toHaveBeenCalledWith(
        "workspace-native",
        "paste",
        ["/Users/private/project/assets/pasted.png"],
        ["attachment-picker"],
      ),
    )
    expect(
      await screen.findByRole("button", {
        name: "Remove attachment: pasted.png",
      }),
    ).toBeVisible()
    expect(screen.queryByText(/Users\/private/u)).not.toBeInTheDocument()

    await user.type(composer, "Use the registered evidence")
    await user.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(sendTurn).toHaveBeenCalledOnce())
    expect(sendTurn.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        workspaceId: "workspace-native",
        instruction: "Use the registered evidence",
        attachments: [
          expect.objectContaining({ id: "attachment-picker" }),
          expect.objectContaining({ id: "attachment-paste" }),
        ],
      }),
    )
    expect(sendTurn.mock.calls[0]?.[0]).not.toHaveProperty("paths")
  })
})
