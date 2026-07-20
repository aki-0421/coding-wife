import type { WorkspaceRecord } from "@/features/workspace-view/types"

export const initialWorkspaces: readonly WorkspaceRecord[] = [
  {
    id: "sol-desktop",
    projectId: "project-demo",
    repository: "coding-wife",
    githubRepository: "aki-0421/coding-wife",
    name: "sol-desktop",
    branch: "main",
    lifecycle: "done",
  },
  {
    id: "docs-driven-architecture",
    projectId: "project-demo",
    repository: "coding-wife",
    githubRepository: "aki-0421/coding-wife",
    name: "docs-driven-architecture",
    branch: "docs/history-kernel",
    lifecycle: "in_review",
  },
  {
    id: "build-live2d-desktop-app",
    projectId: "project-demo",
    repository: "coding-wife",
    githubRepository: "aki-0421/coding-wife",
    name: "build-live2d-desktop-app",
    branch: "feature/live2d-character",
    lifecycle: "in_progress",
    attention: "test_failed",
  },
]
