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

export function workspaceProjectId(workspace: WorkspaceRecord): string {
  return workspace.projectId ?? `legacy:${workspace.repository}`
}

export function projectWorkspaceNavigation(
  workspaces: readonly WorkspaceRecord[],
  selectedWorkspaceId: string,
  projectFilterId: string,
): WorkspaceNavigationProjection {
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
    workspaces[0]
  const filteredWorkspaces =
    projectFilterId.length === 0
      ? workspaces
      : workspaces.filter(
          (workspace) => workspaceProjectId(workspace) === projectFilterId,
        )

  return { filteredWorkspaces, selectedWorkspace }
}
