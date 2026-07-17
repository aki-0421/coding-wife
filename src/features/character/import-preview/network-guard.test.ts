import { afterEach, describe, expect, it, vi } from "vitest"

import { installCharacterPreviewNetworkGuard } from "@/features/character/import-preview/network-guard"

const originalFetch = globalThis.fetch

afterEach(() => {
  vi.unstubAllGlobals()
  globalThis.fetch = originalFetch
})

describe("isolated character preview network guard", () => {
  it("serves only bundled canonical shaders from memory", async () => {
    installCharacterPreviewNetworkGuard()
    const response = await fetch(
      "/vendor/live2d/shaders/webgl/vertshadersrc.vert",
    )
    expect(response.headers.get("content-type")).toContain("text/plain")
    expect((await response.text()).length).toBeGreaterThan(20)
  })

  it.each([
    "https://example.test/model.moc3",
    "/characters/custom/model.moc3",
    "/vendor/live2d/shaders/webgl/unknown.vert",
  ])("rejects every non-shader network request %s", async (url) => {
    installCharacterPreviewNetworkGuard()
    await expect(fetch(url)).rejects.toThrow(
      "Character preview network is disabled",
    )
  })
})
