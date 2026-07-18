import type { ComponentType } from "react"

interface ApplicationModule {
  readonly App: ComponentType
}

export function loadApplication(): Promise<ApplicationModule> {
  return import("@/app/ProductionApp")
}
