import { describe, expect, it } from "vitest"

import type { WorkspaceRecord } from "@/features/workspace-view/types"
import { projectWorkspaceNavigation } from "@/features/workspace-view/workspace-navigation"

function workspace(
  id: string,
  createdAt: string,
  updatedAt: string,
  projectId = "project-one",
): WorkspaceRecord {
  return {
    id,
    projectId,
    repository: "coding-wife",
    name: id,
    branch: `feature/${id}`,
    lifecycle: "backlog",
    createdAt,
    updatedAt,
  }
}

describe("projectWorkspaceNavigation", () => {
  it("keeps workspaces ordered by creation when selection updates another row", () => {
    const older = workspace(
      "workspace-older",
      "2026-07-18T00:00:00.000Z",
      "2026-07-20T00:00:00.000Z",
    )
    const newer = workspace(
      "workspace-newer",
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T00:00:00.000Z",
    )

    const navigation = projectWorkspaceNavigation([older, newer], older.id, [])

    expect(navigation.selectedWorkspace?.id).toBe(older.id)
    expect(navigation.filteredWorkspaces.map(({ id }) => id)).toEqual([
      newer.id,
      older.id,
    ])
  })

  it("uses workspace ID as the stable tie-breaker and preserves filter order", () => {
    const createdAt = "2026-07-19T00:00:00.000Z"
    const second = workspace(
      "workspace-b",
      createdAt,
      "2026-07-20T00:00:00.000Z",
    )
    const first = workspace(
      "workspace-a",
      createdAt,
      "2026-07-18T00:00:00.000Z",
    )
    const otherProject = workspace(
      "workspace-other",
      "2026-07-20T00:00:00.000Z",
      "2026-07-20T00:00:00.000Z",
      "project-other",
    )

    const navigation = projectWorkspaceNavigation(
      [second, otherProject, first],
      first.id,
      ["project-one"],
    )

    expect(navigation.filteredWorkspaces.map(({ id }) => id)).toEqual([
      first.id,
      second.id,
    ])
  })
})
