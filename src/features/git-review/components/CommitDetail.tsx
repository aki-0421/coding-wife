import { useState } from "react"
import {
  ClipboardIcon,
  LoaderCircleIcon,
  MessageCircleMoreIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ChangesPanel } from "@/features/git-review/components/ChangesPanel"
import type { GitReviewCopy } from "@/features/git-review/copy"
import { formatRelativeTime } from "@/features/git-review/relative-time"
import type { CommitExplanationState } from "@/features/git-review/store"
import type {
  CommitDiffFile,
  CommitEvidenceDetail,
  CommitExplanationControllerStateV1,
  CommitExplanationPresentationMode,
  CommitExplanationUserRequestTrigger,
} from "@/lib/contracts/git-review"

export interface CommitDetailProps {
  readonly copy: GitReviewCopy
  readonly locale: "ja" | "en"
  readonly detail: CommitEvidenceDetail
  readonly selectedFileEvidenceId: string | null
  readonly diffStatus: "idle" | "loading" | "ready" | "error"
  readonly diff: CommitDiffFile | null
  readonly explanationIntent: CommitExplanationState
  readonly explanationControllerAvailable: boolean
  readonly explanationContextReady: boolean
  readonly explanationControllerState: CommitExplanationControllerStateV1 | null
  readonly onSelectFile: (fileEvidenceId: string) => void
  readonly onRequestExplanation: (
    trigger: CommitExplanationUserRequestTrigger,
    presentationTrigger: HTMLButtonElement,
  ) => void
  readonly onCancelExplanation: (
    state: CommitExplanationControllerStateV1,
  ) => void
  readonly onPresentExplanation: (
    state: CommitExplanationControllerStateV1,
    mode: CommitExplanationPresentationMode,
    trigger: HTMLButtonElement,
  ) => void
}

type ExplanationAction =
  | {
      readonly kind: "request"
      readonly trigger: "user_request" | "user_retry"
    }
  | { readonly kind: "present" }
  | { readonly kind: "cancel" }
  | { readonly kind: "disabled" }

export function CommitDetail({
  copy,
  locale,
  detail,
  selectedFileEvidenceId,
  diffStatus,
  diff,
  explanationIntent,
  explanationControllerAvailable,
  explanationContextReady,
  explanationControllerState,
  onSelectFile,
  onRequestExplanation,
  onCancelExplanation,
  onPresentExplanation,
}: CommitDetailProps) {
  const [copiedSha, setCopiedSha] = useState(false)
  const controllerStatus =
    explanationControllerState?.status ??
    (explanationControllerAvailable ? "not_generated" : "unavailable")
  const intentBusy =
    explanationIntent.status === "preparing" ||
    explanationIntent.status === "canceling"

  let action: ExplanationAction
  let actionLabel: string
  if (intentBusy) {
    action = { kind: "disabled" }
    actionLabel =
      explanationIntent.status === "canceling"
        ? copy.explainCanceling
        : copy.explainPreparing
  } else if (controllerStatus === "not_generated") {
    action = { kind: "request", trigger: "user_request" }
    actionLabel = copy.explain
  } else if (controllerStatus === "queued" || controllerStatus === "running") {
    if (explanationControllerState?.presentationAvailable) {
      action = { kind: "present" }
      actionLabel = copy.showExplanation
    } else if (explanationControllerState?.trigger === "auto_verified_commit") {
      action = { kind: "request", trigger: "user_request" }
      actionLabel = copy.explain
    } else {
      action = { kind: "cancel" }
      actionLabel = copy.cancelExplanation
    }
  } else if (controllerStatus === "generated") {
    action = { kind: "present" }
    actionLabel = copy.showExplanation
  } else if (
    controllerStatus === "failed" ||
    controllerStatus === "canceled" ||
    (controllerStatus === "unavailable" &&
      explanationControllerState?.retryable)
  ) {
    action = { kind: "request", trigger: "user_retry" }
    actionLabel = copy.retryExplanation
  } else {
    action = { kind: "disabled" }
    actionLabel = copy.explain
  }

  const copySha = async () => {
    try {
      await navigator.clipboard.writeText(detail.identity.commitSha)
      setCopiedSha(true)
      window.setTimeout(() => setCopiedSha(false), 1_500)
    } catch {
      setCopiedSha(false)
    }
  }

  const performExplanationAction = (trigger: HTMLButtonElement) => {
    if (action.kind === "request") {
      onRequestExplanation(action.trigger, trigger)
    } else if (
      action.kind === "present" &&
      explanationControllerState !== null
    ) {
      onPresentExplanation(explanationControllerState, "show", trigger)
    } else if (
      action.kind === "cancel" &&
      explanationControllerState !== null
    ) {
      onCancelExplanation(explanationControllerState)
    }
  }

  const explanationUnavailable =
    explanationIntent.status === "error" || controllerStatus === "unavailable"

  return (
    <article
      className="flex min-h-0 flex-col"
      aria-labelledby="selected-commit-subject"
    >
      <header
        className="group flex min-h-[78px] flex-wrap items-start gap-md border-b border-divider px-lg py-sm max-[680px]:px-md"
        data-git-review-header=""
      >
        <div className="min-w-0 flex-1">
          <h1
            className="m-0 text-headline text-text-strong"
            data-commit-detail-heading=""
            id="selected-commit-subject"
            tabIndex={-1}
          >
            {detail.identity.subject}
          </h1>
          <p className="m-0 mt-xxs flex min-w-0 flex-wrap items-center gap-xs text-caption text-muted-foreground">
            <span>{detail.identity.authorName}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={detail.identity.authoredAt}>
              {formatRelativeTime(detail.identity.authoredAt, locale)}
            </time>
            <span aria-hidden="true">·</span>
            <code className="font-mono text-foreground">
              {detail.identity.commitSha.slice(0, 7)}
            </code>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={copy.copySha}
                  className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
                  onClick={() => void copySha()}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <ClipboardIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{copy.copySha}</TooltipContent>
            </Tooltip>
            {copiedSha ? (
              <span aria-live="polite" className="sr-only" role="status">
                {copy.copied}
              </span>
            ) : null}
          </p>
          <p className="m-0 mt-xs flex items-center gap-sm text-caption">
            <span>{copy.filesChanged(detail.diffSummary.filesChanged)}</span>
            <span className="text-success">
              +{detail.diffSummary.additions}
            </span>
            <span className="text-destructive">
              −{detail.diffSummary.deletions}
            </span>
          </p>
        </div>

        <div className="ml-auto flex max-w-[250px] flex-col items-end gap-xxs">
          <Button
            aria-busy={intentBusy || undefined}
            disabled={
              action.kind === "disabled" ||
              (action.kind === "request" && !explanationContextReady)
            }
            onClick={(event) => performExplanationAction(event.currentTarget)}
            type="button"
            variant="ghost"
          >
            {intentBusy ? (
              <LoaderCircleIcon
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
                data-icon="inline-start"
              />
            ) : action.kind === "cancel" ? (
              <XIcon aria-hidden="true" data-icon="inline-start" />
            ) : action.kind === "request" && action.trigger === "user_retry" ? (
              <RotateCcwIcon aria-hidden="true" data-icon="inline-start" />
            ) : (
              <MessageCircleMoreIcon
                aria-hidden="true"
                data-icon="inline-start"
              />
            )}
            {actionLabel}
          </Button>
          {explanationUnavailable ? (
            <span
              aria-live={
                explanationIntent.status === "error" ? "polite" : undefined
              }
              className="text-right text-label text-muted-foreground"
              role={explanationIntent.status === "error" ? "status" : undefined}
            >
              {copy.explainUnavailable}
            </span>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <ChangesPanel
          copy={copy}
          detail={detail}
          diff={diff}
          diffStatus={diffStatus}
          onSelectFile={onSelectFile}
          selectedFileEvidenceId={selectedFileEvidenceId}
        />
      </div>
    </article>
  )
}
