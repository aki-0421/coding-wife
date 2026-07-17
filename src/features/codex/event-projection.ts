import type {
  ApprovalPendingRequest,
  CodexEvent,
  PendingRequestView,
} from "@/lib/contracts"

const maxStreamingText = 64 * 1024
const maxToolText = 16 * 1024

export type CodexSemanticKind =
  | "thread"
  | "turn"
  | "user"
  | "assistant"
  | "plan"
  | "tool"
  | "file"
  | "diff"
  | "decision"
  | "approval"
  | "request_resolved"
  | "error"
  | "completion"
  | "status"

interface CodexTimelineEventBase {
  readonly id: string
  readonly stableId: string
  readonly sourceEventId: string
  readonly workspaceId: string
  readonly generation: number
  readonly sourceSequence: number
  readonly occurredAt: string
  readonly kind: CodexSemanticKind
  readonly status: string
  readonly durable: boolean
}

export type CodexSemanticTimelineEvent = CodexTimelineEventBase &
  (
    | {
        readonly kind: "thread"
        readonly threadHandle: string
      }
    | {
        readonly kind: "turn" | "completion"
        readonly threadHandle: string
        readonly turnHandle: string
      }
    | {
        readonly kind: "user"
        readonly text: string
        readonly effort: "low" | "max"
      }
    | {
        readonly kind: "assistant"
        readonly itemHandle: string
        readonly text: string
      }
    | {
        readonly kind: "plan"
        readonly stepCount: number
      }
    | {
        readonly kind: "tool"
        readonly itemHandle: string
        readonly toolKind: string
        readonly excerpt: string | null
      }
    | {
        readonly kind: "file"
        readonly itemHandle: string
        readonly pathAlias: string | null
        readonly changeKind: string | null
      }
    | {
        readonly kind: "diff"
        readonly byteCount: number
        readonly detailRef: string
      }
    | {
        readonly kind: "decision" | "approval"
        readonly request: PendingRequestView
      }
    | {
        readonly kind: "request_resolved"
        readonly pendingId: string
      }
    | {
        readonly kind: "error"
        readonly errorCode: string
        readonly detailRef: string | null
        readonly willRetry: boolean
      }
    | {
        readonly kind: "status"
        readonly itemHandle: string | null
        readonly itemType: string | null
        readonly detailRef: string | null
      }
  )

export type CodexHistoryEventKind =
  | "code.thread.status.changed"
  | "code.session.status.changed"
  | "code.user.instruction.accepted"
  | "code.item.status.changed"
  | "code.message.completed"
  | "code.plan.updated"
  | "code.diff.updated"
  | "code.tool.output"
  | "code.file_change.updated"
  | "code.decision.requested"
  | "code.approval.requested"
  | "code.pending.resolved"
  | "code.session.diagnostic"
  | "code.model.violation"
  | "code.protocol.unsupported"

export interface CodexHistoryEvent {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly workspaceId: string
  readonly sessionId: null
  readonly producer: "code"
  readonly kind: CodexHistoryEventKind
  readonly occurredAt: string
  readonly payload: Readonly<Record<string, unknown>>
}

export interface CodexEventProjection {
  readonly timeline: CodexSemanticTimelineEvent | null
  readonly history: CodexHistoryEvent | null
}

export interface AcceptedUserTurn {
  readonly eventId: string
  readonly workspaceId: string
  readonly generation: number
  readonly sourceSequence: number
  readonly occurredAt: string
  readonly text: string
  readonly effort: "low" | "max"
}

function appendBounded(
  previous: string,
  next: string,
  maximum: number,
): string {
  const combined = previous + next
  return combined.length <= maximum
    ? combined
    : combined.slice(combined.length - maximum)
}

function stableId(event: CodexEvent, scope: string, handle = "active"): string {
  return `${event.workspaceId}:${String(event.generation)}:${scope}:${handle}`
}

function base(
  event: CodexEvent,
  kind: CodexSemanticKind,
  status: string,
  stable: string,
  durable: boolean,
): CodexTimelineEventBase {
  return {
    id: durable ? event.eventId : stable,
    stableId: stable,
    sourceEventId: event.eventId,
    workspaceId: event.workspaceId,
    generation: event.generation,
    sourceSequence: event.sequence,
    occurredAt: event.occurredAt,
    kind,
    status,
    durable,
  }
}

function history(
  event: CodexEvent,
  kind: CodexHistoryEventKind,
  payload: Readonly<Record<string, unknown>>,
): CodexHistoryEvent {
  return {
    schemaVersion: 1,
    eventId: event.eventId,
    workspaceId: event.workspaceId,
    sessionId: null,
    producer: "code",
    kind,
    occurredAt: event.occurredAt,
    payload: {
      generation: event.generation,
      sourceSequence: event.sequence,
      ...payload,
    },
  }
}

function isApproval(
  request: PendingRequestView,
): request is ApprovalPendingRequest {
  return request.kind !== "user_input"
}

function turnKind(status: string): "turn" | "completion" | "error" {
  if (status === "completed") return "completion"
  if (status === "running" || status === "inProgress") return "turn"
  return "error"
}

export class CodexEventProjector {
  private readonly assistantText = new Map<string, string>()
  private readonly toolText = new Map<string, string>()

  project(event: CodexEvent): CodexEventProjection {
    switch (event.kind) {
      case "thread_status": {
        const stable = stableId(event, "thread", event.payload.threadHandle)
        return {
          timeline: {
            ...base(event, "thread", event.payload.status, stable, true),
            kind: "thread",
            threadHandle: event.payload.threadHandle,
          },
          history: history(event, "code.thread.status.changed", {
            threadHandle: event.payload.threadHandle,
            status: event.payload.status,
          }),
        }
      }
      case "turn_status": {
        const semanticKind = turnKind(event.payload.status)
        const stable = stableId(event, "turn", event.payload.turnHandle)
        const common = {
          ...base(event, semanticKind, event.payload.status, stable, true),
          threadHandle: event.payload.threadHandle,
          turnHandle: event.payload.turnHandle,
        }
        const timeline: CodexSemanticTimelineEvent =
          semanticKind === "error"
            ? {
                ...common,
                kind: "error",
                errorCode:
                  event.payload.status === "interrupted"
                    ? "CODEX-TURN-INTERRUPTED"
                    : "CODEX-TURN-FAILED",
                detailRef: null,
                willRetry: false,
              }
            : { ...common, kind: semanticKind }
        return {
          timeline,
          history: history(event, "code.session.status.changed", {
            threadHandle: event.payload.threadHandle,
            turnHandle: event.payload.turnHandle,
            status: event.payload.status,
          }),
        }
      }
      case "item_status": {
        const stable = stableId(event, "item", event.payload.itemHandle)
        const itemType = event.payload.itemType
        let timeline: CodexSemanticTimelineEvent
        if (
          ["commandExecution", "mcpToolCall", "webSearch"].includes(itemType)
        ) {
          timeline = {
            ...base(event, "tool", event.payload.status, stable, true),
            kind: "tool",
            itemHandle: event.payload.itemHandle,
            toolKind: itemType,
            excerpt: this.toolText.get(stable) ?? null,
          }
        } else if (itemType === "fileChange") {
          timeline = {
            ...base(event, "file", event.payload.status, stable, true),
            kind: "file",
            itemHandle: event.payload.itemHandle,
            pathAlias: null,
            changeKind: null,
          }
        } else {
          timeline = {
            ...base(event, "status", event.payload.status, stable, true),
            kind: "status",
            itemHandle: event.payload.itemHandle,
            itemType,
            detailRef: null,
          }
        }
        return {
          timeline,
          history: history(event, "code.item.status.changed", {
            itemHandle: event.payload.itemHandle,
            itemType,
            status: event.payload.status,
          }),
        }
      }
      case "agent_message_delta": {
        const stable = stableId(event, "assistant", event.payload.itemHandle)
        const text = appendBounded(
          this.assistantText.get(stable) ?? "",
          event.payload.delta,
          maxStreamingText,
        )
        this.assistantText.set(stable, text)
        return {
          timeline: {
            ...base(event, "assistant", "streaming", stable, false),
            kind: "assistant",
            itemHandle: event.payload.itemHandle,
            text,
          },
          history: null,
        }
      }
      case "agent_message_completed": {
        const stable = stableId(event, "assistant", event.payload.itemHandle)
        this.assistantText.delete(stable)
        return {
          timeline: {
            ...base(event, "assistant", "completed", stable, true),
            kind: "assistant",
            itemHandle: event.payload.itemHandle,
            text: event.payload.text,
          },
          history: history(event, "code.message.completed", {
            itemHandle: event.payload.itemHandle,
            text: event.payload.text,
          }),
        }
      }
      case "plan_updated": {
        const stable = stableId(event, "plan")
        return {
          timeline: {
            ...base(event, "plan", "updated", stable, true),
            kind: "plan",
            stepCount: event.payload.stepCount,
          },
          history: history(event, "code.plan.updated", {
            stepCount: event.payload.stepCount,
          }),
        }
      }
      case "diff_updated": {
        const stable = stableId(event, "diff")
        return {
          timeline: {
            ...base(event, "diff", "updated", stable, true),
            kind: "diff",
            byteCount: event.payload.byteCount,
            detailRef: event.payload.detailRef,
          },
          history: history(event, "code.diff.updated", event.payload),
        }
      }
      case "tool_output": {
        const stable = stableId(event, "item", event.payload.itemHandle)
        const excerpt = appendBounded(
          this.toolText.get(stable) ?? "",
          event.payload.excerpt,
          maxToolText,
        )
        this.toolText.set(stable, excerpt)
        return {
          timeline: {
            ...base(event, "tool", "streaming", stable, true),
            kind: "tool",
            itemHandle: event.payload.itemHandle,
            toolKind: "commandExecution",
            excerpt,
          },
          history: history(event, "code.tool.output", {
            itemHandle: event.payload.itemHandle,
            excerpt: event.payload.excerpt,
          }),
        }
      }
      case "file_change": {
        const stable = stableId(event, "item", event.payload.itemHandle)
        return {
          timeline: {
            ...base(event, "file", "updated", stable, true),
            kind: "file",
            itemHandle: event.payload.itemHandle,
            pathAlias: event.payload.pathAlias,
            changeKind: event.payload.changeKind,
          },
          history: history(event, "code.file_change.updated", event.payload),
        }
      }
      case "pending_request": {
        const request = event.payload.request
        const approval = isApproval(request)
        const stable = stableId(event, "pending", request.pendingId)
        return {
          timeline: {
            ...base(
              event,
              approval ? "approval" : "decision",
              "waiting",
              stable,
              true,
            ),
            kind: approval ? "approval" : "decision",
            request,
          },
          history: history(
            event,
            approval ? "code.approval.requested" : "code.decision.requested",
            { request },
          ),
        }
      }
      case "pending_request_resolved": {
        const stable = stableId(event, "pending", event.payload.pendingId)
        return {
          timeline: {
            ...base(
              event,
              "request_resolved",
              event.payload.status,
              stable,
              true,
            ),
            kind: "request_resolved",
            pendingId: event.payload.pendingId,
          },
          history: history(event, "code.pending.resolved", event.payload),
        }
      }
      case "diagnostic": {
        const stable = stableId(event, "diagnostic", event.payload.detailRef)
        return {
          timeline: {
            ...base(
              event,
              "error",
              event.payload.willRetry ? "retrying" : "failed",
              stable,
              true,
            ),
            kind: "error",
            errorCode: event.payload.code,
            detailRef: event.payload.detailRef,
            willRetry: event.payload.willRetry,
          },
          history: history(event, "code.session.diagnostic", event.payload),
        }
      }
      case "model_violation": {
        const stable = stableId(event, "model_violation")
        return {
          timeline: {
            ...base(event, "error", "failed", stable, true),
            kind: "error",
            errorCode: "CODEX-MODEL-VIOLATION",
            detailRef: null,
            willRetry: false,
          },
          history: history(event, "code.model.violation", event.payload),
        }
      }
      case "protocol_unsupported": {
        const stable = stableId(event, "protocol", event.payload.methodHash)
        return {
          timeline: {
            ...base(event, "error", "blocked", stable, true),
            kind: "error",
            errorCode: "CODEX-PROTOCOL-UNSUPPORTED",
            detailRef: event.payload.detailRef,
            willRetry: false,
          },
          history: history(event, "code.protocol.unsupported", event.payload),
        }
      }
    }
  }
}

export function projectAcceptedUserTurn(
  accepted: AcceptedUserTurn,
): CodexEventProjection {
  const stable = `${accepted.workspaceId}:${String(accepted.generation)}:user:${accepted.eventId}`
  const timeline: CodexSemanticTimelineEvent = {
    id: accepted.eventId,
    stableId: stable,
    sourceEventId: accepted.eventId,
    workspaceId: accepted.workspaceId,
    generation: accepted.generation,
    sourceSequence: accepted.sourceSequence,
    occurredAt: accepted.occurredAt,
    kind: "user",
    status: "accepted",
    durable: true,
    text: accepted.text,
    effort: accepted.effort,
  }
  return {
    timeline,
    history: {
      schemaVersion: 1,
      eventId: accepted.eventId,
      workspaceId: accepted.workspaceId,
      sessionId: null,
      producer: "code",
      kind: "code.user.instruction.accepted",
      occurredAt: accepted.occurredAt,
      payload: {
        generation: accepted.generation,
        sourceSequence: accepted.sourceSequence,
        text: accepted.text,
        effort: accepted.effort,
      },
    },
  }
}
