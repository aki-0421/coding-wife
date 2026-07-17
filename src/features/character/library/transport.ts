import { invoke as tauriInvoke } from "@tauri-apps/api/core"

import hiyoriPack from "../../../../src-tauri/resources/characters/builtin-hiyori/pack.json"
import type {
  CharacterPackManifest,
  CharacterPackRef,
} from "@/features/character/model"
import { parseCharacterPackManifest } from "@/features/character/runtime/character-pack-client"
import {
  builtinHiyoriPackId,
  characterLibraryCommands,
  characterLibrarySchemaVersion,
  parseCharacterCommandError,
  parseCharacterImportResponse,
  parseCharacterLibrarySnapshot,
  parseCharacterPreviewAttestationResponse,
  type CharacterAssetRequest,
  type CharacterCancelImportRequest,
  type CharacterCommandErrorEnvelope,
  type CharacterConfirmImportRequest,
  type CharacterImportResponse,
  type CharacterLibraryRequest,
  type CharacterLibrarySnapshot,
  type CharacterPackView,
  type CharacterPreviewAttestationRequest,
  type CharacterPreviewAttestationResponse,
  type CharacterPreviewSession,
} from "@/features/character/library/contracts"

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export class CharacterLibraryOperationError extends Error {
  public readonly code: string
  public readonly operation: string
  public readonly recoverable: boolean

  public constructor(error?: CharacterCommandErrorEnvelope) {
    super(error?.code ?? "CHARACTER-IPC-FAILED")
    this.name = "CharacterLibraryOperationError"
    this.code = error?.code ?? "CHARACTER-IPC-FAILED"
    this.operation = error?.operation ?? "character_library"
    this.recoverable = error?.recoverable ?? true
  }
}

export interface CharacterLibraryGateway {
  readonly kind: "native" | "demo"
  getLibrary(
    request: CharacterLibraryRequest,
  ): Promise<CharacterLibrarySnapshot>
  pickImport(request: CharacterLibraryRequest): Promise<CharacterImportResponse>
  attestPreview(
    request: CharacterPreviewAttestationRequest,
  ): Promise<CharacterPreviewAttestationResponse>
  confirmImport(
    request: CharacterConfirmImportRequest,
  ): Promise<CharacterLibrarySnapshot>
  cancelImport(request: CharacterCancelImportRequest): Promise<void>
  selectPack(
    request: CharacterLibraryRequest & { readonly packId: string },
  ): Promise<CharacterLibrarySnapshot>
  deletePack(
    request: CharacterLibraryRequest & { readonly packId: string },
  ): Promise<CharacterLibrarySnapshot>
  createPackRef(pack: CharacterPackView): CharacterPackRef
  createPreviewPackRef(preview: CharacterPreviewSession): CharacterPackRef
}

function normalizeBinaryResponse(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value
  if (value instanceof Uint8Array) {
    return new Uint8Array(value).slice().buffer
  }
  throw new CharacterLibraryOperationError()
}

function throwOperationError(error: unknown): never {
  const parsed = parseCharacterCommandError(error)
  throw new CharacterLibraryOperationError(parsed ?? undefined)
}

export class NativeCharacterLibraryGateway implements CharacterLibraryGateway {
  public readonly kind = "native" as const
  readonly #invoke: Invoke

  public constructor(invoke: Invoke = tauriInvoke) {
    this.#invoke = invoke
  }

  public async getLibrary(
    request: CharacterLibraryRequest,
  ): Promise<CharacterLibrarySnapshot> {
    return this.invokeParsed(
      characterLibraryCommands.get,
      request,
      parseCharacterLibrarySnapshot,
    )
  }

  public async pickImport(
    request: CharacterLibraryRequest,
  ): Promise<CharacterImportResponse> {
    return this.invokeParsed(
      characterLibraryCommands.pickImport,
      request,
      parseCharacterImportResponse,
    )
  }

  public async attestPreview(
    request: CharacterPreviewAttestationRequest,
  ): Promise<CharacterPreviewAttestationResponse> {
    return this.invokeParsed(
      characterLibraryCommands.attestPreview,
      request,
      parseCharacterPreviewAttestationResponse,
    )
  }

  public async confirmImport(
    request: CharacterConfirmImportRequest,
  ): Promise<CharacterLibrarySnapshot> {
    return this.invokeParsed(
      characterLibraryCommands.confirmImport,
      request,
      parseCharacterLibrarySnapshot,
    )
  }

  public async cancelImport(
    request: CharacterCancelImportRequest,
  ): Promise<void> {
    try {
      const response = await this.#invoke<unknown>(
        characterLibraryCommands.cancelImport,
        { request },
      )
      if (response !== null) throw new CharacterLibraryOperationError()
    } catch (error) {
      if (error instanceof CharacterLibraryOperationError) throw error
      throwOperationError(error)
    }
  }

  public async selectPack(
    request: CharacterLibraryRequest & { readonly packId: string },
  ): Promise<CharacterLibrarySnapshot> {
    return this.invokeParsed(
      characterLibraryCommands.selectPack,
      request,
      parseCharacterLibrarySnapshot,
    )
  }

  public async deletePack(
    request: CharacterLibraryRequest & { readonly packId: string },
  ): Promise<CharacterLibrarySnapshot> {
    return this.invokeParsed(
      characterLibraryCommands.deletePack,
      request,
      parseCharacterLibrarySnapshot,
    )
  }

  public createPackRef(pack: CharacterPackView): CharacterPackRef {
    if (pack.kind === "builtin") {
      return {
        kind: "url",
        manifestUrl: "/characters/builtin-hiyori/pack.json",
      }
    }
    if (pack.manifest === null) throw new CharacterLibraryOperationError()
    return this.nativePackRef(pack.manifest, pack.manifestHash, null)
  }

  public createPreviewPackRef(
    preview: CharacterPreviewSession,
  ): CharacterPackRef {
    return this.nativePackRef(
      preview.manifest,
      preview.manifestHash,
      preview.previewToken,
    )
  }

  private nativePackRef(
    manifest: CharacterPackManifest,
    manifestHash: string,
    previewToken: string | null,
  ): CharacterPackRef {
    return {
      kind: "native",
      manifest,
      manifestHash,
      previewToken,
      readAsset: (assetId, expectedMime, signal) =>
        this.readAsset(
          {
            packId: manifest.packId,
            assetId,
            manifestHash,
            expectedMime,
            previewToken,
          },
          signal,
        ),
    }
  }

  private async readAsset(
    request: CharacterAssetRequest,
    signal: AbortSignal,
  ): Promise<ArrayBuffer> {
    if (signal.aborted) throw signal.reason
    try {
      const value = await this.#invoke<unknown>(
        characterLibraryCommands.readAsset,
        { request },
      )
      if (signal.aborted) throw signal.reason
      return normalizeBinaryResponse(value)
    } catch (error) {
      if (error instanceof CharacterLibraryOperationError) throw error
      throwOperationError(error)
    }
  }

  private async invokeParsed<T>(
    command: string,
    request: unknown,
    parse: (value: unknown) => T,
  ): Promise<T> {
    let response: unknown
    try {
      response = await this.#invoke<unknown>(command, { request })
    } catch (error) {
      if (error instanceof CharacterLibraryOperationError) throw error
      const native = parseCharacterCommandError(error)
      if (native !== null) throw new CharacterLibraryOperationError(native)
      throw new CharacterLibraryOperationError()
    }
    return parse(response)
  }
}

export class DemoCharacterLibraryGateway implements CharacterLibraryGateway {
  public readonly kind = "demo" as const
  readonly #manifest = parseCharacterPackManifest(structuredClone(hiyoriPack))

  public getLibrary(
    request: CharacterLibraryRequest,
  ): Promise<CharacterLibrarySnapshot> {
    return Promise.resolve(this.snapshot(request.workspaceId))
  }

  public pickImport(
    request: CharacterLibraryRequest,
  ): Promise<CharacterImportResponse> {
    void request
    return Promise.resolve({
      schemaVersion: characterLibrarySchemaVersion,
      outcome: "canceled",
      preview: null,
    })
  }

  public attestPreview(
    request: CharacterPreviewAttestationRequest,
  ): Promise<CharacterPreviewAttestationResponse> {
    void request
    return Promise.reject(new CharacterLibraryOperationError())
  }

  public confirmImport(
    request: CharacterConfirmImportRequest,
  ): Promise<CharacterLibrarySnapshot> {
    void request
    return Promise.reject(new CharacterLibraryOperationError())
  }

  public cancelImport(request: CharacterCancelImportRequest): Promise<void> {
    void request
    return Promise.resolve()
  }

  public selectPack(
    request: CharacterLibraryRequest & { readonly packId: string },
  ): Promise<CharacterLibrarySnapshot> {
    return request.packId === builtinHiyoriPackId
      ? Promise.resolve(this.snapshot(request.workspaceId))
      : Promise.reject(new CharacterLibraryOperationError())
  }

  public deletePack(
    request: CharacterLibraryRequest & { readonly packId: string },
  ): Promise<CharacterLibrarySnapshot> {
    void request
    return Promise.reject(new CharacterLibraryOperationError())
  }

  public createPackRef(pack: CharacterPackView): CharacterPackRef {
    void pack
    return {
      kind: "url",
      manifestUrl: "/characters/builtin-hiyori/pack.json",
    }
  }

  public createPreviewPackRef(
    preview: CharacterPreviewSession,
  ): CharacterPackRef {
    void preview
    throw new CharacterLibraryOperationError()
  }

  private snapshot(workspaceId: string): CharacterLibrarySnapshot {
    const provenance = this.#manifest.provenance
    const provenanceLabel =
      provenance.sourceKind === "developer-provided"
        ? `${provenance.illustration} / ${provenance.modeling}`
        : provenance.sourceLabel
    return {
      schemaVersion: characterLibrarySchemaVersion,
      workspaceId,
      selectedPackId: builtinHiyoriPackId,
      fallbackApplied: false,
      diagnostics: [],
      packs: [
        {
          schemaVersion: characterLibrarySchemaVersion,
          packId: builtinHiyoriPackId,
          displayName: this.#manifest.displayName,
          kind: "builtin",
          manifestHash: "0".repeat(64),
          provenanceLabel,
          importedAt: null,
          runtimeFileCount: this.#manifest.inventory.runtimeFileCount,
          totalBytes: this.#manifest.inventory.totalBytes,
          textureCount: this.#manifest.inventory.textureCount,
          motionCount: this.#manifest.inventory.motionCount,
          expressionCount: this.#manifest.inventory.expressionCount,
          selectedWorkspaceCount: 1,
          deletable: false,
          manifest: null,
          thumbnailSha256: null,
        },
      ],
    }
  }
}

export function createCharacterLibraryGateway(
  transportKind: "native" | "demo",
): CharacterLibraryGateway {
  return transportKind === "native"
    ? new NativeCharacterLibraryGateway()
    : new DemoCharacterLibraryGateway()
}
