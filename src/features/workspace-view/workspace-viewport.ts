import { useSyncExternalStore } from "react"

export type WorkspaceViewportLayout = "desktop" | "compact" | "narrow"

function viewportLayout(width: number): WorkspaceViewportLayout {
  if (width <= 840) return "narrow"
  if (width <= 1279) return "compact"
  return "desktop"
}

function currentViewportLayout(): WorkspaceViewportLayout {
  return viewportLayout(window.innerWidth)
}

function subscribeViewport(listener: () => void): () => void {
  window.addEventListener("resize", listener)
  return () => window.removeEventListener("resize", listener)
}

export function useWorkspaceViewportLayout(): WorkspaceViewportLayout {
  return useSyncExternalStore(
    subscribeViewport,
    currentViewportLayout,
    () => "desktop",
  )
}
