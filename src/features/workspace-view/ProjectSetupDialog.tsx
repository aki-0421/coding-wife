import { useState } from "react"
import { AlertCircleIcon, CloudIcon, GitBranchIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Separator } from "@/components/ui/separator"
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
          <DialogDescription className="text-pretty">
            {copy.projectSetup.description(candidate.folderName)}
          </DialogDescription>
        </DialogHeader>

        {candidate.gitStatus === "not_initialized" ? (
          <section
            className="flex flex-col gap-md"
            aria-labelledby="git-setup-title"
          >
            <div className="flex items-start gap-sm">
              <GitBranchIcon className="mt-xxs text-muted-foreground" />
              <div className="flex min-w-0 flex-col gap-xxs">
                <h2
                  className="m-0 text-title text-text-strong"
                  id="git-setup-title"
                >
                  {copy.projectSetup.gitTitle}
                </h2>
                <p className="m-0 text-pretty text-caption text-muted-foreground">
                  {copy.projectSetup.gitDescription}
                </p>
              </div>
            </div>
            {actionError !== null ? (
              <Alert aria-live="assertive">
                <AlertCircleIcon className="text-destructive" />
                <AlertTitle>{copy.projectSetup.genericError}</AlertTitle>
                <AlertDescription>{actionError}</AlertDescription>
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
          </section>
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
            <div className="flex items-start gap-sm">
              <CloudIcon className="mt-xxs text-muted-foreground" />
              <div className="flex min-w-0 flex-col gap-xxs">
                <h2 className="m-0 text-title text-text-strong">
                  {copy.projectSetup.githubTitle}
                </h2>
                <p className="m-0 text-pretty text-caption text-muted-foreground">
                  {copy.projectSetup.githubDescription}
                </p>
              </div>
            </div>
            <Separator />
            <FieldGroup>
              <Field data-disabled={!githubReady || processing}>
                <FieldLabel htmlFor="project-setup-owner">
                  {copy.projectSetup.ownerLabel}
                </FieldLabel>
                <NativeSelect
                  className="w-full"
                  disabled={!githubReady || processing}
                  id="project-setup-owner"
                  onChange={(event) => setOwner(event.currentTarget.value)}
                  size="sm"
                  value={selectedOwner}
                >
                  {candidate.githubOwners.map((githubOwner) => (
                    <NativeSelectOption key={githubOwner} value={githubOwner}>
                      {githubOwner}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field data-invalid={repositoryTouched && !repositoryValid}>
                <FieldLabel htmlFor="project-setup-repository">
                  {copy.projectSetup.repositoryLabel}
                </FieldLabel>
                <Input
                  aria-invalid={repositoryTouched && !repositoryValid}
                  disabled={processing}
                  id="project-setup-repository"
                  maxLength={100}
                  onBlur={() => setRepositoryTouched(true)}
                  onChange={(event) => setRepository(event.currentTarget.value)}
                  value={repository}
                />
                <FieldDescription>
                  {repositoryTouched && !repositoryValid
                    ? copy.projectSetup.invalidRepository
                    : copy.projectSetup.repositoryHint}
                </FieldDescription>
              </Field>
            </FieldGroup>
            {ownerError !== null || actionError !== null ? (
              <Alert aria-live="assertive">
                <AlertCircleIcon className="text-destructive" />
                <AlertTitle>{copy.projectSetup.genericError}</AlertTitle>
                <AlertDescription>{actionError ?? ownerError}</AlertDescription>
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
