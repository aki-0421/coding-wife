import { useState } from "react"
import {
  CheckIcon,
  ClipboardIcon,
  EyeIcon,
  GitCommitHorizontalIcon,
  LoaderCircleIcon,
  MessageCircleMoreIcon,
  RotateCcwIcon,
  Volume2Icon,
  XIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ChangesPanel } from "@/features/git-review/components/ChangesPanel"
import { EvidenceSections } from "@/features/git-review/components/EvidenceSections"
import type { GitReviewCopy } from "@/features/git-review/copy"
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
  ) => void
  readonly onCancelExplanation: (
    state: CommitExplanationControllerStateV1,
  ) => void
  readonly onPresentExplanation: (
    state: CommitExplanationControllerStateV1,
    mode: CommitExplanationPresentationMode,
  ) => void
}

function formatDate(value: string, locale: "ja" | "en") {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value))
}

function MetadataRow({
  label,
  children,
}: {
  readonly label: string
  readonly children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-md border-b border-divider py-xs text-caption max-[560px]:grid-cols-1 max-[560px]:gap-xxs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 break-all">{children}</dd>
    </div>
  )
}

function Overview({
  copy,
  detail,
  locale,
}: Pick<CommitDetailProps, "copy" | "detail" | "locale">) {
  const unresolvedRisks = detail.risks.filter((risk) => !risk.resolved)
  const [copied, setCopied] = useState(false)

  const copySha = async () => {
    try {
      await navigator.clipboard.writeText(detail.identity.commitSha)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <ScrollArea className="size-full">
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-xl p-xl max-[680px]:p-md">
        <section
          className="flex flex-col gap-sm"
          aria-labelledby="commit-message"
        >
          <h2
            className="m-0 text-headline text-text-strong"
            id="commit-message"
          >
            {copy.message}
          </h2>
          {detail.identity.body ? (
            <pre className="m-0 max-w-[75ch] whitespace-pre-wrap font-sans text-body text-foreground">
              {detail.identity.body}
            </pre>
          ) : (
            <p className="m-0 text-caption text-muted-foreground">—</p>
          )}
        </section>

        <section
          className="flex flex-col gap-sm"
          aria-labelledby="commit-identity"
        >
          <h2
            className="m-0 text-headline text-text-strong"
            id="commit-identity"
          >
            {copy.identity}
          </h2>
          <dl className="m-0 border-t border-divider">
            <MetadataRow label={copy.fullSha}>
              <span className="flex min-w-0 items-center gap-xs">
                <code className="min-w-0 flex-1 break-all font-mono">
                  {detail.identity.commitSha}
                </code>
                <Button
                  aria-label={copy.copySha}
                  onClick={() => void copySha()}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  {copied ? <CheckIcon /> : <ClipboardIcon />}
                </Button>
                {copied ? <span className="sr-only">{copy.copied}</span> : null}
              </span>
            </MetadataRow>
            <MetadataRow label={copy.author}>
              {detail.identity.authorName} &lt;{detail.identity.authorEmail}&gt;
            </MetadataRow>
            <MetadataRow label={copy.authored}>
              {formatDate(detail.identity.authoredAt, locale)}
            </MetadataRow>
            <MetadataRow label={copy.committed}>
              {formatDate(detail.identity.committedAt, locale)}
            </MetadataRow>
            <MetadataRow label={copy.parents}>
              {detail.identity.parents.length === 0
                ? "—"
                : detail.identity.parents
                    .map((parent) => parent.slice(0, 12))
                    .join(", ")}
            </MetadataRow>
          </dl>
        </section>

        <section
          className="flex flex-col gap-sm"
          aria-labelledby="work-correlation"
        >
          <h2
            className="m-0 text-headline text-text-strong"
            id="work-correlation"
          >
            {copy.correlation}
          </h2>
          <dl className="m-0 border-t border-divider">
            <MetadataRow label={copy.workUnit}>
              {detail.workUnitId ?? copy.uncorrelated}
            </MetadataRow>
            <MetadataRow label={copy.sourceEvent}>
              {detail.sourceEventId ?? "—"}
            </MetadataRow>
            <MetadataRow label={copy.beforeObservation}>
              {detail.beforeObservationId ?? "—"}
            </MetadataRow>
            <MetadataRow label={copy.afterObservation}>
              {detail.afterObservationId ?? "—"}
            </MetadataRow>
            <MetadataRow label={copy.observedAt}>
              {formatDate(detail.observedAt, locale)}
            </MetadataRow>
          </dl>
        </section>

        {detail.objective !== null || detail.acceptance.length > 0 ? (
          <section
            className="flex flex-col gap-sm"
            aria-labelledby="work-objective"
          >
            <h2
              className="m-0 text-headline text-text-strong"
              id="work-objective"
            >
              {copy.objective}
            </h2>
            {detail.objective !== null ? (
              <p className="m-0">{detail.objective}</p>
            ) : null}
            {detail.acceptance.length > 0 ? (
              <>
                <h3 className="m-0 text-title text-text-strong">
                  {copy.acceptance}
                </h3>
                <ul className="m-0 grid gap-xs pl-lg text-caption">
                  {detail.acceptance.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
        ) : null}

        <section
          className="flex flex-col gap-sm"
          aria-labelledby="change-summary"
        >
          <h2
            className="m-0 text-headline text-text-strong"
            id="change-summary"
          >
            {copy.changeSummary}
          </h2>
          <dl className="grid grid-cols-4 border-t border-l border-divider max-[680px]:grid-cols-2">
            {[
              [copy.filesChanged, detail.diffSummary.filesChanged],
              [copy.additions, `+${detail.diffSummary.additions}`],
              [copy.deletions, `−${detail.diffSummary.deletions}`],
              [copy.binaryFiles, detail.diffSummary.binaryFiles],
            ].map(([label, value]) => (
              <div
                className="border-r border-b border-divider p-sm"
                key={label}
              >
                <dt className="text-label text-muted-foreground">{label}</dt>
                <dd className="m-0 mt-xxs text-headline text-text-strong">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section
          className="flex flex-col gap-sm"
          aria-labelledby="known-cautions"
        >
          <h2
            className="m-0 text-headline text-text-strong"
            id="known-cautions"
          >
            {copy.cautions}
          </h2>
          {unresolvedRisks.length === 0 ? (
            <p className="m-0 text-caption text-muted-foreground">
              {copy.noCautions}
            </p>
          ) : (
            <ul className="m-0 grid gap-xs pl-lg text-caption">
              {unresolvedRisks.map((risk) => (
                <li key={risk.riskId}>
                  <strong>{copy.riskLevels[risk.level]}:</strong> {risk.summary}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </ScrollArea>
  )
}

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
  const controllerStatus =
    explanationControllerState?.status ??
    (explanationControllerAvailable ? "not_generated" : "unavailable")
  const intentBusy =
    explanationIntent.status === "preparing" ||
    explanationIntent.status === "canceling"
  const statusVariant =
    controllerStatus === "queued" || controllerStatus === "running"
      ? "running"
      : controllerStatus === "generated"
        ? "success"
        : controllerStatus === "failed"
          ? "destructive"
          : "outline"
  const explanationText =
    explanationIntent.status === "preparing"
      ? copy.explainPreparing
      : explanationIntent.status === "canceling"
        ? copy.explainCanceling
        : explanationIntent.status === "error"
          ? copy.explainUnavailable
          : controllerStatus === "unavailable"
            ? copy.explainUnavailable
            : null

  return (
    <article
      className="flex min-h-0 flex-col"
      aria-labelledby="selected-commit-subject"
    >
      <header className="flex min-h-[72px] items-start justify-between gap-lg border-b border-divider px-lg py-sm max-[680px]:px-md">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-xs">
            <GitCommitHorizontalIcon
              aria-hidden="true"
              className="size-3 shrink-0 text-muted-foreground"
            />
            <h1
              className="m-0 truncate text-headline text-text-strong"
              id="selected-commit-subject"
            >
              {detail.identity.subject}
            </h1>
          </div>
          <p className="m-0 mt-xxs flex flex-wrap items-center gap-xs text-caption text-muted-foreground">
            <code className="font-mono text-foreground">
              {detail.identity.commitSha.slice(0, 12)}
            </code>
            <span aria-hidden="true">·</span>
            <span>{detail.identity.authorName}</span>
            <span aria-hidden="true">·</span>
            <Badge
              variant={detail.producer === "main_codex" ? "success" : "outline"}
            >
              {detail.producer === "main_codex"
                ? copy.mainCodex
                : copy.externalProducer}
            </Badge>
            {detail.historySequence !== null ? (
              <Badge variant="outline">{copy.persisted}</Badge>
            ) : null}
          </p>
        </div>
        <div className="flex max-w-[360px] shrink-0 flex-col items-end gap-xs">
          <div className="flex flex-wrap justify-end gap-xs">
            {controllerStatus === "not_generated" ? (
              <Button
                disabled={!explanationContextReady || intentBusy}
                onClick={() => onRequestExplanation("user_request")}
                type="button"
                variant="secondary"
              >
                <MessageCircleMoreIcon
                  aria-hidden="true"
                  data-icon="inline-start"
                />
                {copy.explain}
              </Button>
            ) : null}

            {(controllerStatus === "queued" ||
              controllerStatus === "running") &&
            explanationControllerState?.trigger === "auto_verified_commit" &&
            !explanationControllerState.presentationAvailable ? (
              <Button
                disabled={!explanationContextReady || intentBusy}
                onClick={() => onRequestExplanation("user_request")}
                type="button"
                variant="secondary"
              >
                <MessageCircleMoreIcon
                  aria-hidden="true"
                  data-icon="inline-start"
                />
                {copy.explain}
              </Button>
            ) : null}

            {(controllerStatus === "queued" ||
              controllerStatus === "running") &&
            explanationControllerState?.presentationAvailable ? (
              <Button
                disabled={intentBusy}
                onClick={() =>
                  onPresentExplanation(explanationControllerState, "show")
                }
                type="button"
                variant="secondary"
              >
                <EyeIcon aria-hidden="true" data-icon="inline-start" />
                {copy.showExplanation}
              </Button>
            ) : null}

            {(controllerStatus === "queued" ||
              controllerStatus === "running") &&
            explanationControllerState !== null ? (
              <Button
                disabled={intentBusy}
                onClick={() => onCancelExplanation(explanationControllerState)}
                type="button"
                variant="outline"
              >
                <XIcon aria-hidden="true" data-icon="inline-start" />
                {copy.cancelExplanation}
              </Button>
            ) : null}

            {controllerStatus === "generated" &&
            explanationControllerState !== null ? (
              <>
                <Button
                  disabled={intentBusy}
                  onClick={() =>
                    onPresentExplanation(explanationControllerState, "show")
                  }
                  type="button"
                  variant="secondary"
                >
                  <EyeIcon aria-hidden="true" data-icon="inline-start" />
                  {copy.showExplanation}
                </Button>
                <Button
                  disabled={intentBusy}
                  onClick={() =>
                    onPresentExplanation(
                      explanationControllerState,
                      "replay_narration",
                    )
                  }
                  type="button"
                  variant="ghost"
                >
                  <Volume2Icon aria-hidden="true" data-icon="inline-start" />
                  {copy.replayExplanation}
                </Button>
              </>
            ) : null}

            {controllerStatus === "failed" ||
            controllerStatus === "canceled" ||
            (controllerStatus === "unavailable" &&
              explanationControllerState?.retryable) ? (
              <Button
                disabled={!explanationContextReady || intentBusy}
                onClick={() => onRequestExplanation("user_retry")}
                type="button"
                variant="secondary"
              >
                <RotateCcwIcon aria-hidden="true" data-icon="inline-start" />
                {copy.retryExplanation}
              </Button>
            ) : null}

            {controllerStatus === "unavailable" &&
            !explanationControllerState?.retryable ? (
              <Button disabled type="button" variant="secondary">
                <MessageCircleMoreIcon
                  aria-hidden="true"
                  data-icon="inline-start"
                />
                {copy.explain}
              </Button>
            ) : null}
          </div>
          <span
            className="flex max-w-full items-center gap-xs text-right text-label text-muted-foreground"
            role="status"
          >
            {intentBusy ? (
              <LoaderCircleIcon
                aria-hidden="true"
                className="size-3 animate-spin motion-reduce:animate-none"
              />
            ) : (
              <Badge variant={statusVariant}>
                {copy.explanationStatuses[controllerStatus]}
              </Badge>
            )}
            {explanationText !== null ? <span>{explanationText}</span> : null}
            {explanationControllerState?.errorCode !== null &&
            explanationControllerState?.errorCode !== undefined ? (
              <code className="font-mono">
                {explanationControllerState.errorCode}
              </code>
            ) : null}
          </span>
        </div>
      </header>

      <Tabs className="flex-1" defaultValue="overview">
        <TabsList className="min-h-10 gap-lg overflow-x-auto border-b border-divider px-lg max-[680px]:px-md">
          <TabsTrigger
            className="after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-transparent data-[state=active]:after:bg-warm-active"
            value="overview"
          >
            {copy.tabs.overview}
          </TabsTrigger>
          <TabsTrigger
            className="after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-transparent data-[state=active]:after:bg-warm-active"
            value="changes"
          >
            {copy.tabs.changes}
          </TabsTrigger>
          <TabsTrigger
            className="after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-transparent data-[state=active]:after:bg-warm-active"
            value="evidence"
          >
            {copy.tabs.evidence}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Overview copy={copy} detail={detail} locale={locale} />
        </TabsContent>
        <TabsContent value="changes">
          <ChangesPanel
            copy={copy}
            detail={detail}
            diff={diff}
            diffStatus={diffStatus}
            onSelectFile={onSelectFile}
            selectedFileEvidenceId={selectedFileEvidenceId}
          />
        </TabsContent>
        <TabsContent value="evidence">
          <ScrollArea className="size-full">
            <EvidenceSections copy={copy} detail={detail} />
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </article>
  )
}
