export const appPreferencesSchemaVersion = 1 as const
export const safeDefaultSnapshotId =
  "00000000-0000-0000-0000-000000000000" as const

export const appPreferencesCommands = {
  get: "app_preferences_get",
  update: "app_preferences_update",
  reset: "app_preferences_reset",
} as const

export type AppPreferencesCommand =
  (typeof appPreferencesCommands)[keyof typeof appPreferencesCommands]
export type AppLocale = "ja" | "en"
export type ReducedMotionPreference = "system" | "on" | "off"
export type CharacterVisibility = "visible" | "hidden"
export type AppPreferencesPersistence = "native" | "demo_memory"
export type AppPreferencesRecoveryCode =
  | "APP-PREFERENCES-MISSING"
  | "APP-PREFERENCES-CORRUPT"
  | "APP-PREFERENCES-UNKNOWN-VERSION"
  | "APP-PREFERENCES-UNSAFE-FILE"
  | "APP-PREFERENCES-MIGRATION-FAILED"
  | "APP-PREFERENCES-UNAVAILABLE"

export interface AppPreferencesV1 {
  readonly schemaVersion: typeof appPreferencesSchemaVersion
  readonly version: number
  readonly snapshotId: string
  readonly locale: AppLocale
  readonly reducedMotion: ReducedMotionPreference
  readonly characterVisibility: CharacterVisibility
}

export interface AppPreferencesSnapshotV1 {
  readonly schemaVersion: typeof appPreferencesSchemaVersion
  readonly preferences: AppPreferencesV1
  readonly persistence: AppPreferencesPersistence
  readonly recoveryCode: AppPreferencesRecoveryCode | null
}

export interface AppPreferencesGetRequestV1 {
  readonly schemaVersion: typeof appPreferencesSchemaVersion
  readonly defaultLocale: AppLocale
}

export interface AppPreferencesUpdateRequestV1 {
  readonly schemaVersion: typeof appPreferencesSchemaVersion
  readonly expectedVersion: number
  readonly locale: AppLocale
  readonly reducedMotion: ReducedMotionPreference
  readonly characterVisibility: CharacterVisibility
}

export interface AppPreferencesResetRequestV1 {
  readonly schemaVersion: typeof appPreferencesSchemaVersion
  readonly expectedVersion: number
  readonly defaultLocale: AppLocale
}

export interface AppPreferencesCommandErrorEnvelope {
  readonly code: string
  readonly operation: string
  readonly recoverable: boolean
  readonly userMessageKey: string
  readonly detailRef: string
}

export class AppPreferencesContractError extends Error {
  public readonly code = "APP-PREFERENCES-CONTRACT-INVALID"

  public constructor() {
    super("APP-PREFERENCES-CONTRACT-INVALID")
    this.name = "AppPreferencesContractError"
  }
}

type UnknownRecord = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
): boolean {
  const allowed = new Set(required)
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  )
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isSafeString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    value.trim() === value &&
    !Array.from(value).some((character) => /\p{Cc}/u.test(character))
  )
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
}

function isLocale(value: unknown): value is AppLocale {
  return value === "ja" || value === "en"
}

function isReducedMotion(value: unknown): value is ReducedMotionPreference {
  return value === "system" || value === "on" || value === "off"
}

function isCharacterVisibility(value: unknown): value is CharacterVisibility {
  return value === "visible" || value === "hidden"
}

function isPersistence(value: unknown): value is AppPreferencesPersistence {
  return value === "native" || value === "demo_memory"
}

function isRecoveryCode(value: unknown): value is AppPreferencesRecoveryCode {
  return (
    value === "APP-PREFERENCES-MISSING" ||
    value === "APP-PREFERENCES-CORRUPT" ||
    value === "APP-PREFERENCES-UNKNOWN-VERSION" ||
    value === "APP-PREFERENCES-UNSAFE-FILE" ||
    value === "APP-PREFERENCES-MIGRATION-FAILED" ||
    value === "APP-PREFERENCES-UNAVAILABLE"
  )
}

function contractError(): never {
  throw new AppPreferencesContractError()
}

export function parseAppPreferencesSnapshot(
  value: unknown,
): AppPreferencesSnapshotV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "preferences",
      "persistence",
      "recoveryCode",
    ]) ||
    value.schemaVersion !== appPreferencesSchemaVersion ||
    !isPersistence(value.persistence) ||
    (value.recoveryCode !== null && !isRecoveryCode(value.recoveryCode)) ||
    !isRecord(value.preferences)
  ) {
    return contractError()
  }

  const preferences = value.preferences
  if (
    !hasExactKeys(preferences, [
      "schemaVersion",
      "version",
      "snapshotId",
      "locale",
      "reducedMotion",
      "characterVisibility",
    ]) ||
    preferences.schemaVersion !== appPreferencesSchemaVersion ||
    !isSafeInteger(preferences.version) ||
    !isUuid(preferences.snapshotId) ||
    !isLocale(preferences.locale) ||
    !isReducedMotion(preferences.reducedMotion) ||
    !isCharacterVisibility(preferences.characterVisibility)
  ) {
    return contractError()
  }

  if (
    value.recoveryCode !== null &&
    (preferences.version !== 0 ||
      preferences.snapshotId !== safeDefaultSnapshotId ||
      preferences.reducedMotion !== "system" ||
      preferences.characterVisibility !== "visible")
  ) {
    return contractError()
  }
  if (
    value.recoveryCode === null &&
    value.persistence === "native" &&
    preferences.snapshotId === safeDefaultSnapshotId
  ) {
    return contractError()
  }

  return {
    schemaVersion: appPreferencesSchemaVersion,
    preferences: {
      schemaVersion: appPreferencesSchemaVersion,
      version: preferences.version,
      snapshotId: preferences.snapshotId,
      locale: preferences.locale,
      reducedMotion: preferences.reducedMotion,
      characterVisibility: preferences.characterVisibility,
    },
    persistence: value.persistence,
    recoveryCode: value.recoveryCode,
  }
}

export function parseAppPreferencesCommandError(
  value: unknown,
): AppPreferencesCommandErrorEnvelope | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "code",
      "operation",
      "recoverable",
      "userMessageKey",
      "detailRef",
    ]) ||
    !isSafeString(value.code) ||
    !isSafeString(value.operation) ||
    typeof value.recoverable !== "boolean" ||
    !isSafeString(value.userMessageKey) ||
    !isSafeString(value.detailRef)
  ) {
    return null
  }
  return {
    code: value.code,
    operation: value.operation,
    recoverable: value.recoverable,
    userMessageKey: value.userMessageKey,
    detailRef: value.detailRef,
  }
}

export function createSafeDefaultPreferences(
  locale: AppLocale,
): AppPreferencesV1 {
  return {
    schemaVersion: appPreferencesSchemaVersion,
    version: 0,
    snapshotId: safeDefaultSnapshotId,
    locale,
    reducedMotion: "system",
    characterVisibility: "visible",
  }
}
