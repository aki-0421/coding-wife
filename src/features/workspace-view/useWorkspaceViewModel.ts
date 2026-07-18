import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type {
  ApprovalDecision,
  AttachmentRegistrationResponse,
  PendingRequestView,
} from "@/lib/contracts"

import { initialWorkspaces } from "@/features/workspace-view/demo-data"
import type {
  AttachmentItem,
  ContextSnapshotItem,
  ReasoningEffort,
  SendTurnRequest,
  SettingsSection,
  WorkspaceAdapterState,
  WorkspaceCodexState,
  WorkspaceDraft,
  WorkspaceRecord,
  WorkspaceTab,
  WorkspaceTimelineItem,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"
import type { WorkspaceTurnContextSnapshot } from "@/lib/contracts/workspace-context"

const emptyDraft: WorkspaceDraft = {
  text: "",
  effort: "fast",
  attachments: [],
  contextSnapshots: [],
}

const defaultProjectHash =
  "e0da727f2381a1c290ddcb74bdb52b44b0ec890559443d795f29731d68fe1323"
const defaultCharacterHash =
  "0ab87e72a74abd7bebaaf2b5c4e568e6e3e4bae7e21febca76a6b079f6d33c8c"

function fallbackContextSnapshot(
  workspaceId: string,
): WorkspaceTurnContextSnapshot {
  return {
    schemaVersion: 1,
    workspaceId,
    projectVersion: 1,
    projectHash: defaultProjectHash,
    characterVersion: 1,
    characterHash: defaultCharacterHash,
    snapshotHash:
      "c84d287d3d716df45e08d627bb15ed4b94e27a9eebc257d635c889cfd6ac7365",
    capturedAt: new Date(0).toISOString(),
    project: {
      goal: "",
      constraints: "",
      definitionOfDone: [],
      technicalReferences: [],
      userNotes: "",
    },
    character: {
      displayName: "Sol",
      tone: "neutral",
      toneNotes: "",
      speechDensity: "key_events",
      behavior: "",
      prohibitedExpressions: [],
    },
  }
}

const disconnectedCodexState: WorkspaceCodexState = {
  activeWorkspaceId: null,
  generation: null,
  phase: "idle",
  connected: false,
  readiness: {
    ready: false,
    fastAvailable: false,
    maxAvailable: false,
    reasonCode: "CODEX-NOT-CONNECTED",
  },
  pendingRequests: [],
  timeline: [],
  errorCode: null,
}

function initialCodexState(
  adapter?: WorkspaceViewAdapter,
): WorkspaceCodexState {
  const snapshot = adapter?.codexSnapshot?.()
  if (snapshot !== undefined) return snapshot
  if (adapter?.connected !== true) return disconnectedCodexState
  return {
    ...disconnectedCodexState,
    phase: "ready",
    connected: true,
    readiness: {
      ready: true,
      fastAvailable: true,
      maxAvailable: true,
      reasonCode: null,
    },
  }
}

function attachmentItems(
  response: AttachmentRegistrationResponse,
): readonly AttachmentItem[] {
  return response.items.map((item) => ({
    id: item.handle,
    name: item.name,
    size: item.sizeBytes,
    valid: true,
    relativePath: item.relativePath,
    kind: item.kind,
    source: item.source,
    expiresAt: item.expiresAt,
  }))
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
export type WorkspaceAdapterStatus = "loading" | "ready" | "error"
export type WorkspaceAction = "cancel" | "repair" | "unregister"

export type WorkspaceActionResult =
  { readonly ok: true } | { readonly ok: false; readonly errorCode: string }

export interface WorkspaceViewNotice {
  readonly tone: "neutral" | "error"
  readonly message: string
}

export function useWorkspaceViewModel(adapter?: WorkspaceViewAdapter) {
  const nativeHydration =
    adapter?.loadState !== undefined && adapter.hydrationMode !== "demo"
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceRecord[]>(
    () => (nativeHydration ? [] : initialWorkspaces),
  )
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(() =>
    nativeHydration ? "" : "build-live2d-desktop-app",
  )
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("chat")
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general")
  const [filter, setFilter] = useState("")
  const [drafts, setDrafts] = useState<
    Readonly<Record<string, WorkspaceDraft>>
  >({})
  const [turnState, setTurnState] = useState<TurnUiState>("idle")
  const [codex, setCodex] = useState<WorkspaceCodexState>(() =>
    initialCodexState(adapter),
  )
  const [notice, setNotice] = useState<WorkspaceViewNotice | null>(null)
  const [adapterStatus, setAdapterStatus] = useState<WorkspaceAdapterStatus>(
    nativeHydration ? "loading" : "ready",
  )
  const [adapterLoadAttempt, setAdapterLoadAttempt] = useState(0)
  const [workspaceAction, setWorkspaceAction] =
    useState<WorkspaceAction | null>(null)
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
  const deletingWorkspaceIds = useRef(new Set<string>())

  useEffect(() => {
    if (adapter?.subscribeCodex === undefined) return
    return adapter.subscribeCodex((snapshot) => {
      setCodex(snapshot)
      setTurnState((current) => {
        if (snapshot.phase === "running" || snapshot.phase === "waiting") {
          return "running"
        }
        if (snapshot.phase === "stopping") return "stopping"
        return current === "sending" ? current : "idle"
      })
    })
  }, [adapter])

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
    if (nativeHydration) {
      queueMicrotask(() => {
        if (!current) return
        setAdapterStatus("loading")
        setWorkspaces([])
        setSelectedWorkspaceId("")
        setDrafts({})
        setTimeline([])
        setNotice(null)
      })
    }
    void adapter
      .loadState()
      .then((state) => {
        if (current) {
          applyAdapterState(state)
          setAdapterStatus("ready")
        }
      })
      .catch(() => {
        if (current) {
          if (nativeHydration) {
            setWorkspaces([])
            setSelectedWorkspaceId("")
            setAdapterStatus("error")
          } else {
            setNotice({ tone: "error", message: "WORKSPACE-LOAD-FAILED" })
          }
        }
      })
    return () => {
      current = false
    }
  }, [adapter, adapterLoadAttempt, applyAdapterState, nativeHydration])

  const retryAdapterLoad = useCallback(() => {
    if (adapter?.loadState) setAdapterLoadAttempt((attempt) => attempt + 1)
  }, [adapter])

  const adapterReady = adapterStatus === "ready"

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

  const combinedTimeline = useMemo(() => {
    const timelineKey = (event: WorkspaceTimelineItem) =>
      event.kind === "history"
        ? `history:${event.id}`
        : `semantic:${event.stableId}`
    const events = new Map(
      timeline.map((event) => [timelineKey(event), event] as const),
    )
    for (const event of codex.timeline) events.set(timelineKey(event), event)
    return [...events.values()].sort((left, right) => {
      const timestamp =
        Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
      if (timestamp !== 0) return timestamp
      const leftSequence =
        left.kind === "history" ? left.sequence : left.sourceSequence
      const rightSequence =
        right.kind === "history" ? right.sequence : right.sourceSequence
      return leftSequence - rightSequence
    })
  }, [codex.timeline, timeline])

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
          if (deletingWorkspaceIds.current.has(workspaceId)) return
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
      if (!adapterReady || !selectedWorkspace) return
      updateDraft(selectedWorkspace.id, (current) => ({ ...current, text }))
      scheduleDraftSave(selectedWorkspace.id, text, selectedDraft.effort)
    },
    [
      adapterReady,
      scheduleDraftSave,
      selectedDraft.effort,
      selectedWorkspace,
      updateDraft,
    ],
  )

  const setEffort = useCallback(
    (effort: ReasoningEffort) => {
      if (!adapterReady || !selectedWorkspace) return
      updateDraft(selectedWorkspace.id, (current) => ({ ...current, effort }))
      scheduleDraftSave(selectedWorkspace.id, selectedDraft.text, effort)
    },
    [
      adapterReady,
      scheduleDraftSave,
      selectedDraft.text,
      selectedWorkspace,
      updateDraft,
    ],
  )

  const addAttachmentFiles = useCallback(
    (files: readonly File[]) => {
      if (!adapterReady || !selectedWorkspace) return
      const additions: readonly AttachmentItem[] = files
        .slice(0, 10)
        .map((file, index) => ({
          id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
          name: file.name,
          size: file.size,
          valid: file.size <= 25 * 1024 * 1024,
          relativePath: file.name,
          kind: file.type.startsWith("image/")
            ? ("image" as const)
            : ("file" as const),
          source: "drop" as const,
          expiresAt: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
        }))

      updateDraft(selectedWorkspace.id, (current) => ({
        ...current,
        attachments: [...current.attachments, ...additions].slice(0, 10),
      }))
    },
    [adapterReady, selectedWorkspace, updateDraft],
  )

  const applyAttachmentRegistration = useCallback(
    (workspaceId: string, response: AttachmentRegistrationResponse) => {
      const additions = attachmentItems(response)
      updateDraft(workspaceId, (current) => {
        const byHandle = new Map(
          current.attachments.map((attachment) => [attachment.id, attachment]),
        )
        for (const attachment of additions)
          byHandle.set(attachment.id, attachment)
        return {
          ...current,
          attachments: [...byHandle.values()].slice(0, 10),
        }
      })
      const rejection = response.rejections[0]
      setNotice(
        rejection === undefined
          ? null
          : { tone: "error", message: rejection.code },
      )
    },
    [updateDraft],
  )

  const pickAttachments = useCallback(async () => {
    if (!adapterReady || !selectedWorkspace) return
    if (adapter?.pickAttachments === undefined) return
    const workspaceId = selectedWorkspace.id
    try {
      const response = await adapter.pickAttachments(
        workspaceId,
        selectedDraft.attachments.map((attachment) => attachment.id),
      )
      applyAttachmentRegistration(workspaceId, response)
    } catch {
      setNotice({ tone: "error", message: "CODEX-ATTACHMENT-PICK-FAILED" })
    }
  }, [
    adapter,
    adapterReady,
    applyAttachmentRegistration,
    selectedDraft.attachments,
    selectedWorkspace,
  ])

  const registerAttachmentPaths = useCallback(
    async (source: "drop" | "paste", paths: readonly string[]) => {
      if (!adapterReady || !selectedWorkspace || paths.length === 0) return
      if (adapter?.registerAttachmentPaths === undefined) return
      const workspaceId = selectedWorkspace.id
      try {
        const response = await adapter.registerAttachmentPaths(
          workspaceId,
          source,
          paths,
          selectedDraft.attachments.map((attachment) => attachment.id),
        )
        applyAttachmentRegistration(workspaceId, response)
      } catch {
        setNotice({
          tone: "error",
          message: "CODEX-ATTACHMENT-REGISTER-FAILED",
        })
      }
    },
    [
      adapter,
      adapterReady,
      applyAttachmentRegistration,
      selectedDraft.attachments,
      selectedWorkspace,
    ],
  )

  const removeAttachment = useCallback(
    (attachmentId: string) => {
      if (!adapterReady || !selectedWorkspace) return
      updateDraft(selectedWorkspace.id, (current) => ({
        ...current,
        attachments: current.attachments.filter(
          (attachment) => attachment.id !== attachmentId,
        ),
      }))
    },
    [adapterReady, selectedWorkspace, updateDraft],
  )

  const captureContext = useCallback(
    async (source: ContextSnapshotItem["source"], unavailableCopy: string) => {
      if (!adapterReady || !selectedWorkspace) return
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
          contextSnapshots: [...current.contextSnapshots, snapshot].slice(-10),
        }))
        setNotice(null)
      } catch {
        setNotice({ tone: "error", message: unavailableCopy })
      }
    },
    [adapter, adapterReady, selectedWorkspace, updateDraft],
  )

  const removeContext = useCallback(
    (snapshotId: string) => {
      if (!adapterReady || !selectedWorkspace) return
      updateDraft(selectedWorkspace.id, (current) => ({
        ...current,
        contextSnapshots: current.contextSnapshots.filter(
          (snapshot) => snapshot.id !== snapshotId,
        ),
      }))
    },
    [adapterReady, selectedWorkspace, updateDraft],
  )

  const sendTurn = useCallback(async () => {
    if (!adapterReady || !selectedWorkspace || !adapter?.sendTurn) return false
    const draft = draftFor(drafts, selectedWorkspace.id)

    setTurnState("sending")
    try {
      const editableContextSnapshot =
        adapter.getTurnContextSnapshot === undefined
          ? adapter.hydrationMode === "native"
            ? null
            : fallbackContextSnapshot(selectedWorkspace.id)
          : await adapter.getTurnContextSnapshot(selectedWorkspace.id)
      if (
        editableContextSnapshot === null ||
        editableContextSnapshot.workspaceId !== selectedWorkspace.id
      ) {
        setTurnState("idle")
        return false
      }
      const request: SendTurnRequest = {
        workspaceId: selectedWorkspace.id,
        instruction: draft.text,
        effort: draft.effort,
        attachments: draft.attachments,
        contextSnapshots: draft.contextSnapshots,
        editableContextSnapshot,
      }
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
  }, [
    adapter,
    adapterReady,
    drafts,
    scheduleDraftSave,
    selectedWorkspace,
    updateDraft,
  ])

  const stopTurn = useCallback(async () => {
    if (
      !adapterReady ||
      !selectedWorkspace ||
      !adapter?.stopTurn ||
      turnState !== "running"
    ) {
      return false
    }

    setTurnState("stopping")
    try {
      await adapter.stopTurn(selectedWorkspace.id)
      return true
    } catch {
      setTurnState("idle")
      setNotice({ tone: "error", message: "CODEX-INTERRUPT-FAILED" })
      return false
    }
  }, [adapter, adapterReady, selectedWorkspace, turnState])

  const answerDecision = useCallback(
    async (
      request: PendingRequestView,
      answers: Readonly<Record<string, readonly string[]>>,
    ) => {
      if (!selectedWorkspace || request.kind !== "user_input") return false
      try {
        const accepted =
          request.responseKind === "fallback_decision"
            ? await adapter?.answerFallbackDecision?.({
                workspaceId: selectedWorkspace.id,
                decisionHandle: request.pendingId,
                optionId: answers[request.questions[0].id]?.[0] ?? "",
              })
            : await adapter?.respondPending?.({
                workspaceId: selectedWorkspace.id,
                pendingId: request.pendingId,
                response: { type: "user_input", answers },
              })
        if (accepted !== true) {
          setNotice({
            tone: "error",
            message: "CODEX-DECISION-RESPONSE-REJECTED",
          })
          return false
        }
        setNotice(null)
        return true
      } catch {
        setNotice({ tone: "error", message: "CODEX-DECISION-RESPONSE-FAILED" })
        return false
      }
    },
    [adapter, selectedWorkspace],
  )

  const answerApproval = useCallback(
    async (request: PendingRequestView, decision: ApprovalDecision) => {
      if (!selectedWorkspace || request.kind === "user_input") return false
      try {
        const accepted = await adapter?.respondPending?.({
          workspaceId: selectedWorkspace.id,
          pendingId: request.pendingId,
          response: { type: "approval", decision },
        })
        if (accepted !== true) {
          setNotice({
            tone: "error",
            message: "CODEX-APPROVAL-RESPONSE-REJECTED",
          })
          return false
        }
        setNotice(null)
        return true
      } catch {
        setNotice({ tone: "error", message: "CODEX-APPROVAL-RESPONSE-FAILED" })
        return false
      }
    },
    [adapter, selectedWorkspace],
  )

  const addWorkspace = useCallback(
    async (name: string, goal: string) => {
      const trimmedName = name.trim()
      if (!adapterReady || trimmedName.length === 0) return false
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
    [adapter, adapterReady, applyAdapterState, selectedWorkspace],
  )

  const requestAddProject = useCallback(
    async (unavailableCopy: string) => {
      if (!adapterReady) return
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
    [adapter, adapterReady, applyAdapterState],
  )

  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      if (!adapterReady) return
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
    [adapter, adapterReady, applyAdapterState, selectedWorkspaceId],
  )

  const cancelSelectedWorkspace =
    useCallback(async (): Promise<WorkspaceActionResult> => {
      if (
        !adapterReady ||
        !selectedWorkspace?.updatedAt ||
        !adapter?.cancelWorkspace
      ) {
        return { ok: false, errorCode: "WORKSPACE-CANCEL-UNAVAILABLE" }
      }
      setWorkspaceAction("cancel")
      try {
        applyAdapterState(
          await adapter.cancelWorkspace(
            selectedWorkspace.id,
            selectedWorkspace.updatedAt,
          ),
        )
        setNotice(null)
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          errorCode:
            error instanceof Error ? error.message : "WORKSPACE-CANCEL-FAILED",
        }
      } finally {
        setWorkspaceAction(null)
      }
    }, [adapter, adapterReady, applyAdapterState, selectedWorkspace])

  const repairSelectedWorkspace =
    useCallback(async (): Promise<WorkspaceActionResult> => {
      if (!adapterReady || !selectedWorkspace || !adapter?.repairWorkspace) {
        return { ok: false, errorCode: "WORKSPACE-REPAIR-UNAVAILABLE" }
      }
      setWorkspaceAction("repair")
      try {
        applyAdapterState(await adapter.repairWorkspace(selectedWorkspace.id))
        setNotice(null)
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          errorCode:
            error instanceof Error ? error.message : "WORKSPACE-REPAIR-FAILED",
        }
      } finally {
        setWorkspaceAction(null)
      }
    }, [adapter, adapterReady, applyAdapterState, selectedWorkspace])

  const unregisterSelectedWorkspace =
    useCallback(async (): Promise<WorkspaceActionResult> => {
      if (
        !adapterReady ||
        !selectedWorkspace ||
        !adapter?.unregisterWorkspace
      ) {
        return { ok: false, errorCode: "WORKSPACE-UNREGISTER-UNAVAILABLE" }
      }
      const workspaceId = selectedWorkspace.id
      setWorkspaceAction("unregister")
      try {
        const pending = pendingDraftSaves.current.get(workspaceId)
        if (pending !== undefined && adapter.saveDraft !== undefined) {
          const timer = draftSaveTimers.current.get(workspaceId)
          if (timer !== undefined) window.clearTimeout(timer)
          draftSaveTimers.current.delete(workspaceId)
          await adapter.saveDraft(workspaceId, pending.text, pending.effort)
          pendingDraftSaves.current.delete(workspaceId)
        }
        applyAdapterState(await adapter.unregisterWorkspace(workspaceId))
        setNotice(null)
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          errorCode:
            error instanceof Error
              ? error.message
              : "WORKSPACE-UNREGISTER-FAILED",
        }
      } finally {
        setWorkspaceAction(null)
      }
    }, [adapter, adapterReady, applyAdapterState, selectedWorkspace])

  const deleteSelectedWorkspaceHistory = useCallback(async () => {
    if (
      !adapterReady ||
      !selectedWorkspace ||
      !adapter?.deleteWorkspaceHistory
    ) {
      return false
    }
    const workspaceId = selectedWorkspace.id
    const pendingDraft = pendingDraftSaves.current.get(workspaceId)
    deletingWorkspaceIds.current.add(workspaceId)
    pendingDraftSaves.current.delete(workspaceId)
    const timer = draftSaveTimers.current.get(workspaceId)
    if (timer !== undefined) window.clearTimeout(timer)
    draftSaveTimers.current.delete(workspaceId)
    try {
      applyAdapterState(await adapter.deleteWorkspaceHistory(workspaceId))
      setDrafts((current) => {
        const next = { ...current }
        delete next[workspaceId]
        return next
      })
      setNotice(null)
      return true
    } catch (error) {
      deletingWorkspaceIds.current.delete(workspaceId)
      if (pendingDraft !== undefined) {
        scheduleDraftSave(workspaceId, pendingDraft.text, pendingDraft.effort)
      }
      setNotice({
        tone: "error",
        message:
          error instanceof Error ? error.message : "WORKSPACE-DELETE-FAILED",
      })
      return false
    } finally {
      deletingWorkspaceIds.current.delete(workspaceId)
    }
  }, [
    adapter,
    adapterReady,
    applyAdapterState,
    scheduleDraftSave,
    selectedWorkspace,
  ])

  const resetUiState = useCallback(() => {
    setFilter("")
    setActiveTab("chat")
    setSettingsSection("general")
    setNotice(null)
  }, [])

  return {
    activeTab,
    adapter,
    adapterStatus,
    addAttachmentFiles,
    addWorkspace,
    answerApproval,
    answerDecision,
    captureContext,
    cancelSelectedWorkspace,
    characterHidden,
    codex,
    deleteSelectedWorkspaceHistory,
    filteredWorkspaces,
    filter,
    muted,
    notice,
    pickAttachments,
    history,
    reducedMotion,
    repairSelectedWorkspace,
    registerAttachmentPaths,
    removeAttachment,
    removeContext,
    requestAddProject,
    retryAdapterLoad,
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
    timeline: combinedTimeline,
    turnState,
    workspaces,
    workspaceAction,
    unregisterSelectedWorkspace,
  }
}
