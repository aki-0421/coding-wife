import { useEffect, useState } from "react"
import { AlertCircleIcon, InfoIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
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
import { useRuntime } from "@/features/runtime"
import {
  projectCharacterRuntime,
  useCharacterRuntimeStatus,
  useCharacterRuntimeStatusStore,
} from "@/features/character"
import { ChatView } from "@/features/workspace-view/ChatView"
import { ContextView } from "@/features/workspace-view/ContextView"
import { getWorkspaceCopy } from "@/features/workspace-view/copy"
import { EvidenceView } from "@/features/workspace-view/EvidenceView"
import { SettingsView } from "@/features/workspace-view/SettingsView"
import type { HeaderConnectionState } from "@/features/workspace-view/WorkspaceHeader"
import { WorkspaceHeader } from "@/features/workspace-view/WorkspaceHeader"
import { WorkspaceSidebar } from "@/features/workspace-view/WorkspaceSidebar"
import type {
  CharacterStageRenderer,
  SettingsSection,
  WorkspaceTab,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"
import { useWorkspaceViewModel } from "@/features/workspace-view/useWorkspaceViewModel"

const tabOrder: readonly WorkspaceTab[] = [
  "chat",
  "commit",
  "context",
  "settings",
]

export interface WorkspaceShellProps {
  readonly adapter?: WorkspaceViewAdapter | undefined
  readonly characterRenderer?: CharacterStageRenderer | undefined
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

export function WorkspaceShell({
  adapter,
  characterRenderer,
}: WorkspaceShellProps) {
  const { locale } = useI18n()
  const copy = getWorkspaceCopy(locale)
  const runtime = useRuntime()
  const view = useWorkspaceViewModel(adapter)
  const characterRuntimeStore = useCharacterRuntimeStatusStore()
  const characterRuntimeSnapshot = useCharacterRuntimeStatus(
    view.selectedWorkspace?.id ?? "__no_workspace__",
  )
  const characterRuntime = projectCharacterRuntime(
    characterRuntimeSnapshot,
    view.characterHidden,
  )
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
    view.reducedMotion === "reduce" ||
    (view.reducedMotion === "system" && systemReducedMotion)
  const activeTab = view.activeTab
  const registerAttachmentPaths = view.registerAttachmentPaths

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
  }, [copy.filterWorkspaces, view])

  const openSettings = (section: SettingsSection = "general") => {
    view.setSettingsSection(section)
    view.setActiveTab("settings")
  }

  const setActiveTab = (value: string) => {
    if (isWorkspaceTab(value)) view.setActiveTab(value)
  }

  if (view.adapterStatus === "loading") {
    return (
      <main
        aria-busy="true"
        className="flex min-h-dvh w-full items-center justify-center bg-background p-xl"
        data-workspace-hydration="loading"
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

  if (!view.selectedWorkspace) {
    return (
      <main className="flex min-h-dvh min-w-[960px] items-center justify-center bg-background p-xl">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{copy.workspaces}</EmptyTitle>
            <EmptyDescription>{copy.noMatches}</EmptyDescription>
          </EmptyHeader>
          <Button
            onClick={() => void view.requestAddProject(copy.pickerUnavailable)}
            size="sm"
            type="button"
            variant="secondary"
          >
            {copy.addProject}
          </Button>
        </Empty>
      </main>
    )
  }
  const selectedWorkspace = view.selectedWorkspace

  return (
    <main
      className="workspace-shell"
      data-reduced-motion={reducedMotion || undefined}
      data-runtime={connection}
    >
      <WorkspaceSidebar
        copy={copy}
        filter={view.filter}
        filteredWorkspaces={view.filteredWorkspaces}
        onAddProject={() => void view.requestAddProject(copy.pickerUnavailable)}
        onCreateWorkspace={view.addWorkspace}
        onFilterChange={view.setFilter}
        onOpenSettings={() => openSettings("general")}
        onSelectWorkspace={view.setSelectedWorkspaceId}
        selectedWorkspace={selectedWorkspace}
        selectedWorkspaceId={view.selectedWorkspaceId}
      />

      <Tabs
        className="workspace-tabs"
        onValueChange={setActiveTab}
        orientation="horizontal"
        value={view.activeTab}
      >
        <WorkspaceHeader
          activeTab={view.activeTab}
          connection={connection}
          copy={copy}
          workspace={selectedWorkspace}
        />

        <TabsContent
          className="workspace-view data-[state=inactive]:hidden"
          forceMount
          value="chat"
        >
          <ChatView
            characterHidden={view.characterHidden}
            characterRuntime={characterRuntime}
            connected={connected}
            copy={copy}
            draft={view.selectedDraft}
            history={view.history}
            muted={view.muted}
            onAddAttachments={view.addAttachmentFiles}
            onAnswerApproval={view.answerApproval}
            onAnswerDecision={view.answerDecision}
            onCaptureContext={(source) =>
              view.captureContext(source, copy.contextUnavailable)
            }
            onDraftChange={view.setDraftText}
            onEffortChange={view.setEffort}
            onMutedChange={view.setMuted}
            onOpenDiagnostics={() => openSettings("diagnostics")}
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
            onStop={view.stopTurn}
            reducedMotion={reducedMotion}
            renderer={characterRenderer}
            runtimeError={runtime.state.status === "error"}
            timeline={view.timeline}
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
            copy={copy}
            onBackToChat={() => view.setActiveTab("chat")}
          />
        </TabsContent>

        <TabsContent
          className="workspace-view data-[state=inactive]:hidden"
          forceMount
          value="context"
        >
          <ContextView copy={copy} workspaceId={selectedWorkspace.id} />
        </TabsContent>

        <TabsContent
          className="workspace-view data-[state=inactive]:hidden"
          forceMount
          value="settings"
        >
          <SettingsView
            characterHidden={view.characterHidden}
            characterRuntime={characterRuntime}
            copy={copy}
            history={view.history}
            muted={view.muted}
            onCharacterHiddenChange={view.setCharacterHidden}
            onMutedChange={view.setMuted}
            onDeleteHistory={view.deleteSelectedWorkspaceHistory}
            onOpenContext={() => view.setActiveTab("context")}
            onReducedMotionChange={view.setReducedMotion}
            onResetUi={view.resetUiState}
            onRetryRuntime={runtime.refresh}
            onRetryCharacter={() => {
              characterRuntimeStore.retry(selectedWorkspace.id)
            }}
            onSectionChange={view.setSettingsSection}
            reducedMotion={view.reducedMotion}
            runtimeState={runtime.state}
            section={view.settingsSection}
            workspaceId={selectedWorkspace.id}
          />
        </TabsContent>
      </Tabs>

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
