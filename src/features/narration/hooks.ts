import { useContext, useSyncExternalStore } from "react"

import { NarrationContext } from "@/features/narration/context"
import type {
  NarrationController,
  NarrationControllerSnapshot,
} from "@/features/narration/controller"

export function useNarrationController(): NarrationController {
  const controller = useContext(NarrationContext)
  if (controller === null) {
    throw new Error(
      "useNarrationController must be used within NarrationProvider",
    )
  }
  return controller
}

export function useNarrationSnapshot(): NarrationControllerSnapshot {
  const controller = useNarrationController()
  return useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
}
