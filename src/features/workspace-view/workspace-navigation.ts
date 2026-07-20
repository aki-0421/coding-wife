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

function compareWorkspaceCreation(
  left: WorkspaceRecord,
  right: WorkspaceRecord,
): number {
  const leftCreatedAt =
    left.createdAt === undefined ? Number.NaN : Date.parse(left.createdAt)
  const rightCreatedAt =
    right.createdAt === undefined ? Number.NaN : Date.parse(right.createdAt)
  const leftHasCreation = Number.isFinite(leftCreatedAt)
  const rightHasCreation = Number.isFinite(rightCreatedAt)

  if (leftHasCreation && rightHasCreation) {
    const creationDifference = rightCreatedAt - leftCreatedAt
    if (creationDifference !== 0) return creationDifference
    if (left.id !== right.id) return left.id < right.id ? -1 : 1
  } else if (leftHasCreation !== rightHasCreation) {
    return leftHasCreation ? -1 : 1
  }

  return 0
}

function workspacesByCreation(
  workspaces: readonly WorkspaceRecord[],
): readonly WorkspaceRecord[] {
  return [...workspaces].sort(compareWorkspaceCreation)
}

export function projectWorkspaceNavigation(
  workspaces: readonly WorkspaceRecord[],
  selectedWorkspaceId: string,
  projectFilterIds: readonly string[],
): WorkspaceNavigationProjection {
  const orderedWorkspaces = workspacesByCreation(workspaces)
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
    workspaces[0]
  const filteredWorkspaces =
    projectFilterIds.length === 0
      ? orderedWorkspaces
      : orderedWorkspaces.filter((workspace) =>
          projectFilterIds.includes(workspaceProjectId(workspace)),
        )

  return { filteredWorkspaces, selectedWorkspace }
}
