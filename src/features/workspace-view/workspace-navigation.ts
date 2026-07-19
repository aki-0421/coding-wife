import type {
  WorkspaceLifecycle,
  WorkspaceRecord,
} from "@/features/workspace-view/types"

export const linearWorkspaceStatusLabels = {
  done: "Done",
  in_review: "In Review",
  in_progress: "In Progress",
  backlog: "Backlog",
  canceled: "Canceled",
} as const satisfies Readonly<Record<WorkspaceLifecycle, string>>

export interface WorkspaceNavigationProjection {
  readonly selectedWorkspace: WorkspaceRecord | undefined
  readonly filteredWorkspaces: readonly WorkspaceRecord[]
}

export function projectWorkspaceNavigation(
  workspaces: readonly WorkspaceRecord[],
  selectedWorkspaceId: string,
  filter: string,
): WorkspaceNavigationProjection {
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
    workspaces[0]
  const query = filter.trim().toLocaleLowerCase()
  const filteredWorkspaces =
    query.length === 0
      ? workspaces
      : workspaces.filter((workspace) =>
          [
            workspace.repository,
            workspace.githubRepository,
            workspace.name,
            workspace.branch,
          ].some((value) => value?.toLocaleLowerCase().includes(query)),
        )

  return { filteredWorkspaces, selectedWorkspace }
}
