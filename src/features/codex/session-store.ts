import type {
  CodexEvent,
  CodexPendingResponseRequest,
  PendingRequestView,
} from "@/lib/contracts"

export type CodexEventApplyResult =
  | "applied"
  | "generation_advanced"
  | "duplicate"
  | "stale"
  | "out_of_order"
  | "workspace_mismatch"

export interface CodexSessionSnapshot {
  readonly workspaceId: string | null
  readonly generation: number | null
  readonly lastSequence: number
  readonly turnStatus: string
  readonly activeThreadHandle: string | null
  readonly activeTurnHandle: string | null
  readonly events: readonly CodexEvent[]
  readonly pendingRequests: readonly PendingRequestView[]
  readonly completedMessages: Readonly<Record<string, string>>
}

type StoreListener = (snapshot: CodexSessionSnapshot) => void

const terminalTurnStatuses = new Set([
  "completed",
  "failed",
  "interrupted",
  "canceled",
])

export class CodexSessionStore {
  private workspaceId: string | null = null
  private generation: number | null = null
  private lastSequence = 0
  private turnStatus = "idle"
  private activeThreadHandle: string | null = null
  private activeTurnHandle: string | null = null
  private events: CodexEvent[] = []
  private readonly seenEventIds = new Set<string>()
  private readonly pendingRequests = new Map<string, PendingRequestView>()
  private readonly claimedPendingResponses = new Set<string>()
  private readonly completedMessages = new Map<string, string>()
  private readonly listeners = new Set<StoreListener>()

  constructor(private readonly eventLimit = 500) {
    if (!Number.isSafeInteger(eventLimit) || eventLimit < 1) {
      throw new RangeError("eventLimit must be a positive integer")
    }
  }

  snapshot(): CodexSessionSnapshot {
    return {
      workspaceId: this.workspaceId,
      generation: this.generation,
      lastSequence: this.lastSequence,
      turnStatus: this.turnStatus,
      activeThreadHandle: this.activeThreadHandle,
      activeTurnHandle: this.activeTurnHandle,
      events: [...this.events],
      pendingRequests: [...this.pendingRequests.values()],
      completedMessages: Object.fromEntries(this.completedMessages),
    }
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  apply(event: CodexEvent): CodexEventApplyResult {
    let result: CodexEventApplyResult = "applied"
    if (this.generation === null || event.generation > this.generation) {
      result = this.generation === null ? "applied" : "generation_advanced"
      this.resetForGeneration(event.workspaceId, event.generation)
    } else if (event.generation < this.generation) {
      return "stale"
    } else if (event.workspaceId !== this.workspaceId) {
      return "workspace_mismatch"
    }

    if (this.seenEventIds.has(event.eventId)) return "duplicate"
    if (event.sequence <= this.lastSequence) return "out_of_order"

    this.seenEventIds.add(event.eventId)
    this.lastSequence = event.sequence
    this.events.push(event)
    if (this.events.length > this.eventLimit) {
      const removed = this.events.shift()
      if (removed !== undefined) this.seenEventIds.delete(removed.eventId)
    }
    this.reduce(event)
    this.notify()
    return result
  }

  claimPendingResponse(pendingId: string): boolean {
    if (
      !this.pendingRequests.has(pendingId) ||
      this.claimedPendingResponses.has(pendingId)
    ) {
      return false
    }
    this.claimedPendingResponses.add(pendingId)
    return true
  }

  releasePendingResponse(pendingId: string): void {
    this.claimedPendingResponses.delete(pendingId)
  }

  completePendingResponse(pendingId: string): void {
    this.claimedPendingResponses.delete(pendingId)
    if (this.pendingRequests.delete(pendingId)) this.notify()
  }

  hasPendingRequest(request: CodexPendingResponseRequest): boolean {
    return (
      request.workspaceId === this.workspaceId &&
      this.pendingRequests.has(request.pendingId)
    )
  }

  private resetForGeneration(workspaceId: string, generation: number): void {
    this.workspaceId = workspaceId
    this.generation = generation
    this.lastSequence = 0
    this.turnStatus = "idle"
    this.activeThreadHandle = null
    this.activeTurnHandle = null
    this.events = []
    this.seenEventIds.clear()
    this.pendingRequests.clear()
    this.claimedPendingResponses.clear()
    this.completedMessages.clear()
  }

  private reduce(event: CodexEvent): void {
    switch (event.kind) {
      case "thread_status":
        this.activeThreadHandle = event.payload.threadHandle
        break
      case "turn_status":
        this.activeThreadHandle = event.payload.threadHandle
        this.activeTurnHandle = event.payload.turnHandle
        this.turnStatus = event.payload.status
        if (terminalTurnStatuses.has(event.payload.status)) {
          this.pendingRequests.clear()
          this.claimedPendingResponses.clear()
        }
        break
      case "agent_message_completed":
        this.completedMessages.set(event.payload.itemHandle, event.payload.text)
        break
      case "pending_request":
        this.pendingRequests.set(
          event.payload.request.pendingId,
          event.payload.request,
        )
        break
      default:
        break
    }
  }

  private notify(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
