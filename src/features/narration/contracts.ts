export const narrationSchemaVersion = 1 as const
export const narrationSettingsSchemaVersion = 2 as const
export const narrationMaxTextScalars = 240
export const presenceDirectionMaxUtteranceScalars = 160
export const presenceDirectionEventChannel =
  "coding-wife://presence-direction" as const
export const presenceDirectionScopeCommand = "presence_set_scope" as const

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
  | "idle"
  | "preparing"
  | "playing"
  | "unavailable"
export type NarrationDisposition =
  | "queued"
  | "disabled"
  | "muted"
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
  | "auto_verified_commit"
  | "user_request"
  | "user_retry"

export type PresenceDirectionTrigger =
  | "decision_wait"
  | "recoverable_failure"
  | "terminal_failure"
  | "long_milestone"
  | "main_message"
  | "commit_ready"
  | "turn_completed"
export type PresenceDirectionCue =
  | "neutral"
  | "working"
  | "asking"
  | "success"
  | "warning"
  | "error"
export type PresenceDirectionPriority = "low" | "normal" | "high"

export const narrationProviders = ["openai"] as const
export type NarrationTtsProvider = (typeof narrationProviders)[number]

export const openAiTtsModels = ["gpt-4o-mini-tts"] as const
export type OpenAiTtsModel = (typeof openAiTtsModels)[number]

export const openAiTtsVoices = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const
export type OpenAiTtsVoice = (typeof openAiTtsVoices)[number]

export type NarrationApiKeyActionV2 =
  | { readonly kind: "keep" }
  | { readonly kind: "replace"; readonly value: string }
  | { readonly kind: "clear" }

export interface NarrationSettingsV2 {
  readonly schemaVersion: typeof narrationSettingsSchemaVersion
  readonly version: number
  readonly enabled: boolean
  readonly muted: boolean
  readonly provider: NarrationTtsProvider | null
  readonly apiKeyConfigured: boolean
  readonly model: OpenAiTtsModel
  readonly voice: OpenAiTtsVoice
  readonly speed: number
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
  readonly settings: NarrationSettingsV2
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

export interface NarrationSettingsUpdateV2 {
  readonly schemaVersion: typeof narrationSettingsSchemaVersion
  readonly expectedVersion: number
  readonly enabled: boolean
  readonly muted: boolean
  readonly provider: NarrationTtsProvider | null
  readonly apiKeyAction: NarrationApiKeyActionV2
  readonly model: OpenAiTtsModel
  readonly voice: OpenAiTtsVoice
  readonly speed: number
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
  | CommitNarrationStartedV1
  | CommitNarrationChunkV1
  | CommitNarrationTerminalV1

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

export interface PresenceDirectionEventV1 {
  readonly schemaVersion: typeof narrationSchemaVersion
  readonly requestId: string
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly sourceEventId: string
  readonly decisionId: string | null
  readonly trigger: PresenceDirectionTrigger
  readonly locale: NarrationLocale
  readonly utterance: string
  readonly cue: PresenceDirectionCue
  readonly priority: PresenceDirectionPriority
  readonly modelRole: "presence_director"
  readonly model: "gpt-5.6-luna"
  readonly occurredAt: string
}

export interface PresenceDirectionScopeRequestV1 {
  readonly schemaVersion: typeof narrationSchemaVersion
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly locale: NarrationLocale
}

export interface PresenceDirectionConsumerPort {
  subscribe(listener: (event: unknown) => void): () => void
  setScope?(request: PresenceDirectionScopeRequestV1): Promise<void>
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

function isPresenceDirectionTrigger(
  value: unknown,
): value is PresenceDirectionTrigger {
  return (
    value === "decision_wait" ||
    value === "recoverable_failure" ||
    value === "terminal_failure" ||
    value === "long_milestone" ||
    value === "main_message" ||
    value === "commit_ready" ||
    value === "turn_completed"
  )
}

function isPresenceDirectionCue(value: unknown): value is PresenceDirectionCue {
  return (
    value === "neutral" ||
    value === "working" ||
    value === "asking" ||
    value === "success" ||
    value === "warning" ||
    value === "error"
  )
}

function isPresenceDirectionPriority(
  value: unknown,
): value is PresenceDirectionPriority {
  return value === "low" || value === "normal" || value === "high"
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
] as const

const presenceDirectionBareFilenamePattern =
  /(?:^|[^A-Za-z0-9._@+-])(?:Dockerfile|Makefile|\.[A-Za-z][A-Za-z0-9_-]*|[A-Za-z0-9][A-Za-z0-9._@+-]*\.(?:bash|c|cc|conf|config|cpp|css|csv|env|fish|go|graphql|h|hpp|html?|ini|java|js|json|jsonl|jsx|key|kt|kts|less|lock|log|markdown|md|pem|php|proto|py|rb|rs|sass|scss|sh|sql|swift|toml|ts|tsv|tsx|txt|xml|ya?ml|zsh))(?=$|[^A-Za-z0-9_])/iu

const presenceDirectionCodeOrDiffPatterns = [
  /```|~~~/u,
  /(?:^| )diff --git(?: |$)/iu,
  /(?:^| )index [a-f0-9]+\.\.[a-f0-9]+(?: |$)/iu,
  /(?:^| )@@(?: |[-+]\d)/u,
  /(?:^| )(?:---|\+\+\+)(?: |$)/u,
  /(?:^|[^\p{L}\p{N}_])(?:fn|function)\s+[\p{L}_][\p{L}\p{N}_]*\s*\([^)]*\)\s*\{/iu,
  /(?:^|[^\p{L}\p{N}_])(?:const|let|var)\s+(?:mut\s+)?[\p{L}_][\p{L}\p{N}_]*\s*=/iu,
  /(?:^|[^\p{L}\p{N}_])(?:class|enum|impl|interface|struct)\s+[\p{L}_][\p{L}\p{N}_]*\s*(?:\{|<)/iu,
  /(?:^|[^\p{L}\p{N}_])[\p{L}_][\p{L}\p{N}_]*\s*\([^)]*\)\s*=>/u,
  /(?:^|[^\p{L}\p{N}_])console\.log\s*\(/iu,
  /(?:^|[^\p{L}\p{N}_])[\p{L}_][\p{L}\p{N}_.]*\s*\([^)]*\)\s*(?:[;{}])/u,
  /(?:^| )[+-](?:return\b|\s*(?:class|const|fn|function|let|var)\b|\s*[{}])/iu,
  /\{[^{}]*:[^{}]*\}/u,
  /<\/?[A-Za-z][^>]*>/u,
] as const

const presenceDirectionOpaqueTokenPattern =
  /\b(?:[a-f0-9]{32,}|[a-z0-9_+=-]{40,})\b/iu

const unicodeWhitespacePattern = /^\p{White_Space}$/u
const unicodePathBoundaryPattern = /^(?:\p{White_Space}|\p{P}|\p{S})$/u

function matchesAsciiCaseInsensitive(
  characters: readonly string[],
  start: number,
  expected: string,
): boolean {
  for (let offset = 0; offset < expected.length; offset += 1) {
    const character = characters[start + offset]
    if (
      character === undefined ||
      character.length !== 1 ||
      character.toLowerCase() !== expected[offset]
    ) {
      return false
    }
  }
  return true
}

function publicUrlSchemeLength(
  characters: readonly string[],
  start: number,
): number | null {
  if (matchesAsciiCaseInsensitive(characters, start, "https://")) return 8
  if (matchesAsciiCaseInsensitive(characters, start, "http://")) return 7
  return null
}

function matchingUrlQuoteTerminator(
  previous: string | undefined,
): string | null {
  switch (previous) {
    case '"':
    case "'":
    case "`":
      return previous
    case "“":
      return "”"
    case "‘":
      return "’"
    case "«":
      return "»"
    case "「":
      return "」"
    case "『":
      return "』"
    default:
      return null
  }
}

function isUrlWrapperTerminator(character: string): boolean {
  return (
    character === '"' ||
    character === "`" ||
    character === "<" ||
    character === ">" ||
    character === "）" ||
    character === "】" ||
    character === "〉" ||
    character === "》" ||
    character === "」" ||
    character === "』" ||
    character === "”" ||
    character === "’" ||
    character === "»"
  )
}

function publicUrlCandidateEnd(
  characters: readonly string[],
  start: number,
): number {
  const quoteTerminator = matchingUrlQuoteTerminator(characters[start - 1])
  let parentheses = 0
  let brackets = 0
  let braces = 0
  for (let cursor = start; cursor < characters.length; cursor += 1) {
    const character = characters[cursor]
    if (character === undefined || unicodeWhitespacePattern.test(character)) {
      return cursor
    }
    if (
      cursor > start &&
      ((quoteTerminator !== null && character === quoteTerminator) ||
        isUrlWrapperTerminator(character))
    ) {
      return cursor
    }
    if (character === "(") parentheses += 1
    else if (character === ")") {
      if (parentheses === 0) return cursor
      parentheses -= 1
    } else if (character === "[") brackets += 1
    else if (character === "]") {
      if (brackets === 0) return cursor
      brackets -= 1
    } else if (character === "{") braces += 1
    else if (character === "}") {
      if (braces === 0) return cursor
      braces -= 1
    }
  }
  return characters.length
}

function rawUrlAuthority(candidate: string, schemeLength: number): string {
  const authorityEnd = candidate.slice(schemeLength).search(/[/?#]/u)
  const end =
    authorityEnd === -1 ? candidate.length : schemeLength + authorityEnd
  return candidate.slice(schemeLength, end)
}

function isAsciiDnsAlphanumeric(character: string | undefined): boolean {
  if (character === undefined) return false
  const codePoint = character.codePointAt(0)
  return (
    codePoint !== undefined &&
    ((codePoint >= 0x30 && codePoint <= 0x39) ||
      (codePoint >= 0x41 && codePoint <= 0x5a) ||
      (codePoint >= 0x61 && codePoint <= 0x7a))
  )
}

function isValidPublicHostname(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true
  const domain = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname
  if (domain.length === 0 || domain.length > 253) return false
  return domain.split(".").every((label) => {
    return (
      label.length >= 1 &&
      label.length <= 63 &&
      isAsciiDnsAlphanumeric(label[0]) &&
      isAsciiDnsAlphanumeric(label[label.length - 1]) &&
      [...label].every(
        (character) => isAsciiDnsAlphanumeric(character) || character === "-",
      )
    )
  })
}

function isPublicUrlCandidate(
  candidate: string,
  schemeLength: number,
): boolean {
  try {
    const parsed = new URL(candidate)
    const rawAuthority = rawUrlAuthority(candidate, schemeLength)
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      rawAuthority.length > 0 &&
      !rawAuthority.includes("@") &&
      parsed.hostname.length > 0 &&
      isValidPublicHostname(parsed.hostname) &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    )
  } catch {
    return false
  }
}

interface PublicUrlCandidateSpan {
  readonly end: number
  readonly safe: boolean
}

function publicUrlCandidateSpan(
  characters: readonly string[],
  start: number,
): PublicUrlCandidateSpan | null {
  const previous = characters[start - 1]
  if (
    start !== 0 &&
    (previous === undefined || !unicodePathBoundaryPattern.test(previous))
  ) {
    return null
  }

  const schemeLength = publicUrlSchemeLength(characters, start)
  if (schemeLength === null) return null

  const end = publicUrlCandidateEnd(characters, start)
  const candidate = characters.slice(start, end).join("")
  return {
    end,
    safe: isPublicUrlCandidate(candidate, schemeLength),
  }
}

function findPublicUrlMask(characters: readonly string[]): readonly boolean[] {
  const mask = Array<boolean>(characters.length).fill(false)
  let cursor = 0
  while (cursor < characters.length) {
    const candidate = publicUrlCandidateSpan(characters, cursor)
    if (candidate === null) {
      cursor += 1
      continue
    }
    if (candidate.safe) {
      for (let index = cursor; index < candidate.end; index += 1) {
        mask[index] = true
      }
    }
    cursor = candidate.end
  }
  return mask
}

function containsPrivateAbsolutePath(characters: readonly string[]): boolean {
  const publicUrlMask = findPublicUrlMask(characters)
  return characters.some((character, index) => {
    if (character !== "/" || publicUrlMask[index]) return false
    const next = characters[index + 1]
    if (next === undefined || unicodeWhitespacePattern.test(next)) return false
    const previous = characters[index - 1]
    return (
      index === 0 ||
      (previous !== undefined && unicodePathBoundaryPattern.test(previous))
    )
  })
}

function isRedactedText(value: unknown): value is string {
  if (typeof value !== "string") return false
  const characters: string[] = []
  for (const character of value) {
    characters.push(character)
    if (characters.length > narrationMaxTextScalars) return false
  }
  const scalarCount = characters.length
  return (
    scalarCount >= 1 &&
    scalarCount <= narrationMaxTextScalars &&
    value.trim() === value &&
    !characters.some(
      (character) =>
        character === "\0" ||
        (/\p{Cc}/u.test(character) && character !== "\n" && character !== "\t"),
    ) &&
    !privateTextPatterns.some((pattern) => pattern.test(value)) &&
    !containsPrivateAbsolutePath(characters)
  )
}

const presenceCueAllowlist: Readonly<
  Record<PresenceDirectionTrigger, readonly PresenceDirectionCue[]>
> = {
  decision_wait: ["asking", "neutral"],
  recoverable_failure: ["warning", "neutral"],
  terminal_failure: ["error", "warning", "neutral"],
  long_milestone: ["working", "neutral"],
  main_message: ["working", "neutral"],
  commit_ready: ["success", "neutral"],
  turn_completed: ["success", "neutral"],
}

const presencePriorityByTrigger: Readonly<
  Record<PresenceDirectionTrigger, PresenceDirectionPriority>
> = {
  decision_wait: "high",
  recoverable_failure: "high",
  terminal_failure: "high",
  long_milestone: "low",
  main_message: "normal",
  commit_ready: "normal",
  turn_completed: "normal",
}

function hasSingleSpaceCanonicalWhitespace(
  characters: readonly string[],
): boolean {
  let previousWasSpace = false
  for (const character of characters) {
    if (!unicodeWhitespacePattern.test(character)) {
      previousWasSpace = false
      continue
    }
    if (character !== " " || previousWasSpace) return false
    previousWasSpace = true
  }
  return true
}

function isPresenceDirectionUtterance(value: unknown): value is string {
  if (typeof value !== "string") return false
  const characters: string[] = []
  for (const character of value) {
    characters.push(character)
    if (characters.length > presenceDirectionMaxUtteranceScalars) return false
  }
  return (
    characters.length >= 1 &&
    value.trim() === value &&
    hasSingleSpaceCanonicalWhitespace(characters) &&
    !characters.some(
      (character) =>
        /\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u.test(character) ||
        character === "/" ||
        character === "\\",
    ) &&
    !privateTextPatterns.some((pattern) => pattern.test(value)) &&
    !/(?:https?|file|ftp):|www\./iu.test(value) &&
    !value.includes("<external>") &&
    !/\[redacted\]/iu.test(value) &&
    !presenceDirectionBareFilenamePattern.test(value) &&
    !presenceDirectionCodeOrDiffPatterns.some((pattern) =>
      pattern.test(value),
    ) &&
    !presenceDirectionOpaqueTokenPattern.test(value)
  )
}

function isRfc3339Timestamp(value: unknown): value is string {
  return (
    isSafeString(value, 64) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  )
}

function invalid(code?: string): never {
  throw new NarrationContractError(code)
}

export function parseNarrationSettings(value: unknown): NarrationSettingsV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "version",
      "enabled",
      "muted",
      "provider",
      "apiKeyConfigured",
      "model",
      "voice",
      "speed",
    ]) ||
    value.schemaVersion !== narrationSettingsSchemaVersion ||
    !isSafeInteger(value.version) ||
    typeof value.enabled !== "boolean" ||
    typeof value.muted !== "boolean" ||
    !(value.provider === null || value.provider === "openai") ||
    typeof value.apiKeyConfigured !== "boolean" ||
    !openAiTtsModels.includes(value.model as OpenAiTtsModel) ||
    !openAiTtsVoices.includes(value.voice as OpenAiTtsVoice) ||
    typeof value.speed !== "number" ||
    value.speed < 0.75 ||
    value.speed > 1.25 ||
    Math.abs(value.speed * 20 - Math.round(value.speed * 20)) > 1e-9 ||
    (value.provider !== null && !value.apiKeyConfigured) ||
    (value.enabled && (!value.apiKeyConfigured || value.provider !== "openai"))
  ) {
    return invalid()
  }
  return {
    schemaVersion: narrationSettingsSchemaVersion,
    version: value.version,
    enabled: value.enabled,
    muted: value.muted,
    provider: value.provider,
    apiKeyConfigured: value.apiKeyConfigured,
    model: value.model as OpenAiTtsModel,
    voice: value.voice as OpenAiTtsVoice,
    speed: value.speed,
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
      !openAiTtsVoices.includes(voice.name as OpenAiTtsVoice) ||
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

const presenceDirectionEventKeys = [
  "schemaVersion",
  "requestId",
  "workspaceId",
  "workspaceGeneration",
  "sourceEventId",
  "decisionId",
  "trigger",
  "locale",
  "utterance",
  "cue",
  "priority",
  "modelRole",
  "model",
  "occurredAt",
] as const

export function parsePresenceDirectionEvent(
  value: unknown,
): PresenceDirectionEventV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, presenceDirectionEventKeys) ||
    value.schemaVersion !== narrationSchemaVersion ||
    !isOpaqueId(value.requestId) ||
    !isOpaqueId(value.workspaceId) ||
    !isSafeInteger(value.workspaceGeneration) ||
    value.workspaceGeneration < 1 ||
    !isOpaqueId(value.sourceEventId) ||
    !isPresenceDirectionTrigger(value.trigger) ||
    (value.trigger === "decision_wait"
      ? !isOpaqueId(value.decisionId)
      : value.decisionId !== null) ||
    !isLocale(value.locale) ||
    !isPresenceDirectionUtterance(value.utterance) ||
    !isPresenceDirectionCue(value.cue) ||
    !presenceCueAllowlist[value.trigger].includes(value.cue) ||
    !isPresenceDirectionPriority(value.priority) ||
    value.priority !== presencePriorityByTrigger[value.trigger] ||
    value.modelRole !== "presence_director" ||
    value.model !== "gpt-5.6-luna" ||
    !isRfc3339Timestamp(value.occurredAt)
  ) {
    return invalid("PRESENCE-DIRECTION-ENVELOPE")
  }
  return {
    schemaVersion: narrationSchemaVersion,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    workspaceGeneration: value.workspaceGeneration,
    sourceEventId: value.sourceEventId,
    decisionId: value.decisionId as string | null,
    trigger: value.trigger,
    locale: value.locale,
    utterance: value.utterance,
    cue: value.cue,
    priority: value.priority,
    modelRole: "presence_director",
    model: "gpt-5.6-luna",
    occurredAt: value.occurredAt,
  }
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
