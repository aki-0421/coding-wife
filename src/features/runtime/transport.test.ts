import { describe, expect, it } from "vitest"

import { DemoTransport, TauriTransport } from "@/features/runtime/transport"
import { ipcCommands } from "@/lib/contracts"
import runtimeFixture from "@/test/fixtures/runtime-foundation.v1.json"

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

describe("TauriTransport", () => {
  it("parses each response from the shared Rust fixture", async () => {
    const transport = new TauriTransport((command) => {
      return Promise.resolve(
        command === ipcCommands.healthCheck
          ? runtimeFixture.healthCheck
          : runtimeFixture.runtimeMetadata,
      )
    })

    await expect(
      transport.request(ipcCommands.healthCheck, undefined),
    ).resolves.toEqual(runtimeFixture.healthCheck)
    await expect(
      transport.request(ipcCommands.getRuntimeMetadata, undefined),
    ).resolves.toEqual(runtimeFixture.runtimeMetadata)
  })

  it("normalizes malformed native data to a safe error envelope", async () => {
    const transport = new TauriTransport(() => {
      return Promise.resolve({
        schema_version: 1,
        runtime: "tauri",
        foundation_state: "ready",
      })
    })

    await expect(
      transport.request(ipcCommands.healthCheck, undefined),
    ).rejects.toMatchObject({
      code: "APP-IPC-CONTRACT-MISMATCH",
      operation: ipcCommands.healthCheck,
      recoverable: false,
      userMessageKey: "foundation.error",
      detailRef: "runtime-contract-v1",
    })
  })

  it("does not expose raw invoke errors", async () => {
    const transport = new TauriTransport(() => {
      return Promise.reject(new Error("/\u0055sers/private/token=secret"))
    })

    await expect(
      transport.request(ipcCommands.getRuntimeMetadata, undefined),
    ).rejects.toMatchObject({
      code: "APP-IPC-UNAVAILABLE",
      operation: ipcCommands.getRuntimeMetadata,
      recoverable: true,
      userMessageKey: "foundation.error",
    })
  })
})
