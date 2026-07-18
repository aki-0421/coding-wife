import { describe, expect, it } from "vitest"

import {
  composeTurnInstruction,
  maximumComposedTurnScalars,
} from "@/features/workspace-persistence/turn-context"
import type { WorkspaceTurnContextSnapshot } from "@/lib/contracts/workspace-context"

const snapshot: WorkspaceTurnContextSnapshot = {
  schemaVersion: 1,
  workspaceId: "workspace-fixture",
  projectVersion: 4,
  projectHash: "a".repeat(64),
  characterVersion: 3,
  characterHash: "b".repeat(64),
  snapshotHash: "c".repeat(64),
  capturedAt: "2026-07-18T00:00:00.000Z",
  project: {
    goal: "Ship the next-turn snapshot",
    constraints: "Keep it immutable",
    definitionOfDone: ["The versions are present"],
    technicalReferences: ["docs/requirements/workspace-sessions.md"],
    userNotes: "Do not inject into a running turn",
  },
  character: {
    displayName: "Hiyori",
    tone: "warm",
    toneNotes: "Be concise",
    speechDensity: "key_events",
    behavior: "Stay quiet while tools run",
    prohibitedExpressions: [],
  },
}

describe("composeTurnInstruction", () => {
  it("serializes one immutable snapshot with versions and hashes", () => {
    const composed = composeTurnInstruction("Implement the slice", snapshot)

    expect(composed).toContain("CODING_WIFE_CONTEXT_SNAPSHOT_V1")
    expect(composed).toContain('"project":{"version":4,"hash":"aaa')
    expect(composed).toContain('"character":{"version":3,"hash":"bbb')
    expect(composed).toContain("CODING_WIFE_USER_INSTRUCTION_V1")
    expect(composed.endsWith("Implement the slice")).toBe(true)
  })

  it("rejects a combined request beyond the native turn budget", () => {
    expect(() =>
      composeTurnInstruction("x".repeat(maximumComposedTurnScalars), snapshot),
    ).toThrow("WORKSPACE-CONTEXT-TURN-TOO-LARGE")
  })

  it("rejects unsafe controls while preserving normalized multiline input", () => {
    expect(() =>
      composeTurnInstruction("first line\n\tsecond line", snapshot),
    ).not.toThrow()

    for (const control of ["\0", "\u0007", "\r", "\u0085"]) {
      expect(() =>
        composeTurnInstruction(`unsafe${control}instruction`, snapshot),
      ).toThrow("WORKSPACE-CONTEXT-TURN-UNSAFE-CONTROL")
    }
  })
})
