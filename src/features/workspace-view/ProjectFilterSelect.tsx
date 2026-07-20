import { useId, useMemo, useState } from "react"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

import { AvatarGroup } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import { RepositoryAvatar } from "@/features/workspace-view/RepositoryAvatar"
import type { ProjectRecord } from "@/features/workspace-view/types"

interface ProjectFilterSelectProps {
  readonly copy: WorkspaceCopy
  readonly id: string
  readonly projects: readonly ProjectRecord[]
  readonly selectedProjectIds: readonly string[]
  readonly onChange: (projectIds: readonly string[]) => void
}

function projectLabel(project: ProjectRecord): string {
  return project.githubRepository ?? project.name
}

export function ProjectFilterSelect({
  copy,
  id,
  projects,
  selectedProjectIds,
  onChange,
}: ProjectFilterSelectProps) {
  const [open, setOpen] = useState(false)
  const optionsId = useId()
  const selectedProjects = useMemo(
    () => projects.filter((project) => selectedProjectIds.includes(project.id)),
    [projects, selectedProjectIds],
  )
  const selectedProject = selectedProjects[0]

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-controls={optionsId}
          aria-expanded={open}
          aria-haspopup="listbox"
          className="min-w-0 flex-1 justify-between px-sm font-normal"
          data-workspace-project-filter=""
          id={id}
          role="combobox"
          size="sm"
          type="button"
          variant="outline"
        >
          {selectedProjects.length === 0 ? (
            <span className="truncate text-muted-foreground">
              {copy.allProjects}
            </span>
          ) : selectedProjects.length === 1 && selectedProject !== undefined ? (
            <span className="flex min-w-0 items-center gap-xs">
              <RepositoryAvatar
                githubRepository={selectedProject.githubRepository}
              />
              <span className="truncate">{projectLabel(selectedProject)}</span>
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-xs">
              <AvatarGroup aria-hidden="true" className="shrink-0">
                {selectedProjects.slice(0, 2).map((project) => (
                  <RepositoryAvatar
                    githubRepository={project.githubRepository}
                    key={project.id}
                  />
                ))}
              </AvatarGroup>
              <span className="truncate">
                {copy.selectedProjects(selectedProjects.length)}
              </span>
            </span>
          )}
          <ChevronDownIcon aria-hidden="true" className="ml-xs size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-xs!">
        <ToggleGroup
          aria-label={copy.projectFilterLabel}
          aria-multiselectable="true"
          className="w-full flex-col items-stretch"
          id={optionsId}
          onValueChange={(values) => {
            const selected = new Set(values)
            onChange(
              projects
                .filter((project) => selected.has(project.id))
                .map((project) => project.id),
            )
          }}
          orientation="vertical"
          role="listbox"
          type="multiple"
          value={[...selectedProjectIds]}
        >
          {projects.map((project) => {
            const selected = selectedProjectIds.includes(project.id)
            return (
              <ToggleGroupItem
                aria-selected={selected}
                className="h-8 w-full justify-start gap-xs px-sm text-start"
                key={project.id}
                role="option"
                value={project.id}
              >
                <RepositoryAvatar githubRepository={project.githubRepository} />
                <span className="min-w-0 flex-1 truncate">
                  {projectLabel(project)}
                </span>
                <CheckIcon
                  aria-hidden="true"
                  className={selected ? "opacity-100" : "opacity-0"}
                />
              </ToggleGroupItem>
            )
          })}
        </ToggleGroup>
      </PopoverContent>
    </Popover>
  )
}
