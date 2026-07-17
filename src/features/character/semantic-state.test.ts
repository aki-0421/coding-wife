import { describe, expect, it } from "vitest"

import {
  characterStateByCompanionState,
  mapCompanionStateToCharacterState,
} from "@/features/character/semantic-state"
import type { CompanionSemanticState } from "@/features/workspace-view/types"

describe("companion semantic state mapping", () => {
  it("maps every workspace state to a deterministic character state", () => {
    const expected = {
      idle: "idle",
      thinking: "thinking",
      acting: "acting",
      waiting_for_user: "waiting_for_user",
      reviewing: "reviewing",
      error: "error",
      completed: "completed",
      disconnected: "disconnected",
    } as const satisfies Readonly<
      Record<CompanionSemanticState, CompanionSemanticState>
    >

    expect(characterStateByCompanionState).toEqual(expected)
    for (const state of Object.keys(expected) as CompanionSemanticState[]) {
      expect(mapCompanionStateToCharacterState(state)).toBe(expected[state])
    }
  })
})
