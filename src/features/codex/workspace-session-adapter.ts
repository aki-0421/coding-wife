import {
  codexCommands,
  type AttachmentRegistrationResponse,
  type CodexDiagnostic,
  type CodexEvent,
  type CodexFallbackDecisionRequest,
  type CodexPendingResponseRequest,
  type ReasoningPreset,
} from "@/lib/contracts"

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
  readonly effort: ReasoningPreset
  readonly attachmentHandles: readonly string[]
}

export interface StartCodexTurnResult {
  readonly accepted: true
  readonly clientUserMessageId: string
  readonly turnHandle: string
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

  constructor(
    readonly transport: CodexTransport,
    private readonly history: CodexHistorySink,
    options: {
      readonly sessionStore?: CodexSessionStore
      readonly store?: CodexWorkspaceSessionStore
      readonly clock?: CodexSessionClock
      readonly createId?: () => string
    } = {},
  ) {
    this.sessionStore = options.sessionStore ?? new CodexSessionStore()
    this.store = options.store ?? new CodexWorkspaceSessionStore()
    this.clock = options.clock ?? systemClock
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID())
    this.client = new CodexSessionClient(transport, this.sessionStore)
  }

  private readonly clock: CodexSessionClock
  private readonly createId: () => string

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
    if (
      snapshot.activeWorkspaceId !== request.workspaceId ||
      !snapshot.connected ||
      snapshot.threadHandle === null ||
      snapshot.phase === "running" ||
      snapshot.phase === "waiting" ||
      snapshot.phase === "stopping" ||
      (request.text.trim().length === 0 &&
        request.attachmentHandles.length === 0) ||
      request.text.length > 32_000 ||
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
      .then((turn) => {
        const latest = this.store.snapshot()
        if (latest.activeWorkspaceId !== request.workspaceId) {
          throw new Error("CODEX-WORKSPACE-SWITCHED")
        }
        this.store.markTurnAccepted(turn.turnHandle)
        const accepted = projectAcceptedUserTurn({
          eventId: clientUserMessageId,
          workspaceId: request.workspaceId,
          generation,
          sourceSequence,
          occurredAt: this.clock.now(),
          text: request.text,
          effort: request.effort,
          attachmentCount: request.attachmentHandles.length,
        })
        if (accepted.timeline !== null)
          this.store.applyTimeline(accepted.timeline)
        if (accepted.history !== null) this.enqueueHistory(accepted.history)
        return {
          accepted: true,
          clientUserMessageId,
          turnHandle: turn.turnHandle,
        } as const
      })
      .catch((error: unknown) => {
        this.store.markOperationError(
          safeErrorCode(error, "CODEX-TURN-START-FAILED"),
          true,
        )
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
      this.store.markOperationError(
        safeErrorCode(error, "CODEX-INTERRUPT-FAILED"),
        true,
      )
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
