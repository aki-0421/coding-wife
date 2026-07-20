import { describe, expect, it, vi } from "vitest"

import {
  appPreferencesSchemaVersion,
  type AppPreferencesSnapshotV2,
} from "@/features/preferences/contracts"
import {
  AppPreferencesBoundaryError,
  DemoAppPreferencesGateway,
  NativeAppPreferencesGateway,
} from "@/features/preferences/transport"

const nativeSnapshot: AppPreferencesSnapshotV2 = {
  schemaVersion: 2,
  preferences: {
    schemaVersion: 2,
    version: 2,
    snapshotId: "123e4567-e89b-42d3-a456-426614174000",
    locale: "ja",
  },
  persistence: "native",
  recoveryCode: null,
}

describe("NativeAppPreferencesGateway", () => {
  it("sends exact locale-only get and update envelopes", async () => {
    const invoke = vi.fn(() => Promise.resolve(nativeSnapshot))
    const gateway = new NativeAppPreferencesGateway(invoke)

    await gateway.get("ja")
    await gateway.update({
      schemaVersion: appPreferencesSchemaVersion,
      expectedVersion: 2,
      locale: "en",
    })

    expect(invoke.mock.calls).toEqual([
      [
        "app_preferences_get",
        { request: { schemaVersion: 2, defaultLocale: "ja" } },
      ],
      [
        "app_preferences_update",
        {
          request: {
            schemaVersion: 2,
            expectedVersion: 2,
            locale: "en",
          },
        },
      ],
    ])
  })

  it("fails closed when native data is malformed", async () => {
    const malformed = new NativeAppPreferencesGateway(() =>
      Promise.resolve({ ...nativeSnapshot, raw: "/Users/private" }),
    )
    await expect(malformed.get("en")).rejects.toMatchObject({
      code: "APP-PREFERENCES-CONTRACT-INVALID",
      detailRef: "app-preferences-v2",
    })
  })
})

describe("DemoAppPreferencesGateway", () => {
  it("persists only locale and rejects stale versions", async () => {
    const gateway = new DemoAppPreferencesGateway()
    const initial = await gateway.get("en")
    const updated = await gateway.update({
      schemaVersion: appPreferencesSchemaVersion,
      expectedVersion: initial.preferences.version,
      locale: "ja",
    })

    expect(updated.preferences).toMatchObject({
      schemaVersion: 2,
      version: 1,
      locale: "ja",
    })
    expect(updated.preferences).not.toHaveProperty("reducedMotion")
    expect(updated.preferences).not.toHaveProperty("characterVisibility")

    await expect(
      gateway.update({
        schemaVersion: appPreferencesSchemaVersion,
        expectedVersion: 0,
        locale: "en",
      }),
    ).rejects.toBeInstanceOf(AppPreferencesBoundaryError)
  })
})
