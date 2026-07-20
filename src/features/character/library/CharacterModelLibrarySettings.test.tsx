import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import {
  I18nProvider,
  type LocalePreferenceStore,
} from "@/features/localization"
import { CharacterModelLibrarySettings } from "@/features/character/library/CharacterModelLibrarySettings"
import {
  parseCharacterImportResponse,
  parseCharacterLibrarySnapshot,
  type CharacterCancelImportRequest,
  type CharacterConfirmImportRequest,
  type CharacterImportResponse,
  type CharacterLibraryRequest,
  type CharacterLibrarySnapshot,
  type CharacterPackView,
  type CharacterPreviewAttestationRequest,
  type CharacterPreviewAttestationResponse,
  type CharacterPreviewSession,
  type CharacterSemanticMappingSaveRequest,
} from "@/features/character/library/contracts"
import { CharacterLibraryProvider } from "@/features/character/library/provider"
import {
  CharacterLibraryOperationError,
  DemoCharacterLibraryGateway,
  type CharacterLibraryGateway,
} from "@/features/character/library/transport"
import {
  builtinHiyoriMotionPreset,
  neutralSemanticAssignments,
} from "@/features/character/semantic-mapping"
import type {
  CharacterPackManifest,
  CharacterPackRef,
} from "@/features/character/model"
import characterFixture from "@/test/fixtures/character-library.v1.json"

vi.mock("@/features/character/import-preview/IsolatedCharacterPreview", () => ({
  IsolatedCharacterPreview: ({
    onEvidence,
    onProgress,
  }: {
    onEvidence: (value: {
      protocol: "character-preview-v1"
      type: "success"
      channelNonce: string
      previewNonce: string
      generation: number
      rendererNonce: string
      frameCount: number
      nonTransparentSamples: number
      signature: string
      textureDecodeCount: number
      stateCueObserved: true
      webglError: 0
      parameterCount: number
      partCount: number
      drawableCount: number
      thumbnailSha256: string
      thumbnailPng: ArrayBuffer
    }) => void
    onProgress?: (completed: number, total: number, phase: "rendering") => void
  }) => (
    <button
      onClick={() => {
        onProgress?.(3, 3, "rendering")
        onEvidence({
          protocol: "character-preview-v1",
          type: "success",
          channelNonce: "44444444-4444-4444-8444-444444444444",
          previewNonce: "33333333-3333-4333-8333-333333333333",
          generation: 42,
          rendererNonce: "55555555-5555-4555-8555-555555555555",
          frameCount: 3,
          nonTransparentSamples: 64,
          signature: "abcdef12",
          textureDecodeCount: 1,
          stateCueObserved: true,
          webglError: 0,
          parameterCount: 12,
          partCount: 4,
          drawableCount: 20,
          thumbnailSha256:
            "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
          thumbnailPng: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
            .buffer,
        })
      }}
      type="button"
    >
      Complete isolated preview
    </button>
  ),
}))

const importedPreview = parseCharacterImportResponse(
  characterFixture.importResponse,
)
const builtinPack = parseCharacterLibrarySnapshot(
  characterFixture.librarySnapshot,
).packs[0]!
const trustedFrameBytes = new Uint8Array(
  characterFixture.attestationRequest.thumbnailPng,
)
const customManifest: CharacterPackManifest = {
  ...importedPreview.preview!.manifest,
  compatibility: {
    ...importedPreview.preview!.manifest.compatibility,
    expectedParameters: characterFixture.attestationRequest.parameterCount,
    expectedParts: characterFixture.attestationRequest.partCount,
    expectedDrawables: characterFixture.attestationRequest.drawableCount,
  },
  trustedFrame: {
    assetId: "__coding-wife/trusted-frame.png",
    bytes: trustedFrameBytes.byteLength,
    sha256: characterFixture.attestationRequest.thumbnailSha256,
    dimensions: { width: 1, height: 1 },
  },
}
const customPack: CharacterPackView = {
  schemaVersion: 1,
  packId: "custom:11111111-1111-4111-8111-111111111111",
  displayName: "Local model",
  kind: "custom",
  manifestHash: "d".repeat(64),
  provenanceLabel: "Local folder",
  importedAt: "2026-07-18T00:00:00.000Z",
  runtimeFileCount: 3,
  totalBytes: 600,
  textureCount: 1,
  motionCount: 1,
  expressionCount: 0,
  selectedProjectCount: 0,
  deletable: true,
  manifest: customManifest,
  thumbnailSha256: characterFixture.attestationRequest.thumbnailSha256,
  cueInventory: { motions: ["FlickUp[0]"], expressions: [] },
}

class MemoryLocaleStore implements LocalePreferenceStore {
  readonly persistence = "session-only" as const

  public constructor(private locale: "en" | "ja") {}

  public read(): "en" | "ja" {
    return this.locale
  }

  public write(locale: "en" | "ja"): boolean {
    this.locale = locale
    return true
  }
}

class ModelLibraryGateway implements CharacterLibraryGateway {
  public readonly kind = "native" as const
  public readonly selectionRequests: string[] = []
  public readonly deletionRequests: string[] = []
  public readonly attestationRequests: CharacterPreviewAttestationRequest[] = []
  public readonly confirmationRequests: CharacterConfirmImportRequest[] = []
  public readonly cancellationRequests: CharacterCancelImportRequest[] = []
  public readonly semanticMappingRequests: CharacterSemanticMappingSaveRequest[] =
    []
  public pickerCount = 0
  public pickerErrorCode: string | null = null
  public conflictNextSemanticSave = false
  private snapshot: CharacterLibrarySnapshot

  public constructor(
    packs: readonly CharacterPackView[] = [builtinPack, customPack],
  ) {
    this.snapshot = {
      schemaVersion: 1,
      workspaceId: "workspace-fixture",
      projectId: "project-fixture",
      selectedPackId: builtinPack.packId,
      fallbackApplied: false,
      diagnostics: [],
      packs,
      semanticMapping: {
        schemaVersion: 1,
        packId: builtinPack.packId,
        manifestHash: builtinPack.manifestHash,
        mappingVersion: 0,
        assignments: builtinHiyoriMotionPreset,
      },
      semanticMappingStatus: "default",
    }
  }

  public getLibrary(
    request: CharacterLibraryRequest,
  ): Promise<CharacterLibrarySnapshot> {
    return Promise.resolve({
      ...this.snapshot,
      workspaceId: request.workspaceId,
    })
  }

  public pickImport(
    request: CharacterLibraryRequest,
  ): Promise<CharacterImportResponse> {
    void request
    this.pickerCount += 1
    if (this.pickerErrorCode !== null) {
      return Promise.reject(
        new CharacterLibraryOperationError({
          code: this.pickerErrorCode,
          operation: "character_import_pick",
          recoverable: true,
          userMessageKey: "character.error.generic",
          detailRef: "character-library-v1",
        }),
      )
    }
    return Promise.resolve(importedPreview)
  }

  public attestPreview(
    request: CharacterPreviewAttestationRequest,
  ): Promise<CharacterPreviewAttestationResponse> {
    this.attestationRequests.push(request)
    return Promise.resolve({
      schemaVersion: 1,
      attested: true,
      rendererNonce: request.rendererNonce,
    })
  }

  public confirmImport(
    request: CharacterConfirmImportRequest,
  ): Promise<CharacterLibrarySnapshot> {
    this.confirmationRequests.push(request)
    const published = {
      ...customPack,
      displayName: request.displayName,
    }
    this.snapshot = {
      ...this.snapshot,
      selectedPackId: published.packId,
      semanticMapping: {
        ...this.snapshot.semanticMapping,
        packId: published.packId,
        manifestHash: published.manifestHash,
        mappingVersion: 0,
        assignments: neutralSemanticAssignments(),
      },
      semanticMappingStatus: "default",
      packs: [
        ...this.snapshot.packs
          .filter((pack) => pack.kind === "builtin")
          .map((pack) => ({ ...pack, selectedProjectCount: 0 })),
        { ...published, selectedProjectCount: 1, deletable: true },
      ],
    }
    return Promise.resolve(this.snapshot)
  }

  public cancelImport(request: CharacterCancelImportRequest): Promise<void> {
    this.cancellationRequests.push(request)
    return Promise.resolve()
  }

  public selectPack(
    request: CharacterLibraryRequest & { readonly packId: string },
  ): Promise<CharacterLibrarySnapshot> {
    this.selectionRequests.push(request.packId)
    this.snapshot = {
      ...this.snapshot,
      selectedPackId: request.packId,
      semanticMapping: {
        ...this.snapshot.semanticMapping,
        packId: request.packId,
        manifestHash: this.snapshot.packs.find(
          (pack) => pack.packId === request.packId,
        )!.manifestHash,
        mappingVersion: 0,
        assignments:
          request.packId === builtinPack.packId
            ? builtinHiyoriMotionPreset
            : neutralSemanticAssignments(),
      },
      semanticMappingStatus: "default",
      packs: this.snapshot.packs.map((pack) => ({
        ...pack,
        selectedProjectCount: pack.packId === request.packId ? 1 : 0,
        deletable: pack.kind === "custom",
      })),
    }
    return Promise.resolve(this.snapshot)
  }

  public deletePack(
    request: CharacterLibraryRequest & { readonly packId: string },
  ): Promise<CharacterLibrarySnapshot> {
    this.deletionRequests.push(request.packId)
    this.snapshot = {
      ...this.snapshot,
      selectedPackId: builtinPack.packId,
      semanticMapping: {
        ...this.snapshot.semanticMapping,
        packId: builtinPack.packId,
        manifestHash: builtinPack.manifestHash,
        mappingVersion: 0,
        assignments: builtinHiyoriMotionPreset,
      },
      semanticMappingStatus: "default",
      packs: this.snapshot.packs
        .filter((pack) => pack.packId !== request.packId)
        .map((pack) => ({ ...pack, selectedProjectCount: 1 })),
    }
    return Promise.resolve(this.snapshot)
  }

  public saveSemanticMapping(
    request: CharacterSemanticMappingSaveRequest,
  ): Promise<CharacterLibrarySnapshot> {
    this.semanticMappingRequests.push(request)
    if (this.conflictNextSemanticSave) {
      this.conflictNextSemanticSave = false
      this.snapshot = {
        ...this.snapshot,
        semanticMapping: {
          ...this.snapshot.semanticMapping,
          mappingVersion: request.expectedMappingVersion + 1,
        },
      }
      return Promise.reject(
        new CharacterLibraryOperationError({
          code: "CHARACTER-MAPPING-CONFLICT",
          operation: "character_semantic_mapping_save",
          recoverable: true,
          userMessageKey: "character.error.generic",
          detailRef: "character-library-v1",
        }),
      )
    }
    this.snapshot = {
      ...this.snapshot,
      semanticMapping: {
        schemaVersion: 1,
        packId: request.packId,
        manifestHash: request.manifestHash,
        mappingVersion: request.expectedMappingVersion + 1,
        assignments: request.assignments,
      },
      semanticMappingStatus: "saved",
    }
    return Promise.resolve(this.snapshot)
  }

  public createPackRef(pack: CharacterPackView): CharacterPackRef {
    if (pack.kind === "builtin") {
      return { kind: "url", manifestUrl: "/fixture-pack.json" }
    }
    if (pack.manifest === null) throw new CharacterLibraryOperationError()
    return {
      kind: "native",
      manifest: pack.manifest,
      manifestHash: pack.manifestHash,
      previewToken: null,
      readAsset: (_assetId, _expectedMime, signal) => {
        if (signal.aborted) {
          return Promise.reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("trusted frame read canceled"),
          )
        }
        return Promise.resolve(trustedFrameBytes.slice().buffer)
      },
    }
  }

  public createPreviewPackRef(
    preview: CharacterPreviewSession,
  ): CharacterPackRef {
    void preview
    return { kind: "url", manifestUrl: "/fixture-preview.json" }
  }
}

function renderLibrary(
  gateway: CharacterLibraryGateway,
  locale: "en" | "ja" = "en",
) {
  return render(
    <I18nProvider store={new MemoryLocaleStore(locale)}>
      <TooltipProvider>
        <CharacterLibraryProvider gateway={gateway}>
          <CharacterModelLibrarySettings workspaceId="workspace-fixture" />
        </CharacterLibraryProvider>
      </TooltipProvider>
    </I18nProvider>,
  )
}

function libraryTree(
  gateway: CharacterLibraryGateway,
  workspaceId: string | null,
) {
  return (
    <I18nProvider store={new MemoryLocaleStore("en")}>
      <TooltipProvider>
        <CharacterLibraryProvider gateway={gateway}>
          {workspaceId === null ? null : (
            <CharacterModelLibrarySettings workspaceId={workspaceId} />
          )}
        </CharacterLibraryProvider>
      </TooltipProvider>
    </I18nProvider>
  )
}

describe("CharacterModelLibrarySettings", () => {
  it("opens bundled Hiyori from the simple list and shows a read-only motion preset", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway()
    renderLibrary(gateway)

    const hiyoriRow = await screen.findByRole("button", {
      name: new RegExp(`Open character settings: ${builtinPack.displayName}`),
    })
    expect(screen.getByRole("button", { name: /Local model/ })).toBeVisible()
    expect(
      screen.queryByText(customPack.provenanceLabel),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(customPack.manifestHash)).not.toBeInTheDocument()

    await user.click(hiyoriRow)
    expect(
      screen.getByRole("heading", { name: builtinPack.displayName }),
    ).toBeVisible()
    expect(
      screen.getByRole("heading", { name: "Motion settings" }),
    ).toBeVisible()
    expect(screen.getByText("Preset — cannot be edited")).toBeVisible()
    expect(screen.getByText("Natural idle")).toBeVisible()
    expect(screen.getAllByText("Working")).toHaveLength(2)
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Preview" }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Save settings" }),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Back to characters" }))
    expect(
      screen.getByRole("button", {
        name: new RegExp(`Open character settings: ${builtinPack.displayName}`),
      }),
    ).toHaveFocus()
  })

  it("edits and saves custom motion settings without preview controls", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway()
    renderLibrary(gateway)

    await user.click(await screen.findByRole("button", { name: /Local model/ }))
    await user.click(screen.getByRole("button", { name: "Use this character" }))
    await waitFor(() =>
      expect(gateway.selectionRequests).toEqual([customPack.packId]),
    )
    const successCue = await screen.findByRole<HTMLSelectElement>("combobox", {
      name: "Success",
    })
    await user.selectOptions(successCue, "motion:FlickUp[0]")
    expect(
      screen.queryByRole("button", { name: "Preview" }),
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Save settings" }))

    await waitFor(() => expect(gateway.semanticMappingRequests).toHaveLength(1))
    expect(gateway.semanticMappingRequests[0]?.assignments.success).toEqual({
      kind: "motion",
      cueId: "FlickUp[0]",
    })
    expect(await screen.findByText("Motion settings saved")).toBeVisible()
  })

  it("retains an edited custom draft and retries a conflict with the fresh version", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway()
    gateway.conflictNextSemanticSave = true
    renderLibrary(gateway)

    await user.click(await screen.findByRole("button", { name: /Local model/ }))
    await user.click(screen.getByRole("button", { name: "Use this character" }))
    const successCue = await screen.findByRole<HTMLSelectElement>("combobox", {
      name: "Success",
    })
    await user.selectOptions(successCue, "motion:FlickUp[0]")
    await user.click(screen.getByRole("button", { name: "Save settings" }))

    await waitFor(() => expect(gateway.semanticMappingRequests).toHaveLength(1))
    expect(successCue.value).toBe("motion:FlickUp[0]")
    await user.click(screen.getByRole("button", { name: "Save settings" }))
    await waitFor(() => expect(gateway.semanticMappingRequests).toHaveLength(2))
    expect(gateway.semanticMappingRequests[1]).toMatchObject({
      expectedMappingVersion: 1,
      assignments: {
        success: { kind: "motion", cueId: "FlickUp[0]" },
      },
    })
    expect(await screen.findByText("Motion settings saved")).toBeVisible()
  })

  beforeEach(() => {
    document.documentElement.lang = "en"
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("keeps bundled Hiyori protected and deletes the active custom slot with fallback", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway()
    renderLibrary(gateway)

    expect(
      await screen.findByRole("button", { name: "Replace custom model" }),
    ).toBeVisible()
    await user.click(await screen.findByRole("button", { name: /Local model/ }))
    await user.click(screen.getByRole("button", { name: "Use this character" }))
    await waitFor(() =>
      expect(gateway.selectionRequests).toEqual([customPack.packId]),
    )

    await user.click(screen.getByRole("button", { name: "Delete" }))
    expect(
      screen.getByRole("heading", { name: "Delete this character model?" }),
    ).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Delete model" }))

    await waitFor(() =>
      expect(gateway.deletionRequests).toEqual([customPack.packId]),
    )
    expect(screen.queryByText("Local model")).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: new RegExp(
          `Open character settings: ${builtinPack.displayName}, In use`,
        ),
      }),
    ).toBeVisible()
    expect(
      screen.getByRole("button", { name: "Import custom model" }),
    ).toBeVisible()
  })

  it("does not offer delete or editable motion controls for bundled Hiyori", async () => {
    const user = userEvent.setup()
    renderLibrary(new ModelLibraryGateway([builtinPack]))

    await user.click(
      await screen.findByRole("button", {
        name: new RegExp(`Open character settings: ${builtinPack.displayName}`),
      }),
    )
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
  })

  it("explains import failures in Japanese while retaining the diagnostic code", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway([builtinPack])
    gateway.pickerErrorCode = "CHARACTER-MOC-MISSING"
    renderLibrary(gateway, "ja")

    await user.click(
      await screen.findByRole("button", {
        name: "カスタムモデルを取り込む",
      }),
    )

    expect(
      await screen.findByText(/モデルが参照するファイルの一部が見つからない/),
    ).toBeVisible()
    expect(screen.getByText("CHARACTER-MOC-MISSING")).toBeVisible()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("keeps the current custom slot until a replacement preview is confirmed", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway()
    renderLibrary(gateway)

    await user.click(
      await screen.findByRole("button", { name: "Replace custom model" }),
    )
    expect(
      await screen.findByText(/current custom model stays available/),
    ).toBeVisible()
    expect(gateway.confirmationRequests).toHaveLength(0)

    await user.click(
      screen.getByRole("button", { name: "Complete isolated preview" }),
    )
    await screen.findAllByText("Preview verified")
    await user.click(
      await screen.findByRole("button", { name: "Replace and use model" }),
    )

    await waitFor(() => expect(gateway.confirmationRequests).toHaveLength(1))
    expect(
      screen.getAllByRole("button", { name: /Open character settings/ }),
    ).toHaveLength(2)
    expect(
      screen.getByRole("button", { name: "Replace custom model" }),
    ).toBeVisible()
  })

  it("publishes only after isolated evidence and an explicit display name", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway([builtinPack])
    renderLibrary(gateway)

    await user.click(
      await screen.findByRole("button", { name: "Import custom model" }),
    )
    expect(gateway.pickerCount).toBe(1)
    expect(
      await screen.findByRole("heading", { name: "Review imported model" }),
    ).toBeVisible()
    const confirm = screen.getByRole("button", {
      name: "Import and use model",
    })
    expect(confirm).toBeDisabled()

    await user.click(
      screen.getByRole("button", { name: "Complete isolated preview" }),
    )
    expect((await screen.findAllByText("Preview verified")).length).toBe(2)
    expect(gateway.attestationRequests).toHaveLength(1)

    const name = screen.getByRole("textbox", { name: "Model name" })
    await user.clear(name)
    await user.type(name, "My local model")
    await user.click(confirm)

    await waitFor(() => expect(gateway.confirmationRequests).toHaveLength(1))
    expect(gateway.confirmationRequests[0]?.displayName).toBe("My local model")
    expect(gateway.selectionRequests).toHaveLength(0)
    expect(
      await screen.findByRole("button", {
        name: /Open character settings: My local model, In use/,
      }),
    ).toBeVisible()
  })

  it("cancels quarantine when the preview dialog is dismissed with Escape", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway([builtinPack])
    renderLibrary(gateway)

    await user.click(
      await screen.findByRole("button", { name: "Import custom model" }),
    )
    await screen.findByRole("heading", { name: "Review imported model" })
    await user.keyboard("{Escape}")

    await waitFor(() => expect(gateway.cancellationRequests).toHaveLength(1))
    expect(
      screen.queryByRole("heading", { name: "Review imported model" }),
    ).not.toBeInTheDocument()
  })

  it("cancels on section or main-tab departure and restores the import trigger on return", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway([builtinPack])
    const view = render(libraryTree(gateway, "workspace-fixture"))
    await user.click(
      await screen.findByRole("button", { name: "Import custom model" }),
    )
    expect(
      await screen.findByRole("heading", { name: "Review imported model" }),
    ).toBeVisible()

    view.rerender(libraryTree(gateway, null))
    await waitFor(() => expect(gateway.cancellationRequests).toHaveLength(1))
    view.rerender(libraryTree(gateway, "workspace-fixture"))
    const trigger = await screen.findByRole("button", {
      name: "Import custom model",
    })
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it("keeps the app-global preview when the selected workspace changes", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway([builtinPack])
    const view = render(libraryTree(gateway, "workspace-fixture"))
    await user.click(
      await screen.findByRole("button", { name: "Import custom model" }),
    )

    view.rerender(libraryTree(gateway, "workspace-next"))
    expect(gateway.cancellationRequests).toHaveLength(0)
    expect(
      await screen.findByRole("heading", { name: "Review imported model" }),
    ).toBeVisible()
  })

  it("shows Japanese copy and disables native import in browser mode", async () => {
    renderLibrary(new DemoCharacterLibraryGateway(), "ja")

    expect(
      await screen.findByRole("heading", { name: "キャラクター一覧" }),
    ).toBeVisible()
    const importButton = screen.getByRole("button", {
      name: "カスタムモデルを取り込む",
    })
    expect(importButton).toBeDisabled()
    expect(importButton).toHaveAttribute(
      "title",
      "モデルの取り込みはデスクトップアプリで利用できます。",
    )
  })
})
