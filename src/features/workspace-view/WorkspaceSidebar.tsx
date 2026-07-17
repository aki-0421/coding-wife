import { useMemo, useRef, useState } from "react"
import {
  CheckIcon,
  CircleAlertIcon,
  FolderPlusIcon,
  GitBranchIcon,
  ListFilterIcon,
  MenuIcon,
  PlusIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import type {
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

interface WorkspaceSidebarProps {
  readonly copy: WorkspaceCopy
  readonly filter: string
  readonly filteredWorkspaces: readonly WorkspaceRecord[]
  readonly selectedWorkspace: WorkspaceRecord
  readonly selectedWorkspaceId: string
  readonly onAddProject: () => void
  readonly onCreateWorkspace: (name: string, goal: string) => Promise<boolean>
  readonly onFilterChange: (value: string) => void
  readonly onOpenSettings: () => void
  readonly onSelectWorkspace: (workspaceId: string) => void
}

function StatusMarker({
  lifecycle,
}: {
  readonly lifecycle: WorkspaceLifecycle
}) {
  if (lifecycle === "done") {
    return (
      <span
        aria-hidden="true"
        className="flex size-[10.5px] shrink-0 items-center justify-center rounded-circle bg-warm-active text-[7px] text-app-bg"
      >
        <CheckIcon className="size-[7px]" />
      </span>
    )
  }

  if (lifecycle === "canceled") {
    return (
      <span
        aria-hidden="true"
        className="flex size-[10.5px] shrink-0 items-center justify-center rounded-circle bg-canceled text-[7px] text-app-bg"
      >
        <XIcon className="size-[7px]" />
      </span>
    )
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-[10.5px] shrink-0 rounded-circle border-[1.5px]",
        lifecycle === "in_review" && "border-success",
        lifecycle === "in_progress" && "border-running",
        lifecycle === "backlog" && "border-dashed border-muted-foreground",
      )}
    />
  )
}

function WorkspaceRow({
  copy,
  selected,
  workspace,
  onSelect,
}: {
  readonly copy: WorkspaceCopy
  readonly selected: boolean
  readonly workspace: WorkspaceRecord
  readonly onSelect: () => void
}) {
  const fullName = `${workspace.repository}/${workspace.name}`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-current={selected ? "page" : undefined}
          aria-label={`${fullName}, ${workspace.branch}, ${copy.lifecycle[workspace.lifecycle]}${workspace.attention ? `, ${copy.attention[workspace.attention]}` : ""}`}
          className={cn(
            "group/workspace flex h-[49.5px] w-full items-center gap-sm rounded-control px-sm py-xs text-start outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
            selected && "bg-selected-row",
          )}
          onClick={onSelect}
          type="button"
        >
          <GitBranchIcon
            aria-hidden="true"
            className={cn(
              "size-3 shrink-0 text-muted-foreground",
              selected && "text-branch-selected",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className={cn(
                "truncate text-body text-foreground",
                selected && "font-medium text-text-strong",
              )}
            >
              {fullName}
            </span>
            <span className="flex min-w-0 items-center gap-xs">
              <span
                className={cn(
                  "truncate font-mono text-label text-muted-foreground transition-colors group-hover/workspace:text-selected-row-secondary group-focus-visible/workspace:text-selected-row-secondary",
                  selected && "text-selected-row-secondary",
                )}
              >
                {workspace.branch}
              </span>
              {workspace.attention ? (
                <CircleAlertIcon
                  aria-hidden="true"
                  className="size-3 shrink-0 text-destructive"
                />
              ) : null}
            </span>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {fullName} · {workspace.branch}
        {workspace.attention ? ` · ${copy.attention[workspace.attention]}` : ""}
      </TooltipContent>
    </Tooltip>
  )
}

function CreateWorkspaceDialog({
  copy,
  onCreate,
}: {
  readonly copy: WorkspaceCopy
  readonly onCreate: (name: string, goal: string) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [goal, setGoal] = useState("")

  const submit = async () => {
    if (await onCreate(name, goal)) {
      setName("")
      setGoal("")
      setOpen(false)
    }
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              aria-label={copy.addWorkspace}
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
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="workspace-name">
              {copy.createWorkspace.name}
            </FieldLabel>
            <Input
              autoFocus
              id="workspace-name"
              maxLength={80}
              onChange={(event) => setName(event.currentTarget.value)}
              value={name}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="workspace-goal">
              {copy.createWorkspace.goal}
            </FieldLabel>
            <Textarea
              id="workspace-goal"
              maxLength={4000}
              onChange={(event) => setGoal(event.currentTarget.value)}
              rows={4}
              value={goal}
            />
            <FieldDescription>
              {goal.length.toLocaleString()} / 4,000
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {copy.createWorkspace.cancel}
            </Button>
          </DialogClose>
          <Button
            disabled={name.trim().length === 0}
            onClick={() => void submit()}
            type="button"
          >
            {copy.createWorkspace.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SidebarPanel({
  copy,
  filter,
  filteredWorkspaces,
  selectedWorkspaceId,
  showTrafficLights,
  onAddProject,
  onCreateWorkspace,
  onFilterChange,
  onOpenSettings,
  onSelectWorkspace,
}: WorkspaceSidebarProps & { readonly showTrafficLights: boolean }) {
  const [filterVisible, setFilterVisible] = useState(false)
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
      {showTrafficLights ? (
        <div
          className="flex h-[40.5px] shrink-0 items-center px-lg"
          aria-hidden="true"
        >
          <span className="flex gap-sm">
            <span className="size-3 rounded-circle bg-[#ff5f57]" />
            <span className="size-3 rounded-circle bg-[#febc2e]" />
            <span className="size-3 rounded-circle bg-[#28c840]" />
          </span>
        </div>
      ) : null}

      <div className="flex h-[40.5px] shrink-0 items-center justify-between px-md">
        <h1 className="m-0 text-headline text-muted-foreground">
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
          <CreateWorkspaceDialog copy={copy} onCreate={onCreateWorkspace} />
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
        <nav aria-label={copy.workspaces} className="flex flex-col pb-md">
          {groups.map(({ lifecycle, workspaces }) => (
            <section className="flex flex-col pt-sm" key={lifecycle}>
              <h2 className="m-0 flex h-6 items-center gap-xs px-xs text-title font-medium text-muted-foreground">
                <StatusMarker lifecycle={lifecycle} />
                <span>{copy.lifecycle[lifecycle]}</span>
                <span className="sr-only">({workspaces.length})</span>
              </h2>
              {workspaces.map((workspace) => (
                <WorkspaceRow
                  copy={copy}
                  key={workspace.id}
                  onSelect={() => onSelectWorkspace(workspace.id)}
                  selected={workspace.id === selectedWorkspaceId}
                  workspace={workspace}
                />
              ))}
            </section>
          ))}

          {filteredWorkspaces.length === 0 ? (
            <div className="flex flex-col items-start gap-xs px-sm py-lg">
              <p className="m-0 text-caption text-muted-foreground">
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
              aria-label={copy.settings}
              onClick={onOpenSettings}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <SettingsIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{copy.settings}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export function WorkspaceSidebar(props: WorkspaceSidebarProps) {
  const [compactNavigationOpen, setCompactNavigationOpen] = useState(false)
  const compactOpenerRef = useRef<HTMLButtonElement | null>(null)
  const selected = props.selectedWorkspace

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
        <SidebarPanel {...props} showTrafficLights />
      </div>

      <div className="flex size-full flex-col items-center bg-sidebar min-[1280px]:hidden">
        <div className="flex h-[40.5px] items-center gap-xs" aria-hidden="true">
          <span className="size-xs rounded-circle bg-[#ff5f57]" />
          <span className="size-xs rounded-circle bg-[#febc2e]" />
          <span className="size-xs rounded-circle bg-[#28c840]" />
        </div>
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
              onAddProject={() => {
                closeCompactNavigation()
                props.onAddProject()
              }}
              onCreateWorkspace={async (name, goal) => {
                const created = await props.onCreateWorkspace(name, goal)
                if (created) closeCompactNavigation()
                return created
              }}
              onOpenSettings={() => {
                closeCompactNavigation()
                props.onOpenSettings()
              }}
              onSelectWorkspace={selectFromCompactNavigation}
              showTrafficLights={false}
            />
          </DialogContent>

          <div className="mt-md flex flex-1 flex-col items-center gap-sm">
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
          </div>
        </Dialog>

        <Button
          aria-label={props.copy.settings}
          className="mb-xs"
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
