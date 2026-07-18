import { useContext, useSyncExternalStore } from "react"

import { NativeReadinessContext } from "@/features/readiness/context"

export function useNativeReadinessController() {
  const controller = useContext(NativeReadinessContext)
  if (controller === null) {
    throw new Error(
      "useNativeReadinessController must be used within NativeReadinessProvider",
    )
  }
  return controller
}

export function useNativeReadiness() {
  const controller = useNativeReadinessController()
  return useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
}
