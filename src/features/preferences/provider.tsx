import { useEffect, useState, type ReactNode } from "react"

import { AppPreferencesContext } from "@/features/preferences/context"
import type { AppPreferencesController } from "@/features/preferences/controller"

export interface AppPreferencesProviderProps {
  readonly children: ReactNode
  readonly controller: AppPreferencesController
}

export function AppPreferencesProvider({
  children,
  controller,
}: AppPreferencesProviderProps) {
  const [systemReducedMotion, setSystemReducedMotion] = useState(() =>
    typeof window === "undefined" || window.matchMedia === undefined
      ? false
      : window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  )

  useEffect(() => {
    void controller.initialize()
  }, [controller])

  useEffect(() => {
    if (typeof window === "undefined" || window.matchMedia === undefined) return
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const synchronize = () => setSystemReducedMotion(query.matches)
    synchronize()
    query.addEventListener("change", synchronize)
    return () => query.removeEventListener("change", synchronize)
  }, [])

  useEffect(() => {
    if (typeof document === "undefined") return
    if (systemReducedMotion) {
      document.documentElement.dataset.reducedMotion = "true"
    } else {
      delete document.documentElement.dataset.reducedMotion
    }
    return () => {
      delete document.documentElement.dataset.reducedMotion
    }
  }, [systemReducedMotion])

  return (
    <AppPreferencesContext.Provider value={controller}>
      {children}
    </AppPreferencesContext.Provider>
  )
}
