import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { DemoGitReviewTransport } from "@/features/git-review/demo-transport"
import { EvidenceView } from "@/features/git-review/EvidenceView"
import type { GitReviewTransport } from "@/features/git-review/transport"
import type {
  CommitExplanationController,
  CommitExplanationControllerStateV1,
  CommitExplanationDispatchV1,
  CommitExplanationCancelRequestedV1,
  CommitExplanationPresentationRequestedV1,
  GitReviewCommand,
  GitReviewRequestMap,
  GitReviewResponseMap,
  ListCommitEvidenceRequest,
} from "@/lib/contracts/git-review"

const currentCommitEvidenceId = `commit-${"a".repeat(40)}`

function createExplanationController(
  initialState: CommitExplanationControllerStateV1 | null = null,
  presentOperation: () => Promise<void> = () => Promise.resolve(),
) {
  let state = initialState
  const listeners = new Set<() => void>()
  const request = vi.fn<(dispatch: CommitExplanationDispatchV1) => void>()
  const cancel = vi.fn<(event: CommitExplanationCancelRequestedV1) => void>()
  const present =
    vi.fn<(event: CommitExplanationPresentationRequestedV1) => void>()
  const emit = () => listeners.forEach((listener) => listener())
  const controller: CommitExplanationController = {
    request(dispatch) {
      request(dispatch)
      state = {
        schemaVersion: 1,
        workspaceId: dispatch.request.workspaceId,
        workspaceGeneration: dispatch.request.workspaceGeneration,
        commitEvidenceId: dispatch.request.commitEvidenceId,
        requestId: dispatch.request.requestId,
        locale: dispatch.request.locale,
        selectionVersion: dispatch.request.selectionVersion,
        status: "queued",
        trigger: dispatch.request.trigger,
        retryable: false,
        presentationAvailable: false,
        errorCode: null,
        updatedAt: dispatch.request.requestedAt,
      }
      emit()
      return Promise.resolve()
    },
    cancel(event) {
      cancel(event)
      if (state !== null) {
        state = {
          ...state,
          status: "canceled",
          retryable: true,
          presentationAvailable: false,
          errorCode: "CODEX-SUPPORT-CANCELED",
          updatedAt: event.requestedAt,
        }
        emit()
      }
      return Promise.resolve()
    },
    present(event) {
      present(event)
      return presentOperation()
    },
    getState(workspaceId, workspaceGeneration, commitEvidenceId) {
      return state?.workspaceId === workspaceId &&
        state.workspaceGeneration === workspaceGeneration &&
        state.commitEvidenceId === commitEvidenceId
        ? state
        : null
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return { cancel, controller, present, request }
}

function renderEvidence(
  options: {
    readonly active?: boolean
    readonly companionVisible?: boolean
    readonly locale?: "ja" | "en"
    readonly transport?: GitReviewTransport
    readonly explanationController?: CommitExplanationController
    readonly onExplanationPresentationTrigger?: (
      trigger: HTMLButtonElement,
    ) => void
  } = {},
) {
  const onBackToChat = vi.fn()
  const view = render(
    <EvidenceView
      active={options.active ?? true}
      commitExplanationController={options.explanationController}
      locale={options.locale ?? "en"}
      onBackToChat={onBackToChat}
      {...(options.companionVisible === undefined
        ? {}
        : { companionVisible: options.companionVisible })}
      {...(options.onExplanationPresentationTrigger === undefined
        ? {}
        : {
            onExplanationPresentationTrigger:
              options.onExplanationPresentationTrigger,
          })}
      transport={options.transport ?? new DemoGitReviewTransport(0)}
      workspaceId="workspace-demo"
    />,
  )
  return { ...view, onBackToChat }
}

describe("EvidenceView", () => {
  it("uses the commit drawer when the companion shares the workspace body", async () => {
    renderEvidence({ companionVisible: true })

    expect(
      await screen.findByRole("heading", {
        name: "feat(git): add read-only commit evidence",
      }),
    ).toBeVisible()
    expect(
      screen.getByRole("main", { name: "Commit evidence" }),
    ).toHaveAttribute("data-evidence-companion", "true")
    expect(
      screen.getByRole("button", { name: "Open commit list" }),
    ).toBeVisible()
  })

  it("shows read-only commit identity and all four observed gates", async () => {
    const user = userEvent.setup()
    renderEvidence()

    expect(
      await screen.findByRole("heading", {
        name: "feat(git): add read-only commit evidence",
      }),
    ).toBeVisible()
    expect(screen.getByText("Read only")).toBeVisible()
    await user.click(screen.getByRole("tab", { name: "Evidence" }))
    for (const gate of ["Scope", "Ownership", "Verification", "Risk"]) {
      expect(screen.getAllByText(gate).length).toBeGreaterThan(0)
    }
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("loads only the explicitly selected file diff", async () => {
    const user = userEvent.setup()
    renderEvidence()
    await screen.findByRole("tab", { name: "Changes" })

    expect(screen.queryByText(/async activate/)).not.toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: "Changes" }))
    await user.click(
      screen.getByRole("button", {
        name: /src\/features\/git-review\/store\.ts/,
      }),
    )
    expect(await screen.findByText(/async activate/)).toBeVisible()
  })

  it("offers earlier commits when a filtered page is empty but pageable", async () => {
    const user = userEvent.setup()
    const delegate = new DemoGitReviewTransport(0)
    const transport: GitReviewTransport = {
      kind: "demo",
      async request<K extends GitReviewCommand>(
        command: K,
        request: GitReviewRequestMap[K],
      ): Promise<GitReviewResponseMap[K]> {
        if (command === "list_commit_evidence") {
          const listRequest = request as ListCommitEvidenceRequest
          if (listRequest.cursor === null) {
            return {
              schemaVersion: 1,
              items: [],
              nextCursor: "offset-50",
            } as unknown as GitReviewResponseMap[K]
          }
        }
        return delegate.request(command, request)
      },
    }
    renderEvidence({ transport })

    await user.click(
      await screen.findByRole("button", { name: "Load earlier commits" }),
    )
    expect(
      await screen.findByRole("option", {
        name: /feat\(git\): add read-only commit evidence/,
      }),
    ).toBeVisible()
  })

  it("exposes the compact commit drawer and restores focus after Escape", async () => {
    const user = userEvent.setup()
    renderEvidence()
    await screen.findByRole("heading", {
      name: "feat(git): add read-only commit evidence",
    })
    const trigger = screen.getByRole("button", { name: "Open commit list" })

    trigger.focus()
    await user.click(trigger)
    const drawer = screen.getByRole("region", { name: "Open commit list" })
    const close = within(drawer).getByRole("button", { name: "Close" })
    await waitFor(() => expect(close).toHaveFocus())
    expect(trigger).toHaveAttribute("aria-controls", "commit-list-drawer")
    expect(trigger).toHaveAttribute("aria-expanded", "true")

    await user.keyboard("{Escape}")
    expect(
      screen.queryByRole("region", { name: "Open commit list" }),
    ).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(trigger).toHaveAttribute("aria-expanded", "false")
  })

  it("routes a not-generated explanation through app-owned user_request", async () => {
    const user = userEvent.setup()
    const explanation = createExplanationController()
    const onExplanationPresentationTrigger = vi.fn()
    renderEvidence({
      explanationController: explanation.controller,
      onExplanationPresentationTrigger,
    })
    await screen.findByRole("heading", {
      name: "feat(git): add read-only commit evidence",
    })

    expect(explanation.request).not.toHaveBeenCalled()
    const initialTrigger = screen.getByRole("button", {
      name: "Explain this commit",
    })
    initialTrigger.focus()
    await user.keyboard("{Enter}")
    await waitFor(() => expect(explanation.request).toHaveBeenCalledOnce())
    expect(onExplanationPresentationTrigger).toHaveBeenCalledWith(
      initialTrigger,
    )
    expect(explanation.request.mock.calls[0]?.[0]?.request.trigger).toBe(
      "user_request",
    )
    const serialized = JSON.stringify(
      explanation.request.mock.calls[0]?.[0]?.evidence,
    )
    expect(serialized).not.toContain("relativePath")
    expect(serialized).not.toContain('"content"')

    await user.click(
      screen.getByRole("option", {
        name: /chore: update local project metadata/,
      }),
    )
    expect(explanation.cancel).not.toHaveBeenCalled()
  })

  it("joins automatic running state from one explicit action and cancels only from its action", async () => {
    const user = userEvent.setup()
    const explanation = createExplanationController({
      schemaVersion: 1,
      workspaceId: "workspace-demo",
      workspaceGeneration: 1,
      commitEvidenceId: currentCommitEvidenceId,
      requestId: "auto-request-one",
      locale: "en",
      selectionVersion: 1,
      status: "running",
      trigger: "auto_verified_commit",
      retryable: false,
      presentationAvailable: false,
      errorCode: null,
      updatedAt: "2026-07-18T09:00:00.000Z",
    })
    renderEvidence({ explanationController: explanation.controller })

    expect(await screen.findByText("Generating explanation")).toBeVisible()
    expect(explanation.request).not.toHaveBeenCalled()
    await user.click(
      screen.getByRole("button", { name: "Explain this commit" }),
    )
    await waitFor(() => expect(explanation.request).toHaveBeenCalledOnce())
    expect(explanation.request.mock.calls[0]?.[0]?.request.trigger).toBe(
      "user_request",
    )
    const explicitRequestId =
      explanation.request.mock.calls[0]?.[0]?.request.requestId
    await user.click(screen.getByRole("button", { name: "Cancel explanation" }))
    await waitFor(() => expect(explanation.cancel).toHaveBeenCalledOnce())
    expect(explanation.cancel.mock.calls[0]?.[0]).toMatchObject({
      requestId: explicitRequestId,
      reason: "user",
    })
  })

  it.each([
    ["queued", false, "Explanation queued"],
    ["running", false, "Generating explanation"],
    ["generated", true, "Explanation ready"],
  ] as const)(
    "keeps automatic %s state visible without creating a live region",
    async (status, presentationAvailable, statusText) => {
      const explanation = createExplanationController({
        schemaVersion: 1,
        workspaceId: "workspace-demo",
        workspaceGeneration: 1,
        commitEvidenceId: currentCommitEvidenceId,
        requestId: `auto-${status}`,
        locale: "en",
        selectionVersion: 1,
        status,
        trigger: "auto_verified_commit",
        retryable: false,
        presentationAvailable,
        errorCode: null,
        updatedAt: "2026-07-18T09:00:00.000Z",
      })
      const { container } = renderEvidence({
        explanationController: explanation.controller,
      })

      expect(await screen.findByText(statusText)).toBeVisible()
      expect(screen.queryAllByRole("status")).toHaveLength(0)
      expect(container.querySelectorAll("[aria-live]")).toHaveLength(0)
    },
  )

  it("creates a live terminal fallback only after an explicit presentation fails", async () => {
    const user = userEvent.setup()
    const explanation = createExplanationController(
      {
        schemaVersion: 1,
        workspaceId: "workspace-demo",
        workspaceGeneration: 1,
        commitEvidenceId: currentCommitEvidenceId,
        requestId: "generated-request-one",
        locale: "en",
        selectionVersion: 1,
        status: "generated",
        trigger: "auto_verified_commit",
        retryable: false,
        presentationAvailable: true,
        errorCode: null,
        updatedAt: "2026-07-18T09:00:00.000Z",
      },
      () => Promise.reject(new Error("presentation unavailable")),
    )
    const { container } = renderEvidence({
      explanationController: explanation.controller,
    })

    await screen.findByText("Explanation ready")
    expect(screen.queryAllByRole("status")).toHaveLength(0)

    await user.click(screen.getByRole("button", { name: "Show explanation" }))

    const terminalFallback = await screen.findByRole("status")
    expect(terminalFallback).toHaveAttribute("aria-live", "polite")
    expect(terminalFallback).toHaveTextContent(
      "The app-owned isolated explainer is unavailable",
    )
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(1)
  })

  it("ignores explanation state from another locale or commit selection", async () => {
    const staleLocale = createExplanationController({
      schemaVersion: 1,
      workspaceId: "workspace-demo",
      workspaceGeneration: 1,
      commitEvidenceId: currentCommitEvidenceId,
      requestId: "stale-locale",
      locale: "ja",
      selectionVersion: 1,
      status: "generated",
      trigger: "auto_verified_commit",
      retryable: false,
      presentationAvailable: true,
      errorCode: null,
      updatedAt: "2026-07-18T09:00:00.000Z",
    })
    const localeView = renderEvidence({
      explanationController: staleLocale.controller,
      locale: "en",
    })
    expect(
      await screen.findByRole("button", { name: "Explain this commit" }),
    ).toBeVisible()
    expect(screen.queryByText("Explanation ready")).not.toBeInTheDocument()
    localeView.unmount()

    const staleSelection = createExplanationController({
      schemaVersion: 1,
      workspaceId: "workspace-demo",
      workspaceGeneration: 1,
      commitEvidenceId: currentCommitEvidenceId,
      requestId: "stale-selection",
      locale: "en",
      selectionVersion: 2,
      status: "generated",
      trigger: "auto_verified_commit",
      retryable: false,
      presentationAvailable: true,
      errorCode: null,
      updatedAt: "2026-07-18T09:00:00.000Z",
    })
    renderEvidence({ explanationController: staleSelection.controller })
    expect(
      await screen.findByRole("button", { name: "Explain this commit" }),
    ).toBeVisible()
    expect(screen.queryByText("Explanation ready")).not.toBeInTheDocument()
  })

  it("presents a generated explanation and retries a failed one", async () => {
    const user = userEvent.setup()
    const generated = createExplanationController({
      schemaVersion: 1,
      workspaceId: "workspace-demo",
      workspaceGeneration: 1,
      commitEvidenceId: currentCommitEvidenceId,
      requestId: "generated-request-one",
      locale: "en",
      selectionVersion: 1,
      status: "generated",
      trigger: "auto_verified_commit",
      retryable: false,
      presentationAvailable: true,
      errorCode: null,
      updatedAt: "2026-07-18T09:00:00.000Z",
    })
    const view = renderEvidence({ explanationController: generated.controller })
    await screen.findByText("Explanation ready")
    await user.click(screen.getByRole("button", { name: "Show explanation" }))
    await user.click(screen.getByRole("button", { name: "Read aloud again" }))
    expect(generated.present.mock.calls.map(([event]) => event.mode)).toEqual([
      "show",
      "replay_narration",
    ])

    const failed = createExplanationController({
      schemaVersion: 1,
      workspaceId: "workspace-demo",
      workspaceGeneration: 1,
      commitEvidenceId: currentCommitEvidenceId,
      requestId: "failed-request-one",
      locale: "en",
      selectionVersion: 1,
      status: "failed",
      trigger: "auto_verified_commit",
      retryable: true,
      presentationAvailable: false,
      errorCode: "SUPPORT_TIMEOUT",
      updatedAt: "2026-07-18T09:01:00.000Z",
    })
    const onRetryPresentationTrigger = vi.fn()
    view.rerender(
      <EvidenceView
        active
        commitExplanationController={failed.controller}
        locale="en"
        onBackToChat={vi.fn()}
        onExplanationPresentationTrigger={onRetryPresentationTrigger}
        transport={new DemoGitReviewTransport(0)}
        workspaceId="workspace-demo"
      />,
    )
    await screen.findByText("Explanation failed")
    const retryTrigger = screen.getByRole("button", {
      name: "Retry explanation",
    })
    await user.click(retryTrigger)
    await waitFor(() => expect(failed.request).toHaveBeenCalledOnce())
    expect(onRetryPresentationTrigger).toHaveBeenCalledWith(retryTrigger)
    expect(failed.request.mock.calls[0]?.[0]?.request.trigger).toBe(
      "user_retry",
    )
  })

  it("does not call the native transport while the force-mounted tab is hidden", async () => {
    const calls: GitReviewCommand[] = []
    const delegate = new DemoGitReviewTransport(0)
    const transport: GitReviewTransport = {
      kind: "demo",
      request<K extends GitReviewCommand>(
        command: K,
        request: GitReviewRequestMap[K],
      ): Promise<GitReviewResponseMap[K]> {
        calls.push(command)
        return delegate.request(command, request)
      },
    }
    const view = renderEvidence({ active: false, transport })
    await Promise.resolve()
    expect(calls).toHaveLength(0)

    view.rerender(
      <EvidenceView
        active
        locale="en"
        onBackToChat={vi.fn()}
        transport={transport}
        workspaceId="workspace-demo"
      />,
    )
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
  })

  it("uses Japanese controls without translating the commit message", async () => {
    const user = userEvent.setup()
    renderEvidence({ locale: "ja" })

    expect(
      await screen.findByRole("heading", {
        name: "feat(git): add read-only commit evidence",
      }),
    ).toBeVisible()
    expect(screen.getByText("読み取り専用")).toBeVisible()
    await user.click(screen.getByRole("tab", { name: "証拠" }))
    expect(screen.getByText("観測されたゲート")).toBeVisible()
  })
})
