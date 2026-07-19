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
const createdObjectUrls: string[] = []
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
  motionCount: 0,
  expressionCount: 0,
  selectedProjectCount: 0,
  deletable: true,
  manifest: customManifest,
  thumbnailSha256: characterFixture.attestationRequest.thumbnailSha256,
  cueInventory: { motions: [], expressions: [] },
}

type TrustedFrameMode = "valid" | "missing" | "tampered"

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
  public readonly trustedFrameReads: {
    readonly assetId: string
    readonly expectedMime: string
  }[] = []
  public pickerCount = 0
  public conflictNextSemanticSave = false
  private snapshot: CharacterLibrarySnapshot

  public constructor(
    packs: readonly CharacterPackView[] = [builtinPack, customPack],
    private readonly trustedFrameMode: TrustedFrameMode = "valid",
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
        assignments: {
          neutral: { kind: "neutral" },
          thinking: { kind: "neutral" },
          working: { kind: "neutral" },
          asking: { kind: "neutral" },
          success: { kind: "neutral" },
          warning: { kind: "neutral" },
          error: { kind: "neutral" },
        },
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
      },
      packs: [
        ...this.snapshot.packs
          .filter((pack) => pack.packId !== published.packId)
          .map((pack) => ({ ...pack, selectedProjectCount: 0 })),
        { ...published, selectedProjectCount: 1, deletable: false },
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
      },
      packs: this.snapshot.packs.map((pack) => ({
        ...pack,
        selectedProjectCount: pack.packId === request.packId ? 1 : 0,
        deletable: pack.kind === "custom" && pack.packId !== request.packId,
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
      packs: this.snapshot.packs.filter(
        (pack) => pack.packId !== request.packId,
      ),
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
      readAsset: (assetId, expectedMime, signal) => {
        this.trustedFrameReads.push({ assetId, expectedMime })
        if (signal.aborted) {
          return Promise.reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("trusted frame read canceled"),
          )
        }
        if (this.trustedFrameMode === "missing") {
          return Promise.reject(new CharacterLibraryOperationError())
        }
        const bytes = trustedFrameBytes.slice()
        if (this.trustedFrameMode === "tampered") {
          const lastIndex = bytes.length - 1
          bytes[lastIndex] = (bytes[lastIndex] ?? 0) ^ 0xff
        }
        return Promise.resolve(bytes.buffer)
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
  it("edits, previews, and saves all semantic states from verified cue options", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway([builtinPack])
    renderLibrary(gateway)

    const successCue = await screen.findByRole("combobox", {
      name: "Success cue",
    })
    await user.selectOptions(successCue, "motion:FlickUp[0]")
    await user.click(screen.getAllByRole("button", { name: "Preview" })[4]!)
    expect(screen.getByText(/Success · motion:FlickUp\[0\]/)).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Save mapping" }))
    await waitFor(() => expect(gateway.semanticMappingRequests).toHaveLength(1))
    expect(gateway.semanticMappingRequests[0]?.assignments.success).toEqual({
      kind: "motion",
      cueId: "FlickUp[0]",
    })
    expect(await screen.findByText("Mapping saved")).toBeVisible()
  })

  it("retains an edited draft and retries a conflict with the fresh mapping version", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway([builtinPack])
    gateway.conflictNextSemanticSave = true
    renderLibrary(gateway)

    const successCue = await screen.findByRole<HTMLSelectElement>("combobox", {
      name: "Success cue",
    })
    await user.selectOptions(successCue, "motion:FlickUp[0]")
    await user.click(screen.getByRole("button", { name: "Save mapping" }))

    await waitFor(() => expect(gateway.semanticMappingRequests).toHaveLength(1))
    expect(await screen.findByText("Version 1")).toBeVisible()
    expect(successCue.value).toBe("motion:FlickUp[0]")

    await user.click(screen.getByRole("button", { name: "Save mapping" }))
    await waitFor(() => expect(gateway.semanticMappingRequests).toHaveLength(2))
    expect(gateway.semanticMappingRequests[1]).toMatchObject({
      expectedMappingVersion: 1,
      assignments: {
        success: { kind: "motion", cueId: "FlickUp[0]" },
      },
    })
    expect(await screen.findByText("Version 2")).toBeVisible()
  })

  it("keeps semantic previews static when reduced motion is requested", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    renderLibrary(new ModelLibraryGateway([builtinPack]))

    expect(
      await screen.findByText(/Static preview — motion is reduced/),
    ).toBeVisible()
    expect(
      document.querySelector('[data-semantic-preview="static"]'),
    ).toBeInTheDocument()
  })

  beforeEach(() => {
    document.documentElement.lang = "en"
    createdObjectUrls.length = 0
    let sequence = 0
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:trusted-character-frame-${String(++sequence)}`
      createdObjectUrls.push(url)
      return url
    })
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("restores the attested thumbnail and accessible hashes from restart snapshot data", async () => {
    const firstGateway = new ModelLibraryGateway()
    const first = renderLibrary(firstGateway)

    await waitFor(() =>
      expect(
        first.container.querySelector(
          `[data-character-pack="${customPack.packId}"] [data-character-thumbnail="trusted-frame"]`,
        ),
      ).toHaveAttribute("src", "blob:trusted-character-frame-1"),
    )
    expect(firstGateway.trustedFrameReads).toEqual([
      {
        assetId: "__coding-wife/trusted-frame.png",
        expectedMime: "image/png",
      },
    ])
    expect(
      screen.getByLabelText(`Manifest: ${customPack.manifestHash}`),
    ).toHaveTextContent("dddddddd…dddddddd")
    expect(
      screen.getByLabelText(
        `Trusted frame: ${characterFixture.attestationRequest.thumbnailSha256}`,
      ),
    ).toHaveTextContent("431ced69…7f265460")

    first.unmount()
    const restartedGateway = new ModelLibraryGateway()
    const restarted = renderLibrary(restartedGateway)
    await waitFor(() =>
      expect(
        restarted.container.querySelector(
          `[data-character-pack="${customPack.packId}"] [data-character-thumbnail="trusted-frame"]`,
        ),
      ).toHaveAttribute("src", "blob:trusted-character-frame-2"),
    )
    expect(restartedGateway.trustedFrameReads).toHaveLength(1)
  })

  it.each(["missing", "tampered"] as const)(
    "fails closed when the persisted trusted frame is %s",
    async (trustedFrameMode) => {
      const gateway = new ModelLibraryGateway(
        [builtinPack, customPack],
        trustedFrameMode,
      )
      const view = renderLibrary(gateway)

      await waitFor(() =>
        expect(
          view.container.querySelector(
            `[data-character-pack="${customPack.packId}"] [data-character-thumbnail="unavailable"]`,
          ),
        ).toBeInTheDocument(),
      )
      expect(
        view.container.querySelector(
          `[data-character-pack="${customPack.packId}"] img`,
        ),
      ).not.toBeInTheDocument()
      expect(createdObjectUrls).toEqual([])
      expect(gateway.trustedFrameReads).toHaveLength(1)
    },
  )

  it("selects by keyboard and deletes an unused custom model explicitly", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway()
    renderLibrary(gateway)

    const customRadio = await screen.findByRole("radio", {
      name: /Local model/,
    })
    customRadio.focus()
    await user.keyboard(" ")
    await waitFor(() =>
      expect(gateway.selectionRequests).toEqual([customPack.packId]),
    )

    await user.click(screen.getByRole("radio", { name: /Hiyori/ }))
    await waitFor(() =>
      expect(gateway.selectionRequests).toEqual([
        customPack.packId,
        builtinPack.packId,
      ]),
    )

    await user.click(
      screen.getByRole("button", { name: "Delete: Local model" }),
    )
    expect(
      screen.getByRole("heading", { name: "Delete this character model?" }),
    ).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Delete model" }))

    await waitFor(() =>
      expect(gateway.deletionRequests).toEqual([customPack.packId]),
    )
    expect(screen.queryByText("Local model")).not.toBeInTheDocument()
  })

  it("publishes only after isolated evidence and an explicit display name", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway([builtinPack])
    renderLibrary(gateway)

    await user.click(
      await screen.findByRole("button", { name: "Import model" }),
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
      await screen.findByRole("radio", { name: /My local model/ }),
    ).toHaveAttribute("aria-checked", "true")
  })

  it("cancels quarantine when the preview dialog is dismissed with Escape", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway([builtinPack])
    renderLibrary(gateway)

    await user.click(
      await screen.findByRole("button", { name: "Import model" }),
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
      await screen.findByRole("button", { name: "Import model" }),
    )
    expect(
      await screen.findByRole("heading", { name: "Review imported model" }),
    ).toBeVisible()

    view.rerender(libraryTree(gateway, null))
    await waitFor(() => expect(gateway.cancellationRequests).toHaveLength(1))
    view.rerender(libraryTree(gateway, "workspace-fixture"))
    const trigger = await screen.findByRole("button", { name: "Import model" })
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it("keeps the app-global preview when the selected workspace changes", async () => {
    const user = userEvent.setup()
    const gateway = new ModelLibraryGateway([builtinPack])
    const view = render(libraryTree(gateway, "workspace-fixture"))
    await user.click(
      await screen.findByRole("button", { name: "Import model" }),
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
      await screen.findByRole("heading", { name: "キャラクターモデル" }),
    ).toBeVisible()
    expect(
      screen.getByRole("button", { name: "モデルを取り込む" }),
    ).toBeDisabled()
    expect(
      screen.getByText(/モデルの取り込みはデスクトップアプリ/),
    ).toBeVisible()
  })
})
