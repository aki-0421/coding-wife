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
  if (
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.left < 0 ||
    bounds.top < 0 ||
    bounds.right > window.innerWidth ||
    bounds.bottom > window.innerHeight
  ) {
    return false
  }

  const viewport = element.closest<HTMLElement>(scrollViewportSelector)
  if (viewport !== null) {
    const viewportBounds = viewport.getBoundingClientRect()
    if (
      viewport.getClientRects().length === 0 ||
      viewportBounds.width <= 0 ||
      viewportBounds.height <= 0 ||
      !completelyContains(viewportBounds, bounds)
    ) {
      return false
    }
  }

  if (typeof document.elementFromPoint !== "function") return false
  const hit = document.elementFromPoint(
    bounds.left + bounds.width / 2,
    bounds.top + bounds.height / 2,
  )
  return hit !== null && element.contains(hit)
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
