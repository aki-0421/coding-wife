import { render, screen, waitFor } from "@testing-library/react"
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
} from "@/lib/contracts/git-review"

const currentCommitEvidenceId = `commit-${"a".repeat(40)}`

function createExplanationController(
  initialState: CommitExplanationControllerStateV1 | null = null,
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
          updatedAt: event.requestedAt,
        }
        emit()
      }
      return Promise.resolve()
    },
    present(event) {
      present(event)
      return Promise.resolve()
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
    readonly locale?: "ja" | "en"
    readonly transport?: GitReviewTransport
    readonly explanationController?: CommitExplanationController
  } = {},
) {
  const onBackToChat = vi.fn()
  const view = render(
    <EvidenceView
      active={options.active ?? true}
      commitExplanationController={options.explanationController}
      locale={options.locale ?? "en"}
      onBackToChat={onBackToChat}
      transport={options.transport ?? new DemoGitReviewTransport(0)}
      workspaceId="workspace-demo"
    />,
  )
  return { ...view, onBackToChat }
}

describe("EvidenceView", () => {
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

  it("routes a not-generated explanation through app-owned user_request", async () => {
    const user = userEvent.setup()
    const explanation = createExplanationController()
    renderEvidence({ explanationController: explanation.controller })
    await screen.findByRole("heading", {
      name: "feat(git): add read-only commit evidence",
    })

    expect(explanation.request).not.toHaveBeenCalled()
    await user.click(
      screen.getByRole("button", { name: "Explain this commit" }),
    )
    await waitFor(() => expect(explanation.request).toHaveBeenCalledOnce())
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

  it("shows automatic running state and cancels only from its action", async () => {
    const user = userEvent.setup()
    const explanation = createExplanationController({
      schemaVersion: 1,
      workspaceId: "workspace-demo",
      workspaceGeneration: 1,
      commitEvidenceId: currentCommitEvidenceId,
      requestId: "auto-request-one",
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
    await user.click(screen.getByRole("button", { name: "Cancel explanation" }))
    await waitFor(() => expect(explanation.cancel).toHaveBeenCalledOnce())
    expect(explanation.cancel.mock.calls[0]?.[0]).toMatchObject({
      requestId: "auto-request-one",
      reason: "user",
    })
  })

  it("presents a generated explanation and retries a failed one", async () => {
    const user = userEvent.setup()
    const generated = createExplanationController({
      schemaVersion: 1,
      workspaceId: "workspace-demo",
      workspaceGeneration: 1,
      commitEvidenceId: currentCommitEvidenceId,
      requestId: "generated-request-one",
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
      status: "failed",
      trigger: "auto_verified_commit",
      retryable: true,
      presentationAvailable: false,
      errorCode: "SUPPORT_TIMEOUT",
      updatedAt: "2026-07-18T09:01:00.000Z",
    })
    view.rerender(
      <EvidenceView
        active
        commitExplanationController={failed.controller}
        locale="en"
        onBackToChat={vi.fn()}
        transport={new DemoGitReviewTransport(0)}
        workspaceId="workspace-demo"
      />,
    )
    await screen.findByText("Explanation failed")
    await user.click(screen.getByRole("button", { name: "Retry explanation" }))
    await waitFor(() => expect(failed.request).toHaveBeenCalledOnce())
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
