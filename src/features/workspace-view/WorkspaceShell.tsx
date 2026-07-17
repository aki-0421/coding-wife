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

  const connected =
    adapter?.connected === true && runtime.state.status === "ready"
  const connection: HeaderConnectionState =
    runtime.state.status === "loading"
      ? "checking"
      : runtime.state.status === "error"
        ? "offline"
        : connected
          ? "ready"
          : "preview"
  const reducedMotion =
    view.reducedMotion === "reduce" ||
    (view.reducedMotion === "system" && systemReducedMotion)

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return

    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setSystemReducedMotion(media.matches)
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

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
        const toggle = document.querySelector<HTMLButtonElement>(
          "[data-workspace-filter-toggle]",
        )
        toggle?.click()
        const focusFilter = () => {
          const filterInput = Array.from(
            document.querySelectorAll<HTMLInputElement>("input[aria-label]"),
          ).find(
            (input) =>
              input.getAttribute("aria-label") === copy.filterWorkspaces,
          )
          filterInput?.focus()
        }
        if (typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(focusFilter)
        } else {
          window.setTimeout(focusFilter, 0)
        }
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

  if (!view.selectedWorkspace) {
    return (
      <main className="flex min-h-dvh min-w-[960px] items-center justify-center bg-background p-xl">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{copy.workspaces}</EmptyTitle>
            <EmptyDescription>{copy.noMatches}</EmptyDescription>
          </EmptyHeader>
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
            muted={view.muted}
            onAddAttachments={view.addAttachments}
            onCaptureContext={(source) =>
              view.captureContext(source, copy.contextUnavailable)
            }
            onDraftChange={view.setDraftText}
            onEffortChange={view.setEffort}
            onMutedChange={view.setMuted}
            onOpenDiagnostics={() => openSettings("diagnostics")}
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
            muted={view.muted}
            onCharacterHiddenChange={view.setCharacterHidden}
            onMutedChange={view.setMuted}
            onOpenContext={() => view.setActiveTab("context")}
            onReducedMotionChange={view.setReducedMotion}
            onResetUi={view.resetUiState}
            onRetryRuntime={runtime.refresh}
            onRetryCharacter={() => {
              characterRuntimeStore.retry(selectedWorkspace.id)
            }}
            onSectionChange={view.setSettingsSection}
            onUnavailableAction={() =>
              view.setNotice({
                tone: "neutral",
                message: copy.pickerUnavailable,
              })
            }
            reducedMotion={view.reducedMotion}
            runtimeState={runtime.state}
            section={view.settingsSection}
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
