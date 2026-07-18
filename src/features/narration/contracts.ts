export const narrationSchemaVersion = 1 as const
export const narrationMaxTextScalars = 240

export const narrationCommands = {
  getSettings: "narration_get_settings",
  getRuntime: "narration_get_runtime",
  listVoices: "narration_list_voices",
  updateSettings: "narration_update_settings",
  setMuted: "narration_set_muted",
  resetSettings: "narration_reset_settings",
  setScope: "narration_set_scope",
  speak: "narration_speak",
  cancel: "narration_cancel",
} as const

export type NarrationCommand =
  (typeof narrationCommands)[keyof typeof narrationCommands]
export type NarrationLocale = "ja" | "en"
export type NarrationPlaybackState =
  "idle" | "preparing" | "playing" | "unavailable"
export type NarrationDisposition =
  | "queued"
  | "disabled"
  | "muted"
  | "dropped_duplicate"
  | "dropped_queue_full"
  | "dropped_sequence"
  | "stale"
  | "unavailable"
export type NarrationCancelReason =
  | "explicit_cancel"
  | "mute"
  | "workspace_switch"
  | "turn_stop"
  | "app_close"
  | "reset"
export type NarrationCommitJobTrigger =
  "auto_verified_commit" | "user_request" | "user_retry"

export interface NarrationVoiceSelectionV1 {
  readonly ja: string | null
  readonly en: string | null
}

export interface NarrationSettingsV1 {
  readonly schemaVersion: typeof narrationSchemaVersion
  readonly version: number
  readonly enabled: boolean
  readonly muted: boolean
  readonly voices: NarrationVoiceSelectionV1
  readonly rate: number
}

export interface NarrationRuntimeSnapshotV1 {
  readonly schemaVersion: typeof narrationSchemaVersion
  readonly playbackState: NarrationPlaybackState
  readonly activeRequestId: string | null
  readonly queueDepth: number
  readonly lastErrorCode: string | null
}

export interface NarrationSettingsSnapshotV1 {
  readonly schemaVersion: typeof narrationSchemaVersion
  readonly settings: NarrationSettingsV1
  readonly runtime: NarrationRuntimeSnapshotV1
  readonly loadWarningCode: string | null
}

export interface NarrationVoiceV1 {
  readonly name: string
  readonly locale: string
}

export interface NarrationVoiceListV1 {
  readonly schemaVersion: typeof narrationSchemaVersion
  readonly voices: readonly NarrationVoiceV1[]
}

export interface NarrationSettingsUpdateV1 {
  readonly schemaVersion: typeof narrationSchemaVersion
  readonly expectedVersion: number
  readonly enabled: boolean
  readonly muted: boolean
  readonly voices: NarrationVoiceSelectionV1
  readonly rate: number
}

export interface NarrationMuteRequestV1 {
  readonly schemaVersion: typeof narrationSchemaVersion
  readonly expectedVersion: number
  readonly muted: boolean
}

export interface NarrationScopeRequestV1 {
  readonly schemaVersion: typeof narrationSchemaVersion
  readonly workspaceId: string
  readonly generation: number
}

export interface NarrationSpeakRequestV1 {
  readonly schemaVersion: typeof narrationSchemaVersion
  readonly requestId: string
  readonly workspaceId: string
  readonly generation: number
  readonly sequence: number
  readonly locale: NarrationLocale
  readonly kind: "event" | "commit_explanation" | "test"
  readonly semanticType:
    | "progress"
    | "waiting_for_user"
    | "error"
    | "commit_observed"
    | "commit_explanation"
    | "disconnected"
    | "test"
  readonly priority: "low" | "normal" | "high"
  readonly text: string
}

export interface NarrationSpeakResponseV1 {
  readonly schemaVersion: typeof narrationSchemaVersion
  readonly disposition: NarrationDisposition
  readonly queueDepth: number
  readonly code: string | null
}

export interface NarrationCommandErrorEnvelope {
  readonly code: string
  readonly operation: string
  readonly recoverable: boolean
  readonly userMessageKey: string
  readonly detailRef: string
}

interface CommitNarrationEventBaseV1 {
  readonly schemaVersion: typeof narrationSchemaVersion
  readonly source: "background_support"
  readonly trigger: NarrationCommitJobTrigger
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly commitSha: string
  readonly requestId: string
  readonly locale: NarrationLocale
}

export interface CommitNarrationStartedV1 extends CommitNarrationEventBaseV1 {
  readonly kind: "started"
}

export interface CommitNarrationChunkV1 extends CommitNarrationEventBaseV1 {
  readonly kind: "chunk"
  readonly sequence: number
  readonly text: string
}

export interface CommitNarrationTerminalV1 extends CommitNarrationEventBaseV1 {
  readonly kind: "terminal"
  readonly status: "completed" | "failed" | "canceled"
  readonly errorCode: string | null
}

export type CommitNarrationConsumerEventV1 =
  CommitNarrationStartedV1 | CommitNarrationChunkV1 | CommitNarrationTerminalV1

export interface CommitNarrationSourceKey {
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly commitSha: string
  readonly requestId: string
  readonly locale: NarrationLocale
}

export interface CommitNarrationConsumerPort {
  subscribe(listener: (event: unknown) => void): () => void
}

export class NarrationContractError extends Error {
  public readonly code: string

  public constructor(code = "NARRATION-CONTRACT-INVALID") {
    super(code)
    this.name = "NarrationContractError"
    this.code = code
  }
}

type UnknownRecord = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  )
}

function isSafeString(value: unknown, maximum = 128): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value
  )
}

function isOpaqueId(value: unknown): value is string {
  return isSafeString(value) && /^[A-Za-z0-9][A-Za-z0-9:_-]*$/u.test(value)
}

function isSafeInteger(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= maximum
  )
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isSafeString(value)
}

function isLocale(value: unknown): value is NarrationLocale {
  return value === "ja" || value === "en"
}

function isPlaybackState(value: unknown): value is NarrationPlaybackState {
  return (
    value === "idle" ||
    value === "preparing" ||
    value === "playing" ||
    value === "unavailable"
  )
}

function isDisposition(value: unknown): value is NarrationDisposition {
  return (
    value === "queued" ||
    value === "disabled" ||
    value === "muted" ||
    value === "dropped_duplicate" ||
    value === "dropped_queue_full" ||
    value === "dropped_sequence" ||
    value === "stale" ||
    value === "unavailable"
  )
}

function isCommitJobTrigger(
  value: unknown,
): value is NarrationCommitJobTrigger {
  return (
    value === "auto_verified_commit" ||
    value === "user_request" ||
    value === "user_retry"
  )
}

function isFullCommitSha(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (/^[0-9a-f]{40}$/u.test(value) || /^[0-9a-f]{64}$/u.test(value))
  )
}

const privateTextPatterns = [
  /sk-[a-z0-9_-]{8,}/iu,
  /\bbearer\s+[a-z0-9._~+/-]{12,}=*/iu,
  /\b(?:gh[pousr]_[a-z0-9]{16,}|github_pat_[a-z0-9_]{16,})/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bxox[baprs]-[a-z0-9-]{10,}/iu,
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/iu,
  /(?:^|[^a-z0-9])(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token|cookie|session(?:[_-]?id)?)\s*[:=]\s*["']?\S+/iu,
  /(?:^|[\s([{"'=,:;：、，。！？])\/(?:[^\s/<>"']+\/)+[^\s/<>"']+/u,
] as const

function isRedactedText(value: unknown): value is string {
  if (typeof value !== "string") return false
  const scalarCount = [...value].length
  return (
    scalarCount >= 1 &&
    scalarCount <= narrationMaxTextScalars &&
    value.trim() === value &&
    ![...value].some(
      (character) =>
        character === "\0" ||
        (/\p{Cc}/u.test(character) && character !== "\n" && character !== "\t"),
    ) &&
    !privateTextPatterns.some((pattern) => pattern.test(value))
  )
}

function invalid(code?: string): never {
  throw new NarrationContractError(code)
}

function parseVoices(value: unknown): NarrationVoiceSelectionV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["ja", "en"])) return invalid()
  if (!isNullableString(value.ja) || !isNullableString(value.en))
    return invalid()
  return { ja: value.ja, en: value.en }
}

export function parseNarrationSettings(value: unknown): NarrationSettingsV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "version",
      "enabled",
      "muted",
      "voices",
      "rate",
    ]) ||
    value.schemaVersion !== narrationSchemaVersion ||
    !isSafeInteger(value.version) ||
    typeof value.enabled !== "boolean" ||
    typeof value.muted !== "boolean" ||
    typeof value.rate !== "number" ||
    value.rate < 0.75 ||
    value.rate > 1.25 ||
    Math.abs(value.rate * 20 - Math.round(value.rate * 20)) > 1e-9
  ) {
    return invalid()
  }
  return {
    schemaVersion: narrationSchemaVersion,
    version: value.version,
    enabled: value.enabled,
    muted: value.muted,
    voices: parseVoices(value.voices),
    rate: value.rate,
  }
}

export function parseNarrationRuntime(
  value: unknown,
): NarrationRuntimeSnapshotV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "playbackState",
      "activeRequestId",
      "queueDepth",
      "lastErrorCode",
    ]) ||
    value.schemaVersion !== narrationSchemaVersion ||
    !isPlaybackState(value.playbackState) ||
    !isNullableString(value.activeRequestId) ||
    !isSafeInteger(value.queueDepth, 3) ||
    !isNullableString(value.lastErrorCode)
  ) {
    return invalid()
  }
  return {
    schemaVersion: narrationSchemaVersion,
    playbackState: value.playbackState,
    activeRequestId: value.activeRequestId,
    queueDepth: value.queueDepth,
    lastErrorCode: value.lastErrorCode,
  }
}

export function parseNarrationSettingsSnapshot(
  value: unknown,
): NarrationSettingsSnapshotV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "settings",
      "runtime",
      "loadWarningCode",
    ]) ||
    value.schemaVersion !== narrationSchemaVersion ||
    !isNullableString(value.loadWarningCode)
  ) {
    return invalid()
  }
  return {
    schemaVersion: narrationSchemaVersion,
    settings: parseNarrationSettings(value.settings),
    runtime: parseNarrationRuntime(value.runtime),
    loadWarningCode: value.loadWarningCode,
  }
}

export function parseNarrationVoiceList(value: unknown): NarrationVoiceListV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "voices"]) ||
    value.schemaVersion !== narrationSchemaVersion ||
    !Array.isArray(value.voices) ||
    value.voices.length > 256
  ) {
    return invalid()
  }
  const voices = value.voices.map((voice) => {
    if (
      !isRecord(voice) ||
      !hasExactKeys(voice, ["name", "locale"]) ||
      !isSafeString(voice.name) ||
      !isSafeString(voice.locale) ||
      !(voice.locale === "ja_JP" || /^en_[A-Z]{2}$/u.test(voice.locale))
    ) {
      return invalid()
    }
    return { name: voice.name, locale: voice.locale }
  })
  return { schemaVersion: narrationSchemaVersion, voices }
}

export function parseNarrationSpeakResponse(
  value: unknown,
): NarrationSpeakResponseV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "disposition",
      "queueDepth",
      "code",
    ]) ||
    value.schemaVersion !== narrationSchemaVersion ||
    !isDisposition(value.disposition) ||
    !isSafeInteger(value.queueDepth, 3) ||
    !isNullableString(value.code)
  ) {
    return invalid()
  }
  return {
    schemaVersion: narrationSchemaVersion,
    disposition: value.disposition,
    queueDepth: value.queueDepth,
    code: value.code,
  }
}

export function parseNarrationCommandError(
  value: unknown,
): NarrationCommandErrorEnvelope | null {
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

const commitBaseKeys = [
  "schemaVersion",
  "source",
  "trigger",
  "kind",
  "workspaceId",
  "workspaceGeneration",
  "commitSha",
  "requestId",
  "locale",
] as const

function parseCommitBase(value: UnknownRecord): CommitNarrationEventBaseV1 {
  if (
    value.schemaVersion !== narrationSchemaVersion ||
    value.source !== "background_support" ||
    !isCommitJobTrigger(value.trigger) ||
    !isOpaqueId(value.workspaceId) ||
    !isSafeInteger(value.workspaceGeneration) ||
    !isFullCommitSha(value.commitSha) ||
    !isOpaqueId(value.requestId) ||
    !isLocale(value.locale)
  ) {
    return invalid("NARRATION-PRESENTATION-ENVELOPE")
  }
  return {
    schemaVersion: narrationSchemaVersion,
    source: "background_support",
    trigger: value.trigger,
    workspaceId: value.workspaceId,
    workspaceGeneration: value.workspaceGeneration,
    commitSha: value.commitSha,
    requestId: value.requestId,
    locale: value.locale,
  }
}

export function parseCommitNarrationConsumerEvent(
  value: unknown,
): CommitNarrationConsumerEventV1 {
  if (!isRecord(value)) return invalid("NARRATION-PRESENTATION-ENVELOPE")
  const base = parseCommitBase(value)
  if (value.kind === "started" && hasExactKeys(value, commitBaseKeys)) {
    return { ...base, kind: "started" }
  }
  if (
    value.kind === "chunk" &&
    hasExactKeys(value, [...commitBaseKeys, "sequence", "text"]) &&
    isSafeInteger(value.sequence, 1_023) &&
    isRedactedText(value.text)
  ) {
    return {
      ...base,
      kind: "chunk",
      sequence: value.sequence,
      text: value.text,
    }
  }
  if (
    value.kind === "terminal" &&
    hasExactKeys(value, [...commitBaseKeys, "status", "errorCode"]) &&
    (value.status === "completed" ||
      value.status === "failed" ||
      value.status === "canceled") &&
    isNullableString(value.errorCode)
  ) {
    return {
      ...base,
      kind: "terminal",
      status: value.status,
      errorCode: value.errorCode,
    }
  }
  return invalid("NARRATION-PRESENTATION-ENVELOPE")
}

export function commitNarrationSourceKey(
  value: CommitNarrationSourceKey,
): string {
  return JSON.stringify([
    value.workspaceId,
    value.workspaceGeneration,
    value.commitSha,
    value.requestId,
    value.locale,
  ])
}

export function sourceKeyFromCommitNarrationEvent(
  value: CommitNarrationConsumerEventV1,
): CommitNarrationSourceKey {
  return {
    workspaceId: value.workspaceId,
    workspaceGeneration: value.workspaceGeneration,
    commitSha: value.commitSha,
    requestId: value.requestId,
    locale: value.locale,
  }
}
