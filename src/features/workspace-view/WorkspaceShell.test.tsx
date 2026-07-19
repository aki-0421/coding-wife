import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEventDriver, {
  PointerEventsCheckLevel,
} from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { App } from "@/app/App"
import type {
  AppCleanupFailedV1,
  AppCloseRequestedV1,
  AppLifecycleCleanupFailedListener,
  AppLifecycleCloseListener,
  AppLifecycleGateway,
} from "@/features/app-lifecycle"
import type { LocalePreferenceStore } from "@/features/localization"
import { DemoNarrationGateway, NarrationController } from "@/features/narration"
import {
  NativeReadinessController,
  type NativeReadinessGateway,
  type NativeReadinessSnapshotV1,
  readinessCheckIds,
} from "@/features/readiness"
import { DemoTransport } from "@/features/runtime"
import type {
  SendTurnRequest,
  WorkspaceAdapterState,
  WorkspaceCodexState,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"

const userEvent = {
  setup: () => {
    const keyboardDriver = userEventDriver.setup({
      delay: null,
      pointerEventsCheck: PointerEventsCheckLevel.Never,
      skipHover: true,
    })
    return {
      // This suite verifies application click handlers, not browser pointer sequencing.
      click: async (element: Element) => {
        const openPopover = document.querySelector(
          '[data-slot="popover-content"]',
        )
        if (
          element.closest('[data-slot="popover-close"]') !== null ||
          (openPopover !== null && !openPopover.contains(element))
        ) {
          await keyboardDriver.click(element)
          return
        }
        if (
          element instanceof HTMLElement &&
          !(element instanceof HTMLButtonElement ||
          element instanceof HTMLInputElement
            ? element.disabled
            : false)
        ) {
          element.focus()
        }
        fireEvent.click(element)
      },
      clear: (element: Element) => {
        if (
          !(element instanceof HTMLInputElement) &&
          !(element instanceof HTMLTextAreaElement)
        ) {
          throw new Error("Expected a text entry control")
        }
        fireEvent.change(element, { target: { value: "" } })
        return Promise.resolve()
      },
      type: (element: Element, text: string) => {
        if (
          !(element instanceof HTMLInputElement) &&
          !(element instanceof HTMLTextAreaElement)
        ) {
          throw new Error("Expected a text entry control")
        }
        fireEvent.change(element, {
          target: { value: `${element.value}${text}` },
        })
        return Promise.resolve()
      },
      keyboard: keyboardDriver.keyboard,
      tab: keyboardDriver.tab,
    }
  },
}

const englishLocaleStore: LocalePreferenceStore = {
  persistence: "session-only",
  read: () => "en",
  write: () => true,
}

const japaneseLocaleStore: LocalePreferenceStore = {
  persistence: "session-only",
  read: () => "ja",
  write: () => true,
}

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

function appLifecycleHarness() {
  let listener: AppLifecycleCloseListener | null = null
  let cleanupListener: AppLifecycleCleanupFailedListener | null = null
  const cancelQuit = vi
    .fn<(_: string) => Promise<void>>()
    .mockResolvedValue(undefined)
  const confirmQuit = vi
    .fn<(_: string) => Promise<void>>()
    .mockResolvedValue(undefined)
  const retryCleanup = vi
    .fn<(_: string) => Promise<void>>()
    .mockResolvedValue(undefined)
  const gateway: AppLifecycleGateway = {
    listenCloseRequested(nextListener) {
      listener = nextListener
      return Promise.resolve(() => {
        listener = null
      })
    },
    listenCleanupFailed(nextListener) {
      cleanupListener = nextListener
      return Promise.resolve(() => {
        cleanupListener = null
      })
    },
    cancelQuit,
    confirmQuit,
    retryCleanup,
  }
  return {
    cancelQuit,
    confirmQuit,
    retryCleanup,
    emit(request: AppCloseRequestedV1) {
      if (listener === null) throw new Error("Close listener is not ready")
      listener(request)
    },
    emitCleanupFailure(failure: AppCleanupFailedV1) {
      if (cleanupListener === null) {
        throw new Error("Cleanup listener is not ready")
      }
      cleanupListener(failure)
    },
    gateway,
  }
}

function readyNativeReadinessController(): NativeReadinessController {
  const checkedAt = "2026-07-18T00:00:00.000Z"
  const snapshot: NativeReadinessSnapshotV1 = {
    schemaVersion: 1,
    snapshotId: "123e4567-e89b-42d3-a456-426614174000",
    checkedAt,
    source: "native",
    checks: readinessCheckIds.map((id) => ({
      id,
      status: "ready",
      checkedAt,
      code: `READINESS-${id.toUpperCase().replace("_", "-")}-READY`,
      recoverable: false,
      recoveryAction: "none",
      facts: [],
    })),
  }
  const gateway: NativeReadinessGateway = {
    kind: "native",
    run: () => Promise.resolve(snapshot),
    copy: (snapshotId) =>
      Promise.resolve({
        schemaVersion: 1,
        snapshotId,
        summary: "Coding Wife diagnostics v1\nsource=native\n",
      }),
  }
  return new NativeReadinessController(gateway)
}

function renderWorkspace(adapter?: WorkspaceViewAdapter) {
  return render(
    <App
      localeStore={englishLocaleStore}
      transport={new DemoTransport()}
      {...(adapter?.hydrationMode === "native"
        ? { readinessController: readyNativeReadinessController() }
        : {})}
      {...(adapter ? { workspaceAdapter: adapter } : {})}
    />,
  )
}

function appSettingsButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    "button[data-app-settings-trigger]",
  )
  if (button === null) throw new Error("Expected the app settings trigger")
  return button
}

function expectFocusWithin(container: HTMLElement): void {
  const activeElement = document.activeElement
  if (!(activeElement instanceof HTMLElement)) {
    throw new Error("Expected focus to be on an HTML element")
  }
  expect(container).toContainElement(activeElement)
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
    decisionContext: {
      schemaVersion: 1 as const,
      category: "user_decision" as const,
      targetKind: "active_turn" as const,
      targetAlias: "current turn",
      effect: "continue_turn" as const,
      scope: "turn" as const,
      risk: "medium" as const,
      reversibility: "unknown" as const,
      recommendation: "bounded",
      evidence: ["One bounded unit keeps the next change reviewable."],
      uncertainty: "limited_context" as const,
    },
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
    decisionContext: {
      schemaVersion: 1 as const,
      category: "command_execution" as const,
      targetKind: "workspace" as const,
      targetAlias: "project test command",
      effect: "execute_command" as const,
      scope: "command" as const,
      risk: "low" as const,
      reversibility: "reversible" as const,
      recommendation: "approve_once" as const,
      evidence: ["No network or repository history operation is requested."],
      uncertainty: "none" as const,
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
    activeWorkspaceId: "workspace-native",
    generation: 1,
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
  it("keeps Linear workspace statuses in English for the Japanese locale", () => {
    const { container } = render(
      <App localeStore={japaneseLocaleStore} transport={new DemoTransport()} />,
    )
    const navigation = screen.getByRole("navigation", {
      name: "ワークスペース",
    })

    for (const [label, count] of [
      ["Done", 1],
      ["In Review", 1],
      ["In Progress", 1],
      ["Backlog", 0],
      ["Canceled", 0],
    ] as const) {
      expect(
        within(navigation).getByRole("heading", {
          name: `${label}(${count})`,
        }),
      ).toBeVisible()
    }

    expect(
      within(navigation).getByRole("button", {
        name: "main, aki-0421/coding-wife, Done",
      }),
    ).toBeVisible()
    for (const localizedLabel of [
      "完了",
      "レビュー可能",
      "実行中",
      "未着手",
      "中止",
    ]) {
      expect(within(navigation).queryByText(localizedLabel)).toBeNull()
    }
    expect(
      container.querySelectorAll("[data-linear-status-icon]"),
    ).toHaveLength(5)
    for (const lifecycle of [
      "done",
      "in_review",
      "in_progress",
      "backlog",
      "canceled",
    ]) {
      expect(
        container.querySelector(`[data-linear-status-icon="${lifecycle}"]`),
      ).not.toBeNull()
    }
  })

  it("expands lifecycle groups by default and toggles them independently", async () => {
    const user = userEvent.setup()
    renderWorkspace()
    const navigation = screen.getByRole("navigation", { name: "Workspaces" })
    expect(navigation).toHaveClass("max-w-[242.25px]")
    const doneToggle = within(navigation).getByRole("button", {
      name: "Done(1)",
    })
    const reviewToggle = within(navigation).getByRole("button", {
      name: "In Review(1)",
    })
    const backlogToggle = within(navigation).getByRole("button", {
      name: "Backlog(0)",
    })
    const selectedWorkspace = within(navigation).getByRole("button", {
      name: /feature\/live2d-companion, aki-0421\/coding-wife/,
    })

    expect(doneToggle).toHaveAttribute("aria-expanded", "true")
    expect(reviewToggle).toHaveAttribute("aria-expanded", "true")
    expect(doneToggle.querySelector("[data-workspace-status-count]")).toBeNull()
    expect(
      within(navigation).getByRole("button", {
        name: "main, aki-0421/coding-wife, Done",
      }),
    ).toBeVisible()
    expect(selectedWorkspace).toHaveAttribute("aria-current", "page")

    const controlledContentId = doneToggle.getAttribute("aria-controls")
    expect(controlledContentId).not.toBeNull()
    expect(
      document.getElementById(controlledContentId as string),
    ).not.toHaveAttribute("hidden")
    expect(
      doneToggle.querySelector("[data-workspace-status-chevron]"),
    ).toHaveClass("opacity-0", "group-hover/status:opacity-100")

    await user.click(doneToggle)

    expect(doneToggle).toHaveAttribute("aria-expanded", "false")
    const doneCount = doneToggle.querySelector(
      '[data-workspace-status-count="done"]',
    )
    expect(doneCount).toHaveTextContent("1")
    expect(doneCount).toHaveAttribute("aria-hidden", "true")
    expect(
      document.getElementById(controlledContentId as string),
    ).toHaveAttribute("hidden")
    expect(reviewToggle).toHaveAttribute("aria-expanded", "true")
    expect(
      within(navigation).queryByRole("button", {
        name: "main, aki-0421/coding-wife, Done",
      }),
    ).toBeNull()
    expect(selectedWorkspace).toHaveAttribute("aria-current", "page")

    await user.click(backlogToggle)
    expect(backlogToggle).toHaveAttribute("aria-expanded", "false")
    expect(
      backlogToggle.querySelector('[data-workspace-status-count="backlog"]'),
    ).toHaveTextContent("0")

    doneToggle.focus()
    await user.keyboard(" ")

    expect(doneToggle).toHaveAttribute("aria-expanded", "true")
    expect(doneToggle.querySelector("[data-workspace-status-count]")).toBeNull()
    expect(
      within(navigation).getByRole("button", {
        name: "main, aki-0421/coding-wife, Done",
      }),
    ).toBeVisible()
  })

  it("uses branch titles and GitHub repository metadata with stable typography", () => {
    renderWorkspace()
    const navigation = screen.getByRole("navigation", { name: "Workspaces" })
    const doneToggle = within(navigation).getByRole("button", {
      name: "Done(1)",
    })
    const doneWorkspace = within(navigation).getByRole("button", {
      name: "main, aki-0421/coding-wife, Done",
    })
    const selectedWorkspace = within(navigation).getByRole("button", {
      name: /feature\/live2d-companion, aki-0421\/coding-wife/,
    })

    expect(screen.getByRole("heading", { name: "Workspaces" })).toHaveClass(
      "text-sidebar-heading",
    )
    expect(doneToggle).toHaveClass("text-sidebar-status")
    expect(within(doneWorkspace).getByText("main")).toHaveClass(
      "text-sidebar-item",
      "text-foreground",
    )
    expect(within(doneWorkspace).getByText("aki-0421/coding-wife")).toHaveClass(
      "font-mono",
      "text-sidebar-meta",
      "text-muted-foreground",
    )
    expect(
      navigation.querySelectorAll('[data-repository-avatar="github"]'),
    ).toHaveLength(3)
    expect(
      doneWorkspace.querySelector('[data-repository-avatar="github"]'),
    ).toHaveAttribute("data-github-owner", "aki-0421")
    expect(
      within(selectedWorkspace).getByText("feature/live2d-companion"),
    ).toHaveClass("text-sidebar-item", "text-text-strong")
    expect(within(doneWorkspace).queryByText("sol-desktop")).toBeNull()
  })

  it("keeps duplicate native close requests behind one safe cancellation", async () => {
    const lifecycle = appLifecycleHarness()
    const prepareAppQuit = vi.fn()
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(nativeWorkspaceState()),
      prepareAppQuit,
    }
    const request = {
      schemaVersion: 1 as const,
      requestId: "app-quit-integration-cancel",
      workspaceId: "workspace-native",
      workspaceGeneration: 1,
    }
    render(
      <App
        appLifecycleGateway={lifecycle.gateway}
        localeStore={englishLocaleStore}
        transport={new DemoTransport()}
        workspaceAdapter={adapter}
      />,
    )
    await act(async () => Promise.resolve())

    act(() => {
      lifecycle.emit(request)
      lifecycle.emit(request)
    })
    const dialog = screen.getByRole("dialog", {
      name: "Stop the active turn and quit?",
    })
    const safeAction = within(dialog).getByRole("button", {
      name: "Don’t Quit",
    })
    expect(safeAction).toHaveFocus()
    fireEvent.click(safeAction)

    await waitFor(() =>
      expect(lifecycle.cancelQuit).toHaveBeenCalledWith(request.requestId),
    )
    expect(lifecycle.cancelQuit).toHaveBeenCalledTimes(1)
    expect(prepareAppQuit).not.toHaveBeenCalled()
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
  })

  it("terminalizes and flushes the exact workspace before native quit", async () => {
    const lifecycle = appLifecycleHarness()
    const terminalization = deferred<void>()
    const order: string[] = []
    const prepareAppQuit = vi.fn(() => {
      order.push("terminalize")
      return terminalization.promise
    })
    lifecycle.confirmQuit.mockImplementation(() => {
      order.push("native-quit")
      return Promise.resolve()
    })
    const state = {
      ...nativeWorkspaceState(),
      draft: {
        ...nativeWorkspaceState().draft!,
        text: "Preserve before quit.",
        effort: "max" as const,
      },
    }
    const codex = richCodexState()
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(state),
      codexSnapshot: () => codex,
      subscribeCodex(listener) {
        listener(codex)
        return () => undefined
      },
      prepareAppQuit,
    }
    const narrationGateway = new DemoNarrationGateway()
    const narrationController = new NarrationController(narrationGateway)
    vi.spyOn(narrationController, "dismissPresentation").mockImplementation(
      (reason) => {
        if (reason === "app_close") order.push("presentation-cleanup")
        return Promise.resolve()
      },
    )
    const request = {
      schemaVersion: 1 as const,
      requestId: "app-quit-integration-confirm",
      workspaceId: "workspace-native",
      workspaceGeneration: 1,
    }
    render(
      <App
        appLifecycleGateway={lifecycle.gateway}
        localeStore={englishLocaleStore}
        narrationController={narrationController}
        narrationGateway={narrationGateway}
        transport={new DemoTransport()}
        workspaceAdapter={adapter}
      />,
    )
    await act(async () => Promise.resolve())
    act(() => lifecycle.emit(request))

    fireEvent.click(screen.getByRole("button", { name: "Stop and Quit" }))
    expect(prepareAppQuit).toHaveBeenCalledWith({
      workspaceId: "workspace-native",
      expectedGeneration: 1,
      draftText: "Preserve before quit.",
      draftEffort: "max",
    })
    expect(lifecycle.confirmQuit).not.toHaveBeenCalled()
    expect(
      screen.getByRole("button", { name: "Stopping and quitting…" }),
    ).toBeDisabled()

    await act(() => {
      terminalization.resolve()
      return Promise.resolve()
    })
    await waitFor(() =>
      expect(lifecycle.confirmQuit).toHaveBeenCalledWith(request.requestId),
    )
    expect(order).toEqual([
      "terminalize",
      "presentation-cleanup",
      "native-quit",
    ])
  })

  it("keeps the app open after cleanup failure and retries the same request", async () => {
    const lifecycle = appLifecycleHarness()
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(nativeWorkspaceState()),
    }
    render(
      <App
        appLifecycleGateway={lifecycle.gateway}
        localeStore={englishLocaleStore}
        transport={new DemoTransport()}
        workspaceAdapter={adapter}
      />,
    )
    await act(async () => Promise.resolve())

    act(() =>
      lifecycle.emitCleanupFailure({
        schemaVersion: 1,
        requestId: "app-quit-cleanup-retry",
        attempt: 1,
        errorCode: "APP-QUIT-CLEANUP-INCOMPLETE",
      }),
    )
    const dialog = screen.getByRole("dialog", {
      name: "Coding Wife is still open",
    })
    const retry = within(dialog).getByRole("button", {
      name: "Retry Safe Cleanup",
    })
    await waitFor(() => expect(retry).toHaveFocus())
    expect(
      within(dialog).queryByRole("button", { name: "Don’t Quit" }),
    ).not.toBeInTheDocument()

    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" })
    expect(dialog).toBeInTheDocument()
    fireEvent.click(retry)
    await waitFor(() =>
      expect(lifecycle.retryCleanup).toHaveBeenCalledWith(
        "app-quit-cleanup-retry",
      ),
    )
    expect(lifecycle.retryCleanup).toHaveBeenCalledTimes(1)
    expect(
      within(dialog).getByRole("button", {
        name: "Retrying safe cleanup…",
      }),
    ).toBeDisabled()

    act(() =>
      lifecycle.emitCleanupFailure({
        schemaVersion: 1,
        requestId: "app-quit-cleanup-retry",
        attempt: 2,
        errorCode: "APP-QUIT-CLEANUP-INCOMPLETE",
      }),
    )
    expect(
      within(dialog).getByRole("button", { name: "Retry Safe Cleanup" }),
    ).toBeEnabled()
  })

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
      .mockRejectedValueOnce(new Error("/\u0055sers/private/history.sqlite3"))
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
    expect(screen.queryByText(/\u0055sers\/private/)).not.toBeInTheDocument()
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

  it("shows the GitHub owner avatar before the repository breadcrumb", async () => {
    const BrowserImage = window.Image
    class LoadedImage extends BrowserImage {
      constructor() {
        super()
        Object.defineProperties(this, {
          complete: { configurable: true, value: true },
          naturalWidth: { configurable: true, value: 48 },
        })
      }
    }
    vi.stubGlobal("Image", LoadedImage)

    try {
      renderWorkspace()

      const breadcrumb = screen.getByRole("navigation", {
        name: "Repository location",
      })
      expect(within(breadcrumb).getByText("aki-0421/coding-wife")).toBeVisible()
      expect(
        within(breadcrumb).getByText("build-live2d-desktop-app"),
      ).toHaveAttribute("aria-current", "page")

      const avatar = breadcrumb
        .closest("header")
        ?.querySelector('[data-repository-avatar="github"]')
      expect(avatar).toHaveAttribute("data-github-owner", "aki-0421")
      await waitFor(() =>
        expect(
          avatar?.querySelector('[data-slot="avatar-image"]'),
        ).toHaveAttribute(
          "src",
          "https://avatars.githubusercontent.com/aki-0421?size=48",
        ),
      )
      expect(
        avatar?.querySelector('[data-slot="avatar-image"]'),
      ).toHaveAttribute("referrerpolicy", "no-referrer")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("uses a neutral repository avatar when GitHub metadata is absent", async () => {
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(nativeWorkspaceState()),
    }

    renderWorkspace(adapter)

    expect(await screen.findByText("restored-workspace")).toBeVisible()
    const breadcrumb = screen.getByRole("navigation", {
      name: "Repository location",
    })
    const avatar = breadcrumb
      .closest("header")
      ?.querySelector('[data-repository-avatar="local"]')
    expect(avatar).toBeVisible()
    expect(
      avatar?.querySelector('[data-slot="avatar-image"]'),
    ).not.toBeInTheDocument()
    expect(
      screen
        .getByRole("navigation", { name: "Workspaces" })
        .querySelector('[data-repository-avatar="local"]'),
    ).toBeVisible()
  })

  it("supports keyboard tab cycling and the workspace filter shortcut", async () => {
    renderWorkspace()

    const workspaceTabs = within(
      screen.getByRole("tablist", { name: "Workspace views" }),
    )
    expect(workspaceTabs.getAllByRole("tab")).toHaveLength(3)
    expect(workspaceTabs.queryByRole("tab", { name: "Context" })).toBeNull()

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

  it("opens read-only commit evidence without exposing a mutation action", async () => {
    const user = userEvent.setup()
    renderWorkspace()

    const commitTab = screen.getByRole("tab", { name: "Commit" })
    await user.click(commitTab)
    await waitFor(() =>
      expect(commitTab).toHaveAttribute("aria-selected", "true"),
    )

    expect(
      await screen.findByRole("heading", {
        name: "feat(git): add read-only commit evidence",
      }),
    ).toBeVisible()
    await user.click(screen.getByRole("tab", { name: "Evidence" }))
    await screen.findByText("Observed gates")
    for (const gate of ["Scope", "Ownership", "Verification", "Risk"]) {
      expect(screen.getAllByText(gate).length).toBeGreaterThan(0)
    }
    expect(
      within(screen.getByRole("main", { name: "Commit evidence" })).queryByRole(
        "textbox",
      ),
    ).not.toBeInTheDocument()
  })

  it("opens the compact filter with Command+K and restores its opener", async () => {
    renderWorkspace()
    const opener = screen.getByRole("button", {
      name: "Open workspace navigation",
    })
    Object.defineProperty(opener, "getClientRects", {
      configurable: true,
      value: () => ({ length: 1 }),
    })

    fireEvent.keyDown(window, { key: "k", metaKey: true })
    const dialog = await screen.findByRole("dialog", { name: "Workspaces" })
    const filter = await within(dialog).findByRole("textbox", {
      name: "Filter workspaces",
    })
    await waitFor(() => expect(filter).toHaveFocus())

    fireEvent.keyDown(dialog, { code: "Escape", key: "Escape" })
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Workspaces" }),
      ).not.toBeInTheDocument(),
    )
    await waitFor(() => expect(opener).toHaveFocus())
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
        name: "main, aki-0421/coding-wife, Done",
      }),
    )
    expect(composer).toHaveValue("")

    fireEvent.click(
      within(workspaceNavigation).getByRole("button", {
        name: /feature\/live2d-companion, aki-0421\/coding-wife/,
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
          name: /main, fixture, In Progress/,
        }),
      ).toBeVisible(),
    )
    fireEvent.change(composer, { target: { value: "Keep draft A" } })
    fireEvent.click(
      within(workspaceNavigation).getByRole("button", {
        name: /main, fixture, Backlog/,
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
      lastSummary: {
        eventId: "event-summary",
        sequence: 8,
        text: "Restored summary after restart.",
        updatedAt: "2026-07-18T00:00:40.000Z",
      },
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
    expect(
      screen.getByRole("region", { name: "Last session summary" }),
    ).toHaveTextContent("Restored summary after restart.")
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

  it("renders a restored summary as text in an accessible English recovery region", async () => {
    const unsafeMarkup = '<img src="x" alt="private-probe">'
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () =>
        Promise.resolve({
          ...nativeWorkspaceState(),
          lastSummary: {
            eventId: "event-safe-summary",
            sequence: 4,
            text: `Completed safely.\n${unsafeMarkup}`,
            updatedAt: "2026-07-18T00:00:04.000Z",
          },
        }),
    }

    renderWorkspace(adapter)

    const summary = await screen.findByRole("region", {
      name: "Last session summary",
    })
    expect(summary).toHaveTextContent("Completed safely.")
    expect(summary.textContent).toContain(unsafeMarkup)
    expect(screen.queryByAltText("private-probe")).not.toBeInTheDocument()
    expect(summary).toHaveTextContent(
      "Restored from this workspace's redacted local history.",
    )
  })

  it("localizes the restored summary region in Japanese", async () => {
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () =>
        Promise.resolve({
          ...nativeWorkspaceState(),
          lastSummary: {
            eventId: "event-ja-summary",
            sequence: 3,
            text: "再起動後も要約を復元しました。",
            updatedAt: "2026-07-18T00:00:03.000Z",
          },
        }),
    }

    render(
      <App
        localeStore={japaneseLocaleStore}
        readinessController={readyNativeReadinessController()}
        transport={new DemoTransport()}
        workspaceAdapter={adapter}
      />,
    )

    const summary = await screen.findByRole("region", {
      name: "前回セッションの要約",
    })
    expect(summary).toHaveTextContent("再起動後も要約を復元しました。")
    expect(summary).toHaveTextContent(
      "このワークスペースの秘匿化済みローカル履歴から復元しました。",
    )
  })

  it.each([
    ["missing repository", "missing", "ready"],
    ["read-only recovery", "read_only", "read_only"],
  ] as const)(
    "keeps the last summary visible during %s",
    async (_label, health, historyMode) => {
      const adapter: WorkspaceViewAdapter = {
        hydrationMode: "native",
        loadState: () =>
          Promise.resolve({
            ...nativeWorkspaceState(),
            workspaces: nativeWorkspaceState().workspaces.map((workspace) => ({
              ...workspace,
              health,
            })),
            lastSummary: {
              eventId: `event-${health}-summary`,
              sequence: 2,
              text: "Recovery keeps this workspace summary available.",
              updatedAt: "2026-07-18T00:00:02.000Z",
            },
            history: {
              mode: historyMode,
              errorCode: historyMode === "read_only" ? "HIST-READ-ONLY" : null,
              backupName: null,
            },
          }),
      }

      renderWorkspace(adapter)

      expect(
        await screen.findByRole("region", { name: "Last session summary" }),
      ).toHaveTextContent("Recovery keeps this workspace summary available.")
    },
  )

  it("clears a workspace-local summary when switching to a workspace without one", async () => {
    const stateFor = (activeWorkspaceId: string): WorkspaceAdapterState => ({
      ...nativeWorkspaceState(),
      workspaces: [
        {
          id: "workspace-native",
          repository: "fixture",
          name: "workspace-a",
          branch: "main",
          lifecycle: "in_progress",
          health: "ready",
        },
        {
          id: "workspace-b",
          repository: "fixture",
          name: "workspace-b",
          branch: "main",
          lifecycle: "backlog",
          health: "ready",
        },
      ],
      activeWorkspaceId,
      lastSummary:
        activeWorkspaceId === "workspace-native"
          ? {
              eventId: "event-workspace-a-summary",
              sequence: 2,
              text: "Workspace A private recovery summary.",
              updatedAt: "2026-07-18T00:00:02.000Z",
            }
          : null,
    })
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(stateFor("workspace-native")),
      selectWorkspace: (workspaceId) => Promise.resolve(stateFor(workspaceId)),
    }

    renderWorkspace(adapter)
    expect(
      await screen.findByRole("region", { name: "Last session summary" }),
    ).toHaveTextContent("Workspace A private recovery summary.")

    const navigation = screen.getByRole("navigation", { name: "Workspaces" })
    fireEvent.click(
      within(navigation).getByRole("button", {
        name: /main, fixture, Backlog/u,
      }),
    )

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Last session summary" }),
      ).not.toBeInTheDocument(),
    )
    expect(
      screen.queryByText("Workspace A private recovery summary."),
    ).not.toBeInTheDocument()
  })

  it("omits the recovery region when the summary is empty", async () => {
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () =>
        Promise.resolve({
          ...nativeWorkspaceState(),
          lastSummary: {
            eventId: "event-empty-summary",
            sequence: 1,
            text: "   \n\t",
            updatedAt: "2026-07-18T00:00:01.000Z",
          },
        }),
    }

    renderWorkspace(adapter)
    await screen.findByRole("heading", { name: "No persisted activity yet" })
    expect(
      screen.queryByRole("region", { name: "Last session summary" }),
    ).not.toBeInTheDocument()
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

  it("separates project context details from workspace settings", async () => {
    const user = userEvent.setup()
    renderWorkspace()

    await user.click(screen.getByRole("tab", { name: "Settings" }))
    expect(
      screen.getByRole("heading", { level: 1, name: "Workspace settings" }),
    ).toBeVisible()
    expect(
      screen.getByText(
        "History and privacy for coding-wife/build-live2d-desktop-app.",
      ),
    ).toBeVisible()
    expect(
      screen.getByRole("heading", { name: "History & privacy" }),
    ).toBeVisible()
    expect(
      screen.queryByRole("button", { name: "Character context" }),
    ).toBeNull()
    expect(screen.queryByRole("button", { name: "Companion" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Project context" })).toBeNull()
    expect(screen.queryByRole("button", { name: "General" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Audio" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Support" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Diagnostics" })).toBeNull()

    await user.click(appSettingsButton())
    const appHeading = screen.getByRole("heading", {
      level: 1,
      name: "App settings",
    })
    expect(appHeading).toBeVisible()
    await waitFor(() => expect(appHeading).toHaveFocus())
    expect(appSettingsButton()).toHaveAttribute("aria-current", "page")
    expect(screen.getAllByRole("button", { name: "General" })[0]).toBeVisible()
    expect(
      screen.getByRole("button", { name: "Character context" }),
    ).toBeVisible()
    expect(screen.getByRole("button", { name: "Companion" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Audio" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Support" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Diagnostics" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Project context" })).toBeNull()
    expect(
      screen.queryByRole("button", { name: "History & privacy" }),
    ).toBeNull()
    expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "Projects" }))
    await user.click(
      screen.getByRole("button", { name: /coding-wife.*3 workspaces/ }),
    )
    expect(
      screen.getByRole("heading", { level: 2, name: "coding-wife" }),
    ).toBeVisible()
    expect(
      await screen.findByRole("button", { name: "Save project context" }),
    ).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Back to projects" }))

    await user.click(screen.getByRole("button", { name: "Back to workspace" }))
    expect(
      screen.getByRole("heading", { level: 1, name: "Workspace settings" }),
    ).toBeVisible()
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Settings/ })).toHaveFocus(),
    )
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
    fireEvent.click(appSettingsButton())
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }))

    const localHistory = await screen.findByRole("heading", {
      name: "Workspace history",
    })
    expect(localHistory.closest("article")).toHaveTextContent("Ready")
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

    await user.click(appSettingsButton())
    await user.click(screen.getByRole("button", { name: "Diagnostics" }))
    const localHistory = await screen.findByRole("heading", {
      name: "Workspace history",
    })
    expect(localHistory.closest("article")).toHaveTextContent("Unavailable")

    await user.click(screen.getByRole("button", { name: "Back to workspace" }))
    await user.click(screen.getByRole("tab", { name: "Settings" }))
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

  it("closes compact app settings navigation after selection, Escape, and outside click", async () => {
    const user = userEvent.setup()
    renderWorkspace()

    await user.click(appSettingsButton())
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
    const diagnosticsButton = within(navigation).getByRole("button", {
      name: "Diagnostics",
    })
    diagnosticsButton.focus()
    await user.keyboard("{Enter}")

    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="popover-content"]'),
      ).not.toBeInTheDocument(),
    )
    expect(screen.getByRole("heading", { name: "Diagnostics" })).toBeVisible()
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
    const outsideTarget = screen.getByRole("heading", {
      name: "App settings",
    })
    await user.click(outsideTarget)
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="popover-content"]'),
      ).not.toBeInTheDocument(),
    )
  })

  it("opens compact navigation from the selected workspace and restores focus", async () => {
    const user = userEvent.setup()
    const { container } = renderWorkspace()

    const selectedWorkspaceTrigger = await waitFor(() => {
      const value = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Switch workspace: coding-wife/build-live2d-desktop-app"]',
      )
      expect(value).not.toBeNull()
      return value as HTMLButtonElement
    })
    await user.click(selectedWorkspaceTrigger)

    const dialog = await waitFor(() => {
      const value = document.querySelector<HTMLElement>('[role="dialog"]')
      expect(value).not.toBeNull()
      return value as HTMLElement
    })
    expect(dialog).toHaveAccessibleName("Workspaces")
    expect(selectedWorkspaceTrigger).toHaveAttribute("aria-expanded", "true")

    fireEvent.keyDown(dialog, { code: "Escape", key: "Escape" })
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).not.toBeInTheDocument(),
    )
    await waitFor(() => expect(selectedWorkspaceTrigger).toHaveFocus())

    await user.click(selectedWorkspaceTrigger)
    const reopenedDialog = await waitFor(() => {
      const value = document.querySelector<HTMLElement>('[role="dialog"]')
      expect(value).not.toBeNull()
      return value as HTMLElement
    })
    expect(reopenedDialog).toHaveAccessibleName("Workspaces")
    await user.click(
      within(reopenedDialog).getByRole("button", {
        name: "main, aki-0421/coding-wife, Done",
      }),
    )

    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).not.toBeInTheDocument(),
    )
    expect(
      container.querySelector(
        'button[aria-label="Switch workspace: coding-wife/sol-desktop"]',
      ),
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

  it("disables unavailable effort choices and falls back from a persisted choice", async () => {
    const state = nativeWorkspaceState()
    const persistedMax: WorkspaceAdapterState = {
      ...state,
      draft: { ...state.draft!, effort: "max" },
    }
    const snapshot: WorkspaceCodexState = {
      ...richCodexState(),
      phase: "blocked",
      connected: false,
      readiness: {
        ready: false,
        fastAvailable: true,
        maxAvailable: false,
        reasonCode: "CODEX-EFFORT-UNAVAILABLE",
      },
      pendingRequests: [],
      timeline: [],
      errorCode: "CODEX-EFFORT-UNAVAILABLE",
    }
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(persistedMax),
      codexSnapshot: () => snapshot,
      subscribeCodex(listener) {
        listener(snapshot)
        return () => undefined
      },
    }
    renderWorkspace(adapter)

    const maximum = await screen.findByRole("radio", { name: "Max" })
    const fast = screen.getByRole("radio", { name: "Fast" })
    expect(maximum).toBeDisabled()
    expect(fast).toBeEnabled()
    await waitFor(() => expect(fast).toHaveAttribute("aria-checked", "true"))
    expect(
      screen.getByText("Maximum reasoning is not available in this runtime."),
    ).toBeVisible()
  })

  it("bounds composer input by Unicode scalar values", () => {
    renderWorkspace()
    const composer = screen.getByPlaceholderText(
      "Ask Codex to plan, build, explain, or fix anything…",
    )
    fireEvent.change(composer, { target: { value: "😀".repeat(32_001) } })
    expect(Array.from((composer as HTMLTextAreaElement).value)).toHaveLength(
      32_000,
    )
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
    await waitFor(() =>
      expect(
        document.querySelector('main[data-runtime="ready"]'),
      ).toBeVisible(),
    )

    const composer = screen.getByPlaceholderText(
      "Ask Codex to plan, build, explain, or fix anything…",
    )
    fireEvent.change(composer, {
      target: { value: "Run the bounded implementation" },
    })
    const send = screen.getByRole("button", { name: "Send" })
    expect(send).toBeEnabled()
    fireEvent.click(send)

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      attachments: [],
      contextSnapshots: [],
      effort: "fast",
      instruction: "Run the bounded implementation",
      workspaceId: "build-live2d-desktop-app",
      editableContextSnapshot: {
        workspaceId: "build-live2d-desktop-app",
        projectVersion: 1,
        characterVersion: 1,
      },
    })
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

    const userEventRow = await waitFor(() => {
      const value = container.querySelector<HTMLElement>(
        '[data-event-id="event-user"]',
      )
      expect(value).not.toBeNull()
      return value as HTMLElement
    })
    const assistantEvent = container.querySelector<HTMLElement>(
      '[data-event-id="event-assistant"]',
    )
    const toolEvent = container.querySelector<HTMLElement>(
      '[data-event-id="event-tool"]',
    )
    expect(assistantEvent).not.toBeNull()
    expect(toolEvent).not.toBeNull()
    expect(within(userEventRow).getByText("You")).toBeVisible()
    expect(
      within(assistantEvent as HTMLElement).getByText("Codex"),
    ).toBeVisible()
    expect(within(toolEvent as HTMLElement).getByText("Tool run")).toBeVisible()
    expect(
      within(toolEvent as HTMLElement).getByText("46 focused tests passed"),
    ).toBeVisible()
    const compactCompanion = container.querySelector<HTMLElement>(
      "[data-companion-status-mobile]",
    )
    expect(compactCompanion).not.toBeNull()
    expect(
      within(compactCompanion as HTMLElement).getByText("Waiting for you"),
    ).toBeVisible()
    const approval = container.querySelector<HTMLElement>(
      '[data-event-kind="approval"]',
    )
    expect(approval).not.toBeNull()
    expect(
      within(approval as HTMLElement).getByText("Approval required"),
    ).toBeVisible()
    expect(
      within(approval as HTMLElement).getByText("Risk").parentElement,
    ).toHaveTextContent("Low")
    expect(
      within(approval as HTMLElement).getByText("Reversibility").parentElement,
    ).toHaveTextContent("Reversible")
    expect(
      within(approval as HTMLElement).getByText("Effect").parentElement,
    ).toHaveTextContent("Run the command")
    expect(
      within(approval as HTMLElement).getByText("Recommendation").parentElement,
    ).toHaveTextContent("Approve once")
    const decision = container.querySelector<HTMLElement>(
      '[data-event-kind="decision"]',
    )
    expect(decision).not.toBeNull()
    expect(
      within(decision as HTMLElement).getByText("Your decision is needed"),
    ).toBeVisible()
    expect(
      within(decision as HTMLElement).getByText("Effect").parentElement,
    ).toHaveTextContent("Continue the active turn")
    expect(
      within(decision as HTMLElement).getByText("Recommendation").parentElement,
    ).toHaveTextContent("One bounded unit")

    await user.click(
      within(decision as HTMLElement).getByRole("radio", {
        name: /One bounded unit/,
      }),
    )
    await user.click(
      within(decision as HTMLElement).getByRole("button", {
        name: "Send answer",
      }),
    )
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

    await user.click(
      within(approval as HTMLElement).getByRole("button", {
        name: "Approve once",
      }),
    )
    await waitFor(() =>
      expect(respondPending).toHaveBeenCalledWith({
        workspaceId: "workspace-native",
        pendingId: "pending-approval",
        response: { type: "approval", decision: "approve_once" },
      }),
    )

    expect(
      within(approval as HTMLElement).getByRole("button", { name: "Reject" }),
    ).toBeVisible()
    const stopAction = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Stop turn",
    )
    expect(stopAction).toBeVisible()
    await user.click(
      within(decision as HTMLElement).getByRole("button", {
        name: "Interrupt turn",
      }),
    )
    const interruptDialog = await waitFor(() => {
      const title = Array.from(document.querySelectorAll("h2")).find(
        (heading) => heading.textContent === "Interrupt this turn?",
      )
      const value = title?.closest<HTMLElement>('[role="dialog"]') ?? null
      expect(value).not.toBeNull()
      return value as HTMLElement
    })
    await user.click(
      within(interruptDialog).getByRole("button", { name: "Interrupt turn" }),
    )
    await waitFor(() =>
      expect(stopTurn).toHaveBeenCalledWith("workspace-native"),
    )
  })

  it("confirms interruption with trapped focus and keeps failures actionable", async () => {
    const snapshot = richCodexState()
    const stopTurn = vi.fn().mockRejectedValue(new Error("interrupt failed"))
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(nativeWorkspaceState()),
      codexSnapshot: () => snapshot,
      subscribeCodex(listener) {
        listener(snapshot)
        return () => undefined
      },
      stopTurn,
    }
    const user = userEvent.setup()
    renderWorkspace(adapter)

    const trigger = await screen.findByRole("button", {
      name: "Interrupt turn",
    })
    trigger.focus()
    await user.keyboard("{Enter}")
    const dialog = await screen.findByRole("dialog", {
      name: "Interrupt this turn?",
    })
    expectFocusWithin(dialog)
    await user.tab()
    expectFocusWithin(dialog)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()

    await user.click(trigger)
    const reopened = await screen.findByRole("dialog", {
      name: "Interrupt this turn?",
    })
    await user.click(
      within(reopened).getByRole("button", { name: "Interrupt turn" }),
    )
    expect(await within(reopened).findByRole("alert")).toHaveTextContent(
      "The turn could not be interrupted",
    )
    expect(reopened).toBeVisible()
    expect(stopTurn).toHaveBeenCalledWith("workspace-native")
  })

  it("localizes the complete decision trust context in Japanese", async () => {
    const snapshot = richCodexState()
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () =>
        Promise.resolve(
          nativeWorkspaceState([
            {
              id: "context-ja",
              source: "git_diff",
              label: "Git差分",
              capturedAt: "2026-07-18T00:00:00.000Z",
              byteCount: 42,
            },
          ]),
        ),
      codexSnapshot: () => snapshot,
      subscribeCodex(listener) {
        listener(snapshot)
        return () => undefined
      },
    }
    const { container } = render(
      <App
        localeStore={japaneseLocaleStore}
        transport={new DemoTransport()}
        workspaceAdapter={adapter}
      />,
    )

    expect(await screen.findByText("判断が必要です")).toBeVisible()
    const decision = container.querySelector<HTMLElement>(
      '[data-event-kind="decision"]',
    )
    expect(decision).not.toBeNull()
    const card = within(decision as HTMLElement)
    expect(card.getByText("実行されること").parentElement).toHaveTextContent(
      "進行中のターンを続行",
    )
    expect(card.getByText("範囲").parentElement).toHaveTextContent("このターン")
    expect(card.getByText("リスク").parentElement).toHaveTextContent("中")
    expect(card.getByText("可逆性").parentElement).toHaveTextContent("不明")
    expect(card.getByText("推奨").parentElement).toHaveTextContent(
      "One bounded unit",
    )
    expect(card.getByText("不確実性").parentElement).toHaveTextContent(
      "判断材料が限定的",
    )
    expect(
      card.getByText("One bounded unit keeps the next change reviewable."),
    ).toBeVisible()
    expect(screen.getByLabelText("推論強度")).toBeVisible()
    expect(screen.getByLabelText("GPT-5.6 Sol, 固定モデル")).toBeVisible()
    expect(screen.getByLabelText("下書き項目")).toBeVisible()
    const compactCompanion = container.querySelector<HTMLElement>(
      "[data-companion-status-mobile]",
    )
    expect(compactCompanion).not.toBeNull()
    expect(
      within(compactCompanion as HTMLElement).getByText("回答待ち"),
    ).toBeVisible()
  })

  it("keeps a held decision pending and sends a bounded Other answer with Command+Enter", async () => {
    const snapshot = richCodexState()
    const respondPending = vi.fn().mockResolvedValue(true)
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(nativeWorkspaceState()),
      codexSnapshot: () => snapshot,
      subscribeCodex(listener) {
        listener(snapshot)
        return () => undefined
      },
      respondPending,
    }
    const user = userEvent.setup()
    renderWorkspace(adapter)

    await user.click(await screen.findByText("Other"))
    const other = screen.getByRole("textbox", { name: "Scope: Other answer" })
    expect(screen.getByRole("button", { name: "Send answer" })).toBeDisabled()
    fireEvent.change(other, { target: { value: "😀".repeat(2_001) } })
    expect(Array.from((other as HTMLTextAreaElement).value)).toHaveLength(2_000)
    expect(screen.getByText("2000 / 2000")).toBeVisible()
    await user.clear(other)
    await user.type(other, "Keep the public API unchanged")
    await user.click(screen.getByRole("button", { name: "Hold decision" }))
    expect(
      screen.getByText(
        "Held. No response was sent; this turn is still waiting.",
      ),
    ).toBeVisible()
    expect(respondPending).not.toHaveBeenCalled()

    await user.keyboard("{Meta>}{Enter}{/Meta}")
    await waitFor(() =>
      expect(respondPending).toHaveBeenCalledWith({
        workspaceId: "workspace-native",
        pendingId: "pending-decision",
        response: {
          type: "user_input",
          answers: { scope: ["Keep the public API unchanged"] },
        },
      }),
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

  it("restores the nearest timeline anchor for each workspace", async () => {
    const workspaces: WorkspaceAdapterState["workspaces"] = [
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
    ]
    const stateFor = (
      workspaceId: string,
      sequences: readonly number[],
    ): WorkspaceAdapterState => ({
      workspaces,
      activeWorkspaceId: workspaceId,
      draft: {
        text: "",
        effort: "fast",
        revision: 0,
        contextSnapshots: [],
      },
      timeline: sequences.map((sequence) => ({
        id: `event-${workspaceId}-${String(sequence)}`,
        sequence,
        producer: "code" as const,
        kind: "history" as const,
        domainKind: `code.fixture.${String(sequence)}`,
        occurredAt: "2026-07-18T00:00:00.000Z",
        status: "completed",
      })),
      history: { mode: "ready", errorCode: null, backupName: null },
    })
    const selectWorkspace = vi.fn((workspaceId: string) =>
      Promise.resolve(
        workspaceId === "workspace-a"
          ? stateFor(workspaceId, [1, 2, 3, 4])
          : stateFor(workspaceId, [10, 11]),
      ),
    )
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(stateFor("workspace-a", [1, 2, 3, 4])),
      selectWorkspace,
    }
    const offsetTop = vi
      .spyOn(HTMLElement.prototype, "offsetTop", "get")
      .mockImplementation(function (this: HTMLElement) {
        return Number(this.dataset.eventSequence ?? 0) * 200
      })

    try {
      const { container } = renderWorkspace(adapter)
      expect(await screen.findByText("code.fixture.4")).toBeVisible()
      const viewport = container.querySelector<HTMLElement>(
        '.chat-pane [data-slot="scroll-area-viewport"]',
      )
      expect(viewport).not.toBeNull()
      Object.defineProperties(viewport as HTMLElement, {
        clientHeight: { configurable: true, value: 400 },
        scrollHeight: { configurable: true, value: 1200 },
        scrollTop: { configurable: true, value: 450, writable: true },
      })
      fireEvent.scroll(viewport as HTMLElement)
      const navigation = screen.getByRole("navigation", { name: "Workspaces" })

      fireEvent.click(
        within(navigation).getByRole("button", {
          name: /main, fixture, Backlog/u,
        }),
      )
      expect(await screen.findByText("code.fixture.11")).toBeVisible()
      fireEvent.click(
        within(navigation).getByRole("button", {
          name: /main, fixture, In Progress/u,
        }),
      )
      expect(await screen.findByText("code.fixture.4")).toBeVisible()
      const restoredViewport = container.querySelector<HTMLElement>(
        '.chat-pane [data-slot="scroll-area-viewport"]',
      )
      expect(restoredViewport).not.toBeNull()
      expect(restoredViewport).toHaveAttribute(
        "data-scroll-restoration",
        "anchor",
      )
      await waitFor(() =>
        expect((restoredViewport as HTMLElement).scrollTop).toBe(450),
      )
    } finally {
      offsetTop.mockRestore()
    }
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
      getTurnContextSnapshot: () =>
        Promise.resolve({
          schemaVersion: 1,
          workspaceId: "workspace-native",
          projectVersion: 1,
          projectHash: "a".repeat(64),
          characterVersion: 1,
          characterHash: "b".repeat(64),
          snapshotHash: "c".repeat(64),
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
        }),
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
            ? "file:///\u0055sers/private/project/assets/pasted.png"
            : "",
      },
    })
    await waitFor(() =>
      expect(registerAttachmentPaths).toHaveBeenCalledWith(
        "workspace-native",
        "paste",
        ["/\u0055sers/private/project/assets/pasted.png"],
        ["attachment-picker"],
      ),
    )
    expect(
      await screen.findByRole("button", {
        name: "Remove attachment: pasted.png",
      }),
    ).toBeVisible()
    expect(screen.queryByText(/\u0055sers\/private/u)).not.toBeInTheDocument()

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

  it("delegates terminal cancellation atomically without exposing project actions", async () => {
    const timestamp = "2026-07-18T01:00:00.000Z"
    const activeState: WorkspaceAdapterState = {
      ...nativeWorkspaceState(),
      workspaces: [
        {
          ...nativeWorkspaceState().workspaces[0]!,
          updatedAt: timestamp,
          health: "ready",
        },
      ],
    }
    const canceledState: WorkspaceAdapterState = {
      ...activeState,
      workspaces: activeState.workspaces.map((workspace) => ({
        ...workspace,
        lifecycle: "canceled" as const,
        updatedAt: "2026-07-18T01:00:01.000Z",
      })),
    }
    const codex = richCodexState()
    const stopTurn = vi.fn().mockResolvedValue(undefined)
    const cancelWorkspace = vi.fn().mockResolvedValue(canceledState)
    const unregisterWorkspace = vi.fn().mockResolvedValue(canceledState)
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(activeState),
      codexSnapshot: () => codex,
      subscribeCodex(listener) {
        listener(codex)
        return () => undefined
      },
      stopTurn,
      cancelWorkspace,
      unregisterProject: unregisterWorkspace,
    }
    const user = userEvent.setup()
    const { container } = renderWorkspace(adapter)

    const actions = await waitFor(() => {
      const value = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Workspace actions"]',
      )
      expect(value).not.toBeNull()
      return value as HTMLButtonElement
    })
    await user.click(actions)
    const actionMenu = await waitFor(() => {
      const value = document.querySelector<HTMLElement>(
        "[data-workspace-action-menu]",
      )
      expect(value).not.toBeNull()
      return value as HTMLElement
    })
    expect(
      within(actionMenu).queryByRole("button", { name: /Unregister project/u }),
    ).not.toBeInTheDocument()
    await user.click(
      within(actionMenu).getByRole("button", { name: /Cancel workspace/u }),
    )
    const dialog = await waitFor(() => {
      const title = Array.from(document.querySelectorAll("h2")).find(
        (heading) => heading.textContent === "Cancel this workspace?",
      )
      const value = title?.closest<HTMLElement>('[role="dialog"]') ?? null
      expect(value).not.toBeNull()
      return value as HTMLElement
    })
    expect(within(dialog).getByText("Cancel this workspace?")).toBeVisible()
    await user.click(
      within(dialog).getByRole("button", { name: "Stop and cancel" }),
    )

    await waitFor(() => expect(cancelWorkspace).toHaveBeenCalledOnce())
    expect(stopTurn).not.toHaveBeenCalled()
    expect(cancelWorkspace).toHaveBeenCalledWith(
      "workspace-native",
      timestamp,
      1,
    )
    expect(unregisterWorkspace).not.toHaveBeenCalled()
  })

  it("focuses the safe cancel action, handles Escape, and restores the opener", async () => {
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(nativeWorkspaceState()),
      cancelWorkspace: vi.fn(),
    }
    const user = userEvent.setup()
    renderWorkspace(adapter)
    const opener = await screen.findByRole("button", {
      name: "Workspace actions",
    })

    await user.click(opener)
    await user.click(screen.getByRole("button", { name: /Cancel workspace/u }))
    const dialog = screen.getByRole("dialog", {
      name: "Cancel this workspace?",
    })
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Go back" }),
      ).toHaveFocus(),
    )
    expect(
      within(dialog).getByRole("button", { name: "Dismiss" }),
    ).toBeVisible()

    fireEvent.keyDown(dialog, { code: "Escape", key: "Escape" })
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it("localizes the destructive dialog close control in Japanese", async () => {
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(nativeWorkspaceState()),
      cancelWorkspace: vi.fn(),
    }
    const user = userEvent.setup()
    const { container } = render(
      <App
        localeStore={japaneseLocaleStore}
        transport={new DemoTransport()}
        workspaceAdapter={adapter}
      />,
    )

    const actions = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="ワークスペース操作"]',
      )
      expect(button).not.toBeNull()
      return button as HTMLButtonElement
    })
    await user.click(actions)
    const actionMenu = await waitFor(() => {
      const value = document.querySelector<HTMLElement>(
        "[data-workspace-action-menu]",
      )
      expect(value).not.toBeNull()
      return value as HTMLElement
    })
    await user.click(
      within(actionMenu).getByRole("button", {
        name: /ワークスペースを中止/u,
      }),
    )
    const dialog = await waitFor(() => {
      const value = document.querySelector<HTMLElement>(
        '[role="dialog"][aria-labelledby]',
      )
      expect(value).not.toBeNull()
      return value as HTMLElement
    })
    expect(within(dialog).getByRole("button", { name: "閉じる" })).toBeVisible()
  })

  it("shows repository health and repairs it from the state-aware action menu", async () => {
    const unhealthyState: WorkspaceAdapterState = {
      ...nativeWorkspaceState(),
      workspaces: [
        {
          ...nativeWorkspaceState().workspaces[0]!,
          updatedAt: "2026-07-18T01:00:00.000Z",
          health: "missing",
        },
      ],
    }
    const repairWorkspace = vi.fn().mockResolvedValue({
      ...unhealthyState,
      workspaces: unhealthyState.workspaces.map((workspace) => ({
        ...workspace,
        health: "ready" as const,
      })),
    })
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(unhealthyState),
      repairWorkspace,
    }
    const user = userEvent.setup()
    renderWorkspace(adapter)

    expect((await screen.findAllByText("Repository missing")).length).toBe(2)
    await user.click(screen.getByRole("button", { name: "Workspace actions" }))
    await user.click(
      screen.getByRole("button", { name: /Reselect repository/u }),
    )

    await waitFor(() =>
      expect(repairWorkspace).toHaveBeenCalledWith("workspace-native"),
    )
    expect(screen.queryByText("Repository missing")).not.toBeInTheDocument()
  })

  it("labels stale HEAD recovery as an explicit read-only recheck", async () => {
    const staleState: WorkspaceAdapterState = {
      ...nativeWorkspaceState(),
      workspaces: [
        {
          ...nativeWorkspaceState().workspaces[0]!,
          health: "stale_branch",
        },
      ],
    }
    const recheckWorkspace = vi.fn().mockResolvedValue({
      ...staleState,
      workspaces: staleState.workspaces.map((workspace) => ({
        ...workspace,
        health: "ready" as const,
      })),
    })
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(staleState),
      recheckWorkspace,
    }
    const user = userEvent.setup()
    renderWorkspace(adapter)

    expect(
      (await screen.findAllByText("Branch changed outside the app")).length,
    ).toBe(2)
    await user.click(screen.getByRole("button", { name: "Workspace actions" }))
    await user.click(
      screen.getByRole("button", { name: /^Recheck repository/u }),
    )

    await waitFor(() =>
      expect(recheckWorkspace).toHaveBeenCalledWith("workspace-native", true),
    )
    expect(
      screen.queryByText("Branch changed outside the app"),
    ).not.toBeInTheDocument()
  })

  it("unregisters project metadata from app settings after confirmation", async () => {
    const selected = {
      ...nativeWorkspaceState().workspaces[0]!,
      projectId: "project-native",
      updatedAt: "2026-07-18T01:00:00.000Z",
      health: "ready" as const,
    }
    const fallback = {
      id: "workspace-fallback",
      projectId: "project-fallback",
      repository: "fallback-repository",
      name: "preserved-workspace",
      branch: "main",
      lifecycle: "backlog" as const,
      updatedAt: "2026-07-18T01:00:00.000Z",
      health: "ready" as const,
    }
    const state: WorkspaceAdapterState = {
      ...nativeWorkspaceState(),
      projects: [
        {
          id: "project-native",
          name: "native-repository",
          health: "ready",
          workspaceCount: 1,
          updatedAt: "2026-07-18T01:00:00.000Z",
        },
        {
          id: "project-fallback",
          name: "fallback-repository",
          health: "ready",
          workspaceCount: 1,
          updatedAt: "2026-07-18T01:00:00.000Z",
        },
      ],
      workspaces: [selected, fallback],
    }
    const afterUnregister: WorkspaceAdapterState = {
      ...state,
      projects:
        state.projects?.filter((project) => project.id !== "project-native") ??
        [],
      workspaces: [fallback],
      activeWorkspaceId: fallback.id,
      draft: { ...state.draft!, revision: 0 },
    }
    const unregisterWorkspace = vi.fn().mockResolvedValue(afterUnregister)
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(state),
      unregisterProject: unregisterWorkspace,
    }
    const user = userEvent.setup()
    renderWorkspace(adapter)

    await user.click(await waitFor(appSettingsButton))
    await user.click(screen.getByRole("button", { name: "Projects" }))
    await user.click(screen.getAllByRole("button", { name: "Unregister" })[0]!)
    expect(screen.getByText("Unregister this project?")).toBeVisible()
    expect(unregisterWorkspace).not.toHaveBeenCalled()
    const dialog = screen
      .getByText("Unregister this project?")
      .closest('[role="dialog"]')
    expect(dialog).not.toBeNull()
    await waitFor(() =>
      expect(
        within(dialog as HTMLElement).getByRole("button", {
          name: "Keep project",
        }),
      ).toHaveFocus(),
    )
    await user.click(
      within(dialog as HTMLElement).getByRole("button", {
        name: "Unregister project",
      }),
    )

    await waitFor(() =>
      expect(unregisterWorkspace).toHaveBeenCalledWith("project-native"),
    )
    const appSettings = document.querySelector<HTMLElement>(
      '[data-settings-scope="app"]',
    )
    expect(appSettings).not.toBeNull()
    expect(
      await within(appSettings as HTMLElement).findByText(
        "fallback-repository",
      ),
    ).toBeVisible()
    await user.click(
      within(appSettings as HTMLElement).getByRole("button", {
        name: "Back to workspace",
      }),
    )
    expect(await screen.findByText("preserved-workspace")).toBeVisible()
    expect(screen.queryByText("restored-workspace")).not.toBeInTheDocument()
  })

  it("holds an active workspace selection and Go back preserves draft and narration", async () => {
    const target = {
      id: "workspace-target",
      repository: "native-repository",
      name: "target-workspace",
      branch: "feature/target",
      lifecycle: "backlog" as const,
    }
    const state: WorkspaceAdapterState = {
      ...nativeWorkspaceState(),
      workspaces: [...nativeWorkspaceState().workspaces, target],
      draft: {
        ...nativeWorkspaceState().draft!,
        text: "Keep this exact draft.",
      },
    }
    const codex = richCodexState()
    const stopAndSwitchWorkspace = vi.fn()
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(state),
      codexSnapshot: () => codex,
      subscribeCodex(listener) {
        listener(codex)
        return () => undefined
      },
      stopAndSwitchWorkspace,
    }
    const narrationGateway = new DemoNarrationGateway()
    const narrationController = new NarrationController(narrationGateway)
    const dismissPresentation = vi.spyOn(
      narrationController,
      "dismissPresentation",
    )
    const cancelSpeech = vi.spyOn(narrationGateway, "cancel")
    const user = userEvent.setup()
    const { container } = render(
      <App
        localeStore={englishLocaleStore}
        narrationController={narrationController}
        narrationGateway={narrationGateway}
        transport={new DemoTransport()}
        workspaceAdapter={adapter}
      />,
    )

    const current = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label^="main, native-repository,"]',
      )
      expect(button).not.toBeNull()
      return button as HTMLButtonElement
    })
    const targetRow = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="feature/target, native-repository,"]',
    )
    expect(targetRow).not.toBeNull()
    const composer = screen.getByPlaceholderText(
      "Ask Codex to plan, build, explain, or fix anything…",
    )
    await waitFor(() =>
      expect(narrationController.getSnapshot().scope).toMatchObject({
        workspaceId: "workspace-native",
        generation: 1,
      }),
    )
    dismissPresentation.mockClear()
    cancelSpeech.mockClear()
    expect(composer).toHaveValue("Keep this exact draft.")
    await user.click(targetRow as HTMLButtonElement)

    const dialog = screen.getByRole("dialog", {
      name: "Stop and switch workspaces?",
    })
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Go back" }),
      ).toHaveFocus(),
    )
    expect(within(dialog).getByText("Current workspace")).toBeVisible()
    expect(
      within(dialog).getByText("native-repository/restored-workspace"),
    ).toBeVisible()
    expect(within(dialog).getByText("Switch to")).toBeVisible()
    expect(
      within(dialog).getByText("native-repository/target-workspace"),
    ).toBeVisible()
    expect(current).toHaveAttribute("aria-current", "page")
    expect(targetRow).not.toHaveAttribute("aria-current")

    await user.click(within(dialog).getByRole("button", { name: "Go back" }))
    expect(
      screen.queryByRole("dialog", { name: "Stop and switch workspaces?" }),
    ).not.toBeInTheDocument()
    expect(current).toHaveAttribute("aria-current", "page")
    expect(composer).toHaveValue("Keep this exact draft.")
    expect(stopAndSwitchWorkspace).not.toHaveBeenCalled()
    expect(dismissPresentation).not.toHaveBeenCalled()
    expect(cancelSpeech).not.toHaveBeenCalled()
  })

  it("closes an active workspace selection with Escape and restores its row", async () => {
    const target = {
      id: "workspace-target",
      repository: "native-repository",
      name: "target-workspace",
      branch: "feature/target",
      lifecycle: "backlog" as const,
    }
    const state: WorkspaceAdapterState = {
      ...nativeWorkspaceState(),
      workspaces: [...nativeWorkspaceState().workspaces, target],
    }
    const codex = richCodexState()
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(state),
      codexSnapshot: () => codex,
      subscribeCodex(listener) {
        listener(codex)
        return () => undefined
      },
      stopAndSwitchWorkspace: vi.fn(),
    }
    const user = userEvent.setup()
    const { container } = renderWorkspace(adapter)
    const targetRow = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label^="feature/target, native-repository,"]',
      )
      expect(button).not.toBeNull()
      return button as HTMLButtonElement
    })
    await user.click(targetRow)
    const escapeDialog = screen.getByRole("dialog", {
      name: "Stop and switch workspaces?",
    })
    fireEvent.keyDown(escapeDialog, { code: "Escape", key: "Escape" })
    await waitFor(() => expect(escapeDialog).not.toBeInTheDocument())
    await waitFor(() => expect(targetRow).toHaveFocus())
  })

  it("keeps the old workspace selected until Stop and switch finishes", async () => {
    const target = {
      id: "workspace-target",
      repository: "native-repository",
      name: "target-workspace",
      branch: "feature/target",
      lifecycle: "backlog" as const,
    }
    const state: WorkspaceAdapterState = {
      ...nativeWorkspaceState(),
      workspaces: [...nativeWorkspaceState().workspaces, target],
    }
    const targetState: WorkspaceAdapterState = {
      ...state,
      activeWorkspaceId: target.id,
      draft: {
        text: "",
        effort: "fast",
        revision: 0,
        contextSnapshots: [],
      },
    }
    const codex = richCodexState()
    const transition = deferred<WorkspaceAdapterState>()
    const stopAndSwitchWorkspace = vi.fn(() => transition.promise)
    const adapter: WorkspaceViewAdapter = {
      hydrationMode: "native",
      loadState: () => Promise.resolve(state),
      codexSnapshot: () => codex,
      subscribeCodex(listener) {
        listener(codex)
        return () => undefined
      },
      stopAndSwitchWorkspace,
    }
    const user = userEvent.setup()
    const { container } = renderWorkspace(adapter)

    const current = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label^="main, native-repository,"]',
      )
      expect(button).not.toBeNull()
      return button as HTMLButtonElement
    })
    const targetRow = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="feature/target, native-repository,"]',
    )
    expect(targetRow).not.toBeNull()
    await user.click(targetRow as HTMLButtonElement)
    const dialog = screen
      .getByText("Stop and switch workspaces?")
      .closest('[role="dialog"]')
    expect(dialog).not.toBeNull()
    const switchAction = within(dialog as HTMLElement)
      .getByText("Stop and switch")
      .closest("button")
    expect(switchAction).not.toBeNull()
    await user.click(switchAction as HTMLButtonElement)

    expect(stopAndSwitchWorkspace).toHaveBeenCalledWith({
      fromWorkspaceId: "workspace-native",
      toWorkspaceId: "workspace-target",
      expectedGeneration: 1,
    })
    expect(current).toHaveAttribute("aria-current", "page")
    expect(targetRow).not.toHaveAttribute("aria-current")
    const status = (dialog as HTMLElement).querySelector('[role="status"]')
    expect(status).not.toBeNull()
    expect(status).toHaveTextContent("Stopping and switching…")
    const pendingAction = within(dialog as HTMLElement).getByRole("button", {
      name: "Stopping and switching…",
    })
    expect(pendingAction).toBeDisabled()
    const goBack = within(dialog as HTMLElement)
      .getByText("Go back")
      .closest("button")
    expect(goBack).toBeDisabled()

    await act(async () => {
      transition.resolve(targetState)
      await transition.promise
    })
    await waitFor(() =>
      expect(targetRow).toHaveAttribute("aria-current", "page"),
    )
    expect(current).not.toHaveAttribute("aria-current")
    expect(
      screen.queryByRole("dialog", { name: "Stop and switch workspaces?" }),
    ).not.toBeInTheDocument()
  })
})
