/* eslint-disable react-refresh/only-export-components -- Provider and external-store hooks share one scoped store. */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import type { CharacterPackRef } from "@/features/character/model"
import type {
  CharacterConfirmImportRequest,
  CharacterImportResponse,
  CharacterLibrarySnapshot,
  CharacterPackView,
  CharacterPreviewAttestationRequest,
  CharacterPreviewAttestationResponse,
  CharacterPreviewSession,
} from "@/features/character/library/contracts"
import {
  CharacterLibraryOperationError,
  type CharacterLibraryGateway,
} from "@/features/character/library/transport"

export type CharacterLibraryMutation =
  | "importing"
  | "attesting"
  | "confirming"
  | "canceling"
  | "selecting"
  | "deleting"

export interface CharacterLibraryState {
  readonly status: "idle" | "loading" | "ready" | "error"
  readonly workspaceId: string
  readonly snapshot: CharacterLibrarySnapshot | null
  readonly preview: CharacterPreviewSession | null
  readonly mutation: CharacterLibraryMutation | null
  readonly errorCode: string | null
}

type Listener = () => void

function initialState(workspaceId: string): CharacterLibraryState {
  return {
    status: "idle",
    workspaceId,
    snapshot: null,
    preview: null,
    mutation: null,
    errorCode: null,
  }
}

function safeErrorCode(error: unknown): string {
  return error instanceof CharacterLibraryOperationError
    ? error.code
    : "CHARACTER-CONTRACT-FAILED"
}

export class CharacterLibraryStore {
  public readonly gateway: CharacterLibraryGateway
  readonly #states = new Map<string, CharacterLibraryState>()
  readonly #listeners = new Set<Listener>()
  readonly #loads = new Map<string, Promise<CharacterLibrarySnapshot>>()
  readonly #sessionCounts = new Map<string, number>()
  readonly #previewCancellations = new Map<string, Promise<void>>()
  readonly #restoreFocus = new Set<string>()

  public constructor(gateway: CharacterLibraryGateway) {
    this.gateway = gateway
  }

  public readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  public getState(workspaceId: string): CharacterLibraryState {
    const existing = this.#states.get(workspaceId)
    if (existing !== undefined) return existing
    const state = initialState(workspaceId)
    this.#states.set(workspaceId, state)
    return state
  }

  public acquireSession(workspaceId: string): () => void {
    this.#sessionCounts.set(
      workspaceId,
      (this.#sessionCounts.get(workspaceId) ?? 0) + 1,
    )
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = Math.max(
        0,
        (this.#sessionCounts.get(workspaceId) ?? 1) - 1,
      )
      if (remaining === 0) {
        this.#sessionCounts.delete(workspaceId)
        const state = this.getState(workspaceId)
        if (
          state.preview !== null ||
          state.mutation === "importing" ||
          state.mutation === "attesting"
        ) {
          this.#restoreFocus.add(workspaceId)
        }
        this.scheduleUnownedPreviewCancellation(workspaceId)
      } else {
        this.#sessionCounts.set(workspaceId, remaining)
      }
    }
  }

  public consumeRestoreFocus(workspaceId: string): boolean {
    return this.#restoreFocus.delete(workspaceId)
  }

  public load(workspaceId: string): Promise<CharacterLibrarySnapshot> {
    const inFlight = this.#loads.get(workspaceId)
    if (inFlight !== undefined) return inFlight
    const current = this.getState(workspaceId)
    this.setState(workspaceId, {
      ...current,
      status: current.snapshot === null ? "loading" : current.status,
      errorCode: null,
    })
    const load = this.gateway
      .getLibrary({ workspaceId })
      .then((snapshot) => {
        this.setState(workspaceId, {
          ...this.getState(workspaceId),
          status: "ready",
          snapshot,
          errorCode: null,
        })
        return snapshot
      })
      .catch((error: unknown) => {
        this.setState(workspaceId, {
          ...this.getState(workspaceId),
          status: "error",
          errorCode: safeErrorCode(error),
        })
        throw error
      })
      .finally(() => {
        if (this.#loads.get(workspaceId) === load) {
          this.#loads.delete(workspaceId)
        }
      })
    this.#loads.set(workspaceId, load)
    return load
  }

  public async beginImport(
    workspaceId: string,
  ): Promise<CharacterImportResponse> {
    this.beginMutation(workspaceId, "importing")
    try {
      const response = await this.gateway.pickImport({ workspaceId })
      this.setState(workspaceId, {
        ...this.getState(workspaceId),
        preview: response.preview,
        mutation: null,
        errorCode: null,
      })
      if ((this.#sessionCounts.get(workspaceId) ?? 0) === 0) {
        this.scheduleUnownedPreviewCancellation(workspaceId)
      }
      return response
    } catch (error) {
      this.failMutation(workspaceId, error)
      throw error
    }
  }

  public async attestPreview(
    workspaceId: string,
    request: CharacterPreviewAttestationRequest,
  ): Promise<CharacterPreviewAttestationResponse> {
    this.requirePreview(workspaceId, request.previewToken)
    this.beginMutation(workspaceId, "attesting")
    try {
      const response = await this.gateway.attestPreview(request)
      this.finishMutation(workspaceId)
      return response
    } catch (error) {
      this.failMutation(workspaceId, error)
      throw error
    }
  }

  public async confirmImport(
    request: CharacterConfirmImportRequest,
  ): Promise<CharacterLibrarySnapshot> {
    this.requirePreview(request.workspaceId, request.previewToken)
    this.beginMutation(request.workspaceId, "confirming")
    try {
      const snapshot = await this.gateway.confirmImport(request)
      this.setState(request.workspaceId, {
        ...this.getState(request.workspaceId),
        status: "ready",
        snapshot,
        preview: null,
        mutation: null,
        errorCode: null,
      })
      return snapshot
    } catch (error) {
      this.failMutation(request.workspaceId, error)
      throw error
    }
  }

  public async cancelImport(workspaceId: string): Promise<void> {
    const preview = this.requirePreview(workspaceId)
    this.beginMutation(workspaceId, "canceling")
    try {
      await this.cancelPreviewRequest(preview)
      this.setState(workspaceId, {
        ...this.getState(workspaceId),
        preview: null,
        mutation: null,
        errorCode: null,
      })
    } catch (error) {
      this.failMutation(workspaceId, error)
      throw error
    }
  }

  public async selectPack(
    workspaceId: string,
    packId: string,
  ): Promise<CharacterLibrarySnapshot> {
    this.beginMutation(workspaceId, "selecting")
    try {
      const snapshot = await this.gateway.selectPack({ workspaceId, packId })
      this.setState(workspaceId, {
        ...this.getState(workspaceId),
        status: "ready",
        snapshot,
        mutation: null,
        errorCode: null,
      })
      return snapshot
    } catch (error) {
      this.failMutation(workspaceId, error)
      throw error
    }
  }

  public async deletePack(
    workspaceId: string,
    packId: string,
  ): Promise<CharacterLibrarySnapshot> {
    this.beginMutation(workspaceId, "deleting")
    try {
      const snapshot = await this.gateway.deletePack({ workspaceId, packId })
      this.setState(workspaceId, {
        ...this.getState(workspaceId),
        status: "ready",
        snapshot,
        mutation: null,
        errorCode: null,
      })
      return snapshot
    } catch (error) {
      this.failMutation(workspaceId, error)
      throw error
    }
  }

  public selectedPack(workspaceId: string): CharacterPackView | null {
    const snapshot = this.getState(workspaceId).snapshot
    return (
      snapshot?.packs.find((pack) => pack.packId === snapshot.selectedPackId) ??
      null
    )
  }

  public selectedPackRef(workspaceId: string): CharacterPackRef | null {
    const pack = this.selectedPack(workspaceId)
    return pack === null ? null : this.gateway.createPackRef(pack)
  }

  public previewPackRef(workspaceId: string): CharacterPackRef | null {
    const preview = this.getState(workspaceId).preview
    return preview === null ? null : this.gateway.createPreviewPackRef(preview)
  }

  private beginMutation(
    workspaceId: string,
    mutation: CharacterLibraryMutation,
  ): void {
    const current = this.getState(workspaceId)
    if (current.mutation !== null) throw new CharacterLibraryOperationError()
    this.setState(workspaceId, {
      ...current,
      mutation,
      errorCode: null,
    })
  }

  private finishMutation(workspaceId: string): void {
    this.setState(workspaceId, {
      ...this.getState(workspaceId),
      mutation: null,
      errorCode: null,
    })
  }

  private failMutation(workspaceId: string, error: unknown): void {
    this.setState(workspaceId, {
      ...this.getState(workspaceId),
      mutation: null,
      errorCode: safeErrorCode(error),
    })
  }

  private requirePreview(
    workspaceId: string,
    token?: string,
  ): CharacterPreviewSession {
    const preview = this.getState(workspaceId).preview
    if (
      preview === null ||
      (token !== undefined && token !== preview.previewToken)
    ) {
      throw new CharacterLibraryOperationError()
    }
    return preview
  }

  private setState(workspaceId: string, state: CharacterLibraryState): void {
    this.#states.set(workspaceId, state)
    for (const listener of this.#listeners) listener()
  }

  private scheduleUnownedPreviewCancellation(workspaceId: string): void {
    queueMicrotask(() => {
      if ((this.#sessionCounts.get(workspaceId) ?? 0) !== 0) return
      const preview = this.getState(workspaceId).preview
      if (preview === null) return
      void this.cancelPreviewRequest(preview).then(
        () => {
          const current = this.getState(workspaceId)
          if (current.preview?.previewToken !== preview.previewToken) return
          this.setState(workspaceId, {
            ...current,
            preview: null,
            mutation:
              current.mutation === "canceling" ? null : current.mutation,
            errorCode: null,
          })
        },
        (error: unknown) => {
          const current = this.getState(workspaceId)
          if (current.preview?.previewToken !== preview.previewToken) return
          this.setState(workspaceId, {
            ...current,
            errorCode: safeErrorCode(error),
          })
        },
      )
    })
  }

  private cancelPreviewRequest(
    preview: CharacterPreviewSession,
  ): Promise<void> {
    const existing = this.#previewCancellations.get(preview.previewToken)
    if (existing !== undefined) return existing
    const cancellation = this.gateway
      .cancelImport({
        previewToken: preview.previewToken,
        previewNonce: preview.previewNonce,
        generation: preview.generation,
      })
      .finally(() => {
        if (
          this.#previewCancellations.get(preview.previewToken) === cancellation
        ) {
          this.#previewCancellations.delete(preview.previewToken)
        }
      })
    this.#previewCancellations.set(preview.previewToken, cancellation)
    return cancellation
  }
}

const CharacterLibraryContext = createContext<CharacterLibraryStore | null>(
  null,
)

export function CharacterLibraryProvider({
  children,
  gateway,
}: {
  readonly children: ReactNode
  readonly gateway: CharacterLibraryGateway
}) {
  const store = useMemo(() => new CharacterLibraryStore(gateway), [gateway])
  return (
    <CharacterLibraryContext.Provider value={store}>
      {children}
    </CharacterLibraryContext.Provider>
  )
}

export function useCharacterLibraryStore(): CharacterLibraryStore {
  const store = useContext(CharacterLibraryContext)
  if (store === null) throw new Error("CharacterLibraryProvider is missing")
  return store
}

export function useCharacterLibrary(
  workspaceId: string,
): CharacterLibraryState {
  const store = useCharacterLibraryStore()
  const state = useSyncExternalStore(
    store.subscribe,
    () => store.getState(workspaceId),
    () => store.getState(workspaceId),
  )
  useEffect(() => {
    if (state.status === "idle")
      void store.load(workspaceId).catch(() => undefined)
  }, [state.status, store, workspaceId])
  return state
}
