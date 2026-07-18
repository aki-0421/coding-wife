import { useState } from "react"
import {
  CheckCircle2Icon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import type { GitReviewCopy } from "@/features/git-review/copy"
import type {
  RestoreKind,
  RestorePreview,
  RestoreResult,
} from "@/lib/contracts/git-review"

interface RestorePanelProps {
  readonly copy: GitReviewCopy
  readonly checkpointSha: string
  readonly guidance: readonly string[]
  readonly status:
    | "idle"
    | "previewing"
    | "ready"
    | "blocked"
    | "confirming"
    | "succeeded"
    | "error"
  readonly kind: RestoreKind | null
  readonly preview: RestorePreview | null
  readonly result: RestoreResult | null
  readonly errorCode: string | null
  readonly onPreview: (kind: RestoreKind, recoveryBranch: string | null) => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly onDismissResult: () => void
}

function RestoreConfirmation({
  copy,
  status,
  preview,
  onConfirm,
  onCancel,
}: {
  readonly copy: GitReviewCopy
  readonly status: RestorePanelProps["status"]
  readonly preview: RestorePreview
  readonly onConfirm: () => void
  readonly onCancel: () => void
}) {
  const confirming = status === "confirming"
  const isRevert = preview.kind === "revert_commit"

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open && !confirming) onCancel()
      }}
      open={status === "ready" || confirming}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <div className="flex items-center gap-sm">
            <ShieldAlertIcon
              aria-hidden="true"
              className={isRevert ? "text-destructive" : "text-branch-selected"}
            />
            <DialogTitle>{copy.restoreConfirmTitle}</DialogTitle>
          </div>
          <DialogDescription>
            {isRevert ? copy.restoreConfirmRevert : copy.restoreConfirmRecovery}
          </DialogDescription>
        </DialogHeader>

        <section
          aria-labelledby="restore-impact"
          className="flex flex-col gap-sm"
        >
          <h3 className="m-0 text-title text-text-strong" id="restore-impact">
            {copy.restoreImpact}
          </h3>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-md gap-y-xs text-caption">
            <dt className="text-muted-foreground">{copy.targetCommit}</dt>
            <dd className="m-0 break-all font-mono text-foreground">
              {preview.impact.targetCommitSha}
            </dd>
            <dt className="text-muted-foreground">{copy.currentHead}</dt>
            <dd className="m-0 break-all font-mono text-foreground">
              {preview.impact.currentHeadSha}
            </dd>
            <dt className="text-muted-foreground">{copy.affectedFiles}</dt>
            <dd className="m-0 text-foreground">
              {preview.impact.affectedFiles.length}
            </dd>
            <dt className="text-muted-foreground">{copy.additions}</dt>
            <dd className="m-0 font-mono text-success">
              +{preview.impact.additions}
            </dd>
            <dt className="text-muted-foreground">{copy.deletions}</dt>
            <dd className="m-0 font-mono text-destructive">
              −{preview.impact.deletions}
            </dd>
          </dl>
          <div className="flex flex-wrap gap-xs">
            {preview.impact.createsNewCommit ? (
              <Badge variant="destructive">
                <GitCommitHorizontalIcon aria-hidden="true" />
                {copy.createsNewCommit}
              </Badge>
            ) : null}
            {!preview.impact.checksOutBranch ? (
              <Badge variant="secondary">
                <GitBranchIcon aria-hidden="true" />
                {copy.noCheckout}
              </Badge>
            ) : null}
          </div>
          <div className="max-h-28 overflow-y-auto border-y border-divider py-xs">
            <ul className="m-0 flex list-none flex-col gap-xxs p-0 font-mono text-caption text-muted-foreground">
              {preview.impact.affectedFiles.map((file) => (
                <li className="break-all" key={file}>
                  {file}
                </li>
              ))}
            </ul>
          </div>
          {preview.expiresAt !== null ? (
            <p className="m-0 text-caption text-muted-foreground">
              {copy.expiresAt}:{" "}
              {new Date(preview.expiresAt).toLocaleTimeString()}
            </p>
          ) : null}
        </section>

        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={confirming} type="button" variant="secondary">
              {copy.cancel}
            </Button>
          </DialogClose>
          <Button
            disabled={confirming}
            onClick={onConfirm}
            type="button"
            variant={isRevert ? "destructive" : "default"}
          >
            {confirming ? (
              <LoaderCircleIcon
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            ) : isRevert ? (
              <RotateCcwIcon aria-hidden="true" />
            ) : (
              <GitBranchIcon aria-hidden="true" />
            )}
            {confirming
              ? copy.confirming
              : isRevert
                ? copy.confirmRevert
                : copy.confirmRecovery}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RestorePanel({
  copy,
  checkpointSha,
  guidance,
  status,
  kind,
  preview,
  result,
  errorCode,
  onPreview,
  onConfirm,
  onCancel,
  onDismissResult,
}: RestorePanelProps) {
  const [branch, setBranch] = useState(`recovery/${checkpointSha.slice(0, 8)}`)
  const busy = status === "previewing" || status === "confirming"

  return (
    <div className="mx-auto flex w-full max-w-[840px] flex-col gap-lg p-xl max-[680px]:p-md">
      <section
        className="flex flex-col gap-xs"
        aria-labelledby="restore-heading"
      >
        <h2 className="m-0 text-headline text-text-strong" id="restore-heading">
          {copy.restoreHeading}
        </h2>
        <p className="m-0 max-w-[75ch] text-caption text-muted-foreground">
          {copy.restoreDescription}
        </p>
      </section>

      {status === "blocked" && preview !== null ? (
        <Alert aria-live="polite">
          <ShieldAlertIcon aria-hidden="true" className="text-destructive" />
          <AlertTitle>{copy.restoreBlocked}</AlertTitle>
          <AlertDescription>
            <p className="m-0">{copy.restoreBlockedDescription}</p>
            <ul className="m-0 mt-xs flex flex-col gap-xxs pl-lg text-foreground">
              {preview.blockedReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {status === "error" ? (
        <Alert aria-live="polite">
          <TriangleAlertIcon aria-hidden="true" className="text-destructive" />
          <AlertTitle>{copy.restoreError}</AlertTitle>
          <AlertDescription>
            {copy.errorCode}: <span className="font-mono">{errorCode}</span>
          </AlertDescription>
        </Alert>
      ) : null}

      {status === "succeeded" && result !== null ? (
        <Alert aria-live="polite">
          <CheckCircle2Icon aria-hidden="true" className="text-success" />
          <AlertTitle>{copy.restoreSucceeded}</AlertTitle>
          <AlertDescription>
            <p className="m-0 text-foreground">
              {result.kind === "revert_commit"
                ? copy.revertSucceeded
                : copy.recoverySucceeded}
            </p>
            <p className="m-0 mt-xs break-all font-mono">
              {result.createdCommitSha ?? result.createdReference}
            </p>
            <Button
              className="mt-sm"
              onClick={onDismissResult}
              type="button"
              variant="secondary"
            >
              {copy.dismiss}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 border-t border-l border-divider max-[760px]:grid-cols-1">
        <section className="flex flex-col gap-md border-r border-b border-divider p-lg">
          <div className="flex items-start gap-sm">
            <RotateCcwIcon
              aria-hidden="true"
              className="mt-xxs size-4 text-destructive"
            />
            <div>
              <h3 className="m-0 text-title text-text-strong">
                {copy.revertTitle}
              </h3>
              <p className="m-0 mt-xs text-caption text-muted-foreground">
                {copy.revertDescription}
              </p>
            </div>
          </div>
          <Button
            className="self-start"
            disabled={busy}
            onClick={() => onPreview("revert_commit", null)}
            type="button"
            variant="destructive"
          >
            {status === "previewing" && kind === "revert_commit" ? (
              <LoaderCircleIcon
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            ) : (
              <RotateCcwIcon aria-hidden="true" />
            )}
            {status === "previewing" && kind === "revert_commit"
              ? copy.previewing
              : copy.previewRevert}
          </Button>
        </section>

        <section className="flex flex-col gap-md border-r border-b border-divider p-lg">
          <div className="flex items-start gap-sm">
            <GitBranchIcon
              aria-hidden="true"
              className="mt-xxs size-4 text-branch-selected"
            />
            <div>
              <h3 className="m-0 text-title text-text-strong">
                {copy.recoveryTitle}
              </h3>
              <p className="m-0 mt-xs text-caption text-muted-foreground">
                {copy.recoveryDescription}
              </p>
            </div>
          </div>
          <Field>
            <FieldLabel htmlFor="recovery-branch">
              {copy.recoveryBranchLabel}
            </FieldLabel>
            <Input
              autoComplete="off"
              id="recovery-branch"
              maxLength={200}
              onChange={(event) => setBranch(event.currentTarget.value)}
              spellCheck={false}
              value={branch}
            />
            <FieldDescription>{copy.noCheckout}</FieldDescription>
          </Field>
          <Button
            className="self-start"
            disabled={busy || branch.trim().length === 0}
            onClick={() => onPreview("recovery_branch", branch.trim())}
            type="button"
            variant="secondary"
          >
            {status === "previewing" && kind === "recovery_branch" ? (
              <LoaderCircleIcon
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            ) : (
              <GitBranchIcon aria-hidden="true" />
            )}
            {status === "previewing" && kind === "recovery_branch"
              ? copy.previewing
              : copy.previewRecovery}
          </Button>
        </section>
      </div>

      <Separator />
      <section className="flex flex-col gap-xs">
        <h2 className="m-0 text-title text-text-strong">
          {copy.restoreGuidance}
        </h2>
        <ol className="m-0 flex flex-col gap-xs pl-lg text-caption text-muted-foreground">
          {guidance.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </section>

      {preview?.status === "ready" ? (
        <RestoreConfirmation
          copy={copy}
          onCancel={onCancel}
          onConfirm={onConfirm}
          preview={preview}
          status={status}
        />
      ) : null}
    </div>
  )
}
