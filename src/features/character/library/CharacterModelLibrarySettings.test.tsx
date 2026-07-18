import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

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
} from "@/features/character/library/contracts"
import { CharacterLibraryProvider } from "@/features/character/library/provider"
import {
  DemoCharacterLibraryGateway,
  type CharacterLibraryGateway,
} from "@/features/character/library/transport"
import type { CharacterPackRef } from "@/features/character/model"
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
  selectedWorkspaceCount: 0,
  deletable: true,
  manifest: importedPreview.preview!.manifest,
  thumbnailSha256: null,
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
  public pickerCount = 0
  private snapshot: CharacterLibrarySnapshot

  public constructor(
    packs: readonly CharacterPackView[] = [builtinPack, customPack],
  ) {
    this.snapshot = {
      schemaVersion: 1,
      workspaceId: "workspace-fixture",
      selectedPackId: builtinPack.packId,
      fallbackApplied: false,
      diagnostics: [],
      packs,
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
      packs: [
        ...this.snapshot.packs
          .filter((pack) => pack.packId !== published.packId)
          .map((pack) => ({ ...pack, selectedWorkspaceCount: 0 })),
        { ...published, selectedWorkspaceCount: 1, deletable: false },
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
      packs: this.snapshot.packs.map((pack) => ({
        ...pack,
        selectedWorkspaceCount: pack.packId === request.packId ? 1 : 0,
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

  public createPackRef(pack: CharacterPackView): CharacterPackRef {
    void pack
    return { kind: "url", manifestUrl: "/fixture-pack.json" }
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
      <CharacterLibraryProvider gateway={gateway}>
        <CharacterModelLibrarySettings workspaceId="workspace-fixture" />
      </CharacterLibraryProvider>
    </I18nProvider>,
  )
}

describe("CharacterModelLibrarySettings", () => {
  beforeEach(() => {
    document.documentElement.lang = "en"
  })

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
