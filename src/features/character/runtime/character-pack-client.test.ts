import { afterEach, describe, expect, it, vi } from "vitest"

import hiyoriPack from "../../../../src-tauri/resources/characters/builtin-hiyori/pack.json"
import characterFixture from "@/test/fixtures/character-library.v1.json"
import type { CharacterPackFile } from "@/features/character/model"
import {
  CharacterPackClient,
  isAcceptedCharacterResourceContentType,
  isSafeCharacterAssetId,
  parseCharacterPackManifest,
} from "@/features/character/runtime/character-pack-client"

const fixtureSha256 =
  "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a"

function createPackWithAsset(
  role: CharacterPackFile["role"],
  bytes: Uint8Array,
  hash = fixtureSha256,
) {
  const pack = structuredClone(hiyoriPack)
  const asset = pack.files.find((file) => file.role === role)
  if (asset === undefined) throw new Error(`${role} fixture is missing`)
  asset.bytes = bytes.byteLength
  asset.sha256 = hash
  pack.inventory.totalBytes = pack.files.reduce(
    (total, file) => total + file.bytes,
    0,
  )
  return { assetId: asset.assetId, pack }
}

async function loadAssetFixture(
  role: CharacterPackFile["role"],
  bytes: Uint8Array,
  contentType: string | null,
  options: Readonly<{
    hash?: string
    manifestContentType?: string | null
    responseBytes?: Uint8Array
  }> = {},
) {
  const { assetId, pack } = createPackWithAsset(role, bytes, options.hash)
  const responseBytes = options.responseBytes ?? bytes
  const manifestContentType = options.manifestContentType ?? "application/json"
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
        const responseOptions =
          manifestContentType === null
            ? undefined
            : { headers: { "content-type": manifestContentType } }
        return Promise.resolve(
          new Response(
            new TextEncoder().encode(JSON.stringify(pack)),
            responseOptions,
          ),
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
    { kind: "url", manifestUrl: "/characters/test/pack.json" },
    signal,
  )
  return { assetId, client, signal }
}

function stubManifestResponse(contentType: string | null) {
  const responseOptions =
    contentType === null
      ? undefined
      : { headers: { "content-type": contentType } }
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          new TextEncoder().encode(JSON.stringify(hiyoriPack)),
          responseOptions,
        ),
      ),
    ),
  )
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

  it("accepts an unattested custom preview from the Rust contract", () => {
    const manifest = parseCharacterPackManifest(
      structuredClone(characterFixture.importResponse.preview.manifest),
    )

    expect(manifest.packId).toBe("custom:11111111-1111-4111-8111-111111111111")
    expect(manifest.provenance.sourceKind).toBe("user_imported")
    expect(manifest.compatibility.expectedDrawables).toBeNull()
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
      "inventory does not match",
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

  it("rejects unknown manifest and file fields", () => {
    expect(() =>
      parseCharacterPackManifest({ ...hiyoriPack, sourcePath: "/tmp/model" }),
    ).toThrow("manifest shape")

    const pack = structuredClone(hiyoriPack)
    Object.assign(pack.files[0]!, { executable: "plugin.js" })
    expect(() => parseCharacterPackManifest(pack)).toThrow("file entry")
  })

  it.each(["application/json", "application/json; charset=utf-8"])(
    "accepts the manifest media type %s",
    async (contentType) => {
      stubManifestResponse(contentType)

      await expect(
        CharacterPackClient.load(
          { kind: "url", manifestUrl: "/characters/test/pack.json" },
          new AbortController().signal,
        ),
      ).resolves.toBeInstanceOf(CharacterPackClient)
    },
  )

  it.each([null, "text/html", "text/plain; charset=utf-8"])(
    "rejects the manifest media type %s",
    async (contentType) => {
      stubManifestResponse(contentType)

      await expect(
        CharacterPackClient.load(
          { kind: "url", manifestUrl: "/characters/test/pack.json" },
          new AbortController().signal,
        ),
      ).rejects.toThrow("unexpected media type")
    },
  )

  it("rejects a cross-origin manifest before fetching it", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)

    await expect(
      CharacterPackClient.load(
        { kind: "url", manifestUrl: "https://example.com/pack.json" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("same-origin")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ["manifest", "application/json"],
    ["manifest", "application/json; charset=utf-8"],
    ["model", "application/json"],
    ["motion", "application/json; charset=utf-8"],
    ["physics", "application/json"],
    ["pose", "application/json"],
    ["display_info", "application/json"],
    ["texture", "image/png"],
    ["moc", "application/octet-stream"],
    ["moc", null],
    ["shader", "text/plain; charset=utf-8"],
    ["shader", null],
  ] as const)("accepts %s only as %s", (kind, contentType) => {
    expect(isAcceptedCharacterResourceContentType(kind, contentType)).toBe(true)
  })

  it.each([
    ["manifest", "text/html"],
    ["model", "text/html"],
    ["motion", "text/html"],
    ["physics", "text/plain"],
    ["pose", "application/octet-stream"],
    ["display_info", "image/png"],
    ["texture", "application/json"],
    ["moc", "text/plain"],
    ["shader", "text/html"],
  ] as const)("rejects unexpected %s media type %s", (kind, contentType) => {
    expect(isAcceptedCharacterResourceContentType(kind, contentType)).toBe(
      false,
    )
  })

  it.each([null, "application/octet-stream"])(
    "accepts a verified MOC with %s media type",
    async (contentType) => {
      const bytes = Uint8Array.from([1, 2, 3, 4])
      const { assetId, client, signal } = await loadAssetFixture(
        "moc",
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
    const { assetId, client, signal } = await loadAssetFixture(
      "moc",
      bytes,
      "text/html",
    )

    await expect(client.arrayBuffer(assetId, signal)).rejects.toThrow(
      "unexpected media type",
    )
  })

  it.each([
    ["model", "text/html"],
    ["physics", "text/html"],
    ["pose", "text/plain"],
    ["motion", "application/octet-stream"],
    ["texture", "application/json"],
  ] as const)(
    "rejects fetched %s bytes with unexpected media type %s",
    async (role, contentType) => {
      const bytes = Uint8Array.from([1, 2, 3, 4])
      const { assetId, client, signal } = await loadAssetFixture(
        role,
        bytes,
        contentType,
      )

      await expect(client.arrayBuffer(assetId, signal)).rejects.toThrow(
        "unexpected media type",
      )
    },
  )

  it("rejects MOC bytes whose hash differs from the manifest", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4])
    const { assetId, client, signal } = await loadAssetFixture(
      "moc",
      bytes,
      null,
      {
        hash: "0".repeat(64),
      },
    )

    await expect(client.arrayBuffer(assetId, signal)).rejects.toThrow(
      "hash did not match",
    )
  })

  it("rejects MOC bytes whose length differs from the manifest", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4])
    const { assetId, client, signal } = await loadAssetFixture(
      "moc",
      bytes,
      null,
      {
        responseBytes: Uint8Array.from([1, 2, 3, 4, 5]),
      },
    )

    await expect(client.arrayBuffer(assetId, signal)).rejects.toThrow(
      "length did not match",
    )
  })

  it.each(["native", "memory"] as const)(
    "verifies %s binary assets without creating an asset URL",
    async (kind) => {
      const bytes = Uint8Array.from([1, 2, 3, 4])
      const { assetId, pack } = createPackWithAsset("moc", bytes)
      const manifest = parseCharacterPackManifest(pack)
      const readAsset = vi.fn(() => Promise.resolve(bytes.buffer))
      const ref =
        kind === "native"
          ? {
              kind,
              manifest,
              manifestHash: "d".repeat(64),
              previewToken: null,
              readAsset,
            }
          : {
              kind,
              manifest,
              assets: new Map([[assetId, bytes.buffer]]),
            }
      const client = await CharacterPackClient.load(
        ref,
        new AbortController().signal,
      )

      await expect(
        client.arrayBuffer(assetId, new AbortController().signal),
      ).resolves.toEqual(bytes.buffer)
      if (kind === "native") {
        expect(readAsset).toHaveBeenCalledWith(
          assetId,
          "application/octet-stream",
          expect.any(AbortSignal),
        )
      }
    },
  )
})
