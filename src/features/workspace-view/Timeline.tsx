import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleXIcon,
} from "lucide-react"
import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/features/localization"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import type {
  WorkspaceAdapterState,
  WorkspaceLifecycle,
  WorkspaceTimelineItem,
} from "@/features/workspace-view/types"

interface TimelineProps {
  readonly compactStatus?: ReactNode
  readonly copy: WorkspaceCopy
  readonly events: readonly WorkspaceTimelineItem[]
  readonly history: WorkspaceAdapterState["history"]
  readonly onOpenDiagnostics: () => void
}

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
  return event.status.replaceAll("_", " ")
}

function TimelineEventRow({
  copy,
  event,
}: {
  readonly copy: WorkspaceCopy
  readonly event: WorkspaceTimelineItem
}) {
  const { locale } = useI18n()
  const failed = event.status === "failed" || event.errorCode !== undefined
  const completed = event.status === "completed" || event.status === "done"
  const Icon = failed
    ? CircleXIcon
    : completed
      ? CheckCircle2Icon
      : ActivityIcon
  const occurredAt = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(event.occurredAt))

  return (
    <article
      aria-posinset={event.sequence}
      className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-sm rounded-control px-xs py-sm hover:bg-muted"
      data-event-kind={event.kind}
    >
      <Icon
        aria-hidden="true"
        className={
          failed
            ? "mt-xxs size-3 text-destructive"
            : "mt-xxs size-3 text-success"
        }
      />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-xs">
          <span className="text-title text-text-strong">
            {eventStatus(copy, event)}
          </span>
          <code className="max-w-full truncate rounded-control bg-code-chip px-xs py-xxs font-mono text-label text-text-secondary">
            {event.kind}
          </code>
        </div>
        {event.errorCode ? (
          <p className="m-0 mt-xxs font-mono text-label text-destructive">
            {event.errorCode}
          </p>
        ) : null}
      </div>
      <time
        className="whitespace-nowrap text-label text-muted-foreground"
        dateTime={event.occurredAt}
      >
        {occurredAt}
      </time>
    </article>
  )
}

export function Timeline({
  compactStatus,
  copy,
  events,
  history,
  onOpenDiagnostics,
}: TimelineProps) {
  const historyUnavailable = history.mode !== "ready"
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
            variant={historyUnavailable ? "outline" : "success"}
          >
            {historyUnavailable ? copy.historyUnavailable : copy.persistedBadge}
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
            <TimelineEventRow copy={copy} event={event} key={event.id} />
          ))}
        </div>
      ) : (
        <div className="flex min-h-36 flex-col items-center justify-center gap-xs rounded-control border border-dashed border-divider px-xl text-center">
          <ActivityIcon
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
