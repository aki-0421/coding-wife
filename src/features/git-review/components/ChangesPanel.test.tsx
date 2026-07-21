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
          content: "",
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
      expect(screen.getByText(copy.chooseFile).closest(".w-full")).toHaveClass(
        "min-w-0",
      )
      idle.unmount()

      const error = renderPanel(locale, "error", null)
      expect(screen.getByText(copy.diffError).closest(".w-full")).toHaveClass(
        "min-w-0",
      )
      error.unmount()

      renderPanel(locale, "ready", "text")
      expect(screen.getByText(copy.diffEmpty).closest(".w-full")).toHaveClass(
        "min-w-0",
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
    expect(stateContainer).toHaveClass("w-full", "min-w-0")
    expect(message).toHaveClass(
      "w-full",
      "min-w-0",
      "whitespace-normal",
      "break-words",
    )
  })
})
