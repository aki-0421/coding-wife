import {
  type CommitNarrationConsumerEventV1,
  type CommitNarrationConsumerPort,
  type CommitNarrationSourceKey,
  commitNarrationSourceKey,
  type NarrationCancelReason,
  type NarrationCommitJobTrigger,
  NarrationContractError,
  type NarrationLocale,
  type NarrationRuntimeSnapshotV1,
  type NarrationSettingsSnapshotV1,
  type NarrationSettingsUpdateV2,
  type NarrationVoiceV1,
  narrationSchemaVersion,
  narrationSettingsSchemaVersion,
  type PresenceDirectionConsumerPort,
  type PresenceDirectionCue,
  type PresenceDirectionEventV1,
  type PresenceDirectionPriority,
  type PresenceDirectionScopeRequestV1,
  type PresenceDirectionTrigger,
  parseCommitNarrationConsumerEvent,
  parseNarrationSettings,
  parsePresenceDirectionEvent,
  sourceKeyFromCommitNarrationEvent,
} from "@/features/narration/contracts"
import {
  NarrationBoundaryError,
  type NarrationGateway,
} from "@/features/narration/transport"

type Listener = () => void
type Wait = (milliseconds: number) => Promise<void>

export type NarrationLoadStatus =
  | "idle"
  | "loading"
  | "ready"
  | "saving"
  | "error"
export type NarrationVoiceStatus = "idle" | "loading" | "ready" | "error"
export type CommitNarrationPresentationStatus =
  | "preparing"
  | "streaming"
  | "ready"
  | "canceled"
  | "unavailable"
export type NarrationSpeechStatus =
  | "off"
  | "muted"
  | "idle"
  | "queued"
  | "playing"
  | "unavailable"

export interface NarrationScope {
  readonly workspaceId: string
  readonly generation: number
  readonly locale?: NarrationLocale
}

export interface CaptionVisibilityAcknowledgment {
  readonly key: CommitNarrationSourceKey
  readonly presentationGeneration: number
  readonly sequence: number
}

export interface TestCaptionVisibilityAcknowledgment {
  readonly testGeneration: number
}

export interface PresenceCaptionVisibilityAcknowledgment {
  readonly requestId: string
  readonly presentationGeneration: number
}

export interface CommitNarrationPresentationSnapshot {
  readonly key: CommitNarrationSourceKey
  readonly trigger: NarrationCommitJobTrigger
  readonly presentationGeneration: number
  readonly status: CommitNarrationPresentationStatus
  readonly chunks: readonly string[]
  readonly lastSequence: number | null
  readonly speechStatus: NarrationSpeechStatus
  readonly errorCode: string | null
}

export interface NarrationTestSnapshot {
  readonly status: "idle" | "preparing" | "playing" | "unavailable"
  readonly generation: number
  readonly text: string | null
  readonly errorCode: string | null
}

export interface PresenceDirectionPresentationSnapshot {
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
  readonly occurredAt: string
  readonly presentationGeneration: number
  readonly speechStatus: NarrationSpeechStatus
  readonly errorCode: string | null
}

export interface NarrationControllerSnapshot {
  readonly settingsStatus: NarrationLoadStatus
  readonly voiceStatus: NarrationVoiceStatus
  readonly settingsSnapshot: NarrationSettingsSnapshotV1 | null
  readonly voices: readonly NarrationVoiceV1[]
  readonly scope: NarrationScope | null
  readonly presentation: CommitNarrationPresentationSnapshot | null
  readonly presence: PresenceDirectionPresentationSnapshot | null
  readonly latestPresenceRequestId: string | null
  readonly test: NarrationTestSnapshot
  readonly lastErrorCode: string | null
}

interface PreparedCommitNarration {
  readonly key: CommitNarrationSourceKey
  readonly trigger: NarrationCommitJobTrigger
  status: "preparing" | "streaming" | "ready" | "failed" | "canceled"
  chunks: string[]
  errorCode: string | null
  touchedAt: number
}

type CaptionSpeechSequenceState =
  | "waiting"
  | "leading"
  | "scheduled"
  | "skipped"

interface CaptionSpeechGate {
  readonly key: CommitNarrationSourceKey
  readonly presentationGeneration: number
  readonly sequences: Map<number, CaptionSpeechSequenceState>
  readonly leads: Map<number, Promise<void>>
  nextReleaseSequence: number
  draining: boolean
  terminal: boolean
  readonly acknowledgmentTimers: Map<number, ReturnType<typeof setTimeout>>
}

interface TestCaptionGate {
  readonly generation: number
  readonly resolve: (visible: boolean) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface PresenceCaptionGate {
  readonly requestId: string
  readonly presentationGeneration: number
  state: "waiting" | "leading" | "scheduled" | "terminal"
  acknowledgmentTimer: ReturnType<typeof setTimeout> | null
}

interface PendingPresenceScopeSync {
  readonly epoch: number
  readonly request: PresenceDirectionScopeRequestV1
  readonly source: PresenceDirectionConsumerPort
}

const maximumPreparedPresentations = 12
const speechPollMilliseconds = 125
const speechTimeoutMilliseconds = 50_000
const testSpeechTimeoutMilliseconds = speechTimeoutMilliseconds
const captionAcknowledgmentTimeoutMilliseconds = 1_000
const captionSpeechLeadMilliseconds = 100
const maximumPresenceDedupeEntries = 64

function initialSnapshot(): NarrationControllerSnapshot {
  return {
    settingsStatus: "idle",
    voiceStatus: "idle",
    settingsSnapshot: null,
    voices: [],
    scope: null,
    presentation: null,
    presence: null,
    latestPresenceRequestId: null,
    test: { status: "idle", generation: 0, text: null, errorCode: null },
    lastErrorCode: null,
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function errorCode(error: unknown): string {
  if (
    error instanceof NarrationBoundaryError ||
    error instanceof NarrationContractError
  ) {
    return error.code
  }
  return "NARRATION-UNAVAILABLE"
}

function presentationStatus(
  status: PreparedCommitNarration["status"],
): CommitNarrationPresentationStatus {
  if (status === "failed") return "unavailable"
  return status
}

export function isActiveCommitNarrationPresentation(
  presentation: CommitNarrationPresentationSnapshot | null,
): boolean {
  return (
    presentation?.status === "preparing" ||
    presentation?.status === "streaming" ||
    presentation?.status === "ready"
  )
}

function sameSourceKey(
  left: CommitNarrationSourceKey,
  right: CommitNarrationSourceKey,
): boolean {
  return commitNarrationSourceKey(left) === commitNarrationSourceKey(right)
}

function presencePriority(trigger: PresenceDirectionTrigger): number {
  switch (trigger) {
    case "decision_wait":
      return 7
    case "terminal_failure":
      return 6
    case "recoverable_failure":
      return 5
    case "main_message":
      return 4
    case "commit_ready":
      return 3
    case "turn_completed":
      return 2
    case "long_milestone":
      return 1
  }
}

function presenceHoldsPriority(
  presence: PresenceDirectionPresentationSnapshot,
): boolean {
  return (
    presence.trigger === "decision_wait" ||
    presence.speechStatus === "queued" ||
    presence.speechStatus === "playing"
  )
}

function presenceSemanticType(
  trigger: PresenceDirectionTrigger,
): "progress" | "waiting_for_user" | "error" | "commit_observed" {
  switch (trigger) {
    case "decision_wait":
      return "waiting_for_user"
    case "recoverable_failure":
    case "terminal_failure":
      return "error"
    case "commit_ready":
      return "commit_observed"
    case "main_message":
    case "long_milestone":
    case "turn_completed":
      return "progress"
  }
}

function presenceDedupeKeys(
  event: PresenceDirectionEventV1,
): readonly string[] {
  const scope = [event.workspaceId, event.workspaceGeneration]
  return [
    JSON.stringify([...scope, "request", event.requestId]),
    JSON.stringify([...scope, "source", event.sourceEventId]),
  ]
}

export class NarrationController {
  readonly #listeners = new Set<Listener>()
  readonly #prepared = new Map<string, PreparedCommitNarration>()
  readonly #scopeGenerationHighWater = new Map<string, number>()
  #snapshot = initialSnapshot()
  #initialization: Promise<void> | null = null
  #sourceDisconnect: (() => void) | null = null
  #presenceSourceDisconnect: (() => void) | null = null
  #presenceSource: PresenceDirectionConsumerPort | null = null
  #scopeEpoch = 0
  #scopeWriteChain: Promise<void> = Promise.resolve()
  #presenceScopeDesired: PendingPresenceScopeSync | null = null
  #presenceScopeDrain: Promise<void> | null = null
  #presentationGeneration = 0
  #speechEpoch = 0
  #speechChain: Promise<void> = Promise.resolve()
  #presenceCancellation: Promise<void> = Promise.resolve()
  #captionSpeechGate: CaptionSpeechGate | null = null
  #testCaptionGate: TestCaptionGate | null = null
  #presenceCaptionGate: PresenceCaptionGate | null = null
  readonly #presenceDedupe = new Set<string>()
  readonly #presenceDedupeOrder: string[] = []
  #testSequence = 0

  public constructor(
    public readonly gateway: NarrationGateway,
    private readonly pause: Wait = wait,
  ) {}

  public readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  public getSnapshot = (): NarrationControllerSnapshot => this.#snapshot

  public connect(source: CommitNarrationConsumerPort | null): () => void {
    this.#sourceDisconnect?.()
    this.#sourceDisconnect =
      source?.subscribe((event) => this.consume(event)) ?? null
    return () => {
      this.#sourceDisconnect?.()
      this.#sourceDisconnect = null
    }
  }

  public connectPresence(
    source: PresenceDirectionConsumerPort | null,
  ): () => void {
    this.#presenceSourceDisconnect?.()
    this.#presenceSource = source
    const disconnect =
      source?.subscribe((event) => this.consumePresence(event)) ?? null
    this.#presenceSourceDisconnect = disconnect
    this.syncPresenceScope(this.#snapshot.scope)
    return () => {
      if (
        this.#presenceSourceDisconnect !== disconnect ||
        this.#presenceSource !== source
      ) {
        return
      }
      disconnect?.()
      this.#presenceSourceDisconnect = null
      this.#presenceSource = null
      if (this.#presenceScopeDesired?.source === source) {
        this.#presenceScopeDesired = null
      }
    }
  }

  public initialize(): Promise<void> {
    if (this.#initialization !== null) return this.#initialization
    this.update({
      settingsStatus: "loading",
      voiceStatus: "loading",
      lastErrorCode: null,
    })
    this.#initialization = Promise.allSettled([
      this.gateway.getSettings(),
      this.gateway.listVoices(),
    ]).then(([settings, voices]) => {
      const settingsSnapshot =
        settings.status === "fulfilled" ? settings.value : null
      const availableVoices =
        voices.status === "fulfilled"
          ? voices.value.voices
          : this.#snapshot.voices
      const failure =
        settings.status === "rejected"
          ? errorCode(settings.reason)
          : voices.status === "rejected"
            ? errorCode(voices.reason)
            : null
      this.update({
        settingsStatus: settingsSnapshot === null ? "error" : "ready",
        voiceStatus: voices.status === "fulfilled" ? "ready" : "error",
        settingsSnapshot,
        voices: availableVoices,
        lastErrorCode: failure ?? settingsSnapshot?.loadWarningCode ?? null,
      })
    })
    return this.#initialization
  }

  public async refresh(): Promise<void> {
    this.#initialization = null
    await this.initialize()
  }

  public async refreshVoices(): Promise<boolean> {
    const settingsError =
      this.#snapshot.settingsStatus === "error"
        ? this.#snapshot.lastErrorCode
        : null
    this.update({ voiceStatus: "loading", lastErrorCode: settingsError })
    try {
      const voices = await this.gateway.listVoices()
      this.update({
        voiceStatus: "ready",
        voices: voices.voices,
        lastErrorCode:
          settingsError ??
          this.#snapshot.settingsSnapshot?.loadWarningCode ??
          null,
      })
      return true
    } catch (error) {
      this.update({
        voiceStatus: "error",
        lastErrorCode: errorCode(error),
      })
      return false
    }
  }

  public async saveSettings(
    input: Omit<NarrationSettingsUpdateV2, "schemaVersion" | "expectedVersion">,
  ): Promise<boolean> {
    const current = this.#snapshot.settingsSnapshot
    if (current === null) return false
    const validationError = this.validateSettingsInput(
      input,
      current.settings.version,
    )
    if (validationError !== null) {
      this.update({ settingsStatus: "error", lastErrorCode: validationError })
      return false
    }
    this.update({ settingsStatus: "saving", lastErrorCode: null })
    try {
      const settingsSnapshot = await this.gateway.updateSettings({
        schemaVersion: narrationSettingsSchemaVersion,
        expectedVersion: current.settings.version,
        ...input,
      })
      this.update({ settingsStatus: "ready", settingsSnapshot })
      if (
        !settingsSnapshot.settings.enabled ||
        settingsSnapshot.settings.muted
      ) {
        await this.cancelSpeech(
          settingsSnapshot.settings.muted ? "mute" : "explicit_cancel",
        )
      }
      return true
    } catch (error) {
      this.update({
        settingsStatus: "error",
        lastErrorCode: errorCode(error),
      })
      return false
    }
  }

  public async setMuted(muted: boolean): Promise<boolean> {
    const current = this.#snapshot.settingsSnapshot
    if (current === null) return false
    this.update({ settingsStatus: "saving", lastErrorCode: null })
    try {
      const settingsSnapshot = await this.gateway.setMuted({
        schemaVersion: narrationSchemaVersion,
        expectedVersion: current.settings.version,
        muted,
      })
      this.update({ settingsStatus: "ready", settingsSnapshot })
      if (muted) await this.cancelSpeech("mute")
      return true
    } catch (error) {
      this.update({
        settingsStatus: "error",
        lastErrorCode: errorCode(error),
      })
      return false
    }
  }

  public async resetSettings(): Promise<boolean> {
    const current = this.#snapshot.settingsSnapshot
    if (current === null) return false
    this.update({ settingsStatus: "saving", lastErrorCode: null })
    try {
      const settingsSnapshot = await this.gateway.resetSettings(
        current.settings.version,
      )
      await this.cancelSpeech("reset")
      this.update({ settingsStatus: "ready", settingsSnapshot })
      return true
    } catch (error) {
      this.update({
        settingsStatus: "error",
        lastErrorCode: errorCode(error),
      })
      return false
    }
  }

  public setScope(scope: NarrationScope): Promise<boolean> {
    const highestGeneration = this.#scopeGenerationHighWater.get(
      scope.workspaceId,
    )
    if (
      highestGeneration !== undefined &&
      scope.generation < highestGeneration
    ) {
      this.update({ lastErrorCode: "NARRATION-SCOPE-ROLLBACK" })
      return Promise.resolve(false)
    }
    this.#scopeGenerationHighWater.set(scope.workspaceId, scope.generation)
    const epoch = ++this.#scopeEpoch
    const intent: NarrationScope = {
      workspaceId: scope.workspaceId,
      generation: scope.generation,
      ...(scope.locale === undefined ? {} : { locale: scope.locale }),
    }
    const operation = this.#scopeWriteChain.then(() =>
      this.applyScope(intent, epoch),
    )
    this.#scopeWriteChain = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation.catch((error: unknown) => {
      if (epoch === this.#scopeEpoch) {
        this.update({ lastErrorCode: errorCode(error) })
      }
      return false
    })
  }

  public consume(value: unknown): boolean {
    let event: CommitNarrationConsumerEventV1
    try {
      event = parseCommitNarrationConsumerEvent(value)
    } catch (error) {
      this.failActivePresentation(errorCode(error))
      return false
    }
    const key = sourceKeyFromCommitNarrationEvent(event)
    const scope = this.#snapshot.scope
    if (
      scope !== null &&
      event.workspaceId === scope.workspaceId &&
      event.workspaceGeneration < scope.generation
    ) {
      return false
    }
    const id = commitNarrationSourceKey(key)
    const existing = this.#prepared.get(id)
    if (event.kind === "started") {
      if (existing !== undefined) {
        if (existing.trigger !== event.trigger || existing.chunks.length > 0) {
          this.failPrepared(existing, "NARRATION-PRESENTATION-SEQUENCE")
          return false
        }
        return true
      }
      this.#prepared.set(id, {
        key,
        trigger: event.trigger,
        status: "preparing",
        chunks: [],
        errorCode: null,
        touchedAt: Date.now(),
      })
      this.trimPrepared()
      return true
    }
    if (existing === undefined || existing.trigger !== event.trigger) {
      this.failActivePresentation("NARRATION-PRESENTATION-SEQUENCE")
      return false
    }
    if (existing.status === "canceled") return false
    existing.touchedAt = Date.now()
    if (event.kind === "chunk") {
      if (
        existing.status === "ready" ||
        existing.status === "failed" ||
        event.sequence !== existing.chunks.length
      ) {
        this.failPrepared(existing, "NARRATION-PRESENTATION-SEQUENCE")
        return false
      }
      existing.chunks = [...existing.chunks, event.text]
      existing.status = "streaming"
      if (this.activeMatches(existing.key)) {
        this.publishActive(existing)
        this.prepareCaptionSpeech()
      }
      return true
    }
    existing.status =
      event.status === "completed"
        ? existing.chunks.length > 0
          ? "ready"
          : "failed"
        : event.status
    existing.errorCode =
      event.status === "completed" && existing.chunks.length === 0
        ? "NARRATION-PRESENTATION-EMPTY"
        : event.errorCode
    if (this.activeMatches(existing.key)) {
      this.publishActive(existing)
      if (existing.status !== "ready") {
        void this.terminalizeCaptionSpeech()
        void this.cancelSpeech("explicit_cancel")
      }
    }
    return true
  }

  public consumePresence(value: unknown): boolean {
    let event: PresenceDirectionEventV1
    try {
      event = parsePresenceDirectionEvent(value)
    } catch {
      return false
    }

    const scope = this.#snapshot.scope
    const highestGeneration = this.#scopeGenerationHighWater.get(
      event.workspaceId,
    )
    if (
      scope === null ||
      scope.locale === undefined ||
      event.workspaceId !== scope.workspaceId ||
      event.workspaceGeneration !== scope.generation ||
      event.locale !== scope.locale ||
      (highestGeneration !== undefined &&
        event.workspaceGeneration < highestGeneration) ||
      isActiveCommitNarrationPresentation(this.#snapshot.presentation)
    ) {
      return false
    }

    const dedupeKeys = presenceDedupeKeys(event)
    if (dedupeKeys.some((key) => this.#presenceDedupe.has(key))) return false

    const active = this.#snapshot.presence
    if (
      active !== null &&
      presenceHoldsPriority(active) &&
      presencePriority(event.trigger) < presencePriority(active.trigger)
    ) {
      return false
    }

    this.recordPresenceDedupe(dedupeKeys)
    this.clearPresenceCaptionGate()
    this.#speechEpoch++
    this.#speechChain = Promise.resolve()
    if (
      active !== null &&
      (active.speechStatus === "queued" || active.speechStatus === "playing")
    ) {
      this.queuePresenceCancellation("explicit_cancel")
    }

    const presentationGeneration = ++this.#presentationGeneration
    const speechStatus = this.resolveInactiveSpeechStatus()
    this.#snapshot = {
      ...this.#snapshot,
      presence: {
        requestId: event.requestId,
        workspaceId: event.workspaceId,
        workspaceGeneration: event.workspaceGeneration,
        sourceEventId: event.sourceEventId,
        decisionId: event.decisionId,
        trigger: event.trigger,
        locale: event.locale,
        utterance: event.utterance,
        cue: event.cue,
        priority: event.priority,
        occurredAt: event.occurredAt,
        presentationGeneration,
        speechStatus,
        errorCode: null,
      },
      latestPresenceRequestId: event.requestId,
    }
    this.emit()
    this.preparePresenceCaptionSpeech()
    return true
  }

  public async activatePresentation(
    key: CommitNarrationSourceKey,
  ): Promise<boolean> {
    if (isActiveCommitNarrationPresentation(this.#snapshot.presentation)) {
      const presentation = this.#snapshot.presentation
      if (presentation !== null && !sameSourceKey(presentation.key, key)) {
        await this.dismissPresentation("explicit_cancel")
      } else {
        await this.cancelSpeech("explicit_cancel")
      }
    }
    const prepared = this.#prepared.get(commitNarrationSourceKey(key))
    if (prepared === undefined || prepared.status === "canceled") return false
    const scope = this.#snapshot.scope
    if (scope === null) {
      if (
        !(await this.setScope({
          workspaceId: key.workspaceId,
          generation: key.workspaceGeneration,
        }))
      ) {
        return false
      }
    } else if (
      scope.workspaceId !== key.workspaceId ||
      scope.generation !== key.workspaceGeneration
    ) {
      return false
    }
    const preparedActive =
      prepared.status === "preparing" ||
      prepared.status === "streaming" ||
      prepared.status === "ready"
    if (preparedActive) {
      await this.dismissPresence("explicit_cancel")
    }
    const generation = ++this.#presentationGeneration
    if (preparedActive) this.#speechEpoch++
    this.clearCaptionSpeechGate()
    this.#snapshot = {
      ...this.#snapshot,
      presentation: {
        key: prepared.key,
        trigger: prepared.trigger,
        presentationGeneration: generation,
        status: presentationStatus(prepared.status),
        chunks: [...prepared.chunks],
        lastSequence:
          prepared.chunks.length === 0 ? null : prepared.chunks.length - 1,
        speechStatus: this.resolveInactiveSpeechStatus(),
        errorCode: prepared.errorCode,
      },
    }
    this.emit()
    if (prepared.status === "streaming" || prepared.status === "ready") {
      this.prepareCaptionSpeech()
    }
    return true
  }

  public readonly acknowledgeCaptionVisible = (
    acknowledgment: CaptionVisibilityAcknowledgment,
  ): boolean => {
    const presentation = this.#snapshot.presentation
    const gate = this.#captionSpeechGate
    if (
      presentation === null ||
      gate === null ||
      gate.terminal ||
      acknowledgment.presentationGeneration !==
        presentation.presentationGeneration ||
      acknowledgment.presentationGeneration !== gate.presentationGeneration ||
      !sameSourceKey(acknowledgment.key, presentation.key) ||
      !sameSourceKey(acknowledgment.key, gate.key) ||
      acknowledgment.sequence < 0 ||
      acknowledgment.sequence > (presentation.lastSequence ?? -1) ||
      gate.sequences.get(acknowledgment.sequence) !== "waiting"
    ) {
      return false
    }

    gate.sequences.set(acknowledgment.sequence, "leading")
    this.clearCaptionAcknowledgmentTimer(gate, acknowledgment.sequence)
    gate.leads.set(
      acknowledgment.sequence,
      this.pause(captionSpeechLeadMilliseconds),
    )
    void this.drainCaptionSpeech(gate)
    return true
  }

  public readonly acknowledgePresenceCaptionVisible = (
    acknowledgment: PresenceCaptionVisibilityAcknowledgment,
  ): boolean => {
    const presence = this.#snapshot.presence
    const gate = this.#presenceCaptionGate
    const scope = this.#snapshot.scope
    if (
      presence === null ||
      gate === null ||
      gate.state !== "waiting" ||
      acknowledgment.requestId !== presence.requestId ||
      acknowledgment.requestId !== gate.requestId ||
      acknowledgment.requestId !== this.#snapshot.latestPresenceRequestId ||
      acknowledgment.presentationGeneration !==
        presence.presentationGeneration ||
      acknowledgment.presentationGeneration !== gate.presentationGeneration ||
      scope === null ||
      scope.workspaceId !== presence.workspaceId ||
      scope.generation !== presence.workspaceGeneration ||
      scope.locale !== presence.locale ||
      isActiveCommitNarrationPresentation(this.#snapshot.presentation)
    ) {
      return false
    }

    gate.state = "leading"
    if (gate.acknowledgmentTimer !== null) {
      clearTimeout(gate.acknowledgmentTimer)
      gate.acknowledgmentTimer = null
    }
    void this.releasePresenceSpeech(gate)
    return true
  }

  public consumePendingRequestResolved(resolution: {
    readonly workspaceId: string
    readonly workspaceGeneration: number
    readonly pendingId: string
  }): boolean {
    const presence = this.#snapshot.presence
    if (
      presence === null ||
      presence.trigger !== "decision_wait" ||
      presence.workspaceId !== resolution.workspaceId ||
      presence.workspaceGeneration !== resolution.workspaceGeneration ||
      presence.decisionId !== resolution.pendingId
    ) {
      return false
    }
    void this.dismissPresence("explicit_cancel")
    return true
  }

  public async dismissPresence(
    reason: NarrationCancelReason = "explicit_cancel",
  ): Promise<void> {
    const presence = this.#snapshot.presence
    if (presence === null) return
    const shouldCancelNative =
      presence.speechStatus === "queued" || presence.speechStatus === "playing"
    this.clearPresenceCaptionGate()
    this.#speechEpoch++
    this.#speechChain = Promise.resolve()
    this.#presentationGeneration++
    this.#snapshot = {
      ...this.#snapshot,
      presence: null,
      latestPresenceRequestId: null,
    }
    this.emit()
    if (shouldCancelNative) this.queuePresenceCancellation(reason)
    await this.#presenceCancellation
  }

  public async cancelPresentation(
    reason: NarrationCancelReason = "explicit_cancel",
  ): Promise<void> {
    this.clearCaptionSpeechGate()
    if (this.#snapshot.presentation !== null) {
      const prepared = this.#prepared.get(
        commitNarrationSourceKey(this.#snapshot.presentation.key),
      )
      if (prepared !== undefined) {
        prepared.status = "canceled"
        prepared.errorCode = "NARRATION-PRESENTATION-CANCELED"
        prepared.touchedAt = Date.now()
      }
      this.#presentationGeneration++
      this.#snapshot = {
        ...this.#snapshot,
        presentation: {
          ...this.#snapshot.presentation,
          presentationGeneration: this.#presentationGeneration,
          status: "canceled",
          speechStatus: "idle",
          errorCode: "NARRATION-PRESENTATION-CANCELED",
        },
      }
      this.emit()
    }
    await this.cancelSpeech(reason)
  }

  public async dismissPresentation(
    reason: NarrationCancelReason = "explicit_cancel",
  ): Promise<void> {
    this.clearCaptionSpeechGate()
    if (this.#snapshot.presentation !== null) {
      this.#presentationGeneration++
      this.#snapshot = {
        ...this.#snapshot,
        presentation: null,
      }
      this.emit()
    }
    await this.cancelSpeech(reason)
  }

  public async playTest(
    scope: NarrationScope,
    locale: NarrationLocale,
    text: string,
  ): Promise<boolean> {
    if (!(await this.setScope(scope))) return false
    const settings = this.#snapshot.settingsSnapshot?.settings
    if (settings === undefined) return false
    this.settleTestCaptionGate(false)
    const testEpoch = ++this.#speechEpoch
    const testGeneration = ++this.#testSequence
    const requestId = `narration-test-${testGeneration}`
    let resolveVisibility!: (visible: boolean) => void
    const visibility = new Promise<boolean>((resolve) => {
      resolveVisibility = resolve
    })
    const gate: TestCaptionGate = {
      generation: testGeneration,
      resolve: resolveVisibility,
      timer: null,
    }
    gate.timer = setTimeout(() => {
      if (this.#testCaptionGate !== gate) return
      this.#testCaptionGate = null
      gate.timer = null
      this.update({
        test: {
          status: "unavailable",
          generation: testGeneration,
          text,
          errorCode: "NARRATION-TEST-CAPTION-NOT-VISIBLE",
        },
      })
      gate.resolve(false)
    }, captionAcknowledgmentTimeoutMilliseconds)
    this.#testCaptionGate = gate
    this.update({
      test: {
        status: "preparing",
        generation: testGeneration,
        text,
        errorCode: null,
      },
    })
    const visible = await visibility
    if (!visible || !this.testStillCurrent(testEpoch, testGeneration)) {
      return false
    }
    await this.pause(captionSpeechLeadMilliseconds)
    if (!this.testStillCurrent(testEpoch, testGeneration)) return false
    this.update({
      test: {
        status: "playing",
        generation: testGeneration,
        text,
        errorCode: null,
      },
    })
    try {
      const response = await this.gateway.speak({
        schemaVersion: narrationSchemaVersion,
        requestId,
        workspaceId: scope.workspaceId,
        generation: scope.generation,
        sequence: 0,
        locale,
        kind: "test",
        semanticType: "test",
        priority: "high",
        text,
      })
      if (!this.testStillCurrent(testEpoch, testGeneration)) return false
      if (response.disposition !== "queued") {
        this.update({
          test: {
            status: "unavailable",
            generation: testGeneration,
            text,
            errorCode: response.code ?? `NARRATION-${response.disposition}`,
          },
        })
        return false
      }
      await this.waitForPlaybackEnd(testEpoch, testSpeechTimeoutMilliseconds)
      if (!this.testStillCurrent(testEpoch, testGeneration)) return false
      this.update({
        test: {
          status: "idle",
          generation: testGeneration,
          text,
          errorCode: null,
        },
      })
      return true
    } catch (error) {
      if (!this.testStillCurrent(testEpoch, testGeneration)) return false
      const code = errorCode(error)
      if (code !== "NARRATION-PLAYBACK-TIMEOUT") {
        await this.cancelTerminalSpeech()
      }
      this.update({
        test: {
          status: "unavailable",
          generation: testGeneration,
          text,
          errorCode: code,
        },
      })
      return false
    }
  }

  public readonly acknowledgeTestCaptionVisible = (
    acknowledgment: TestCaptionVisibilityAcknowledgment,
  ): boolean => {
    const gate = this.#testCaptionGate
    if (
      gate === null ||
      this.#snapshot.test.status !== "preparing" ||
      acknowledgment.testGeneration !== gate.generation ||
      acknowledgment.testGeneration !== this.#snapshot.test.generation
    ) {
      return false
    }
    this.settleTestCaptionGate(true)
    return true
  }

  public async cancelTest(): Promise<void> {
    this.#speechEpoch++
    this.settleTestCaptionGate(false)
    await this.gateway.cancel("explicit_cancel")
    this.update({ test: { ...this.#snapshot.test, status: "idle" } })
  }

  public voicesForLocale(locale: NarrationLocale): readonly NarrationVoiceV1[] {
    return this.#snapshot.voices.filter((voice) =>
      locale === "ja"
        ? voice.locale === "ja_JP"
        : voice.locale.startsWith("en_"),
    )
  }

  private async applyScope(
    scope: NarrationScope,
    epoch: number,
  ): Promise<boolean> {
    if (epoch !== this.#scopeEpoch) return false

    const sameNativeScope =
      this.#snapshot.scope?.workspaceId === scope.workspaceId &&
      this.#snapshot.scope.generation === scope.generation
    const sameLocale =
      sameNativeScope && this.#snapshot.scope?.locale === scope.locale
    if (sameLocale) {
      this.syncPresenceScope(scope, epoch)
      return true
    }

    await this.dismissPresence("workspace_switch")
    if (epoch !== this.#scopeEpoch) return false

    if (sameNativeScope) {
      this.update({ scope, lastErrorCode: null })
      this.syncPresenceScope(scope, epoch)
      return true
    }

    if (
      this.#snapshot.scope !== null &&
      isActiveCommitNarrationPresentation(this.#snapshot.presentation)
    ) {
      await this.dismissPresentation("workspace_switch")
      if (epoch !== this.#scopeEpoch) return false
    }

    try {
      await this.gateway.setScope({
        schemaVersion: narrationSchemaVersion,
        workspaceId: scope.workspaceId,
        generation: scope.generation,
      })
      if (epoch !== this.#scopeEpoch) return false
      this.dropStalePrepared(scope)
      this.update({ scope, lastErrorCode: null })
      this.syncPresenceScope(scope, epoch)
      return true
    } catch (error) {
      if (epoch === this.#scopeEpoch) {
        this.update({ lastErrorCode: errorCode(error) })
      }
      return false
    }
  }

  private recordPresenceDedupe(keys: readonly string[]): void {
    for (const key of keys) {
      if (this.#presenceDedupe.has(key)) continue
      this.#presenceDedupe.add(key)
      this.#presenceDedupeOrder.push(key)
    }
    while (
      this.#presenceDedupeOrder.length >
      maximumPresenceDedupeEntries * 2
    ) {
      const oldest = this.#presenceDedupeOrder.shift()
      if (oldest !== undefined) this.#presenceDedupe.delete(oldest)
    }
  }

  private syncPresenceScope(
    scope: NarrationScope | null,
    epoch = this.#scopeEpoch,
  ): void {
    if (
      scope?.locale === undefined ||
      this.#presenceSource?.setScope === undefined
    ) {
      return
    }
    const request: PresenceDirectionScopeRequestV1 = {
      schemaVersion: narrationSchemaVersion,
      workspaceId: scope.workspaceId,
      workspaceGeneration: scope.generation,
      locale: scope.locale,
    }
    this.#presenceScopeDesired = {
      epoch,
      request,
      source: this.#presenceSource,
    }
    this.startPresenceScopeDrain()
  }

  private startPresenceScopeDrain(): void {
    if (
      this.#presenceScopeDrain !== null ||
      this.#presenceScopeDesired === null
    ) {
      return
    }
    const drain = this.drainPresenceScopes()
    this.#presenceScopeDrain = drain
    void drain.then(
      () => this.finishPresenceScopeDrain(drain),
      () => this.finishPresenceScopeDrain(drain),
    )
  }

  private finishPresenceScopeDrain(drain: Promise<void>): void {
    if (this.#presenceScopeDrain !== drain) return
    this.#presenceScopeDrain = null
    this.startPresenceScopeDrain()
  }

  private async drainPresenceScopes(): Promise<void> {
    while (this.#presenceScopeDesired !== null) {
      const desired = this.#presenceScopeDesired
      this.#presenceScopeDesired = null
      if (
        desired.epoch !== this.#scopeEpoch ||
        desired.source !== this.#presenceSource ||
        desired.source.setScope === undefined
      ) {
        continue
      }
      try {
        await desired.source.setScope(desired.request)
      } catch {
        // Luna scheduling is optional and must not block the main workspace scope.
      }
    }
  }

  private preparePresenceCaptionSpeech(): void {
    const presence = this.#snapshot.presence
    const settings = this.#snapshot.settingsSnapshot?.settings
    if (presence === null || settings === undefined) return
    if (!settings.enabled || settings.muted) {
      this.updatePresence({
        speechStatus: settings.muted ? "muted" : "off",
      })
      return
    }

    const gate: PresenceCaptionGate = {
      requestId: presence.requestId,
      presentationGeneration: presence.presentationGeneration,
      state: "waiting",
      acknowledgmentTimer: null,
    }
    gate.acknowledgmentTimer = setTimeout(() => {
      if (this.#presenceCaptionGate !== gate || gate.state !== "waiting") return
      gate.state = "terminal"
      gate.acknowledgmentTimer = null
      this.updatePresence({
        speechStatus: "unavailable",
        errorCode: "NARRATION-CAPTION-NOT-VISIBLE",
      })
    }, captionAcknowledgmentTimeoutMilliseconds)
    this.#presenceCaptionGate = gate
    this.updatePresence({ speechStatus: "queued" })
  }

  private clearPresenceCaptionGate(): void {
    const gate = this.#presenceCaptionGate
    if (gate !== null) {
      gate.state = "terminal"
      if (gate.acknowledgmentTimer !== null) {
        clearTimeout(gate.acknowledgmentTimer)
        gate.acknowledgmentTimer = null
      }
    }
    this.#presenceCaptionGate = null
  }

  private async releasePresenceSpeech(
    gate: PresenceCaptionGate,
  ): Promise<void> {
    const epoch = this.#speechEpoch
    await this.pause(captionSpeechLeadMilliseconds)
    await this.#presenceCancellation
    if (!this.presenceStillCurrent(epoch, gate, "leading")) return

    const presence = this.#snapshot.presence
    const settings = this.#snapshot.settingsSnapshot?.settings
    if (presence === null || settings === undefined) return
    if (!settings.enabled || settings.muted) {
      gate.state = "terminal"
      this.updatePresence({
        speechStatus: settings.muted ? "muted" : "off",
      })
      return
    }

    gate.state = "scheduled"
    try {
      const response = await this.gateway.speak({
        schemaVersion: narrationSchemaVersion,
        requestId: `presence-${presence.requestId.slice(0, 96)}-${presence.presentationGeneration}`,
        workspaceId: presence.workspaceId,
        generation: presence.workspaceGeneration,
        sequence: 0,
        locale: presence.locale,
        kind: "event",
        semanticType: presenceSemanticType(presence.trigger),
        priority: presence.priority,
        text: presence.utterance,
      })
      if (!this.presenceStillCurrent(epoch, gate, "scheduled")) return
      if (response.disposition !== "queued") {
        gate.state = "terminal"
        this.updatePresence({
          speechStatus:
            response.disposition === "muted"
              ? "muted"
              : response.disposition === "disabled"
                ? "off"
                : "unavailable",
          errorCode:
            response.disposition === "muted" ||
            response.disposition === "disabled"
              ? null
              : (response.code ?? `NARRATION-${response.disposition}`),
        })
        return
      }
      this.updatePresence({ speechStatus: "playing" })
      await this.waitForPlaybackEnd(epoch)
      if (this.presenceStillCurrent(epoch, gate, "scheduled")) {
        gate.state = "terminal"
        this.updatePresence({ speechStatus: "idle" })
      }
    } catch (error) {
      if (!this.presenceStillCurrent(epoch, gate, "scheduled")) return
      gate.state = "terminal"
      const code = errorCode(error)
      this.updatePresence({ speechStatus: "unavailable", errorCode: code })
      if (code !== "NARRATION-PLAYBACK-TIMEOUT") {
        await this.cancelPresenceNativeSpeech("explicit_cancel")
      }
    }
  }

  private presenceStillCurrent(
    epoch: number,
    gate: PresenceCaptionGate,
    state: PresenceCaptionGate["state"],
  ): boolean {
    const presence = this.#snapshot.presence
    const scope = this.#snapshot.scope
    return (
      epoch === this.#speechEpoch &&
      this.#presenceCaptionGate === gate &&
      gate.state === state &&
      presence !== null &&
      presence.requestId === gate.requestId &&
      presence.requestId === this.#snapshot.latestPresenceRequestId &&
      presence.presentationGeneration === gate.presentationGeneration &&
      scope?.workspaceId === presence.workspaceId &&
      scope.generation === presence.workspaceGeneration &&
      scope.locale === presence.locale &&
      !isActiveCommitNarrationPresentation(this.#snapshot.presentation)
    )
  }

  private updatePresence(
    update: Partial<PresenceDirectionPresentationSnapshot>,
  ): void {
    if (this.#snapshot.presence === null) return
    this.#snapshot = {
      ...this.#snapshot,
      presence: { ...this.#snapshot.presence, ...update },
    }
    this.emit()
  }

  private async cancelPresenceNativeSpeech(
    reason: NarrationCancelReason,
  ): Promise<void> {
    try {
      await this.gateway.cancel(reason)
    } catch {
      // Optional presence failures stay isolated from the main session UI.
    }
  }

  private queuePresenceCancellation(reason: NarrationCancelReason): void {
    this.#presenceCancellation = this.#presenceCancellation.then(() =>
      this.cancelPresenceNativeSpeech(reason),
    )
  }

  private prepareCaptionSpeech(): void {
    const presentation = this.#snapshot.presentation
    const settings = this.#snapshot.settingsSnapshot?.settings
    if (
      presentation === null ||
      settings === undefined ||
      presentation.lastSequence === null ||
      presentation.status === "canceled" ||
      presentation.status === "unavailable"
    ) {
      return
    }

    let gate = this.#captionSpeechGate
    if (
      gate === null ||
      gate.presentationGeneration !== presentation.presentationGeneration ||
      !sameSourceKey(gate.key, presentation.key)
    ) {
      this.clearCaptionSpeechGate()
      gate = {
        key: presentation.key,
        presentationGeneration: presentation.presentationGeneration,
        sequences: new Map(),
        leads: new Map(),
        nextReleaseSequence: 0,
        draining: false,
        terminal: false,
        acknowledgmentTimers: new Map(),
      }
      this.#captionSpeechGate = gate
    }

    const addedSequences: number[] = []
    for (let sequence = 0; sequence <= presentation.lastSequence; sequence++) {
      if (!gate.sequences.has(sequence)) {
        gate.sequences.set(sequence, "waiting")
        addedSequences.push(sequence)
      }
    }

    if (!settings.enabled || settings.muted) {
      this.skipPendingCaptionSpeech(gate)
      this.updatePresentation({
        speechStatus: settings.muted ? "muted" : "off",
      })
      return
    }
    if (gate.terminal) return

    if ([...gate.sequences.values()].some((state) => state === "waiting")) {
      if (presentation.speechStatus !== "playing") {
        this.updatePresentation({ speechStatus: "queued" })
      }
      for (const sequence of addedSequences) {
        this.armCaptionAcknowledgmentTimeout(gate, sequence)
      }
    }
  }

  private armCaptionAcknowledgmentTimeout(
    gate: CaptionSpeechGate,
    sequence: number,
  ): void {
    if (
      gate.terminal ||
      gate.sequences.get(sequence) !== "waiting" ||
      gate.acknowledgmentTimers.has(sequence)
    ) {
      return
    }
    const timer = setTimeout(() => {
      if (this.#captionSpeechGate !== gate || gate.terminal) return
      gate.acknowledgmentTimers.delete(sequence)
      if (gate.sequences.get(sequence) !== "waiting") return
      void this.terminalizeCaptionSpeech("NARRATION-CAPTION-NOT-VISIBLE")
    }, captionAcknowledgmentTimeoutMilliseconds)
    gate.acknowledgmentTimers.set(sequence, timer)
  }

  private clearCaptionAcknowledgmentTimer(
    gate: CaptionSpeechGate,
    sequence: number,
  ): void {
    const timer = gate.acknowledgmentTimers.get(sequence)
    if (timer === undefined) return
    clearTimeout(timer)
    gate.acknowledgmentTimers.delete(sequence)
  }

  private clearCaptionAcknowledgmentTimers(gate: CaptionSpeechGate): void {
    for (const timer of gate.acknowledgmentTimers.values()) {
      clearTimeout(timer)
    }
    gate.acknowledgmentTimers.clear()
  }

  private async drainCaptionSpeech(gate: CaptionSpeechGate): Promise<void> {
    if (gate.draining || gate.terminal) return
    gate.draining = true
    try {
      while (this.#captionSpeechGate === gate && !gate.terminal) {
        const sequence = gate.nextReleaseSequence
        const state = gate.sequences.get(sequence)
        if (state === undefined || state === "waiting") break
        if (state === "skipped" || state === "scheduled") {
          gate.nextReleaseSequence++
          continue
        }
        const lead = gate.leads.get(sequence)
        if (lead === undefined) break
        await lead
        if (this.#captionSpeechGate !== gate || gate.terminal) return
        if (gate.sequences.get(sequence) !== "leading") continue

        const presentation = this.#snapshot.presentation
        const settings = this.#snapshot.settingsSnapshot?.settings
        const text = presentation?.chunks[sequence]
        if (
          presentation === null ||
          settings === undefined ||
          text === undefined ||
          presentation.presentationGeneration !== gate.presentationGeneration ||
          !sameSourceKey(presentation.key, gate.key)
        ) {
          return
        }
        gate.leads.delete(sequence)
        if (!settings.enabled || settings.muted) {
          gate.sequences.set(sequence, "skipped")
          continue
        }
        gate.sequences.set(sequence, "scheduled")
        gate.nextReleaseSequence++
        this.scheduleSpeech(sequence, text)
      }
    } catch {
      void this.terminalizeCaptionSpeech("NARRATION-CAPTION-VISIBILITY")
    } finally {
      gate.draining = false
    }
  }

  private skipPendingCaptionSpeech(gate: CaptionSpeechGate): void {
    for (const [sequence, state] of gate.sequences) {
      if (state === "waiting" || state === "leading") {
        this.clearCaptionAcknowledgmentTimer(gate, sequence)
        gate.sequences.set(sequence, "skipped")
        gate.leads.delete(sequence)
      }
    }
  }

  private terminalizeCaptionSpeech(
    code?: string,
    cancelNative = false,
  ): Promise<void> {
    const gate = this.#captionSpeechGate
    if (gate !== null) {
      gate.terminal = true
      this.clearCaptionAcknowledgmentTimers(gate)
    }
    this.#speechEpoch++
    this.#speechChain = Promise.resolve()
    if (code !== undefined) {
      this.updatePresentation({
        speechStatus: "unavailable",
        errorCode: code,
      })
    }
    return cancelNative ? this.cancelTerminalSpeech() : Promise.resolve()
  }

  private async cancelTerminalSpeech(): Promise<void> {
    try {
      await this.gateway.cancel("explicit_cancel")
    } catch (error) {
      this.update({ lastErrorCode: errorCode(error) })
    }
  }

  private clearCaptionSpeechGate(): void {
    const gate = this.#captionSpeechGate
    if (gate !== null) {
      gate.terminal = true
      this.clearCaptionAcknowledgmentTimers(gate)
    }
    this.#captionSpeechGate = null
  }

  private scheduleSpeech(sequence: number, text: string): void {
    const presentation = this.#snapshot.presentation
    const settings = this.#snapshot.settingsSnapshot?.settings
    if (presentation === null || settings === undefined) return
    if (!settings.enabled || settings.muted) {
      this.updatePresentation({
        speechStatus: settings.muted ? "muted" : "off",
      })
      return
    }
    const epoch = this.#speechEpoch
    const generation = presentation.presentationGeneration
    const key = presentation.key
    this.updatePresentation({ speechStatus: "queued" })
    this.#speechChain = this.#speechChain
      .then(async () => {
        if (!this.speechStillActive(epoch, generation, key)) return
        const response = await this.gateway.speak({
          schemaVersion: narrationSchemaVersion,
          requestId: `present-${key.requestId.slice(0, 96)}-${generation}`,
          workspaceId: key.workspaceId,
          generation: key.workspaceGeneration,
          sequence,
          locale: key.locale,
          kind: "commit_explanation",
          semanticType: "commit_explanation",
          priority: "normal",
          text,
        })
        if (!this.speechStillActive(epoch, generation, key)) return
        if (response.disposition !== "queued") {
          if (response.disposition === "muted") {
            this.updatePresentation({ speechStatus: "muted" })
          } else if (response.disposition === "disabled") {
            this.updatePresentation({ speechStatus: "off" })
          } else {
            await this.terminalizeCaptionSpeech(
              response.code ?? `NARRATION-${response.disposition}`,
              true,
            )
          }
          return
        }
        this.updatePresentation({ speechStatus: "playing" })
        await this.waitForPlaybackEnd(epoch)
        if (this.speechStillActive(epoch, generation, key)) {
          this.updatePresentation({ speechStatus: "idle" })
        }
      })
      .catch(async (error: unknown) => {
        if (this.speechStillActive(epoch, generation, key)) {
          const code = errorCode(error)
          await this.terminalizeCaptionSpeech(
            code,
            code !== "NARRATION-PLAYBACK-TIMEOUT",
          )
        }
      })
  }

  private async waitForPlaybackEnd(
    epoch: number,
    timeoutMilliseconds = speechTimeoutMilliseconds,
  ): Promise<void> {
    let elapsed = 0
    while (elapsed < timeoutMilliseconds && epoch === this.#speechEpoch) {
      const runtime = await this.gateway.getRuntime()
      this.updateRuntime(runtime)
      if (runtime.playbackState === "unavailable") {
        throw new NarrationBoundaryError({
          code: runtime.lastErrorCode ?? "NARRATION-AUDIO-UNAVAILABLE",
          operation: "narration_get_runtime",
          recoverable: true,
          userMessageKey: "narration.error.generic",
          detailRef: "narration-v1",
        })
      }
      if (runtime.playbackState === "idle" && runtime.queueDepth === 0) return
      await this.pause(speechPollMilliseconds)
      elapsed += speechPollMilliseconds
    }
    if (elapsed >= timeoutMilliseconds && epoch === this.#speechEpoch) {
      try {
        await this.gateway.cancel("explicit_cancel")
      } catch (error) {
        this.update({ lastErrorCode: errorCode(error) })
      }
      throw new NarrationBoundaryError({
        code: "NARRATION-PLAYBACK-TIMEOUT",
        operation: "narration_get_runtime",
        recoverable: true,
        userMessageKey: "narration.error.generic",
        detailRef: "narration-v1",
      })
    }
  }

  private updateRuntime(runtime: NarrationRuntimeSnapshotV1): void {
    const settingsSnapshot = this.#snapshot.settingsSnapshot
    if (settingsSnapshot === null) return
    this.update({
      settingsSnapshot: { ...settingsSnapshot, runtime },
    })
  }

  private speechStillActive(
    epoch: number,
    generation: number,
    key: CommitNarrationSourceKey,
  ): boolean {
    const active = this.#snapshot.presentation
    const gate = this.#captionSpeechGate
    return (
      epoch === this.#speechEpoch &&
      active !== null &&
      gate !== null &&
      !gate.terminal &&
      gate.presentationGeneration === generation &&
      active.presentationGeneration === generation &&
      active.status !== "canceled" &&
      active.status !== "unavailable" &&
      active.speechStatus !== "unavailable" &&
      sameSourceKey(gate.key, key) &&
      sameSourceKey(active.key, key)
    )
  }

  private settleTestCaptionGate(visible: boolean): void {
    const gate = this.#testCaptionGate
    if (gate === null) return
    this.#testCaptionGate = null
    if (gate.timer !== null) {
      clearTimeout(gate.timer)
      gate.timer = null
    }
    gate.resolve(visible)
  }

  private testStillCurrent(epoch: number, generation: number): boolean {
    return (
      epoch === this.#speechEpoch &&
      this.#snapshot.test.generation === generation &&
      (this.#snapshot.test.status === "preparing" ||
        this.#snapshot.test.status === "playing")
    )
  }

  private async cancelSpeech(reason: NarrationCancelReason): Promise<void> {
    if (this.#captionSpeechGate !== null) {
      this.skipPendingCaptionSpeech(this.#captionSpeechGate)
    }
    this.clearPresenceCaptionGate()
    this.#speechEpoch++
    this.#speechChain = Promise.resolve()
    try {
      await this.gateway.cancel(reason)
    } catch (error) {
      this.update({ lastErrorCode: errorCode(error) })
    }
    const settings = this.#snapshot.settingsSnapshot?.settings
    if (this.#snapshot.presence !== null) {
      this.updatePresence({
        speechStatus: settings?.muted
          ? "muted"
          : settings?.enabled
            ? "idle"
            : "off",
      })
    }
    if (
      this.#snapshot.presentation !== null &&
      this.#snapshot.presentation.status !== "unavailable" &&
      this.#captionSpeechGate?.terminal !== true
    ) {
      this.updatePresentation({
        speechStatus: settings?.muted
          ? "muted"
          : settings?.enabled
            ? "idle"
            : "off",
      })
    }
  }

  private activeMatches(key: CommitNarrationSourceKey): boolean {
    return (
      isActiveCommitNarrationPresentation(this.#snapshot.presentation) &&
      this.#snapshot.presentation !== null &&
      sameSourceKey(this.#snapshot.presentation.key, key)
    )
  }

  private publishActive(prepared: PreparedCommitNarration): void {
    const active = this.#snapshot.presentation
    if (active === null || !sameSourceKey(active.key, prepared.key)) return
    this.#snapshot = {
      ...this.#snapshot,
      presentation: {
        ...active,
        status: presentationStatus(prepared.status),
        chunks: [...prepared.chunks],
        lastSequence:
          prepared.chunks.length === 0 ? null : prepared.chunks.length - 1,
        errorCode: prepared.errorCode,
      },
    }
    this.emit()
  }

  private failPrepared(prepared: PreparedCommitNarration, code: string): void {
    prepared.status = "failed"
    prepared.errorCode = code
    if (this.activeMatches(prepared.key)) {
      this.publishActive(prepared)
      void this.cancelSpeech("explicit_cancel")
    }
  }

  private failActivePresentation(code: string): void {
    if (this.#snapshot.presentation === null) {
      this.update({ lastErrorCode: code })
      return
    }
    const prepared = this.#prepared.get(
      commitNarrationSourceKey(this.#snapshot.presentation.key),
    )
    if (prepared !== undefined) {
      prepared.status = "failed"
      prepared.errorCode = code
      prepared.touchedAt = Date.now()
    }
    this.updatePresentation({
      status: "unavailable",
      speechStatus: "unavailable",
      errorCode: code,
    })
    void this.cancelSpeech("explicit_cancel")
  }

  private resolveInactiveSpeechStatus(): NarrationSpeechStatus {
    const settings = this.#snapshot.settingsSnapshot?.settings
    if (settings === undefined || !settings.enabled) return "off"
    return settings.muted ? "muted" : "idle"
  }

  private updatePresentation(
    update: Partial<CommitNarrationPresentationSnapshot>,
  ): void {
    if (this.#snapshot.presentation === null) return
    this.#snapshot = {
      ...this.#snapshot,
      presentation: { ...this.#snapshot.presentation, ...update },
    }
    this.emit()
  }

  private trimPrepared(): void {
    if (this.#prepared.size <= maximumPreparedPresentations) return
    const activeKey = this.#snapshot.presentation
      ? commitNarrationSourceKey(this.#snapshot.presentation.key)
      : null
    const oldest = [...this.#prepared.entries()]
      .filter(([key]) => key !== activeKey)
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0]
    if (oldest !== undefined) this.#prepared.delete(oldest[0])
  }

  private dropStalePrepared(scope: NarrationScope): void {
    for (const [id, prepared] of this.#prepared) {
      if (
        prepared.key.workspaceId === scope.workspaceId &&
        prepared.key.workspaceGeneration < scope.generation
      ) {
        this.#prepared.delete(id)
      }
    }
  }

  private validateSettingsInput(
    input: Omit<NarrationSettingsUpdateV2, "schemaVersion" | "expectedVersion">,
    version: number,
  ): string | null {
    if (
      input.apiKeyAction.kind === "replace" &&
      (input.apiKeyAction.value.length > 512 ||
        !/^[A-Za-z0-9._-]+$/u.test(input.apiKeyAction.value))
    ) {
      return "NARRATION-API-KEY-INVALID"
    }
    const current = this.#snapshot.settingsSnapshot?.settings
    const apiKeyConfigured =
      input.apiKeyAction.kind === "replace"
        ? input.apiKeyAction.value.trim().length > 0
        : input.apiKeyAction.kind === "clear"
          ? false
          : (current?.apiKeyConfigured ?? false)
    try {
      parseNarrationSettings({
        schemaVersion: narrationSettingsSchemaVersion,
        version,
        enabled: input.enabled,
        muted: input.muted,
        provider: input.provider,
        apiKeyConfigured,
        model: input.model,
        voice: input.voice,
        speed: input.speed,
      })
    } catch (error) {
      return errorCode(error)
    }
    return null
  }

  private update(update: Partial<NarrationControllerSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...update }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.#listeners) listener()
  }
}
