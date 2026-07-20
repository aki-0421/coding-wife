import { useRef, useState } from "react"
import { AlertCircleIcon, FolderPlusIcon } from "lucide-react"

import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import { RepositoryAvatar } from "@/features/workspace-view/RepositoryAvatar"
import type { ProjectRecord } from "@/features/workspace-view/types"
import { defaultWorkspaceName } from "@/features/workspace-view/workspace-name"

interface WorkspaceProjectSelectionProps {
  readonly copy: WorkspaceCopy
  readonly onAddProject?: (() => void) | undefined
  readonly onCreate: (projectId: string, name: string) => Promise<boolean>
  readonly onCreated?: (() => void) | undefined
  readonly onCreatingChange?: ((creating: boolean) => void) | undefined
  readonly projects: readonly ProjectRecord[]
}

export function WorkspaceProjectSelection({
  copy,
  onAddProject,
  onCreate,
  onCreated,
  onCreatingChange,
  projects,
}: WorkspaceProjectSelectionProps) {
  const [creatingProjectId, setCreatingProjectId] = useState<string | null>(
    null,
  )
  const [creationFailed, setCreationFailed] = useState(false)
  const creatingRef = useRef(false)
  const creating = creatingProjectId !== null

  const createWorkspace = async (projectId: string) => {
    if (creatingRef.current) return
    creatingRef.current = true
    setCreatingProjectId(projectId)
    setCreationFailed(false)
    onCreatingChange?.(true)
    let created = false
    try {
      created = await onCreate(projectId, defaultWorkspaceName())
      if (!created) setCreationFailed(true)
    } finally {
      creatingRef.current = false
      setCreatingProjectId(null)
      onCreatingChange?.(false)
    }
    if (created) onCreated?.()
  }

  if (projects.length === 0) {
    return (
      <Button
        className="self-start"
        data-workspace-empty-add-project=""
        disabled={onAddProject === undefined}
        onClick={onAddProject}
        size="lg"
        type="button"
      >
        <FolderPlusIcon data-icon="inline-start" />
        {copy.addProject}
      </Button>
    )
  }

  return (
    <div
      className="flex w-full flex-col gap-sm"
      data-workspace-project-selection=""
    >
      <div className="grid grid-cols-3 gap-sm" data-workspace-project-grid="">
        {projects.map((project) => {
          const projectLabel = project.githubRepository ?? project.name
          const projectCreating = creatingProjectId === project.id

          return (
            <Button
              aria-busy={projectCreating}
              className="h-16 min-w-0 justify-start gap-sm overflow-hidden px-md py-sm text-start"
              data-project-id={project.id}
              data-workspace-project-card=""
              disabled={creating}
              key={project.id}
              onClick={() => void createWorkspace(project.id)}
              type="button"
              variant="outline"
            >
              <RepositoryAvatar
                githubRepository={project.githubRepository}
                size="default"
              />
              <span className="flex min-w-0 flex-1 flex-col items-start">
                <span className="max-w-full truncate text-title">
                  {projectLabel}
                </span>
                {projectCreating ? (
                  <span className="text-label text-muted-foreground">
                    {copy.createWorkspace.creating}
                  </span>
                ) : null}
              </span>
            </Button>
          )
        })}
      </div>
      {creationFailed ? (
        <Alert aria-live="assertive">
          <AlertCircleIcon className="text-destructive" />
          <AlertTitle>{copy.createWorkspace.failed}</AlertTitle>
        </Alert>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {creating ? copy.createWorkspace.creating : ""}
      </span>
    </div>
  )
}
