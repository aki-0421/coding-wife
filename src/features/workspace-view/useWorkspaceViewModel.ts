import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type {
  ApprovalDecision,
  AttachmentRegistrationResponse,
  PendingRequestView,
} from "@/lib/contracts"
import {
  bundledHiyoriCharacterContextPreset,
  type WorkspaceTurnContextSnapshot,
} from "@/lib/contracts/workspace-context"

import {
  projectWorkspaceNavigation,
  workspaceProjectId,
} from "@/features/workspace-view/workspace-navigation"
import type {
  AttachmentItem,
  ContextSnapshotItem,
  ProjectRecord,
  ProjectRegistrationResult,
  ProjectSetupCandidate,
  ReasoningEffort,
  SendTurnRequest,
  WorkspaceAdapterState,
  WorkspaceCodexState,
  WorkspaceDraft,
  WorkspaceRecord,
  WorkspaceTab,
  WorkspaceTimelineItem,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"

export interface ProjectSetupState {
  readonly candidate: ProjectSetupCandidate
  readonly status:
    | "idle"
    | "initializing_git"
    | "checking_github"
    | "setting_up_github"
    | "canceling"
  readonly errorCode: string | null
}

const emptyDraft: WorkspaceDraft = {
  text: "",
  effort: "off",
  fastMode: false,
  planMode: false,
  goalMode: false,
  attachments: [],
  contextSnapshots: [],
}

const defaultProjectHash =
  "e0da727f2381a1c290ddcb74bdb52b44b0ec890559443d795f29731d68fe1323"
const defaultCharacterHash =
  "7607f6f22a12f0abed924b078a0e1b202c87e993d67f4346a0c0a2682a1004af"
const safeErrorCodePattern = /^[A-Z][A-Z0-9-]{2,127}$/u

function safeErrorCode(error: unknown, fallback: string): string {
  if (typeof error === "string" && safeErrorCodePattern.test(error)) {
    return error
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    safeErrorCodePattern.test(error.code)
  ) {
    return error.code
  }
  if (error instanceof Error && safeErrorCodePattern.test(error.message)) {
    return error.message
  }
  return fallback
}

function projectsForWorkspaces(
  workspaces: readonly WorkspaceRecord[],
): readonly ProjectRecord[] {
  const grouped = new Map<string, WorkspaceRecord[]>()
  for (const workspace of workspaces) {
    const projectId = workspaceProjectId(workspace)
    grouped.set(projectId, [...(grouped.get(projectId) ?? []), workspace])
  }
  return [...grouped.entries()].map(([id, items]) => ({
    id,
    name: items[0]?.repository ?? id,
    ...(items[0]?.githubRepository === undefined
      ? {}
      : { githubRepository: items[0].githubRepository }),
    health: items[0]?.health ?? "ready",
    workspaceCount: items.length,
    updatedAt: items[0]?.updatedAt ?? new Date(0).toISOString(),
  }))
}

function fallbackContextSnapshot(
  workspaceId: string,
): WorkspaceTurnContextSnapshot {
  return {
    schemaVersion: 1,
    workspaceId,
    projectVersion: 1,
    projectHash: defaultProjectHash,
    characterPackId: "builtin:hiyori_pro",
    characterVersion: 1,
    characterHash: defaultCharacterHash,
    snapshotHash:
      "87bd96621876045566d8d24c4fb7c54f98dd5c2958d1c159b407b68f19a539e2",
    capturedAt: new Date(0).toISOString(),
    project: {
      goal: "",
      constraints: "",
      definitionOfDone: [],
      technicalReferences: [],
      userNotes: "",
    },
    character: bundledHiyoriCharacterContextPreset,
  }
}

const disconnectedCodexState: WorkspaceCodexState = {
  activeWorkspaceId: null,
  generation: null,
  phase: "idle",
  connected: false,
  readiness: {
    ready: false,
    fastServiceTier: null,
    supportedReasoningEfforts: [],
    experimentalModesAvailable: false,
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
      fastServiceTier: "priority",
      supportedReasoningEfforts: [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ],
      experimentalModesAvailable: true,
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

function timelineItemKey(event: WorkspaceTimelineItem): string {
  return event.kind === "history"
    ? `history:${event.id}`
    : `semantic:${event.stableId}`
}

function durableTimelineIdentity(
  event: WorkspaceTimelineItem,
): { readonly eventId: string; readonly sequence: number } | null {
  if (event.kind === "history") {
    return { eventId: event.id, sequence: event.sequence }
  }
  if (!event.durable) return null
  return {
    eventId: event.sourceEventId,
    sequence: event.sourceSequence,
  }
}

export type TurnUiState = "idle" | "sending" | "running" | "stopping"
export type WorkspaceAdapterStatus = "loading" | "ready" | "error"
export type WorkspaceAction =
  | "archive"
  | "cancel"
  | "recheck"
  | "repair"
  | "unregister"

export type WorkspaceActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorCode: string }

export interface WorkspaceViewNotice {
  readonly tone: "neutral" | "error"
  readonly message: string
}

export function useWorkspaceViewModel(
  adapter?: WorkspaceViewAdapter,
  initialWorkspaces: readonly WorkspaceRecord[] = [],
) {
  const nativeHydration =
    adapter?.loadState !== undefined && adapter.hydrationMode !== "demo"
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceRecord[]>(
    () => (nativeHydration ? [] : initialWorkspaces),
  )
  const [projects, setProjects] = useState<readonly ProjectRecord[]>(() => {
    if (nativeHydration) return []
    return projectsForWorkspaces(initialWorkspaces)
  })
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(() => {
    if (nativeHydration) return ""
    return (
      initialWorkspaces.find(
        (workspace) => workspace.id === "build-live2d-desktop-app",
      )?.id ??
      initialWorkspaces[0]?.id ??
      ""
    )
  })
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("chat")
  const [projectFilterIds, setProjectFilterIdsState] = useState<
    readonly string[]
  >([])
  const [drafts, setDrafts] = useState<
    Readonly<Record<string, WorkspaceDraft>>
  >({})
  const [turnState, setTurnState] = useState<TurnUiState>("idle")
  const [codex, setCodex] = useState<WorkspaceCodexState>(() =>
    initialCodexState(adapter),
  )
  const [notice, setNotice] = useState<WorkspaceViewNotice | null>(null)
  const [projectSetup, setProjectSetup] = useState<ProjectSetupState | null>(
    null,
  )
  const [adapterStatus, setAdapterStatus] = useState<WorkspaceAdapterStatus>(
    nativeHydration ? "loading" : "ready",
  )
  const [adapterLoadAttempt, setAdapterLoadAttempt] = useState(0)
  const [workspaceAction, setWorkspaceAction] =
    useState<WorkspaceAction | null>(null)
  const [timeline, setTimeline] = useState<readonly WorkspaceTimelineItem[]>([])
  const [timelineAnchor, setTimelineAnchor] = useState<NonNullable<
    WorkspaceAdapterState["timelineAnchor"]
  > | null>(null)
  const [nextBeforeSequence, setNextBeforeSequence] = useState<number | null>(
    null,
  )
  const [history, setHistory] = useState<WorkspaceAdapterState["history"]>({
    mode: "ready",
    errorCode: null,
    backupName: null,
  })
  const [muted, setMuted] = useState(false)
  const selectionVersion = useRef(0)
  const sendVersion = useRef(0)
  const repositoryCheckVersion = useRef(0)
  const timelineRestoreVersion = useRef(0)
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
    setProjects(state.projects ?? projectsForWorkspaces(state.workspaces))
    setWorkspaces(state.workspaces)
    setTimeline(state.timeline)
    setTimelineAnchor(state.timelineAnchor ?? null)
    setNextBeforeSequence(state.nextBeforeSequence ?? null)
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
            fastMode: existing.fastMode ?? false,
            planMode: existing.planMode ?? false,
            goalMode: existing.goalMode ?? false,
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
        setProjects([])
        setWorkspaces([])
        setSelectedWorkspaceId("")
        setDrafts({})
        setTimeline([])
        setTimelineAnchor(null)
        setNextBeforeSequence(null)
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

  useEffect(() => {
    const validProjectIds = projectFilterIds.filter((projectId) =>
      projects.some((project) => project.id === projectId),
    )
    if (validProjectIds.length !== projectFilterIds.length) {
      setProjectFilterIdsState(validProjectIds)
    }
  }, [projectFilterIds, projects])

  const setProjectFilterIds = useCallback(
    (projectIds: readonly string[]) => {
      const selectedProjectIds = new Set(projectIds)
      setProjectFilterIdsState(
        projects
          .filter((project) => selectedProjectIds.has(project.id))
          .map((project) => project.id),
      )
    },
    [projects],
  )

  const { filteredWorkspaces, selectedWorkspace } = useMemo(
    () =>
      projectWorkspaceNavigation(
        workspaces,
        selectedWorkspaceId,
        projectFilterIds,
      ),
    [projectFilterIds, selectedWorkspaceId, workspaces],
  )
  const selectedDraft = selectedWorkspace
    ? draftFor(drafts, selectedWorkspace.id)
    : emptyDraft
  const globalExecutionActive =
    turnState !== "idle" ||
    ["running", "waiting", "stopping"].includes(codex.phase) ||
    codex.pendingRequests.length > 0
  const backgroundExecutionWorkspace =
    globalExecutionActive &&
    codex.activeWorkspaceId !== null &&
    codex.activeWorkspaceId !== selectedWorkspaceId
      ? (workspaces.find(
          (workspace) => workspace.id === codex.activeWorkspaceId,
        ) ?? null)
      : null
  const selectedTurnState =
    codex.activeWorkspaceId === null ||
    codex.activeWorkspaceId === selectedWorkspaceId
      ? turnState
      : "idle"

  const combinedTimeline = useMemo(() => {
    const events = new Map(
      timeline.map((event) => [timelineItemKey(event), event] as const),
    )
    for (const event of codex.timeline) {
      if (event.workspaceId === selectedWorkspaceId) {
        events.set(timelineItemKey(event), event)
      }
    }
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
  }, [codex.timeline, selectedWorkspaceId, timeline])

  const timelineAnchorLoaded = useMemo(() => {
    if (timelineAnchor === null) return true
    return timeline.some((event) => {
      const identity = durableTimelineIdentity(event)
      return (
        identity?.eventId === timelineAnchor.eventId &&
        identity.sequence === timelineAnchor.sequence
      )
    })
  }, [timeline, timelineAnchor])

  useEffect(() => {
    if (
      !adapterReady ||
      selectedWorkspace === undefined ||
      timelineAnchor === null ||
      timelineAnchorLoaded ||
      nextBeforeSequence === null ||
      adapter?.loadTimelinePage === undefined
    ) {
      return
    }
    timelineRestoreVersion.current += 1
    const version = timelineRestoreVersion.current
    const workspaceId = selectedWorkspace.id
    void adapter
      .loadTimelinePage(workspaceId, nextBeforeSequence)
      .then((page) => {
        if (
          timelineRestoreVersion.current !== version ||
          selectedWorkspaceId !== workspaceId
        ) {
          return
        }
        setTimeline((current) => {
          const merged = new Map(
            current.map((event) => [timelineItemKey(event), event] as const),
          )
          for (const event of page.timeline) {
            merged.set(timelineItemKey(event), event)
          }
          return [...merged.values()]
        })
        setNextBeforeSequence((current) =>
          page.nextBeforeSequence === current ? null : page.nextBeforeSequence,
        )
      })
      .catch(() => {
        if (timelineRestoreVersion.current !== version) return
        setNextBeforeSequence(null)
        setNotice({
          tone: "error",
          message: "HIST-TIMELINE-RESTORE-FAILED",
        })
      })
    return () => {
      timelineRestoreVersion.current += 1
    }
  }, [
    adapter,
    adapterReady,
    nextBeforeSequence,
    selectedWorkspace,
    selectedWorkspaceId,
    timelineAnchor,
    timelineAnchorLoaded,
  ])

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

  const setFastMode = useCallback(
    (fastMode: boolean) => {
      if (!adapterReady || !selectedWorkspace) return
      updateDraft(selectedWorkspace.id, (current) => ({
        ...current,
        fastMode,
      }))
    },
    [adapterReady, selectedWorkspace, updateDraft],
  )

  const setPlanMode = useCallback(
    (planMode: boolean) => {
      if (!adapterReady || !selectedWorkspace) return
      updateDraft(selectedWorkspace.id, (current) => ({
        ...current,
        planMode,
      }))
    },
    [adapterReady, selectedWorkspace, updateDraft],
  )

  const setGoalMode = useCallback(
    (goalMode: boolean) => {
      if (!adapterReady || !selectedWorkspace) return
      updateDraft(selectedWorkspace.id, (current) => ({
        ...current,
        goalMode,
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
    if (backgroundExecutionWorkspace !== null) return
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
    backgroundExecutionWorkspace,
    selectedDraft.attachments,
    selectedWorkspace,
  ])

  const registerAttachmentPaths = useCallback(
    async (source: "drop" | "paste", paths: readonly string[]) => {
      if (!adapterReady || !selectedWorkspace || paths.length === 0) return
      if (adapter?.registerAttachmentPaths === undefined) return
      if (backgroundExecutionWorkspace !== null) return
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
      backgroundExecutionWorkspace,
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
    if (backgroundExecutionWorkspace !== null) {
      setNotice({
        tone: "neutral",
        message: "CODEX-OTHER-WORKSPACE-ACTIVE",
      })
      return false
    }
    sendVersion.current += 1
    const version = sendVersion.current
    const draft = draftFor(drafts, selectedWorkspace.id)

    setTurnState("sending")
    try {
      const editableContextSnapshot =
        adapter.getTurnContextSnapshot === undefined
          ? adapter.hydrationMode === "native"
            ? null
            : fallbackContextSnapshot(selectedWorkspace.id)
          : await adapter.getTurnContextSnapshot(selectedWorkspace.id)
      if (sendVersion.current !== version) return false
      if (
        editableContextSnapshot === null ||
        editableContextSnapshot.workspaceId !== selectedWorkspace.id
      ) {
        setTurnState("idle")
        setNotice({
          tone: "error",
          message: "CODEX-TURN-CONTEXT-UNAVAILABLE",
        })
        return false
      }
      if (adapter.recheckWorkspace !== undefined) {
        const checked = await adapter.recheckWorkspace(selectedWorkspace.id)
        if (sendVersion.current !== version) return false
        applyAdapterState(checked)
        const checkedWorkspace = checked.workspaces.find(
          (workspace) => workspace.id === selectedWorkspace.id,
        )
        if (checkedWorkspace?.health !== "ready") {
          setTurnState("idle")
          setNotice({
            tone: "error",
            message: `WORKSPACE-REPOSITORY-${checkedWorkspace?.health ?? "unreadable"}`,
          })
          return false
        }
      } else if (
        selectedWorkspace.health !== undefined &&
        selectedWorkspace.health !== "ready"
      ) {
        setTurnState("idle")
        setNotice({
          tone: "error",
          message: `WORKSPACE-REPOSITORY-${selectedWorkspace.health}`,
        })
        return false
      }
      const request: SendTurnRequest = {
        workspaceId: selectedWorkspace.id,
        instruction: draft.text,
        effort: draft.effort,
        fastMode: draft.fastMode ?? false,
        planMode: draft.planMode ?? false,
        goalMode: draft.goalMode ?? false,
        attachments: draft.attachments,
        contextSnapshots: draft.contextSnapshots,
        editableContextSnapshot,
      }
      const result = await adapter.sendTurn(request)
      if (sendVersion.current !== version) return false
      if (!result.accepted) {
        setTurnState("idle")
        setNotice({ tone: "error", message: "CODEX-TURN-NOT-ACCEPTED" })
        return false
      }

      updateDraft(selectedWorkspace.id, (current) => ({
        ...current,
        text: "",
        goalMode: false,
        attachments: [],
        contextSnapshots: [],
      }))
      scheduleDraftSave(selectedWorkspace.id, "", draft.effort)
      setTurnState("running")
      setNotice(null)
      return true
    } catch (error) {
      if (sendVersion.current === version) {
        setTurnState("idle")
        setNotice({
          tone: "error",
          message: safeErrorCode(error, "CODEX-TURN-START-FAILED"),
        })
      }
      return false
    }
  }, [
    adapter,
    adapterReady,
    applyAdapterState,
    backgroundExecutionWorkspace,
    drafts,
    scheduleDraftSave,
    selectedWorkspace,
    updateDraft,
  ])

  useEffect(() => {
    if (
      !adapterReady ||
      selectedWorkspace === undefined ||
      adapter?.recheckWorkspace === undefined
    ) {
      return
    }
    const workspaceId = selectedWorkspace.id
    const recheck = () => {
      repositoryCheckVersion.current += 1
      const version = repositoryCheckVersion.current
      void adapter
        .recheckWorkspace?.(workspaceId)
        .then((state) => {
          if (
            repositoryCheckVersion.current === version &&
            state.activeWorkspaceId === workspaceId
          ) {
            applyAdapterState(state)
          }
        })
        .catch(() => {
          if (repositoryCheckVersion.current !== version) return
          setNotice({
            tone: "error",
            message: "WORKSPACE-REPOSITORY-unreadable",
          })
        })
    }
    window.addEventListener("focus", recheck)
    return () => {
      repositoryCheckVersion.current += 1
      window.removeEventListener("focus", recheck)
    }
  }, [adapter, adapterReady, applyAdapterState, selectedWorkspace])

  const saveTimelineAnchor = useCallback(
    (eventId: string, sequence: number, offset: number) => {
      if (
        !adapterReady ||
        selectedWorkspace === undefined ||
        adapter?.saveTimelineAnchor === undefined
      ) {
        return
      }
      const workspaceId = selectedWorkspace.id
      void adapter
        .saveTimelineAnchor(workspaceId, eventId, sequence, offset)
        .catch(() => undefined)
    },
    [adapter, adapterReady, selectedWorkspace],
  )

  const stopTurn = useCallback(async () => {
    if (
      !adapterReady ||
      !selectedWorkspace ||
      !adapter?.stopTurn ||
      turnState !== "running" ||
      (codex.activeWorkspaceId !== null &&
        codex.activeWorkspaceId !== selectedWorkspace.id)
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
  }, [
    adapter,
    adapterReady,
    codex.activeWorkspaceId,
    selectedWorkspace,
    turnState,
  ])

  const answerDecision = useCallback(
    async (
      request: PendingRequestView,
      answers: Readonly<Record<string, readonly string[]>>,
    ) => {
      if (
        !selectedWorkspace ||
        selectedWorkspace.id !== codex.activeWorkspaceId ||
        request.kind !== "user_input"
      )
        return false
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
    [adapter, codex.activeWorkspaceId, selectedWorkspace],
  )

  const answerApproval = useCallback(
    async (request: PendingRequestView, decision: ApprovalDecision) => {
      if (
        !selectedWorkspace ||
        selectedWorkspace.id !== codex.activeWorkspaceId ||
        request.kind === "user_input"
      )
        return false
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
    [adapter, codex.activeWorkspaceId, selectedWorkspace],
  )

  const addWorkspace = useCallback(
    async (projectId: string, name: string) => {
      const trimmedName = name.trim()
      if (!adapterReady || trimmedName.length === 0) return false
      const project = projects.find((candidate) => candidate.id === projectId)
      if (project === undefined) return false
      if (adapter?.requestAddWorkspace) {
        try {
          const state = await adapter.requestAddWorkspace({
            projectId,
            name: trimmedName,
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
        projectId,
        repository: project.name,
        ...(project.githubRepository === undefined
          ? {}
          : { githubRepository: project.githubRepository }),
        name: trimmedName,
        branch: `coding-wife/local-${Date.now()}`,
        lifecycle: "backlog",
      }
      setWorkspaces((current) => [...current, record])
      setProjects((current) =>
        current.map((candidate) =>
          candidate.id === projectId
            ? {
                ...candidate,
                workspaceCount: candidate.workspaceCount + 1,
                updatedAt: new Date().toISOString(),
              }
            : candidate,
        ),
      )
      setSelectedWorkspaceId(record.id)
      setActiveTab("chat")
      setDrafts((current) => ({
        ...current,
        [record.id]: emptyDraft,
      }))
      return true
    },
    [adapter, adapterReady, applyAdapterState, projects],
  )

  const applyProjectRegistrationResult = useCallback(
    (result: ProjectRegistrationResult) => {
      applyAdapterState(result.state)
      if (result.outcome === "setup_required" && result.setup !== undefined) {
        setProjectSetup({
          candidate: result.setup,
          status: "idle",
          errorCode: null,
        })
      } else {
        setProjectSetup(null)
      }
      setNotice(null)
    },
    [applyAdapterState],
  )

  const requestAddProject = useCallback(
    async (unavailableCopy: string) => {
      if (!adapterReady) return
      if (!adapter?.requestAddProject) {
        setNotice({ tone: "neutral", message: unavailableCopy })
        return
      }
      try {
        const result = await adapter.requestAddProject()
        if (result !== undefined) applyProjectRegistrationResult(result)
      } catch (error) {
        setNotice({
          tone: "error",
          message: error instanceof Error ? error.message : unavailableCopy,
        })
      }
    },
    [adapter, adapterReady, applyProjectRegistrationResult],
  )

  const initializeProjectGit = useCallback(async () => {
    if (projectSetup === null || adapter?.initializeProjectGit === undefined) {
      return
    }
    const setupId = projectSetup.candidate.setupId
    setProjectSetup((current) =>
      current?.candidate.setupId === setupId
        ? {
            ...current,
            status:
              current.candidate.gitStatus === "ready"
                ? "checking_github"
                : "initializing_git",
            errorCode: null,
          }
        : current,
    )
    try {
      applyProjectRegistrationResult(
        await adapter.initializeProjectGit(setupId),
      )
    } catch (error) {
      setProjectSetup((current) =>
        current?.candidate.setupId === setupId
          ? {
              ...current,
              status: "idle",
              errorCode:
                error instanceof Error
                  ? error.message
                  : "PROJECT-SETUP-GIT-FAILED",
            }
          : current,
      )
    }
  }, [adapter, applyProjectRegistrationResult, projectSetup])

  const setupProjectGithub = useCallback(
    async (owner: string, repository: string) => {
      if (projectSetup === null || adapter?.setupProjectGithub === undefined) {
        return
      }
      const setupId = projectSetup.candidate.setupId
      setProjectSetup((current) =>
        current?.candidate.setupId === setupId
          ? { ...current, status: "setting_up_github", errorCode: null }
          : current,
      )
      try {
        applyProjectRegistrationResult(
          await adapter.setupProjectGithub(setupId, owner, repository),
        )
      } catch (error) {
        setProjectSetup((current) =>
          current?.candidate.setupId === setupId
            ? {
                ...current,
                status: "idle",
                errorCode:
                  error instanceof Error
                    ? error.message
                    : "PROJECT-SETUP-GITHUB-FAILED",
              }
            : current,
        )
      }
    },
    [adapter, applyProjectRegistrationResult, projectSetup],
  )

  const cancelProjectSetup = useCallback(async () => {
    if (projectSetup === null) return
    const setupId = projectSetup.candidate.setupId
    if (adapter?.cancelProjectSetup === undefined) {
      setProjectSetup(null)
      return
    }
    setProjectSetup((current) =>
      current?.candidate.setupId === setupId
        ? { ...current, status: "canceling", errorCode: null }
        : current,
    )
    try {
      await adapter.cancelProjectSetup(setupId)
      setProjectSetup((current) =>
        current?.candidate.setupId === setupId ? null : current,
      )
    } catch (error) {
      setProjectSetup((current) =>
        current?.candidate.setupId === setupId
          ? {
              ...current,
              status: "idle",
              errorCode:
                error instanceof Error
                  ? error.message
                  : "PROJECT-SETUP-CANCEL-FAILED",
            }
          : current,
      )
    }
  }, [adapter, projectSetup])

  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      if (!adapterReady || workspaceId === selectedWorkspaceId) return
      sendVersion.current += 1
      if (turnState === "sending") setTurnState("idle")
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
    [adapter, adapterReady, applyAdapterState, selectedWorkspaceId, turnState],
  )

  const cancelSelectedWorkspace = useCallback(
    async (
      expectedGeneration: number | null = null,
    ): Promise<WorkspaceActionResult> => {
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
            expectedGeneration,
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
    },
    [adapter, adapterReady, applyAdapterState, selectedWorkspace],
  )

  const repairSelectedWorkspace =
    useCallback(async (): Promise<WorkspaceActionResult> => {
      const recheckObservedHead =
        selectedWorkspace?.health === "stale_branch" &&
        adapter?.recheckWorkspace !== undefined
      if (
        !adapterReady ||
        !selectedWorkspace ||
        (!recheckObservedHead && adapter?.repairWorkspace === undefined)
      ) {
        return { ok: false, errorCode: "WORKSPACE-REPAIR-UNAVAILABLE" }
      }
      setWorkspaceAction("repair")
      try {
        const state = recheckObservedHead
          ? await adapter.recheckWorkspace(selectedWorkspace.id, true)
          : await adapter.repairWorkspace!(selectedWorkspace.id)
        applyAdapterState(state)
        const repaired = state.workspaces.find(
          (workspace) => workspace.id === selectedWorkspace.id,
        )
        if (repaired?.health !== "ready") {
          return {
            ok: false,
            errorCode: `WORKSPACE-REPOSITORY-${repaired?.health ?? "unreadable"}`,
          }
        }
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

  const recheckSelectedWorkspace =
    useCallback(async (): Promise<WorkspaceActionResult> => {
      if (
        !adapterReady ||
        !selectedWorkspace ||
        adapter?.recheckWorkspace === undefined
      ) {
        return { ok: false, errorCode: "WORKSPACE-RECHECK-UNAVAILABLE" }
      }
      setWorkspaceAction("recheck")
      try {
        applyAdapterState(await adapter.recheckWorkspace(selectedWorkspace.id))
        setNotice(null)
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          errorCode:
            error instanceof Error ? error.message : "WORKSPACE-RECHECK-FAILED",
        }
      } finally {
        setWorkspaceAction(null)
      }
    }, [adapter, adapterReady, applyAdapterState, selectedWorkspace])

  const unregisterProject = useCallback(
    async (projectId: string): Promise<WorkspaceActionResult> => {
      if (
        !adapterReady ||
        !projects.some((project) => project.id === projectId) ||
        !adapter?.unregisterProject
      ) {
        return { ok: false, errorCode: "WORKSPACE-UNREGISTER-UNAVAILABLE" }
      }
      setWorkspaceAction("unregister")
      try {
        applyAdapterState(await adapter.unregisterProject(projectId))
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
    },
    [adapter, adapterReady, applyAdapterState, projects],
  )

  const archiveWorkspace = useCallback(
    async (
      workspaceId: string,
      expectedGeneration: number | null = null,
    ): Promise<WorkspaceActionResult> => {
      if (!adapterReady || !adapter?.archiveWorkspace) {
        return { ok: false, errorCode: "WORKSPACE-ARCHIVE-UNAVAILABLE" }
      }
      setWorkspaceAction("archive")
      const pendingDraft = pendingDraftSaves.current.get(workspaceId)
      deletingWorkspaceIds.current.add(workspaceId)
      pendingDraftSaves.current.delete(workspaceId)
      const timer = draftSaveTimers.current.get(workspaceId)
      if (timer !== undefined) window.clearTimeout(timer)
      draftSaveTimers.current.delete(workspaceId)
      try {
        applyAdapterState(
          await adapter.archiveWorkspace(workspaceId, expectedGeneration),
        )
        setDrafts((current) => {
          const next = { ...current }
          delete next[workspaceId]
          return next
        })
        setNotice(null)
        return { ok: true }
      } catch (error) {
        if (pendingDraft !== undefined) {
          scheduleDraftSave(workspaceId, pendingDraft.text, pendingDraft.effort)
        }
        return {
          ok: false,
          errorCode:
            error instanceof Error ? error.message : "WORKSPACE-ARCHIVE-FAILED",
        }
      } finally {
        deletingWorkspaceIds.current.delete(workspaceId)
        setWorkspaceAction(null)
      }
    },
    [adapter, adapterReady, applyAdapterState, scheduleDraftSave],
  )

  return {
    activeTab,
    adapter,
    adapterStatus,
    addWorkspace,
    answerApproval,
    answerDecision,
    archiveWorkspace,
    captureContext,
    cancelProjectSetup,
    cancelSelectedWorkspace,
    backgroundExecutionWorkspace,
    codex,
    filteredWorkspaces,
    projectFilterIds,
    projectSetup,
    muted,
    notice,
    pickAttachments,
    projects,
    history,
    initializeProjectGit,
    recheckSelectedWorkspace,
    repairSelectedWorkspace,
    registerAttachmentPaths,
    removeAttachment,
    removeContext,
    requestAddProject,
    retryAdapterLoad,
    selectedDraft,
    selectedWorkspace,
    selectedWorkspaceId,
    saveTimelineAnchor,
    sendTurn,
    setupProjectGithub,
    setActiveTab,
    setDraftText,
    setEffort,
    setFastMode,
    setPlanMode,
    setGoalMode,
    setProjectFilterIds,
    setMuted,
    setNotice,
    setSelectedWorkspaceId: selectWorkspace,
    stopTurn,
    timeline: combinedTimeline,
    timelineAnchor,
    turnState: selectedTurnState,
    workspaces,
    workspaceAction,
    unregisterProject,
  }
}
