import { describe, expect, it } from "vitest"

import {
  AppPreferencesContractError,
  appPreferencesSchemaVersion,
  parseAppPreferencesCommandError,
  parseAppPreferencesSnapshot,
  safeDefaultSnapshotId,
} from "@/features/preferences/contracts"

const persistedFixture = {
  schemaVersion: 1,
  preferences: {
    schemaVersion: 1,
    version: 4,
    snapshotId: "123e4567-e89b-42d3-a456-426614174000",
    locale: "ja",
    reducedMotion: "on",
    characterVisibility: "hidden",
  },
  persistence: "native",
  recoveryCode: null,
} as const

describe("AppPreferencesV1 contracts", () => {
  it("parses an exact versioned native snapshot", () => {
    expect(parseAppPreferencesSnapshot(persistedFixture)).toEqual(
      persistedFixture,
    )
  })

  it("accepts only sanitized safe-default recovery snapshots", () => {
    expect(
      parseAppPreferencesSnapshot({
        schemaVersion: appPreferencesSchemaVersion,
        preferences: {
          schemaVersion: appPreferencesSchemaVersion,
          version: 0,
          snapshotId: safeDefaultSnapshotId,
          locale: "en",
          reducedMotion: "system",
          characterVisibility: "visible",
        },
        persistence: "native",
        recoveryCode: "APP-PREFERENCES-CORRUPT",
      }),
    ).toMatchObject({ recoveryCode: "APP-PREFERENCES-CORRUPT" })

    expect(() =>
      parseAppPreferencesSnapshot({
        ...persistedFixture,
        recoveryCode: "APP-PREFERENCES-CORRUPT",
      }),
    ).toThrow(AppPreferencesContractError)
  })

  it("rejects unknown versions, enum drift, and extra raw fields", () => {
    for (const fixture of [
      { ...persistedFixture, schemaVersion: 2 },
      {
        ...persistedFixture,
        preferences: {
          ...persistedFixture.preferences,
          reducedMotion: "reduce",
        },
      },
      {
        ...persistedFixture,
        preferences: {
          ...persistedFixture.preferences,
          rawValue: "/\u0055sers/private/token=secret",
        },
      },
      {
        ...persistedFixture,
        recoveryCode: "APP-PREFERENCES-RAW-ERROR",
      },
    ]) {
      expect(() => parseAppPreferencesSnapshot(fixture)).toThrow(
        AppPreferencesContractError,
      )
    }
  })

  it("parses only bounded native error envelopes", () => {
    expect(
      parseAppPreferencesCommandError({
        code: "APP-PREFERENCES-CONFLICT",
        operation: "app_preferences_update",
        recoverable: true,
        userMessageKey: "preferences.error.generic",
        detailRef: "app-preferences-v1",
      }),
    ).toMatchObject({ code: "APP-PREFERENCES-CONFLICT" })
    expect(
      parseAppPreferencesCommandError({
        code: "APP-PREFERENCES-CONFLICT",
        operation: "app_preferences_update",
        recoverable: true,
        userMessageKey: "preferences.error.generic",
        detailRef: "app-preferences-v1",
        raw: "/\u0055sers/private/token=secret",
      }),
    ).toBeNull()
  })
})
