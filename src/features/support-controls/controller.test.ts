import { describe, expect, it } from "vitest"

import { SupportControlsController } from "@/features/support-controls/controller"
import { DemoSupportControlsGateway } from "@/features/support-controls/transport"

describe("SupportControlsController", () => {
  it("serializes desired changes against the latest accepted version", async () => {
    const controller = new SupportControlsController(
      new DemoSupportControlsGateway(),
    )
    expect(await controller.initialize()).toBe(true)
    const first = controller.update({ globalEnabled: false })
    const second = controller.update({ commitExplainerEnabled: false })
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: {
        settings: {
          version: 3,
          globalEnabled: false,
          commitExplainerEnabled: false,
        },
        effectiveState: "user_disabled",
      },
    })
    controller.dispose()
  })
})
