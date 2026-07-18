import { describe, expect, it, vi } from "vitest"

import {
  appPreferencesSchemaVersion,
  type AppPreferencesSnapshotV1,
} from "@/features/preferences/contracts"
import {
  AppPreferencesBoundaryError,
  DemoAppPreferencesGateway,
  NativeAppPreferencesGateway,
} from "@/features/preferences/transport"

const nativeSnapshot: AppPreferencesSnapshotV1 = {
  schemaVersion: 1,
  preferences: {
    schemaVersion: 1,
    version: 2,
    snapshotId: "123e4567-e89b-42d3-a456-426614174000",
    locale: "ja",
    reducedMotion: "on",
    characterVisibility: "hidden",
  },
  persistence: "native",
  recoveryCode: null,
}

describe("NativeAppPreferencesGateway", () => {
  it("sends exact typed get, update, and reset request envelopes", async () => {
    const invoke = vi.fn(() => Promise.resolve(nativeSnapshot))
    const gateway = new NativeAppPreferencesGateway(invoke)

    await gateway.get("ja")
    await gateway.update({
      schemaVersion: appPreferencesSchemaVersion,
      expectedVersion: 2,
      locale: "en",
      reducedMotion: "off",
      characterVisibility: "visible",
    })
    await gateway.reset({
      schemaVersion: appPreferencesSchemaVersion,
      expectedVersion: 3,
      defaultLocale: "ja",
    })

    expect(invoke.mock.calls).toEqual([
      [
        "app_preferences_get",
        { request: { schemaVersion: 1, defaultLocale: "ja" } },
      ],
      [
        "app_preferences_update",
        {
          request: {
            schemaVersion: 1,
            expectedVersion: 2,
            locale: "en",
            reducedMotion: "off",
            characterVisibility: "visible",
          },
        },
      ],
      [
        "app_preferences_reset",
        {
          request: {
            schemaVersion: 1,
            expectedVersion: 3,
            defaultLocale: "ja",
          },
        },
      ],
    ])
  })

  it("fails closed when native data is malformed or raw errors escape", async () => {
    const malformed = new NativeAppPreferencesGateway(() =>
      Promise.resolve({ ...nativeSnapshot, raw: "/Users/private" }),
    )
    await expect(malformed.get("en")).rejects.toMatchObject({
      code: "APP-PREFERENCES-CONTRACT-INVALID",
      recoverable: false,
    })

    const rawError = new NativeAppPreferencesGateway(() =>
      Promise.reject(new Error("/Users/private/token=secret")),
    )
    await expect(rawError.get("en")).rejects.toEqual(
      expect.objectContaining({
        code: "APP-PREFERENCES-IPC-UNAVAILABLE",
      }),
    )
  })
})

describe("DemoAppPreferencesGateway", () => {
  it("is honest memory-only state and a new preview restarts at defaults", async () => {
    const gateway = new DemoAppPreferencesGateway()
    const initial = await gateway.get("ja")
    expect(initial).toMatchObject({
      persistence: "demo_memory",
      preferences: {
        locale: "ja",
        reducedMotion: "system",
        characterVisibility: "visible",
      },
    })

    const changed = await gateway.update({
      schemaVersion: 1,
      expectedVersion: initial.preferences.version,
      locale: "en",
      reducedMotion: "on",
      characterVisibility: "hidden",
    })
    expect(changed.preferences.version).toBe(1)
    expect((await gateway.get("ja")).preferences.locale).toBe("en")

    const restartedPreview = await new DemoAppPreferencesGateway().get("ja")
    expect(restartedPreview).toMatchObject({
      persistence: "demo_memory",
      preferences: {
        version: 0,
        locale: "ja",
        reducedMotion: "system",
        characterVisibility: "visible",
      },
    })
  })

  it("rejects stale expected versions", async () => {
    const gateway = new DemoAppPreferencesGateway()
    await gateway.get("en")
    await expect(
      gateway.update({
        schemaVersion: 1,
        expectedVersion: 9,
        locale: "ja",
        reducedMotion: "system",
        characterVisibility: "visible",
      }),
    ).rejects.toBeInstanceOf(AppPreferencesBoundaryError)
  })
})
