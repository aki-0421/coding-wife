import type { CodexDiagnostic, PendingRequestView } from "@/lib/contracts"

import type { CodexSemanticTimelineEvent } from "@/features/codex/event-projection"
import type { CodexSessionSnapshot } from "@/features/codex/session-store"

export type CodexWorkspacePhase =
  | "idle"
  | "connecting"
  | "blocked"
  | "ready"
  | "running"
  | "waiting"
  | "stopping"
  | "interrupted"
  | "failed"
  | "completed"

export type CodexHistoryMode = "ready" | "read_only" | "recovery_required"

export interface CodexReadiness {
  readonly ready: boolean
  readonly fastAvailable: boolean
  readonly maxAvailable: boolean
  readonly reasonCode: string | null
}

export interface CodexWorkspaceSessionSnapshot {
  readonly activeWorkspaceId: string | null
  readonly phase: CodexWorkspacePhase
  readonly connected: boolean
  readonly historyMode: CodexHistoryMode
  readonly historyWritable: boolean
  readonly diagnostic: CodexDiagnostic | null
  readonly readiness: CodexReadiness
  readonly generation: number | null
  readonly lastSequence: number
  readonly threadHandle: string | null
  readonly turnHandle: string | null
  readonly pendingRequests: readonly PendingRequestView[]
  readonly timeline: readonly CodexSemanticTimelineEvent[]
  readonly errorCode: string | null
}

type StoreListener = (snapshot: CodexWorkspaceSessionSnapshot) => void

const unavailableReadiness: CodexReadiness = {
  ready: false,
  fastAvailable: false,
  maxAvailable: false,
  reasonCode: "CODEX-NOT-CONNECTED",
}

export function evaluateCodexReadiness(
  diagnostic: CodexDiagnostic,
  historyMode: CodexHistoryMode,
): CodexReadiness {
  const fastAvailable = diagnostic.modelAvailable && diagnostic.fastAvailable
  const maxAvailable = diagnostic.modelAvailable && diagnostic.maxAvailable
  const ready =
    historyMode === "ready" &&
    diagnostic.health === "ready" &&
    diagnostic.childState === "ready" &&
    diagnostic.accountPresent &&
    diagnostic.modelAvailable &&
    fastAvailable &&
    maxAvailable &&
    diagnostic.capabilities.coreLifecycle === "supported" &&
    diagnostic.capabilities.modelDiscovery === "supported"

  let reasonCode: string | null = null
  if (historyMode !== "ready") {
    reasonCode = "HIST-WRITER-NOT-READY"
  } else if (diagnostic.health !== "ready") {
    reasonCode =
      diagnostic.errorCode ?? `CODEX-${diagnostic.health.toUpperCase()}`
  } else if (!diagnostic.accountPresent) {
    reasonCode = "CODEX-AUTH-REQUIRED"
  } else if (!diagnostic.modelAvailable) {
    reasonCode = "CODEX-SOL-UNAVAILABLE"
  } else if (!fastAvailable || !maxAvailable) {
    reasonCode = "CODEX-EFFORT-UNAVAILABLE"
  } else if (
    diagnostic.capabilities.coreLifecycle !== "supported" ||
    diagnostic.capabilities.modelDiscovery !== "supported"
  ) {
    reasonCode = "CODEX-CAPABILITY-UNAVAILABLE"
  } else if (diagnostic.childState !== "ready") {
    reasonCode = "CODEX-CHILD-NOT-READY"
  }

  return { ready, fastAvailable, maxAvailable, reasonCode }
}

function phaseFromSession(
  session: CodexSessionSnapshot,
  current: CodexWorkspacePhase,
): CodexWorkspacePhase {
  switch (session.turnStatus) {
    case "completed":
      return "completed"
    case "interrupted":
    case "canceled":
      return "interrupted"
    case "failed":
      return "failed"
    default:
      break
  }
  if (current === "stopping") return current
  if (session.pendingRequests.length > 0) return "waiting"
  if (["running", "inProgress"].includes(session.turnStatus)) return "running"
  return current === "connecting" || current === "blocked" ? current : "ready"
}

export class CodexWorkspaceSessionStore {
  private current: CodexWorkspaceSessionSnapshot = {
    activeWorkspaceId: null,
    phase: "idle",
    connected: false,
    historyMode: "ready",
    historyWritable: true,
    diagnostic: null,
    readiness: unavailableReadiness,
    generation: null,
    lastSequence: 0,
    threadHandle: null,
    turnHandle: null,
    pendingRequests: [],
    timeline: [],
    errorCode: null,
  }
  private readonly timeline = new Map<string, CodexSemanticTimelineEvent>()
  private readonly listeners = new Set<StoreListener>()

  constructor(private readonly timelineLimit = 500) {
    if (!Number.isSafeInteger(timelineLimit) || timelineLimit < 1) {
      throw new RangeError("timelineLimit must be a positive integer")
    }
  }

  snapshot = (): CodexWorkspaceSessionSnapshot => this.current

  subscribe = (listener: StoreListener): (() => void) => {
    this.listeners.add(listener)
    listener(this.current)
    return () => this.listeners.delete(listener)
  }

  beginActivation(workspaceId: string, historyMode: CodexHistoryMode): void {
    this.timeline.clear()
    this.update({
      activeWorkspaceId: workspaceId,
      phase: "connecting",
      connected: false,
      historyMode,
      historyWritable: historyMode === "ready",
      diagnostic: null,
      readiness: unavailableReadiness,
      generation: null,
      lastSequence: 0,
      threadHandle: null,
      turnHandle: null,
      pendingRequests: [],
      timeline: [],
      errorCode: null,
    })
  }

  applyDiagnostic(diagnostic: CodexDiagnostic): CodexReadiness {
    const readiness = evaluateCodexReadiness(
      diagnostic,
      this.current.historyMode,
    )
    this.update({
      ...this.current,
      diagnostic,
      readiness,
      phase: readiness.ready ? "connecting" : "blocked",
      connected: false,
      errorCode: readiness.reasonCode,
    })
    return readiness
  }

  markThreadReady(threadHandle: string, generation: number): void {
    if (
      threadHandle.trim().length === 0 ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      throw new RangeError("threadHandle and generation must be valid")
    }
    this.update({
      ...this.current,
      generation,
      threadHandle,
      phase: "ready",
      connected: this.current.readiness.ready && this.current.historyWritable,
      errorCode: null,
    })
  }

  markTurnAccepted(turnHandle: string): void {
    this.update({
      ...this.current,
      turnHandle,
      phase: "running",
      errorCode: null,
    })
  }

  markStopping(): void {
    this.update({ ...this.current, phase: "stopping", errorCode: null })
  }

  markOperationError(errorCode: string, connected = false): void {
    this.update({
      ...this.current,
      phase: "failed",
      connected,
      errorCode,
    })
  }

  markHistoryFailure(errorCode: string): void {
    this.update({
      ...this.current,
      phase: "failed",
      connected: false,
      historyWritable: false,
      errorCode,
    })
  }

  syncSession(session: CodexSessionSnapshot): void {
    if (
      this.current.activeWorkspaceId === null ||
      session.workspaceId !== this.current.activeWorkspaceId
    ) {
      return
    }
    this.update({
      ...this.current,
      phase: phaseFromSession(session, this.current.phase),
      generation: session.generation,
      lastSequence: session.lastSequence,
      threadHandle: session.activeThreadHandle ?? this.current.threadHandle,
      turnHandle: session.activeTurnHandle ?? this.current.turnHandle,
      pendingRequests: session.pendingRequests,
    })
  }

  applyTimeline(event: CodexSemanticTimelineEvent): boolean {
    if (
      this.current.activeWorkspaceId !== event.workspaceId ||
      (this.current.generation !== null &&
        this.current.generation !== event.generation)
    ) {
      return false
    }
    this.timeline.set(event.stableId, event)
    if (this.timeline.size > this.timelineLimit) {
      const oldest = [...this.timeline.values()].sort(
        (left, right) => left.sourceSequence - right.sourceSequence,
      )[0]
      if (oldest !== undefined) this.timeline.delete(oldest.stableId)
    }
    this.update({
      ...this.current,
      timeline: [...this.timeline.values()].sort(
        (left, right) => left.sourceSequence - right.sourceSequence,
      ),
    })
    return true
  }

  private update(snapshot: CodexWorkspaceSessionSnapshot): void {
    this.current = snapshot
    for (const listener of this.listeners) listener(snapshot)
  }
}
