import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  canConsumeCharacterFirstFrameDeadline,
  CharacterFirstFrameDeadline,
} from "@/features/character/runtime/first-frame-deadline"

function eligibility(
  overrides: Partial<
    Parameters<typeof canConsumeCharacterFirstFrameDeadline>[0]
  > = {},
) {
  return canConsumeCharacterFirstFrameDeadline({
    expectedGeneration: 1,
    rendererGeneration: 1,
    motionPolicy: "animated",
    documentVisible: true,
    contextLost: false,
    cssWidth: 608,
    cssHeight: 879,
    ...overrides,
  })
}

function deadline(onExpire = vi.fn()) {
  return {
    onExpire,
    value: new CharacterFirstFrameDeadline({
      timeoutMilliseconds: 3_000,
      onExpire,
    }),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("character first-frame deadline", () => {
  it("waits through a compact interval longer than the timeout", () => {
    const { onExpire, value } = deadline()
    value.begin(1)
    value.setEligible(1, eligibility({ cssWidth: 0, cssHeight: 0 }))

    vi.advanceTimersByTime(30_000)
    expect(onExpire).not.toHaveBeenCalled()
    expect(value.snapshot.state).toBe("paused")

    value.setEligible(1, eligibility())
    vi.advanceTimersByTime(2_999)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledWith(1)
  })

  it("runs normally on desktop and stops after a visible frame", () => {
    const { onExpire, value } = deadline()
    value.begin(1)
    value.setEligible(1, eligibility())
    vi.advanceTimersByTime(1_200)
    value.complete(1)
    vi.advanceTimersByTime(10_000)

    expect(onExpire).not.toHaveBeenCalled()
    expect(value.snapshot.state).toBe("completed")
  })

  it("does not consume time while explicitly hidden or reduced", () => {
    expect(eligibility({ motionPolicy: "hidden" })).toBe(false)
    expect(eligibility({ motionPolicy: "reduced" })).toBe(false)

    const { onExpire, value } = deadline()
    value.begin(1)
    value.setEligible(1, eligibility({ motionPolicy: "hidden" }))
    vi.advanceTimersByTime(5_000)
    value.setEligible(1, eligibility({ motionPolicy: "reduced" }))
    vi.advanceTimersByTime(5_000)
    expect(onExpire).not.toHaveBeenCalled()

    value.setEligible(1, eligibility())
    vi.advanceTimersByTime(3_000)
    expect(onExpire).toHaveBeenCalledWith(1)
  })

  it("pauses across context loss and invalidates the stale generation", () => {
    expect(eligibility({ contextLost: true })).toBe(false)
    expect(eligibility({ rendererGeneration: 2 })).toBe(false)

    const { onExpire, value } = deadline()
    value.begin(1)
    value.setEligible(1, eligibility())
    vi.advanceTimersByTime(1_000)
    value.setEligible(1, eligibility({ contextLost: true }))
    vi.advanceTimersByTime(10_000)
    expect(onExpire).not.toHaveBeenCalled()

    expect(value.replaceGeneration(1, 2)).toBe(true)
    value.setEligible(1, true)
    value.setEligible(2, true)
    vi.advanceTimersByTime(1_999)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith(2)
  })
})
