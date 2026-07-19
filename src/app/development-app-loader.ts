import type { ComponentType } from "react"

export interface ApplicationModule {
  readonly App: ComponentType
}

interface ApplicationImports {
  readonly demo: () => Promise<ApplicationModule>
  readonly production: () => Promise<ApplicationModule>
}

const applicationImports: ApplicationImports = {
  demo: () => import("@/app/App"),
  production: () => import("@/app/ProductionApp"),
}

export function developmentDemoRequested(search: string): boolean {
  return new URLSearchParams(search).get("demoAppServer") === "1"
}

export function loadDevelopmentApplication(
  search: string,
  imports: ApplicationImports = applicationImports,
): Promise<ApplicationModule> {
  return developmentDemoRequested(search)
    ? imports.demo()
    : imports.production()
}

export function loadApplication(): Promise<ApplicationModule> {
  return loadDevelopmentApplication(window.location.search)
}
