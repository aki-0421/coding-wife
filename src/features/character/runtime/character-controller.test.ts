import { describe, expect, it } from "vitest"

import {
  computeCharacterBackingSize,
  resolveLoadFailureStaticPreview,
} from "@/features/character/runtime/character-controller"

describe("character canvas backing size", () => {
  it("tracks CSS pixels while capping high-density displays", () => {
    expect(computeCharacterBackingSize(607.84, 754.99, 1)).toEqual({
      width: 608,
      height: 755,
      devicePixelRatio: 1,
    })
    expect(computeCharacterBackingSize(607.84, 754.99, 3)).toEqual({
      width: 1216,
      height: 1510,
      devicePixelRatio: 2,
    })
  })

  it("normalizes invalid and collapsed dimensions safely", () => {
    expect(computeCharacterBackingSize(-10, 0, Number.NaN)).toEqual({
      width: 1,
      height: 1,
      devicePixelRatio: 1,
    })
    expect(computeCharacterBackingSize(100, 50, 0.5)).toEqual({
      width: 100,
      height: 50,
      devicePixelRatio: 1,
    })
  })

  it("keeps the committed frame on a failed switch and uses a persisted frame on initial failure", () => {
    expect(resolveLoadFailureStaticPreview(true, true, false)).toBe(true)
    expect(resolveLoadFailureStaticPreview(true, false, true)).toBe(false)
    expect(resolveLoadFailureStaticPreview(false, false, true)).toBe(true)
    expect(resolveLoadFailureStaticPreview(false, false, false)).toBe(false)
  })
})
