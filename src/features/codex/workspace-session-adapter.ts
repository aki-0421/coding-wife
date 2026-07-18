import {
  codexCommands,
  type AttachmentRegistrationResponse,
  type CodexDiagnostic,
  type CodexEvent,
  type CodexFallbackDecisionRequest,
  type CodexPendingResponseRequest,
  type ReasoningPreset,
} from "@/lib/contracts"
import {
  hasDisallowedMultilineControl,
  unicodeScalarCount,
} from "@/lib/public-text"

import { CodexSessionClient } from "@/features/codex/client"
import {
  CodexEventProjector,
  projectAcceptedUserTurn,
  type CodexHistoryEvent,
} from "@/features/codex/event-projection"
import { CodexSessionStore } from "@/features/codex/session-store"
import type { CodexTransport } from "@/features/codex/transport"
import {
  CodexWorkspaceSessionStore,
  type CodexHistoryMode,
  type CodexWorkspaceSessionSnapshot,
} from "@/features/codex/workspace-session-store"

export interface CodexHistorySink {
  append(event: CodexHistoryEvent): Promise<void>
}

export interface ActivateCodexWorkspaceRequest {
  readonly workspaceId: string
  readonly historyMode: CodexHistoryMode
  readonly resumeThreadHandle?: string
}

export interface StartCodexTurnRequest {
  readonly workspaceId: string
  readonly text: string
  readonly publicText?: string
  readonly effort: ReasoningPreset
  readonly attachmentHandles: readonly string[]
}

export interface StartCodexTurnResult {
  readonly accepted: true
  readonly clientUserMessageId: string
  readonly turnHandle: string
}

export interface CodexTerminalWorkUnitEvent {
  readonly schemaVersion: 1
  readonly workUnitId: string
  readonly workspaceId: string
  readonly generation: number
  readonly threadHandle: string
  readonly turnHandle: string
  readonly terminalStatus: "completed" | "failed" | "interrupted" | "canceled"
  readonly sourceEventId: string
  readonly sourceSequence: number
  readonly occurredAt: string
  readonly objective: string
  readonly effort: ReasoningPreset
  readonly attachmentCount: number
}

export interface CodexTurnLifecycleSink {
  recordTerminal(event: CodexTerminalWorkUnitEvent): void | Promise<void>
}

export interface CodexSessionClock {
  readonly now: () => string
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

const systemClock: CodexSessionClock = {
  now: () => new Date().toISOString(),
  setTimeout: (callback, milliseconds) =>
    globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const attachmentHandlePattern =
  /^attachment-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

const terminalTurnStatuses = new Set([
  "completed",
  "failed",
  "interrupted",
  "canceled",
])

interface ActivationIdentity {
  readonly token: number
  readonly workspaceId: string
  readonly threadHandle: string
  readonly generation: number
}

interface AcceptedWorkUnit {
  readonly workUnitId: string
  readonly objective: string
  readonly effort: ReasoningPreset
  readonly attachmentCount: number
}

type TerminalTurnEvent = Extract<CodexEvent, { readonly kind: "turn_status" }>

function codedError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code })
}

function executionKey(
  workspaceId: string,
  generation: number,
  turnHandle: string,
): string {
  return `${workspaceId}:${String(generation)}:${turnHandle}`
}

function safeErrorCode(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9-]{2,127}$/u.test(error.code)
  ) {
    return error.code
  }
  return fallback
}

function validateWorkspaceId(workspaceId: string): void {
  if (
    workspaceId.trim().length === 0 ||
    workspaceId.length > 128 ||
    workspaceId.includes("\0")
  ) {
    throw new Error("CODEX-WORKSPACE-ID-INVALID")
  }
}

function timeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  clock: CodexSessionClock,
  code: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = clock.setTimeout(
      () => reject(Object.assign(new Error(code), { code })),
      milliseconds,
    )
    promise.then(
      (value) => {
        clock.clearTimeout(handle)
        resolve(value)
      },
      (error: unknown) => {
        clock.clearTimeout(handle)
        reject(error instanceof Error ? error : new Error(code))
      },
    )
  })
}

export class CodexWorkspaceSessionAdapter {
  readonly sessionStore: CodexSessionStore
  readonly store: CodexWorkspaceSessionStore
  readonly client: CodexSessionClient

  private readonly projector = new CodexEventProjector()
  private readonly historyQueues = new Map<string, Promise<void>>()
  private readonly historyBlocked = new Set<string>()
  private readonly ownedThreadHandles = new Map<string, string>()
  private started = false
  private startPromise: Promise<void> | null = null
  private activation = 0
  private turnStart: Promise<StartCodexTurnResult> | null = null
  private readonly staleExecutions = new Set<string>()
  private readonly acceptedWorkUnits = new Map<string, AcceptedWorkUnit>()
  private readonly observedTerminalEvents = new Map<string, TerminalTurnEvent>()
  private readonly notifiedTerminalEventIds = new Set<string>()

  constructor(
    readonly transport: CodexTransport,
    private readonly history: CodexHistorySink,
    options: {
      readonly sessionStore?: CodexSessionStore
      readonly store?: CodexWorkspaceSessionStore
      readonly clock?: CodexSessionClock
      readonly createId?: () => string
      readonly turnLifecycleSink?: CodexTurnLifecycleSink
    } = {},
  ) {
    this.sessionStore = options.sessionStore ?? new CodexSessionStore()
    this.store = options.store ?? new CodexWorkspaceSessionStore()
    this.clock = options.clock ?? systemClock
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID())
    this.turnLifecycleSink = options.turnLifecycleSink
    this.client = new CodexSessionClient(transport, this.sessionStore)
  }

  private readonly clock: CodexSessionClock
  private readonly createId: () => string
  private readonly turnLifecycleSink: CodexTurnLifecycleSink | undefined

  snapshot = (): CodexWorkspaceSessionSnapshot => this.store.snapshot()

  subscribe = (
    listener: (snapshot: CodexWorkspaceSessionSnapshot) => void,
  ): (() => void) => this.store.subscribe(listener)

  async start(): Promise<void> {
    if (this.started) return
    if (this.startPromise !== null) return this.startPromise
    const operation = this.client
      .start(
        (error) => {
          this.store.markOperationError(
            safeErrorCode(error, "CODEX-EVENT-CONTRACT-FAILED"),
          )
        },
        (event, result) => this.receiveEvent(event, result),
        (event) => this.canApplyEvent(event),
      )
      .then(() => {
        this.started = true
      })
      .finally(() => {
        this.startPromise = null
      })
    this.startPromise = operation
    return operation
  }

  stop(): void {
    this.activation += 1
    this.client.stop()
    this.started = false
    this.staleExecutions.clear()
    this.acceptedWorkUnits.clear()
    this.observedTerminalEvents.clear()
    this.notifiedTerminalEventIds.clear()
  }

  async activateWorkspace(
    request: ActivateCodexWorkspaceRequest,
  ): Promise<CodexWorkspaceSessionSnapshot> {
    validateWorkspaceId(request.workspaceId)
    await this.start()
    const activation = ++this.activation
    this.historyBlocked.delete(request.workspaceId)
    this.sessionStore.activateWorkspace(request.workspaceId)
    this.store.beginActivation(request.workspaceId, request.historyMode)

    let diagnostic: CodexDiagnostic
    try {
      diagnostic = await this.transport.request(codexCommands.connect, {
        workspaceId: request.workspaceId,
      })
    } catch (error) {
      if (activation === this.activation) {
        this.store.markOperationError(
          safeErrorCode(error, "CODEX-CONNECT-FAILED"),
        )
      }
      throw error
    }
    if (activation !== this.activation) return this.store.snapshot()
    const readiness = this.store.applyDiagnostic(diagnostic)
    if (!readiness.ready) return this.store.snapshot()

    try {
      const explicitResume = request.resumeThreadHandle !== undefined
      const ownedThreadHandle =
        request.resumeThreadHandle ??
        this.ownedThreadHandles.get(request.workspaceId)
      let thread
      if (ownedThreadHandle === undefined) {
        thread = await this.transport.request(codexCommands.threadStart, {
          workspaceId: request.workspaceId,
        })
      } else {
        try {
          thread = await this.transport.request(codexCommands.threadResume, {
            workspaceId: request.workspaceId,
            threadHandle: ownedThreadHandle,
          })
        } catch (error) {
          if (
            explicitResume ||
            safeErrorCode(error, "CODEX-THREAD-RESUME-FAILED") !==
              "CODEX-THREAD-STALE"
          ) {
            throw error
          }
          this.ownedThreadHandles.delete(request.workspaceId)
          thread = await this.transport.request(codexCommands.threadStart, {
            workspaceId: request.workspaceId,
          })
        }
      }
      if (activation === this.activation) {
        this.ownedThreadHandles.set(request.workspaceId, thread.threadHandle)
        this.store.markThreadReady(thread.threadHandle, thread.generation)
      }
      return this.store.snapshot()
    } catch (error) {
      if (activation === this.activation) {
        this.store.markOperationError(
          safeErrorCode(error, "CODEX-THREAD-START-FAILED"),
        )
      }
      throw error
    }
  }

  async sendTurn(
    request: StartCodexTurnRequest,
  ): Promise<StartCodexTurnResult> {
    if (this.turnStart !== null) {
      throw new Error("CODEX-TURN-START-IN-FLIGHT")
    }
    const snapshot = this.store.snapshot()
    const publicText = request.publicText ?? request.text
    if (
      snapshot.activeWorkspaceId !== request.workspaceId ||
      this.staleExecutions.size > 0 ||
      !snapshot.connected ||
      snapshot.threadHandle === null ||
      snapshot.phase === "running" ||
      snapshot.phase === "waiting" ||
      snapshot.phase === "stopping" ||
      (publicText.trim().length === 0 &&
        request.attachmentHandles.length === 0) ||
      unicodeScalarCount(publicText) > 32_000 ||
      unicodeScalarCount(request.text) > 80_000 ||
      hasDisallowedMultilineControl(publicText) ||
      hasDisallowedMultilineControl(request.text) ||
      request.attachmentHandles.length > 10 ||
      new Set(request.attachmentHandles).size !==
        request.attachmentHandles.length ||
      request.attachmentHandles.some(
        (handle) => !attachmentHandlePattern.test(handle),
      ) ||
      (request.effort === "low" && !snapshot.readiness.fastAvailable) ||
      (request.effort === "max" && !snapshot.readiness.maxAvailable)
    ) {
      throw new Error("CODEX-TURN-PREFLIGHT-BLOCKED")
    }
    const threadHandle = snapshot.threadHandle
    const clientUserMessageId = `message-${this.createId()}`
    const generation = snapshot.generation
    if (generation === null) throw new Error("CODEX-GENERATION-UNAVAILABLE")
    const identity: ActivationIdentity = {
      token: this.activation,
      workspaceId: request.workspaceId,
      threadHandle,
      generation,
    }
    const sourceSequence = snapshot.lastSequence + 1
    const operation = this.transport
      .request(codexCommands.turnStart, {
        workspaceId: request.workspaceId,
        threadHandle,
        clientUserMessageId,
        text: request.text,
        effort: request.effort,
        attachmentHandles: request.attachmentHandles,
      })
      .then(async (turn) => {
        const key = executionKey(
          identity.workspaceId,
          identity.generation,
          turn.turnHandle,
        )
        this.acceptedWorkUnits.set(key, {
          workUnitId: clientUserMessageId,
          objective: publicText,
          effort: request.effort,
          attachmentCount: request.attachmentHandles.length,
        })
        const observedTerminal = this.observedTerminalEvents.get(key)
        const alreadyTerminal = observedTerminal !== undefined
        if (observedTerminal !== undefined) {
          this.emitTerminalWorkUnit(key, observedTerminal)
        }
        const accepted = projectAcceptedUserTurn({
          eventId: clientUserMessageId,
          workspaceId: request.workspaceId,
          generation,
          sourceSequence,
          occurredAt: this.clock.now(),
          text: publicText,
          effort: request.effort,
          attachmentCount: request.attachmentHandles.length,
        })
        if (accepted.history !== null) this.enqueueHistory(accepted.history)
        if (!this.isCurrent(identity)) {
          if (!alreadyTerminal) {
            this.staleExecutions.add(key)
          }
          try {
            const interrupted = await this.transport.request(
              codexCommands.turnInterrupt,
              {
                workspaceId: identity.workspaceId,
                threadHandle: identity.threadHandle,
                turnHandle: turn.turnHandle,
              },
            )
            if (!interrupted.accepted) {
              throw codedError("CODEX-STALE-TURN-INTERRUPT-REJECTED")
            }
          } catch (error) {
            throw codedError(
              safeErrorCode(error, "CODEX-STALE-TURN-INTERRUPT-FAILED"),
            )
          }
          throw codedError("CODEX-WORKSPACE-SWITCHED")
        }
        this.store.markTurnAccepted(turn.turnHandle)
        if (accepted.timeline !== null)
          this.store.applyTimeline(accepted.timeline)
        return {
          accepted: true,
          clientUserMessageId,
          turnHandle: turn.turnHandle,
        } as const
      })
      .catch((error: unknown) => {
        if (this.isCurrent(identity)) {
          this.store.markOperationError(
            safeErrorCode(error, "CODEX-TURN-START-FAILED"),
            true,
          )
        }
        throw error
      })
      .finally(() => {
        this.turnStart = null
      })
    this.turnStart = operation
    return operation
  }

  pickAttachments(
    workspaceId: string,
    existingHandles: readonly string[],
  ): Promise<AttachmentRegistrationResponse> {
    this.validateAttachmentRequest(workspaceId, existingHandles)
    return this.transport.request(codexCommands.pickAttachments, {
      workspaceId,
      existingHandles,
    })
  }

  registerAttachmentPaths(
    workspaceId: string,
    source: "drop" | "paste",
    paths: readonly string[],
    existingHandles: readonly string[],
  ): Promise<AttachmentRegistrationResponse> {
    this.validateAttachmentRequest(workspaceId, existingHandles)
    if (
      paths.length > 64 ||
      paths.some(
        (path) =>
          path.length === 0 || path.length > 4_096 || path.includes("\0"),
      )
    ) {
      throw new Error("CODEX-ATTACHMENT-PATHS-INVALID")
    }
    return this.transport.request(codexCommands.registerAttachmentPaths, {
      workspaceId,
      source,
      paths,
      existingHandles,
    })
  }

  async stopTurn(workspaceId: string): Promise<void> {
    const snapshot = this.store.snapshot()
    if (
      snapshot.activeWorkspaceId !== workspaceId ||
      snapshot.threadHandle === null ||
      snapshot.turnHandle === null ||
      !["running", "waiting", "stopping"].includes(snapshot.phase)
    ) {
      throw new Error("CODEX-TURN-NOT-ACTIVE")
    }
    this.store.markStopping()
    const generation = snapshot.generation
    if (generation === null) throw new Error("CODEX-GENERATION-UNAVAILABLE")
    const identity: ActivationIdentity = {
      token: this.activation,
      workspaceId,
      threadHandle: snapshot.threadHandle,
      generation,
    }
    const request = this.transport.request(codexCommands.turnInterrupt, {
      workspaceId,
      threadHandle: snapshot.threadHandle,
      turnHandle: snapshot.turnHandle,
    })
    try {
      const response = await timeout(
        request,
        5_000,
        this.clock,
        "CODEX-INTERRUPT-ACK-TIMEOUT",
      )
      if (!response.accepted) throw new Error("CODEX-INTERRUPT-REJECTED")
    } catch (error) {
      if (this.isCurrent(identity)) {
        this.store.markOperationError(
          safeErrorCode(error, "CODEX-INTERRUPT-FAILED"),
          true,
        )
      }
      throw error
    }
  }

  respondPending(request: CodexPendingResponseRequest): Promise<boolean> {
    return this.client.respondPending(request)
  }

  answerFallbackDecision(
    request: CodexFallbackDecisionRequest,
  ): Promise<boolean> {
    return this.client.answerFallbackDecision(request)
  }

  flushHistory(workspaceId: string): Promise<void> {
    return this.historyQueues.get(workspaceId) ?? Promise.resolve()
  }

  private validateAttachmentRequest(
    workspaceId: string,
    existingHandles: readonly string[],
  ): void {
    if (
      this.store.snapshot().activeWorkspaceId !== workspaceId ||
      existingHandles.length > 10 ||
      new Set(existingHandles).size !== existingHandles.length ||
      existingHandles.some((handle) => !attachmentHandlePattern.test(handle))
    ) {
      throw new Error("CODEX-ATTACHMENT-PREFLIGHT-BLOCKED")
    }
  }

  private receiveEvent(
    event: CodexEvent,
    result:
      | "applied"
      | "generation_advanced"
      | "duplicate"
      | "stale"
      | "out_of_order"
      | "workspace_mismatch",
  ): void {
    if (
      event.kind === "turn_status" &&
      terminalTurnStatuses.has(event.payload.status)
    ) {
      const key = executionKey(
        event.workspaceId,
        event.generation,
        event.payload.turnHandle,
      )
      this.observedTerminalEvents.set(key, event)
      if (this.observedTerminalEvents.size > 500) {
        const oldest = this.observedTerminalEvents.keys().next().value
        if (typeof oldest === "string")
          this.observedTerminalEvents.delete(oldest)
      }
      this.staleExecutions.delete(key)
      this.emitTerminalWorkUnit(key, event)
    }
    if (result === "duplicate" || result === "out_of_order") return
    const projection = this.projector.project(event)
    if (projection.history !== null) this.enqueueHistory(projection.history)
    if (result === "applied" || result === "generation_advanced") {
      this.store.syncSession(this.sessionStore.snapshot())
      if (projection.timeline !== null) {
        this.store.applyTimeline(projection.timeline)
      }
    }
  }

  private isCurrent(identity: ActivationIdentity): boolean {
    const current = this.store.snapshot()
    return (
      identity.token === this.activation &&
      current.activeWorkspaceId === identity.workspaceId &&
      current.threadHandle === identity.threadHandle &&
      current.generation === identity.generation
    )
  }

  private canApplyEvent(event: CodexEvent): boolean {
    const current = this.store.snapshot()
    if (
      current.activeWorkspaceId !== event.workspaceId ||
      current.generation === null ||
      current.generation !== event.generation ||
      current.threadHandle === null
    ) {
      return false
    }
    if (event.kind === "thread_status" || event.kind === "turn_status") {
      return event.payload.threadHandle === current.threadHandle
    }
    return true
  }

  private emitTerminalWorkUnit(key: string, event: TerminalTurnEvent): void {
    if (this.notifiedTerminalEventIds.has(event.eventId)) {
      this.observedTerminalEvents.delete(key)
      return
    }
    const accepted = this.acceptedWorkUnits.get(key)
    if (accepted === undefined) return
    this.notifiedTerminalEventIds.add(event.eventId)
    this.acceptedWorkUnits.delete(key)
    this.observedTerminalEvents.delete(key)
    if (this.notifiedTerminalEventIds.size > 500) {
      const oldest = this.notifiedTerminalEventIds.values().next().value
      if (typeof oldest === "string")
        this.notifiedTerminalEventIds.delete(oldest)
    }
    if (this.turnLifecycleSink === undefined) return
    const terminalEvent: CodexTerminalWorkUnitEvent = {
      schemaVersion: 1,
      workUnitId: accepted.workUnitId,
      workspaceId: event.workspaceId,
      generation: event.generation,
      threadHandle: event.payload.threadHandle,
      turnHandle: event.payload.turnHandle,
      terminalStatus: event.payload
        .status as CodexTerminalWorkUnitEvent["terminalStatus"],
      sourceEventId: event.eventId,
      sourceSequence: event.sequence,
      occurredAt: event.occurredAt,
      objective: accepted.objective,
      effort: accepted.effort,
      attachmentCount: accepted.attachmentCount,
    }
    try {
      void Promise.resolve(
        this.turnLifecycleSink.recordTerminal(terminalEvent),
      ).catch(() => undefined)
    } catch {
      // Git/checkpoint lifecycle failures are owned and surfaced by that sink.
    }
  }

  private enqueueHistory(event: CodexHistoryEvent): void {
    const previous =
      this.historyQueues.get(event.workspaceId) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        if (this.historyBlocked.has(event.workspaceId)) return
        await this.history.append(event)
      })
      .catch((error: unknown) => {
        this.historyBlocked.add(event.workspaceId)
        if (this.store.snapshot().activeWorkspaceId === event.workspaceId) {
          this.store.markHistoryFailure(
            safeErrorCode(error, "HIST-CODEX-EVENT-WRITE-FAILED"),
          )
        }
      })
    this.historyQueues.set(event.workspaceId, next)
  }
}
