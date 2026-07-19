export const supportControlSchemaVersion = 1 as const
export const supportMaximumActive = 1 as const
export const supportMaximumQueued = 10 as const

export const supportControlCommands = {
  get: "support_settings_get",
  update: "support_settings_update",
} as const

export type SupportControlCommand =
  (typeof supportControlCommands)[keyof typeof supportControlCommands]
export type SupportPersistence = "native" | "demo_memory"
export type SupportReadinessStatus = "approved" | "blocked" | "unavailable"
export type SupportEffectiveState =
  | "enabled"
  | "user_disabled"
  | "role_disabled"
  | "release_blocked"
  | "settings_recovery"
export type SupportOutcomeStatus =
  "generated" | "failed" | "canceled" | "unavailable"
export type SupportTrigger =
  "auto_verified_commit" | "user_request" | "user_retry"

export interface SupportSettingsV1 {
  readonly schemaVersion: typeof supportControlSchemaVersion
  readonly version: number
  readonly globalEnabled: boolean
  readonly commitExplainerEnabled: boolean
}

export interface SupportReleaseReadinessV1 {
  readonly status: SupportReadinessStatus
  readonly approvedCliVersion: string
  readonly approvedBinaryHashPrefix: string
  readonly approvedSchemaFingerprintPrefix: string
  readonly observedCliVersion: string | null
  readonly observedBinaryHashPrefix: string | null
  readonly observedSchemaFingerprintPrefix: string | null
  readonly skillName: string
  readonly skillVersion: string | null
  readonly skillDigestPrefix: string | null
  readonly reasonCode: string | null
  readonly checkedAt: string
}

export interface SupportCapacityV1 {
  readonly maximumActive: typeof supportMaximumActive
  readonly maximumQueued: typeof supportMaximumQueued
  readonly active: number
  readonly queued: number
}

export interface SupportUsageCountersV1 {
  readonly attemptedTasks: number
  readonly startedTasks: number
  readonly succeededTasks: number
  readonly failedTasks: number
  readonly canceledTasks: number
  readonly unavailableTasks: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly totalLatencyMs: number
}

export interface SupportLatestOutcomeV1 {
  readonly status: SupportOutcomeStatus
  readonly trigger: SupportTrigger
  readonly completedAt: string
  readonly latencyMs: number | null
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly errorCode: string | null
}

export interface SupportAuditV1 {
  readonly role: "commit_explainer"
  readonly modelFamily: "gpt-5.6-sol"
  readonly reasoningEffort: "low"
  readonly permissionProfile: "coding-wife-support-zero"
  readonly rawTranscriptPersisted: false
  readonly taskTimeoutMs: 15_000
  readonly tokenBudget: 16_000
  readonly fallbackTasks: number
  readonly latestOutcome: SupportLatestOutcomeV1 | null
}

export interface SupportControlSnapshotV1 {
  readonly schemaVersion: typeof supportControlSchemaVersion
  readonly settings: SupportSettingsV1
  readonly persistence: SupportPersistence
  readonly recoveryCode: string | null
  readonly readiness: SupportReleaseReadinessV1
  readonly effectiveState: SupportEffectiveState
  readonly effectiveEnabled: boolean
  readonly fallbackReasonCode: string | null
  readonly capacity: SupportCapacityV1
  readonly usage: SupportUsageCountersV1
  readonly audit: SupportAuditV1
  readonly lastErrorCode: string | null
}

export interface SupportSettingsGetRequestV1 {
  readonly schemaVersion: typeof supportControlSchemaVersion
}

export interface SupportSettingsUpdateRequestV1 {
  readonly schemaVersion: typeof supportControlSchemaVersion
  readonly expectedVersion: number
  readonly globalEnabled: boolean
  readonly commitExplainerEnabled: boolean
}

export interface SupportControlCommandErrorEnvelope {
  readonly code: string
  readonly operation: string
  readonly recoverable: boolean
  readonly userMessageKey: string
}

export class SupportControlContractError extends Error {
  public readonly code = "CODEX-SUPPORT-CONTRACT-INVALID"

  public constructor() {
    super("CODEX-SUPPORT-CONTRACT-INVALID")
    this.name = "SupportControlContractError"
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

function isSafeString(value: unknown, maximum = 160): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !Array.from(value).some((character) => /\p{Cc}/u.test(character))
  )
}

function isSafeCode(value: unknown): value is string {
  return (
    isSafeString(value, 128) &&
    /^(?:CODEX-SUPPORT|SUPPORT)-[A-Z0-9-]+$/u.test(value)
  )
}

function isHashPrefix(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/u.test(value)
}

function isTimestamp(value: unknown): value is string {
  return (
    isSafeString(value, 64) &&
    !Number.isNaN(Date.parse(value)) &&
    value.includes("T")
  )
}

function isReadinessStatus(value: unknown): value is SupportReadinessStatus {
  return value === "approved" || value === "blocked" || value === "unavailable"
}

function isEffectiveState(value: unknown): value is SupportEffectiveState {
  return (
    value === "enabled" ||
    value === "user_disabled" ||
    value === "role_disabled" ||
    value === "release_blocked" ||
    value === "settings_recovery"
  )
}

function isOutcomeStatus(value: unknown): value is SupportOutcomeStatus {
  return (
    value === "generated" ||
    value === "failed" ||
    value === "canceled" ||
    value === "unavailable"
  )
}

function isTrigger(value: unknown): value is SupportTrigger {
  return (
    value === "auto_verified_commit" ||
    value === "user_request" ||
    value === "user_retry"
  )
}

function contractError(): never {
  throw new SupportControlContractError()
}

function parseSettings(value: unknown): SupportSettingsV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "version",
      "globalEnabled",
      "commitExplainerEnabled",
    ]) ||
    value.schemaVersion !== supportControlSchemaVersion ||
    !isSafeInteger(value.version) ||
    typeof value.globalEnabled !== "boolean" ||
    typeof value.commitExplainerEnabled !== "boolean"
  ) {
    return contractError()
  }
  return {
    schemaVersion: supportControlSchemaVersion,
    version: value.version,
    globalEnabled: value.globalEnabled,
    commitExplainerEnabled: value.commitExplainerEnabled,
  }
}

function parseReadiness(value: unknown): SupportReleaseReadinessV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "status",
      "approvedCliVersion",
      "approvedBinaryHashPrefix",
      "approvedSchemaFingerprintPrefix",
      "observedCliVersion",
      "observedBinaryHashPrefix",
      "observedSchemaFingerprintPrefix",
      "skillName",
      "skillVersion",
      "skillDigestPrefix",
      "reasonCode",
      "checkedAt",
    ]) ||
    !isReadinessStatus(value.status) ||
    !isSafeString(value.approvedCliVersion, 32) ||
    !isHashPrefix(value.approvedBinaryHashPrefix) ||
    !isHashPrefix(value.approvedSchemaFingerprintPrefix) ||
    (value.observedCliVersion !== null &&
      !isSafeString(value.observedCliVersion, 32)) ||
    (value.observedBinaryHashPrefix !== null &&
      !isHashPrefix(value.observedBinaryHashPrefix)) ||
    (value.observedSchemaFingerprintPrefix !== null &&
      !isHashPrefix(value.observedSchemaFingerprintPrefix)) ||
    value.skillName !== "coding-wife-explain-commit" ||
    (value.skillVersion !== null && !isSafeString(value.skillVersion, 64)) ||
    (value.skillDigestPrefix !== null &&
      !isHashPrefix(value.skillDigestPrefix)) ||
    (value.reasonCode !== null && !isSafeCode(value.reasonCode)) ||
    !isTimestamp(value.checkedAt) ||
    (value.status === "approved" &&
      (value.reasonCode !== null ||
        value.skillVersion === null ||
        value.skillDigestPrefix === null ||
        value.observedCliVersion !== value.approvedCliVersion ||
        value.observedBinaryHashPrefix !== value.approvedBinaryHashPrefix ||
        value.observedSchemaFingerprintPrefix !==
          value.approvedSchemaFingerprintPrefix)) ||
    (value.status !== "approved" && value.reasonCode === null)
  ) {
    return contractError()
  }
  return value as unknown as SupportReleaseReadinessV1
}

function parseCapacity(value: unknown): SupportCapacityV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "maximumActive",
      "maximumQueued",
      "active",
      "queued",
    ]) ||
    value.maximumActive !== supportMaximumActive ||
    value.maximumQueued !== supportMaximumQueued ||
    !isSafeInteger(value.active) ||
    !isSafeInteger(value.queued) ||
    value.active > value.maximumActive ||
    value.queued > value.maximumQueued
  ) {
    return contractError()
  }
  return value as unknown as SupportCapacityV1
}

const usageKeys = [
  "attemptedTasks",
  "startedTasks",
  "succeededTasks",
  "failedTasks",
  "canceledTasks",
  "unavailableTasks",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "totalLatencyMs",
] as const

function parseUsage(value: unknown): SupportUsageCountersV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, usageKeys) ||
    !usageKeys.every((key) => isSafeInteger(value[key])) ||
    Number(value.totalTokens) !==
      Number(value.inputTokens) + Number(value.outputTokens)
  ) {
    return contractError()
  }
  return value as unknown as SupportUsageCountersV1
}

function parseLatestOutcome(value: unknown): SupportLatestOutcomeV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "status",
      "trigger",
      "completedAt",
      "latencyMs",
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "errorCode",
    ]) ||
    !isOutcomeStatus(value.status) ||
    !isTrigger(value.trigger) ||
    !isTimestamp(value.completedAt) ||
    (value.latencyMs !== null && !isSafeInteger(value.latencyMs)) ||
    !isSafeInteger(value.inputTokens) ||
    !isSafeInteger(value.outputTokens) ||
    !isSafeInteger(value.totalTokens) ||
    value.totalTokens !== value.inputTokens + value.outputTokens ||
    (value.errorCode !== null && !isSafeCode(value.errorCode)) ||
    (value.status === "generated" && value.errorCode !== null) ||
    (value.status !== "generated" && value.errorCode === null)
  ) {
    return contractError()
  }
  return value as unknown as SupportLatestOutcomeV1
}

function parseAudit(value: unknown): SupportAuditV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "role",
      "modelFamily",
      "reasoningEffort",
      "permissionProfile",
      "rawTranscriptPersisted",
      "taskTimeoutMs",
      "tokenBudget",
      "fallbackTasks",
      "latestOutcome",
    ]) ||
    value.role !== "commit_explainer" ||
    value.modelFamily !== "gpt-5.6-sol" ||
    value.reasoningEffort !== "low" ||
    value.permissionProfile !== "coding-wife-support-zero" ||
    value.rawTranscriptPersisted !== false ||
    value.taskTimeoutMs !== 15_000 ||
    value.tokenBudget !== 16_000 ||
    !isSafeInteger(value.fallbackTasks)
  ) {
    return contractError()
  }
  return {
    role: "commit_explainer",
    modelFamily: "gpt-5.6-sol",
    reasoningEffort: "low",
    permissionProfile: "coding-wife-support-zero",
    rawTranscriptPersisted: false,
    taskTimeoutMs: 15_000,
    tokenBudget: 16_000,
    fallbackTasks: value.fallbackTasks,
    latestOutcome:
      value.latestOutcome === null
        ? null
        : parseLatestOutcome(value.latestOutcome),
  }
}

function validEffectiveState(
  settings: SupportSettingsV1,
  readiness: SupportReleaseReadinessV1,
  recoveryCode: string | null,
  state: SupportEffectiveState,
  enabled: boolean,
  fallback: string | null,
): boolean {
  if (recoveryCode !== null) {
    return (
      state === "settings_recovery" &&
      !enabled &&
      fallback === recoveryCode &&
      !settings.globalEnabled &&
      !settings.commitExplainerEnabled
    )
  }
  if (!settings.globalEnabled) {
    return (
      state === "user_disabled" &&
      !enabled &&
      fallback === "CODEX-SUPPORT-DISABLED"
    )
  }
  if (!settings.commitExplainerEnabled) {
    return (
      state === "role_disabled" &&
      !enabled &&
      fallback === "CODEX-SUPPORT-COMMIT-EXPLAINER-DISABLED"
    )
  }
  if (readiness.status !== "approved") {
    return (
      state === "release_blocked" &&
      !enabled &&
      fallback === readiness.reasonCode
    )
  }
  return state === "enabled" && enabled && fallback === null
}

export function parseSupportControlSnapshot(
  value: unknown,
): SupportControlSnapshotV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "settings",
      "persistence",
      "recoveryCode",
      "readiness",
      "effectiveState",
      "effectiveEnabled",
      "fallbackReasonCode",
      "capacity",
      "usage",
      "audit",
      "lastErrorCode",
    ]) ||
    value.schemaVersion !== supportControlSchemaVersion ||
    (value.persistence !== "native" && value.persistence !== "demo_memory") ||
    (value.recoveryCode !== null && !isSafeCode(value.recoveryCode)) ||
    !isEffectiveState(value.effectiveState) ||
    typeof value.effectiveEnabled !== "boolean" ||
    (value.fallbackReasonCode !== null &&
      !isSafeCode(value.fallbackReasonCode)) ||
    (value.lastErrorCode !== null && !isSafeCode(value.lastErrorCode))
  ) {
    return contractError()
  }
  const settings = parseSettings(value.settings)
  const readiness = parseReadiness(value.readiness)
  const usage = parseUsage(value.usage)
  const audit = parseAudit(value.audit)
  if (
    !validEffectiveState(
      settings,
      readiness,
      value.recoveryCode,
      value.effectiveState,
      value.effectiveEnabled,
      value.fallbackReasonCode,
    ) ||
    audit.fallbackTasks > usage.unavailableTasks
  ) {
    return contractError()
  }
  return {
    schemaVersion: supportControlSchemaVersion,
    settings,
    persistence: value.persistence,
    recoveryCode: value.recoveryCode,
    readiness,
    effectiveState: value.effectiveState,
    effectiveEnabled: value.effectiveEnabled,
    fallbackReasonCode: value.fallbackReasonCode,
    capacity: parseCapacity(value.capacity),
    usage,
    audit,
    lastErrorCode: value.lastErrorCode,
  }
}

export function parseSupportControlCommandError(
  value: unknown,
): SupportControlCommandErrorEnvelope | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "code",
      "operation",
      "recoverable",
      "userMessageKey",
    ]) ||
    !isSafeCode(value.code) ||
    !isSafeString(value.operation, 96) ||
    typeof value.recoverable !== "boolean" ||
    value.userMessageKey !== "support.error.generic"
  ) {
    return null
  }
  return {
    code: value.code,
    operation: value.operation,
    recoverable: value.recoverable,
    userMessageKey: "support.error.generic",
  }
}
