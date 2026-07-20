import { describe, expect, it } from "vitest"

import {
  builtinHiyoriMotionPreset,
  mapCharacterStateToSemanticState,
  neutralSemanticAssignments,
  resolveSemanticCue,
} from "@/features/character/semantic-mapping"

describe("semantic character mapping", () => {
  it("maps every operational state to the seven stable semantic states", () => {
    expect([
      mapCharacterStateToSemanticState("idle"),
      mapCharacterStateToSemanticState("thinking"),
      mapCharacterStateToSemanticState("acting"),
      mapCharacterStateToSemanticState("reviewing"),
      mapCharacterStateToSemanticState("waiting_for_user"),
      mapCharacterStateToSemanticState("completed"),
      mapCharacterStateToSemanticState("disconnected"),
      mapCharacterStateToSemanticState("error"),
    ]).toEqual([
      "neutral",
      "thinking",
      "working",
      "working",
      "asking",
      "success",
      "warning",
      "error",
    ])
  })

  it("uses default presets and fails invalid mappings to neutral", () => {
    const mapping = {
      schemaVersion: 1,
      packId: "builtin:hiyori_pro",
      manifestHash: "0".repeat(64),
      mappingVersion: 1,
      assignments: {
        ...neutralSemanticAssignments(),
        success: { kind: "motion", cueId: "FlickUp[0]" } as const,
      },
    } as const
    expect(resolveSemanticCue(mapping, "saved", "success")).toEqual({
      kind: "motion",
      cueId: "FlickUp[0]",
    })
    expect(resolveSemanticCue(mapping, "invalid", "success")).toEqual({
      kind: "neutral",
    })
    expect(
      resolveSemanticCue(
        {
          ...mapping,
          mappingVersion: 0,
          assignments: builtinHiyoriMotionPreset,
        },
        "default",
        "working",
      ),
    ).toEqual({ kind: "motion", cueId: "Tap@Body[0]" })
  })
})
