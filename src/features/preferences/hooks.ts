import { useContext, useSyncExternalStore } from "react"

import { AppPreferencesContext } from "@/features/preferences/context"
import type {
  AppPreferencesController,
  AppPreferencesControllerState,
} from "@/features/preferences/controller"

export function useAppPreferencesController(): AppPreferencesController {
  const controller = useContext(AppPreferencesContext)
  if (controller === null) {
    throw new Error(
      "useAppPreferencesController must be used within AppPreferencesProvider",
    )
  }
  return controller
}

export function useAppPreferences(): AppPreferencesControllerState {
  const controller = useAppPreferencesController()
  return useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
}
