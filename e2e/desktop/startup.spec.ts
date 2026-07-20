import { $, browser, expect } from "@wdio/globals"

interface HealthCheckResponse {
  readonly schemaVersion: number
  readonly runtime: "tauri"
  readonly foundationState: "ready"
}

describe("Coding Wife desktop startup", () => {
  it("starts the real Tauri application and reaches the setup UI", async () => {
    const setupOverview = await $("[data-setup-overview]")
    await setupOverview.waitForDisplayed()

    await expect(browser).toHaveTitle("Coding Wife")
    await expect(setupOverview).toHaveAttribute("data-setup-state")
  })

  it("executes the real Rust health check through Tauri IPC", async () => {
    const health = await browser.tauri.execute(
      async ({ core }): Promise<HealthCheckResponse> =>
        core.invoke<HealthCheckResponse>("health_check"),
    )

    expect(health).toEqual({
      schemaVersion: 1,
      runtime: "tauri",
      foundationState: "ready",
    })
  })
})
