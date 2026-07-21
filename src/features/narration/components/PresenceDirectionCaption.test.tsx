import { act, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PresenceDirectionCaption } from "@/features/narration/components/PresenceDirectionCaption"
import type { PresenceDirectionPresentationSnapshot } from "@/features/narration/controller"

const originalElementFromPoint = Object.getOwnPropertyDescriptor(
  document,
  "elementFromPoint",
)

function presentation(): PresenceDirectionPresentationSnapshot {
  return {
    requestId: "presence-1",
    workspaceId: "workspace-1",
    workspaceGeneration: 2,
    sourceEventId: "event-1",
    trigger: "decision_wait",
    locale: "ja",
    utterance: "確認が必要なところで待っています。",
    cue: "asking",
    priority: "high",
    occurredAt: "2026-07-21T10:00:00.000Z",
    presentationGeneration: 4,
    speechStatus: "queued",
    errorCode: null,
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

function mockVisibleLayout(element: HTMLElement): void {
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

describe("PresenceDirectionCaption", () => {
  it("renders one polite visible sentence without alert semantics", () => {
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
    expect(caption).toHaveClass("whitespace-nowrap")
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
})
