import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  I18nProvider,
  type LocalePreferenceStore,
} from "@/features/localization"
import { CommitNarrationCaption } from "@/features/narration/components/CommitNarrationCaption"
import type { CommitNarrationPresentationSnapshot } from "@/features/narration/controller"

const jaStore: LocalePreferenceStore = {
  persistence: "session-only",
  read: () => "ja",
  write: () => true,
}

function installAnimationFrames() {
  let nextId = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextId
    callbacks.set(id, callback)
    return id
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    callbacks.delete(id)
  })
  return {
    flush() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const callback of pending) callback(performance.now())
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

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
  onVisible = vi.fn(),
) {
  render(
    <I18nProvider store={jaStore}>
      <CommitNarrationCaption
        onCancel={onCancel}
        onVisible={onVisible}
        presentation={value}
      />
    </I18nProvider>,
  )
  return { onCancel, onVisible }
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
    const { onCancel } = renderCaption(presentation())

    await user.click(screen.getByRole("button", { name: "説明を閉じる" }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it("acknowledges each exact sequence only after a visible paint boundary", () => {
    const frames = installAnimationFrames()
    const onVisible = vi.fn()
    renderCaption(presentation(), vi.fn(), onVisible)
    const caption = screen.getByRole("region", { name: "コミットの説明" })
    Object.defineProperty(caption, "getClientRects", {
      configurable: true,
      value: () => ({ length: 1 }),
    })

    act(() => frames.flush())
    expect(onVisible).not.toHaveBeenCalled()
    act(() => frames.flush())

    expect(onVisible).toHaveBeenNthCalledWith(1, {
      key: presentation().key,
      presentationGeneration: 3,
      sequence: 0,
    })
    expect(onVisible).toHaveBeenNthCalledWith(2, {
      key: presentation().key,
      presentationGeneration: 3,
      sequence: 1,
    })
  })

  it("does not acknowledge a hidden caption", () => {
    const frames = installAnimationFrames()
    const onVisible = vi.fn()
    renderCaption(presentation(), vi.fn(), onVisible)

    act(() => frames.flush())
    act(() => frames.flush())

    expect(onVisible).not.toHaveBeenCalled()
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
