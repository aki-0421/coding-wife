import type { WorkspaceRecord } from "@/features/workspace-view/types"

export const initialWorkspaces: readonly WorkspaceRecord[] = [
  {
    id: "sol-desktop",
    repository: "coding-wife",
    githubRepository: "aki-0421/coding-wife",
    name: "sol-desktop",
    branch: "main",
    lifecycle: "done",
  },
  {
    id: "docs-driven-architecture",
    repository: "coding-wife",
    githubRepository: "aki-0421/coding-wife",
    name: "docs-driven-architecture",
    branch: "docs/history-kernel",
    lifecycle: "in_review",
  },
  {
    id: "build-live2d-desktop-app",
    repository: "coding-wife",
    githubRepository: "aki-0421/coding-wife",
    name: "build-live2d-desktop-app",
    branch: "feature/live2d-companion",
    lifecycle: "in_progress",
    attention: "test_failed",
  },
]
