import { describe, expect, it, vi } from "vitest"

import fixture from "@/test/fixtures/character-library.v1.json"
import {
  characterLibraryCommands,
  parseCharacterImportResponse,
  parseCharacterSemanticMappingSaveRequest,
} from "@/features/character/library/contracts"
import {
  CharacterLibraryOperationError,
  DemoCharacterLibraryGateway,
  NativeCharacterLibraryGateway,
} from "@/features/character/library/transport"

type FakeInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>

describe("native character library transport", () => {
  it("routes exact request envelopes through response parsers", async () => {
    const invoke = vi.fn((command: string) => {
      if (command === characterLibraryCommands.get) {
        return Promise.resolve(fixture.librarySnapshot)
      }
      if (command === characterLibraryCommands.pickImport) {
        return Promise.resolve(fixture.importResponse)
      }
      if (command === characterLibraryCommands.saveSemanticMapping) {
        return Promise.resolve(fixture.librarySnapshot)
      }
      throw new Error("unexpected command")
    }) as unknown as FakeInvoke
    const gateway = new NativeCharacterLibraryGateway(invoke)

    await expect(gateway.getLibrary(fixture.libraryRequest)).resolves.toEqual(
      fixture.librarySnapshot,
    )
    await expect(gateway.pickImport(fixture.libraryRequest)).resolves.toEqual(
      fixture.importResponse,
    )
    await expect(
      gateway.saveSemanticMapping(
        parseCharacterSemanticMappingSaveRequest(
          fixture.semanticMappingSaveRequest,
        ),
      ),
    ).resolves.toEqual(fixture.librarySnapshot)
    expect(invoke).toHaveBeenNthCalledWith(1, characterLibraryCommands.get, {
      request: fixture.libraryRequest,
    })
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      characterLibraryCommands.pickImport,
      { request: fixture.libraryRequest },
    )
    expect(invoke).toHaveBeenNthCalledWith(
      3,
      characterLibraryCommands.saveSemanticMapping,
      { request: fixture.semanticMappingSaveRequest },
    )
  })

  it("accepts only binary IPC responses and forwards every asset capability", async () => {
    const invoke = vi.fn(() =>
      Promise.resolve(Uint8Array.from([1, 2, 3, 4])),
    ) as unknown as FakeInvoke
    const gateway = new NativeCharacterLibraryGateway(invoke)
    const preview = parseCharacterImportResponse(
      fixture.importResponse,
    ).preview!
    const ref = gateway.createPreviewPackRef(preview)
    expect(ref.kind).toBe("native")
    if (ref.kind !== "native") throw new Error("native ref expected")

    await expect(
      ref.readAsset(
        preview.manifest.entrypoint,
        "application/json",
        new AbortController().signal,
      ),
    ).resolves.toEqual(Uint8Array.from([1, 2, 3, 4]).buffer)
    expect(invoke).toHaveBeenCalledWith(characterLibraryCommands.readAsset, {
      request: {
        packId: preview.packId,
        assetId: preview.manifest.entrypoint,
        manifestHash: preview.manifestHash,
        expectedMime: "application/json",
        previewToken: preview.previewToken,
      },
    })

    const jsonInvoke = vi.fn(() => Promise.resolve([1, 2, 3, 4]))
    const rejected = new NativeCharacterLibraryGateway(
      jsonInvoke as unknown as FakeInvoke,
    ).createPreviewPackRef(preview)
    if (rejected.kind !== "native") throw new Error("native ref expected")
    await expect(
      rejected.readAsset(
        preview.manifest.entrypoint,
        "application/json",
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(CharacterLibraryOperationError)
  })

  it("projects native errors to stable codes without trusting raw detail", async () => {
    const nativeError = Object.assign(
      new Error(fixture.error.code),
      fixture.error,
    )
    const gateway = new NativeCharacterLibraryGateway((() =>
      Promise.reject(nativeError)) as FakeInvoke)
    await expect(
      gateway.getLibrary(fixture.libraryRequest),
    ).rejects.toMatchObject({
      code: fixture.error.code,
      operation: fixture.error.operation,
      recoverable: fixture.error.recoverable,
      message: fixture.error.code,
    })

    const malformedError = Object.assign(new Error(fixture.error.code), {
      ...fixture.error,
      detailRef: "/Users/private/raw-error",
    })
    const malformed = new NativeCharacterLibraryGateway((() =>
      Promise.reject(malformedError)) as FakeInvoke)
    await expect(malformed.getLibrary(fixture.libraryRequest)).rejects.toThrow(
      "CHARACTER-IPC-FAILED",
    )
  })

  it("does not start a binary IPC read for an already aborted signal", async () => {
    const invoke = vi.fn()
    const gateway = new NativeCharacterLibraryGateway(invoke)
    const preview = parseCharacterImportResponse(
      fixture.importResponse,
    ).preview!
    const ref = gateway.createPreviewPackRef(preview)
    if (ref.kind !== "native") throw new Error("native ref expected")
    const controller = new AbortController()
    controller.abort(new Error("canceled"))
    await expect(
      ref.readAsset(
        preview.manifest.entrypoint,
        "application/json",
        controller.signal,
      ),
    ).rejects.toThrow("canceled")
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe("demo character library transport", () => {
  it("exposes only bundled Hiyori and treats native import as canceled", async () => {
    const gateway = new DemoCharacterLibraryGateway()
    const snapshot = await gateway.getLibrary(fixture.libraryRequest)
    expect(snapshot.selectedPackId).toBe("builtin:hiyori_pro")
    expect(snapshot.packs).toHaveLength(1)
    expect(gateway.createPackRef(snapshot.packs[0]!)).toEqual({
      kind: "url",
      manifestUrl: "/characters/builtin-hiyori/pack.json",
    })
    await expect(gateway.pickImport(fixture.libraryRequest)).resolves.toEqual({
      schemaVersion: 1,
      outcome: "canceled",
      preview: null,
    })
  })
})
