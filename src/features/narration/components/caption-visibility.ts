const scrollViewportSelector =
  '[data-slot="scroll-area-viewport"], [data-radix-scroll-area-viewport]'

function scheduleFrame(callback: FrameRequestCallback): () => void {
  if (typeof window.requestAnimationFrame === "function") {
    const id = window.requestAnimationFrame(callback)
    return () => window.cancelAnimationFrame(id)
  }
  const id = window.setTimeout(() => callback(performance.now()), 16)
  return () => window.clearTimeout(id)
}

function completelyContains(outer: DOMRect, inner: DOMRect): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.right <= outer.right &&
    inner.bottom <= outer.bottom
  )
}

function hasArea(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0
}

function isInsideWindow(rect: DOMRect): boolean {
  return (
    rect.left >= 0 &&
    rect.top >= 0 &&
    rect.right <= window.innerWidth &&
    rect.bottom <= window.innerHeight
  )
}

function renderedTextRects(
  element: HTMLElement,
  fallback: DOMRect,
): readonly DOMRect[] {
  const walker = element.ownerDocument.createTreeWalker(element, 4)
  const textNodes: Text[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text && node.data.trim().length > 0)
      textNodes.push(node)
  }
  if (textNodes.length === 0) return [fallback]

  const rects: DOMRect[] = []
  for (const textNode of textNodes) {
    const range = element.ownerDocument.createRange()
    if (typeof range.getClientRects !== "function") return [fallback]
    range.selectNodeContents(textNode)
    const rangeRects = range.getClientRects() as DOMRectList & {
      readonly [index: number]: DOMRect
    }
    for (let index = 0; index < rangeRects.length; index += 1) {
      const rect =
        typeof rangeRects.item === "function"
          ? rangeRects.item(index)
          : rangeRects[index]
      if (rect !== null && rect !== undefined && hasArea(rect)) rects.push(rect)
    }
  }
  return rects
}

interface VisibilityPoint {
  readonly x: number
  readonly y: number
}

function representativePoints(rect: DOMRect): readonly VisibilityPoint[] {
  const insetX = Math.min(2, rect.width / 4)
  const insetY = Math.min(2, rect.height / 4)
  const xs = [
    rect.left + insetX,
    rect.left + rect.width / 2,
    rect.right - insetX,
  ]
  const ys = [
    rect.top + insetY,
    rect.top + rect.height / 2,
    rect.bottom - insetY,
  ]
  const points: VisibilityPoint[] = []
  const seen = new Set<string>()
  for (const x of xs) {
    for (const y of ys) {
      const key = `${x}:${y}`
      if (seen.has(key)) continue
      seen.add(key)
      points.push({ x, y })
    }
  }
  return points
}

function isFrontmostAtEveryPoint(
  element: HTMLElement,
  rects: readonly DOMRect[],
): boolean {
  if (typeof document.elementFromPoint !== "function" || rects.length === 0) {
    return false
  }
  for (const rect of rects) {
    for (const point of representativePoints(rect)) {
      let hit: Element | null
      try {
        hit = document.elementFromPoint(point.x, point.y)
      } catch {
        return false
      }
      if (hit === null || (hit !== element && !element.contains(hit))) {
        return false
      }
    }
  }
  return true
}

export function isCaptionTargetFullyVisible(element: HTMLElement): boolean {
  if (
    !element.isConnected ||
    document.visibilityState === "hidden" ||
    element.getClientRects().length === 0
  ) {
    return false
  }
  const style = window.getComputedStyle(element)
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    Number.parseFloat(style.opacity) === 0
  ) {
    return false
  }

  const bounds = element.getBoundingClientRect()
  if (!hasArea(bounds) || !isInsideWindow(bounds)) {
    return false
  }

  const viewport = element.closest<HTMLElement>(scrollViewportSelector)
  const viewportBounds = viewport?.getBoundingClientRect() ?? null
  if (viewport !== null) {
    if (
      viewport.getClientRects().length === 0 ||
      viewportBounds === null ||
      !hasArea(viewportBounds) ||
      !completelyContains(viewportBounds, bounds)
    ) {
      return false
    }
  }

  const textRects = renderedTextRects(element, bounds)
  if (
    textRects.some(
      (rect) =>
        !hasArea(rect) ||
        !isInsideWindow(rect) ||
        (viewportBounds !== null && !completelyContains(viewportBounds, rect)),
    )
  ) {
    return false
  }
  return isFrontmostAtEveryPoint(element, textRects)
}

export function scheduleAfterCaptionPaint(callback: () => void): () => void {
  let cancelAfterPaint: () => void = () => undefined
  const cancelBeforePaint = scheduleFrame(() => {
    cancelAfterPaint = scheduleFrame(callback)
  })
  return () => {
    cancelBeforePaint()
    cancelAfterPaint()
  }
}

export { scrollViewportSelector }
