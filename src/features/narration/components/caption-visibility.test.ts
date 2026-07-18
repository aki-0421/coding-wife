import { afterEach, describe, expect, it, vi } from "vitest"

import { isCaptionTargetFullyVisible } from "@/features/narration/components/caption-visibility"

const originalElementFromPoint = Object.getOwnPropertyDescriptor(
  document,
  "elementFromPoint",
)

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  }
}

function mockLayout(element: HTMLElement, bounds: DOMRect): void {
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
}

function mockFrontHit(resolve: (x: number, y: number) => Element | null): void {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: resolve,
  })
}

function mockTextRects(rects: readonly DOMRect[]): void {
  vi.spyOn(document, "createRange").mockImplementation(
    () =>
      ({
        getClientRects: () => rects,
        selectNodeContents: () => undefined,
      }) as unknown as Range,
  )
}

function connectedTarget(bounds = rect(100, 100, 200, 80)): HTMLElement {
  const target = document.createElement("p")
  target.textContent = "Visible narration text"
  document.body.append(target)
  mockLayout(target, bounds)
  return target
}

afterEach(() => {
  document.body.replaceChildren()
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

describe("isCaptionTargetFullyVisible", () => {
  it("rejects a 200x80 text target whose center is exposed but 95% is occluded", () => {
    const target = connectedTarget()
    const overlay = document.createElement("div")
    document.body.append(overlay)
    mockFrontHit((x) => (x >= 195 && x <= 205 ? target : overlay))

    expect(isCaptionTargetFullyVisible(target)).toBe(false)
  })

  it("rejects partial window clipping before any front-hit admission", () => {
    const target = connectedTarget(rect(-1, 100, 200, 80))
    mockFrontHit(() => target)

    expect(isCaptionTargetFullyVisible(target)).toBe(false)
  })

  it("rejects a target clipped by its nearest scroll viewport", () => {
    const viewport = document.createElement("div")
    viewport.dataset.slot = "scroll-area-viewport"
    document.body.append(viewport)
    mockLayout(viewport, rect(100, 100, 220, 120))
    const target = document.createElement("p")
    target.textContent = "Clipped narration text"
    viewport.append(target)
    mockLayout(target, rect(120, 160, 180, 80))
    mockFrontHit(() => target)

    expect(isCaptionTargetFullyVisible(target)).toBe(false)
  })

  it("accepts a pointer-events transparent overlay when hit testing reaches the text", () => {
    const target = connectedTarget()
    const overlay = document.createElement("div")
    overlay.style.pointerEvents = "none"
    document.body.append(overlay)
    mockFrontHit(() => target)

    expect(isCaptionTargetFullyVisible(target)).toBe(true)
  })

  it("checks representative points on every rendered text line", () => {
    const target = connectedTarget()
    const overlay = document.createElement("div")
    document.body.append(overlay)
    mockTextRects([rect(110, 110, 180, 20), rect(110, 145, 180, 20)])
    mockFrontHit((x, y) =>
      y < 145 || (x >= 195 && x <= 205) ? target : overlay,
    )

    expect(isCaptionTargetFullyVisible(target)).toBe(false)
  })

  it("accepts fully frontmost multi-line text", () => {
    const target = connectedTarget()
    mockTextRects([rect(110, 110, 180, 20), rect(110, 145, 180, 20)])
    mockFrontHit(() => target)

    expect(isCaptionTargetFullyVisible(target)).toBe(true)
  })
})
