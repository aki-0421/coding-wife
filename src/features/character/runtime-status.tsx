import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import hiyoriPack from "../../../src-tauri/resources/characters/builtin-hiyori/pack.json"
import type {
  CharacterControllerStatus,
  CharacterErrorCode,
} from "@/features/character/model"

export type CharacterRendererKind = "builtin_hiyori" | "external"

export const BUILTIN_HIYORI_PACK = Object.freeze({
  packId: hiyoriPack.packId,
  displayName: hiyoriPack.displayName,
  bundledVersion: hiyoriPack.bundledVersion,
  illustration: hiyoriPack.provenance.illustration,
  modeling: hiyoriPack.provenance.modeling,
  noticeSha256: hiyoriPack.provenance.noticeSha256,
})

export interface CharacterRuntimeSnapshot {
  readonly rendererKind: CharacterRendererKind
  readonly workspaceId: string
  readonly generation: number
  readonly mounted: boolean
  readonly status: CharacterControllerStatus | null
  readonly lastErrorCode: CharacterErrorCode | null
  readonly canRetry: boolean
}

export interface CharacterRuntimeSession {
  readonly id: number
  readonly workspaceId: string
  readonly generation: number
}

interface RuntimeEntry {
  readonly sessionId: number
  readonly snapshot: CharacterRuntimeSnapshot
  readonly retry: (() => void) | null
}

type Listener = () => void

export class CharacterRuntimeStatusStore {
  readonly #rendererKind: CharacterRendererKind
  readonly #entries = new Map<string, RuntimeEntry>()
  readonly #listeners = new Set<Listener>()
  readonly #closedSessions = new Set<number>()
  #nextSessionId = 1

  public constructor(rendererKind: CharacterRendererKind) {
    this.#rendererKind = rendererKind
  }

  public readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  public createSession(
    workspaceId: string,
    generation: number,
  ): CharacterRuntimeSession {
    return Object.freeze({
      id: this.#nextSessionId++,
      workspaceId,
      generation,
    })
  }

  public mount(session: CharacterRuntimeSession, retry: () => void): void {
    if (this.#rendererKind !== "builtin_hiyori") return
    const current = this.#entries.get(session.workspaceId)
    if (!this.isCurrentOrNewer(session, current)) return

    this.#closedSessions.delete(session.id)
    this.setEntry(session.workspaceId, {
      sessionId: session.id,
      retry,
      snapshot: {
        rendererKind: this.#rendererKind,
        workspaceId: session.workspaceId,
        generation: session.generation,
        mounted: true,
        status:
          current?.snapshot.generation === session.generation
            ? current.snapshot.status
            : null,
        lastErrorCode: current?.snapshot.lastErrorCode ?? null,
        canRetry: false,
      },
    })
  }

  public report(
    session: CharacterRuntimeSession,
    status: CharacterControllerStatus,
    retry: () => void,
  ): void {
    if (
      this.#rendererKind !== "builtin_hiyori" ||
      this.#closedSessions.has(session.id)
    ) {
      return
    }
    if (status.phase === "disposed") {
      this.unmount(session)
      return
    }

    const current = this.#entries.get(session.workspaceId)
    if (!this.isCurrentOrNewer(session, current)) return
    const errorCode = status.error?.code
    const lastErrorCode =
      errorCode !== undefined && errorCode !== "disposed"
        ? errorCode
        : (current?.snapshot.lastErrorCode ?? null)

    this.setEntry(session.workspaceId, {
      sessionId: session.id,
      retry,
      snapshot: {
        rendererKind: this.#rendererKind,
        workspaceId: session.workspaceId,
        generation: session.generation,
        mounted: true,
        status,
        lastErrorCode,
        canRetry:
          status.phase === "error" && status.error?.recoverable === true,
      },
    })
  }

  public unmount(session: CharacterRuntimeSession): void {
    this.#closedSessions.add(session.id)
    const current = this.#entries.get(session.workspaceId)
    if (current?.sessionId !== session.id) return

    this.setEntry(session.workspaceId, {
      sessionId: session.id,
      retry: null,
      snapshot: {
        ...current.snapshot,
        mounted: false,
        canRetry: false,
      },
    })
  }

  public retry(workspaceId: string): boolean {
    const current = this.#entries.get(workspaceId)
    if (!current?.snapshot.canRetry || current.retry === null) return false

    this.setEntry(workspaceId, {
      ...current,
      snapshot: { ...current.snapshot, canRetry: false },
    })
    current.retry()
    return true
  }

  public getSnapshot(workspaceId: string): CharacterRuntimeSnapshot {
    const current = this.#entries.get(workspaceId)
    if (current !== undefined) return current.snapshot

    const snapshot: CharacterRuntimeSnapshot = {
      rendererKind: this.#rendererKind,
      workspaceId,
      generation: 0,
      mounted: false,
      status: null,
      lastErrorCode: null,
      canRetry: false,
    }
    this.#entries.set(workspaceId, {
      sessionId: 0,
      snapshot,
      retry: null,
    })
    return snapshot
  }

  private isCurrentOrNewer(
    session: CharacterRuntimeSession,
    current: RuntimeEntry | undefined,
  ): boolean {
    if (current === undefined) return true
    if (session.generation !== current.snapshot.generation) {
      return session.generation > current.snapshot.generation
    }
    return session.id >= current.sessionId
  }

  private setEntry(workspaceId: string, entry: RuntimeEntry): void {
    this.#entries.set(workspaceId, entry)
    for (const listener of this.#listeners) listener()
  }
}

const CharacterRuntimeStatusContext =
  createContext<CharacterRuntimeStatusStore | null>(null)

export function CharacterRuntimeStatusProvider({
  children,
  rendererKind,
}: {
  readonly children: ReactNode
  readonly rendererKind: CharacterRendererKind
}) {
  const store = useMemo(
    () => new CharacterRuntimeStatusStore(rendererKind),
    [rendererKind],
  )
  return (
    <CharacterRuntimeStatusContext.Provider value={store}>
      {children}
    </CharacterRuntimeStatusContext.Provider>
  )
}

export function useCharacterRuntimeStatusStore(): CharacterRuntimeStatusStore {
  const store = useContext(CharacterRuntimeStatusContext)
  if (store === null) {
    throw new Error("CharacterRuntimeStatusProvider is missing")
  }
  return store
}

export function useCharacterRuntimeStatus(
  workspaceId: string,
): CharacterRuntimeSnapshot {
  const store = useCharacterRuntimeStatusStore()
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot(workspaceId),
    () => store.getSnapshot(workspaceId),
  )
}
