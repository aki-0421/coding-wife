import { createContext } from "react"

import type { AppPreferencesController } from "@/features/preferences/controller"

export const AppPreferencesContext =
  createContext<AppPreferencesController | null>(null)
