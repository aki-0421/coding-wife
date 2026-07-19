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
  parseWorkspaceResumeState,
  parseWorkspacePickResponse,
  parseWorkspaceStateSnapshot,
  workspaceHistoryCommands,
  workspaceHistorySchemaVersion,
} from "@/lib/contracts/workspace-history"
import fixture from "@/test/fixtures/workspace-history.v1.json"

const gitSha = "a".repeat(40)
const gitParent = "b".repeat(40)
const gitFingerprint = `sha256:${"c".repeat(64)}`

function gitSkillAudit() {
  return {
    schemaVersion: 1,
    skillId: "coding-wife-commit-work",
    skillVersion: "1.0.0",
    contentDigest: gitFingerprint,
    pathAuthority: "app_bundle",
    injectionMode: "skill_input",
    workspaceGeneration: 1,
    workUnitId: "work-unit-fixture",
    clientRequestId: "turn-fixture",
    injectedAt: "2026-07-18T00:00:00.000Z",
  }
}

function gitObservationPayload() {
  return {
    schemaVersion: 1,
    observationId: "observation-fixture",
    workspaceId: "workspace-fixture",
    workspaceGeneration: 1,
    reason: "active_view",
    workUnitId: null,
    sourceEventId: null,
    supportState: "ready",
    headSha: gitSha,
    headReference: "refs/heads/main",
    branch: "main",
    detached: false,
    indexFingerprint: gitFingerprint,
    statusFingerprint: gitFingerprint,
    repositoryFingerprint: gitFingerprint,
    preExisting: [],
    blockedReasons: [],
    capturedAt: "2026-07-18T00:00:01.000Z",
    historySequence: null,
  }
}

function gitCommitEvidencePayload() {
  return {
    schemaVersion: 1,
    commitEvidenceId: `commit-${gitSha}`,
    workspaceId: "workspace-fixture",
    producer: "main_codex",
    identity: {
      commitSha: gitSha,
      subject: "feat(git): record read-only evidence",
      body: "- persist the observed commit facts",
      authorName: "Fixture Author",
      authorEmail: "fixture@example.invalid",
      authoredAt: "2026-07-18T00:00:02.000Z",
      committedAt: "2026-07-18T00:00:02.000Z",
      parents: [gitParent],
    },
    workUnitId: "work-unit-fixture",
    objective: "Persist bounded commit evidence",
    acceptance: ["The exact evidence can be read again"],
    beforeObservationId: "observation-before",
    afterObservationId: "observation-after",
    sourceEventId: "event-terminal-fixture",
    gates: ["scope", "ownership", "verification", "risk"].map((gate) => ({
      gate,
      outcome: "pass",
      reasonCodes: [],
      evidenceIds: [],
    })),
    files: [
      {
        fileEvidenceId: "file-fixture",
        relativePath: "src/main.rs",
        changeKind: "modified",
        additions: 4,
        deletions: 1,
        binary: false,
      },
    ],
    diffSummary: {
      filesChanged: 1,
      additions: 4,
      deletions: 1,
      binaryFiles: 0,
    },
    verification: [],
    decisions: [],
    failedAttempts: [],
    risks: [],
    commitSkillInjection: gitSkillAudit(),
    observedAt: "2026-07-18T00:00:03.000Z",
    historySequence: null,
  }
}

function gitWorkUnitPayload() {
  return {
    schemaVersion: 1,
    workspaceId: "workspace-fixture",
    workspaceGeneration: 1,
    workUnitId: "work-unit-fixture",
    sourceEventId: "event-terminal-fixture",
    terminalState: "completed",
    beforeObservationId: "observation-before",
    afterObservationId: "observation-after",
    newCommitEvidenceIds: [`commit-${gitSha}`],
    commitSkillInjection: gitSkillAudit(),
    reportedCommitBlockReason: null,
    observedAt: "2026-07-18T00:00:04.000Z",
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
        workspaceHistoryCommands.recheck,
        fixture.state,
      ),
    ).toEqual(fixture.state)
    expect(
      parseWorkspaceHistoryResponse(
        workspaceHistoryCommands.repair,
        fixture.state,
      ),
    ).toEqual(fixture.state)
    expect(
      parseWorkspaceHistoryResponse(
        workspaceHistoryCommands.unregister,
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
        workspaceHistoryCommands.cancel,
        fixture.summary,
      ),
    ).toEqual(fixture.summary)
    expect(
      parseWorkspaceHistoryResponse(
        workspaceHistoryCommands.saveDraft,
        fixture.draft,
      ),
    ).toEqual(fixture.draft)
    const character = {
      schemaVersion: 1 as const,
      version: 3,
      contentHash: "d".repeat(64),
      updatedAt: "2026-07-18T00:00:30.000Z",
      context: {
        displayName: "Sol",
        tone: "neutral" as const,
        toneNotes: "",
        speechDensity: "key_events" as const,
        behavior: "",
        prohibitedExpressions: [],
      },
    }
    expect(
      parseWorkspaceHistoryResponse(
        workspaceHistoryCommands.getCharacterContext,
        character,
      ),
    ).toEqual(character)
    expect(
      parseWorkspaceHistoryResponse(
        workspaceHistoryCommands.saveCharacterContext,
        character,
      ),
    ).toEqual(character)
    const anchor = {
      schemaVersion: 1,
      workspaceId: "workspace-fixture",
      eventId: "event-fixture",
      sequence: 7,
      offset: -12,
      revision: 3,
      updatedAt: "2026-07-18T00:01:00.000Z",
      wasClamped: false,
    }
    expect(
      parseWorkspaceHistoryResponse(
        workspaceHistoryCommands.saveTimelineAnchor,
        anchor,
      ),
    ).toEqual(anchor)
    expect(
      parseWorkspaceHistoryResponse(
        workspaceHistoryCommands.listTimeline,
        fixture.timeline,
      ),
    ).toEqual(fixture.timeline)
  })

  it("accepts only workspace-scoped versioned summary and anchor state", () => {
    const resumeState = {
      schemaVersion: 1,
      workspaceId: "workspace-fixture",
      lastSummary: {
        schemaVersion: 1,
        workspaceId: "workspace-fixture",
        eventId: "event-fixture",
        sequence: 7,
        text: "First line\nSecond 😀",
        updatedAt: "2026-07-18T00:00:45.000Z",
      },
      timelineAnchor: {
        schemaVersion: 1,
        workspaceId: "workspace-fixture",
        eventId: "event-fixture",
        sequence: 7,
        offset: -12,
        revision: 3,
        updatedAt: "2026-07-18T00:01:00.000Z",
        wasClamped: false,
      },
    }
    expect(parseWorkspaceResumeState(resumeState)).toEqual(resumeState)
    expect(
      parseWorkspaceStateSnapshot({ ...fixture.state, resumeState }),
    ).toMatchObject({ resumeState })
    expect(() =>
      parseWorkspaceResumeState({
        ...resumeState,
        timelineAnchor: {
          ...resumeState.timelineAnchor,
          workspaceId: "workspace-other",
        },
      }),
    ).toThrow(WorkspaceHistoryContractError)
    expect(() =>
      parseWorkspaceResumeState({
        ...resumeState,
        timelineAnchor: {
          ...resumeState.timelineAnchor,
          offset: 1_000_001,
        },
      }),
    ).toThrow(WorkspaceHistoryContractError)
  })

  it("accepts stale branch health as a bounded repair state", () => {
    expect(
      parsePersistedWorkspaceSummary({
        ...fixture.summary,
        health: "stale_branch",
      }),
    ).toMatchObject({ health: "stale_branch" })
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
      "Read /\u0055sers/private/project/secret.txt",
      "Bearer secret-token-value",
      "api_key=private-value",
      "chain-of-thought must remain hidden",
    ]) {
      expect(() =>
        parsePersistedWorkspaceDraft({ ...fixture.draft, text }),
      ).toThrow(WorkspaceHistoryContractError)
    }
    expect(
      parsePersistedTimelinePage({
        ...fixture.timeline,
        items: [
          {
            ...fixture.timeline.items[0],
            payload: { status: "failed", reasoning: "hidden" },
          },
        ],
      }).items[0],
    ).toMatchObject({
      kind: "code.unsupported",
      payload: { errorCode: "CODEX-HISTORY-UNSUPPORTED" },
    })
  })

  it("parses only the exact rich Codex history allowlist", () => {
    const event = {
      ...fixture.timeline.items[0],
      eventId: "event-codex-tool",
      producer: "code",
      kind: "code.tool.output",
      payload: {
        semanticVersion: 1,
        generation: 7,
        sourceSequence: 12,
        itemHandle: "item-safe",
        excerpt: "Tests passed",
      },
    }

    expect(parsePersistedTimelineEvent(event)).toEqual(event)
    expect(
      parsePersistedTimelineEvent({
        ...event,
        payload: { ...event.payload, rawStderr: "not allowed" },
      }),
    ).toMatchObject({ kind: "code.unsupported" })
    expect(
      parsePersistedTimelineEvent({
        ...event,
        payload: { ...event.payload, excerpt: "x".repeat(16 * 1024 + 1) },
      }),
    ).toMatchObject({ kind: "code.unsupported" })
  })

  it("uses Unicode scalar limits and normalized multiline public text", () => {
    const event = {
      ...fixture.timeline.items[0],
      eventId: "event-codex-multiline",
      producer: "code",
      kind: "code.tool.output",
      payload: {
        semanticVersion: 1,
        generation: 7,
        sourceSequence: 12,
        itemHandle: "item-safe",
        excerpt: "first line\n\tsecond 😀",
      },
    }

    expect(parsePersistedTimelineEvent(event)).toEqual(event)
    expect(
      parsePersistedTimelineEvent({
        ...event,
        payload: { ...event.payload, excerpt: "😀".repeat(16 * 1024) },
      }).kind,
    ).toBe("code.tool.output")
    for (const excerpt of [
      "😀".repeat(16 * 1024 + 1),
      "line\r\n",
      "bell\u0007",
      "/\u0055sers/private/project/file.rs",
      "Bearer hidden-token",
    ]) {
      expect(
        parsePersistedTimelineEvent({
          ...event,
          payload: { ...event.payload, excerpt },
        }),
      ).toMatchObject({
        kind: "code.unsupported",
        payload: { errorCode: "CODEX-HISTORY-UNSUPPORTED" },
      })
    }
    expect(
      parsePersistedTimelineEvent({ ...event, schemaVersion: 2 }),
    ).toMatchObject({ kind: "code.unsupported", schemaVersion: 1 })
  })

  it("parses only exact read-only Git observation payloads", () => {
    const base = {
      ...fixture.timeline.items[0],
      sessionId: null,
      producer: "git",
    }
    const observation = {
      ...base,
      eventId: "git-observation-fixture",
      kind: "git.observation.recorded",
      payload: gitObservationPayload(),
    }
    const evidence = {
      ...base,
      eventId: "git-evidence-fixture",
      kind: "git.commit_evidence.recorded",
      payload: gitCommitEvidencePayload(),
    }
    const workUnit = {
      ...base,
      eventId: "git-work-unit-fixture",
      kind: "git.work_unit.observed",
      payload: gitWorkUnitPayload(),
    }

    expect(parsePersistedTimelineEvent(observation)).toEqual(observation)
    expect(parsePersistedTimelineEvent(evidence)).toEqual(evidence)
    expect(parsePersistedTimelineEvent(workUnit)).toEqual(workUnit)
    expect(() =>
      parsePersistedTimelineEvent({
        ...observation,
        payload: { ...observation.payload, rawCommand: "write" },
      }),
    ).toThrow(WorkspaceHistoryContractError)
    expect(() =>
      parsePersistedTimelineEvent({
        ...evidence,
        payload: { ...evidence.payload, workspaceId: "workspace-other" },
      }),
    ).toThrow(WorkspaceHistoryContractError)
    expect(() =>
      parsePersistedTimelineEvent({
        ...workUnit,
        sessionId: "session-fixture",
      }),
    ).toThrow(WorkspaceHistoryContractError)
    expect(() =>
      parsePersistedTimelineEvent({
        ...evidence,
        payload: {
          ...evidence.payload,
          files: [
            {
              ...evidence.payload.files[0],
              privatePath: "/private/repository",
            },
          ],
        },
      }),
    ).toThrow(WorkspaceHistoryContractError)
    expect(() =>
      parsePersistedTimelineEvent({
        ...observation,
        payload: { ...observation.payload, historySequence: 2 },
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
        detailRef: "/\u0055sers/private/diagnostic",
      }),
    ).toBeNull()
  })
})
