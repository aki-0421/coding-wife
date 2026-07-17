import { describe, expect, it } from "vitest"

import {
  neutralCharacterCue,
  resolveMotionPolicy,
  selectCharacterState,
} from "@/features/character/runtime/motion-policy"

describe("character motion policy", () => {
  it("rejects stale state and lower-priority state from the same generation", () => {
    const acting = { state: "acting", generation: 4 } as const

    expect(
      selectCharacterState(acting, { state: "error", generation: 3 }),
    ).toEqual(acting)
    expect(
      selectCharacterState(acting, { state: "idle", generation: 4 }),
    ).toEqual(acting)
    expect(
      selectCharacterState(acting, {
        state: "waiting_for_user",
        generation: 4,
      }),
    ).toEqual({ state: "waiting_for_user", generation: 4 })
    expect(
      selectCharacterState(acting, { state: "idle", generation: 5 }),
    ).toEqual({ state: "idle", generation: 5 })
  })

  it("maps every semantic state to the reviewed neutral cue", () => {
    expect(neutralCharacterCue).toEqual({
      motionGroup: "Idle",
      motionIndex: 0,
    })
  })

  it("prioritizes visibility and reduced-motion constraints", () => {
    expect(resolveMotionPolicy("animated", false, true)).toBe("animated")
    expect(resolveMotionPolicy("animated", true, true)).toBe("reduced")
    expect(resolveMotionPolicy("reduced", false, true)).toBe("reduced")
    expect(resolveMotionPolicy("animated", false, false)).toBe("hidden")
    expect(resolveMotionPolicy("hidden", false, true)).toBe("hidden")
  })
})
