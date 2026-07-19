import { describe, expect, it } from "vitest"

import fixture from "@/test/fixtures/character-library.v1.json"
import {
  CharacterLibraryContractError,
  characterLibrarySchemaVersion,
  parseCharacterAssetRequest,
  parseCharacterCancelImportRequest,
  parseCharacterCommandError,
  parseCharacterConfirmImportRequest,
  parseCharacterDeleteRequest,
  parseCharacterImportResponse,
  parseCharacterLibraryRequest,
  parseCharacterLibrarySnapshot,
  parseCharacterPreviewAttestationRequest,
  parseCharacterPreviewAttestationResponse,
  parseCharacterSelectRequest,
  parseCharacterSemanticMappingSaveRequest,
} from "@/features/character/library/contracts"
import { parseCharacterPackManifest } from "@/features/character/runtime/character-pack-client"

describe("character library contract", () => {
  it("parses every Rust contract fixture without shape drift", () => {
    expect(fixture.schemaVersion).toBe(characterLibrarySchemaVersion)
    expect(parseCharacterLibraryRequest(fixture.libraryRequest)).toEqual(
      fixture.libraryRequest,
    )
    expect(parseCharacterAssetRequest(fixture.assetRequest)).toEqual(
      fixture.assetRequest,
    )
    expect(
      parseCharacterPreviewAttestationRequest(fixture.attestationRequest),
    ).toEqual(fixture.attestationRequest)
    expect(
      parseCharacterPreviewAttestationResponse(fixture.attestationResponse),
    ).toEqual(fixture.attestationResponse)
    expect(parseCharacterConfirmImportRequest(fixture.confirmRequest)).toEqual(
      fixture.confirmRequest,
    )
    expect(parseCharacterCancelImportRequest(fixture.cancelRequest)).toEqual(
      fixture.cancelRequest,
    )
    expect(parseCharacterSelectRequest(fixture.selectRequest)).toEqual(
      fixture.selectRequest,
    )
    expect(parseCharacterDeleteRequest(fixture.deleteRequest)).toEqual(
      fixture.deleteRequest,
    )
    expect(
      parseCharacterSemanticMappingSaveRequest(
        fixture.semanticMappingSaveRequest,
      ),
    ).toEqual(fixture.semanticMappingSaveRequest)
    expect(parseCharacterImportResponse(fixture.importResponse)).toEqual(
      fixture.importResponse,
    )
    expect(
      parseCharacterImportResponse(fixture.canceledImportResponse),
    ).toEqual(fixture.canceledImportResponse)
    expect(parseCharacterLibrarySnapshot(fixture.librarySnapshot)).toEqual(
      fixture.librarySnapshot,
    )
    expect(parseCharacterCommandError(fixture.error)).toEqual(fixture.error)
  })

  it("accepts the JS safe generation boundary and rejects the next integer", () => {
    expect(
      parseCharacterPreviewAttestationRequest({
        ...fixture.attestationRequest,
        generation: fixture.generationBoundary,
      }).generation,
    ).toBe(Number.MAX_SAFE_INTEGER)
    expect(() =>
      parseCharacterPreviewAttestationRequest({
        ...fixture.attestationRequest,
        generation: fixture.generationOverflow,
      }),
    ).toThrow(CharacterLibraryContractError)
    expect(() =>
      parseCharacterCancelImportRequest({
        ...fixture.cancelRequest,
        generation: fixture.generationOverflow,
      }),
    ).toThrow(CharacterLibraryContractError)
  })

  it("accepts dotted cue IDs through 80 ASCII bytes and rejects URLs or overflow", () => {
    const cue79 = `${"a".repeat(76)}[0]`
    const cue80 = `${"a".repeat(77)}[0]`
    const cue81 = `${"a".repeat(78)}[0]`
    const requestWithCue = (cueId: string) => ({
      ...fixture.semanticMappingSaveRequest,
      assignments: {
        ...fixture.semanticMappingSaveRequest.assignments,
        success: { kind: "motion", cueId },
      },
    })

    expect(
      parseCharacterSemanticMappingSaveRequest(requestWithCue("Tap.Body[0]"))
        .assignments.success,
    ).toEqual({ kind: "motion", cueId: "Tap.Body[0]" })
    expect(
      parseCharacterSemanticMappingSaveRequest(requestWithCue(cue79))
        .assignments.success,
    ).toEqual({ kind: "motion", cueId: cue79 })
    expect(
      parseCharacterSemanticMappingSaveRequest(requestWithCue(cue80))
        .assignments.success,
    ).toEqual({ kind: "motion", cueId: cue80 })
    expect(() =>
      parseCharacterSemanticMappingSaveRequest(
        requestWithCue("https://example.test/Tap.motion3.json"),
      ),
    ).toThrow(CharacterLibraryContractError)
    expect(() =>
      parseCharacterSemanticMappingSaveRequest(requestWithCue(cue81)),
    ).toThrow(CharacterLibraryContractError)
  })

  it("rejects unknown fields, snake case, future schemas, and private paths", () => {
    expect(() =>
      parseCharacterLibrarySnapshot({
        ...fixture.librarySnapshot,
        schemaVersion: 2,
      }),
    ).toThrow(CharacterLibraryContractError)
    expect(() =>
      parseCharacterLibraryRequest({
        ...fixture.libraryRequest,
        workspace_id: fixture.libraryRequest.workspaceId,
      }),
    ).toThrow(CharacterLibraryContractError)
    expect(() =>
      parseCharacterImportResponse({
        ...fixture.importResponse,
        preview: {
          ...fixture.importResponse.preview,
          sourcePath: "/\u0055sers/private/model",
        },
      }),
    ).toThrow(CharacterLibraryContractError)
    expect(
      parseCharacterCommandError({
        ...fixture.error,
        detailRef: "/\u0055sers/private/diagnostic",
      }),
    ).toBeNull()
  })

  it("keeps preview manifests unattested and published manifests fully attested", () => {
    const preview = parseCharacterImportResponse(fixture.importResponse).preview
    expect(preview?.manifest.compatibility.expectedDrawables).toBeNull()

    const previewManifest = parseCharacterPackManifest(
      fixture.importResponse.preview.manifest,
    )
    const manifest = {
      ...previewManifest,
      compatibility: {
        ...previewManifest.compatibility,
        expectedParameters: 70,
        expectedParts: 24,
        expectedDrawables: 134,
      },
      trustedFrame: {
        assetId: "__coding-wife/trusted-frame.png",
        bytes: fixture.attestationRequest.thumbnailPng.length,
        sha256: fixture.attestationRequest.thumbnailSha256,
        dimensions: { width: 1, height: 1 },
      },
    }
    const custom = {
      ...fixture.librarySnapshot.packs[0],
      packId: manifest.packId,
      displayName: manifest.displayName,
      kind: "custom",
      provenanceLabel: "Local folder",
      importedAt: manifest.importedAt,
      runtimeFileCount: manifest.inventory.runtimeFileCount,
      totalBytes: manifest.inventory.totalBytes,
      textureCount: manifest.inventory.textureCount,
      motionCount: manifest.inventory.motionCount,
      expressionCount: manifest.inventory.expressionCount,
      selectedProjectCount: 0,
      deletable: true,
      manifest,
      thumbnailSha256: manifest.trustedFrame.sha256,
      cueInventory: { motions: [], expressions: [] },
    }
    expect(
      parseCharacterLibrarySnapshot({
        ...fixture.librarySnapshot,
        packs: [fixture.librarySnapshot.packs[0], custom],
      }).packs[1]?.manifest?.compatibility.expectedDrawables,
    ).toBe(134)
  })

  it("rejects custom manifest resource escalation and partial attestation", () => {
    const oversized = structuredClone(
      fixture.importResponse.preview.manifest,
    ) as unknown as {
      files: { dimensions?: { width: number } }[]
    }
    const texture = oversized.files[2]
    if (texture?.dimensions === undefined) throw new Error("texture fixture")
    texture.dimensions.width = 8193
    expect(() => parseCharacterPackManifest(oversized)).toThrow(
      "texture dimensions",
    )

    const partial = {
      ...fixture.importResponse.preview.manifest,
      compatibility: {
        ...fixture.importResponse.preview.manifest.compatibility,
        expectedParameters: 70,
      },
    }
    expect(() => parseCharacterPackManifest(partial)).toThrow("attestation")

    const unknown = {
      ...fixture.importResponse.preview.manifest,
      executable: "plugin.js",
    }
    expect(() => parseCharacterPackManifest(unknown)).toThrow("manifest shape")
  })
})
