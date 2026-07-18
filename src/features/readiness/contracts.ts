export const nativeReadinessSchemaVersion = 1 as const

export const nativeReadinessCommands = {
  run: "run_diagnostic_check",
  copy: "copy_sanitized_diagnostics",
} as const

export const readinessCheckIds = [
  "os_app",
  "codex",
  "git",
  "history",
  "live2d",
  "preferences",
] as const

export const readinessStatuses = [
  "ready",
  "degraded",
  "blocked",
  "not_configured",
  "unavailable",
  "error",
] as const

export const readinessRecoveryActions = [
  "none",
  "recheck",
  "install_codex",
  "authenticate_codex",
  "update_codex",
  "select_workspace",
  "repair_workspace",
  "repair_history",
  "restore_live2d",
  "save_preferences",
  "reset_preferences",
] as const

export const readinessFactKeys = [
  "platform",
  "architecture",
  "os_version",
  "app_version",
  "build_profile",
  "readiness_schema",
  "codex_model",
  "codex_auth",
  "codex_schema",
  "git_executable",
  "repository_health",
  "history_schema",
  "history_mode",
  "live2d_core",
  "builtin_resources",
  "character_library",
  "character_schema",
  "preferences_schema",
] as const

export type ReadinessCheckId = (typeof readinessCheckIds)[number]
export type ReadinessStatus = (typeof readinessStatuses)[number]
export type ReadinessRecoveryAction = (typeof readinessRecoveryActions)[number]
export type ReadinessFactKey = (typeof readinessFactKeys)[number]
export type ReadinessSource = "native" | "demo"

export interface ReadinessFactV1 {
  readonly key: ReadinessFactKey
  readonly value: string
}

export interface ReadinessCheckV1 {
  readonly id: ReadinessCheckId
  readonly status: ReadinessStatus
  readonly checkedAt: string
  readonly code: string
  readonly recoverable: boolean
  readonly recoveryAction: ReadinessRecoveryAction
  readonly facts: readonly ReadinessFactV1[]
}

export interface NativeReadinessSnapshotV1 {
  readonly schemaVersion: typeof nativeReadinessSchemaVersion
  readonly snapshotId: string
  readonly checkedAt: string
  readonly source: ReadinessSource
  readonly checks: readonly ReadinessCheckV1[]
}

export interface SanitizedDiagnosticsSummaryV1 {
  readonly schemaVersion: typeof nativeReadinessSchemaVersion
  readonly snapshotId: string
  readonly summary: string
}

export interface ReadinessCommandErrorEnvelope {
  readonly code: string
  readonly operation: string
  readonly recoverable: boolean
  readonly userMessageKey: string
  readonly detailRef: string
}

type UnknownRecord = Readonly<Record<string, unknown>>

export class NativeReadinessContractError extends Error {
  public readonly code = "READINESS-CONTRACT-INVALID"

  public constructor() {
    super("READINESS-CONTRACT-INVALID")
    this.name = "NativeReadinessContractError"
  }
}

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

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
}

function isUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    value.endsWith("Z") &&
    Number.isFinite(Date.parse(value))
  )
}

function isSafeCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 96 &&
    /^READINESS-[A-Z0-9-]+$/u.test(value)
  )
}

function isSafeFactValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 80 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  )
}

function isMember<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.some((item) => item === value)
}

function contractError(): never {
  throw new NativeReadinessContractError()
}

function parseFact(value: unknown): ReadinessFactV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["key", "value"]) ||
    !isMember(value.key, readinessFactKeys) ||
    !isSafeFactValue(value.value)
  ) {
    return contractError()
  }
  return { key: value.key, value: value.value }
}

function parseCheck(value: unknown, checkedAt: string): ReadinessCheckV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "status",
      "checkedAt",
      "code",
      "recoverable",
      "recoveryAction",
      "facts",
    ]) ||
    !isMember(value.id, readinessCheckIds) ||
    !isMember(value.status, readinessStatuses) ||
    value.checkedAt !== checkedAt ||
    !isSafeCode(value.code) ||
    typeof value.recoverable !== "boolean" ||
    !isMember(value.recoveryAction, readinessRecoveryActions) ||
    !Array.isArray(value.facts) ||
    value.facts.length > readinessFactKeys.length
  ) {
    return contractError()
  }
  const facts = value.facts.map(parseFact)
  if (new Set(facts.map((fact) => fact.key)).size !== facts.length) {
    return contractError()
  }
  return {
    id: value.id,
    status: value.status,
    checkedAt,
    code: value.code,
    recoverable: value.recoverable,
    recoveryAction: value.recoveryAction,
    facts,
  }
}

export function parseNativeReadinessSnapshot(
  value: unknown,
): NativeReadinessSnapshotV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "snapshotId",
      "checkedAt",
      "source",
      "checks",
    ]) ||
    value.schemaVersion !== nativeReadinessSchemaVersion ||
    !isUuid(value.snapshotId) ||
    !isUtcTimestamp(value.checkedAt) ||
    (value.source !== "native" && value.source !== "demo") ||
    !Array.isArray(value.checks) ||
    value.checks.length !== readinessCheckIds.length
  ) {
    return contractError()
  }
  const checks = value.checks.map((check) =>
    parseCheck(check, value.checkedAt as string),
  )
  const ids = checks.map((check) => check.id)
  if (
    new Set(ids).size !== readinessCheckIds.length ||
    !readinessCheckIds.every((id) => ids.includes(id)) ||
    (value.source === "demo" &&
      checks.some((check) => check.status === "ready"))
  ) {
    return contractError()
  }
  return {
    schemaVersion: nativeReadinessSchemaVersion,
    snapshotId: value.snapshotId,
    checkedAt: value.checkedAt,
    source: value.source,
    checks,
  }
}

export function parseSanitizedDiagnosticsSummary(
  value: unknown,
  expectedSnapshotId: string,
): SanitizedDiagnosticsSummaryV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "snapshotId", "summary"]) ||
    value.schemaVersion !== nativeReadinessSchemaVersion ||
    value.snapshotId !== expectedSnapshotId ||
    !isUuid(value.snapshotId) ||
    typeof value.summary !== "string" ||
    value.summary.length > 12_000 ||
    !value.summary.startsWith("Coding Wife diagnostics v1\n") ||
    /\/Users\/|\/home\/|[A-Za-z]:\\|token=|cookie=|authorization=|stderr|stdout/iu.test(
      value.summary,
    ) ||
    Array.from(value.summary).some(
      (character) => /\p{Cc}/u.test(character) && character !== "\n",
    )
  ) {
    return contractError()
  }
  return {
    schemaVersion: nativeReadinessSchemaVersion,
    snapshotId: value.snapshotId,
    summary: value.summary,
  }
}

export function parseReadinessCommandError(
  value: unknown,
): ReadinessCommandErrorEnvelope | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "code",
      "operation",
      "recoverable",
      "userMessageKey",
      "detailRef",
    ]) ||
    !isSafeCode(value.code) ||
    typeof value.operation !== "string" ||
    typeof value.recoverable !== "boolean" ||
    value.userMessageKey !== "readiness.error.generic" ||
    value.detailRef !== "native-readiness-v1"
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

export function checkById(
  snapshot: NativeReadinessSnapshotV1 | null,
  id: ReadinessCheckId,
): ReadinessCheckV1 | null {
  return snapshot?.checks.find((check) => check.id === id) ?? null
}
