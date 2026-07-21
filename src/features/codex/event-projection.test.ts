import { describe, expect, it } from "vitest"

import { parseCodexEvent, type CodexEvent } from "@/lib/contracts"
import fixture from "@/test/fixtures/codex-runtime.v1.json"

import {
  CodexEventProjector,
  projectAcceptedUserTurn,
} from "@/features/codex/event-projection"

function event(
  sequence: number,
  value: Pick<CodexEvent, "kind" | "payload">,
): CodexEvent {
  return parseCodexEvent({
    schemaVersion: 1,
    eventId: `event-${String(sequence)}`,
    workspaceId: "workspace-fixture",
    generation: 7,
    sequence,
    occurredAt: `2026-07-18T00:00:${String(sequence).padStart(2, "0")}Z`,
    ...value,
  })
}

describe("CodexEventProjector", () => {
  it("coalesces assistant deltas in memory and persists only the completed authority", () => {
    const projector = new CodexEventProjector()
    const first = projector.project(
      event(1, {
        kind: "agent_message_delta",
        payload: { itemHandle: "item-assistant", delta: "Hello " },
      }),
    )
    const second = projector.project(
      event(2, {
        kind: "agent_message_delta",
        payload: { itemHandle: "item-assistant", delta: "world" },
      }),
    )
    const completed = projector.project(
      event(3, {
        kind: "agent_message_completed",
        payload: { itemHandle: "item-assistant", text: "Hello world." },
      }),
    )

    expect(first.history).toBeNull()
    expect(second.timeline).toMatchObject({
      kind: "assistant",
      status: "streaming",
      text: "Hello world",
      durable: false,
    })
    expect(completed.timeline).toMatchObject({
      kind: "assistant",
      status: "completed",
      text: "Hello world.",
      durable: true,
    })
    expect(completed.timeline?.stableId).toBe(second.timeline?.stableId)
    expect(completed.history).toMatchObject({
      kind: "code.message.completed",
      eventId: "event-3",
      payload: { generation: 7, sourceSequence: 3 },
    })
  })

  it("keeps Codex warnings non-terminal while preserving the diagnostic history", () => {
    const projected = new CodexEventProjector().project(
      event(4, {
        kind: "diagnostic",
        payload: {
          code: "CODEX-WARNING",
          willRetry: false,
          detailRef: "diagnostic-warning-1",
        },
      }),
    )

    expect(projected.timeline).toMatchObject({
      kind: "status",
      status: "warning",
      itemType: "warning",
      detailRef: "diagnostic-warning-1",
    })
    expect(projected.history).toMatchObject({
      kind: "code.session.diagnostic",
      payload: { code: "CODEX-WARNING", willRetry: false },
    })
  })

  it("keeps automatic connection recovery out of the visible timeline", () => {
    const projected = new CodexEventProjector().project(
      event(5, {
        kind: "diagnostic",
        payload: {
          code: "CODEX-CONNECTION-LOST",
          willRetry: true,
          detailRef: "diagnostic-recovery-1",
        },
      }),
    )

    expect(projected.timeline).toBeNull()
    expect(projected.history).toMatchObject({
      kind: "code.session.diagnostic",
      payload: { code: "CODEX-CONNECTION-LOST", willRetry: true },
    })
  })

  it("persists message item lifecycle without rendering duplicate status rows", () => {
    const projected = new CodexEventProjector().project(
      event(5, {
        kind: "item_status",
        payload: {
          itemHandle: "item-assistant",
          itemType: "agentMessage",
          status: "running",
        },
      }),
    )

    expect(projected.timeline).toBeNull()
    expect(projected.history).toMatchObject({
      kind: "code.item.status.changed",
      payload: { itemType: "agentMessage", status: "running" },
    })
  })

  it("keeps legacy MCP rows readable without presenting the protocol type as a tool name", () => {
    const projected = new CodexEventProjector().project(
      event(1, {
        kind: "item_status",
        payload: {
          itemHandle: "item-tool",
          itemType: "mcpToolCall",
          status: "completed",
        },
      }),
    )

    expect(projected.timeline).toMatchObject({
      kind: "tool",
      toolKind: "mcpToolCall",
      providerName: null,
      toolName: "MCP",
      summary: null,
    })
  })

  it("projects tool, file, plan, diff, approval, error, and completion semantics", () => {
    const projector = new CodexEventProjector()
    const approval = parseCodexEvent(fixture.events[1])
    if (approval.kind !== "pending_request") throw new Error("approval fixture")
    const projections = [
      projector.project(
        event(1, {
          kind: "tool_status",
          payload: {
            itemHandle: "item-tool",
            toolKind: "mcpToolCall",
            providerName: "browser",
            toolName: "open",
            summary: "ref_id=page-safe",
            durationMs: null,
            status: "running",
          },
        }),
      ),
      projector.project(
        event(2, {
          kind: "tool_output",
          payload: { itemHandle: "item-tool", excerpt: "8 tests passed" },
        }),
      ),
      projector.project(
        event(3, {
          kind: "file_change",
          payload: {
            itemHandle: "item-file",
            pathAlias: "<workspace>/src/app.ts",
            changeKind: "update",
          },
        }),
      ),
      projector.project(
        event(4, { kind: "plan_updated", payload: { stepCount: 4 } }),
      ),
      projector.project(
        event(5, {
          kind: "diff_updated",
          payload: { byteCount: 120, detailRef: "detail-diff-1" },
        }),
      ),
      projector.project(approval),
      projector.project(
        event(7, {
          kind: "diagnostic",
          payload: {
            code: "CODEX-TURN-ERROR",
            willRetry: false,
            detailRef: "detail-error-1",
          },
        }),
      ),
      projector.project(
        event(8, {
          kind: "turn_status",
          payload: {
            threadHandle: "thread-1",
            turnHandle: "turn-1",
            status: "completed",
          },
        }),
      ),
    ]

    expect(projections.map(({ timeline }) => timeline?.kind)).toEqual([
      "tool",
      "tool",
      "file",
      "plan",
      "diff",
      "approval",
      "error",
      "completion",
    ])
    expect(projections.map(({ history }) => history?.kind)).toEqual([
      "code.tool.status.changed",
      "code.tool.output",
      "code.file_change.updated",
      "code.plan.updated",
      "code.diff.updated",
      "code.approval.requested",
      "code.session.diagnostic",
      "code.session.status.changed",
    ])
    expect(projections[1]?.timeline).toMatchObject({
      kind: "tool",
      toolKind: "mcpToolCall",
      providerName: "browser",
      toolName: "open",
      summary: "ref_id=page-safe",
      excerpt: "8 tests passed",
    })
    expect(projections[5]?.history?.payload).toEqual({
      semanticVersion: 1,
      generation: approval.generation,
      sourceSequence: approval.sequence,
      request: approval.payload.request,
    })
    expect(JSON.stringify(projections)).not.toMatch(
      /chain[-_ ]?of[-_ ]?thought|rawReasoning|\/Users\//iu,
    )
  })

  it("does not project or persist inline source bodies from tool summaries", () => {
    const projected = new CodexEventProjector().project(
      event(1, {
        kind: "tool_status",
        payload: {
          itemHandle: "item-tool",
          toolKind: "mcpToolCall",
          providerName: "node-repl",
          toolName: "run",
          summary:
            "code=var fs = await import('node:fs/promises') · title=依存関係ファイルを確認",
          durationMs: null,
          status: "running",
        },
      }),
    )

    expect(projected.timeline).toMatchObject({
      kind: "tool",
      summary: "title=依存関係ファイルを確認 · code=<source hidden>",
    })
    expect(projected.history).toMatchObject({
      kind: "code.tool.status.changed",
      payload: {
        summary: "title=依存関係ファイルを確認 · code=<source hidden>",
      },
    })
    expect(JSON.stringify(projected)).not.toContain("node:fs/promises")
  })

  it("creates one durable user instruction only after turn acceptance", () => {
    const projection = projectAcceptedUserTurn({
      eventId: "message-fixture",
      workspaceId: "workspace-fixture",
      generation: 7,
      sourceSequence: 9,
      occurredAt: "2026-07-18T00:00:09Z",
      text: "Run the focused tests.",
      effort: "max",
      attachmentCount: 0,
    })

    expect(projection.timeline).toMatchObject({
      kind: "user",
      status: "accepted",
      text: "Run the focused tests.",
      attachmentCount: 0,
    })
    expect(projection.history).toMatchObject({
      kind: "code.user.instruction.accepted",
      eventId: "message-fixture",
      payload: { effort: "max" },
    })
  })
})
