import { describe, expect, it } from "vitest"

import {
  characterStateBySemanticState,
  mapSemanticStateToCharacterState,
} from "@/features/character/semantic-state"
import type { CharacterSemanticState } from "@/features/workspace-view/types"

describe("character semantic state mapping", () => {
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
      Record<CharacterSemanticState, CharacterSemanticState>
    >

    expect(characterStateBySemanticState).toEqual(expected)
    for (const state of Object.keys(expected) as CharacterSemanticState[]) {
      expect(mapSemanticStateToCharacterState(state)).toBe(expected[state])
    }
  })
})
