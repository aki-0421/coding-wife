import { useEffect, useRef, useState } from "react"
import {
  BanIcon,
  EllipsisIcon,
  FolderMinusIcon,
  FolderSearchIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  WifiOffIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import { RepositoryAvatar } from "@/features/workspace-view/RepositoryAvatar"
import type {
  WorkspaceRecord,
  WorkspaceTab,
} from "@/features/workspace-view/types"
import { cn } from "@/lib/utils"

export type HeaderConnectionState = "checking" | "preview" | "offline" | "ready"

interface WorkspaceHeaderProps {
  readonly activeTab: WorkspaceTab
  readonly connection: HeaderConnectionState
  readonly copy: WorkspaceCopy
  readonly workspace: WorkspaceRecord
  readonly actionPending: "cancel" | "repair" | "unregister" | null
  readonly canCancel: boolean
  readonly canRepair: boolean
  readonly canUnregister: boolean
  readonly turnActive: boolean
  readonly onCancel: (stopFirst: boolean) => Promise<boolean>
  readonly onRepair: () => Promise<boolean>
  readonly onUnregister: () => Promise<boolean>
}

const tabOrder: readonly WorkspaceTab[] = [
  "chat",
  "commit",
  "context",
  "settings",
]

function ConnectionStatus({
  connection,
  copy,
}: Pick<WorkspaceHeaderProps, "connection" | "copy">) {
  return (
    <span
      className={cn(
        "ml-auto flex shrink-0 items-center gap-xs text-label",
        connection === "ready" && "text-success",
        connection === "checking" && "text-running",
        (connection === "preview" || connection === "offline") &&
          "text-muted-foreground",
      )}
      role="status"
    >
      {connection === "checking" ? (
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-3 animate-spin motion-reduce:animate-none"
        />
      ) : connection === "offline" ? (
        <WifiOffIcon aria-hidden="true" className="size-3" />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "size-[7px] rounded-circle border",
            connection === "ready"
              ? "border-success bg-success/20"
              : "rotate-45 rounded-[1px] border-muted-foreground",
          )}
        />
      )}
      <span>{copy.connection[connection]}</span>
    </span>
  )
}

function WorkspaceHealthStatus({
  copy,
  workspace,
}: Pick<WorkspaceHeaderProps, "copy" | "workspace">) {
  if (workspace.health === undefined || workspace.health === "ready")
    return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex min-w-0 items-center gap-xxs text-label text-destructive"
          data-workspace-health={workspace.health}
          role="status"
        >
          <TriangleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="hidden max-w-48 truncate min-[1180px]:inline">
            {copy.workspaceHealth[workspace.health]}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{copy.workspaceHealth[workspace.health]}</TooltipContent>
    </Tooltip>
  )
}

type ConfirmationStage = "cancel" | "unregister" | "unregister_final" | null

function WorkspaceActions(props: WorkspaceHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<ConfirmationStage>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const safeActionRef = useRef<HTMLButtonElement | null>(null)
  const busy = props.actionPending !== null
  const cancelDisabled =
    busy ||
    !props.canCancel ||
    props.workspace.lifecycle === "canceled" ||
    props.workspace.lifecycle === "done"
  const repairDisabled = busy || !props.canRepair || props.turnActive
  const unregisterDisabled = busy || !props.canUnregister || props.turnActive
  const recheckRepository = props.workspace.health === "stale_branch"

  const closeConfirmation = () => setConfirmation(null)
  const completeCancel = async () => {
    if (await props.onCancel(props.turnActive)) closeConfirmation()
  }
  const completeUnregister = async () => {
    if (await props.onUnregister()) closeConfirmation()
  }

  useEffect(() => {
    if (confirmation === null) return
    const frame = window.requestAnimationFrame(() =>
      safeActionRef.current?.focus(),
    )
    return () => window.cancelAnimationFrame(frame)
  }, [confirmation])

  return (
    <>
      <Popover onOpenChange={setMenuOpen} open={menuOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-label={props.copy.workspaceActions}
            ref={triggerRef}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <EllipsisIcon />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-72 gap-xxs p-xs"
          data-workspace-action-menu=""
        >
          <Button
            className="h-auto justify-start gap-sm px-sm py-xs text-start"
            disabled={cancelDisabled}
            onClick={() => {
              setMenuOpen(false)
              setConfirmation("cancel")
            }}
            type="button"
            variant="ghost"
          >
            <BanIcon className="size-3 shrink-0" />
            <span className="flex min-w-0 flex-col items-start">
              <span>{props.copy.workspaceMenu.cancel}</span>
              <span className="whitespace-normal text-caption font-normal text-muted-foreground">
                {props.copy.workspaceMenu.cancelDescription}
              </span>
            </span>
          </Button>
          {props.workspace.health !== undefined &&
          props.workspace.health !== "ready" ? (
            <Button
              className="h-auto justify-start gap-sm px-sm py-xs text-start"
              disabled={repairDisabled}
              onClick={() => {
                setMenuOpen(false)
                void props.onRepair()
              }}
              type="button"
              variant="ghost"
            >
              {recheckRepository ? (
                <RefreshCwIcon className="size-3 shrink-0" />
              ) : (
                <FolderSearchIcon className="size-3 shrink-0" />
              )}
              <span className="flex min-w-0 flex-col items-start">
                <span>
                  {recheckRepository
                    ? props.copy.workspaceMenu.recheckRepository
                    : props.copy.workspaceMenu.repair}
                </span>
                <span className="whitespace-normal text-caption font-normal text-muted-foreground">
                  {props.turnActive
                    ? props.copy.workspaceMenu.runningBlocked
                    : recheckRepository
                      ? props.copy.workspaceMenu.recheckDescription
                      : props.copy.workspaceMenu.repairDescription}
                </span>
              </span>
            </Button>
          ) : null}
          <Button
            className="h-auto justify-start gap-sm px-sm py-xs text-start text-destructive hover:text-destructive"
            disabled={unregisterDisabled}
            onClick={() => {
              setMenuOpen(false)
              setConfirmation("unregister")
            }}
            type="button"
            variant="ghost"
          >
            <FolderMinusIcon className="size-3 shrink-0" />
            <span className="flex min-w-0 flex-col items-start">
              <span>{props.copy.workspaceMenu.unregister}</span>
              <span className="whitespace-normal text-caption font-normal text-muted-foreground">
                {props.turnActive
                  ? props.copy.workspaceMenu.runningBlocked
                  : props.copy.workspaceMenu.unregisterDescription}
              </span>
            </span>
          </Button>
        </PopoverContent>
      </Popover>

      <Dialog
        onOpenChange={(open) => {
          if (!open && !busy) closeConfirmation()
        }}
        open={confirmation !== null}
      >
        <DialogContent
          closeLabel={props.copy.dismiss}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            window.requestAnimationFrame(() => triggerRef.current?.focus())
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            if (!busy) closeConfirmation()
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            safeActionRef.current?.focus()
          }}
          showCloseButton={!busy}
        >
          <DialogHeader>
            <DialogTitle>
              {confirmation === "cancel"
                ? props.copy.workspaceMenu.cancelTitle
                : confirmation === "unregister"
                  ? props.copy.workspaceMenu.unregisterTitle
                  : props.copy.workspaceMenu.unregisterFinalTitle}
            </DialogTitle>
            <DialogDescription>
              {confirmation === "cancel"
                ? props.turnActive
                  ? props.copy.workspaceMenu.cancelRunningBody
                  : props.copy.workspaceMenu.cancelBody
                : confirmation === "unregister"
                  ? props.copy.workspaceMenu.unregisterBody
                  : props.copy.workspaceMenu.unregisterFinalBody}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={busy}
              onClick={closeConfirmation}
              ref={safeActionRef}
              type="button"
              variant="ghost"
            >
              {props.copy.workspaceMenu.keepWorkspace}
            </Button>
            {confirmation === "unregister" ? (
              <Button
                onClick={() => setConfirmation("unregister_final")}
                type="button"
                variant="secondary"
              >
                {props.copy.workspaceMenu.continueUnregister}
              </Button>
            ) : confirmation === "unregister_final" ? (
              <Button
                disabled={busy}
                onClick={() => void completeUnregister()}
                type="button"
                variant="destructive"
              >
                {busy
                  ? props.copy.workspaceMenu.working
                  : props.copy.workspaceMenu.confirmUnregister}
              </Button>
            ) : (
              <Button
                disabled={busy}
                onClick={() => void completeCancel()}
                type="button"
                variant="destructive"
              >
                {busy
                  ? props.copy.workspaceMenu.working
                  : props.turnActive
                    ? props.copy.workspaceMenu.stopAndCancel
                    : props.copy.workspaceMenu.confirmCancel}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function WorkspaceHeader({
  activeTab,
  actionPending,
  canCancel,
  canRepair,
  canUnregister,
  connection,
  copy,
  onCancel,
  onRepair,
  onUnregister,
  turnActive,
  workspace,
}: WorkspaceHeaderProps) {
  return (
    <header className="workspace-header border-b border-divider bg-surface">
      <div className="flex h-[40px] min-w-0 items-center gap-sm px-xl">
        <RepositoryAvatar workspace={workspace} />
        <Breadcrumb aria-label={copy.repositoryBreadcrumb} className="min-w-0">
          <BreadcrumbList className="min-w-0 flex-nowrap gap-sm text-display">
            <BreadcrumbItem className="min-w-0 max-w-56 shrink">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="truncate font-medium text-muted-foreground">
                    {workspace.githubRepository ?? workspace.repository}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {workspace.githubRepository ?? workspace.repository}
                </TooltipContent>
              </Tooltip>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="shrink-0 text-text-disabled" />
            <BreadcrumbItem className="min-w-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <BreadcrumbPage className="truncate font-semibold text-text-strong">
                    {workspace.name}
                  </BreadcrumbPage>
                </TooltipTrigger>
                <TooltipContent>{workspace.name}</TooltipContent>
              </Tooltip>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="hidden min-w-0 items-center gap-xxs font-mono text-label text-muted-foreground min-[1120px]:flex">
              <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
              <span className="max-w-44 truncate">{workspace.branch}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>{workspace.branch}</TooltipContent>
        </Tooltip>
        <WorkspaceHealthStatus copy={copy} workspace={workspace} />
        <span aria-hidden="true" className="h-full min-w-12 flex-1" />
        <WorkspaceActions
          actionPending={actionPending}
          activeTab={activeTab}
          canCancel={canCancel}
          canRepair={canRepair}
          canUnregister={canUnregister}
          connection={connection}
          copy={copy}
          onCancel={onCancel}
          onRepair={onRepair}
          onUnregister={onUnregister}
          turnActive={turnActive}
          workspace={workspace}
        />
        <ConnectionStatus connection={connection} copy={copy} />
      </div>

      <div className="flex h-[40px] min-w-0 items-end overflow-x-auto px-xl">
        <TabsList aria-label="Workspace views" className="h-full gap-xl">
          {tabOrder.map((tab) => (
            <TabsTrigger
              className="h-full px-xxs after:absolute after:inset-x-0 after:bottom-0 after:h-[1.5px] after:bg-warm-active after:opacity-0 after:transition-opacity data-[state=active]:after:opacity-100"
              key={tab}
              value={tab}
            >
              {copy.tabs[tab]}
              {tab === "chat" && workspace.attention ? (
                <Badge
                  className="ml-xxs h-[16px] min-w-[16px] px-xxs"
                  variant="destructive"
                >
                  1
                </Badge>
              ) : null}
              {activeTab === tab ? (
                <span className="sr-only">({copy.active})</span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </header>
  )
}
