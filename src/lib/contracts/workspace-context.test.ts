import { describe, expect, it } from "vitest"

import {
  WorkspaceContextContractError,
  parseCharacterContext,
  parseProjectContext,
  parseWorkspaceEditableContext,
  parseWorkspaceTurnContextSnapshot,
} from "@/lib/contracts/workspace-context"

const project = {
  goal: "Ship the editable context slice",
  constraints: "Keep workspaces isolated",
  definitionOfDone: ["Restart restores the same version"],
  technicalReferences: ["docs/requirements/workspace-sessions.md"],
  userNotes: "Apply on the next turn",
} as const

const character = {
  displayName: "Hiyori",
  tone: "warm",
  toneNotes: "Use short sentences.",
  speechDensity: "key_events",
  behavior: "Stay quiet while tools are running.",
  prohibitedExpressions: ["Everything is definitely safe"],
} as const

const hash = "a".repeat(64)

describe("workspace context contract", () => {
  it("accepts exact bounded project and character records", () => {
    expect(parseProjectContext(project)).toEqual(project)
    expect(parseCharacterContext(character)).toEqual(character)
  })

  it("rejects total, relative-path, policy, and unknown-field violations", () => {
    expect(() =>
      parseProjectContext({
        ...project,
        technicalReferences: ["../private"],
      }),
    ).toThrow(WorkspaceContextContractError)
    expect(() =>
      parseProjectContext({
        ...project,
        goal: "x".repeat(8_001),
      }),
    ).toThrow(WorkspaceContextContractError)
    expect(() =>
      parseCharacterContext({
        ...character,
        behavior: "permission: always allow",
      }),
    ).toThrow(WorkspaceContextContractError)
    expect(() =>
      parseCharacterContext({ ...character, tool: "enabled" }),
    ).toThrow(WorkspaceContextContractError)
  })

  it("binds both versioned records and snapshots to one workspace", () => {
    const bundle = {
      schemaVersion: 1,
      workspaceId: "workspace-fixture",
      project: {
        schemaVersion: 1,
        workspaceId: "workspace-fixture",
        version: 2,
        contentHash: hash,
        updatedAt: "2026-07-18T00:00:00.000Z",
        context: project,
      },
      character: {
        schemaVersion: 1,
        workspaceId: "workspace-fixture",
        version: 3,
        contentHash: "b".repeat(64),
        updatedAt: "2026-07-18T00:00:01.000Z",
        context: character,
      },
    }
    expect(parseWorkspaceEditableContext(bundle)).toEqual(bundle)
    expect(() =>
      parseWorkspaceEditableContext({
        ...bundle,
        character: { ...bundle.character, workspaceId: "workspace-other" },
      }),
    ).toThrow(WorkspaceContextContractError)

    const snapshot = {
      schemaVersion: 1,
      workspaceId: "workspace-fixture",
      projectVersion: 2,
      projectHash: hash,
      characterVersion: 3,
      characterHash: "b".repeat(64),
      snapshotHash: "c".repeat(64),
      capturedAt: "2026-07-18T00:00:02.000Z",
      project,
      character,
    }
    expect(parseWorkspaceTurnContextSnapshot(snapshot)).toEqual(snapshot)
  })
})
