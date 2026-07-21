import { act, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PresenceDirectionCaption } from "@/features/narration/components/PresenceDirectionCaption"
import type { PresenceDirectionPresentationSnapshot } from "@/features/narration/controller"

const originalElementFromPoint = Object.getOwnPropertyDescriptor(
  document,
  "elementFromPoint",
)

function presentation(
  overrides: Partial<PresenceDirectionPresentationSnapshot> = {},
): PresenceDirectionPresentationSnapshot {
  return {
    requestId: "presence-1",
    workspaceId: "workspace-1",
    workspaceGeneration: 2,
    sourceEventId: "event-1",
    decisionId: "pending-1",
    trigger: "decision_wait",
    locale: "ja",
    utterance: "確認が必要なところで待っています。",
    cue: "asking",
    priority: "high",
    occurredAt: "2026-07-21T10:00:00.000Z",
    presentationGeneration: 4,
    speechStatus: "queued",
    errorCode: null,
    ...overrides,
  }
}

function installAnimationFrames() {
  let nextId = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextId
    callbacks.set(id, callback)
    return id
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id))
  return {
    flush() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const callback of pending) callback(performance.now())
    },
  }
}

function mockVisibleLayout(
  element: HTMLElement,
  options: {
    readonly bounds?: Partial<DOMRect>
    readonly textRects?: readonly DOMRect[]
  } = {},
): void {
  const bounds = {
    x: 100,
    y: 100,
    top: 100,
    right: 500,
    bottom: 130,
    left: 100,
    width: 400,
    height: 30,
    toJSON: () => ({}),
    ...options.bounds,
  } satisfies DOMRect
  Object.defineProperties(element, {
    getBoundingClientRect: {
      configurable: true,
      value: () => bounds,
    },
    getClientRects: {
      configurable: true,
      value: () => ({ 0: bounds, length: 1 }),
    },
  })
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => element,
  })
  if (options.textRects !== undefined) {
    vi.spyOn(document, "createRange").mockImplementation(
      () =>
        ({
          getClientRects: () => options.textRects,
          selectNodeContents: () => undefined,
        }) as unknown as Range,
    )
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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

describe("PresenceDirectionCaption", () => {
  it("renders one polite wrapping sentence without alert semantics", () => {
    render(
      <PresenceDirectionCaption
        onVisible={vi.fn()}
        presentation={presentation()}
      />,
    )

    const caption = screen.getByRole("status")
    expect(caption).toHaveTextContent("確認が必要なところで待っています。")
    expect(caption).toHaveAttribute("aria-live", "polite")
    expect(caption).toHaveAttribute("aria-atomic", "true")
    expect(caption).toHaveClass(
      "whitespace-normal",
      "break-words",
      "[overflow-wrap:anywhere]",
    )
    expect(caption).not.toHaveClass("whitespace-nowrap")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("acknowledges only after a fully visible paint boundary", () => {
    const frames = installAnimationFrames()
    const onVisible = vi.fn()
    render(
      <PresenceDirectionCaption
        onVisible={onVisible}
        presentation={presentation()}
      />,
    )
    mockVisibleLayout(screen.getByRole("status"))

    act(() => frames.flush())
    expect(onVisible).not.toHaveBeenCalled()
    act(() => frames.flush())

    expect(onVisible).toHaveBeenCalledOnce()
    expect(onVisible).toHaveBeenCalledWith({
      requestId: "presence-1",
      presentationGeneration: 4,
    })
  })

  it("keeps a 160-scalar caption fully visible in a narrow pane at 200% zoom", () => {
    const frames = installAnimationFrames()
    const onVisible = vi.fn()
    const utterance = "W".repeat(160)
    vi.stubGlobal("devicePixelRatio", 2)
    render(
      <PresenceDirectionCaption
        onVisible={onVisible}
        presentation={presentation({ utterance })}
      />,
    )
    const caption = screen.getByRole("status")
    const textRects = Array.from({ length: 10 }, (_, index) => ({
      x: 104,
      y: 104 + index * 18,
      top: 104 + index * 18,
      right: 296,
      bottom: 120 + index * 18,
      left: 104,
      width: 192,
      height: 16,
      toJSON: () => ({}),
    })) satisfies DOMRect[]
    mockVisibleLayout(caption, {
      bounds: {
        right: 300,
        bottom: 286,
        width: 200,
        height: 186,
      },
      textRects,
    })

    expect(caption).toHaveTextContent(utterance)
    expect(caption).toHaveClass("max-w-[min(65ch,100%)]")
    act(() => frames.flush())
    act(() => frames.flush())

    expect(onVisible).toHaveBeenCalledOnce()
  })
})
