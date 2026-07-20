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
  normalizeProjectContextForSave,
  parseCharacterContext,
  projectContextValidationIssue,
  type CharacterContext,
  type ProjectContext,
  type VersionedCharacterContext,
  type VersionedProjectContext,
  type WorkspaceContextValidationReason,
} from "@/lib/contracts/workspace-context"
import type { WorkspaceViewAdapter } from "@/features/workspace-view/types"

type SectionStatus =
  | "loading"
  | "ready"
  | "saving"
  | "saved"
  | "conflict"
  | "error"

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

interface SettingsContextState {
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

export interface EditableSettingsContextModel extends SettingsContextState {
  readonly projectId: string
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

const globalCharacterKey = "__app_character__"

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

function loadingState(): SettingsContextState {
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
  const suffix = code.replace(/^(?:WORKSPACE-)?PROJECT-CONTEXT-/u, "")
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
  const suffix = code.replace("APP-CHARACTER-CONTEXT-", "")
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

export function useEditableSettingsContext(
  adapter: WorkspaceViewAdapter | undefined,
  projectId: string,
): EditableSettingsContextModel {
  const workspaceId = projectId
  const [states, setStates] = useState<
    Readonly<Record<string, SettingsContextState>>
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
      update: (current: SettingsContextState) => SettingsContextState,
    ) => {
      setStates((current) => ({
        ...current,
        [id]: update(current[id] ?? loadingState()),
      }))
    },
    [],
  )

  const replaceCharacter = useCallback(
    (
      update: (
        current: SettingsContextState["character"],
      ) => SettingsContextState["character"],
    ) => {
      setStates((current) => {
        const global = current[globalCharacterKey] ?? loadingState()
        return {
          ...current,
          [globalCharacterKey]: {
            ...global,
            character: update(global.character),
          },
        }
      })
    },
    [],
  )

  const loadCharacter = useCallback(
    (force = false) => {
      const token = (loadGenerations.current.get(globalCharacterKey) ?? 0) + 1
      loadGenerations.current.set(globalCharacterKey, token)
      const cached = statesRef.current[globalCharacterKey]?.character
      if (!force && cached?.persisted !== null && cached !== undefined) return
      replaceCharacter((current) => ({ ...current, status: "loading" }))
      if (adapter?.loadCharacterContext === undefined) {
        replaceCharacter((current) => ({
          ...current,
          status: "error",
          errorCode: "APP-CHARACTER-CONTEXT-UNAVAILABLE",
          fieldError: null,
        }))
        return
      }
      void adapter.loadCharacterContext().then(
        (persisted) => {
          if (token !== loadGenerations.current.get(globalCharacterKey)) return
          replaceCharacter(() => ({
            persisted,
            draft: persisted.context,
            listDrafts: characterListDrafts(persisted.context),
            status: "ready",
            dirty: false,
            errorCode: null,
            fieldError: null,
            conflict: null,
          }))
        },
        (error: unknown) => {
          if (token !== loadGenerations.current.get(globalCharacterKey)) return
          replaceCharacter((current) => ({
            ...current,
            status: "error",
            errorCode: safeErrorCode(
              error,
              "APP-CHARACTER-CONTEXT-LOAD-FAILED",
            ),
            fieldError: null,
          }))
        },
      )
    },
    [adapter, replaceCharacter],
  )

  const load = useCallback(
    (id: string, force = false) => {
      const token = (loadGenerations.current.get(id) ?? 0) + 1
      loadGenerations.current.set(id, token)
      if (id === "__no_project__") return
      const cached = statesRef.current[id]
      if (!force && cached !== undefined && cached.project.persisted !== null) {
        return
      }
      replaceWorkspace(id, () => loadingState())
      if (adapter?.loadProjectContext === undefined) {
        replaceWorkspace(id, (current) => ({
          project: {
            ...current.project,
            status: "error",
            errorCode: "PROJECT-CONTEXT-UNAVAILABLE",
            fieldError: null,
          },
          character: current.character,
        }))
        return
      }
      void adapter.loadProjectContext(id).then(
        (persisted) => {
          if (
            token !== loadGenerations.current.get(id) ||
            persisted.projectId !== id
          ) {
            return
          }
          replaceWorkspace(id, () => ({
            project: {
              persisted,
              draft: persisted.context,
              listDrafts: projectListDrafts(persisted.context),
              status: "ready",
              dirty: false,
              errorCode: null,
              fieldError: null,
              conflict: null,
            },
            character: loadingState().character,
          }))
        },
        (error: unknown) => {
          if (token !== loadGenerations.current.get(id)) return
          const errorCode = safeErrorCode(error, "PROJECT-CONTEXT-LOAD-FAILED")
          replaceWorkspace(id, (current) => ({
            project: {
              ...current.project,
              status: "error",
              errorCode,
              fieldError: null,
            },
            character: current.character,
          }))
        },
      )
    },
    [adapter, replaceWorkspace],
  )

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) {
        loadCharacter()
        load(workspaceId)
      }
    })
    return () => {
      active = false
    }
  }, [load, loadCharacter, workspaceId])

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
      replaceCharacter((current) => ({
        ...current,
        draft: { ...current.draft, ...change },
        status: current.persisted === null ? "loading" : "ready",
        dirty: true,
        errorCode: null,
        fieldError: null,
        conflict: null,
      }))
    },
    [replaceCharacter],
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
      replaceCharacter((current) => ({
        ...current,
        listDrafts: { prohibitedExpressions: value },
        status: current.persisted === null ? "loading" : "ready",
        dirty: true,
        errorCode: null,
        fieldError: null,
        conflict: null,
      }))
    },
    [replaceCharacter],
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
    replaceCharacter((current) => {
      const prohibitedExpressions = normalizeContextListDraft(
        current.listDrafts.prohibitedExpressions,
      )
      return {
        ...current,
        draft: { ...current.draft, prohibitedExpressions },
        listDrafts: {
          prohibitedExpressions: prohibitedExpressions.join("\n"),
        },
      }
    })
  }, [replaceCharacter])

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
      context = normalizeProjectContextForSave(candidate)
    } catch {
      const issue = projectContextValidationIssue(candidate)
      replaceWorkspace(workspaceId, (state) => ({
        ...state,
        project: {
          ...state.project,
          status: "error",
          errorCode: "PROJECT-CONTEXT-INVALID",
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
        saved.projectId !== workspaceId
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
      const code = safeErrorCode(error, "PROJECT-CONTEXT-SAVE-FAILED")
      if (
        (code === "PROJECT-CONTEXT-CONFLICT" ||
          code === "WORKSPACE-PROJECT-CONTEXT-CONFLICT") &&
        adapter.loadProjectContext !== undefined
      ) {
        try {
          const remote = await adapter.loadProjectContext(workspaceId)
          if (
            token !== projectSaveGenerations.current.get(workspaceId) ||
            remote.projectId !== workspaceId
          ) {
            return false
          }
          replaceWorkspace(workspaceId, (state) => ({
            ...state,
            project: {
              ...state.project,
              persisted: remote,
              status: "conflict",
              errorCode: code,
              fieldError: null,
              conflict: {
                localVersion: expectedVersion,
                remoteVersion: remote.version,
                changedFields: changedFields(candidate, remote.context),
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
    const current = statesRef.current[globalCharacterKey]?.character
    if (
      current?.persisted === null ||
      current === undefined ||
      adapter?.saveCharacterContext === undefined
    ) {
      return false
    }
    const expectedVersion = current.persisted.version
    const token =
      (characterSaveGenerations.current.get(globalCharacterKey) ?? 0) + 1
    characterSaveGenerations.current.set(globalCharacterKey, token)
    const candidate = characterContextWithLists(
      current.draft,
      current.listDrafts,
    )
    let context: CharacterContext
    try {
      context = parseCharacterContext(candidate)
    } catch {
      const issue = characterContextValidationIssue(candidate)
      replaceCharacter((state) => ({
        ...state,
        status: "error",
        errorCode: "APP-CHARACTER-CONTEXT-INVALID",
        fieldError:
          issue === null ? null : { field: issue.field, reason: issue.reason },
      }))
      return false
    }
    replaceCharacter((state) => ({
      ...state,
      status: "saving",
      errorCode: null,
      fieldError: null,
    }))
    try {
      const saved = await adapter.saveCharacterContext(expectedVersion, context)
      if (token !== characterSaveGenerations.current.get(globalCharacterKey)) {
        return false
      }
      replaceCharacter(() => ({
        persisted: saved,
        draft: saved.context,
        listDrafts: characterListDrafts(saved.context),
        status: "saved",
        dirty: false,
        errorCode: null,
        fieldError: null,
        conflict: null,
      }))
      return true
    } catch (error) {
      if (token !== characterSaveGenerations.current.get(globalCharacterKey)) {
        return false
      }
      const code = safeErrorCode(error, "APP-CHARACTER-CONTEXT-SAVE-FAILED")
      if (
        code === "APP-CHARACTER-CONTEXT-CONFLICT" &&
        adapter.loadCharacterContext !== undefined
      ) {
        try {
          const remote = await adapter.loadCharacterContext()
          if (
            token !== characterSaveGenerations.current.get(globalCharacterKey)
          ) {
            return false
          }
          replaceCharacter((state) => ({
            ...state,
            persisted: remote,
            status: "conflict",
            errorCode: code,
            fieldError: null,
            conflict: {
              localVersion: expectedVersion,
              remoteVersion: remote.version,
              changedFields: changedFields(candidate, remote.context),
            },
          }))
          return false
        } catch {
          // Fall through to the safe conflict code while preserving the draft.
        }
      }
      replaceCharacter((state) => ({
        ...state,
        status: "error",
        errorCode: code,
        fieldError: characterNativeFieldError(code, candidate),
      }))
      return false
    }
  }, [adapter, replaceCharacter])

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
    replaceCharacter((state) =>
      state.persisted === null
        ? state
        : {
            persisted: state.persisted,
            draft: state.persisted.context,
            listDrafts: characterListDrafts(state.persisted.context),
            status: "ready",
            dirty: false,
            errorCode: null,
            fieldError: null,
            conflict: null,
          },
    )
  }, [replaceCharacter])

  const project = states[workspaceId] ?? loadingState()
  const globalCharacter =
    states[globalCharacterKey]?.character ?? loadingState().character
  const current = useMemo(
    () => ({ project: project.project, character: globalCharacter }),
    [project.project, globalCharacter],
  )
  return useMemo(
    () => ({
      projectId,
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
      retryLoad: () => {
        load(workspaceId, true)
        loadCharacter(true)
      },
    }),
    [
      current,
      discardCharacter,
      discardProject,
      load,
      loadCharacter,
      normalizeCharacterList,
      normalizeProjectList,
      saveCharacter,
      saveProject,
      updateCharacter,
      updateCharacterList,
      updateProject,
      updateProjectList,
      workspaceId,
      projectId,
    ],
  )
}
