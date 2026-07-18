import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { DemoGitReviewTransport } from "@/features/git-review/demo-transport"
import { EvidenceView } from "@/features/git-review/EvidenceView"

function renderEvidence(locale: "ja" | "en" = "en") {
  const onBackToChat = vi.fn()
  render(
    <EvidenceView
      locale={locale}
      onBackToChat={onBackToChat}
      transport={new DemoGitReviewTransport(0)}
      workspaceId="workspace-demo"
    />,
  )
  return { onBackToChat }
}

describe("EvidenceView", () => {
  it("shows the selected review pack and all four independent safety gates", async () => {
    renderEvidence()

    expect(
      await screen.findByRole("heading", {
        name: "Connect automatic Git checkpoints to a reviewable evidence workflow.",
      }),
    ).toBeVisible()
    for (const gate of ["Scope", "Ownership", "Verification", "Risk"]) {
      expect(screen.getAllByText(gate).length).toBeGreaterThan(0)
    }
    expect(screen.getAllByText("Pass")).toHaveLength(4)
    expect(
      screen.queryByRole("button", { name: /^commit$/i }),
    ).not.toBeInTheDocument()
  })

  it("loads only the selected file diff and compares stored checkpoints", async () => {
    const user = userEvent.setup()
    renderEvidence()
    await screen.findByRole("tab", { name: "Files" })

    await user.click(screen.getByRole("tab", { name: "Files" }))
    await user.click(
      screen.getByRole("button", {
        name: /src\/features\/git-review\/store\.ts/,
      }),
    )
    expect(await screen.findByText(/export class GitReviewStore/)).toBeVisible()

    await user.click(screen.getByRole("tab", { name: "Compare" }))
    await user.click(screen.getByRole("button", { name: "Compare" }))
    expect(
      await screen.findByText(
        "Added TypeScript contract and browser interaction verification.",
      ),
    ).toBeVisible()
  })

  it("requires preview and explicit confirmation before a revert", async () => {
    const user = userEvent.setup()
    renderEvidence()
    await screen.findByRole("tab", { name: "Restore" })

    await user.click(screen.getByRole("tab", { name: "Restore" }))
    await user.click(screen.getByRole("button", { name: "Preview revert" }))
    expect(
      await screen.findByRole("dialog", { name: "Confirm Git operation" }),
    ).toBeVisible()
    expect(
      screen.getByText(
        "This creates a new revert commit. It does not delete the selected checkpoint.",
      ),
    ).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Confirm Git operation" }),
      ).not.toBeInTheDocument(),
    )

    await user.click(screen.getByRole("button", { name: "Preview revert" }))
    await user.click(
      await screen.findByRole("button", { name: "Create revert commit" }),
    )
    expect(await screen.findByText("Git operation completed")).toBeVisible()
    expect(screen.getByText("A new revert commit was created.")).toBeVisible()
  })

  it("renders the Japanese product copy without translating evidence", async () => {
    renderEvidence("ja")

    expect(await screen.findByText("安全ゲート")).toBeVisible()
    expect(screen.getByRole("tab", { name: "失敗した試行" })).toBeVisible()
    expect(
      screen.getAllByText(
        "Connect automatic Git checkpoints to a reviewable evidence workflow.",
      ).length,
    ).toBeGreaterThan(0)
  })
})
