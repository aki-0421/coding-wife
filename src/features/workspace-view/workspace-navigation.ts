import type { WorkspaceRecord } from "@/features/workspace-view/types"

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
          [workspace.repository, workspace.name, workspace.branch].some(
            (value) => value.toLocaleLowerCase().includes(query),
          ),
        )

  return { filteredWorkspaces, selectedWorkspace }
}
