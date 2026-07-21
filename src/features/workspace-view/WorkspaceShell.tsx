import { AlertCircleIcon, InfoIcon, XIcon } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  type AppCleanupFailedV1,
  type AppCloseRequestedV1,
  type AppLifecycleGateway,
  getSafeQuitCopy,
  SafeQuitDialog,
  type SafeQuitDialogStatus,
} from "@/features/app-lifecycle"
import {
  projectCharacterRuntime,
  useCharacterRuntimeStatus,
  useCharacterRuntimeStatusStore,
} from "@/features/character"
import type { ScopedCommitExplanationController } from "@/features/git-review/commit-explanation-adapter"
import { EvidenceView } from "@/features/git-review/EvidenceView"
import type { GitReviewTransport } from "@/features/git-review/transport"
import { useI18n } from "@/features/localization"
import {
  CommitNarrationCaption,
  isActiveCommitNarrationPresentation,
  type NarrationController,
  useNarrationSnapshot,
} from "@/features/narration"
import {
  SetupOverview,
  shouldShowSetupOverview,
  useNativeReadiness,
} from "@/features/readiness"
import { useRuntime } from "@/features/runtime"
import { CharacterStageSlot } from "@/features/workspace-view/CharacterStageSlot"
import { ChatView } from "@/features/workspace-view/ChatView"
import {
  getWorkspaceCopy,
  type WorkspaceCopy,
} from "@/features/workspace-view/copy"
import { ProjectSetupDialog } from "@/features/workspace-view/ProjectSetupDialog"
import { AppSettingsView } from "@/features/workspace-view/SettingsView"
import {
  type AppSettingsSection,
  type CharacterStageRenderer,
  type WorkspaceRecord,
  type WorkspaceTab,
  type WorkspaceViewAdapter,
  workspaceTabs,
} from "@/features/workspace-view/types"
import { useEditableSettingsContext } from "@/features/workspace-view/useEditableSettingsContext"
import { useWorkspaceViewModel } from "@/features/workspace-view/useWorkspaceViewModel"
import { WorkspaceHeader } from "@/features/workspace-view/WorkspaceHeader"
import { WorkspaceProjectSelection } from "@/features/workspace-view/WorkspaceProjectSelection"
import { WorkspaceSidebar } from "@/features/workspace-view/WorkspaceSidebar"
import {
  deriveWorkspaceCharacterState,
  useCompletedCharacterCue,
} from "@/features/workspace-view/workspace-character-state"
import { useWorkspaceViewportLayout } from "@/features/workspace-view/workspace-viewport"
import { gitReviewSchemaVersion } from "@/lib/contracts/git-review"

export interface WorkspaceShellProps {
  readonly adapter?: WorkspaceViewAdapter | undefined
  readonly appLifecycleGateway?: AppLifecycleGateway | undefined
  readonly characterRenderer?: CharacterStageRenderer | undefined
  readonly gitReviewTransport: GitReviewTransport
  readonly initialWorkspaces?: readonly WorkspaceRecord[] | undefined
  readonly commitExplanationController?:
    | ScopedCommitExplanationController
    | undefined
  readonly narrationController: NarrationController
}

function isWorkspaceTab(value: string): value is WorkspaceTab {
  return workspaceTabs.some((tab) => tab === value)
}

function getSystemReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

function workspaceActionError(copy: WorkspaceCopy, code: string): string {
  if (code.includes("ACTIVE") || code.includes("RUNNING")) {
    return copy.workspaceMenu.error.active
  }
  if (code.includes("UNAVAILABLE")) {
    return copy.workspaceMenu.error.unavailable
  }
  if (code.includes("CONFLICT") || code.includes("REVISION")) {
    return copy.workspaceMenu.error.conflict
  }
  if (code === "WORKSPACE-REPAIR-ROOT-IN-USE") {
    return copy.workspaceMenu.error.rootInUse
  }
  if (code.includes("DRAFT")) return copy.workspaceMenu.error.draft
  return copy.workspaceMenu.error.generic
}

export function WorkspaceShell({
  adapter,
  appLifecycleGateway,
  characterRenderer,
  gitReviewTransport,
  initialWorkspaces,
  commitExplanationController,
  narrationController,
}: WorkspaceShellProps) {
  const { locale } = useI18n()
  const viewportLayout = useWorkspaceViewportLayout()
  const copy = getWorkspaceCopy(locale)
  const safeQuitCopy = getSafeQuitCopy(locale)
  const runtime = useRuntime()
  const narration = useNarrationSnapshot()
  const nativeReadiness = useNativeReadiness()
  const view = useWorkspaceViewModel(adapter, initialWorkspaces)
  const [appSettingsProjectId, setAppSettingsProjectId] = useState<
    string | null
  >(null)
  const contextModel = useEditableSettingsContext(
    adapter,
    appSettingsProjectId ?? "__no_project__",
    null,
  )
  const characterRuntimeStore = useCharacterRuntimeStatusStore()
  const characterRuntimeSnapshot = useCharacterRuntimeStatus(
    view.selectedWorkspace?.id ?? "__no_workspace__",
  )
  const characterRuntime = projectCharacterRuntime(characterRuntimeSnapshot)
  const [appSettingsOpen, setAppSettingsOpen] = useState(false)
  const [appSettingsSection, setAppSettingsSection] =
    useState<AppSettingsSection>("general")
  const [archiveCandidate, setArchiveCandidate] = useState<{
    readonly workspace: WorkspaceRecord
    readonly expectedGeneration: number | null
  } | null>(null)
  const [archivePendingWorkspaceId, setArchivePendingWorkspaceId] = useState<
    string | null
  >(null)
  const archiveSafeActionRef = useRef<HTMLButtonElement | null>(null)
  const [systemReducedMotion, setSystemReducedMotion] = useState(
    getSystemReducedMotion,
  )
  const observesCodexConnection =
    adapter?.hydrationMode === "native" &&
    (adapter.codexSnapshot !== undefined ||
      adapter.subscribeCodex !== undefined)
  const [runtimeSetupRecovery, setRuntimeSetupRecovery] = useState(false)

  useEffect(() => {
    if (adapter?.hydrationMode !== "native") {
      setRuntimeSetupRecovery(false)
      return
    }
    if (runtime.state.status === "error") {
      setRuntimeSetupRecovery(true)
    } else if (runtime.state.status === "ready") {
      setRuntimeSetupRecovery(false)
    }
  }, [adapter?.hydrationMode, runtime.state.status])

  const connected = view.codex.connected && runtime.state.status === "ready"
  const reducedMotion = systemReducedMotion
  const turnActive =
    view.turnState === "sending" ||
    view.turnState === "running" ||
    view.turnState === "stopping" ||
    view.codex.phase === "running" ||
    view.codex.phase === "stopping"
  const sessionInMotion =
    view.turnState === "sending" ||
    view.turnState === "stopping" ||
    view.codex.phase === "running" ||
    view.codex.phase === "stopping" ||
    (view.turnState === "running" && view.codex.phase !== "waiting")
  const runningWorkspaceId = sessionInMotion
    ? (view.codex.activeWorkspaceId ?? view.selectedWorkspace?.id ?? null)
    : null
  const selectedWorkspaceId = view.selectedWorkspace?.id ?? null
  const selectedOwnsExecution =
    selectedWorkspaceId !== null &&
    view.codex.activeWorkspaceId === selectedWorkspaceId
  const completedCharacterCue = useCompletedCharacterCue(view.codex)
  const characterState = deriveWorkspaceCharacterState({
    codex: view.codex,
    completedCue: completedCharacterCue,
    selectedWorkspaceId,
    turnActive,
    turnState: view.turnState,
  })
  const activeTab = view.activeTab
  const registerAttachmentPaths = view.registerAttachmentPaths
  const codexGeneration = view.codex.generation
  const workspaceGeneration =
    selectedWorkspaceId !== null &&
    view.codex.activeWorkspaceId === selectedWorkspaceId &&
    Number.isSafeInteger(codexGeneration) &&
    Number(codexGeneration) > 0
      ? codexGeneration
      : null
  const workspaceThreadReady =
    !observesCodexConnection || (connected && workspaceGeneration !== null)
  const commitPresentation =
    narration.presentation?.key.workspaceId === selectedWorkspaceId &&
    narration.presentation.key.workspaceGeneration === workspaceGeneration &&
    narration.presentation.key.locale === locale &&
    isActiveCommitNarrationPresentation(narration.presentation)
      ? narration.presentation
      : null
  const previousSelectedWorkspaceId = useRef<string | null>(null)
  const previousExplanationScope = useRef<{
    readonly workspaceId: string
    readonly workspaceGeneration: number
    readonly locale: typeof locale
  } | null>(null)
  const explanationPresentationTriggerRef = useRef<HTMLButtonElement | null>(
    null,
  )
  const explanationFocusRestoreVersionRef = useRef(0)
  const safeQuitRequestRef = useRef<AppCloseRequestedV1 | null>(null)
  const cleanupFailureRef = useRef<AppCleanupFailedV1 | null>(null)
  const safeQuitOperationRef = useRef<Promise<void> | null>(null)
  const [safeQuitRequest, setSafeQuitRequest] =
    useState<AppCloseRequestedV1 | null>(null)
  const [safeQuitStatus, setSafeQuitStatus] =
    useState<SafeQuitDialogStatus>("confirming")
  const [cleanupFailure, setCleanupFailure] =
    useState<AppCleanupFailedV1 | null>(null)

  useEffect(() => {
    if (appLifecycleGateway === undefined) return
    let disposed = false
    const unlisten: Array<() => void> = []
    const register = (subscription: Promise<() => void>) => {
      void subscription
        .then((dispose) => {
          if (disposed) {
            dispose()
            return
          }
          unlisten.push(dispose)
        })
        .catch(() => undefined)
    }
    register(
      appLifecycleGateway.listenCloseRequested((request) => {
        const current = safeQuitRequestRef.current
        if (current !== null || cleanupFailureRef.current !== null) return
        safeQuitRequestRef.current = request
        setSafeQuitStatus("confirming")
        setSafeQuitRequest(request)
      }),
    )
    register(
      appLifecycleGateway.listenCleanupFailed((failure) => {
        const current = cleanupFailureRef.current
        if (
          current !== null &&
          (current.requestId !== failure.requestId ||
            current.attempt > failure.attempt)
        ) {
          return
        }
        safeQuitRequestRef.current = null
        cleanupFailureRef.current = failure
        setSafeQuitRequest(null)
        setCleanupFailure(failure)
        setSafeQuitStatus("cleanup_failed")
      }),
    )
    return () => {
      disposed = true
      unlisten.forEach((dispose) => dispose())
    }
  }, [appLifecycleGateway])

  const clearSafeQuitRequest = useCallback((requestId: string) => {
    if (safeQuitRequestRef.current?.requestId !== requestId) return
    safeQuitRequestRef.current = null
    setSafeQuitRequest(null)
    setSafeQuitStatus("confirming")
  }, [])

  const keepAppOpen = useCallback(() => {
    const request = safeQuitRequestRef.current
    if (
      request === null ||
      appLifecycleGateway === undefined ||
      safeQuitOperationRef.current !== null
    ) {
      return
    }
    setSafeQuitStatus("canceling")
    const operation = appLifecycleGateway
      .cancelQuit(request.requestId)
      .then(() => clearSafeQuitRequest(request.requestId))
      .catch(() => {
        if (safeQuitRequestRef.current?.requestId === request.requestId) {
          setSafeQuitStatus("cancel_failed")
        }
      })
      .finally(() => {
        if (safeQuitOperationRef.current === operation) {
          safeQuitOperationRef.current = null
        }
      })
    safeQuitOperationRef.current = operation
  }, [appLifecycleGateway, clearSafeQuitRequest])

  const stopAndQuit = useCallback(() => {
    const request = safeQuitRequestRef.current
    if (
      request === null ||
      appLifecycleGateway === undefined ||
      adapter?.prepareAppQuit === undefined ||
      safeQuitOperationRef.current !== null
    ) {
      if (request !== null) setSafeQuitStatus("stop_failed")
      return
    }
    const draft = view.selectedDraft
    setSafeQuitStatus("stopping")
    const operation = adapter
      .prepareAppQuit({
        workspaceId: request.workspaceId,
        expectedGeneration: request.workspaceGeneration,
        draftText: draft.text,
        draftEffort: draft.effort,
      })
      .then(async () => {
        commitExplanationController?.revokePresentationIntent("close")
        await Promise.all([
          narrationController.dismissPresentation("app_close"),
          narrationController.dismissPresence("app_close"),
        ])
        await appLifecycleGateway.confirmQuit(request.requestId)
      })
      .catch(() => {
        if (safeQuitRequestRef.current?.requestId === request.requestId) {
          setSafeQuitStatus("stop_failed")
        }
      })
      .finally(() => {
        if (safeQuitOperationRef.current === operation) {
          safeQuitOperationRef.current = null
        }
      })
    safeQuitOperationRef.current = operation
  }, [
    adapter,
    appLifecycleGateway,
    commitExplanationController,
    narrationController,
    view.selectedDraft,
  ])

  const retryCleanup = useCallback(() => {
    const failure = cleanupFailureRef.current
    if (
      failure === null ||
      appLifecycleGateway === undefined ||
      safeQuitOperationRef.current !== null
    ) {
      return
    }
    setSafeQuitStatus("retrying_cleanup")
    const operation = appLifecycleGateway
      .retryCleanup(failure.requestId)
      .catch(() => {
        if (cleanupFailureRef.current?.requestId === failure.requestId) {
          setSafeQuitStatus("cleanup_failed")
        }
      })
      .finally(() => {
        if (safeQuitOperationRef.current === operation) {
          safeQuitOperationRef.current = null
        }
      })
    safeQuitOperationRef.current = operation
  }, [appLifecycleGateway])

  useEffect(() => {
    const previous = previousSelectedWorkspaceId.current
    previousSelectedWorkspaceId.current = selectedWorkspaceId
    if (previous !== null && previous !== selectedWorkspaceId) {
      commitExplanationController?.revokePresentationIntent("scope_change")
      void narrationController.dismissPresentation("workspace_switch")
    }
  }, [commitExplanationController, narrationController, selectedWorkspaceId])

  useEffect(() => {
    if (selectedWorkspaceId === null || workspaceGeneration === null) return
    const scope = {
      workspaceId: selectedWorkspaceId,
      workspaceGeneration,
      locale,
    }
    const previous = previousExplanationScope.current
    previousExplanationScope.current = scope
    if (
      previous?.workspaceId === scope.workspaceId &&
      previous.workspaceGeneration === scope.workspaceGeneration &&
      previous.locale !== scope.locale
    ) {
      void narrationController.dismissPresentation("workspace_switch")
    }
    void narrationController.setScope({
      workspaceId: scope.workspaceId,
      generation: scope.workspaceGeneration,
      locale: scope.locale,
    })
    void commitExplanationController
      ?.setScope({
        schemaVersion: gitReviewSchemaVersion,
        workspaceId: scope.workspaceId,
        workspaceGeneration: scope.workspaceGeneration,
        locale: scope.locale,
      })
      .catch(() => undefined)
  }, [
    commitExplanationController,
    locale,
    narrationController,
    selectedWorkspaceId,
    workspaceGeneration,
  ])

  useEffect(() => {
    for (const event of view.codex.timeline) {
      if (event.kind !== "request_resolved") continue
      narrationController.consumePendingRequestResolved({
        workspaceId: event.workspaceId,
        workspaceGeneration: event.generation,
        pendingId: event.pendingId,
      })
    }
  }, [narrationController, view.codex.timeline])

  const stopTurn = useCallback(async () => {
    commitExplanationController?.revokePresentationIntent("turn_stop")
    const [mainTurn] = await Promise.allSettled([
      view.stopTurn(),
      narrationController.dismissPresentation("turn_stop"),
      narrationController.dismissPresence("turn_stop"),
    ])
    return mainTurn.status === "fulfilled" ? mainTurn.value : false
  }, [commitExplanationController, narrationController, view])

  const reportWorkspaceAction = useCallback(
    (result: Awaited<ReturnType<typeof view.cancelSelectedWorkspace>>) => {
      if (!result.ok) {
        view.setNotice({
          tone: "error",
          message: workspaceActionError(copy, result.errorCode),
        })
      }
      return result.ok
    },
    [copy, view],
  )

  const unregisterProject = useCallback(
    async (projectId: string) =>
      reportWorkspaceAction(await view.unregisterProject(projectId)),
    [reportWorkspaceAction, view],
  )

  const executeArchiveWorkspace = useCallback(
    async (workspaceId: string, expectedGeneration: number | null) => {
      setArchivePendingWorkspaceId(workspaceId)
      try {
        const archived = reportWorkspaceAction(
          await view.archiveWorkspace(workspaceId, expectedGeneration),
        )
        if (!archived) return false
        setArchiveCandidate(null)
        commitExplanationController?.revokePresentationIntent(
          "selection_change",
        )
        await Promise.all([
          narrationController.dismissPresentation("explicit_cancel"),
          narrationController.dismissPresence("explicit_cancel"),
        ])
        return true
      } finally {
        setArchivePendingWorkspaceId((current) =>
          current === workspaceId ? null : current,
        )
      }
    },
    [
      commitExplanationController,
      narrationController,
      reportWorkspaceAction,
      view,
    ],
  )

  const requestArchiveWorkspace = useCallback(
    (workspace: WorkspaceRecord) => {
      const hasActiveMainSession =
        workspace.id === view.codex.activeWorkspaceId &&
        (turnActive ||
          view.codex.phase === "waiting" ||
          view.codex.pendingRequests.length > 0)
      if (hasActiveMainSession) {
        const generation = view.codex.generation
        setArchiveCandidate({
          workspace,
          expectedGeneration:
            Number.isSafeInteger(generation) && Number(generation) > 0
              ? generation
              : null,
        })
        return
      }
      void executeArchiveWorkspace(workspace.id, null)
    },
    [executeArchiveWorkspace, turnActive, view.codex],
  )

  const confirmArchiveWorkspace = useCallback(async () => {
    if (archiveCandidate === null) return
    await executeArchiveWorkspace(
      archiveCandidate.workspace.id,
      archiveCandidate.expectedGeneration,
    )
  }, [archiveCandidate, executeArchiveWorkspace])

  const dismissCommitPresentation = useCallback(() => {
    explanationFocusRestoreVersionRef.current += 1
    explanationPresentationTriggerRef.current = null
    commitExplanationController?.revokePresentationIntent("selection_change")
    void narrationController.dismissPresentation("explicit_cancel")
  }, [commitExplanationController, narrationController])

  const closeCommitPresentation = useCallback(() => {
    const trigger = explanationPresentationTriggerRef.current
    explanationPresentationTriggerRef.current = null
    const restoreVersion = ++explanationFocusRestoreVersionRef.current
    commitExplanationController?.revokePresentationIntent("close")
    void narrationController.dismissPresentation("explicit_cancel")
    window.requestAnimationFrame(() => {
      if (explanationFocusRestoreVersionRef.current !== restoreVersion) return
      if (trigger?.isConnected) {
        trigger.focus()
        return
      }
      document
        .querySelector<HTMLElement>("[data-commit-detail-heading]")
        ?.focus()
    })
  }, [commitExplanationController, narrationController])

  useEffect(() => {
    explanationFocusRestoreVersionRef.current += 1
    explanationPresentationTriggerRef.current = null
  }, [locale, selectedWorkspaceId, workspaceGeneration])

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return

    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setSystemReducedMotion(media.matches)
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  useEffect(() => {
    if (
      adapter?.hydrationMode !== "native" ||
      adapter.registerAttachmentPaths === undefined
    ) {
      return
    }
    let active = true
    let unlisten: (() => void) | undefined
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (active && activeTab === "chat" && event.payload.type === "drop") {
            void registerAttachmentPaths("drop", event.payload.paths)
          }
        }),
      )
      .then((dispose) => {
        if (active) unlisten = dispose
        else dispose()
      })
      .catch(() => undefined)
    return () => {
      active = false
      unlisten?.()
    }
  }, [activeTab, adapter, registerAttachmentPaths])

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "Tab") {
        event.preventDefault()
        if (appSettingsOpen) return
        const currentIndex = workspaceTabs.indexOf(view.activeTab)
        const direction = event.shiftKey ? -1 : 1
        const nextIndex =
          (currentIndex + direction + workspaceTabs.length) %
          workspaceTabs.length
        view.setActiveTab(workspaceTabs[nextIndex] ?? "chat")
      }

      if (event.metaKey && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault()
        const visible = (element: HTMLElement) =>
          element.getClientRects().length > 0
        const focusProjectFilter = () => {
          const controls = Array.from(
            document.querySelectorAll<HTMLElement>(
              "[data-workspace-project-filter]",
            ),
          )
          const projectFilter = controls.find(visible) ?? controls[0]
          projectFilter?.focus()
          return projectFilter !== undefined
        }

        const filterToggles = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            "[data-workspace-filter-toggle]",
          ),
        )
        const visibleFilterToggle = filterToggles.find(visible)
        if (visibleFilterToggle !== undefined) {
          if (visibleFilterToggle.getAttribute("aria-expanded") !== "true") {
            visibleFilterToggle.click()
          }
          window.requestAnimationFrame(focusProjectFilter)
          return
        }

        const compactToggle = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            "[data-workspace-navigation-toggle]",
          ),
        ).find(visible)
        if (compactToggle !== undefined) {
          compactToggle.click()
          const prepareCompactFilter = (attempt: number) => {
            const dialog = document.getElementById(
              "compact-workspace-navigation",
            )
            if (dialog === null) {
              if (attempt < 4) {
                window.setTimeout(() => prepareCompactFilter(attempt + 1), 25)
              }
              return
            }
            const dialogFilterToggle = dialog?.querySelector<HTMLButtonElement>(
              "[data-workspace-filter-toggle]",
            )
            if (dialogFilterToggle?.getAttribute("aria-expanded") !== "true") {
              dialogFilterToggle?.click()
            }
            window.setTimeout(() => {
              if (focusProjectFilter()) return
              if (attempt < 4) prepareCompactFilter(attempt + 1)
            }, 25)
          }
          window.setTimeout(() => prepareCompactFilter(0), 0)
          return
        }

        const fallbackToggle = filterToggles[0]
        if (fallbackToggle?.getAttribute("aria-expanded") !== "true") {
          fallbackToggle?.click()
        }
        window.requestAnimationFrame(focusProjectFilter)
      }
    }

    window.addEventListener("keydown", handleKeyboard)
    return () => window.removeEventListener("keydown", handleKeyboard)
  }, [appSettingsOpen, view])

  const openAppSettings = (section: AppSettingsSection = "general") => {
    setAppSettingsProjectId(null)
    setAppSettingsSection(section)
    setAppSettingsOpen(true)
  }

  const setActiveTab = (value: string) => {
    if (!isWorkspaceTab(value)) return
    setAppSettingsProjectId(null)
    setAppSettingsOpen(false)
    view.setActiveTab(value)
  }

  if (view.adapterStatus === "loading") {
    return (
      <main
        aria-busy="true"
        className="flex min-h-dvh w-full items-center justify-center bg-background p-xl"
        data-workspace-hydration="loading"
        data-workspace-viewport={viewportLayout}
      >
        <div
          className="flex w-full max-w-lg flex-col gap-lg rounded-panel border border-divider bg-surface p-xl shadow-panel"
          role="status"
        >
          <div className="flex flex-col gap-xs">
            <span className="text-headline text-text-strong">
              {copy.loadingWorkspacesTitle}
            </span>
            <span className="text-caption text-muted-foreground">
              {copy.loadingWorkspacesDescription}
            </span>
          </div>
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-8 w-1/2" />
        </div>
      </main>
    )
  }

  if (view.adapterStatus === "error") {
    return (
      <main
        className="flex min-h-dvh w-full items-center justify-center bg-background p-xl"
        data-workspace-hydration="error"
        data-workspace-viewport={viewportLayout}
      >
        <div
          className="flex w-full max-w-lg flex-col items-start gap-md rounded-panel border border-destructive/40 bg-surface p-xl shadow-panel"
          role="alert"
        >
          <div className="flex flex-col gap-xs">
            <span className="text-headline text-text-strong">
              {copy.workspaceLoadFailedTitle}
            </span>
            <span className="text-caption text-muted-foreground">
              {copy.workspaceLoadFailedDescription}
            </span>
          </div>
          <Button
            onClick={view.retryAdapterLoad}
            size="sm"
            type="button"
            variant="secondary"
          >
            {copy.retry}
          </Button>
        </div>
      </main>
    )
  }

  const selectedWorkspace = view.selectedWorkspace
  const runtimeSetupRequired =
    adapter?.hydrationMode === "native" &&
    (runtime.state.status === "error" || runtimeSetupRecovery)
  const setupRequirementOverrides = {
    runtimeUnavailable: runtimeSetupRequired,
  }
  const setupOverviewRequired = shouldShowSetupOverview(
    adapter?.hydrationMode,
    nativeReadiness,
    view.projects.length,
    setupRequirementOverrides,
  )
  const recheckSetup = async () => {
    if (runtimeSetupRequired) runtime.refresh()
  }
  const projectSetupDialog =
    view.projectSetup === null ? null : (
      <ProjectSetupDialog
        copy={copy}
        key={view.projectSetup.candidate.setupId}
        onCancel={() => void view.cancelProjectSetup()}
        onInitializeGit={() => void view.initializeProjectGit()}
        onSetupGithub={(owner, repository) =>
          void view.setupProjectGithub(owner, repository)
        }
        setup={view.projectSetup}
      />
    )

  if (setupOverviewRequired) {
    return (
      <main data-workspace-viewport={viewportLayout}>
        <SetupOverview
          notice={view.notice}
          onAddProject={() =>
            void view.requestAddProject(copy.pickerUnavailable)
          }
          onRecheck={recheckSetup}
          projectCount={view.projects.length}
          requirementOverrides={setupRequirementOverrides}
        />
        {projectSetupDialog}
        <SafeQuitDialog
          copy={safeQuitCopy}
          onDontQuit={keepAppOpen}
          onRetryCleanup={retryCleanup}
          onStopAndQuit={stopAndQuit}
          open={safeQuitRequest !== null || cleanupFailure !== null}
          status={safeQuitStatus}
        />
      </main>
    )
  }

  return (
    <main
      className="workspace-shell"
      data-reduced-motion={reducedMotion || undefined}
      data-runtime={runtime.state.status}
      data-workspace-viewport={viewportLayout}
    >
      <WorkspaceSidebar
        appSettingsActive={appSettingsOpen}
        copy={copy}
        filteredWorkspaces={view.filteredWorkspaces}
        projectFilterIds={view.projectFilterIds}
        projects={view.projects}
        runningWorkspaceId={runningWorkspaceId}
        archiveDisabledWorkspaceId={archivePendingWorkspaceId ?? undefined}
        onAddProject={() => void view.requestAddProject(copy.pickerUnavailable)}
        onCreateWorkspace={view.addWorkspace}
        onProjectFilterChange={view.setProjectFilterIds}
        onOpenSettings={() =>
          openAppSettings(view.projects.length === 0 ? "projects" : "general")
        }
        onRequestArchive={requestArchiveWorkspace}
        onSelectWorkspace={(workspaceId) => {
          setAppSettingsProjectId(null)
          setAppSettingsOpen(false)
          view.setSelectedWorkspaceId(workspaceId)
        }}
        selectedWorkspace={selectedWorkspace}
        selectedWorkspaceId={view.selectedWorkspaceId}
      />

      {appSettingsOpen ? (
        <AppSettingsView
          characterRuntime={characterRuntime}
          adapter={adapter}
          contextModel={contextModel}
          copy={copy}
          muted={view.muted}
          onMutedChange={view.setMuted}
          onRetryCharacter={() => {
            characterRuntimeStore.retry(
              selectedWorkspace?.id ?? "__no_workspace__",
            )
          }}
          onCloseProject={() => setAppSettingsProjectId(null)}
          onOpenProject={setAppSettingsProjectId}
          onSectionChange={(section) => {
            setAppSettingsProjectId(null)
            setAppSettingsSection(section)
          }}
          onUnregisterProject={unregisterProject}
          projectActionPending={view.workspaceAction !== null || turnActive}
          projects={view.projects}
          runtimeState={runtime.state}
          section={appSettingsSection}
          selectedProjectId={appSettingsProjectId}
          turnActive={turnActive}
          workspaceId={selectedWorkspace?.id ?? "__no_workspace__"}
        />
      ) : null}

      {selectedWorkspace ? (
        <Tabs
          className="workspace-tabs grid"
          data-character-active="true"
          data-character-layout=""
          data-workspace-tab={view.activeTab}
          hidden={appSettingsOpen}
          onValueChange={setActiveTab}
          orientation="horizontal"
          value={view.activeTab}
        >
          <WorkspaceHeader
            activeTab={view.activeTab}
            copy={copy}
            workspace={selectedWorkspace}
          />

          <TabsContent
            className="workspace-view data-[state=inactive]:hidden"
            forceMount
            value="chat"
          >
            <ChatView
              {...(view.backgroundExecutionWorkspace === null
                ? {}
                : {
                    backgroundExecutionWorkspaceLabel: `${view.backgroundExecutionWorkspace.repository}/${view.backgroundExecutionWorkspace.name}`,
                  })}
              characterState={characterState}
              copy={copy}
              draft={view.selectedDraft}
              history={view.history}
              muted={view.muted}
              onAnswerApproval={view.answerApproval}
              onAnswerDecision={view.answerDecision}
              onCaptureContext={(source) =>
                view.captureContext(source, copy.contextUnavailable)
              }
              onDraftChange={view.setDraftText}
              onEffortChange={view.setEffort}
              onFastModeChange={view.setFastMode}
              onGoalModeChange={view.setGoalMode}
              onPlanModeChange={view.setPlanMode}
              onMutedChange={view.setMuted}
              onOpenDiagnostics={() => openAppSettings("diagnostics")}
              onPickAttachments={
                adapter?.pickAttachments === undefined
                  ? undefined
                  : view.pickAttachments
              }
              onRegisterAttachmentPaths={
                adapter?.registerAttachmentPaths === undefined
                  ? undefined
                  : view.registerAttachmentPaths
              }
              onRemoveAttachment={view.removeAttachment}
              onRemoveContext={view.removeContext}
              onRetryRuntime={runtime.refresh}
              onSend={view.sendTurn}
              onStop={stopTurn}
              onTimelineAnchorChange={view.saveTimelineAnchor}
              reducedMotion={reducedMotion}
              readiness={view.codex.readiness}
              repositoryHealth={selectedWorkspace.health}
              runtimeError={runtime.state.status === "error"}
              timeline={view.timeline}
              timelineAnchor={view.timelineAnchor}
              pendingRequestIds={
                selectedOwnsExecution
                  ? view.codex.pendingRequests.map(
                      (request) => request.pendingId,
                    )
                  : []
              }
              turnState={view.turnState}
              workspaceThreadReady={workspaceThreadReady}
              workspaceId={selectedWorkspace.id}
            />
          </TabsContent>

          <TabsContent
            className="workspace-view data-[state=inactive]:hidden"
            forceMount
            value="commit"
          >
            <EvidenceView
              active={
                view.activeTab === "commit" &&
                (gitReviewTransport.kind === "demo" ||
                  workspaceGeneration !== null)
              }
              commitExplanationController={commitExplanationController}
              characterVisible
              locale={locale}
              onBackToChat={() => view.setActiveTab("chat")}
              onCommitSelectionChange={dismissCommitPresentation}
              onExplanationPresentationTrigger={(trigger) => {
                explanationFocusRestoreVersionRef.current += 1
                explanationPresentationTriggerRef.current = trigger
              }}
              transport={gitReviewTransport}
              workspaceGeneration={workspaceGeneration ?? 1}
              workspaceId={selectedWorkspace.id}
            />
          </TabsContent>

          <CharacterStageSlot
            characterRuntime={characterRuntime}
            copy={copy}
            muted={view.muted}
            onMutedChange={view.setMuted}
            onRetryCharacter={() => {
              characterRuntimeStore.retry(selectedWorkspace.id)
            }}
            reducedMotion={reducedMotion}
            state={characterState}
            visible={!appSettingsOpen}
            workspaceGeneration={workspaceGeneration}
            workspaceId={selectedWorkspace.id}
            {...(characterRenderer ? { renderer: characterRenderer } : {})}
          />

          {commitPresentation ? (
            <div
              className="workspace-narration-overlay"
              data-narration-presentation={commitPresentation.status}
              data-narration-speech={commitPresentation.speechStatus}
              data-workspace-narration-overlay=""
              data-workspace-tab={view.activeTab}
            >
              <CommitNarrationCaption
                onDismiss={closeCommitPresentation}
                onVisible={narrationController.acknowledgeCaptionVisible}
                presentation={commitPresentation}
              />
            </div>
          ) : null}
        </Tabs>
      ) : appSettingsOpen ? null : (
        <section className="workspace-tabs bg-background">
          <Empty className="row-span-2 row-start-1 w-full items-stretch gap-lg p-10 text-start max-[840px]:p-xl">
            <EmptyHeader className="mx-auto w-full max-w-[48rem] items-start text-start">
              <EmptyTitle className="text-lg font-semibold tracking-tight">
                {copy.createWorkspace.selectProject}
              </EmptyTitle>
            </EmptyHeader>
            <div className="mx-auto flex w-full max-w-[48rem] flex-col items-stretch">
              <WorkspaceProjectSelection
                copy={copy}
                onAddProject={() =>
                  void view.requestAddProject(copy.pickerUnavailable)
                }
                onCreate={view.addWorkspace}
                projects={view.projects}
              />
            </div>
          </Empty>
        </section>
      )}

      {projectSetupDialog}

      <Dialog
        onOpenChange={(open) => {
          if (!open && archivePendingWorkspaceId === null) {
            setArchiveCandidate(null)
          }
        }}
        open={archiveCandidate !== null}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const archivedId = archiveCandidate?.workspace.id
            if (archivedId === undefined) return
            const archiveButton = [
              ...document.querySelectorAll<HTMLElement>(
                "[data-workspace-archive]",
              ),
            ].find(
              (element) =>
                element.getAttribute("data-workspace-archive") === archivedId,
            )
            archiveButton?.focus()
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            archiveSafeActionRef.current?.focus()
          }}
          showCloseButton={archivePendingWorkspaceId === null}
        >
          <DialogHeader>
            <DialogTitle>{copy.archiveDialog.title}</DialogTitle>
            <DialogDescription>
              {copy.archiveDialog.body(archiveCandidate?.workspace.name ?? "")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={archivePendingWorkspaceId !== null}
              onClick={() => setArchiveCandidate(null)}
              ref={archiveSafeActionRef}
              type="button"
              variant="outline"
            >
              {copy.archiveDialog.cancel}
            </Button>
            <Button
              disabled={archivePendingWorkspaceId !== null}
              onClick={() => void confirmArchiveWorkspace()}
              type="button"
              variant="destructive"
            >
              {archivePendingWorkspaceId !== null
                ? copy.archiveDialog.working
                : copy.archiveDialog.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SafeQuitDialog
        copy={safeQuitCopy}
        onDontQuit={keepAppOpen}
        onRetryCleanup={retryCleanup}
        onStopAndQuit={stopAndQuit}
        open={safeQuitRequest !== null || cleanupFailure !== null}
        status={safeQuitStatus}
      />

      {view.notice ? (
        <div
          aria-live={view.notice.tone === "error" ? "assertive" : "polite"}
          className="workspace-notice flex items-start gap-xs rounded-control border border-divider bg-popover px-md py-sm text-caption text-foreground shadow-overlay"
          role={view.notice.tone === "error" ? "alert" : "status"}
        >
          {view.notice.tone === "error" ? (
            <AlertCircleIcon
              aria-hidden="true"
              className="mt-xxs size-3 shrink-0 text-destructive"
            />
          ) : (
            <InfoIcon
              aria-hidden="true"
              className="mt-xxs size-3 shrink-0 text-muted-foreground"
            />
          )}
          <span className="max-w-[48ch]">{view.notice.message}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={copy.dismiss}
                onClick={() => view.setNotice(null)}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{copy.dismiss}</TooltipContent>
          </Tooltip>
        </div>
      ) : null}
    </main>
  )
}
