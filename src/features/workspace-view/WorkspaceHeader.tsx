import {
  ChevronRightIcon,
  EllipsisIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  SparklesIcon,
  WifiOffIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
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

export function WorkspaceHeader({
  activeTab,
  connection,
  copy,
  workspace,
}: WorkspaceHeaderProps) {
  return (
    <header className="workspace-header border-b border-divider bg-surface">
      <div
        className="flex h-[40px] min-w-0 items-center gap-sm px-xl"
        data-tauri-drag-region=""
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={copy.appMark}
              className="flex size-6 shrink-0 items-center justify-center rounded-control border border-warm-active/40 bg-warm-active text-app-bg"
              role="img"
            >
              <SparklesIcon aria-hidden="true" className="size-3" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{copy.appMark}</TooltipContent>
        </Tooltip>
        <span className="shrink-0 text-display font-medium text-muted-foreground">
          {workspace.repository}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3 shrink-0 text-text-disabled"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 truncate text-display font-semibold text-text-strong">
              {workspace.name}
            </span>
          </TooltipTrigger>
          <TooltipContent>{workspace.name}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="hidden min-w-0 items-center gap-xxs font-mono text-label text-muted-foreground min-[1120px]:flex">
              <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
              <span className="max-w-44 truncate">{workspace.branch}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>{workspace.branch}</TooltipContent>
        </Tooltip>
        <Button
          aria-label={copy.workspaceActions}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <EllipsisIcon />
        </Button>
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
