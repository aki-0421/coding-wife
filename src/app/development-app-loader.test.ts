import { describe, expect, it, vi } from "vitest"

import {
  developmentDemoRequested,
  loadDevelopmentApplication,
} from "@/app/development-app-loader"

describe("development application bootstrap", () => {
  it("loads the native production composition without the explicit demo query", async () => {
    const production = vi.fn(() => Promise.resolve({ App: () => null }))
    const demo = vi.fn(() => Promise.resolve({ App: () => null }))

    await loadDevelopmentApplication("", { demo, production })

    expect(production).toHaveBeenCalledOnce()
    expect(demo).not.toHaveBeenCalled()
  })

  it("loads the demo composition only for the exact opt-in query", async () => {
    const production = vi.fn(() => Promise.resolve({ App: () => null }))
    const demo = vi.fn(() => Promise.resolve({ App: () => null }))

    await loadDevelopmentApplication("?demoAppServer=1", {
      demo,
      production,
    })

    expect(demo).toHaveBeenCalledOnce()
    expect(production).not.toHaveBeenCalled()
    expect(developmentDemoRequested("?demoAppServer=true")).toBe(false)
    expect(developmentDemoRequested("?demoAppServer=0")).toBe(false)
  })
})
