import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleXIcon,
  CopyIcon,
  FileCode2Icon,
  GitCompareArrowsIcon,
  ListChecksIcon,
  TerminalSquareIcon,
} from "lucide-react"
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react"

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
  DialogTrigger,
} from "@/components/ui/dialog"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Textarea } from "@/components/ui/textarea"
import type { CodexSemanticTimelineEvent } from "@/features/codex"
import { useI18n } from "@/features/localization"
import type { ChatTimelineEvent } from "@/features/workspace-view/chat-timeline"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import type {
  WorkspaceAdapterState,
  WorkspaceLifecycle,
  WorkspaceTimelineItem,
} from "@/features/workspace-view/types"
import type {
  ApprovalDecision,
  PendingRequestView,
  PendingUserInputAnswer,
} from "@/lib/contracts"
import { unicodeScalarCount } from "@/lib/public-text"
import { cn } from "@/lib/utils"

interface TimelineProps {
  readonly compactStatus?: ReactNode
  readonly copy: WorkspaceCopy
  readonly events: readonly ChatTimelineEvent[]
  readonly history: WorkspaceAdapterState["history"]
  readonly interruptAvailable: boolean
  readonly pendingRequestIds: readonly string[]
  readonly onAnswerApproval: (
    request: PendingRequestView,
    decision: ApprovalDecision,
  ) => Promise<boolean>
  readonly onAnswerDecision: (
    request: PendingRequestView,
    answers: Readonly<Record<string, PendingUserInputAnswer>>,
  ) => Promise<boolean>
  readonly onInterrupt: () => boolean | void | Promise<boolean | void>
  readonly onOpenDiagnostics: () => void
}

type PendingTimelineEvent = Extract<
  CodexSemanticTimelineEvent,
  { readonly kind: "decision" | "approval" }
>

const otherAnswerId = "__coding_wife_other__"

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

function eventId(event: WorkspaceTimelineItem): string | null {
  if (event.kind === "history") return event.id
  return event.durable ? event.sourceEventId : null
}

function eventCode(event: WorkspaceTimelineItem): string | undefined {
  if (event.kind === "history") return event.errorCode
  return event.kind === "error" ? event.errorCode : undefined
}

function eventLabel(copy: WorkspaceCopy, event: WorkspaceTimelineItem): string {
  if (event.kind === "history") return copy.timelineEvent.history
  if (event.kind === "tool") {
    if (event.providerName !== null) return event.providerName
    if (event.toolKind === "commandExecution") {
      return copy.timelineEvent.toolProvider.terminal
    }
    if (event.toolKind === "webSearch") {
      return copy.timelineEvent.toolProvider.webSearch
    }
  }
  return copy.timelineEvent.kind[event.kind]
}

function eventDetail(
  copy: WorkspaceCopy,
  event: WorkspaceTimelineItem,
): string | null {
  switch (event.kind) {
    case "history":
      return event.errorCode ? `${event.domainKind} · ${event.errorCode}` : null
    case "user":
      return event.text
    case "assistant":
      return event.text
    case "plan":
      return null
    case "tool": {
      const details = [event.summary, event.excerpt].filter(
        (detail): detail is string => detail !== null && detail.length > 0,
      )
      return [...new Set(details)].join("\n") || null
    }
    case "file":
      return null
    case "diff":
      return `${copy.timelineEvent.bytesChanged(event.byteCount)} · ${event.detailRef}`
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

function eventFailed(event: WorkspaceTimelineItem): boolean {
  return event.status === "failed" || eventCode(event) !== undefined
}

function eventCompleted(event: WorkspaceTimelineItem): boolean {
  return event.status === "completed" || event.status === "done"
}

function eventInterrupted(event: WorkspaceTimelineItem): boolean {
  return event.status === "interrupted" || event.status === "canceled"
}

function eventActive(event: WorkspaceTimelineItem): boolean {
  return [
    "active",
    "inProgress",
    "running",
    "streaming",
    "waiting",
    "warning",
  ].includes(event.status)
}

function eventTag(event: WorkspaceTimelineItem): string | null {
  switch (event.kind) {
    case "history":
      return event.domainKind
    case "tool":
      return event.toolName
    case "file":
      return event.changeKind
    case "error":
      return event.errorCode
    case "status":
      return event.itemType
    default:
      return null
  }
}

function eventSummary(
  copy: WorkspaceCopy,
  event: WorkspaceTimelineItem,
): string | null {
  switch (event.kind) {
    case "history":
      return event.errorCode ?? null
    case "plan":
      return copy.timelineEvent.steps(event.stepCount)
    case "tool": {
      const detail =
        event.summary ?? event.excerpt?.split("\n", 1)[0]?.trim() ?? null
      const duration =
        event.durationMs === null
          ? null
          : copy.timelineEvent.duration(event.durationMs)
      return [detail, duration].filter(Boolean).join(" · ") || null
    }
    case "file":
      return event.pathAlias
    case "diff":
      return copy.timelineEvent.bytesChanged(event.byteCount)
    case "error":
      return event.detailRef
    case "status":
      return event.detailRef
    default:
      return null
  }
}

function EventIcon({ event }: { readonly event: OperationTimelineEvent }) {
  switch (event.kind) {
    case "tool":
      return <TerminalSquareIcon aria-hidden="true" className="size-3" />
    case "file":
      return <FileCode2Icon aria-hidden="true" className="size-3" />
    case "diff":
      return <GitCompareArrowsIcon aria-hidden="true" className="size-3" />
    case "plan":
      return <ListChecksIcon aria-hidden="true" className="size-3" />
    case "error":
      return <AlertTriangleIcon aria-hidden="true" className="size-3" />
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
  const [otherAnswers, setOtherAnswers] = useState<
    Readonly<Record<string, string>>
  >({})
  const [held, setHeld] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [interruptOpen, setInterruptOpen] = useState(false)
  const [interrupting, setInterrupting] = useState(false)
  const [interruptFailed, setInterruptFailed] = useState(false)
  const isDecision = request.kind === "user_input"
  const supportsOther =
    isDecision && request.responseKind === "native_server_request"
  const decisionContext = request.decisionContext
  const recommendation =
    decisionContext.recommendation === null
      ? copy.timelineEvent.noRecommendation
      : isDecision
        ? (request.questions
            .flatMap((question) => question.options)
            .find((option) => option.id === decisionContext.recommendation)
            ?.label ?? copy.timelineEvent.noRecommendation)
        : copy.timelineEvent.approvalDecision[
            decisionContext.recommendation as ApprovalDecision
          ]
  const complete =
    isDecision &&
    request.questions.every((question) => {
      const answer = answers[question.id]
      if (answer === otherAnswerId) {
        const text = otherAnswers[question.id]?.trim() ?? ""
        const length = unicodeScalarCount(text)
        return supportsOther && length >= 1 && length <= 2_000
      }
      return question.options.some((option) => option.id === answer)
    })

  const answerDecision = async () => {
    if (!isDecision || !complete || submitting || !active) return
    setSubmitting(true)
    await onAnswerDecision(
      request,
      Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          answers[question.id] === otherAnswerId
            ? {
                type: "other",
                text: otherAnswers[question.id]?.trim() ?? "",
              }
            : { type: "option", optionId: answers[question.id] ?? "" },
        ]),
      ),
    )
    setHeld(false)
    setSubmitting(false)
  }

  const answerApproval = async (decision: ApprovalDecision) => {
    if (isDecision || submitting || !active) return
    setSubmitting(true)
    await onAnswerApproval(request, decision)
    setHeld(false)
    setSubmitting(false)
  }

  const interruptTurn = async () => {
    if (interrupting) return
    setInterruptFailed(false)
    setInterrupting(true)
    try {
      const interrupted = await onInterrupt()
      if (interrupted === false) {
        setInterruptFailed(true)
        return
      }
      setInterruptOpen(false)
    } catch {
      setInterruptFailed(true)
    } finally {
      setInterrupting(false)
    }
  }

  const onDecisionKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" || !event.metaKey || !complete) return
    event.preventDefault()
    void answerDecision()
  }

  return (
    <section
      aria-label={
        isDecision
          ? copy.timelineEvent.decisionRequired
          : copy.timelineEvent.approvalRequired
      }
      className={cn(
        "rounded-panel border p-md",
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

      <div className="mt-sm rounded-control bg-surface p-sm">
        <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-sm gap-y-xxs text-caption">
          <dt className="text-muted-foreground">{copy.timelineEvent.effect}</dt>
          <dd className="m-0 text-text-secondary">
            {copy.timelineEvent.decisionEffect[decisionContext.effect]}
          </dd>
          <dt className="text-muted-foreground">{copy.timelineEvent.scope}</dt>
          <dd className="m-0 text-text-secondary">
            {copy.timelineEvent.scopeValue[decisionContext.scope]}
          </dd>
          <dt className="text-muted-foreground">{copy.timelineEvent.risk}</dt>
          <dd className="m-0 text-text-secondary">
            {copy.timelineEvent.riskValue[decisionContext.risk]}
          </dd>
          <dt className="text-muted-foreground">
            {copy.timelineEvent.reversibility}
          </dt>
          <dd className="m-0 text-text-secondary">
            {
              copy.timelineEvent.reversibilityValue[
                decisionContext.reversibility
              ]
            }
          </dd>
          <dt className="text-muted-foreground">
            {copy.timelineEvent.recommendation}
          </dt>
          <dd className="m-0 text-text-secondary">{recommendation}</dd>
          <dt className="text-muted-foreground">
            {copy.timelineEvent.uncertainty}
          </dt>
          <dd className="m-0 text-text-secondary">
            {copy.timelineEvent.uncertaintyValue[decisionContext.uncertainty]}
          </dd>
        </dl>
        <div className="mt-sm">
          <span className="text-label uppercase tracking-wide text-muted-foreground">
            {copy.timelineEvent.evidence}
          </span>
          <ul className="mb-0 mt-xs space-y-xxs pl-lg text-caption text-text-secondary">
            {decisionContext.evidence.map((evidence) => (
              <li key={evidence}>{evidence}</li>
            ))}
          </ul>
        </div>
      </div>

      {isDecision ? (
        <div
          className="mt-md flex flex-col gap-md"
          onKeyDown={onDecisionKeyDown}
        >
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
                onValueChange={(optionId) => {
                  setHeld(false)
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: optionId,
                  }))
                }}
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
                {supportsOther ? (
                  <label className="grid cursor-pointer grid-cols-[16px_minmax(0,1fr)] items-start gap-sm rounded-control border border-divider bg-surface p-sm hover:border-warm-active/40 has-data-[state=checked]:border-warm-active/60 has-data-[state=checked]:bg-warm-active/5">
                    <RadioGroupItem className="mt-xxs" value={otherAnswerId} />
                    <span className="min-w-0">
                      <span className="block text-title text-text-strong">
                        {copy.timelineEvent.other}
                      </span>
                      <span className="mt-xxs block text-caption text-muted-foreground">
                        {copy.timelineEvent.otherDescription}
                      </span>
                    </span>
                  </label>
                ) : null}
              </RadioGroup>
              {supportsOther && answers[question.id] === otherAnswerId ? (
                <div className="mt-sm">
                  <Textarea
                    aria-label={`${question.header}: ${copy.timelineEvent.otherAnswer}`}
                    disabled={!active || submitting}
                    onChange={(changeEvent) => {
                      const value = Array.from(changeEvent.currentTarget.value)
                        .slice(0, 2_000)
                        .join("")
                      setHeld(false)
                      setOtherAnswers((current) => ({
                        ...current,
                        [question.id]: value,
                      }))
                    }}
                    placeholder={copy.timelineEvent.otherPlaceholder}
                    rows={3}
                    value={otherAnswers[question.id] ?? ""}
                  />
                  <p className="m-0 mt-xxs text-label text-muted-foreground">
                    {String(
                      unicodeScalarCount(otherAnswers[question.id] ?? ""),
                    )}{" "}
                    / 2000
                  </p>
                </div>
              ) : null}
            </fieldset>
          ))}
          {held ? (
            <p className="m-0 text-caption text-muted-foreground" role="status">
              {copy.timelineEvent.held}
            </p>
          ) : null}
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
            <Button
              disabled={!active || submitting}
              onClick={() => setHeld(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              {copy.timelineEvent.hold}
            </Button>
            {interruptAvailable || interruptOpen ? (
              <Dialog
                onOpenChange={(open) => {
                  if (interrupting) return
                  setInterruptFailed(false)
                  setInterruptOpen(open)
                }}
                open={interruptOpen}
              >
                <DialogTrigger asChild>
                  <Button
                    disabled={submitting}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {copy.timelineEvent.interrupt}
                  </Button>
                </DialogTrigger>
                <DialogContent showCloseButton={false}>
                  <DialogHeader>
                    <DialogTitle>
                      {copy.timelineEvent.interruptDialogTitle}
                    </DialogTitle>
                    <DialogDescription>
                      {copy.timelineEvent.interruptDialogDescription}
                    </DialogDescription>
                  </DialogHeader>
                  {interruptFailed ? (
                    <p
                      className="m-0 text-caption text-destructive"
                      role="alert"
                    >
                      {copy.timelineEvent.interruptFailed}
                    </p>
                  ) : null}
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button
                        disabled={interrupting}
                        type="button"
                        variant="outline"
                      >
                        {copy.timelineEvent.interruptDialogCancel}
                      </Button>
                    </DialogClose>
                    <Button
                      disabled={interrupting}
                      onClick={() => void interruptTurn()}
                      type="button"
                      variant="destructive"
                    >
                      {interrupting
                        ? copy.timelineEvent.interrupting
                        : copy.timelineEvent.interruptDialogConfirm}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-md">
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

type MessageTimelineEvent = Extract<
  WorkspaceTimelineItem,
  { readonly kind: "user" | "assistant" }
>

type OperationTimelineEvent = Extract<
  WorkspaceTimelineItem,
  {
    readonly kind: "plan" | "tool" | "file" | "diff" | "error"
  }
>

interface FormattedEventTime {
  readonly accessible: string
  readonly visible: string
}

function formatEventTime(
  locale: string,
  occurredAt: string,
): FormattedEventTime {
  const date = new Date(occurredAt)
  return {
    accessible: new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date),
    visible: new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date),
  }
}

function EventTime({
  occurredAt,
  time,
}: {
  readonly occurredAt: string
  readonly time: FormattedEventTime
}) {
  return (
    <time
      aria-label={time.accessible}
      className="shrink-0 whitespace-nowrap text-label tabular-nums text-muted-foreground"
      dateTime={occurredAt}
    >
      {time.visible}
    </time>
  )
}

function EventState({
  copy,
  event,
}: {
  readonly copy: WorkspaceCopy
  readonly event: WorkspaceTimelineItem
}) {
  const failed = eventFailed(event)
  const completed = eventCompleted(event)
  const interrupted = eventInterrupted(event)
  const active = eventActive(event)

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-xxs text-label",
        failed
          ? "text-destructive"
          : completed
            ? "text-success"
            : interrupted
              ? "text-muted-foreground"
              : active
                ? "text-running"
                : "text-muted-foreground",
      )}
    >
      {failed ? (
        <CircleXIcon aria-hidden="true" className="size-3" />
      ) : completed ? (
        <CheckCircle2Icon aria-hidden="true" className="size-3" />
      ) : interrupted ? (
        <AlertTriangleIcon aria-hidden="true" className="size-3" />
      ) : (
        <ActivityIcon aria-hidden="true" className="size-3" />
      )}
      <span>{eventStatus(copy, event)}</span>
    </span>
  )
}

function CopyDetailsButton({
  copy,
  detail,
}: {
  readonly copy: WorkspaceCopy
  readonly detail: string
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  )

  const copyDetail = async () => {
    if (navigator.clipboard?.writeText === undefined) {
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
    <Button
      aria-label={copy.timelineEvent.copyDetails}
      className="text-muted-foreground"
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
  )
}

function MessageEventRow({
  copy,
  event,
  time,
}: {
  readonly copy: WorkspaceCopy
  readonly event: MessageTimelineEvent
  readonly time: FormattedEventTime
}) {
  const showState =
    eventFailed(event) || eventInterrupted(event) || eventActive(event)

  return (
    <article
      aria-posinset={eventSequence(event)}
      className={cn(
        "group min-w-0",
        event.kind === "user"
          ? "my-sm rounded-composer bg-warm-active/5 px-md py-md"
          : "px-sm py-lg",
      )}
      data-event-id={eventId(event) ?? undefined}
      data-event-kind={event.kind}
      data-event-layout="message"
      data-event-sequence={eventSequence(event)}
    >
      <header className="flex min-w-0 items-center gap-xs">
        <span className="text-title text-text-strong">
          {eventLabel(copy, event)}
        </span>
        {showState ? <EventState copy={copy} event={event} /> : null}
        <span className="ml-auto">
          <EventTime occurredAt={event.occurredAt} time={time} />
        </span>
      </header>
      <p className="m-0 mt-xs whitespace-pre-wrap break-words text-pretty text-body leading-relaxed text-foreground [overflow-wrap:anywhere]">
        {event.text}
      </p>
      <footer className="mt-xs flex min-h-6 flex-wrap items-center gap-xs">
        {event.kind === "user" ? (
          <span className="min-w-0 text-label text-muted-foreground">
            {copy.timelineEvent.effort}: {copy.reasoningLevels[event.effort]}
            {event.attachmentCount > 0
              ? ` · ${String(event.attachmentCount)} ${copy.timelineEvent.attachments}`
              : null}
          </span>
        ) : null}
        <span className="ml-auto">
          <CopyDetailsButton copy={copy} detail={event.text} />
        </span>
      </footer>
    </article>
  )
}

function OperationSummary({
  copy,
  event,
  expandable,
  time,
}: {
  readonly copy: WorkspaceCopy
  readonly event: OperationTimelineEvent
  readonly expandable: boolean
  readonly time: FormattedEventTime
}) {
  const tag = eventTag(event)
  const summary = eventSummary(copy, event)

  return (
    <div className="grid min-h-8 min-w-0 grid-cols-[12px_16px_minmax(0,1fr)_max-content_max-content] items-center gap-xs px-xs py-xxs">
      <span className="flex size-3 items-center justify-center text-muted-foreground">
        {expandable ? (
          <ChevronDownIcon
            aria-hidden="true"
            className="size-3 group-open:rotate-180"
          />
        ) : null}
      </span>
      <span
        className={cn(
          "flex size-4 items-center justify-center",
          eventFailed(event) ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <EventIcon event={event} />
      </span>
      <span className="flex min-w-0 items-center gap-xs">
        <span className="max-w-28 shrink truncate text-title text-foreground">
          {eventLabel(copy, event)}
        </span>
        {tag ? (
          <code
            className={cn(
              "max-w-44 shrink truncate rounded-control bg-code-chip px-xs py-xxs font-mono text-label",
              eventFailed(event) ? "text-destructive" : "text-text-secondary",
            )}
          >
            {tag}
          </code>
        ) : null}
        {summary ? (
          <span className="min-w-0 truncate text-caption text-text-secondary">
            {summary}
          </span>
        ) : null}
      </span>
      <EventState copy={copy} event={event} />
      <EventTime occurredAt={event.occurredAt} time={time} />
    </div>
  )
}

function OperationEventRow({
  copy,
  event,
  time,
}: {
  readonly copy: WorkspaceCopy
  readonly event: OperationTimelineEvent
  readonly time: FormattedEventTime
}) {
  const detail = eventDetail(copy, event)
  const openByDefault =
    eventFailed(event) || eventInterrupted(event) || eventActive(event)

  return (
    <article
      aria-posinset={eventSequence(event)}
      className="min-w-0 border-b border-divider/60 last:border-b-0"
      data-event-id={eventId(event) ?? undefined}
      data-event-kind={event.kind}
      data-event-layout="operation"
      data-event-sequence={eventSequence(event)}
    >
      {detail ? (
        <details className="timeline-operation group" open={openByDefault}>
          <summary className="cursor-pointer list-none rounded-control outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
            <OperationSummary
              copy={copy}
              event={event}
              expandable
              time={time}
            />
          </summary>
          <div className="pb-sm pl-[34px] pr-xs">
            <p
              className={cn(
                "m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-control bg-code-chip px-sm py-xs font-mono text-label leading-relaxed text-text-secondary [overflow-wrap:anywhere]",
                eventFailed(event) && "text-destructive",
              )}
            >
              {detail}
            </p>
            <div className="mt-xxs flex justify-end">
              <CopyDetailsButton copy={copy} detail={detail} />
            </div>
          </div>
        </details>
      ) : (
        <OperationSummary
          copy={copy}
          event={event}
          expandable={false}
          time={time}
        />
      )}
    </article>
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
  readonly event: ChatTimelineEvent
  readonly interruptAvailable: boolean
  readonly onAnswerApproval: TimelineProps["onAnswerApproval"]
  readonly onAnswerDecision: TimelineProps["onAnswerDecision"]
  readonly onInterrupt: TimelineProps["onInterrupt"]
}) {
  const { locale } = useI18n()
  const time = formatEventTime(locale, event.occurredAt)

  switch (event.kind) {
    case "user":
    case "assistant":
      return <MessageEventRow copy={copy} event={event} time={time} />
    case "plan":
    case "tool":
    case "file":
    case "diff":
    case "error":
      return <OperationEventRow copy={copy} event={event} time={time} />
    case "decision":
    case "approval":
      return (
        <article
          aria-posinset={eventSequence(event)}
          className="py-sm"
          data-event-id={eventId(event) ?? undefined}
          data-event-kind={event.kind}
          data-event-layout="intervention"
          data-event-sequence={eventSequence(event)}
        >
          <PendingRequestCard
            active={activePendingIds.has(event.request.pendingId)}
            copy={copy}
            event={event}
            interruptAvailable={interruptAvailable}
            onAnswerApproval={onAnswerApproval}
            onAnswerDecision={onAnswerDecision}
            onInterrupt={onInterrupt}
          />
        </article>
      )
  }
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
  const historyUnavailable =
    history.mode === "read_only" || history.mode === "recovery_required"
  const activePendingIds = useMemo(
    () => new Set(pendingRequestIds),
    [pendingRequestIds],
  )
  return (
    <div className="timeline-content flex min-h-full flex-col pb-[162px] pt-lg">
      {compactStatus ? (
        <div
          className="mb-md hidden justify-end px-xs max-[840px]:flex"
          data-chat-compact-status-region=""
        >
          {compactStatus}
        </div>
      ) : null}

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
        <div className="flex flex-col" role="feed">
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
      ) : null}
    </div>
  )
}
