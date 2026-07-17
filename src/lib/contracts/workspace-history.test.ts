import { describe, expect, it } from "vitest"

import {
  WorkspaceHistoryContractError,
  parseAppendDomainEventResponse,
  parsePersistedContextSnapshot,
  parsePersistedTimelineEvent,
  parsePersistedTimelinePage,
  parsePersistedWorkspaceDraft,
  parsePersistedWorkspaceSummary,
  parseWorkspaceCommandError,
  parseWorkspaceDeleteChallenge,
  parseWorkspaceHistoryResponse,
  parseWorkspacePickResponse,
  parseWorkspaceStateSnapshot,
  workspaceHistoryCommands,
  workspaceHistorySchemaVersion,
} from "@/lib/contracts/workspace-history"
import fixture from "@/test/fixtures/workspace-history.v1.json"

const gitFingerprint = `sha256:${"c".repeat(64)}`

function gitReviewPackPayload() {
  return {
    schemaVersion: 1,
    checkpoint: {
      checkpointId: "checkpoint-fixture",
      commitSha: "a".repeat(40),
      parentSha: "b".repeat(40),
      targetReference: "refs/heads/main",
      message: "feat: add fixture\n\n- verify the bounded history shape",
      authorName: "Fixture Author",
      authorEmail: "fixture@example.invalid",
      createdAt: "2026-07-18T00:00:02.000Z",
    },
    workspaceId: "workspace-fixture",
    workUnitId: "work-unit-fixture",
    objective: "Persist a bounded review pack",
    acceptance: ["The exact review pack can be restored"],
    gates: ["scope", "ownership", "verification", "risk"].map((gate) => ({
      gate,
      outcome: "pass",
      reasonCodes: [],
      observedRepositoryFingerprint: gitFingerprint,
    })),
    manifest: [
      {
        fileId: "file-fixture",
        relativePath: "src/main.rs",
        changeKind: "modified",
        ownership: "owned",
        beforeHash: `sha256:${"d".repeat(64)}`,
        afterHash: `sha256:${"e".repeat(64)}`,
        additions: 4,
        deletions: 1,
        reasonCode: null,
      },
    ],
    diffSummary: {
      filesChanged: 1,
      additions: 4,
      deletions: 1,
      binaryFiles: 0,
      totalBytes: 128,
    },
    verification: [
      {
        evidenceId: "evidence-fixture",
        check: "cargo test",
        result: "passed",
        durationMs: 1200,
        summary: "All focused tests passed",
        observedRepositoryFingerprint: gitFingerprint,
      },
    ],
    decisions: [],
    failedAttempts: [],
    risks: [],
    restoreGuidance: [
      "Preview the affected files before creating a revert commit.",
    ],
    operationState: "history_complete",
    packDigest: `sha256:${"f".repeat(64)}`,
    historySequence: null,
  }
}

describe("workspace history contract", () => {
  it("parses every Rust response fixture without shape drift", () => {
    expect(fixture.schemaVersion).toBe(workspaceHistorySchemaVersion)
    expect(parseWorkspaceStateSnapshot(fixture.state)).toEqual(fixture.state)
    expect(parsePersistedWorkspaceSummary(fixture.summary)).toEqual(
      fixture.summary,
    )
    expect(parsePersistedWorkspaceDraft(fixture.draft)).toEqual(fixture.draft)
    expect(parsePersistedContextSnapshot(fixture.context)).toEqual(
      fixture.context,
    )
    expect(parsePersistedTimelinePage(fixture.timeline)).toEqual(
      fixture.timeline,
    )
    expect(parseWorkspaceDeleteChallenge(fixture.challenge)).toEqual(
      fixture.challenge,
    )
    expect(parseAppendDomainEventResponse(fixture.append)).toEqual(
      fixture.append,
    )
    expect(parseWorkspaceCommandError(fixture.error)).toEqual(fixture.error)
    expect(
      parseWorkspacePickResponse({
        schemaVersion: 1,
        outcome: "selected",
        state: fixture.state,
      }),
    ).toEqual({ schemaVersion: 1, outcome: "selected", state: fixture.state })
  })

  it("routes each command to its exact parser", () => {
    expect(
      parseWorkspaceHistoryResponse(
        workspaceHistoryCommands.list,
        fixture.state,
      ),
    ).toEqual(fixture.state)
    expect(
      parseWorkspaceHistoryResponse(
        workspaceHistoryCommands.createSession,
        fixture.state,
      ),
    ).toEqual(fixture.state)
    expect(
      parseWorkspaceHistoryResponse(
        workspaceHistoryCommands.updateLifecycle,
        fixture.summary,
      ),
    ).toEqual(fixture.summary)
    expect(
      parseWorkspaceHistoryResponse(
        workspaceHistoryCommands.saveDraft,
        fixture.draft,
      ),
    ).toEqual(fixture.draft)
    expect(
      parseWorkspaceHistoryResponse(
        workspaceHistoryCommands.listTimeline,
        fixture.timeline,
      ),
    ).toEqual(fixture.timeline)
  })

  it("rejects future schemas, snake_case, unknown fields, and cross-workspace state", () => {
    expect(() =>
      parseWorkspaceStateSnapshot({ ...fixture.state, schemaVersion: 2 }),
    ).toThrow(WorkspaceHistoryContractError)
    expect(() =>
      parseWorkspaceStateSnapshot({
        ...fixture.state,
        active_workspace_id: fixture.state.activeWorkspaceId,
      }),
    ).toThrow(WorkspaceHistoryContractError)
    expect(() =>
      parsePersistedWorkspaceSummary({
        ...fixture.summary,
        rawPath: "/tmp/repo",
      }),
    ).toThrow(WorkspaceHistoryContractError)
    expect(() =>
      parseWorkspaceStateSnapshot({
        ...fixture.state,
        draft: { ...fixture.draft, workspaceId: "workspace-other" },
      }),
    ).toThrow(WorkspaceHistoryContractError)
  })

  it("accepts explicit ephemeral demo history without recovery metadata", () => {
    const ephemeralState = {
      ...fixture.state,
      history: {
        schemaVersion: 1,
        mode: "ephemeral",
        errorCode: null,
        backupName: null,
      },
    }

    expect(parseWorkspaceStateSnapshot(ephemeralState).history).toEqual(
      ephemeralState.history,
    )
    expect(() =>
      parseWorkspaceStateSnapshot({
        ...ephemeralState,
        history: {
          ...ephemeralState.history,
          errorCode: "HIST-RECOVERY-REQUIRED",
        },
      }),
    ).toThrow(WorkspaceHistoryContractError)
  })

  it("rejects private paths, secret-like text, and raw reasoning before UI state", () => {
    for (const text of [
      "Read /Users/private/project/secret.txt",
      "Bearer secret-token-value",
      "api_key=private-value",
      "chain-of-thought must remain hidden",
    ]) {
      expect(() =>
        parsePersistedWorkspaceDraft({ ...fixture.draft, text }),
      ).toThrow(WorkspaceHistoryContractError)
    }
    expect(() =>
      parsePersistedTimelinePage({
        ...fixture.timeline,
        items: [
          {
            ...fixture.timeline.items[0],
            payload: { status: "failed", reasoning: "hidden" },
          },
        ],
      }),
    ).toThrow(WorkspaceHistoryContractError)
  })

  it("parses only the exact rich Codex history allowlist", () => {
    const event = {
      ...fixture.timeline.items[0],
      eventId: "event-codex-tool",
      producer: "code",
      kind: "code.tool.output",
      payload: {
        generation: 7,
        sourceSequence: 12,
        itemHandle: "item-safe",
        excerpt: "Tests passed",
      },
    }

    expect(parsePersistedTimelineEvent(event)).toEqual(event)
    expect(() =>
      parsePersistedTimelineEvent({
        ...event,
        payload: { ...event.payload, rawStderr: "not allowed" },
      }),
    ).toThrow(WorkspaceHistoryContractError)
    expect(() =>
      parsePersistedTimelineEvent({
        ...event,
        payload: { ...event.payload, excerpt: "x".repeat(16 * 1024 + 1) },
      }),
    ).toThrow(WorkspaceHistoryContractError)
  })

  it("parses only exact owned Git operation and raw review-pack payloads", () => {
    const operation = {
      ...fixture.timeline.items[0],
      eventId: "git-operation-fixture-prepared",
      sessionId: null,
      producer: "git",
      kind: "git.checkpoint.operation.changed",
      payload: {
        schemaVersion: 1,
        operationId: "operation-fixture",
        clientRequestId: "request-fixture",
        workspaceId: "workspace-fixture",
        workUnitId: "work-unit-fixture",
        baselineId: "baseline-fixture",
        state: "prepared",
        expectedHeadSha: "b".repeat(40),
        targetReference: "refs/heads/main",
        commitSha: null,
        packDigest: null,
        errorCode: null,
        observedAt: "2026-07-18T00:00:01.000Z",
      },
    }
    const pack = {
      ...operation,
      eventId: "git-pack-checkpoint-fixture",
      kind: "git.review_pack.recorded",
      payload: gitReviewPackPayload(),
    }

    expect(parsePersistedTimelineEvent(operation)).toEqual(operation)
    expect(parsePersistedTimelineEvent(pack)).toEqual(pack)
    expect(() =>
      parsePersistedTimelineEvent({
        ...operation,
        payload: { ...operation.payload, rawCommand: "git commit" },
      }),
    ).toThrow(WorkspaceHistoryContractError)
    expect(() =>
      parsePersistedTimelineEvent({
        ...pack,
        payload: { ...pack.payload, workspaceId: "workspace-other" },
      }),
    ).toThrow(WorkspaceHistoryContractError)
    expect(() =>
      parsePersistedTimelineEvent({
        ...pack,
        sessionId: "session-fixture",
      }),
    ).toThrow(WorkspaceHistoryContractError)
    expect(() =>
      parsePersistedTimelineEvent({
        ...pack,
        payload: {
          ...pack.payload,
          checkpoint: {
            ...pack.payload.checkpoint,
            privatePath: "/Users/private/repository",
          },
        },
      }),
    ).toThrow(WorkspaceHistoryContractError)
    expect(() =>
      parsePersistedTimelineEvent({
        ...pack,
        payload: {
          ...pack.payload,
          manifest: Array.from({ length: 501 }, () => pack.payload.manifest[0]),
        },
      }),
    ).toThrow(WorkspaceHistoryContractError)
  })

  it("enforces the 200 event page bound and monotonic sequence order", () => {
    expect(() =>
      parsePersistedTimelinePage({
        ...fixture.timeline,
        items: Array.from({ length: 201 }, (_, index) => ({
          ...fixture.timeline.items[0],
          eventId: `event-${String(index)}`,
          sequence: index + 1,
        })),
      }),
    ).toThrow(WorkspaceHistoryContractError)
    expect(() =>
      parsePersistedTimelinePage({
        ...fixture.timeline,
        items: [
          { ...fixture.timeline.items[0], sequence: 2 },
          {
            ...fixture.timeline.items[0],
            eventId: "event-second",
            sequence: 1,
          },
        ],
      }),
    ).toThrow(WorkspaceHistoryContractError)
  })

  it("rejects malformed command errors instead of trusting native detail", () => {
    expect(
      parseWorkspaceCommandError({
        ...fixture.error,
        operation: "arbitrary_shell_command",
      }),
    ).toBeNull()
    expect(
      parseWorkspaceCommandError({
        ...fixture.error,
        detailRef: "/Users/private/diagnostic",
      }),
    ).toBeNull()
  })
})
