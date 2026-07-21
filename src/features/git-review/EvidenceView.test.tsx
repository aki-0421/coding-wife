import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { DemoGitReviewTransport } from "@/features/git-review/demo-transport"
import { EvidenceView } from "@/features/git-review/EvidenceView"
import type { GitReviewTransport } from "@/features/git-review/transport"
import type {
  CommitExplanationCancelRequestedV1,
  CommitExplanationController,
  CommitExplanationControllerStateV1,
  CommitExplanationDispatchV1,
  CommitExplanationPresentationRequestedV1,
  GitReviewCommand,
  GitReviewRequestMap,
  GitReviewResponseMap,
  ListCommitEvidenceRequest,
  ReadCommitDiffRequest,
} from "@/lib/contracts/git-review"

const currentCommitEvidenceId = `commit-${"a".repeat(40)}`

class RecordingTransport implements GitReviewTransport {
  readonly kind = "demo"
  readonly calls: Array<{ command: GitReviewCommand; request: unknown }> = []

  constructor(readonly delegate = new DemoGitReviewTransport(0)) {}

  request<K extends GitReviewCommand>(
    command: K,
    request: GitReviewRequestMap[K],
  ): Promise<GitReviewResponseMap[K]> {
    this.calls.push({ command, request })
    return this.delegate.request(command, request)
  }
}

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
    readonly characterVisible?: boolean
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
      {...(options.characterVisible === undefined
        ? {}
        : { characterVisible: options.characterVisible })}
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
  it("shows only GitHub-style commit identity and change summary", async () => {
    const { container } = renderEvidence({ characterVisible: true })

    expect(
      await screen.findByRole("heading", {
        name: "feat(git): add read-only commit evidence",
      }),
    ).toBeVisible()
    expect(
      screen.getByRole("main", { name: "Commit changes" }),
    ).toHaveAttribute("data-evidence-character", "true")
    expect(container.querySelector("[data-git-review-header]")).not.toBeNull()
    expect(screen.getByText("Coding Wife")).toBeVisible()
    expect(screen.getByText("3 files changed")).toBeVisible()
    expect(screen.getByText("+630")).toBeVisible()
    expect(screen.getByText("−753")).toBeVisible()
    expect(screen.getByText("aaaaaaa")).toBeVisible()

    for (const hiddenText of [
      "Read only",
      "Fresh",
      "Main Codex",
      "Persisted",
      "Scope",
      "Ownership",
      "Verification",
      "Risk",
      "coding-wife@example.invalid",
      "work-unit-read-only-git",
      "event-terminal-read-only-git",
      "observation-before-read-only-git",
      "Overview",
      "Evidence",
    ]) {
      expect(screen.queryByText(hiddenText)).not.toBeInTheDocument()
    }
    expect(screen.queryByText("a".repeat(40))).not.toBeInTheDocument()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("automatically loads only the first file and renders numbered unified rows", async () => {
    const transport = new RecordingTransport()
    const { container } = renderEvidence({ transport })

    await waitFor(() =>
      expect(
        container.querySelectorAll("[data-git-diff-line]").length,
      ).toBeGreaterThan(0),
    )
    const diffCalls = transport.calls.filter(
      (call) => call.command === "read_commit_diff_file",
    )
    expect(diffCalls).toHaveLength(1)
    expect(diffCalls[0]?.request).toMatchObject({
      fileEvidenceId: "file-store",
    })

    const hunk = container.querySelector('[data-diff-kind="hunk"]')
    const deletion = container.querySelector('[data-diff-kind="deletion"]')
    const additions = container.querySelectorAll('[data-diff-kind="addition"]')
    const context = container.querySelector('[data-diff-kind="context"]')
    expect(
      screen.getByRole("option", {
        name: "src/features/git-review/store.ts 286 additions, 451 deletions",
      }),
    ).toBeVisible()
    expect(hunk).toHaveAttribute("data-old-line", "")
    expect(deletion).toHaveAttribute("data-old-line", "21")
    expect(deletion).toHaveAttribute("data-new-line", "")
    expect(deletion).toHaveClass("bg-destructive/10")
    expect(deletion).toHaveTextContent("Deleted line, old line 21:")
    expect(additions[0]).toHaveAttribute("data-new-line", "21")
    expect(additions[1]).toHaveAttribute("data-new-line", "22")
    expect(additions[0]).toHaveClass("bg-success/10")
    expect(additions[0]).toHaveTextContent("Added line, new line 21:")
    expect(context).toHaveTextContent("Context line, old line 22, new line 23:")
    expect(
      container.querySelector("[data-git-file-header] .sr-only"),
    ).toHaveTextContent("286 additions, 451 deletions")
    expect(container.querySelector("[data-git-diff-scroll]")).not.toBeNull()
  })

  it("localizes accessible file stats and diff line positions", async () => {
    const { container } = renderEvidence({ locale: "ja" })

    expect(
      await screen.findByRole("option", {
        name: "src/features/git-review/store.ts 追加286行、削除451行",
      }),
    ).toBeVisible()
    await waitFor(() =>
      expect(
        container.querySelector('[data-diff-kind="deletion"]'),
      ).toHaveTextContent("削除された行、変更前21行目:"),
    )
    expect(
      container.querySelector('[data-diff-kind="addition"]'),
    ).toHaveTextContent("追加された行、変更後21行目:")
    expect(
      container.querySelector('[data-diff-kind="context"]'),
    ).toHaveTextContent("前後の行、変更前22行目、変更後23行目:")
  })

  it("filters files locally and supports keyboard file navigation", async () => {
    const user = userEvent.setup()
    const transport = new RecordingTransport()
    renderEvidence({ transport })
    await screen.findByText(/async activate/)

    const filter = screen.getByRole("searchbox", {
      name: "Filter changed files",
    })
    await user.type(filter, "EvidenceView")
    expect(
      screen.getByRole("option", {
        name: /^src\/features\/git-review\/EvidenceView\.tsx /,
      }),
    ).toBeVisible()
    expect(
      screen.queryByRole("option", {
        name: /^src\/features\/git-review\/store\.ts /,
      }),
    ).not.toBeInTheDocument()

    await user.clear(filter)
    const first = screen.getByRole("option", {
      name: /^src\/features\/git-review\/store\.ts /,
    })
    first.focus()
    await user.keyboard("{ArrowDown}")
    const second = screen.getByRole("option", {
      name: /^src\/features\/git-review\/EvidenceView\.tsx /,
    })
    await waitFor(() => expect(second).toHaveAttribute("aria-selected", "true"))
    await waitFor(() =>
      expect(
        transport.calls.filter(
          (call) => call.command === "read_commit_diff_file",
        ),
      ).toHaveLength(2),
    )
  })

  it("shows binary state and file navigation without property badges", async () => {
    const user = userEvent.setup()
    renderEvidence()

    await user.click(
      await screen.findByRole("option", {
        name: /^docs\/thinking\/demo\.png /,
      }),
    )
    expect(
      await screen.findByText("Binary file — preview unavailable."),
    ).toBeVisible()
    expect(screen.queryByText("BIN")).not.toBeInTheDocument()
    expect(screen.queryByText("Modified")).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Previous changed file" }),
    ).toBeEnabled()
    expect(
      screen.getByRole("button", { name: "Next changed file" }),
    ).toBeDisabled()
  })

  it.each([
    ["oversize", "Diff is too large to display safely."],
    ["invalid_utf8", "Text preview is unavailable for this encoding."],
  ] as const)(
    "shows the typed %s state without raw details",
    async (state, text) => {
      const user = userEvent.setup()
      const delegate = new DemoGitReviewTransport(0)
      const transport: GitReviewTransport = {
        kind: "demo",
        async request<K extends GitReviewCommand>(
          command: K,
          request: GitReviewRequestMap[K],
        ): Promise<GitReviewResponseMap[K]> {
          const response = await delegate.request(command, request)
          if (command !== "read_commit_diff_file") return response
          const input = request as ReadCommitDiffRequest
          if (input.fileEvidenceId !== "file-demo-image") return response
          return {
            ...(response as GitReviewResponseMap["read_commit_diff_file"]),
            state,
            content: "",
          } as GitReviewResponseMap[K]
        },
      }
      renderEvidence({ transport })

      await user.click(
        await screen.findByRole("option", {
          name: /^docs\/thinking\/demo\.png /,
        }),
      )
      expect(await screen.findByText(text)).toBeVisible()
      expect(screen.queryByText(/824,018 bytes/)).not.toBeInTheDocument()
    },
  )

  it("shows a safe file error while keeping the remaining file list", async () => {
    const user = userEvent.setup()
    const delegate = new DemoGitReviewTransport(0)
    const transport: GitReviewTransport = {
      kind: "demo",
      request<K extends GitReviewCommand>(
        command: K,
        request: GitReviewRequestMap[K],
      ): Promise<GitReviewResponseMap[K]> {
        if (
          command === "read_commit_diff_file" &&
          (request as ReadCommitDiffRequest).fileEvidenceId ===
            "file-demo-image"
        ) {
          return Promise.reject(new Error("PRIVATE_NATIVE_DETAIL"))
        }
        return delegate.request(command, request)
      },
    }
    renderEvidence({ transport })

    await user.click(
      await screen.findByRole("option", {
        name: /^docs\/thinking\/demo\.png /,
      }),
    )
    expect(
      await screen.findByText("This file diff could not be loaded."),
    ).toBeVisible()
    expect(screen.queryByText("PRIVATE_NATIVE_DETAIL")).not.toBeInTheDocument()
    expect(screen.getAllByRole("option")).toHaveLength(3)
  })

  it("exposes desktop and compact path navigation, collapse, and copy semantics", async () => {
    const user = userEvent.setup()
    const { container } = renderEvidence()
    await screen.findByText(/async activate/)

    expect(
      container.querySelector('[data-git-path-navigation="desktop"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-git-path-navigation="compact"]'),
    ).not.toBeNull()
    expect(container.querySelector("[data-git-file-section]")).not.toBeNull()
    expect(container.querySelector("[data-git-file-header]")).not.toBeNull()

    const copySha = screen.getByRole("button", { name: "Copy commit SHA" })
    const copyPath = screen.getByRole("button", { name: "Copy file path" })
    expect(copySha).toHaveClass("opacity-0")
    expect(copyPath).toHaveClass("opacity-0")

    const collapse = screen.getByRole("button", { name: "Collapse file diff" })
    expect(collapse).toHaveAttribute("aria-expanded", "true")
    await user.click(collapse)
    expect(
      screen.getByRole("button", { name: "Expand file diff" }),
    ).toHaveAttribute("aria-expanded", "false")
    expect(container.querySelector("[data-git-diff-scroll]")).toBeNull()
  })

  it("opens the compact commit drawer and restores focus after Escape", async () => {
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
    const current = within(drawer).getByRole("option", {
      name: /feat\(git\): add read-only commit evidence/,
    })
    expect(current).toHaveTextContent("aaaaaaa")
    expect(current).toHaveTextContent("Coding Wife")
    expect(current).not.toHaveTextContent("work-unit-read-only-git")
    expect(current).not.toHaveTextContent("Verification")

    await user.keyboard("{Escape}")
    expect(
      screen.queryByRole("region", { name: "Open commit list" }),
    ).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it("keeps pagination in the commit drawer", async () => {
    const user = userEvent.setup()
    const delegate = new DemoGitReviewTransport(0)
    const transport: GitReviewTransport = {
      kind: "demo",
      async request<K extends GitReviewCommand>(
        command: K,
        request: GitReviewRequestMap[K],
      ): Promise<GitReviewResponseMap[K]> {
        if (command === "list_commit_evidence") {
          const input = request as ListCommitEvidenceRequest
          if (input.cursor === null) {
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
      await screen.findByRole("button", { name: "Open commit list" }),
    )
    await user.click(
      screen.getByRole("button", { name: "Load earlier commits" }),
    )
    expect(
      await screen.findByRole("option", {
        name: /feat\(git\): add read-only commit evidence/,
      }),
    ).toBeVisible()
  })

  it("routes explanation lifecycle through the single action position", async () => {
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

    expect(
      await screen.findByRole("button", { name: "Explain changes" }),
    ).toBeVisible()
    expect(screen.queryByText("Generating explanation")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Explain changes" }))
    await waitFor(() => expect(explanation.request).toHaveBeenCalledOnce())
    expect(explanation.request.mock.calls[0]?.[0]?.request.trigger).toBe(
      "user_request",
    )

    await user.click(
      await screen.findByRole("button", { name: "Cancel explanation" }),
    )
    await waitFor(() => expect(explanation.cancel).toHaveBeenCalledOnce())
    expect(screen.queryByText("CODEX-SUPPORT-CANCELED")).not.toBeInTheDocument()
  })

  it("shows a presentation failure only after explicit action and rejects stale state", async () => {
    const user = userEvent.setup()
    const generated = createExplanationController(
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
    const view = renderEvidence({ explanationController: generated.controller })

    expect(
      await screen.findByRole("button", { name: "Show explanation" }),
    ).toBeVisible()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Show explanation" }))
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Explanation is unavailable",
    )
    view.unmount()

    const stale = createExplanationController({
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
    renderEvidence({ explanationController: stale.controller })
    expect(
      await screen.findByRole("button", { name: "Explain changes" }),
    ).toBeVisible()
    expect(
      screen.queryByRole("button", { name: "Show explanation" }),
    ).not.toBeInTheDocument()
  })

  it("does not call the native transport while the force-mounted tab is hidden", async () => {
    const transport = new RecordingTransport()
    const view = renderEvidence({ active: false, transport })
    await Promise.resolve()
    expect(transport.calls).toHaveLength(0)

    view.rerender(
      <EvidenceView
        active
        locale="en"
        onBackToChat={vi.fn()}
        transport={transport}
        workspaceId="workspace-demo"
      />,
    )
    await waitFor(() => expect(transport.calls.length).toBeGreaterThan(0))
  })

  it("uses Japanese controls without translating commit content", async () => {
    renderEvidence({ locale: "ja" })

    expect(
      await screen.findByRole("heading", {
        name: "feat(git): add read-only commit evidence",
      }),
    ).toBeVisible()
    expect(screen.getByRole("main", { name: "コミットの変更" })).toBeVisible()
    expect(
      screen.getByRole("searchbox", { name: "変更ファイルを絞り込む" }),
    ).toBeVisible()
    expect(
      screen.getByRole("button", { name: "コミット SHA をコピー" }),
    ).toHaveClass("opacity-0")
    expect(
      screen.getByRole("button", { name: "ファイルパスをコピー" }),
    ).toHaveClass("opacity-0")
    expect(screen.queryByText("保存済み")).not.toBeInTheDocument()
    expect(screen.queryByText("観測されたゲート")).not.toBeInTheDocument()
  })
})
