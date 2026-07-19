import { useId, useMemo, useRef, useState } from "react"
import {
  ArchiveIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FolderPlusIcon,
  GitBranchIcon,
  ListFilterIcon,
  MenuIcon,
  PlusIcon,
  SettingsIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import { WorkspaceCreateForm } from "@/features/workspace-view/WorkspaceCreateForm"
import { RepositoryAvatar } from "@/features/workspace-view/RepositoryAvatar"
import { WorkspaceLifecycleIcon } from "@/features/workspace-view/WorkspaceLifecycleStatus"
import { linearWorkspaceStatusLabels } from "@/features/workspace-view/workspace-navigation"
import type {
  ProjectRecord,
  WorkspaceLifecycle,
  WorkspaceRecord,
} from "@/features/workspace-view/types"
import { cn } from "@/lib/utils"

const lifecycleOrder: readonly WorkspaceLifecycle[] = [
  "done",
  "in_review",
  "in_progress",
  "backlog",
  "canceled",
]

const initiallyExpandedLifecycles = {
  done: true,
  in_review: true,
  in_progress: true,
  backlog: true,
  canceled: true,
} as const satisfies Readonly<Record<WorkspaceLifecycle, boolean>>

interface WorkspaceSidebarProps {
  readonly appSettingsActive: boolean
  readonly copy: WorkspaceCopy
  readonly filter: string
  readonly filteredWorkspaces: readonly WorkspaceRecord[]
  readonly projects: readonly ProjectRecord[]
  readonly selectedProjectId?: string | undefined
  readonly selectedWorkspace?: WorkspaceRecord | undefined
  readonly selectedWorkspaceId: string
  readonly archiveDisabledWorkspaceId?: string | undefined
  readonly onAddProject: () => void
  readonly onCreateWorkspace: (
    projectId: string,
    name: string,
  ) => Promise<boolean>
  readonly onFilterChange: (value: string) => void
  readonly onOpenSettings: () => void
  readonly onRequestArchive: (workspace: WorkspaceRecord) => void
  readonly onSelectWorkspace: (workspaceId: string) => void
}

interface SidebarPanelProps extends WorkspaceSidebarProps {
  readonly expandedLifecycles: Readonly<Record<WorkspaceLifecycle, boolean>>
  readonly reserveTitlebarSpace: boolean
  readonly onToggleLifecycle: (lifecycle: WorkspaceLifecycle) => void
}

function WorkspaceRow({
  copy,
  selected,
  workspace,
  archiveDisabled,
  onArchive,
  onSelect,
}: {
  readonly copy: WorkspaceCopy
  readonly selected: boolean
  readonly workspace: WorkspaceRecord
  readonly archiveDisabled: boolean
  readonly onArchive: () => void
  readonly onSelect: () => void
}) {
  const repositoryLabel = workspace.githubRepository ?? workspace.repository
  const health =
    workspace.health === undefined || workspace.health === "ready"
      ? null
      : copy.workspaceHealth[workspace.health]

  return (
    <div
      className={cn(
        "group/workspace relative flex h-[49.5px] w-full items-center rounded-control transition-colors hover:bg-muted focus-within:bg-muted",
        selected && "bg-selected-row",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-current={selected ? "page" : undefined}
            aria-label={`${workspace.branch}, ${repositoryLabel}, ${linearWorkspaceStatusLabels[workspace.lifecycle]}${workspace.attention ? `, ${copy.attention[workspace.attention]}` : ""}${health ? `, ${health}` : ""}`}
            className="flex h-full min-w-0 flex-1 items-center gap-sm rounded-control px-sm py-xs pr-xl text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onSelect}
            type="button"
          >
            <RepositoryAvatar workspace={workspace} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-xxs">
                <GitBranchIcon
                  aria-hidden="true"
                  className={cn(
                    "size-3 shrink-0 text-muted-foreground",
                    selected && "text-branch-selected",
                  )}
                />
                <span
                  className={`truncate text-sidebar-item ${selected ? "text-text-strong" : "text-foreground"}`}
                >
                  {workspace.branch}
                </span>
              </span>
              <span className="flex min-w-0 items-center gap-xs">
                <span
                  className={`truncate font-mono text-sidebar-meta transition-colors group-hover/workspace:text-selected-row-secondary group-focus-within/workspace:text-selected-row-secondary ${selected ? "text-selected-row-secondary" : "text-muted-foreground"}`}
                >
                  {repositoryLabel}
                </span>
                {workspace.attention ? (
                  <CircleAlertIcon
                    aria-hidden="true"
                    className="size-3 shrink-0 text-destructive"
                  />
                ) : null}
                {health ? (
                  <span
                    className="flex min-w-0 items-center gap-xxs truncate text-destructive"
                    data-workspace-health={workspace.health}
                  >
                    <TriangleAlertIcon
                      aria-hidden="true"
                      className="size-3 shrink-0"
                    />
                    <span className="truncate text-label">{health}</span>
                  </span>
                ) : null}
              </span>
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {workspace.branch} · {repositoryLabel}
          {workspace.attention
            ? ` · ${copy.attention[workspace.attention]}`
            : ""}
          {health ? ` · ${health}` : ""}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={`${copy.archiveWorkspace}: ${workspace.name}`}
            className="absolute right-xs size-6 opacity-0 transition-opacity group-hover/workspace:opacity-100 group-focus-within/workspace:opacity-100 focus-visible:opacity-100"
            data-workspace-archive={workspace.id}
            disabled={archiveDisabled}
            onClick={onArchive}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <ArchiveIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">{copy.archiveWorkspace}</TooltipContent>
      </Tooltip>
    </div>
  )
}

function CreateWorkspaceDialog({
  copy,
  projects,
  selectedProjectId,
  onCreate,
}: {
  readonly copy: WorkspaceCopy
  readonly projects: readonly ProjectRecord[]
  readonly selectedProjectId?: string | undefined
  readonly onCreate: (projectId: string, name: string) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              aria-label={copy.addWorkspace}
              disabled={projects.length === 0}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <PlusIcon />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>{copy.addWorkspace}</TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.createWorkspace.title}</DialogTitle>
          <DialogDescription>
            {copy.createWorkspace.description}
          </DialogDescription>
        </DialogHeader>
        <WorkspaceCreateForm
          ariaLabel={copy.createWorkspace.title}
          autoFocusName
          copy={copy}
          onCancel={() => setOpen(false)}
          onCreate={async (projectId, name) => {
            const created = await onCreate(projectId, name)
            if (created) setOpen(false)
            return created
          }}
          projects={projects}
          selectedProjectId={selectedProjectId}
        />
      </DialogContent>
    </Dialog>
  )
}

function SidebarPanel({
  appSettingsActive,
  copy,
  expandedLifecycles,
  filter,
  filteredWorkspaces,
  projects,
  selectedProjectId,
  selectedWorkspaceId,
  archiveDisabledWorkspaceId,
  reserveTitlebarSpace,
  onAddProject,
  onCreateWorkspace,
  onFilterChange,
  onOpenSettings,
  onRequestArchive,
  onSelectWorkspace,
  onToggleLifecycle,
}: SidebarPanelProps) {
  const [filterVisible, setFilterVisible] = useState(false)
  const lifecycleContentIdPrefix = useId()
  const groups = useMemo(
    () =>
      lifecycleOrder.map((lifecycle) => ({
        lifecycle,
        workspaces: filteredWorkspaces.filter(
          (workspace) => workspace.lifecycle === lifecycle,
        ),
      })),
    [filteredWorkspaces],
  )

  return (
    <div className="flex size-full min-h-0 flex-col bg-sidebar">
      {reserveTitlebarSpace ? (
        <div className="h-[40.5px] shrink-0" aria-hidden="true" />
      ) : null}

      <div className="flex h-[40.5px] shrink-0 items-center justify-between px-md">
        <h1 className="m-0 text-sidebar-heading text-muted-foreground">
          {copy.workspaces}
        </h1>
        <div className="flex items-center gap-xxs">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={copy.filterWorkspaces}
                aria-pressed={filterVisible}
                data-workspace-filter-toggle=""
                onClick={() => setFilterVisible((current) => !current)}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <ListFilterIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{copy.filterWorkspaces}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={copy.addProject}
                onClick={onAddProject}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <FolderPlusIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{copy.addProject}</TooltipContent>
          </Tooltip>
          <CreateWorkspaceDialog
            copy={copy}
            onCreate={onCreateWorkspace}
            projects={projects}
            selectedProjectId={selectedProjectId}
          />
        </div>
      </div>

      {filterVisible ? (
        <div className="shrink-0 px-xs pb-xs">
          <Input
            aria-label={copy.filterWorkspaces}
            autoFocus
            maxLength={200}
            onChange={(event) => onFilterChange(event.currentTarget.value)}
            placeholder={copy.filterWorkspaces}
            value={filter}
          />
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1 px-xs">
        <nav
          aria-label={copy.workspaces}
          className="flex w-full max-w-[242.25px] flex-col pb-md"
        >
          {groups.map(({ lifecycle, workspaces }) => {
            const expanded = expandedLifecycles[lifecycle]
            const contentId = `${lifecycleContentIdPrefix}-${lifecycle}`

            return (
              <section className="flex flex-col pt-sm" key={lifecycle}>
                <h2 className="m-0">
                  <button
                    aria-controls={contentId}
                    aria-expanded={expanded}
                    className="group/status flex h-6 w-full cursor-pointer items-center gap-xs rounded-control px-xs text-start text-sidebar-status text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    data-workspace-status-toggle={lifecycle}
                    onClick={() => onToggleLifecycle(lifecycle)}
                    type="button"
                  >
                    <WorkspaceLifecycleIcon lifecycle={lifecycle} />
                    <span>{linearWorkspaceStatusLabels[lifecycle]}</span>
                    <span className="sr-only">({workspaces.length})</span>
                    <span className="ml-auto flex items-center gap-xxs">
                      {!expanded ? (
                        <span
                          aria-hidden="true"
                          className="tabular-nums text-label text-muted-foreground"
                          data-workspace-status-count={lifecycle}
                        >
                          {workspaces.length}
                        </span>
                      ) : null}
                      <ChevronRightIcon
                        aria-hidden="true"
                        className={cn(
                          "size-3 shrink-0 opacity-0 transition-[opacity,transform] duration-150 motion-reduce:transition-none group-hover/status:opacity-100 group-focus-visible/status:opacity-100",
                          expanded && "rotate-90",
                        )}
                        data-workspace-status-chevron=""
                      />
                    </span>
                  </button>
                </h2>
                <div hidden={!expanded} id={contentId}>
                  {workspaces.map((workspace) => (
                    <WorkspaceRow
                      archiveDisabled={
                        archiveDisabledWorkspaceId === workspace.id
                      }
                      copy={copy}
                      key={workspace.id}
                      onArchive={() => onRequestArchive(workspace)}
                      onSelect={() => onSelectWorkspace(workspace.id)}
                      selected={workspace.id === selectedWorkspaceId}
                      workspace={workspace}
                    />
                  ))}
                </div>
              </section>
            )
          })}

          {filteredWorkspaces.length === 0 && filter.length > 0 ? (
            <div className="flex flex-col items-start gap-xs px-sm py-lg">
              <p className="m-0 text-sidebar-helper text-muted-foreground">
                {copy.noMatches}
              </p>
              <Button
                onClick={() => onFilterChange("")}
                size="xs"
                type="button"
                variant="secondary"
              >
                {copy.clearFilter}
              </Button>
            </div>
          ) : null}
        </nav>
      </ScrollArea>

      <div className="flex h-[40.5px] shrink-0 items-center justify-end border-t border-divider px-md">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-current={appSettingsActive ? "page" : undefined}
              aria-label={copy.appSettings}
              className={cn(
                appSettingsActive && "bg-selected-row text-text-strong",
              )}
              data-app-settings-trigger=""
              onClick={onOpenSettings}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <SettingsIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{copy.appSettings}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export function WorkspaceSidebar(props: WorkspaceSidebarProps) {
  const [compactNavigationOpen, setCompactNavigationOpen] = useState(false)
  const [expandedLifecycles, setExpandedLifecycles] = useState<
    Readonly<Record<WorkspaceLifecycle, boolean>>
  >(() => ({ ...initiallyExpandedLifecycles }))
  const compactOpenerRef = useRef<HTMLButtonElement | null>(null)
  const selected = props.selectedWorkspace
  const toggleLifecycle = (lifecycle: WorkspaceLifecycle) => {
    setExpandedLifecycles((current) => ({
      ...current,
      [lifecycle]: !current[lifecycle],
    }))
  }

  const openCompactNavigation = (opener: HTMLButtonElement) => {
    compactOpenerRef.current = opener
    setCompactNavigationOpen(true)
  }

  const closeCompactNavigation = () => setCompactNavigationOpen(false)

  const selectFromCompactNavigation = (workspaceId: string) => {
    props.onSelectWorkspace(workspaceId)
    closeCompactNavigation()
  }

  return (
    <aside className="workspace-sidebar border-r border-divider">
      <div className="hidden size-full min-[1280px]:block">
        <SidebarPanel
          {...props}
          expandedLifecycles={expandedLifecycles}
          onToggleLifecycle={toggleLifecycle}
          reserveTitlebarSpace
        />
      </div>

      <div className="flex size-full flex-col items-center bg-sidebar min-[1280px]:hidden">
        <div className="h-[40.5px] shrink-0" aria-hidden="true" />
        <Dialog
          onOpenChange={setCompactNavigationOpen}
          open={compactNavigationOpen}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-controls="compact-workspace-navigation"
                aria-expanded={compactNavigationOpen}
                aria-haspopup="dialog"
                aria-label={props.copy.compactSidebar}
                className="mt-xs"
                data-workspace-navigation-toggle=""
                onClick={(event) => openCompactNavigation(event.currentTarget)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <MenuIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {props.copy.compactSidebar}
            </TooltipContent>
          </Tooltip>
          <DialogContent
            className="top-0 left-0 h-dvh max-h-dvh w-[255.04px] max-w-[255.04px] translate-x-0 translate-y-0 rounded-none border-y-0 border-l-0 p-0"
            id="compact-workspace-navigation"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              compactOpenerRef.current?.focus()
            }}
            onEscapeKeyDown={closeCompactNavigation}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeCompactNavigation()
            }}
            showCloseButton={false}
          >
            <DialogTitle className="sr-only">
              {props.copy.workspaces}
            </DialogTitle>
            <SidebarPanel
              {...props}
              expandedLifecycles={expandedLifecycles}
              onAddProject={() => {
                closeCompactNavigation()
                props.onAddProject()
              }}
              onCreateWorkspace={async (projectId, name) => {
                const created = await props.onCreateWorkspace(projectId, name)
                if (created) closeCompactNavigation()
                return created
              }}
              onOpenSettings={() => {
                closeCompactNavigation()
                props.onOpenSettings()
              }}
              onSelectWorkspace={selectFromCompactNavigation}
              onToggleLifecycle={toggleLifecycle}
              reserveTitlebarSpace={false}
            />
          </DialogContent>

          <div className="mt-md flex flex-1 flex-col items-center gap-sm">
            {selected ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-controls="compact-workspace-navigation"
                    aria-expanded={compactNavigationOpen}
                    aria-haspopup="dialog"
                    aria-label={`${props.copy.switchWorkspace}: ${selected.repository}/${selected.name}`}
                    onClick={(event) =>
                      openCompactNavigation(event.currentTarget)
                    }
                    size="icon-sm"
                    type="button"
                    variant="secondary"
                  >
                    <GitBranchIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {props.copy.switchWorkspace}: {selected.repository}/
                  {selected.name}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </Dialog>

        <Button
          aria-current={props.appSettingsActive ? "page" : undefined}
          aria-label={props.copy.appSettings}
          className={cn(
            "mb-xs",
            props.appSettingsActive && "bg-selected-row text-text-strong",
          )}
          data-app-settings-trigger=""
          onClick={props.onOpenSettings}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <SettingsIcon />
        </Button>
      </div>
    </aside>
  )
}
