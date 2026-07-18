import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import {
  characterContextValidationIssue,
  parseCharacterContext,
  parseProjectContext,
  projectContextValidationIssue,
  type CharacterContext,
  type ProjectContext,
  type VersionedCharacterContext,
  type VersionedProjectContext,
  type WorkspaceContextValidationReason,
} from "@/lib/contracts/workspace-context"
import type { WorkspaceViewAdapter } from "@/features/workspace-view/types"

type SectionStatus =
  "loading" | "ready" | "saving" | "saved" | "conflict" | "error"

export interface ContextConflict {
  readonly localVersion: number
  readonly remoteVersion: number
  readonly changedFields: readonly string[]
}

export type ContextErrorReason =
  | WorkspaceContextValidationReason
  | "referenceBoundary"
  | "referenceMissing"
  | "referenceChanged"

export type EditableContextField = keyof ProjectContext | keyof CharacterContext

export interface ContextFieldError {
  readonly field: EditableContextField | null
  readonly reason: ContextErrorReason
}

export interface ProjectListDrafts {
  readonly definitionOfDone: string
  readonly technicalReferences: string
}

export interface CharacterListDrafts {
  readonly prohibitedExpressions: string
}

export interface EditableContextSection<T, V, L> {
  readonly persisted: V | null
  readonly draft: T
  readonly listDrafts: L
  readonly status: SectionStatus
  readonly dirty: boolean
  readonly errorCode: string | null
  readonly fieldError: ContextFieldError | null
  readonly conflict: ContextConflict | null
}

interface WorkspaceContextState {
  readonly project: EditableContextSection<
    ProjectContext,
    VersionedProjectContext,
    ProjectListDrafts
  >
  readonly character: EditableContextSection<
    CharacterContext,
    VersionedCharacterContext,
    CharacterListDrafts
  >
}

export interface EditableWorkspaceContextModel extends WorkspaceContextState {
  readonly workspaceId: string
  readonly updateProject: (change: Partial<ProjectContext>) => void
  readonly updateCharacter: (change: Partial<CharacterContext>) => void
  readonly updateProjectList: (
    field: keyof ProjectListDrafts,
    value: string,
  ) => void
  readonly updateCharacterList: (value: string) => void
  readonly normalizeProjectList: (field: keyof ProjectListDrafts) => void
  readonly normalizeCharacterList: () => void
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

export function normalizeContextListDraft(value: string): readonly string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function projectListDrafts(context: ProjectContext): ProjectListDrafts {
  return {
    definitionOfDone: context.definitionOfDone.join("\n"),
    technicalReferences: context.technicalReferences.join("\n"),
  }
}

function characterListDrafts(context: CharacterContext): CharacterListDrafts {
  return { prohibitedExpressions: context.prohibitedExpressions.join("\n") }
}

function loadingState(): WorkspaceContextState {
  return {
    project: {
      persisted: null,
      draft: emptyProject,
      listDrafts: projectListDrafts(emptyProject),
      status: "loading",
      dirty: false,
      errorCode: null,
      fieldError: null,
      conflict: null,
    },
    character: {
      persisted: null,
      draft: emptyCharacter,
      listDrafts: characterListDrafts(emptyCharacter),
      status: "loading",
      dirty: false,
      errorCode: null,
      fieldError: null,
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

function projectContextWithLists(
  draft: ProjectContext,
  listDrafts: ProjectListDrafts,
): ProjectContext {
  return {
    ...draft,
    definitionOfDone: normalizeContextListDraft(listDrafts.definitionOfDone),
    technicalReferences: normalizeContextListDraft(
      listDrafts.technicalReferences,
    ),
  }
}

function characterContextWithLists(
  draft: CharacterContext,
  listDrafts: CharacterListDrafts,
): CharacterContext {
  return {
    ...draft,
    prohibitedExpressions: normalizeContextListDraft(
      listDrafts.prohibitedExpressions,
    ),
  }
}

function projectNativeFieldError(code: string): ContextFieldError | null {
  const suffix = code.replace("WORKSPACE-PROJECT-CONTEXT-", "")
  if (suffix === "GOAL") return { field: "goal", reason: "text" }
  if (suffix === "CONSTRAINTS") {
    return { field: "constraints", reason: "text" }
  }
  if (suffix === "DEFINITION") {
    return { field: "definitionOfDone", reason: "items" }
  }
  if (suffix === "REFERENCES") {
    return { field: "technicalReferences", reason: "technicalReference" }
  }
  if (suffix === "REFERENCE-BOUNDARY") {
    return { field: "technicalReferences", reason: "referenceBoundary" }
  }
  if (suffix === "REFERENCE-MISSING") {
    return { field: "technicalReferences", reason: "referenceMissing" }
  }
  if (suffix === "REFERENCE-CHANGED") {
    return { field: "technicalReferences", reason: "referenceChanged" }
  }
  if (suffix === "NOTES") return { field: "userNotes", reason: "text" }
  if (suffix === "TOTAL") return { field: null, reason: "total" }
  return null
}

function characterNativeFieldError(
  code: string,
  context: CharacterContext,
): ContextFieldError | null {
  const suffix = code.replace("WORKSPACE-CHARACTER-CONTEXT-", "")
  if (suffix === "DISPLAY-NAME") {
    return { field: "displayName", reason: "text" }
  }
  if (suffix === "TONE") return { field: "toneNotes", reason: "text" }
  if (suffix === "BEHAVIOR") return { field: "behavior", reason: "text" }
  if (suffix === "PROHIBITED") {
    return { field: "prohibitedExpressions", reason: "items" }
  }
  if (suffix === "POLICY") {
    const issue = characterContextValidationIssue(context)
    return issue?.reason === "policy"
      ? { field: issue.field, reason: "policy" }
      : { field: null, reason: "policy" }
  }
  if (suffix === "TOTAL") return { field: null, reason: "total" }
  return null
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
            fieldError: null,
          },
          character: {
            ...current.character,
            status: "error",
            errorCode: "WORKSPACE-CONTEXT-UNAVAILABLE",
            fieldError: null,
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
              listDrafts: projectListDrafts(bundle.project.context),
              status: "ready",
              dirty: false,
              errorCode: null,
              fieldError: null,
              conflict: null,
            },
            character: {
              persisted: bundle.character,
              draft: bundle.character.context,
              listDrafts: characterListDrafts(bundle.character.context),
              status: "ready",
              dirty: false,
              errorCode: null,
              fieldError: null,
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
            project: {
              ...current.project,
              status: "error",
              errorCode,
              fieldError: null,
            },
            character: {
              ...current.character,
              status: "error",
              errorCode,
              fieldError: null,
            },
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
          fieldError: null,
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
          fieldError: null,
          conflict: null,
        },
      }))
    },
    [replaceWorkspace, workspaceId],
  )

  const updateProjectList = useCallback(
    (field: keyof ProjectListDrafts, value: string) => {
      replaceWorkspace(workspaceId, (current) => ({
        ...current,
        project: {
          ...current.project,
          listDrafts: { ...current.project.listDrafts, [field]: value },
          status: current.project.persisted === null ? "loading" : "ready",
          dirty: true,
          errorCode: null,
          fieldError: null,
          conflict: null,
        },
      }))
    },
    [replaceWorkspace, workspaceId],
  )

  const updateCharacterList = useCallback(
    (value: string) => {
      replaceWorkspace(workspaceId, (current) => ({
        ...current,
        character: {
          ...current.character,
          listDrafts: { prohibitedExpressions: value },
          status: current.character.persisted === null ? "loading" : "ready",
          dirty: true,
          errorCode: null,
          fieldError: null,
          conflict: null,
        },
      }))
    },
    [replaceWorkspace, workspaceId],
  )

  const normalizeProjectList = useCallback(
    (field: keyof ProjectListDrafts) => {
      replaceWorkspace(workspaceId, (current) => {
        const items = normalizeContextListDraft(
          current.project.listDrafts[field],
        )
        return {
          ...current,
          project: {
            ...current.project,
            draft: { ...current.project.draft, [field]: items },
            listDrafts: {
              ...current.project.listDrafts,
              [field]: items.join("\n"),
            },
          },
        }
      })
    },
    [replaceWorkspace, workspaceId],
  )

  const normalizeCharacterList = useCallback(() => {
    replaceWorkspace(workspaceId, (current) => {
      const prohibitedExpressions = normalizeContextListDraft(
        current.character.listDrafts.prohibitedExpressions,
      )
      return {
        ...current,
        character: {
          ...current.character,
          draft: { ...current.character.draft, prohibitedExpressions },
          listDrafts: {
            prohibitedExpressions: prohibitedExpressions.join("\n"),
          },
        },
      }
    })
  }, [replaceWorkspace, workspaceId])

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
    const candidate = projectContextWithLists(current.draft, current.listDrafts)
    let context: ProjectContext
    try {
      context = parseProjectContext(candidate)
    } catch {
      const issue = projectContextValidationIssue(candidate)
      replaceWorkspace(workspaceId, (state) => ({
        ...state,
        project: {
          ...state.project,
          status: "error",
          errorCode: "WORKSPACE-PROJECT-CONTEXT-INVALID",
          fieldError:
            issue === null
              ? null
              : { field: issue.field, reason: issue.reason },
        },
      }))
      return false
    }
    replaceWorkspace(workspaceId, (state) => ({
      ...state,
      project: {
        ...state.project,
        status: "saving",
        errorCode: null,
        fieldError: null,
      },
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
          listDrafts: projectListDrafts(saved.context),
          status: "saved",
          dirty: false,
          errorCode: null,
          fieldError: null,
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
              fieldError: null,
              conflict: {
                localVersion: expectedVersion,
                remoteVersion: remote.project.version,
                changedFields: changedFields(candidate, remote.project.context),
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
        project: {
          ...state.project,
          status: "error",
          errorCode: code,
          fieldError: projectNativeFieldError(code),
        },
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
    const candidate = characterContextWithLists(
      current.draft,
      current.listDrafts,
    )
    let context: CharacterContext
    try {
      context = parseCharacterContext(candidate)
    } catch {
      const issue = characterContextValidationIssue(candidate)
      replaceWorkspace(workspaceId, (state) => ({
        ...state,
        character: {
          ...state.character,
          status: "error",
          errorCode: "WORKSPACE-CHARACTER-CONTEXT-INVALID",
          fieldError:
            issue === null
              ? null
              : { field: issue.field, reason: issue.reason },
        },
      }))
      return false
    }
    replaceWorkspace(workspaceId, (state) => ({
      ...state,
      character: {
        ...state.character,
        status: "saving",
        errorCode: null,
        fieldError: null,
      },
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
          listDrafts: characterListDrafts(saved.context),
          status: "saved",
          dirty: false,
          errorCode: null,
          fieldError: null,
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
              fieldError: null,
              conflict: {
                localVersion: expectedVersion,
                remoteVersion: remote.character.version,
                changedFields: changedFields(
                  candidate,
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
        character: {
          ...state.character,
          status: "error",
          errorCode: code,
          fieldError: characterNativeFieldError(code, candidate),
        },
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
              listDrafts: projectListDrafts(state.project.persisted.context),
              status: "ready",
              dirty: false,
              errorCode: null,
              fieldError: null,
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
              listDrafts: characterListDrafts(
                state.character.persisted.context,
              ),
              status: "ready",
              dirty: false,
              errorCode: null,
              fieldError: null,
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
      updateProjectList,
      updateCharacterList,
      normalizeProjectList,
      normalizeCharacterList,
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
      normalizeCharacterList,
      normalizeProjectList,
      saveCharacter,
      saveProject,
      updateCharacter,
      updateCharacterList,
      updateProject,
      updateProjectList,
      workspaceId,
    ],
  )
}
