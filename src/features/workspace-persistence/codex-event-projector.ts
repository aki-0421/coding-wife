import type { PendingRequestView } from "@/lib/contracts"
import type { PersistedTimelineEvent } from "@/lib/contracts/workspace-history"
import { unicodeScalarCount } from "@/lib/public-text"
import {
  isInternalConnectionDiagnosticCode,
  sanitizeToolSummary,
  type CodexSemanticTimelineEvent,
} from "@/features/codex/event-projection"

const maxToolTextScalars = 16 * 1024
function appendBoundedScalars(
  previous: string,
  next: string,
  maximum: number,
): string {
  const combined = previous + next
  if (unicodeScalarCount(combined) <= maximum) return combined
  return Array.from(combined).slice(-maximum).join("")
}

function stableId(
  event: PersistedTimelineEvent,
  generation: number,
  scope: string,
  handle = "active",
): string {
  return `${event.workspaceId}:${String(generation)}:${scope}:${handle}`
}

interface PersistedSemanticBase {
  readonly id: string
  readonly stableId: string
  readonly sourceEventId: string
  readonly workspaceId: string
  readonly generation: number
  readonly sourceSequence: number
  readonly occurredAt: string
  readonly status: string
  readonly durable: true
}

function base(
  event: PersistedTimelineEvent,
  generation: number,
  sourceSequence: number,
  status: string,
  stable: string,
): PersistedSemanticBase {
  return {
    id: event.eventId,
    stableId: stable,
    sourceEventId: event.eventId,
    workspaceId: event.workspaceId,
    generation,
    sourceSequence,
    occurredAt: event.occurredAt,
    status,
    durable: true,
  }
}

function stringField(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string {
  return payload[key] as string
}

function numberField(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): number {
  return payload[key] as number
}

function codexBase(event: PersistedTimelineEvent): {
  readonly generation: number
  readonly sourceSequence: number
} | null {
  if (
    event.producer !== "code" ||
    event.kind === "code.unsupported" ||
    event.payload.semanticVersion !== 1
  ) {
    return null
  }
  return {
    generation: numberField(event.payload, "generation"),
    sourceSequence: numberField(event.payload, "sourceSequence"),
  }
}

function turnKind(status: string): "turn" | "completion" | "error" {
  if (status === "completed") return "completion"
  if (status === "running" || status === "inProgress") return "turn"
  return "error"
}

export function isHiddenCodexHistoryEvent(
  event: PersistedTimelineEvent,
): boolean {
  return (
    event.producer === "code" &&
    event.kind === "code.item.status.changed" &&
    event.payload.semanticVersion === 1 &&
    ["userMessage", "agentMessage"].includes(
      stringField(event.payload, "itemType"),
    )
  )
}

function legacyToolMetadata(toolKind: string) {
  return {
    toolKind,
    providerName: null,
    toolName:
      toolKind === "commandExecution"
        ? "shell"
        : toolKind === "webSearch"
          ? "search"
          : "MCP",
    summary: null,
    durationMs: null,
  } as const
}

export class PersistedCodexEventProjector {
  private readonly toolText = new Map<string, string>()
  private readonly toolMetadata = new Map<
    string,
    {
      readonly toolKind: string
      readonly providerName: string | null
      readonly toolName: string
      readonly summary: string | null
      readonly durationMs: number | null
    }
  >()
  private readonly fileChanges = new Map<
    string,
    { readonly pathAlias: string; readonly changeKind: string }
  >()

  project(event: PersistedTimelineEvent): CodexSemanticTimelineEvent | null {
    const persistedBase = codexBase(event)
    if (persistedBase === null) return null
    const { generation, sourceSequence } = persistedBase
    const payload = event.payload

    switch (event.kind) {
      case "code.thread.status.changed": {
        const threadHandle = stringField(payload, "threadHandle")
        return {
          ...base(
            event,
            generation,
            sourceSequence,
            stringField(payload, "status"),
            stableId(event, generation, "thread", threadHandle),
          ),
          kind: "thread",
          threadHandle,
        }
      }
      case "code.session.status.changed": {
        const status = stringField(payload, "status")
        const semanticKind = turnKind(status)
        const threadHandle = stringField(payload, "threadHandle")
        const turnHandle = stringField(payload, "turnHandle")
        const common = {
          ...base(
            event,
            generation,
            sourceSequence,
            status,
            stableId(event, generation, "turn", turnHandle),
          ),
          threadHandle,
          turnHandle,
        }
        return semanticKind === "error"
          ? {
              ...common,
              kind: "error",
              errorCode:
                status === "interrupted"
                  ? "CODEX-TURN-INTERRUPTED"
                  : "CODEX-TURN-FAILED",
              detailRef: null,
              willRetry: false,
            }
          : { ...common, kind: semanticKind }
      }
      case "code.user.instruction.accepted":
        return {
          ...base(
            event,
            generation,
            sourceSequence,
            "accepted",
            stableId(event, generation, "user", event.eventId),
          ),
          kind: "user",
          text: stringField(payload, "text"),
          effort: payload.effort as "low" | "max",
          attachmentCount: numberField(payload, "attachmentCount"),
        }
      case "code.item.status.changed": {
        const itemHandle = stringField(payload, "itemHandle")
        const itemType = stringField(payload, "itemType")
        const status = stringField(payload, "status")
        const stable = stableId(event, generation, "item", itemHandle)
        if (isHiddenCodexHistoryEvent(event)) return null
        if (
          ["commandExecution", "mcpToolCall", "webSearch"].includes(itemType)
        ) {
          const metadata = legacyToolMetadata(itemType)
          this.toolMetadata.set(stable, metadata)
          return {
            ...base(event, generation, sourceSequence, status, stable),
            kind: "tool",
            itemHandle,
            ...metadata,
            excerpt: this.toolText.get(stable) ?? null,
          }
        }
        if (itemType === "fileChange") {
          const change = this.fileChanges.get(stable)
          return {
            ...base(event, generation, sourceSequence, status, stable),
            kind: "file",
            itemHandle,
            pathAlias: change?.pathAlias ?? null,
            changeKind: change?.changeKind ?? null,
          }
        }
        return {
          ...base(event, generation, sourceSequence, status, stable),
          kind: "status",
          itemHandle,
          itemType,
          detailRef: null,
        }
      }
      case "code.tool.status.changed": {
        const itemHandle = stringField(payload, "itemHandle")
        const stable = stableId(event, generation, "item", itemHandle)
        const metadata = {
          toolKind: stringField(payload, "toolKind"),
          providerName: payload.providerName as string | null,
          toolName: stringField(payload, "toolName"),
          summary: sanitizeToolSummary(payload.summary as string | null),
          durationMs: payload.durationMs as number | null,
        }
        this.toolMetadata.set(stable, metadata)
        return {
          ...base(
            event,
            generation,
            sourceSequence,
            stringField(payload, "status"),
            stable,
          ),
          kind: "tool",
          itemHandle,
          ...metadata,
          excerpt: this.toolText.get(stable) ?? null,
        }
      }
      case "code.message.completed": {
        const itemHandle = stringField(payload, "itemHandle")
        return {
          ...base(
            event,
            generation,
            sourceSequence,
            "completed",
            stableId(event, generation, "assistant", itemHandle),
          ),
          kind: "assistant",
          itemHandle,
          text: stringField(payload, "text"),
        }
      }
      case "code.plan.updated":
        return {
          ...base(
            event,
            generation,
            sourceSequence,
            "updated",
            stableId(event, generation, "plan"),
          ),
          kind: "plan",
          stepCount: numberField(payload, "stepCount"),
        }
      case "code.diff.updated":
        return {
          ...base(
            event,
            generation,
            sourceSequence,
            "updated",
            stableId(event, generation, "diff"),
          ),
          kind: "diff",
          byteCount: numberField(payload, "byteCount"),
          detailRef: stringField(payload, "detailRef"),
        }
      case "code.tool.output": {
        const itemHandle = stringField(payload, "itemHandle")
        const stable = stableId(event, generation, "item", itemHandle)
        const excerpt = appendBoundedScalars(
          this.toolText.get(stable) ?? "",
          stringField(payload, "excerpt"),
          maxToolTextScalars,
        )
        this.toolText.set(stable, excerpt)
        const metadata = this.toolMetadata.get(stable) ?? {
          toolKind: "commandExecution",
          providerName: null,
          toolName: "shell",
          summary: null,
          durationMs: null,
        }
        return {
          ...base(event, generation, sourceSequence, "streaming", stable),
          kind: "tool",
          itemHandle,
          ...metadata,
          excerpt,
        }
      }
      case "code.file_change.updated": {
        const itemHandle = stringField(payload, "itemHandle")
        const stable = stableId(event, generation, "item", itemHandle)
        const change = {
          pathAlias: stringField(payload, "pathAlias"),
          changeKind: stringField(payload, "changeKind"),
        }
        this.fileChanges.set(stable, change)
        return {
          ...base(event, generation, sourceSequence, "updated", stable),
          kind: "file",
          itemHandle,
          ...change,
        }
      }
      case "code.decision.requested":
      case "code.approval.requested": {
        const request = payload.request as PendingRequestView
        const kind =
          event.kind === "code.approval.requested" ? "approval" : "decision"
        return {
          ...base(
            event,
            generation,
            sourceSequence,
            "waiting",
            stableId(event, generation, "pending", request.pendingId),
          ),
          kind,
          request,
        }
      }
      case "code.pending.resolved": {
        const pendingId = stringField(payload, "pendingId")
        return {
          ...base(
            event,
            generation,
            sourceSequence,
            stringField(payload, "status"),
            stableId(event, generation, "pending", pendingId),
          ),
          kind: "request_resolved",
          pendingId,
        }
      }
      case "code.session.diagnostic": {
        const detailRef = stringField(payload, "detailRef")
        const willRetry = payload.willRetry as boolean
        const code = stringField(payload, "code")
        if (isInternalConnectionDiagnosticCode(code)) return null
        if (code === "CODEX-WARNING") {
          return {
            ...base(
              event,
              generation,
              sourceSequence,
              "warning",
              stableId(event, generation, "diagnostic", detailRef),
            ),
            kind: "status",
            itemHandle: null,
            itemType: "warning",
            detailRef,
          }
        }
        return {
          ...base(
            event,
            generation,
            sourceSequence,
            willRetry ? "retrying" : "failed",
            stableId(event, generation, "diagnostic", detailRef),
          ),
          kind: "error",
          errorCode: code,
          detailRef,
          willRetry,
        }
      }
      case "code.model.violation":
        return {
          ...base(
            event,
            generation,
            sourceSequence,
            "failed",
            stableId(event, generation, "model_violation"),
          ),
          kind: "error",
          errorCode: "CODEX-MODEL-VIOLATION",
          detailRef: null,
          willRetry: false,
        }
      case "code.protocol.unsupported":
        return {
          ...base(
            event,
            generation,
            sourceSequence,
            "blocked",
            stableId(
              event,
              generation,
              "protocol",
              stringField(payload, "methodHash"),
            ),
          ),
          kind: "error",
          errorCode: "CODEX-PROTOCOL-UNSUPPORTED",
          detailRef: stringField(payload, "detailRef"),
          willRetry: false,
        }
      case "code.unsupported":
        return null
      default:
        return null
    }
  }
}
