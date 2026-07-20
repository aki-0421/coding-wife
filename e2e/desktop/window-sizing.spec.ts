import { $, browser, expect } from "@wdio/globals"

import {
  setLogicalWindowSize,
  type LogicalWindowSize,
} from "./support/window"

const acceptanceSizes: readonly LogicalWindowSize[] = [
  { width: 1470, height: 836 },
  { width: 1280, height: 800 },
  { width: 960, height: 640 },
]

interface HorizontalLayout {
  readonly clientWidth: number
  readonly scrollWidth: number
}

describe("Coding Wife native window sizing", () => {
  it("uses the required logical viewport at each acceptance size", async () => {
    const setupOverview = await $("[data-setup-overview]")
    await setupOverview.waitForDisplayed()

    for (const size of acceptanceSizes) {
      const metrics = await setLogicalWindowSize(size)
      expect(metrics.viewport).toEqual(size)
      expect(metrics.webdriver).toEqual(metrics.physical)
      await expect(setupOverview).toBeDisplayed()

      const horizontalLayout = (await browser.execute(() => {
        const page = globalThis as unknown as {
          readonly document: {
            readonly documentElement: {
              readonly clientWidth: number
              readonly scrollWidth: number
            }
          }
        }
        return {
          clientWidth: page.document.documentElement.clientWidth,
          scrollWidth: page.document.documentElement.scrollWidth,
        }
      })) as unknown as HorizontalLayout
      expect(horizontalLayout.scrollWidth).toBeLessThanOrEqual(
        horizontalLayout.clientWidth,
      )
    }
  })
})
