import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import {
  I18nProvider,
  type LocalePreferenceStore,
} from "@/features/localization"
import { CommitNarrationCaption } from "@/features/narration/components/CommitNarrationCaption"
import type { CommitNarrationPresentationSnapshot } from "@/features/narration/controller"

const jaStore: LocalePreferenceStore = {
  read: () => "ja",
  write: () => true,
}

function presentation(
  overrides: Partial<CommitNarrationPresentationSnapshot> = {},
): CommitNarrationPresentationSnapshot {
  return {
    key: {
      workspaceId: "workspace-1",
      workspaceGeneration: 2,
      commitSha: "a".repeat(40),
      requestId: "support-1",
      locale: "ja",
    },
    trigger: "auto_verified_commit",
    presentationGeneration: 3,
    status: "streaming",
    chunks: ["変更の要約です。", "検証結果はすべて成功しました。"],
    lastSequence: 1,
    speechStatus: "playing",
    errorCode: null,
    ...overrides,
  }
}

function renderCaption(
  value: CommitNarrationPresentationSnapshot,
  onCancel = vi.fn(),
) {
  render(
    <I18nProvider store={jaStore}>
      <CommitNarrationCaption onCancel={onCancel} presentation={value} />
    </I18nProvider>,
  )
  return onCancel
}

describe("CommitNarrationCaption", () => {
  it("renders every accepted chunk in a polite visible log", () => {
    renderCaption(presentation())

    const log = screen.getByRole("log", { name: "コミットの説明" })
    expect(log).toHaveAttribute("aria-live", "polite")
    expect(within(log).getAllByRole("listitem")).toHaveLength(2)
    expect(within(log).getByText("変更の要約です。")).toBeVisible()
    expect(
      within(log).getByText("検証結果はすべて成功しました。"),
    ).toBeVisible()
    expect(screen.getByText("読み上げ中")).toBeVisible()
    expect(screen.getByText("aaaaaaaa")).toBeVisible()
  })

  it("offers an explicit caption-and-speech cancel action", async () => {
    const user = userEvent.setup()
    const onCancel = renderCaption(presentation())

    await user.click(screen.getByRole("button", { name: "説明を閉じる" }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it("keeps accepted captions visible when presentation becomes unavailable", () => {
    renderCaption(
      presentation({
        status: "unavailable",
        speechStatus: "unavailable",
        errorCode: "NARRATION-PRESENTATION-SEQUENCE",
      }),
    )

    expect(screen.getByText("変更の要約です。")).toBeVisible()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "NARRATION-PRESENTATION-SEQUENCE",
    )
    expect(
      screen.queryByRole("button", { name: "説明を閉じる" }),
    ).not.toBeInTheDocument()
  })

  it("announces preparation without inventing caption text", () => {
    renderCaption(
      presentation({
        status: "preparing",
        chunks: [],
        lastSequence: null,
        speechStatus: "off",
      }),
    )

    expect(screen.getByRole("status")).toHaveTextContent("説明を準備しています")
    expect(screen.queryByRole("log")).not.toBeInTheDocument()
  })
})
