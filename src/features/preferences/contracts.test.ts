import { describe, expect, it } from "vitest"

import {
  AppPreferencesContractError,
  appPreferencesSchemaVersion,
  parseAppPreferencesCommandError,
  parseAppPreferencesSnapshot,
  safeDefaultSnapshotId,
} from "@/features/preferences/contracts"

const persistedFixture = {
  schemaVersion: 2,
  preferences: {
    schemaVersion: 2,
    version: 4,
    snapshotId: "123e4567-e89b-42d3-a456-426614174000",
    locale: "ja",
  },
  persistence: "native",
  recoveryCode: null,
} as const

describe("AppPreferencesV2 contracts", () => {
  it("parses an exact locale-only native snapshot", () => {
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

  it("rejects legacy display fields, unknown versions, and raw extras", () => {
    for (const fixture of [
      { ...persistedFixture, schemaVersion: 1 },
      {
        ...persistedFixture,
        preferences: {
          ...persistedFixture.preferences,
          reducedMotion: "system",
        },
      },
      { ...persistedFixture, raw: "/Users/private" },
    ]) {
      expect(() => parseAppPreferencesSnapshot(fixture)).toThrow(
        AppPreferencesContractError,
      )
    }
  })

  it("parses only exact sanitized command errors", () => {
    const envelope = {
      code: "APP-PREFERENCES-WRITE",
      operation: "app_preferences_update",
      recoverable: true,
      userMessageKey: "preferences.error.generic",
      detailRef: "app-preferences-v2",
    }
    expect(parseAppPreferencesCommandError(envelope)).toEqual(envelope)
    expect(
      parseAppPreferencesCommandError({ ...envelope, raw: "secret" }),
    ).toBe(null)
  })
})
