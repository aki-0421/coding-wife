import { afterEach, describe, expect, it, vi } from "vitest"

import hiyoriPack from "../../../../src-tauri/resources/characters/builtin-hiyori/pack.json"
import {
  CharacterPackClient,
  isSafeCharacterAssetId,
  parseCharacterPackManifest,
} from "@/features/character/runtime/character-pack-client"

const fixtureSha256 =
  "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a"

function createPackWithMoc(bytes: Uint8Array, hash = fixtureSha256) {
  const pack = structuredClone(hiyoriPack)
  const moc = pack.files.find((file) => file.role === "moc")
  if (moc === undefined) throw new Error("MOC fixture is missing")
  moc.bytes = bytes.byteLength
  moc.sha256 = hash
  pack.inventory.totalBytes = pack.files.reduce(
    (total, file) => total + file.bytes,
    0,
  )
  return { assetId: moc.assetId, pack }
}

async function loadMocFixture(
  bytes: Uint8Array,
  contentType: string | null,
  options: Readonly<{
    hash?: string
    responseBytes?: Uint8Array
  }> = {},
) {
  const { assetId, pack } = createPackWithMoc(bytes, options.hash)
  const responseBytes = options.responseBytes ?? bytes
  vi.stubGlobal(
    "fetch",
    vi.fn((input: URL | RequestInfo) => {
      const url =
        input instanceof URL
          ? input.href
          : typeof input === "string"
            ? input
            : input.url
      if (url.endsWith("/pack.json")) {
        return Promise.resolve(
          new Response(JSON.stringify(pack), {
            headers: { "content-type": "application/json" },
          }),
        )
      }
      const responseOptions =
        contentType === null
          ? undefined
          : { headers: { "content-type": contentType } }
      return Promise.resolve(
        new Response(responseBytes.buffer as ArrayBuffer, responseOptions),
      )
    }),
  )

  const signal = new AbortController().signal
  const client = await CharacterPackClient.load(
    { manifestUrl: "/characters/test/pack.json" },
    signal,
  )
  return { assetId, client, signal }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

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

  it.each([null, "application/octet-stream"])(
    "accepts a verified MOC with %s media type",
    async (contentType) => {
      const bytes = Uint8Array.from([1, 2, 3, 4])
      const { assetId, client, signal } = await loadMocFixture(
        bytes,
        contentType,
      )

      await expect(client.arrayBuffer(assetId, signal)).resolves.toEqual(
        bytes.buffer,
      )
    },
  )

  it("rejects an explicit unexpected MOC media type", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4])
    const { assetId, client, signal } = await loadMocFixture(bytes, "text/html")

    await expect(client.arrayBuffer(assetId, signal)).rejects.toThrow(
      "unexpected media type",
    )
  })

  it("rejects MOC bytes whose hash differs from the manifest", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4])
    const { assetId, client, signal } = await loadMocFixture(bytes, null, {
      hash: "0".repeat(64),
    })

    await expect(client.arrayBuffer(assetId, signal)).rejects.toThrow(
      "hash did not match",
    )
  })

  it("rejects MOC bytes whose length differs from the manifest", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4])
    const { assetId, client, signal } = await loadMocFixture(bytes, null, {
      responseBytes: Uint8Array.from([1, 2, 3, 4, 5]),
    })

    await expect(client.arrayBuffer(assetId, signal)).rejects.toThrow(
      "length did not match",
    )
  })
})
