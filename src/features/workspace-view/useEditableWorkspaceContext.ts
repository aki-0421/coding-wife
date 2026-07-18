import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import {
  parseCharacterContext,
  parseProjectContext,
  type CharacterContext,
  type ProjectContext,
  type VersionedCharacterContext,
  type VersionedProjectContext,
} from "@/lib/contracts/workspace-context"
import type { WorkspaceViewAdapter } from "@/features/workspace-view/types"

type SectionStatus =
  "loading" | "ready" | "saving" | "saved" | "conflict" | "error"

export interface ContextConflict {
  readonly localVersion: number
  readonly remoteVersion: number
  readonly changedFields: readonly string[]
}

export interface EditableContextSection<T, V> {
  readonly persisted: V | null
  readonly draft: T
  readonly status: SectionStatus
  readonly dirty: boolean
  readonly errorCode: string | null
  readonly conflict: ContextConflict | null
}

interface WorkspaceContextState {
  readonly project: EditableContextSection<
    ProjectContext,
    VersionedProjectContext
  >
  readonly character: EditableContextSection<
    CharacterContext,
    VersionedCharacterContext
  >
}

export interface EditableWorkspaceContextModel extends WorkspaceContextState {
  readonly workspaceId: string
  readonly updateProject: (change: Partial<ProjectContext>) => void
  readonly updateCharacter: (change: Partial<CharacterContext>) => void
  readonly saveProject: () => Promise<boolean>
  readonly saveCharacter: () => Promise<boolean>
  readonly discardProject: () => void
  readonly discardCharacter: () => void
  readonly reloadProject: () => void
  readonly reloadCharacter: () => void
  readonly retryLoad: () => void
}

const emptyProject: ProjectContext = {
  goal: "",
  constraints: "",
  definitionOfDone: [],
  technicalReferences: [],
  userNotes: "",
}

const emptyCharacter: CharacterContext = {
  displayName: "Sol",
  tone: "neutral",
  toneNotes: "",
  speechDensity: "key_events",
  behavior: "",
  prohibitedExpressions: [],
}

function loadingState(): WorkspaceContextState {
  return {
    project: {
      persisted: null,
      draft: emptyProject,
      status: "loading",
      dirty: false,
      errorCode: null,
      conflict: null,
    },
    character: {
      persisted: null,
      draft: emptyCharacter,
      status: "loading",
      dirty: false,
      errorCode: null,
      conflict: null,
    },
  }
}

function safeErrorCode(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9-]{2,127}$/u.test(error.code)
  ) {
    return error.code
  }
  return fallback
}

function changedFields<T extends object>(local: T, remote: T): string[] {
  return Object.keys(local).filter(
    (key) =>
      JSON.stringify(local[key as keyof T]) !==
      JSON.stringify(remote[key as keyof T]),
  )
}

export function useEditableWorkspaceContext(
  adapter: WorkspaceViewAdapter | undefined,
  workspaceId: string,
): EditableWorkspaceContextModel {
  const [states, setStates] = useState<
    Readonly<Record<string, WorkspaceContextState>>
  >({})
  const statesRef = useRef(states)
  const loadGenerations = useRef(new Map<string, number>())
  const projectSaveGenerations = useRef(new Map<string, number>())
  const characterSaveGenerations = useRef(new Map<string, number>())

  useLayoutEffect(() => {
    statesRef.current = states
  }, [states])

  const replaceWorkspace = useCallback(
    (
      id: string,
      update: (current: WorkspaceContextState) => WorkspaceContextState,
    ) => {
      setStates((current) => ({
        ...current,
        [id]: update(current[id] ?? loadingState()),
      }))
    },
    [],
  )

  const load = useCallback(
    (id: string, force = false) => {
      const token = (loadGenerations.current.get(id) ?? 0) + 1
      loadGenerations.current.set(id, token)
      if (id === "__no_workspace__") return
      const cached = statesRef.current[id]
      if (
        !force &&
        cached !== undefined &&
        cached.project.persisted !== null &&
        cached.character.persisted !== null
      ) {
        return
      }
      replaceWorkspace(id, () => loadingState())
      if (adapter?.loadEditableContext === undefined) {
        replaceWorkspace(id, (current) => ({
          project: {
            ...current.project,
            status: "error",
            errorCode: "WORKSPACE-CONTEXT-UNAVAILABLE",
          },
          character: {
            ...current.character,
            status: "error",
            errorCode: "WORKSPACE-CONTEXT-UNAVAILABLE",
          },
        }))
        return
      }
      void adapter.loadEditableContext(id).then(
        (bundle) => {
          if (
            token !== loadGenerations.current.get(id) ||
            bundle.workspaceId !== id
          ) {
            return
          }
          replaceWorkspace(id, () => ({
            project: {
              persisted: bundle.project,
              draft: bundle.project.context,
              status: "ready",
              dirty: false,
              errorCode: null,
              conflict: null,
            },
            character: {
              persisted: bundle.character,
              draft: bundle.character.context,
              status: "ready",
              dirty: false,
              errorCode: null,
              conflict: null,
            },
          }))
        },
        (error: unknown) => {
          if (token !== loadGenerations.current.get(id)) return
          const errorCode = safeErrorCode(
            error,
            "WORKSPACE-CONTEXT-LOAD-FAILED",
          )
          replaceWorkspace(id, (current) => ({
            project: { ...current.project, status: "error", errorCode },
            character: { ...current.character, status: "error", errorCode },
          }))
        },
      )
    },
    [adapter, replaceWorkspace],
  )

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) load(workspaceId)
    })
    return () => {
      active = false
    }
  }, [load, workspaceId])

  const updateProject = useCallback(
    (change: Partial<ProjectContext>) => {
      replaceWorkspace(workspaceId, (current) => ({
        ...current,
        project: {
          ...current.project,
          draft: { ...current.project.draft, ...change },
          status: current.project.persisted === null ? "loading" : "ready",
          dirty: true,
          errorCode: null,
          conflict: null,
        },
      }))
    },
    [replaceWorkspace, workspaceId],
  )

  const updateCharacter = useCallback(
    (change: Partial<CharacterContext>) => {
      replaceWorkspace(workspaceId, (current) => ({
        ...current,
        character: {
          ...current.character,
          draft: { ...current.character.draft, ...change },
          status: current.character.persisted === null ? "loading" : "ready",
          dirty: true,
          errorCode: null,
          conflict: null,
        },
      }))
    },
    [replaceWorkspace, workspaceId],
  )

  const saveProject = useCallback(async () => {
    const current = statesRef.current[workspaceId]?.project
    if (
      current?.persisted === null ||
      current === undefined ||
      adapter?.saveProjectContext === undefined
    ) {
      return false
    }
    const expectedVersion = current.persisted.version
    const token = (projectSaveGenerations.current.get(workspaceId) ?? 0) + 1
    projectSaveGenerations.current.set(workspaceId, token)
    let context: ProjectContext
    try {
      context = parseProjectContext(current.draft)
    } catch {
      replaceWorkspace(workspaceId, (state) => ({
        ...state,
        project: {
          ...state.project,
          status: "error",
          errorCode: "WORKSPACE-PROJECT-CONTEXT-INVALID",
        },
      }))
      return false
    }
    replaceWorkspace(workspaceId, (state) => ({
      ...state,
      project: { ...state.project, status: "saving", errorCode: null },
    }))
    try {
      const saved = await adapter.saveProjectContext(
        workspaceId,
        expectedVersion,
        context,
      )
      if (
        token !== projectSaveGenerations.current.get(workspaceId) ||
        saved.workspaceId !== workspaceId
      ) {
        return false
      }
      replaceWorkspace(workspaceId, (state) => ({
        ...state,
        project: {
          persisted: saved,
          draft: saved.context,
          status: "saved",
          dirty: false,
          errorCode: null,
          conflict: null,
        },
      }))
      return true
    } catch (error) {
      if (token !== projectSaveGenerations.current.get(workspaceId)) {
        return false
      }
      const code = safeErrorCode(error, "WORKSPACE-PROJECT-CONTEXT-SAVE-FAILED")
      if (
        code === "WORKSPACE-PROJECT-CONTEXT-CONFLICT" &&
        adapter.loadEditableContext !== undefined
      ) {
        try {
          const remote = await adapter.loadEditableContext(workspaceId)
          if (
            token !== projectSaveGenerations.current.get(workspaceId) ||
            remote.workspaceId !== workspaceId
          ) {
            return false
          }
          replaceWorkspace(workspaceId, (state) => ({
            ...state,
            project: {
              ...state.project,
              persisted: remote.project,
              status: "conflict",
              errorCode: code,
              conflict: {
                localVersion: expectedVersion,
                remoteVersion: remote.project.version,
                changedFields: changedFields(
                  state.project.draft,
                  remote.project.context,
                ),
              },
            },
          }))
          return false
        } catch {
          // Fall through to the safe conflict code while preserving the draft.
        }
      }
      replaceWorkspace(workspaceId, (state) => ({
        ...state,
        project: { ...state.project, status: "error", errorCode: code },
      }))
      return false
    }
  }, [adapter, replaceWorkspace, workspaceId])

  const saveCharacter = useCallback(async () => {
    const current = statesRef.current[workspaceId]?.character
    if (
      current?.persisted === null ||
      current === undefined ||
      adapter?.saveCharacterContext === undefined
    ) {
      return false
    }
    const expectedVersion = current.persisted.version
    const token = (characterSaveGenerations.current.get(workspaceId) ?? 0) + 1
    characterSaveGenerations.current.set(workspaceId, token)
    let context: CharacterContext
    try {
      context = parseCharacterContext(current.draft)
    } catch {
      replaceWorkspace(workspaceId, (state) => ({
        ...state,
        character: {
          ...state.character,
          status: "error",
          errorCode: "WORKSPACE-CHARACTER-CONTEXT-INVALID",
        },
      }))
      return false
    }
    replaceWorkspace(workspaceId, (state) => ({
      ...state,
      character: { ...state.character, status: "saving", errorCode: null },
    }))
    try {
      const saved = await adapter.saveCharacterContext(
        workspaceId,
        expectedVersion,
        context,
      )
      if (
        token !== characterSaveGenerations.current.get(workspaceId) ||
        saved.workspaceId !== workspaceId
      ) {
        return false
      }
      replaceWorkspace(workspaceId, (state) => ({
        ...state,
        character: {
          persisted: saved,
          draft: saved.context,
          status: "saved",
          dirty: false,
          errorCode: null,
          conflict: null,
        },
      }))
      return true
    } catch (error) {
      if (token !== characterSaveGenerations.current.get(workspaceId)) {
        return false
      }
      const code = safeErrorCode(
        error,
        "WORKSPACE-CHARACTER-CONTEXT-SAVE-FAILED",
      )
      if (
        code === "WORKSPACE-CHARACTER-CONTEXT-CONFLICT" &&
        adapter.loadEditableContext !== undefined
      ) {
        try {
          const remote = await adapter.loadEditableContext(workspaceId)
          if (
            token !== characterSaveGenerations.current.get(workspaceId) ||
            remote.workspaceId !== workspaceId
          ) {
            return false
          }
          replaceWorkspace(workspaceId, (state) => ({
            ...state,
            character: {
              ...state.character,
              persisted: remote.character,
              status: "conflict",
              errorCode: code,
              conflict: {
                localVersion: expectedVersion,
                remoteVersion: remote.character.version,
                changedFields: changedFields(
                  state.character.draft,
                  remote.character.context,
                ),
              },
            },
          }))
          return false
        } catch {
          // Fall through to the safe conflict code while preserving the draft.
        }
      }
      replaceWorkspace(workspaceId, (state) => ({
        ...state,
        character: { ...state.character, status: "error", errorCode: code },
      }))
      return false
    }
  }, [adapter, replaceWorkspace, workspaceId])

  const discardProject = useCallback(() => {
    replaceWorkspace(workspaceId, (state) => ({
      ...state,
      project:
        state.project.persisted === null
          ? state.project
          : {
              persisted: state.project.persisted,
              draft: state.project.persisted.context,
              status: "ready",
              dirty: false,
              errorCode: null,
              conflict: null,
            },
    }))
  }, [replaceWorkspace, workspaceId])

  const discardCharacter = useCallback(() => {
    replaceWorkspace(workspaceId, (state) => ({
      ...state,
      character:
        state.character.persisted === null
          ? state.character
          : {
              persisted: state.character.persisted,
              draft: state.character.persisted.context,
              status: "ready",
              dirty: false,
              errorCode: null,
              conflict: null,
            },
    }))
  }, [replaceWorkspace, workspaceId])

  const current = states[workspaceId] ?? loadingState()
  return useMemo(
    () => ({
      workspaceId,
      ...current,
      updateProject,
      updateCharacter,
      saveProject,
      saveCharacter,
      discardProject,
      discardCharacter,
      reloadProject: discardProject,
      reloadCharacter: discardCharacter,
      retryLoad: () => load(workspaceId, true),
    }),
    [
      current,
      discardCharacter,
      discardProject,
      load,
      saveCharacter,
      saveProject,
      updateCharacter,
      updateProject,
      workspaceId,
    ],
  )
}
