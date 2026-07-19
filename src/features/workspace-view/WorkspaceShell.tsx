import { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircleIcon, InfoIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  getSafeQuitCopy,
  SafeQuitDialog,
  type AppCleanupFailedV1,
  type AppCloseRequestedV1,
  type AppLifecycleGateway,
  type SafeQuitDialogStatus,
} from "@/features/app-lifecycle"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useI18n } from "@/features/localization"
import { useAppPreferences } from "@/features/preferences"
import { useRuntime } from "@/features/runtime"
import {
  projectCharacterRuntime,
  useCharacterRuntimeStatus,
  useCharacterRuntimeStatusStore,
} from "@/features/character"
import type { ScopedCommitExplanationController } from "@/features/git-review/commit-explanation-adapter"
import { EvidenceView } from "@/features/git-review/EvidenceView"
import type { GitReviewTransport } from "@/features/git-review/transport"
import {
  CommitNarrationCaption,
  type NarrationController,
  useNarrationSnapshot,
} from "@/features/narration"
import { ChatView } from "@/features/workspace-view/ChatView"
import { ContextView } from "@/features/workspace-view/ContextView"
import {
  getWorkspaceCopy,
  type WorkspaceCopy,
} from "@/features/workspace-view/copy"
import {
  AppSettingsView,
  ProjectSettingsView,
} from "@/features/workspace-view/SettingsView"
import type { HeaderConnectionState } from "@/features/workspace-view/WorkspaceHeader"
import { WorkspaceHeader } from "@/features/workspace-view/WorkspaceHeader"
import { WorkspaceCreateForm } from "@/features/workspace-view/WorkspaceCreateForm"
import { WorkspaceSidebar } from "@/features/workspace-view/WorkspaceSidebar"
import type {
  CharacterStageRenderer,
  AppSettingsSection,
  WorkspaceRecord,
  WorkspaceTab,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"
import { useEditableWorkspaceContext } from "@/features/workspace-view/useEditableWorkspaceContext"
import { useWorkspaceViewModel } from "@/features/workspace-view/useWorkspaceViewModel"
import { useWorkspaceViewportLayout } from "@/features/workspace-view/workspace-viewport"
import { gitReviewSchemaVersion } from "@/lib/contracts/git-review"

const tabOrder: readonly WorkspaceTab[] = [
  "chat",
  "commit",
  "context",
  "settings",
]

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
  return tabOrder.some((tab) => tab === value)
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
  const appPreferences = useAppPreferences().snapshot.preferences
  const characterHidden = appPreferences.characterVisibility === "hidden"
  const view = useWorkspaceViewModel(adapter, initialWorkspaces)
  const contextModel = useEditableWorkspaceContext(
    adapter,
    view.selectedWorkspace?.id ?? "__no_workspace__",
  )
  const characterRuntimeStore = useCharacterRuntimeStatusStore()
  const characterRuntimeSnapshot = useCharacterRuntimeStatus(
    view.selectedWorkspace?.id ?? "__no_workspace__",
  )
  const characterRuntime = projectCharacterRuntime(
    characterRuntimeSnapshot,
    characterHidden,
  )
  const [appSettingsOpen, setAppSettingsOpen] = useState(false)
  const [appSettingsSection, setAppSettingsSection] =
    useState<AppSettingsSection>("general")
  const [archiveCandidate, setArchiveCandidate] =
    useState<WorkspaceRecord | null>(null)
  const archiveSafeActionRef = useRef<HTMLButtonElement | null>(null)
  const [systemReducedMotion, setSystemReducedMotion] = useState(
    getSystemReducedMotion,
  )

  const connected = view.codex.connected && runtime.state.status === "ready"
  const connection: HeaderConnectionState =
    runtime.state.status === "loading" || view.codex.phase === "connecting"
      ? "checking"
      : runtime.state.status === "error"
        ? "offline"
        : adapter?.hydrationMode === "demo" || adapter === undefined
          ? "preview"
          : connected
            ? "ready"
            : "offline"
  const reducedMotion =
    systemReducedMotion || appPreferences.reducedMotion === "on"
  const turnActive =
    view.turnState === "sending" ||
    view.turnState === "running" ||
    view.turnState === "stopping" ||
    view.codex.phase === "running" ||
    view.codex.phase === "stopping"
  const activeTab = view.activeTab
  const registerAttachmentPaths = view.registerAttachmentPaths
  const selectedWorkspaceId = view.selectedWorkspace?.id ?? null
  const pendingWorkspaceTransition = view.pendingWorkspaceTransition
  const transitionFromWorkspace = pendingWorkspaceTransition
    ? view.workspaces.find(
        (workspace) =>
          workspace.id === pendingWorkspaceTransition.fromWorkspaceId,
      )
    : undefined
  const transitionToWorkspace = pendingWorkspaceTransition
    ? view.workspaces.find(
        (workspace) =>
          workspace.id === pendingWorkspaceTransition.toWorkspaceId,
      )
    : undefined
  const transitionStopping = pendingWorkspaceTransition?.status === "stopping"
  const codexGeneration = view.codex.generation
  const workspaceGeneration =
    selectedWorkspaceId !== null &&
    view.codex.activeWorkspaceId === selectedWorkspaceId &&
    Number.isSafeInteger(codexGeneration) &&
    Number(codexGeneration) > 0
      ? codexGeneration
      : null
  const commitPresentation =
    narration.presentation?.key.workspaceId === selectedWorkspaceId &&
    narration.presentation.key.workspaceGeneration === workspaceGeneration &&
    narration.presentation.key.locale === locale &&
    narration.presentation.status !== "canceled"
      ? narration.presentation
      : null
  const previousSelectedWorkspaceId = useRef<string | null>(null)
  const previousExplanationScope = useRef<{
    readonly workspaceId: string
    readonly workspaceGeneration: number
    readonly locale: typeof locale
  } | null>(null)
  const transitionOriginRef = useRef<HTMLElement | null>(null)
  const explanationPresentationTriggerRef = useRef<HTMLButtonElement | null>(
    null,
  )
  const explanationFocusRestoreVersionRef = useRef(0)
  const transitionSafeActionRef = useRef<HTMLButtonElement | null>(null)
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
        await narrationController.dismissPresentation("app_close")
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

  const stopTurn = useCallback(async () => {
    commitExplanationController?.revokePresentationIntent("turn_stop")
    const [mainTurn] = await Promise.allSettled([
      view.stopTurn(),
      narrationController.dismissPresentation("turn_stop"),
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

  const cancelWorkspace = useCallback(
    async (stopFirst: boolean) => {
      const canceled = reportWorkspaceAction(
        await view.cancelSelectedWorkspace(
          stopFirst ? workspaceGeneration : null,
        ),
      )
      if (!canceled) {
        return false
      }
      commitExplanationController?.revokePresentationIntent("selection_change")
      await narrationController.dismissPresentation("explicit_cancel")
      return true
    },
    [
      commitExplanationController,
      narrationController,
      reportWorkspaceAction,
      view,
      workspaceGeneration,
    ],
  )

  const repairWorkspace = useCallback(
    async () => reportWorkspaceAction(await view.repairSelectedWorkspace()),
    [reportWorkspaceAction, view],
  )

  const unregisterProject = useCallback(
    async (projectId: string) =>
      reportWorkspaceAction(await view.unregisterProject(projectId)),
    [reportWorkspaceAction, view],
  )

  const confirmArchiveWorkspace = useCallback(async () => {
    if (archiveCandidate === null) return
    if (
      reportWorkspaceAction(await view.archiveWorkspace(archiveCandidate.id))
    ) {
      setArchiveCandidate(null)
    }
  }, [archiveCandidate, reportWorkspaceAction, view])

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
        const currentIndex = tabOrder.indexOf(view.activeTab)
        const direction = event.shiftKey ? -1 : 1
        const nextIndex =
          (currentIndex + direction + tabOrder.length) % tabOrder.length
        view.setActiveTab(tabOrder[nextIndex] ?? "chat")
      }

      if (event.metaKey && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault()
        const visible = (element: HTMLElement) =>
          element.getClientRects().length > 0
        const focusFilter = () => {
          const inputs = Array.from(
            document.querySelectorAll<HTMLInputElement>("input[aria-label]"),
          ).filter(
            (input) =>
              input.getAttribute("aria-label") === copy.filterWorkspaces,
          )
          const filterInput = inputs.find(visible) ?? inputs[0]
          filterInput?.focus()
        }

        const filterToggles = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            "[data-workspace-filter-toggle]",
          ),
        )
        const visibleFilterToggle = filterToggles.find(visible)
        if (visibleFilterToggle !== undefined) {
          if (visibleFilterToggle.getAttribute("aria-pressed") !== "true") {
            visibleFilterToggle.click()
          }
          window.requestAnimationFrame(focusFilter)
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
            if (dialogFilterToggle?.getAttribute("aria-pressed") !== "true") {
              dialogFilterToggle?.click()
            }
            window.setTimeout(() => {
              const dialogFilter = Array.from(
                dialog?.querySelectorAll<HTMLInputElement>(
                  "input[aria-label]",
                ) ?? [],
              ).find(
                (input) =>
                  input.getAttribute("aria-label") === copy.filterWorkspaces,
              )
              if (dialogFilter !== undefined) dialogFilter.focus()
              else if (attempt < 4) prepareCompactFilter(attempt + 1)
              else focusFilter()
            }, 25)
          }
          window.setTimeout(() => prepareCompactFilter(0), 0)
          return
        }

        const fallbackToggle = filterToggles[0]
        if (fallbackToggle?.getAttribute("aria-pressed") !== "true") {
          fallbackToggle?.click()
        }
        window.requestAnimationFrame(focusFilter)
      }
    }

    window.addEventListener("keydown", handleKeyboard)
    return () => window.removeEventListener("keydown", handleKeyboard)
  }, [appSettingsOpen, copy.filterWorkspaces, view])

  const openAppSettings = (section: AppSettingsSection = "general") => {
    setAppSettingsSection(section)
    setAppSettingsOpen(true)
  }

  const closeAppSettings = () => {
    setAppSettingsOpen(false)
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus()
    })
  }

  const resetUiState = () => {
    view.resetUiState()
    setAppSettingsSection("general")
    setAppSettingsOpen(false)
  }

  const setActiveTab = (value: string) => {
    if (!isWorkspaceTab(value)) return
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

  return (
    <main
      className="workspace-shell"
      data-reduced-motion={reducedMotion || undefined}
      data-runtime={connection}
      data-workspace-viewport={viewportLayout}
    >
      <WorkspaceSidebar
        appSettingsActive={appSettingsOpen}
        copy={copy}
        filter={view.filter}
        filteredWorkspaces={view.filteredWorkspaces}
        projects={view.projects}
        archiveDisabledWorkspaceId={
          turnActive ? selectedWorkspace?.id : undefined
        }
        onAddProject={() => void view.requestAddProject(copy.pickerUnavailable)}
        onCreateWorkspace={view.addWorkspace}
        onFilterChange={view.setFilter}
        onOpenSettings={() =>
          openAppSettings(view.projects.length === 0 ? "projects" : "general")
        }
        onRequestArchive={setArchiveCandidate}
        onSelectWorkspace={(workspaceId) => {
          setAppSettingsOpen(false)
          view.setSelectedWorkspaceId(workspaceId)
        }}
        selectedProjectId={
          selectedWorkspace?.projectId ??
          view.projects.find(
            (project) => project.name === selectedWorkspace?.repository,
          )?.id
        }
        selectedWorkspace={selectedWorkspace}
        selectedWorkspaceId={view.selectedWorkspaceId}
      />

      {appSettingsOpen ? (
        <AppSettingsView
          copy={copy}
          muted={view.muted}
          onBack={closeAppSettings}
          onMutedChange={view.setMuted}
          onResetUi={resetUiState}
          onSectionChange={setAppSettingsSection}
          onUnregisterProject={unregisterProject}
          projectActionPending={view.workspaceAction !== null || turnActive}
          projects={view.projects}
          runtimeState={runtime.state}
          section={appSettingsSection}
          workspaceId={selectedWorkspace?.id ?? "__no_workspace__"}
        />
      ) : null}

      {selectedWorkspace ? (
        <Tabs
          className="workspace-tabs"
          hidden={appSettingsOpen}
          onValueChange={setActiveTab}
          orientation="horizontal"
          value={view.activeTab}
        >
          <WorkspaceHeader
            activeTab={view.activeTab}
            actionPending={view.workspaceAction}
            canCancel={adapter?.cancelWorkspace !== undefined}
            canRepair={
              adapter?.repairWorkspace !== undefined ||
              adapter?.recheckWorkspace !== undefined
            }
            connection={connection}
            copy={copy}
            onCancel={cancelWorkspace}
            onRepair={repairWorkspace}
            turnActive={turnActive}
            workspace={selectedWorkspace}
          />

          <TabsContent
            className="workspace-view data-[state=inactive]:hidden"
            forceMount
            value="chat"
          >
            <ChatView
              characterHidden={characterHidden}
              characterRuntime={characterRuntime}
              connected={connected}
              copy={copy}
              draft={view.selectedDraft}
              history={view.history}
              lastSummary={view.lastSummary}
              muted={view.muted}
              onAnswerApproval={view.answerApproval}
              onAnswerDecision={view.answerDecision}
              onCaptureContext={(source) =>
                view.captureContext(source, copy.contextUnavailable)
              }
              onDraftChange={view.setDraftText}
              onEffortChange={view.setEffort}
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
              onRetryCharacter={() => {
                characterRuntimeStore.retry(selectedWorkspace.id)
              }}
              onSend={view.sendTurn}
              onStop={stopTurn}
              onTimelineAnchorChange={view.saveTimelineAnchor}
              reducedMotion={reducedMotion}
              readiness={view.codex.readiness}
              repositoryHealth={selectedWorkspace.health}
              renderer={characterRenderer}
              runtimeError={runtime.state.status === "error"}
              timeline={view.timeline}
              timelineAnchor={view.timelineAnchor}
              pendingRequestIds={view.codex.pendingRequests.map(
                (request) => request.pendingId,
              )}
              turnState={view.turnState}
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

          <TabsContent
            className="workspace-view data-[state=inactive]:hidden"
            forceMount
            value="context"
          >
            <ContextView
              copy={copy}
              model={contextModel}
              turnActive={turnActive}
            />
          </TabsContent>

          <TabsContent
            className="workspace-view data-[state=inactive]:hidden"
            value="settings"
          >
            <ProjectSettingsView
              characterRuntime={characterRuntime}
              contextModel={contextModel}
              copy={copy}
              history={view.history}
              muted={view.muted}
              onDeleteHistory={view.deleteSelectedWorkspaceHistory}
              onRetryCharacter={() => {
                characterRuntimeStore.retry(selectedWorkspace.id)
              }}
              onSectionChange={view.setProjectSettingsSection}
              section={view.projectSettingsSection}
              turnActive={turnActive}
              workspaceId={selectedWorkspace.id}
              workspaceLabel={`${selectedWorkspace.repository}/${selectedWorkspace.name}`}
            />
          </TabsContent>

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
          <Empty className="row-span-2 row-start-1 w-full items-stretch gap-xl p-10 text-start max-[840px]:p-xl">
            <EmptyHeader className="mx-auto w-full max-w-[40rem] items-start gap-sm text-start">
              <EmptyTitle className="text-lg font-semibold tracking-tight">
                {copy.createWorkspace.firstTitle}
              </EmptyTitle>
              <EmptyDescription className="text-body">
                {copy.createWorkspace.description}
              </EmptyDescription>
            </EmptyHeader>
            <WorkspaceCreateForm
              ariaLabel={copy.createWorkspace.firstTitle}
              className="mx-auto max-w-[40rem]"
              copy={copy}
              onAddProject={() =>
                void view.requestAddProject(copy.pickerUnavailable)
              }
              onCreate={view.addWorkspace}
              prominent
              projects={view.projects}
              selectedProjectId={
                selectedWorkspace?.projectId ?? view.projects[0]?.id
              }
            />
          </Empty>
        </section>
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open && view.workspaceAction !== "archive") {
            setArchiveCandidate(null)
          }
        }}
        open={archiveCandidate !== null}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const archivedId = archiveCandidate?.id
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
          showCloseButton={view.workspaceAction !== "archive"}
        >
          <DialogHeader>
            <DialogTitle>{copy.archiveDialog.title}</DialogTitle>
            <DialogDescription>
              {copy.archiveDialog.body(archiveCandidate?.name ?? "")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={view.workspaceAction === "archive"}
              onClick={() => setArchiveCandidate(null)}
              ref={archiveSafeActionRef}
              type="button"
              variant="outline"
            >
              {copy.archiveDialog.cancel}
            </Button>
            <Button
              disabled={view.workspaceAction === "archive"}
              onClick={() => void confirmArchiveWorkspace()}
              type="button"
              variant="destructive"
            >
              {view.workspaceAction === "archive"
                ? copy.archiveDialog.working
                : copy.archiveDialog.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open && !transitionStopping) view.cancelWorkspaceTransition()
        }}
        open={pendingWorkspaceTransition !== null}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const origin = transitionOriginRef.current
            transitionOriginRef.current = null
            window.requestAnimationFrame(() => origin?.focus())
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            if (!transitionStopping) view.cancelWorkspaceTransition()
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            if (document.activeElement instanceof HTMLElement) {
              transitionOriginRef.current = document.activeElement
            }
            transitionSafeActionRef.current?.focus()
          }}
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle>{copy.workspaceSwitch.title}</DialogTitle>
            <DialogDescription>
              {copy.workspaceSwitch.description}
            </DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-md gap-y-sm rounded-control border border-divider bg-muted/40 p-md text-caption">
            <dt className="text-muted-foreground">
              {copy.workspaceSwitch.from}
            </dt>
            <dd className="m-0 truncate font-medium text-text-strong">
              {transitionFromWorkspace
                ? `${transitionFromWorkspace.repository}/${transitionFromWorkspace.name}`
                : pendingWorkspaceTransition?.fromWorkspaceId}
            </dd>
            <dt className="text-muted-foreground">{copy.workspaceSwitch.to}</dt>
            <dd className="m-0 truncate font-medium text-text-strong">
              {transitionToWorkspace
                ? `${transitionToWorkspace.repository}/${transitionToWorkspace.name}`
                : pendingWorkspaceTransition?.toWorkspaceId}
            </dd>
          </dl>
          {transitionStopping ? (
            <p
              aria-live="polite"
              className="m-0 text-caption text-muted-foreground"
              role="status"
            >
              {copy.workspaceSwitch.stopping}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={transitionStopping}
              onClick={view.cancelWorkspaceTransition}
              ref={transitionSafeActionRef}
              type="button"
              variant="ghost"
            >
              {copy.workspaceSwitch.goBack}
            </Button>
            <Button
              disabled={transitionStopping}
              onClick={() =>
                void view.confirmWorkspaceTransition(
                  copy.workspaceSwitch.failed,
                )
              }
              type="button"
            >
              {transitionStopping
                ? copy.workspaceSwitch.stopping
                : copy.workspaceSwitch.confirm}
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
