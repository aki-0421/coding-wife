import { describe, expect, it, vi } from "vitest"

import {
  DemoSupportControlsGateway,
  NativeSupportControlsGateway,
  SupportControlsBoundaryError,
} from "@/features/support-controls/transport"

describe("support controls transport", () => {
  it("uses the exact typed native commands and request envelope", async () => {
    const fixture = await new DemoSupportControlsGateway().get()
    const invoke = vi.fn().mockResolvedValue(fixture)
    const gateway = new NativeSupportControlsGateway(invoke)
    await expect(gateway.get()).resolves.toEqual(fixture)
    await expect(
      gateway.update({
        schemaVersion: 1,
        expectedVersion: 3,
        globalEnabled: false,
        commitExplainerEnabled: true,
      }),
    ).resolves.toEqual(fixture)
    expect(invoke).toHaveBeenNthCalledWith(1, "support_settings_get", {
      request: { schemaVersion: 1 },
    })
    expect(invoke).toHaveBeenNthCalledWith(2, "support_settings_update", {
      request: {
        schemaVersion: 1,
        expectedVersion: 3,
        globalEnabled: false,
        commitExplainerEnabled: true,
      },
    })
  })

  it("fails closed on schema drift and preserves typed native errors", async () => {
    const fixture = await new DemoSupportControlsGateway().get()
    const malformed = new NativeSupportControlsGateway(
      vi.fn().mockResolvedValue({ ...fixture, raw: true }),
    )
    await expect(malformed.get()).rejects.toMatchObject({
      code: "CODEX-SUPPORT-CONTRACT-INVALID",
    })
    const failed = new NativeSupportControlsGateway(
      vi.fn().mockRejectedValue({
        code: "CODEX-SUPPORT-SETTINGS-CONFLICT",
        operation: "support_settings_update",
        recoverable: true,
        userMessageKey: "support.error.generic",
      }),
    )
    await expect(failed.get()).rejects.toEqual(
      expect.objectContaining({
        code: "CODEX-SUPPORT-SETTINGS-CONFLICT",
        recoverable: true,
      }),
    )
  })

  it("keeps preview deterministic and never creates model usage", async () => {
    const gateway = new DemoSupportControlsGateway()
    const initial = await gateway.get()
    expect(initial.effectiveState).toBe("release_blocked")
    expect(initial.usage.startedTasks).toBe(0)
    const disabled = await gateway.update({
      schemaVersion: 1,
      expectedVersion: 1,
      globalEnabled: false,
      commitExplainerEnabled: true,
    })
    expect(disabled.effectiveState).toBe("user_disabled")
    expect(disabled.settings.version).toBe(2)
    await expect(
      gateway.update({
        schemaVersion: 1,
        expectedVersion: 1,
        globalEnabled: true,
        commitExplainerEnabled: true,
      }),
    ).rejects.toBeInstanceOf(SupportControlsBoundaryError)
  })
})
