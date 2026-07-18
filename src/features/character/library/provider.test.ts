import { describe, expect, it, vi } from "vitest"

import fixture from "@/test/fixtures/character-library.v1.json"
import {
  parseCharacterImportResponse,
  parseCharacterLibrarySnapshot,
  type CharacterImportResponse,
  type CharacterLibrarySnapshot,
  type CharacterPreviewAttestationRequest,
  type CharacterPreviewAttestationResponse,
} from "@/features/character/library/contracts"
import { CharacterLibraryStore } from "@/features/character/library/provider"
import {
  CharacterLibraryOperationError,
  type CharacterLibraryGateway,
} from "@/features/character/library/transport"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function createGateway(
  overrides: Partial<CharacterLibraryGateway> = {},
): CharacterLibraryGateway {
  const snapshot = parseCharacterLibrarySnapshot(fixture.librarySnapshot)
  const imported = parseCharacterImportResponse(fixture.importResponse)
  return {
    kind: "native",
    getLibrary: () => Promise.resolve(snapshot),
    pickImport: () => Promise.resolve(imported),
    attestPreview: (request) =>
      Promise.resolve({
        schemaVersion: 1,
        attested: true,
        rendererNonce: request.rendererNonce,
      }),
    confirmImport: () => Promise.resolve(snapshot),
    cancelImport: () => Promise.resolve(),
    selectPack: () => Promise.resolve(snapshot),
    deletePack: () => Promise.resolve(snapshot),
    createPackRef: () => ({
      kind: "url",
      manifestUrl: "/characters/builtin-hiyori/pack.json",
    }),
    createPreviewPackRef: (preview) => ({
      kind: "memory",
      manifest: preview.manifest,
      assets: new Map(),
    }),
    ...overrides,
  }
}

describe("CharacterLibraryStore", () => {
  it("deduplicates workspace hydration and publishes one stable snapshot", async () => {
    const loading = deferred<CharacterLibrarySnapshot>()
    const getLibrary = vi.fn(() => loading.promise)
    const store = new CharacterLibraryStore(createGateway({ getLibrary }))
    const listener = vi.fn()
    store.subscribe(listener)

    const first = store.load(fixture.libraryRequest.workspaceId)
    const second = store.load(fixture.libraryRequest.workspaceId)
    expect(first).toBe(second)
    expect(getLibrary).toHaveBeenCalledOnce()
    expect(store.getState(fixture.libraryRequest.workspaceId).status).toBe(
      "loading",
    )

    loading.resolve(parseCharacterLibrarySnapshot(fixture.librarySnapshot))
    await first
    expect(store.getState(fixture.libraryRequest.workspaceId)).toMatchObject({
      status: "ready",
      snapshot: { selectedPackId: "builtin:hiyori_pro" },
      errorCode: null,
    })
    expect(listener).toHaveBeenCalled()
  })

  it("tracks preview, one attestation, confirmation, selection, and deletion", async () => {
    const imported = parseCharacterImportResponse(fixture.importResponse)
    const snapshot = parseCharacterLibrarySnapshot(fixture.librarySnapshot)
    const attestPreview = vi.fn((request: CharacterPreviewAttestationRequest) =>
      Promise.resolve<CharacterPreviewAttestationResponse>({
        schemaVersion: 1,
        attested: true,
        rendererNonce: request.rendererNonce,
      }),
    )
    const confirmImport = vi.fn(() => Promise.resolve(snapshot))
    const gateway = createGateway({
      pickImport: vi.fn(() => Promise.resolve(imported)),
      attestPreview,
      confirmImport,
      selectPack: vi.fn(() => Promise.resolve(snapshot)),
      deletePack: vi.fn(() => Promise.resolve(snapshot)),
    })
    const store = new CharacterLibraryStore(gateway)
    const workspaceId = fixture.libraryRequest.workspaceId
    const releaseSession = store.acquireSession(workspaceId)

    await store.beginImport(workspaceId)
    expect(store.getState(workspaceId).preview?.previewToken).toBe(
      fixture.importResponse.preview.previewToken,
    )
    await store.attestPreview(workspaceId, fixture.attestationRequest)
    await store.confirmImport(fixture.confirmRequest)
    expect(store.getState(workspaceId).preview).toBeNull()
    await store.selectPack(workspaceId, "builtin:hiyori_pro")
    await store.deletePack(workspaceId, fixture.importResponse.preview.packId)
    expect(attestPreview).toHaveBeenCalledWith(fixture.attestationRequest)
    expect(confirmImport).toHaveBeenCalledWith(fixture.confirmRequest)
    releaseSession()
  })

  it("serializes mutations and retains only a stable error code", async () => {
    const importing = deferred<CharacterImportResponse>()
    const gateway = createGateway({
      pickImport: () => importing.promise,
    })
    const store = new CharacterLibraryStore(gateway)
    const workspaceId = fixture.libraryRequest.workspaceId
    const first = store.beginImport(workspaceId)
    await expect(store.beginImport(workspaceId)).rejects.toBeInstanceOf(
      CharacterLibraryOperationError,
    )
    importing.reject(
      new CharacterLibraryOperationError({
        ...fixture.error,
        operation: "character_import_pick",
        userMessageKey: "character.error.generic" as const,
        detailRef: "character-library-v1" as const,
      }),
    )
    await expect(first).rejects.toThrow(fixture.error.code)
    expect(store.getState(workspaceId)).toMatchObject({
      mutation: null,
      errorCode: fixture.error.code,
    })
  })

  it("ignores a Strict Mode release when the same section immediately reacquires its lease", async () => {
    const cancelImport = vi.fn(() => Promise.resolve())
    const store = new CharacterLibraryStore(createGateway({ cancelImport }))
    const workspaceId = fixture.libraryRequest.workspaceId
    const firstRelease = store.acquireSession(workspaceId)
    await store.beginImport(workspaceId)

    firstRelease()
    const secondRelease = store.acquireSession(workspaceId)
    await Promise.resolve()
    expect(cancelImport).not.toHaveBeenCalled()
    expect(store.getState(workspaceId).preview).not.toBeNull()

    secondRelease()
    await vi.waitFor(() => expect(cancelImport).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(store.getState(workspaceId).preview).toBeNull(),
    )
  })

  it("cancels the exact preview when a main-tab or section departure happens during picker loading", async () => {
    const importing = deferred<CharacterImportResponse>()
    const cancelImport = vi.fn(() => Promise.resolve())
    const store = new CharacterLibraryStore(
      createGateway({
        pickImport: () => importing.promise,
        cancelImport,
      }),
    )
    const workspaceId = fixture.libraryRequest.workspaceId
    const releaseSession = store.acquireSession(workspaceId)
    const importPromise = store.beginImport(workspaceId)
    releaseSession()
    importing.resolve(parseCharacterImportResponse(fixture.importResponse))
    await importPromise

    await vi.waitFor(() => expect(cancelImport).toHaveBeenCalledOnce())
    expect(cancelImport).toHaveBeenCalledWith({
      previewToken: fixture.importResponse.preview.previewToken,
      previewNonce: fixture.importResponse.preview.previewNonce,
      generation: fixture.importResponse.preview.generation,
    })
    await vi.waitFor(() =>
      expect(store.getState(workspaceId).preview).toBeNull(),
    )
  })

  it("deduplicates workspace departure cleanup while attestation is in flight", async () => {
    const attesting = deferred<CharacterPreviewAttestationResponse>()
    const cancelImport = vi.fn(() => Promise.resolve())
    const store = new CharacterLibraryStore(
      createGateway({
        attestPreview: () => attesting.promise,
        cancelImport,
      }),
    )
    const workspaceId = fixture.libraryRequest.workspaceId
    const releaseSession = store.acquireSession(workspaceId)
    await store.beginImport(workspaceId)
    const attestationPromise = store.attestPreview(
      workspaceId,
      fixture.attestationRequest,
    )
    releaseSession()
    releaseSession()

    await vi.waitFor(() => expect(cancelImport).toHaveBeenCalledOnce())
    attesting.resolve({
      schemaVersion: 1,
      attested: true,
      rendererNonce: fixture.attestationRequest.rendererNonce,
    })
    await attestationPromise
    await vi.waitFor(() =>
      expect(store.getState(workspaceId).preview).toBeNull(),
    )
    expect(store.consumeRestoreFocus(workspaceId)).toBe(true)
    expect(store.consumeRestoreFocus(workspaceId)).toBe(false)
  })
})
