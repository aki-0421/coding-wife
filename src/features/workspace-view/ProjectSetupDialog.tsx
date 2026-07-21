import { useState } from "react"
import { AlertCircleIcon, CloudIcon, GitBranchIcon } from "lucide-react"

import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import type { ProjectSetupState } from "@/features/workspace-view/useWorkspaceViewModel"

interface ProjectSetupDialogProps {
  readonly copy: WorkspaceCopy
  readonly setup: ProjectSetupState
  readonly onCancel: () => void
  readonly onInitializeGit: () => void
  readonly onSetupGithub: (owner: string, repository: string) => void
}

function repositoryNameIsValid(value: string): boolean {
  const normalized = value.trim()
  return (
    normalized.length > 0 &&
    normalized.length <= 100 &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.toLowerCase().endsWith(".git") &&
    /^[A-Za-z0-9._-]+$/u.test(normalized)
  )
}

function githubOwnerError(
  copy: WorkspaceCopy,
  status: ProjectSetupState["candidate"]["githubOwnerStatus"],
): string | null {
  if (status === "cli_missing") return copy.projectSetup.githubCliMissing
  if (status === "auth_required") return copy.projectSetup.githubAuthRequired
  if (status === "unavailable") return copy.projectSetup.githubUnavailable
  return null
}

function setupError(copy: WorkspaceCopy, code: string | null): string | null {
  if (code === null) return null
  if (code.includes("REPOSITORY-NAME")) {
    return copy.projectSetup.invalidRepository
  }
  if (code.includes("CLI-MISSING")) {
    return copy.projectSetup.githubCliMissing
  }
  if (code.includes("AUTH")) return copy.projectSetup.githubAuthRequired
  return copy.projectSetup.genericError
}

export function ProjectSetupDialog({
  copy,
  setup,
  onCancel,
  onInitializeGit,
  onSetupGithub,
}: ProjectSetupDialogProps) {
  const { candidate } = setup
  const [owner, setOwner] = useState(candidate.githubOwners[0] ?? "")
  const [repository, setRepository] = useState(
    candidate.suggestedRepositoryName,
  )
  const [repositoryTouched, setRepositoryTouched] = useState(false)
  const processing = setup.status !== "idle"
  const selectedOwner = candidate.githubOwners.includes(owner)
    ? owner
    : (candidate.githubOwners[0] ?? "")
  const repositoryValid = repositoryNameIsValid(repository)
  const ownerError = githubOwnerError(copy, candidate.githubOwnerStatus)
  const actionError = setupError(copy, setup.errorCode)
  const githubReady =
    candidate.githubOwnerStatus === "ready" && selectedOwner.length > 0

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open && !processing) onCancel()
      }}
      open
    >
      <DialogContent
        aria-describedby={undefined}
        closeLabel={copy.projectSetup.close}
        onEscapeKeyDown={(event) => {
          if (processing) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (processing) event.preventDefault()
        }}
        showCloseButton={!processing}
      >
        <DialogHeader>
          <DialogTitle className="text-balance">
            {copy.projectSetup.title}
          </DialogTitle>
        </DialogHeader>

        {candidate.gitStatus === "not_initialized" ? (
          <div className="flex flex-col gap-md">
            {actionError !== null ? (
              <Alert aria-live="assertive">
                <AlertCircleIcon className="text-destructive" />
                <AlertTitle>{actionError}</AlertTitle>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button
                disabled={processing}
                onClick={onCancel}
                type="button"
                variant="secondary"
              >
                {setup.status === "canceling"
                  ? copy.projectSetup.canceling
                  : copy.projectSetup.cancel}
              </Button>
              <Button
                disabled={processing}
                onClick={onInitializeGit}
                type="button"
              >
                <GitBranchIcon data-icon="inline-start" />
                {setup.status === "initializing_git"
                  ? copy.projectSetup.initializingGit
                  : copy.projectSetup.initializeGit}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="flex flex-col gap-md"
            onSubmit={(event) => {
              event.preventDefault()
              setRepositoryTouched(true)
              if (githubReady && repositoryValid && !processing) {
                onSetupGithub(selectedOwner, repository.trim())
              }
            }}
          >
            <FieldGroup
              className="flex-row items-start gap-xs"
              data-project-repository-slug=""
            >
              <Field
                className="min-w-0 flex-1"
                data-disabled={!githubReady || processing}
              >
                <Select
                  disabled={!githubReady || processing}
                  onValueChange={setOwner}
                  value={selectedOwner}
                >
                  <SelectTrigger
                    aria-label={copy.projectSetup.ownerAccessibilityLabel}
                    className="w-full"
                    id="project-setup-owner"
                    size="sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {candidate.githubOwners.map((githubOwner) => (
                        <SelectItem key={githubOwner} value={githubOwner}>
                          {githubOwner}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <span
                aria-hidden="true"
                className="flex h-8 shrink-0 items-center text-body text-muted-foreground"
              >
                /
              </span>
              <Field
                className="min-w-0 flex-1"
                data-invalid={repositoryTouched && !repositoryValid}
              >
                <Input
                  aria-label={copy.projectSetup.repositoryAccessibilityLabel}
                  aria-invalid={repositoryTouched && !repositoryValid}
                  disabled={processing}
                  id="project-setup-repository"
                  maxLength={100}
                  onBlur={() => setRepositoryTouched(true)}
                  onChange={(event) => setRepository(event.currentTarget.value)}
                  value={repository}
                />
                {repositoryTouched && !repositoryValid ? (
                  <FieldDescription role="alert">
                    {copy.projectSetup.invalidRepository}
                  </FieldDescription>
                ) : null}
              </Field>
            </FieldGroup>
            {ownerError !== null || actionError !== null ? (
              <Alert aria-live="assertive">
                <AlertCircleIcon className="text-destructive" />
                <AlertTitle>{actionError ?? ownerError}</AlertTitle>
              </Alert>
            ) : null}
            <p className="sr-only" aria-live="polite">
              {setup.status === "setting_up_github"
                ? copy.projectSetup.settingUpGithub
                : setup.status === "initializing_git"
                  ? copy.projectSetup.initializingGit
                  : setup.status === "checking_github"
                    ? copy.projectSetup.checkingGithub
                    : ""}
            </p>
            <DialogFooter>
              <Button
                disabled={processing}
                onClick={onCancel}
                type="button"
                variant="secondary"
              >
                {setup.status === "canceling"
                  ? copy.projectSetup.canceling
                  : copy.projectSetup.cancel}
              </Button>
              {githubReady ? (
                <Button disabled={processing || !repositoryValid} type="submit">
                  <CloudIcon data-icon="inline-start" />
                  {setup.status === "setting_up_github"
                    ? copy.projectSetup.settingUpGithub
                    : copy.projectSetup.setupGithub}
                </Button>
              ) : (
                <Button
                  disabled={processing}
                  onClick={onInitializeGit}
                  type="button"
                >
                  {setup.status === "checking_github"
                    ? copy.projectSetup.checkingGithub
                    : copy.projectSetup.retryGithub}
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
