import { render, screen } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import {
  ChangesPanel,
  type ChangesPanelProps,
} from "@/features/git-review/components/ChangesPanel"
import { gitReviewCopy } from "@/features/git-review/copy"
import {
  DemoGitReviewTransport,
  demoCurrentCommitEvidenceId,
} from "@/features/git-review/demo-transport"
import { maximumRenderedDiffLines } from "@/features/git-review/unified-diff"
import type {
  CommitDiffFile,
  CommitEvidenceDetail,
  DiffContentState,
} from "@/lib/contracts/git-review"

let detail: CommitEvidenceDetail

beforeAll(async () => {
  detail = await new DemoGitReviewTransport(0).request("read_commit_evidence", {
    schemaVersion: 1,
    workspaceId: "workspace-demo",
    workspaceGeneration: 1,
    commitEvidenceId: demoCurrentCommitEvidenceId,
  })
})

function renderPanel(
  locale: "en" | "ja",
  diffStatus: ChangesPanelProps["diffStatus"],
  state: DiffContentState | null,
  content = "",
) {
  const file = detail.files[0]
  if (file === undefined) throw new Error("Demo detail has no changed file")
  const diff: CommitDiffFile | null =
    state === null
      ? null
      : {
          schemaVersion: 1,
          commitEvidenceId: detail.commitEvidenceId,
          fileEvidenceId: file.fileEvidenceId,
          relativePath: file.relativePath,
          changeKind: file.changeKind,
          state,
          content,
          byteCount: 0,
          additions: 0,
          deletions: 0,
        }

  return render(
    <TooltipProvider>
      <div className="flex h-96 w-[520px]">
        <ChangesPanel
          copy={gitReviewCopy[locale]}
          detail={detail}
          diff={diff}
          diffStatus={diffStatus}
          onSelectFile={vi.fn()}
          selectedFileEvidenceId={file.fileEvidenceId}
        />
      </div>
    </TooltipProvider>,
  )
}

describe("ChangesPanel fallback widths", () => {
  it.each(["en", "ja"] as const)(
    "keeps %s idle, error, and empty text fallbacks at readable width",
    (locale) => {
      const copy = gitReviewCopy[locale]
      const idle = renderPanel(locale, "idle", null)
      const idleMessage = screen.getByText(copy.chooseFile)
      expect(idleMessage).toHaveClass("max-w-[28rem]")
      expect(idleMessage.parentElement).toHaveClass(
        "w-full",
        "min-w-0",
        "flex-1",
        "self-stretch",
      )
      idle.unmount()

      const error = renderPanel(locale, "error", null)
      const errorMessage = screen.getByText(copy.diffError)
      expect(errorMessage).toHaveClass("max-w-[28rem]")
      expect(errorMessage.parentElement).toHaveClass(
        "w-full",
        "min-w-0",
        "flex-1",
        "self-stretch",
      )
      error.unmount()

      const empty = renderPanel(locale, "ready", "text")
      const emptyMessage = screen.getByText(copy.diffEmpty)
      expect(emptyMessage).toHaveClass("max-w-[28rem]")
      expect(emptyMessage.parentElement).toHaveClass(
        "w-full",
        "min-w-0",
        "flex-1",
        "self-stretch",
      )
      empty.unmount()

      renderPanel(
        locale,
        "ready",
        "text",
        Array.from(
          { length: maximumRenderedDiffLines + 1 },
          () => " context",
        ).join("\n"),
      )
      const renderLimitMessage = screen.getByText(copy.diffRenderLimit)
      expect(renderLimitMessage).toHaveClass("max-w-[28rem]")
      expect(renderLimitMessage.parentElement).toHaveClass(
        "w-full",
        "min-w-0",
        "flex-1",
        "self-stretch",
      )
    },
  )

  it.each(["en", "ja"] as const)(
    "keeps %s loading fallback at full available width",
    (locale) => {
      renderPanel(locale, "loading", null)
      const loading = screen.getByText(gitReviewCopy[locale].diffLoading)
      expect(loading.closest('[aria-live="polite"]')).toHaveClass(
        "size-full",
        "min-w-0",
        "flex-1",
        "self-stretch",
      )
    },
  )

  it.each(
    (["en", "ja"] as const).flatMap((locale) =>
      (["binary", "oversize", "invalid_utf8"] as const).map((state) => ({
        locale,
        state,
      })),
    ),
  )("keeps $locale $state typed state readable", ({ locale, state }) => {
    renderPanel(locale, "ready", state)
    const message = screen.getByText(gitReviewCopy[locale].diffStates[state])
    const stateContainer = message.closest("[data-git-diff-state]")
    expect(stateContainer).toHaveAttribute("data-git-diff-state", state)
    expect(stateContainer).toHaveClass(
      "w-full",
      "min-w-0",
      "flex-1",
      "self-stretch",
    )
    expect(stateContainer?.parentElement).toHaveClass(
      "w-full",
      "min-w-0",
      "flex-1",
      "self-stretch",
    )
    expect(message.parentElement).toHaveClass("w-full", "max-w-[28rem]")
    expect(message.parentElement).not.toHaveClass("max-w-md")
    expect(message).toHaveClass(
      "w-full",
      "min-w-0",
      "whitespace-normal",
      "break-words",
    )
  })

  it("keeps text diffs in a full-width internal overflow surface", () => {
    const { container } = renderPanel(
      "en",
      "ready",
      "text",
      `@@ -1 +1 @@\n-old\n+${"x".repeat(300)}`,
    )

    expect(container.querySelector("[data-git-file-section]")).toHaveClass(
      "size-full",
      "min-w-0",
    )
    expect(container.querySelector(".git-changes-layout")).toHaveClass(
      "w-full",
      "min-w-0",
    )
    const scroll = container.querySelector("[data-git-diff-scroll]")
    expect(scroll).toHaveClass("size-full", "min-w-0", "flex-1", "self-stretch")
    expect(scroll?.parentElement).toHaveClass(
      "w-full",
      "min-w-0",
      "flex-1",
      "self-stretch",
    )
  })
})
