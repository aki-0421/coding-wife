import { describe, expect, it, vi } from "vitest"

import fixture from "@/test/fixtures/character-library.v1.json"
import {
  parseCharacterImportResponse,
  parseCharacterLibrarySnapshot,
  type CharacterImportResponse,
  type CharacterLibrarySnapshot,
  type CharacterPackView,
  type CharacterPreviewAttestationRequest,
  type CharacterPreviewAttestationResponse,
  type SemanticMappingV1,
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
    saveSemanticMapping: () => Promise.resolve(snapshot),
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

function projectSnapshot(
  snapshot: CharacterLibrarySnapshot,
  workspaceId: string,
  projectId: string,
  overrides: Partial<CharacterLibrarySnapshot> = {},
): CharacterLibrarySnapshot {
  return { ...snapshot, workspaceId, projectId, ...overrides }
}

function withMappingVersion(
  snapshot: CharacterLibrarySnapshot,
  mappingVersion: number,
): CharacterLibrarySnapshot {
  return {
    ...snapshot,
    semanticMappingStatus: "saved",
    semanticMapping: {
      ...snapshot.semanticMapping,
      mappingVersion,
    } satisfies SemanticMappingV1,
  }
}

function mappingConflict(): CharacterLibraryOperationError {
  return new CharacterLibraryOperationError({
    code: "CHARACTER-MAPPING-CONFLICT",
    operation: "character_semantic_mapping_save",
    recoverable: true,
    userMessageKey: "character.error.generic",
    detailRef: "character-library-v1",
  })
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

  it("publishes app-scoped mutations to every hydrated sibling workspace", async () => {
    const snapshot = parseCharacterLibrarySnapshot(fixture.librarySnapshot)
    const getLibrary = vi.fn((request: { readonly workspaceId: string }) =>
      Promise.resolve({ ...snapshot, workspaceId: request.workspaceId }),
    )
    const changed = {
      ...snapshot,
      workspaceId: "workspace-primary",
      diagnostics: ["CHARACTER-SELECTION-FALLBACK"],
      fallbackApplied: true,
    } satisfies CharacterLibrarySnapshot
    const store = new CharacterLibraryStore(
      createGateway({
        getLibrary,
        selectPack: () => Promise.resolve(changed),
      }),
    )
    await store.load("workspace-primary")
    await store.load("workspace-sibling")

    await store.selectPack("workspace-primary", "builtin:hiyori_pro")

    expect(store.getState("workspace-sibling").snapshot).toMatchObject({
      workspaceId: "workspace-sibling",
      projectId: snapshot.projectId,
      fallbackApplied: true,
      diagnostics: ["CHARACTER-SELECTION-FALLBACK"],
    })
  })

  it("publishes an app-global pack deletion atomically to every hydrated workspace", async () => {
    const snapshot = parseCharacterLibrarySnapshot(fixture.librarySnapshot)
    const builtinPack = snapshot.packs[0]
    if (builtinPack === undefined) throw new Error("builtin pack fixture")
    const customPack: CharacterPackView = {
      ...builtinPack,
      packId: "custom:11111111-1111-4111-8111-111111111111",
      displayName: "Project A pack",
      kind: "custom" as const,
      deletable: true,
    }
    const projectA = projectSnapshot(snapshot, "workspace-a", "project-a", {
      packs: [...snapshot.packs, customPack],
      selectedPackId: customPack.packId,
      semanticMapping: {
        ...snapshot.semanticMapping,
        packId: customPack.packId,
      },
    })
    const projectB = projectSnapshot(snapshot, "workspace-b", "project-b", {
      packs: [...snapshot.packs, customPack],
    })
    const deletedA = projectSnapshot(snapshot, "workspace-a", "project-a")
    const deletedB = projectSnapshot(snapshot, "workspace-b", "project-b")
    const projectBRefresh = deferred<CharacterLibrarySnapshot>()
    let hydrate = true
    const getLibrary = vi.fn(
      ({ workspaceId }: { readonly workspaceId: string }) => {
        if (hydrate) {
          return Promise.resolve(
            workspaceId === "workspace-a" ? projectA : projectB,
          )
        }
        return projectBRefresh.promise
      },
    )
    const store = new CharacterLibraryStore(
      createGateway({
        getLibrary,
        deletePack: () => Promise.resolve(deletedA),
      }),
    )
    await store.load("workspace-a")
    await store.load("workspace-b")
    hydrate = false

    const deletion = store.deletePack("workspace-a", customPack.packId)
    await Promise.resolve()

    expect(store.getState("workspace-a").snapshot?.packs).toHaveLength(2)
    expect(store.getState("workspace-b").snapshot?.packs).toHaveLength(2)
    expect(store.getState("workspace-a").mutation).toBe("deleting")

    projectBRefresh.resolve(deletedB)
    await deletion

    expect(store.getState("workspace-a").snapshot).toMatchObject({
      projectId: "project-a",
      selectedPackId: "builtin:hiyori_pro",
      packs: [{ packId: "builtin:hiyori_pro" }],
    })
    expect(store.getState("workspace-b").snapshot).toMatchObject({
      projectId: "project-b",
      selectedPackId: "builtin:hiyori_pro",
      packs: [{ packId: "builtin:hiyori_pro" }],
    })
  })

  it("recovers a pending project hydration after a global deletion", async () => {
    const snapshot = parseCharacterLibrarySnapshot(fixture.librarySnapshot)
    const projectA = projectSnapshot(snapshot, "workspace-a", "project-a")
    const staleProjectB = projectSnapshot(
      snapshot,
      "workspace-b",
      "project-b",
      { diagnostics: ["CHARACTER-SELECTION-FALLBACK"] },
    )
    const freshProjectB = projectSnapshot(snapshot, "workspace-b", "project-b")
    const staleHydration = deferred<CharacterLibrarySnapshot>()
    const freshHydration = deferred<CharacterLibrarySnapshot>()
    let projectBLoads = 0
    const store = new CharacterLibraryStore(
      createGateway({
        getLibrary: ({ workspaceId }) => {
          if (workspaceId === "workspace-a") return Promise.resolve(projectA)
          projectBLoads += 1
          return projectBLoads === 1
            ? staleHydration.promise
            : freshHydration.promise
        },
        deletePack: () => Promise.resolve(projectA),
      }),
    )
    await store.load("workspace-a")
    const staleLoad = store.load("workspace-b")

    await store.deletePack("workspace-a", "custom:deleted")

    expect(store.getState("workspace-b")).toMatchObject({
      status: "idle",
      snapshot: null,
      errorCode: null,
    })
    const freshLoad = store.load("workspace-b")
    expect(store.getState("workspace-b").status).toBe("loading")

    staleHydration.resolve(staleProjectB)
    await staleLoad

    expect(store.getState("workspace-b")).toMatchObject({
      status: "loading",
      snapshot: null,
    })
    expect(store.load("workspace-b")).toBe(freshLoad)

    freshHydration.resolve(freshProjectB)
    await freshLoad
    expect(store.getState("workspace-b")).toMatchObject({
      status: "ready",
      snapshot: {
        projectId: "project-b",
        diagnostics: [],
      },
    })
  })

  it("invalidates an early pending hydration error when a global mutation publishes", async () => {
    const snapshot = parseCharacterLibrarySnapshot(fixture.librarySnapshot)
    const projectA = projectSnapshot(snapshot, "workspace-a", "project-a")
    const projectB = projectSnapshot(snapshot, "workspace-b", "project-b")
    const projectC = projectSnapshot(snapshot, "workspace-c", "project-c")
    const staleHydration = deferred<CharacterLibrarySnapshot>()
    const projectCRefresh = deferred<CharacterLibrarySnapshot>()
    let projectBLoads = 0
    let refreshHydratedProjects = false
    const getLibrary = vi.fn(({ workspaceId }: { workspaceId: string }) => {
      if (workspaceId === "workspace-a") return Promise.resolve(projectA)
      if (workspaceId === "workspace-c") {
        return refreshHydratedProjects
          ? projectCRefresh.promise
          : Promise.resolve(projectC)
      }
      projectBLoads += 1
      return projectBLoads === 1
        ? staleHydration.promise
        : Promise.resolve(projectB)
    })
    const store = new CharacterLibraryStore(
      createGateway({
        getLibrary,
        deletePack: () => Promise.resolve(projectA),
      }),
    )
    await store.load("workspace-a")
    await store.load("workspace-c")
    const staleLoad = store.load("workspace-b")
    refreshHydratedProjects = true

    const deletion = store.deletePack("workspace-a", "custom:deleted")
    await vi.waitFor(() => expect(getLibrary).toHaveBeenCalledTimes(4))
    staleHydration.reject(new CharacterLibraryOperationError())
    await expect(staleLoad).rejects.toBeInstanceOf(
      CharacterLibraryOperationError,
    )
    expect(store.getState("workspace-b").status).toBe("error")

    projectCRefresh.resolve(projectC)
    await deletion
    expect(store.getState("workspace-b")).toMatchObject({
      status: "idle",
      snapshot: null,
      errorCode: null,
    })

    await store.load("workspace-b")
    expect(store.getState("workspace-b")).toMatchObject({
      status: "ready",
      snapshot: { projectId: "project-b" },
    })
  })

  it("keeps only the newest hydration across rapid global mutations", async () => {
    const snapshot = parseCharacterLibrarySnapshot(fixture.librarySnapshot)
    const projectA = projectSnapshot(snapshot, "workspace-a", "project-a")
    const afterDeleteA = withMappingVersion(projectA, 2)
    const afterMappingA = withMappingVersion(projectA, 3)
    const staleProjectB = projectSnapshot(
      withMappingVersion(snapshot, 1),
      "workspace-b",
      "project-b",
    )
    const supersededProjectB = projectSnapshot(
      withMappingVersion(snapshot, 2),
      "workspace-b",
      "project-b",
    )
    const freshProjectB = projectSnapshot(
      withMappingVersion(snapshot, 3),
      "workspace-b",
      "project-b",
    )
    const hydrations = [
      deferred<CharacterLibrarySnapshot>(),
      deferred<CharacterLibrarySnapshot>(),
      deferred<CharacterLibrarySnapshot>(),
    ]
    let projectBLoads = 0
    const store = new CharacterLibraryStore(
      createGateway({
        getLibrary: ({ workspaceId }) => {
          if (workspaceId === "workspace-a") return Promise.resolve(projectA)
          const hydration = hydrations[projectBLoads]
          projectBLoads += 1
          if (hydration === undefined) throw new Error("unexpected hydration")
          return hydration.promise
        },
        deletePack: () => Promise.resolve(afterDeleteA),
        saveSemanticMapping: () => Promise.resolve(afterMappingA),
      }),
    )
    await store.load("workspace-a")
    const staleLoad = store.load("workspace-b")

    await store.deletePack("workspace-a", "custom:deleted")
    const supersededLoad = store.load("workspace-b")
    await store.saveSemanticMapping({
      workspaceId: "workspace-a",
      packId: snapshot.selectedPackId,
      manifestHash: snapshot.semanticMapping.manifestHash,
      expectedMappingVersion: 2,
      assignments: snapshot.semanticMapping.assignments,
    })
    expect(store.getState("workspace-b").status).toBe("idle")
    const freshLoad = store.load("workspace-b")

    hydrations[0]?.resolve(staleProjectB)
    await staleLoad
    expect(store.getState("workspace-b")).toMatchObject({
      status: "loading",
      snapshot: null,
    })
    expect(store.load("workspace-b")).toBe(freshLoad)

    hydrations[2]?.resolve(freshProjectB)
    await freshLoad
    expect(store.getState("workspace-b")).toMatchObject({
      status: "ready",
      snapshot: { semanticMapping: { mappingVersion: 3 } },
    })

    hydrations[1]?.resolve(supersededProjectB)
    await supersededLoad
    expect(store.getState("workspace-b")).toMatchObject({
      status: "ready",
      snapshot: { semanticMapping: { mappingVersion: 3 } },
    })
  })

  it("leaves an unmounted pending consumer idle until remount hydration", async () => {
    const snapshot = parseCharacterLibrarySnapshot(fixture.librarySnapshot)
    const projectA = projectSnapshot(snapshot, "workspace-a", "project-a")
    const projectB = projectSnapshot(snapshot, "workspace-b", "project-b")
    const staleHydration = deferred<CharacterLibrarySnapshot>()
    let projectBLoads = 0
    const store = new CharacterLibraryStore(
      createGateway({
        getLibrary: ({ workspaceId }) => {
          if (workspaceId === "workspace-a") return Promise.resolve(projectA)
          projectBLoads += 1
          return projectBLoads === 1
            ? staleHydration.promise
            : Promise.resolve(projectB)
        },
        deletePack: () => Promise.resolve(projectA),
      }),
    )
    await store.load("workspace-a")
    const unsubscribe = store.subscribe(vi.fn())
    const staleLoad = store.load("workspace-b")
    unsubscribe()

    await store.deletePack("workspace-a", "custom:deleted")
    staleHydration.resolve(projectB)
    await staleLoad
    expect(store.getState("workspace-b")).toMatchObject({
      status: "idle",
      snapshot: null,
    })

    await store.load("workspace-b")
    expect(store.getState("workspace-b")).toMatchObject({
      status: "ready",
      snapshot: { projectId: "project-b" },
    })
  })

  it("invalidates a project that cannot refresh after a global mutation", async () => {
    const snapshot = parseCharacterLibrarySnapshot(fixture.librarySnapshot)
    const projectA = projectSnapshot(snapshot, "workspace-a", "project-a")
    const projectB = projectSnapshot(snapshot, "workspace-b", "project-b")
    let refreshProjectB = false
    const getLibrary = vi.fn(
      ({ workspaceId }: { readonly workspaceId: string }) => {
        if (refreshProjectB && workspaceId === "workspace-b") {
          return Promise.reject(new CharacterLibraryOperationError())
        }
        return Promise.resolve(
          workspaceId === "workspace-a" ? projectA : projectB,
        )
      },
    )
    const store = new CharacterLibraryStore(
      createGateway({
        getLibrary,
        deletePack: () => Promise.resolve(projectA),
      }),
    )
    await store.load("workspace-a")
    await store.load("workspace-b")
    refreshProjectB = true

    await store.deletePack("workspace-a", "custom:missing")

    expect(store.getState("workspace-a")).toMatchObject({
      status: "ready",
      snapshot: { projectId: "project-a" },
    })
    expect(store.getState("workspace-b")).toMatchObject({
      status: "idle",
      snapshot: null,
      errorCode: null,
    })
  })

  it("reloads every hydrated workspace after a mapping conflict and retries with the fresh version", async () => {
    const snapshot = parseCharacterLibrarySnapshot(fixture.librarySnapshot)
    let projectA = withMappingVersion(
      projectSnapshot(snapshot, "workspace-a", "project-a"),
      1,
    )
    let projectB = withMappingVersion(
      projectSnapshot(snapshot, "workspace-b", "project-b"),
      1,
    )
    const saveSemanticMapping = vi.fn(
      (
        request: Parameters<CharacterLibraryGateway["saveSemanticMapping"]>[0],
      ) => {
        if (request.expectedMappingVersion === 1) {
          projectA = withMappingVersion(projectA, 2)
          projectB = withMappingVersion(projectB, 2)
          return Promise.reject(mappingConflict())
        }
        projectA = withMappingVersion(projectA, 3)
        projectB = withMappingVersion(projectB, 3)
        return Promise.resolve(projectA)
      },
    )
    const store = new CharacterLibraryStore(
      createGateway({
        getLibrary: ({ workspaceId }) =>
          Promise.resolve(workspaceId === "workspace-a" ? projectA : projectB),
        saveSemanticMapping,
      }),
    )
    await store.load("workspace-a")
    await store.load("workspace-b")
    const assignments = snapshot.semanticMapping.assignments

    await expect(
      store.saveSemanticMapping({
        workspaceId: "workspace-a",
        packId: snapshot.selectedPackId,
        manifestHash: snapshot.semanticMapping.manifestHash,
        expectedMappingVersion: 1,
        assignments,
      }),
    ).rejects.toThrow("CHARACTER-MAPPING-CONFLICT")

    expect(store.getState("workspace-a")).toMatchObject({
      errorCode: "CHARACTER-MAPPING-CONFLICT",
      snapshot: { semanticMapping: { mappingVersion: 2 } },
    })
    expect(store.getState("workspace-b").snapshot).toMatchObject({
      projectId: "project-b",
      semanticMapping: { mappingVersion: 2 },
    })

    await store.saveSemanticMapping({
      workspaceId: "workspace-a",
      packId: snapshot.selectedPackId,
      manifestHash: snapshot.semanticMapping.manifestHash,
      expectedMappingVersion: 2,
      assignments,
    })

    expect(saveSemanticMapping).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedMappingVersion: 2 }),
    )
    expect(store.getState("workspace-a")).toMatchObject({
      errorCode: null,
      snapshot: { semanticMapping: { mappingVersion: 3 } },
    })
    expect(store.getState("workspace-b").snapshot).toMatchObject({
      projectId: "project-b",
      semanticMapping: { mappingVersion: 3 },
    })
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
