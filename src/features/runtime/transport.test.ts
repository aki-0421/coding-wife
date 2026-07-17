import { describe, expect, it } from "vitest"

import { DemoTransport } from "@/features/runtime/transport"
import { ipcCommands } from "@/lib/contracts"

describe("DemoTransport", () => {
  it("identifies browser fallback as demo-only", async () => {
    const transport = new DemoTransport()

    await expect(
      transport.request(ipcCommands.healthCheck, undefined),
    ).resolves.toEqual({
      schemaVersion: 1,
      runtime: "demo",
      foundationState: "demo_only",
    })
  })

  it("never claims product integrations are configured", async () => {
    const transport = new DemoTransport()
    const metadata = await transport.request(
      ipcCommands.getRuntimeMetadata,
      undefined,
    )

    expect(metadata.integrations).toEqual({
      codex: "not_configured",
      git: "not_configured",
      live2d: "not_configured",
      history: "not_configured",
    })
  })
})
