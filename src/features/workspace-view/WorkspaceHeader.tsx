import { useState, type ReactNode } from "react"
import { GitBranchIcon, TriangleAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import { RepositoryAvatar } from "@/features/workspace-view/RepositoryAvatar"
import {
  workspaceTabs,
  type WorkspaceRecord,
  type WorkspaceTab,
} from "@/features/workspace-view/types"
import { cn } from "@/lib/utils"

interface WorkspaceHeaderProps {
  readonly activeTab: WorkspaceTab
  readonly copy: WorkspaceCopy
  readonly workspace: WorkspaceRecord
}

function WorkspaceHealthStatus({
  copy,
  workspace,
}: Pick<WorkspaceHeaderProps, "copy" | "workspace">) {
  if (workspace.health === undefined || workspace.health === "ready")
    return null
  return (
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
  )
}

function HeaderValueButton({
  children,
  className,
  copyLabel,
  current,
  onCopy,
  value,
}: {
  readonly children?: ReactNode
  readonly className?: string | undefined
  readonly copyLabel: string
  readonly current?: boolean | undefined
  readonly onCopy: () => void
  readonly value: string
}) {
  return (
    <Button
      aria-current={current ? "page" : undefined}
      aria-label={`${copyLabel}: ${value}`}
      className={cn("min-w-0 justify-start px-xs", className)}
      onClick={onCopy}
      size="xs"
      type="button"
      variant="ghost"
    >
      {children}
      <span className="min-w-0 flex-1 truncate text-start">{value}</span>
    </Button>
  )
}

export function WorkspaceHeader({
  activeTab,
  copy,
  workspace,
}: WorkspaceHeaderProps) {
  const [copyAnnouncement, setCopyAnnouncement] = useState("")
  const repository = workspace.githubRepository ?? workspace.repository

  const copyHeaderValue = async (value: string) => {
    try {
      if (navigator.clipboard?.writeText === undefined) {
        throw new Error("Clipboard is unavailable")
      }
      await navigator.clipboard.writeText(value)
      setCopyAnnouncement(`${copy.headerCopy.copied}: ${value}`)
    } catch {
      setCopyAnnouncement(copy.headerCopy.failed)
    }
  }

  return (
    <header className="workspace-header border-b border-divider bg-surface">
      <div className="flex h-[40px] min-w-0 items-center gap-sm px-xl">
        <RepositoryAvatar githubRepository={workspace.githubRepository} />
        <Breadcrumb aria-label={copy.repositoryBreadcrumb} className="min-w-0">
          <BreadcrumbList className="min-w-0 flex-nowrap gap-sm text-display">
            <BreadcrumbItem className="min-w-0 max-w-56 shrink">
              <HeaderValueButton
                className="w-full text-display font-medium text-muted-foreground"
                copyLabel={copy.headerCopy.repository}
                onCopy={() => void copyHeaderValue(repository)}
                value={repository}
              />
            </BreadcrumbItem>
            <BreadcrumbSeparator className="shrink-0 text-text-disabled" />
            <BreadcrumbItem className="min-w-0 max-w-64 shrink">
              <HeaderValueButton
                className="w-full text-display font-semibold text-text-strong"
                copyLabel={copy.headerCopy.workspace}
                current
                onCopy={() => void copyHeaderValue(workspace.name)}
                value={workspace.name}
              />
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <HeaderValueButton
          className="hidden max-w-52 shrink font-mono text-label text-muted-foreground min-[1120px]:inline-flex"
          copyLabel={copy.headerCopy.branch}
          onCopy={() => void copyHeaderValue(workspace.branch)}
          value={workspace.branch}
        >
          <GitBranchIcon aria-hidden="true" data-icon="inline-start" />
        </HeaderValueButton>
        <WorkspaceHealthStatus copy={copy} workspace={workspace} />
        <span aria-hidden="true" className="h-full min-w-12 flex-1" />
        <span aria-live="polite" className="sr-only" role="status">
          {copyAnnouncement}
        </span>
      </div>

      <div className="flex h-[40px] min-w-0 items-end overflow-x-auto px-xl">
        <TabsList aria-label="Workspace views" className="h-full gap-xl">
          {workspaceTabs.map((tab) => (
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
