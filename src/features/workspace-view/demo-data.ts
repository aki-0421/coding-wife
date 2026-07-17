import type { WorkspaceRecord } from "@/features/workspace-view/types"

export const initialWorkspaces: readonly WorkspaceRecord[] = [
  {
    id: "sol-desktop",
    repository: "coding-wife",
    name: "sol-desktop",
    branch: "main",
    lifecycle: "done",
  },
  {
    id: "docs-driven-architecture",
    repository: "coding-wife",
    name: "docs-driven-architecture",
    branch: "docs/history-kernel",
    lifecycle: "in_review",
  },
  {
    id: "build-live2d-desktop-app",
    repository: "coding-wife",
    name: "build-live2d-desktop-app",
    branch: "feature/live2d-companion",
    lifecycle: "in_progress",
    attention: "test_failed",
  },
]
