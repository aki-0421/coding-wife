import { describe, expect, it } from "vitest"

import {
  WorkspaceHistoryContractError,
  parseAppendDomainEventResponse,
  parsePersistedContextSnapshot,
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
