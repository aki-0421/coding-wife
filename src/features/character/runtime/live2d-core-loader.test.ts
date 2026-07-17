import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  LIVE2D_CORE_SCRIPT_URL,
  LIVE2D_CORE_VERSION,
  loadLive2dCore,
  resetLive2dCoreLoaderForTests,
} from "@/features/character/runtime/live2d-core-loader"

function setCoreVersion(version: number): void {
  Object.defineProperty(globalThis, "Live2DCubismCore", {
    configurable: true,
    value: {
      Version: {
        csmGetVersion: () => version,
      },
    },
  })
}

describe("Live2D Core loader", () => {
  beforeEach(() => {
    resetLive2dCoreLoaderForTests()
    Reflect.deleteProperty(globalThis, "Live2DCubismCore")
  })

  afterEach(() => {
    document
      .querySelectorAll("script[data-coding-wife-live2d-core]")
      .forEach((script) => script.remove())
    Reflect.deleteProperty(globalThis, "Live2DCubismCore")
  })

  it("loads one reviewed same-origin classic script for concurrent callers", async () => {
    const first = loadLive2dCore()
    const second = loadLive2dCore()
    const script = document.querySelector<HTMLScriptElement>(
      "script[data-coding-wife-live2d-core]",
    )

    expect(first).toBe(second)
    expect(script?.getAttribute("src")).toBe(LIVE2D_CORE_SCRIPT_URL)
    setCoreVersion(LIVE2D_CORE_VERSION)
    script?.dispatchEvent(new Event("load"))

    await expect(first).resolves.toBeDefined()
    await expect(second).resolves.toBeDefined()
    expect(
      document.querySelectorAll("script[data-coding-wife-live2d-core]"),
    ).toHaveLength(1)
  })

  it("fails closed when a preloaded Core version differs", async () => {
    setCoreVersion(LIVE2D_CORE_VERSION + 1)

    await expect(loadLive2dCore()).rejects.toMatchObject({
      code: "core_version_mismatch",
      recoverable: false,
    })
  })
})
