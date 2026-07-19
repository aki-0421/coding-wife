import { useEffect, useId, useState } from "react"
import { FolderPlusIcon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import type { ProjectRecord } from "@/features/workspace-view/types"
import { cn } from "@/lib/utils"

function defaultWorkspaceName(): string {
  const now = new Date()
  const part = (value: number) => value.toString().padStart(2, "0")
  const suffix =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().slice(0, 4)
      : Math.floor(Math.random() * 36 ** 4)
          .toString(36)
          .padStart(4, "0")
  return `ws-${part(now.getMonth() + 1)}${part(now.getDate())}-${suffix}`
}

function preferredProjectId(
  projects: readonly ProjectRecord[],
  selectedProjectId: string | undefined,
): string {
  return projects.some((project) => project.id === selectedProjectId)
    ? (selectedProjectId ?? "")
    : (projects[0]?.id ?? "")
}

interface WorkspaceCreateFormProps {
  readonly ariaLabel: string
  readonly autoFocusName?: boolean | undefined
  readonly className?: string | undefined
  readonly copy: WorkspaceCopy
  readonly onAddProject?: (() => void) | undefined
  readonly onCancel?: (() => void) | undefined
  readonly onCreate: (projectId: string, name: string) => Promise<boolean>
  readonly prominent?: boolean | undefined
  readonly projects: readonly ProjectRecord[]
  readonly selectedProjectId?: string | undefined
}

export function WorkspaceCreateForm({
  ariaLabel,
  autoFocusName = false,
  className,
  copy,
  onAddProject,
  onCancel,
  onCreate,
  prominent = false,
  projects,
  selectedProjectId,
}: WorkspaceCreateFormProps) {
  const projectFieldId = useId()
  const nameFieldId = useId()
  const [projectId, setProjectId] = useState(() =>
    preferredProjectId(projects, selectedProjectId),
  )
  const [name, setName] = useState(defaultWorkspaceName)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setProjectId((current) =>
      projects.some((project) => project.id === current)
        ? current
        : preferredProjectId(projects, selectedProjectId),
    )
  }, [projects, selectedProjectId])

  const submit = async () => {
    if (submitting || projectId.length === 0 || name.trim().length === 0) return
    setSubmitting(true)
    if (!(await onCreate(projectId, name))) setSubmitting(false)
  }

  return (
    <form
      aria-label={ariaLabel}
      className={cn("flex w-full flex-col gap-lg", className)}
      data-workspace-create-form=""
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <FieldGroup className="gap-md">
        <Field>
          <FieldLabel
            className={cn(prominent && "text-body font-medium")}
            htmlFor={projectFieldId}
          >
            {copy.createWorkspace.project}
          </FieldLabel>
          {projects.length === 0 ? (
            <Button
              className={cn(
                "justify-start",
                prominent ? "self-start rounded-lg px-lg" : "w-full",
              )}
              disabled={onAddProject === undefined || submitting}
              id={projectFieldId}
              onClick={onAddProject}
              size={prominent ? "lg" : "default"}
              type="button"
            >
              <FolderPlusIcon data-icon="inline-start" />
              {copy.addProject}
            </Button>
          ) : (
            <NativeSelect
              className={cn(
                "w-full",
                prominent && "[&_select]:h-9 [&_select]:rounded-lg",
              )}
              disabled={submitting}
              id={projectFieldId}
              onChange={(event) => setProjectId(event.currentTarget.value)}
              value={projectId}
            >
              {projects.map((project) => (
                <NativeSelectOption key={project.id} value={project.id}>
                  {project.githubRepository ?? project.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field>
          <FieldLabel
            className={cn(prominent && "text-body font-medium")}
            htmlFor={nameFieldId}
          >
            {copy.createWorkspace.name}
          </FieldLabel>
          <Input
            autoFocus={autoFocusName}
            className={cn(prominent && "h-9 rounded-lg px-md")}
            disabled={submitting}
            id={nameFieldId}
            maxLength={80}
            onChange={(event) => setName(event.currentTarget.value)}
            value={name}
          />
        </Field>
      </FieldGroup>

      {projects.length > 0 || onCancel !== undefined ? (
        <div className="flex items-center justify-end gap-xs">
          {onCancel !== undefined ? (
            <Button
              disabled={submitting}
              onClick={onCancel}
              type="button"
              variant="ghost"
            >
              {copy.createWorkspace.cancel}
            </Button>
          ) : null}
          {projects.length > 0 ? (
            <Button
              className={cn(prominent && "rounded-lg px-lg")}
              disabled={
                submitting || projectId.length === 0 || name.trim().length === 0
              }
              size={prominent ? "lg" : "default"}
              type="submit"
            >
              <PlusIcon data-icon="inline-start" />
              {submitting
                ? copy.createWorkspace.creating
                : copy.createWorkspace.create}
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  )
}
