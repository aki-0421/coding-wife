import { describe, expect, it } from "vitest"

import hiyoriPack from "../../../../src-tauri/resources/characters/builtin-hiyori/pack.json"
import {
  isSafeCharacterAssetId,
  parseCharacterPackManifest,
} from "@/features/character/runtime/character-pack-client"

describe("character pack manifest", () => {
  it("accepts the verified bundled Hiyori inventory", () => {
    const manifest = parseCharacterPackManifest(structuredClone(hiyoriPack))

    expect(manifest.packId).toBe("builtin:hiyori_pro")
    expect(manifest.files).toHaveLength(17)
    expect(manifest.inventory.motionCount).toBe(10)
  })

  it.each([
    "",
    "/runtime/model.moc3",
    "../runtime/model.moc3",
    "runtime/../model.moc3",
    "runtime\\model.moc3",
    "https://example.com/model.moc3",
    "runtime//model.moc3",
  ])("rejects unsafe asset ID %j", (assetId) => {
    expect(isSafeCharacterAssetId(assetId)).toBe(false)
  })

  it("rejects traversal, duplicate assets, and inventory drift", () => {
    const traversal = structuredClone(hiyoriPack)
    traversal.files[0]!.assetId = "../texture.png"
    expect(() => parseCharacterPackManifest(traversal)).toThrow(
      "outside the reviewed schema",
    )

    const duplicate = structuredClone(hiyoriPack)
    duplicate.files[1]!.assetId = duplicate.files[0]!.assetId
    expect(() => parseCharacterPackManifest(duplicate)).toThrow(
      "duplicate asset IDs",
    )

    const drift = structuredClone(hiyoriPack)
    drift.inventory.totalBytes++
    expect(() => parseCharacterPackManifest(drift)).toThrow(
      "reviewed Hiyori contract",
    )
  })

  it("rejects motion cues that reference an unlisted motion", () => {
    const pack = structuredClone(hiyoriPack)
    pack.inventory.motionGroups.Idle[0]!.assetId =
      "runtime/motion/not-listed.motion3.json"

    expect(() => parseCharacterPackManifest(pack)).toThrow(
      "motion cue is outside the reviewed schema",
    )
  })
})
