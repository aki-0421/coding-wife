import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { initialWorkspaces } from "@/features/workspace-view/demo-data"
import type {
  AttachmentItem,
  ContextSnapshotItem,
  ReasoningEffort,
  SendTurnRequest,
  SettingsSection,
  WorkspaceAdapterState,
  WorkspaceDraft,
  WorkspaceRecord,
  WorkspaceTab,
  WorkspaceTimelineItem,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"

const emptyDraft: WorkspaceDraft = {
  text: "",
  effort: "fast",
  attachments: [],
  contextSnapshots: [],
}

interface PendingDraftSave {
  readonly text: string
  readonly effort: ReasoningEffort
}

function draftFor(
  drafts: Readonly<Record<string, WorkspaceDraft>>,
  workspaceId: string,
): WorkspaceDraft {
  return drafts[workspaceId] ?? emptyDraft
}

export type TurnUiState = "idle" | "sending" | "running" | "stopping"

export interface WorkspaceViewNotice {
  readonly tone: "neutral" | "error"
  readonly message: string
}

export function useWorkspaceViewModel(adapter?: WorkspaceViewAdapter) {
  const [workspaces, setWorkspaces] =
    useState<readonly WorkspaceRecord[]>(initialWorkspaces)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(
    "build-live2d-desktop-app",
  )
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("chat")
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general")
  const [filter, setFilter] = useState("")
  const [drafts, setDrafts] = useState<
    Readonly<Record<string, WorkspaceDraft>>
  >({})
  const [turnState, setTurnState] = useState<TurnUiState>("idle")
  const [notice, setNotice] = useState<WorkspaceViewNotice | null>(null)
  const [adapterReady, setAdapterReady] = useState(!adapter?.loadState)
  const [timeline, setTimeline] = useState<readonly WorkspaceTimelineItem[]>([])
  const [history, setHistory] = useState<WorkspaceAdapterState["history"]>({
    mode: "ready",
    errorCode: null,
    backupName: null,
  })
  const [muted, setMuted] = useState(false)
  const [characterHidden, setCharacterHidden] = useState(false)
  const [reducedMotion, setReducedMotion] = useState<
    "system" | "reduce" | "allow"
  >("system")
  const selectionVersion = useRef(0)
  const pendingDraftSaves = useRef(new Map<string, PendingDraftSave>())
  const draftSaveTimers = useRef(new Map<string, number>())

  const applyAdapterState = useCallback((state: WorkspaceAdapterState) => {
    setWorkspaces(state.workspaces)
    setTimeline(state.timeline)
    setHistory(state.history)
    if (state.activeWorkspaceId === null) {
      setSelectedWorkspaceId("")
      return
    }
    const activeWorkspaceId = state.activeWorkspaceId
    setSelectedWorkspaceId(activeWorkspaceId)
    if (state.draft !== null) {
      const adapterDraft = state.draft
      const pendingDraft = pendingDraftSaves.current.get(activeWorkspaceId)
      setDrafts((current) => {
        const existing = draftFor(current, activeWorkspaceId)
        return {
          ...current,
          [activeWorkspaceId]: {
            text: pendingDraft?.text ?? adapterDraft.text,
            effort: pendingDraft?.effort ?? adapterDraft.effort,
            attachments: existing.attachments,
            contextSnapshots: adapterDraft.contextSnapshots,
          },
        }
      })
    }
  }, [])

  useEffect(() => {
    if (!adapter?.loadState) return
    let current = true
    void adapter
      .loadState()
      .then((state) => {
        if (current) {
          applyAdapterState(state)
          setAdapterReady(true)
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setNotice({
            tone: "error",
            message:
              error instanceof Error ? error.message : "WORKSPACE-LOAD-FAILED",
          })
        }
      })
    return () => {
      current = false
    }
  }, [adapter, applyAdapterState])

  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
    workspaces[0]
  const selectedDraft = selectedWorkspace
    ? draftFor(drafts, selectedWorkspace.id)
    : emptyDraft

  const filteredWorkspaces = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    if (query.length === 0) {
      return workspaces
    }

    return workspaces.filter((workspace) =>
      [workspace.repository, workspace.name, workspace.branch].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    )
  }, [filter, workspaces])

  const updateDraft = useCallback(
    (
      workspaceId: string,
      update: (current: WorkspaceDraft) => WorkspaceDraft,
    ) => {
      setDrafts((current) => ({
        ...current,
        [workspaceId]: update(draftFor(current, workspaceId)),
      }))
    },
    [],
  )

  const persistPendingDraft = useCallback(
    (workspaceId: string) => {
      const pending = pendingDraftSaves.current.get(workspaceId)
      if (pending === undefined || !adapter?.saveDraft) return
      void adapter
        .saveDraft(workspaceId, pending.text, pending.effort)
        .then(() => {
          if (pendingDraftSaves.current.get(workspaceId) === pending) {
            pendingDraftSaves.current.delete(workspaceId)
          }
        })
        .catch((error: unknown) => {
          setNotice({
            tone: "error",
            message:
              error instanceof Error
                ? error.message
                : "WORKSPACE-DRAFT-SAVE-FAILED",
          })
        })
    },
    [adapter],
  )

  const scheduleDraftSave = useCallback(
    (workspaceId: string, text: string, effort: ReasoningEffort) => {
      pendingDraftSaves.current.set(workspaceId, { text, effort })
      const existingTimer = draftSaveTimers.current.get(workspaceId)
      if (existingTimer !== undefined) window.clearTimeout(existingTimer)
      if (!adapterReady || !adapter?.saveDraft) return
      const timer = window.setTimeout(() => {
        draftSaveTimers.current.delete(workspaceId)
        persistPendingDraft(workspaceId)
      }, 250)
      draftSaveTimers.current.set(workspaceId, timer)
    },
    [adapter, adapterReady, persistPendingDraft],
  )

  useEffect(() => {
    if (!adapterReady || !adapter?.saveDraft) return
    for (const [workspaceId, pending] of pendingDraftSaves.current) {
      scheduleDraftSave(workspaceId, pending.text, pending.effort)
    }
  }, [adapter, adapterReady, scheduleDraftSave])

  useEffect(() => {
    const timers = draftSaveTimers.current
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const setDraftText = useCallback(
    (text: string) => {
      if (!selectedWorkspace) return
      updateDraft(selectedWorkspace.id, (current) => ({ ...current, text }))
      scheduleDraftSave(selectedWorkspace.id, text, selectedDraft.effort)
    },
    [scheduleDraftSave, selectedDraft.effort, selectedWorkspace, updateDraft],
  )

  const setEffort = useCallback(
    (effort: ReasoningEffort) => {
      if (!selectedWorkspace) return
      updateDraft(selectedWorkspace.id, (current) => ({ ...current, effort }))
      scheduleDraftSave(selectedWorkspace.id, selectedDraft.text, effort)
    },
    [scheduleDraftSave, selectedDraft.text, selectedWorkspace, updateDraft],
  )

  const addAttachments = useCallback(
    (files: readonly File[]) => {
      if (!selectedWorkspace) return
      const additions: readonly AttachmentItem[] = files
        .slice(0, 10)
        .map((file, index) => ({
          id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
          name: file.name,
          size: file.size,
          valid: file.size <= 25 * 1024 * 1024,
        }))

      updateDraft(selectedWorkspace.id, (current) => ({
        ...current,
        attachments: [...current.attachments, ...additions].slice(0, 10),
      }))
    },
    [selectedWorkspace, updateDraft],
  )

  const removeAttachment = useCallback(
    (attachmentId: string) => {
      if (!selectedWorkspace) return
      updateDraft(selectedWorkspace.id, (current) => ({
        ...current,
        attachments: current.attachments.filter(
          (attachment) => attachment.id !== attachmentId,
        ),
      }))
    },
    [selectedWorkspace, updateDraft],
  )

  const captureContext = useCallback(
    async (source: ContextSnapshotItem["source"], unavailableCopy: string) => {
      if (!selectedWorkspace) return
      if (!adapter?.captureContext) {
        setNotice({ tone: "neutral", message: unavailableCopy })
        return
      }

      try {
        const snapshot = await adapter.captureContext(
          selectedWorkspace.id,
          source,
        )
        updateDraft(selectedWorkspace.id, (current) => ({
          ...current,
          contextSnapshots: [...current.contextSnapshots, snapshot].slice(
            0,
            10,
          ),
        }))
        setNotice(null)
      } catch {
        setNotice({ tone: "error", message: unavailableCopy })
      }
    },
    [adapter, selectedWorkspace, updateDraft],
  )

  const removeContext = useCallback(
    (snapshotId: string) => {
      if (!selectedWorkspace) return
      updateDraft(selectedWorkspace.id, (current) => ({
        ...current,
        contextSnapshots: current.contextSnapshots.filter(
          (snapshot) => snapshot.id !== snapshotId,
        ),
      }))
    },
    [selectedWorkspace, updateDraft],
  )

  const sendTurn = useCallback(async () => {
    if (!selectedWorkspace || !adapter?.sendTurn) return false
    const draft = draftFor(drafts, selectedWorkspace.id)
    const request: SendTurnRequest = {
      workspaceId: selectedWorkspace.id,
      instruction: draft.text,
      effort: draft.effort,
      attachments: draft.attachments,
      contextSnapshots: draft.contextSnapshots,
    }

    setTurnState("sending")
    try {
      const result = await adapter.sendTurn(request)
      if (!result.accepted) {
        setTurnState("idle")
        return false
      }

      updateDraft(selectedWorkspace.id, (current) => ({
        ...current,
        text: "",
        attachments: [],
        contextSnapshots: [],
      }))
      scheduleDraftSave(selectedWorkspace.id, "", draft.effort)
      setTurnState("running")
      setNotice(null)
      return true
    } catch {
      setTurnState("idle")
      return false
    }
  }, [adapter, drafts, scheduleDraftSave, selectedWorkspace, updateDraft])

  const stopTurn = useCallback(async () => {
    if (!selectedWorkspace || !adapter?.stopTurn || turnState !== "running") {
      return
    }

    setTurnState("stopping")
    try {
      await adapter.stopTurn(selectedWorkspace.id)
    } finally {
      setTurnState("idle")
    }
  }, [adapter, selectedWorkspace, turnState])

  const addWorkspace = useCallback(
    async (name: string, goal: string) => {
      const trimmedName = name.trim()
      if (trimmedName.length === 0) return false
      if (adapter?.requestAddWorkspace && selectedWorkspace) {
        try {
          const state = await adapter.requestAddWorkspace({
            fromWorkspaceId: selectedWorkspace.id,
            name: trimmedName,
            goal: goal.trim(),
            repository: selectedWorkspace.repository,
            branch: selectedWorkspace.branch,
          })
          if (state !== undefined) {
            applyAdapterState(state)
            setActiveTab("chat")
            setNotice(null)
            return true
          }
        } catch (error) {
          setNotice({
            tone: "error",
            message:
              error instanceof Error
                ? error.message
                : "WORKSPACE-CREATE-FAILED",
          })
          return false
        }
      }
      const record: WorkspaceRecord = {
        id: `local-${Date.now()}`,
        repository: selectedWorkspace?.repository ?? "local-project",
        name: trimmedName,
        branch: selectedWorkspace?.branch ?? "main",
        lifecycle: "backlog",
      }
      setWorkspaces((current) => [...current, record])
      setSelectedWorkspaceId(record.id)
      setActiveTab("chat")
      setDrafts((current) => ({
        ...current,
        [record.id]: { ...emptyDraft, text: goal.trim() },
      }))
      return true
    },
    [adapter, applyAdapterState, selectedWorkspace],
  )

  const requestAddProject = useCallback(
    async (unavailableCopy: string) => {
      if (!adapter?.requestAddProject) {
        setNotice({ tone: "neutral", message: unavailableCopy })
        return
      }
      try {
        const state = await adapter.requestAddProject()
        if (state !== undefined) applyAdapterState(state)
        setNotice(null)
      } catch (error) {
        setNotice({
          tone: "error",
          message: error instanceof Error ? error.message : unavailableCopy,
        })
      }
    },
    [adapter, applyAdapterState],
  )

  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      selectionVersion.current += 1
      const version = selectionVersion.current
      const previousWorkspaceId = selectedWorkspaceId
      setSelectedWorkspaceId(workspaceId)
      if (!adapter?.selectWorkspace) return
      void adapter
        .selectWorkspace(workspaceId)
        .then((state) => {
          if (selectionVersion.current === version) applyAdapterState(state)
        })
        .catch((error: unknown) => {
          if (selectionVersion.current === version) {
            setSelectedWorkspaceId(previousWorkspaceId)
            setNotice({
              tone: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "WORKSPACE-SELECT-FAILED",
            })
          }
        })
    },
    [adapter, applyAdapterState, selectedWorkspaceId],
  )

  const deleteSelectedWorkspaceHistory = useCallback(async () => {
    if (!selectedWorkspace || !adapter?.deleteWorkspaceHistory) return false
    try {
      const workspaceId = selectedWorkspace.id
      applyAdapterState(await adapter.deleteWorkspaceHistory(workspaceId))
      pendingDraftSaves.current.delete(workspaceId)
      const timer = draftSaveTimers.current.get(workspaceId)
      if (timer !== undefined) window.clearTimeout(timer)
      draftSaveTimers.current.delete(workspaceId)
      setNotice(null)
      return true
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error ? error.message : "WORKSPACE-DELETE-FAILED",
      })
      return false
    }
  }, [adapter, applyAdapterState, selectedWorkspace])

  const resetUiState = useCallback(() => {
    setFilter("")
    setActiveTab("chat")
    setSettingsSection("general")
    setNotice(null)
  }, [])

  return {
    activeTab,
    adapter,
    addAttachments,
    addWorkspace,
    captureContext,
    characterHidden,
    deleteSelectedWorkspaceHistory,
    filteredWorkspaces,
    filter,
    muted,
    notice,
    history,
    reducedMotion,
    removeAttachment,
    removeContext,
    requestAddProject,
    resetUiState,
    selectedDraft,
    selectedWorkspace,
    selectedWorkspaceId,
    sendTurn,
    setActiveTab,
    setCharacterHidden,
    setDraftText,
    setEffort,
    setFilter,
    setMuted,
    setNotice,
    setReducedMotion,
    setSelectedWorkspaceId: selectWorkspace,
    setSettingsSection,
    settingsSection,
    stopTurn,
    timeline,
    turnState,
    workspaces,
  }
}
