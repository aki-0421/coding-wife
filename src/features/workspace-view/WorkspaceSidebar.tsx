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

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import { ProjectFilterSelect } from "@/features/workspace-view/ProjectFilterSelect"
import { RepositoryAvatar } from "@/features/workspace-view/RepositoryAvatar"
import { WorkspaceLifecycleIcon } from "@/features/workspace-view/WorkspaceLifecycleStatus"
import { linearWorkspaceStatusLabels } from "@/features/workspace-view/workspace-navigation"
import { defaultWorkspaceName } from "@/features/workspace-view/workspace-name"
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

const sidebarIconButtonClassName = "text-muted-foreground"

interface WorkspaceSidebarProps {
  readonly appSettingsActive: boolean
  readonly copy: WorkspaceCopy
  readonly filteredWorkspaces: readonly WorkspaceRecord[]
  readonly projectFilterIds: readonly string[]
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
  readonly onProjectFilterChange: (projectIds: readonly string[]) => void
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
            className="flex h-full min-w-0 flex-1 items-center gap-sm rounded-control px-sm py-xs text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onSelect}
            type="button"
          >
            <RepositoryAvatar githubRepository={workspace.githubRepository} />
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
            className="mr-xs size-6 text-muted-foreground opacity-0 transition-opacity group-hover/workspace:opacity-100 group-focus-within/workspace:opacity-100 focus-visible:opacity-100"
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

function preferredWorkspaceProjectId(
  projects: readonly ProjectRecord[],
  projectFilterIds: readonly string[],
  selectedProjectId: string | undefined,
): string {
  if (
    selectedProjectId !== undefined &&
    projectFilterIds.includes(selectedProjectId) &&
    projects.some((project) => project.id === selectedProjectId)
  ) {
    return selectedProjectId
  }
  const firstFilteredProject = projects.find((project) =>
    projectFilterIds.includes(project.id),
  )
  if (firstFilteredProject !== undefined) {
    return firstFilteredProject.id
  }
  if (projects.some((project) => project.id === selectedProjectId)) {
    return selectedProjectId ?? ""
  }
  return projects[0]?.id ?? ""
}

function CreateWorkspaceButton({
  copy,
  projectFilterIds,
  projects,
  selectedProjectId,
  onCreate,
}: {
  readonly copy: WorkspaceCopy
  readonly projectFilterIds: readonly string[]
  readonly projects: readonly ProjectRecord[]
  readonly selectedProjectId?: string | undefined
  readonly onCreate: (projectId: string, name: string) => Promise<boolean>
}) {
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const projectId = preferredWorkspaceProjectId(
    projects,
    projectFilterIds,
    selectedProjectId,
  )
  const label = creating ? copy.createWorkspace.creating : copy.addWorkspace

  const createWorkspace = async () => {
    if (creatingRef.current || projectId.length === 0) return
    creatingRef.current = true
    setCreating(true)
    try {
      await onCreate(projectId, defaultWorkspaceName())
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-busy={creating}
            aria-label={label}
            className={sidebarIconButtonClassName}
            data-workspace-create=""
            disabled={creating || projectId.length === 0}
            onClick={() => void createWorkspace()}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <PlusIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <span className="sr-only" aria-live="polite">
        {creating ? copy.createWorkspace.creating : ""}
      </span>
    </>
  )
}

function SidebarPanel({
  appSettingsActive,
  copy,
  expandedLifecycles,
  filteredWorkspaces,
  projectFilterIds,
  projects,
  selectedProjectId,
  selectedWorkspaceId,
  archiveDisabledWorkspaceId,
  reserveTitlebarSpace,
  onAddProject,
  onCreateWorkspace,
  onProjectFilterChange,
  onOpenSettings,
  onRequestArchive,
  onSelectWorkspace,
  onToggleLifecycle,
}: SidebarPanelProps) {
  const [filterOpen, setFilterOpen] = useState(false)
  const lifecycleContentIdPrefix = useId()
  const projectFilterSelectId = useId()
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
          <Popover onOpenChange={setFilterOpen} open={filterOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    aria-label={copy.filterWorkspaces}
                    aria-pressed={projectFilterIds.length > 0}
                    className={cn(
                      "relative",
                      sidebarIconButtonClassName,
                      projectFilterIds.length > 0 &&
                        "bg-selected-row text-text-strong",
                    )}
                    data-workspace-filter-toggle=""
                    disabled={projects.length === 0}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <ListFilterIcon />
                    {projectFilterIds.length > 0 ? (
                      <Badge
                        aria-hidden="true"
                        className="absolute -top-1 -right-1 h-4 min-w-4 px-1"
                        data-workspace-filter-count=""
                        variant="default"
                      >
                        {projectFilterIds.length}
                      </Badge>
                    ) : null}
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>{copy.filterWorkspaces}</TooltipContent>
            </Tooltip>
            <PopoverContent align="end" className="w-[270px] p-sm">
              <Field className="flex-row items-center gap-sm">
                <FieldLabel
                  className="shrink-0 text-label font-medium text-foreground"
                  htmlFor={projectFilterSelectId}
                >
                  {copy.projectFilterLabel}
                </FieldLabel>
                <ProjectFilterSelect
                  copy={copy}
                  id={projectFilterSelectId}
                  onChange={onProjectFilterChange}
                  projects={projects}
                  selectedProjectIds={projectFilterIds}
                />
              </Field>
            </PopoverContent>
          </Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={copy.addProject}
                className={sidebarIconButtonClassName}
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
          <CreateWorkspaceButton
            copy={copy}
            onCreate={onCreateWorkspace}
            projectFilterIds={projectFilterIds}
            projects={projects}
            selectedProjectId={selectedProjectId}
          />
        </div>
      </div>

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
        </nav>
      </ScrollArea>

      <div className="flex h-[40.5px] shrink-0 items-center justify-end border-t border-divider px-md">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-current={appSettingsActive ? "page" : undefined}
              aria-label={copy.appSettings}
              className={cn(
                sidebarIconButtonClassName,
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
                className={cn("mt-xs", sidebarIconButtonClassName)}
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
                    className={sidebarIconButtonClassName}
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
            sidebarIconButtonClassName,
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
