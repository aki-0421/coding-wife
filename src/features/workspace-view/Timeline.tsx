import { useMemo, useState, type ReactNode } from "react"
import {
  ActivityIcon,
  AlertTriangleIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleXIcon,
  ClipboardCheckIcon,
  CopyIcon,
  FileCode2Icon,
  GitCompareArrowsIcon,
  HelpCircleIcon,
  ListChecksIcon,
  MessageSquareTextIcon,
  ShieldAlertIcon,
  TerminalSquareIcon,
  UserIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { CodexSemanticTimelineEvent } from "@/features/codex"
import { useI18n } from "@/features/localization"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import type {
  WorkspaceAdapterState,
  WorkspaceLifecycle,
  WorkspaceTimelineItem,
} from "@/features/workspace-view/types"
import type { ApprovalDecision, PendingRequestView } from "@/lib/contracts"
import { cn } from "@/lib/utils"

interface TimelineProps {
  readonly compactStatus?: ReactNode
  readonly copy: WorkspaceCopy
  readonly events: readonly WorkspaceTimelineItem[]
  readonly history: WorkspaceAdapterState["history"]
  readonly interruptAvailable: boolean
  readonly pendingRequestIds: readonly string[]
  readonly onAnswerApproval: (
    request: PendingRequestView,
    decision: ApprovalDecision,
  ) => Promise<boolean>
  readonly onAnswerDecision: (
    request: PendingRequestView,
    answers: Readonly<Record<string, readonly string[]>>,
  ) => Promise<boolean>
  readonly onInterrupt: () => void | Promise<void>
  readonly onOpenDiagnostics: () => void
}

type PendingTimelineEvent = Extract<
  CodexSemanticTimelineEvent,
  { readonly kind: "decision" | "approval" }
>

const lifecycleValues: readonly WorkspaceLifecycle[] = [
  "done",
  "in_review",
  "in_progress",
  "backlog",
  "canceled",
]

function isLifecycle(value: string): value is WorkspaceLifecycle {
  return lifecycleValues.some((lifecycle) => lifecycle === value)
}

function eventStatus(
  copy: WorkspaceCopy,
  event: WorkspaceTimelineItem,
): string {
  if (isLifecycle(event.status)) return copy.lifecycle[event.status]
  if (event.status === "completed") return copy.completed
  if (event.status === "failed") return copy.failed
  if (event.status === "streaming") return copy.timelineEvent.streaming
  if (event.status === "running" || event.status === "inProgress") {
    return copy.timelineEvent.running
  }
  if (event.status === "interrupted" || event.status === "canceled") {
    return copy.timelineEvent.interrupted
  }
  return event.status.replaceAll("_", " ")
}

function eventSequence(event: WorkspaceTimelineItem): number {
  return event.kind === "history" ? event.sequence : event.sourceSequence
}

function eventCode(event: WorkspaceTimelineItem): string | undefined {
  if (event.kind === "history") return event.errorCode
  return event.kind === "error" ? event.errorCode : undefined
}

function eventLabel(copy: WorkspaceCopy, event: WorkspaceTimelineItem): string {
  if (event.kind === "history") return copy.timelineEvent.history
  return copy.timelineEvent.kind[event.kind]
}

function eventDetail(event: WorkspaceTimelineItem): string | null {
  switch (event.kind) {
    case "history":
      return event.domainKind
    case "user":
      return event.text
    case "assistant":
      return event.text
    case "plan":
      return `${String(event.stepCount)} steps`
    case "tool":
      return event.excerpt
    case "file":
      return (
        [event.changeKind, event.pathAlias].filter(Boolean).join(" · ") || null
      )
    case "diff":
      return `${String(event.byteCount)} B · ${event.detailRef}`
    case "error":
      return [event.errorCode, event.detailRef].filter(Boolean).join(" · ")
    case "status":
      return (
        [event.itemType, event.detailRef].filter(Boolean).join(" · ") || null
      )
    case "request_resolved":
      return null
    default:
      return null
  }
}

function EventIcon({ event }: { readonly event: WorkspaceTimelineItem }) {
  switch (event.kind) {
    case "user":
      return <UserIcon aria-hidden="true" className="size-3" />
    case "assistant":
      return <BotIcon aria-hidden="true" className="size-3" />
    case "tool":
      return <TerminalSquareIcon aria-hidden="true" className="size-3" />
    case "file":
      return <FileCode2Icon aria-hidden="true" className="size-3" />
    case "diff":
      return <GitCompareArrowsIcon aria-hidden="true" className="size-3" />
    case "plan":
      return <ListChecksIcon aria-hidden="true" className="size-3" />
    case "decision":
      return <HelpCircleIcon aria-hidden="true" className="size-3" />
    case "approval":
      return <ShieldAlertIcon aria-hidden="true" className="size-3" />
    case "completion":
    case "request_resolved":
      return <CheckCircle2Icon aria-hidden="true" className="size-3" />
    case "error":
      return <CircleXIcon aria-hidden="true" className="size-3" />
    case "history":
      return <ClipboardCheckIcon aria-hidden="true" className="size-3" />
    default:
      return <ActivityIcon aria-hidden="true" className="size-3" />
  }
}

function PendingRequestCard({
  active,
  copy,
  event,
  interruptAvailable,
  onAnswerApproval,
  onAnswerDecision,
  onInterrupt,
}: {
  readonly active: boolean
  readonly copy: WorkspaceCopy
  readonly event: PendingTimelineEvent
  readonly interruptAvailable: boolean
  readonly onAnswerApproval: TimelineProps["onAnswerApproval"]
  readonly onAnswerDecision: TimelineProps["onAnswerDecision"]
  readonly onInterrupt: TimelineProps["onInterrupt"]
}) {
  const request = event.request
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  const isDecision = request.kind === "user_input"
  const complete =
    isDecision &&
    request.questions.every((question) =>
      question.options.some((option) => option.id === answers[question.id]),
    )

  const answerDecision = async () => {
    if (!isDecision || !complete || submitting || !active) return
    setSubmitting(true)
    await onAnswerDecision(
      request,
      Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          [answers[question.id] ?? ""],
        ]),
      ),
    )
    setSubmitting(false)
  }

  const answerApproval = async (decision: ApprovalDecision) => {
    if (isDecision || submitting || !active) return
    setSubmitting(true)
    await onAnswerApproval(request, decision)
    setSubmitting(false)
  }

  return (
    <section
      aria-label={
        isDecision
          ? copy.timelineEvent.decisionRequired
          : copy.timelineEvent.approvalRequired
      }
      className={cn(
        "mt-sm rounded-panel border p-md",
        isDecision
          ? "border-warm-active/40 bg-warm-active/5"
          : "border-destructive/30 bg-destructive/5",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-sm">
        <div className="min-w-0">
          <h3 className="m-0 text-title text-text-strong">
            {isDecision
              ? copy.timelineEvent.decisionRequired
              : copy.timelineEvent.approvalRequired}
          </h3>
          <p className="m-0 mt-xxs text-caption text-muted-foreground">
            {request.reason ?? copy.timelineEvent.responseNeeded}
          </p>
        </div>
        <Badge variant={active ? "running" : "success"}>
          {active
            ? copy.timelineEvent.waitingForYou
            : copy.timelineEvent.responded}
        </Badge>
      </div>

      <dl className="mt-sm grid grid-cols-[max-content_minmax(0,1fr)] gap-x-sm gap-y-xxs text-caption">
        <dt className="text-muted-foreground">
          {copy.timelineEvent.operation}
        </dt>
        <dd className="m-0 min-w-0 break-words font-mono text-text-secondary">
          {request.operation}
        </dd>
        <dt className="text-muted-foreground">{copy.timelineEvent.target}</dt>
        <dd className="m-0 min-w-0 break-words text-text-secondary">
          {request.targetAlias}
        </dd>
      </dl>

      {isDecision ? (
        <div className="mt-md flex flex-col gap-md">
          {request.questions.map((question) => (
            <fieldset className="m-0 border-0 p-0" key={question.id}>
              <legend className="mb-xs text-title text-text-strong">
                {question.question}
              </legend>
              <span className="mb-sm block text-label uppercase tracking-wide text-muted-foreground">
                {question.header}
              </span>
              <RadioGroup
                aria-label={question.question}
                disabled={!active || submitting}
                onValueChange={(optionId) =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: optionId,
                  }))
                }
                value={answers[question.id] ?? null}
              >
                {question.options.map((option) => (
                  <label
                    className="grid cursor-pointer grid-cols-[16px_minmax(0,1fr)] items-start gap-sm rounded-control border border-divider bg-surface p-sm hover:border-warm-active/40 has-data-[state=checked]:border-warm-active/60 has-data-[state=checked]:bg-warm-active/5"
                    key={option.id}
                  >
                    <RadioGroupItem className="mt-xxs" value={option.id} />
                    <span className="min-w-0">
                      <span className="block text-title text-text-strong">
                        {option.label}
                      </span>
                      <span className="mt-xxs block text-caption text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </fieldset>
          ))}
          <div className="flex flex-wrap gap-xs">
            <Button
              disabled={!active || !complete || submitting}
              onClick={() => void answerDecision()}
              size="sm"
              type="button"
            >
              {submitting
                ? copy.timelineEvent.submitting
                : copy.timelineEvent.answer}
            </Button>
            {interruptAvailable ? (
              <Button
                disabled={submitting}
                onClick={() => void onInterrupt()}
                size="sm"
                type="button"
                variant="outline"
              >
                {copy.timelineEvent.interrupt}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-md">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-sm gap-y-xxs rounded-control bg-surface p-sm text-caption">
            <dt className="text-muted-foreground">
              {copy.timelineEvent.scope}
            </dt>
            <dd className="m-0 text-text-secondary">
              {request.approvalContext.scope}
            </dd>
            <dt className="text-muted-foreground">{copy.timelineEvent.risk}</dt>
            <dd className="m-0 text-text-secondary">
              {request.approvalContext.risk}
            </dd>
            <dt className="text-muted-foreground">
              {copy.timelineEvent.reversibility}
            </dt>
            <dd className="m-0 text-text-secondary">
              {request.approvalContext.reversibility}
            </dd>
            <dt className="text-muted-foreground">
              {copy.timelineEvent.recommendation}
            </dt>
            <dd className="m-0 text-text-secondary">
              {
                copy.timelineEvent.approvalDecision[
                  request.approvalContext.recommendation
                ]
              }
            </dd>
          </dl>
          {request.approvalContext.evidence.length > 0 ? (
            <div className="mt-sm">
              <span className="text-label uppercase tracking-wide text-muted-foreground">
                {copy.timelineEvent.evidence}
              </span>
              <ul className="mb-0 mt-xs space-y-xxs pl-lg text-caption text-text-secondary">
                {request.approvalContext.evidence.map((evidence) => (
                  <li key={evidence}>{evidence}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="mt-md flex flex-wrap gap-xs">
            {request.allowedDecisions.map((decision) => (
              <Button
                disabled={!active || submitting}
                key={decision}
                onClick={() => void answerApproval(decision)}
                size="sm"
                type="button"
                variant={
                  decision === "approve_once"
                    ? "default"
                    : decision === "reject"
                      ? "outline"
                      : "destructive"
                }
              >
                {copy.timelineEvent.approvalDecision[decision]}
              </Button>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function TimelineEventRow({
  activePendingIds,
  copy,
  event,
  interruptAvailable,
  onAnswerApproval,
  onAnswerDecision,
  onInterrupt,
}: {
  readonly activePendingIds: ReadonlySet<string>
  readonly copy: WorkspaceCopy
  readonly event: WorkspaceTimelineItem
  readonly interruptAvailable: boolean
  readonly onAnswerApproval: TimelineProps["onAnswerApproval"]
  readonly onAnswerDecision: TimelineProps["onAnswerDecision"]
  readonly onInterrupt: TimelineProps["onInterrupt"]
}) {
  const { locale } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  )
  const errorCode = eventCode(event)
  const failed = event.status === "failed" || errorCode !== undefined
  const completed =
    event.status === "completed" ||
    event.status === "done" ||
    event.kind === "completion" ||
    event.kind === "request_resolved"
  const pending = event.kind === "decision" || event.kind === "approval"
  const occurredAt = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(event.occurredAt))
  const detail = eventDetail(event)
  const expandable =
    detail !== null && (detail.length > 240 || detail.includes("\n"))

  const copyDetail = async () => {
    if (detail === null || navigator.clipboard?.writeText === undefined) {
      setCopyState("failed")
      return
    }
    try {
      await navigator.clipboard.writeText(detail)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }
  }

  return (
    <article
      aria-posinset={eventSequence(event)}
      className={cn(
        "grid grid-cols-[24px_minmax(0,1fr)] items-start gap-sm rounded-panel px-sm py-md transition-colors hover:bg-muted/60",
        event.kind === "user" && "bg-warm-active/5",
        pending && "border border-divider bg-surface shadow-sm",
      )}
      data-event-kind={event.kind}
    >
      <span
        className={cn(
          "mt-xxs flex size-5 items-center justify-center rounded-circle border bg-surface",
          failed
            ? "border-destructive/40 text-destructive"
            : completed
              ? "border-success/40 text-success"
              : pending
                ? "border-warm-active/50 text-warm-active"
                : "border-divider text-muted-foreground",
        )}
      >
        <EventIcon event={event} />
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-xs">
          <span className="text-title text-text-strong">
            {eventLabel(copy, event)}
          </span>
          <Badge
            variant={failed ? "destructive" : completed ? "success" : "outline"}
          >
            {eventStatus(copy, event)}
          </Badge>
          {event.kind === "tool" ? (
            <code className="rounded-control bg-code-chip px-xs py-xxs font-mono text-label text-text-secondary">
              {event.toolKind}
            </code>
          ) : null}
          {event.kind === "user" ? (
            <span className="text-label text-muted-foreground">
              {copy.timelineEvent.effort}: {event.effort} ·{" "}
              {event.attachmentCount} {copy.timelineEvent.attachments}
            </span>
          ) : null}
          <time
            className="ml-auto whitespace-nowrap text-label text-muted-foreground"
            dateTime={event.occurredAt}
          >
            {occurredAt}
          </time>
        </div>

        {detail !== null ? (
          <div className="mt-xs">
            <p
              className={cn(
                "m-0 whitespace-pre-wrap break-words text-caption leading-relaxed text-text-secondary",
                expandable && !expanded && "line-clamp-3",
                (event.kind === "tool" || event.kind === "history") &&
                  "rounded-control bg-code-chip p-sm font-mono text-label",
              )}
            >
              {detail}
            </p>
            <div className="mt-xs flex flex-wrap items-center gap-xxs">
              {expandable ? (
                <Button
                  aria-expanded={expanded}
                  onClick={() => setExpanded((value) => !value)}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  {expanded ? (
                    <ChevronUpIcon data-icon="inline-start" />
                  ) : (
                    <ChevronDownIcon data-icon="inline-start" />
                  )}
                  {expanded ? copy.collapseDetails : copy.expandDetails}
                </Button>
              ) : null}
              <Button
                aria-label={copy.timelineEvent.copyDetails}
                onClick={() => void copyDetail()}
                size="xs"
                type="button"
                variant="ghost"
              >
                <CopyIcon data-icon="inline-start" />
                {copyState === "copied"
                  ? copy.timelineEvent.copied
                  : copyState === "failed"
                    ? copy.timelineEvent.copyFailed
                    : copy.timelineEvent.copy}
              </Button>
            </div>
          </div>
        ) : null}

        {errorCode && detail !== errorCode ? (
          <p className="m-0 mt-xs font-mono text-label text-destructive">
            {errorCode}
          </p>
        ) : null}

        {pending ? (
          <PendingRequestCard
            active={activePendingIds.has(event.request.pendingId)}
            copy={copy}
            event={event}
            interruptAvailable={interruptAvailable}
            onAnswerApproval={onAnswerApproval}
            onAnswerDecision={onAnswerDecision}
            onInterrupt={onInterrupt}
          />
        ) : null}
      </div>
    </article>
  )
}

export function Timeline({
  compactStatus,
  copy,
  events,
  history,
  interruptAvailable,
  pendingRequestIds,
  onAnswerApproval,
  onAnswerDecision,
  onInterrupt,
  onOpenDiagnostics,
}: TimelineProps) {
  const historyEphemeral = history.mode === "ephemeral"
  const historyUnavailable =
    history.mode === "read_only" || history.mode === "recovery_required"
  const activePendingIds = useMemo(
    () => new Set(pendingRequestIds),
    [pendingRequestIds],
  )
  return (
    <div className="timeline-content flex min-h-full flex-col pb-[162px] pt-lg">
      <div className="mb-sm flex items-start justify-between gap-md">
        <div className="flex flex-col gap-xxs">
          <h2 className="m-0 text-headline text-text-strong">
            {copy.timelineTitle}
          </h2>
          <p className="m-0 text-caption text-muted-foreground">
            {copy.timelineDescription}
          </p>
        </div>
        <div
          className="timeline-status-region flex shrink-0 flex-col items-end gap-xs"
          data-chat-status-region=""
        >
          <Badge
            data-persistence-status=""
            variant={history.mode === "ready" ? "success" : "outline"}
          >
            {historyEphemeral
              ? copy.ephemeralHistoryBadge
              : historyUnavailable
                ? copy.historyUnavailable
                : copy.persistedBadge}
          </Badge>
          {compactStatus}
        </div>
      </div>

      {historyUnavailable ? (
        <div
          className="mb-md flex items-start gap-sm rounded-control border border-destructive/40 bg-destructive/10 p-md"
          role="alert"
        >
          <AlertTriangleIcon className="mt-xxs size-3 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="m-0 text-title text-destructive">
              {copy.historyUnavailable}
            </p>
            <p className="m-0 mt-xxs font-mono text-label text-destructive">
              {history.errorCode ?? "HIST-READ-ONLY"}
            </p>
          </div>
          <Button
            onClick={onOpenDiagnostics}
            size="xs"
            type="button"
            variant="ghost"
          >
            {copy.diagnostics}
          </Button>
        </div>
      ) : null}

      {events.length > 0 ? (
        <div className="flex flex-col gap-xxs" role="feed">
          {events.map((event) => (
            <TimelineEventRow
              activePendingIds={activePendingIds}
              copy={copy}
              event={event}
              interruptAvailable={interruptAvailable}
              key={event.id}
              onAnswerApproval={onAnswerApproval}
              onAnswerDecision={onAnswerDecision}
              onInterrupt={onInterrupt}
            />
          ))}
        </div>
      ) : (
        <div className="flex min-h-36 flex-col items-center justify-center gap-xs rounded-control border border-dashed border-divider px-xl text-center">
          <MessageSquareTextIcon
            aria-hidden="true"
            className="size-5 text-muted-foreground"
          />
          <h3 className="m-0 text-title text-text-strong">
            {copy.timelineEmptyTitle}
          </h3>
          <p className="m-0 max-w-[52ch] text-caption text-muted-foreground">
            {copy.timelineEmptyBody}
          </p>
        </div>
      )}
    </div>
  )
}
