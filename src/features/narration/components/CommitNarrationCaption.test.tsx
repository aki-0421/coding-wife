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

const originalElementFromPoint = Object.getOwnPropertyDescriptor(
  document,
  "elementFromPoint",
)

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

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalElementFromPoint === undefined) {
    Reflect.deleteProperty(document, "elementFromPoint")
  } else {
    Object.defineProperty(
      document,
      "elementFromPoint",
      originalElementFromPoint,
    )
  }
})

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
  onDismiss = vi.fn(),
  onVisible = vi.fn(),
) {
  render(
    <I18nProvider store={jaStore}>
      <CommitNarrationCaption
        onDismiss={onDismiss}
        onVisible={onVisible}
        presentation={value}
      />
    </I18nProvider>,
  )
  return { onDismiss, onVisible }
}

function mockCaptionLayout(
  caption: HTMLElement,
  bounds: Partial<DOMRect> = {},
): void {
  const rect = {
    x: 100,
    y: 100,
    top: 100,
    right: 700,
    bottom: 300,
    left: 100,
    width: 600,
    height: 200,
    toJSON: () => ({}),
    ...bounds,
  } satisfies DOMRect
  Object.defineProperties(caption, {
    getBoundingClientRect: {
      configurable: true,
      value: () => rect,
    },
    getClientRects: {
      configurable: true,
      value: () => ({ length: 1 }),
    },
  })
}

function containsPoint(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

function mockSequenceLayout(
  options: {
    readonly clipped?: readonly number[]
    readonly hidden?: readonly number[]
    readonly mostlyObstructed?: readonly number[]
    readonly obstructed?: readonly number[]
  } = {},
) {
  const caption = screen.getByRole("region", { name: "コミットの説明" })
  const log = screen.getByRole("log", { name: "コミットの説明" })
  const viewport = log.closest('[data-slot="scroll-area-viewport"]')
  if (!(viewport instanceof HTMLElement)) {
    throw new Error("scroll viewport is missing")
  }
  const items = within(log).getAllByRole("listitem")
  mockCaptionLayout(caption, {
    y: 50,
    top: 50,
    right: 700,
    bottom: 250,
    height: 200,
  })
  mockCaptionLayout(viewport, {
    y: 160,
    top: 160,
    right: 680,
    bottom: 235,
    left: 120,
    width: 560,
    height: 75,
  })
  const itemRects = items.map((item, sequence) => {
    const top = sequence === 0 ? 170 : 205
    const bottom = options.clipped?.includes(sequence) ? 245 : top + 20
    const rect = {
      x: 130,
      y: top,
      top,
      right: 650,
      bottom,
      left: 130,
      width: 520,
      height: bottom - top,
      toJSON: () => ({}),
    } satisfies DOMRect
    mockCaptionLayout(item, rect)
    if (options.hidden?.includes(sequence)) {
      Object.defineProperty(item, "getClientRects", {
        configurable: true,
        value: () => ({ length: 0 }),
      })
    }
    return rect
  })
  const obstruction = document.createElement("div")
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: (x: number, y: number) => {
      const sequence = itemRects.findIndex((rect) => containsPoint(rect, x, y))
      if (sequence >= 0) {
        if (options.mostlyObstructed?.includes(sequence)) {
          const rect = itemRects[sequence]
          if (rect === undefined) return obstruction
          const centerX = rect.left + rect.width / 2
          const centerY = rect.top + rect.height / 2
          return Math.abs(x - centerX) <= 5 && Math.abs(y - centerY) <= 5
            ? items[sequence]
            : obstruction
        }
        return options.obstructed?.includes(sequence)
          ? obstruction
          : items[sequence]
      }
      return containsPoint(caption.getBoundingClientRect(), x, y)
        ? caption
        : null
    },
  })
  return {
    items,
    viewport,
    reveal(sequence: number) {
      const previous = itemRects[sequence]
      const item = items[sequence]
      if (previous === undefined || item === undefined) return
      const next = {
        ...previous,
        bottom: previous.top + 20,
        height: 20,
      } satisfies DOMRect
      itemRects[sequence] = next
      mockCaptionLayout(item, next)
    },
  }
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

  it("offers an explicit caption-and-speech dismiss action", async () => {
    const user = userEvent.setup()
    const { onDismiss } = renderCaption(presentation())

    await user.click(screen.getByRole("button", { name: "説明を閉じる" }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it("acknowledges each exact sequence only after a visible paint boundary", () => {
    const frames = installAnimationFrames()
    const onVisible = vi.fn()
    renderCaption(presentation(), vi.fn(), onVisible)
    mockSequenceLayout()

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

  it("does not acknowledge a hidden sequence inside a visible caption", () => {
    const frames = installAnimationFrames()
    const onVisible = vi.fn()
    renderCaption(presentation(), vi.fn(), onVisible)
    mockSequenceLayout({ hidden: [1] })

    act(() => frames.flush())
    act(() => frames.flush())

    expect(onVisible).toHaveBeenCalledOnce()
    expect(onVisible).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 0 }),
    )
  })

  it("does not acknowledge a sequence partially clipped by the inner viewport", () => {
    const frames = installAnimationFrames()
    const onVisible = vi.fn()
    renderCaption(presentation(), vi.fn(), onVisible)
    mockSequenceLayout({ clipped: [1] })

    act(() => frames.flush())
    act(() => frames.flush())

    expect(onVisible).toHaveBeenCalledOnce()
    expect(onVisible).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 0 }),
    )
  })

  it("acknowledges a clipped sequence only after it scrolls fully into view", () => {
    const frames = installAnimationFrames()
    const onVisible = vi.fn()
    renderCaption(presentation(), vi.fn(), onVisible)
    const layout = mockSequenceLayout({ clipped: [1] })

    act(() => frames.flush())
    act(() => frames.flush())
    expect(onVisible).toHaveBeenCalledOnce()

    layout.reveal(1)
    act(() => {
      layout.viewport.dispatchEvent(new Event("scroll"))
    })
    act(() => frames.flush())
    act(() => frames.flush())

    expect(onVisible).toHaveBeenCalledTimes(2)
    expect(onVisible).toHaveBeenLastCalledWith(
      expect.objectContaining({ sequence: 1 }),
    )
  })

  it("does not acknowledge a sequence behind another hit target", () => {
    const frames = installAnimationFrames()
    const onVisible = vi.fn()
    renderCaption(presentation(), vi.fn(), onVisible)
    mockSequenceLayout({ obstructed: [1] })

    act(() => frames.flush())
    act(() => frames.flush())

    expect(onVisible).toHaveBeenCalledOnce()
    expect(onVisible).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 0 }),
    )
  })

  it("does not acknowledge a mostly covered sequence whose center remains exposed", () => {
    const frames = installAnimationFrames()
    const onVisible = vi.fn()
    renderCaption(presentation(), vi.fn(), onVisible)
    mockSequenceLayout({ mostlyObstructed: [1] })

    act(() => frames.flush())
    act(() => frames.flush())

    expect(onVisible).toHaveBeenCalledOnce()
    expect(onVisible).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 0 }),
    )
  })

  it("does not acknowledge a hidden caption", () => {
    const frames = installAnimationFrames()
    const onVisible = vi.fn()
    renderCaption(presentation(), vi.fn(), onVisible)

    act(() => frames.flush())
    act(() => frames.flush())

    expect(onVisible).not.toHaveBeenCalled()
  })

  it("does not acknowledge a caption clipped outside the active viewport", () => {
    const frames = installAnimationFrames()
    const onVisible = vi.fn()
    renderCaption(presentation(), vi.fn(), onVisible)
    const caption = screen.getByRole("region", { name: "コミットの説明" })
    mockCaptionLayout(caption, {
      y: -240,
      top: -240,
      right: 700,
      bottom: -40,
    })

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
