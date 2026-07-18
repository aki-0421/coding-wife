import { describe, expect, it } from "vitest"

import fixture from "@/test/fixtures/character-library.v1.json"
import type { CharacterFrameMetrics } from "@/features/character/model"
import {
  createCharacterPreviewFailureMessage,
  createCharacterPreviewLoadMessage,
  createCharacterPreviewSuccessMessage,
  parseCharacterPreviewLoadMessage,
  parseCharacterPreviewResultMessage,
} from "@/features/character/import-preview/preview-protocol"
import { parseCharacterPackManifest } from "@/features/character/runtime/character-pack-client"

const channelNonce = "55555555-5555-4555-8555-555555555555"

function assetsForFixture() {
  const manifest = parseCharacterPackManifest(
    fixture.importResponse.preview.manifest,
  )
  return new Map(
    manifest.files.map((file) => [file.assetId, new ArrayBuffer(file.bytes)]),
  )
}

function frameMetrics(): CharacterFrameMetrics {
  return {
    frameCount: 2,
    nonTransparentSamples: 24,
    signature: "deadbeef",
    signatureChanges: 1,
    backingWidth: 640,
    backingHeight: 640,
    lastDeltaMilliseconds: 16,
    webglError: 0,
    modelInventory: {
      parameterCount: 70,
      partCount: 24,
      drawableCount: 134,
      textureDecodeCount: 1,
    },
  }
}

describe("isolated character preview protocol", () => {
  it("accepts one complete in-memory pack without paths or capabilities", () => {
    const manifest = parseCharacterPackManifest(
      fixture.importResponse.preview.manifest,
    )
    const message = createCharacterPreviewLoadMessage(
      channelNonce,
      fixture.importResponse.preview.previewNonce,
      fixture.importResponse.preview.generation,
      manifest,
      assetsForFixture(),
    )
    const parsed = parseCharacterPreviewLoadMessage(message)

    expect(parsed.assets).toHaveLength(manifest.files.length)
    expect(
      parsed.assets.every((asset) => asset.bytes instanceof ArrayBuffer),
    ).toBe(true)
    expect(JSON.stringify(parsed)).not.toContain("previewToken")
    expect(JSON.stringify(parsed)).not.toContain("/Users/")
  })

  it("rejects missing, duplicate, oversized-generation, and unexpected payloads", () => {
    const manifest = parseCharacterPackManifest(
      fixture.importResponse.preview.manifest,
    )
    const valid = createCharacterPreviewLoadMessage(
      channelNonce,
      fixture.importResponse.preview.previewNonce,
      fixture.importResponse.preview.generation,
      manifest,
      assetsForFixture(),
    )
    expect(() =>
      parseCharacterPreviewLoadMessage({
        ...valid,
        generation: fixture.generationOverflow,
      }),
    ).toThrow("CHARACTER-PREVIEW-PROTOCOL")
    expect(() =>
      parseCharacterPreviewLoadMessage({
        ...valid,
        assets: [valid.assets[0], valid.assets[0]],
      }),
    ).toThrow("CHARACTER-PREVIEW-PROTOCOL")
    expect(() =>
      parseCharacterPreviewLoadMessage({ ...valid, previewToken: "secret" }),
    ).toThrow("CHARACTER-PREVIEW-PROTOCOL")
    expect(() =>
      parseCharacterPreviewLoadMessage({
        ...valid,
        assets: valid.assets.slice(1),
      }),
    ).toThrow("CHARACTER-PREVIEW-PROTOCOL")
  })

  it("binds visible-frame evidence to both nonces and the safe generation", () => {
    const result = createCharacterPreviewSuccessMessage(
      {
        channelNonce,
        previewNonce: fixture.importResponse.preview.previewNonce,
        generation: fixture.importResponse.preview.generation,
        rendererNonce: fixture.attestationRequest.rendererNonce,
      },
      frameMetrics(),
      true,
      fixture.attestationRequest.thumbnailSha256,
      new Uint8Array(fixture.attestationRequest.thumbnailPng).buffer,
    )
    expect(parseCharacterPreviewResultMessage(result)).toEqual(result)
    expect(result).toMatchObject({
      frameCount: 2,
      nonTransparentSamples: 24,
      textureDecodeCount: 1,
      stateCueObserved: true,
      webglError: 0,
      parameterCount: 70,
      partCount: 24,
      drawableCount: 134,
    })
  })

  it("rejects fake attestation, stale generation, unknown fields, and raw errors", () => {
    const identity = {
      channelNonce,
      previewNonce: fixture.importResponse.preview.previewNonce,
      generation: fixture.importResponse.preview.generation,
      rendererNonce: fixture.attestationRequest.rendererNonce,
    }
    const valid = createCharacterPreviewSuccessMessage(
      identity,
      frameMetrics(),
      true,
      fixture.attestationRequest.thumbnailSha256,
      new Uint8Array(fixture.attestationRequest.thumbnailPng).buffer,
    )
    for (const mutation of [
      { ...valid, stateCueObserved: false },
      { ...valid, nonTransparentSamples: 0 },
      { ...valid, generation: fixture.generationOverflow },
      { ...valid, webglError: 1280 },
      { ...valid, rawMessage: "/Users/private/model" },
    ]) {
      expect(() => parseCharacterPreviewResultMessage(mutation)).toThrow(
        "CHARACTER-PREVIEW-PROTOCOL",
      )
    }
    expect(() =>
      createCharacterPreviewFailureMessage(identity, "/Users/private/error"),
    ).toThrow("CHARACTER-PREVIEW-PROTOCOL")
  })

  it("allows only a stable renderer error code in failure results", () => {
    const failure = createCharacterPreviewFailureMessage(
      {
        channelNonce,
        previewNonce: fixture.importResponse.preview.previewNonce,
        generation: fixture.importResponse.preview.generation,
      },
      "moc_invalid",
    )
    expect(parseCharacterPreviewResultMessage(failure)).toEqual(failure)
  })
})
