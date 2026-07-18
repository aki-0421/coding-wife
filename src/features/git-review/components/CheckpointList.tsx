import {
  ArchiveIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  GitCommitHorizontalIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { EvidenceFilter, GitReviewCopy } from "@/features/git-review/copy"
import type { SupportedLocale } from "@/features/localization/types"
import type { ReviewPackSummary } from "@/lib/contracts/git-review"

type CheckpointVisualStatus = "ready" | "attention" | "failed" | "interrupted"

interface CheckpointListProps {
  readonly copy: GitReviewCopy
  readonly locale: SupportedLocale
  readonly items: readonly ReviewPackSummary[]
  readonly selectedCheckpointId: string | null
  readonly filter: EvidenceFilter
  readonly query: string
  readonly loadingMore: boolean
  readonly hasMore: boolean
  readonly onFilterChange: (filter: EvidenceFilter) => void
  readonly onQueryChange: (query: string) => void
  readonly onSelect: (checkpointId: string) => void
  readonly onLoadMore: () => void
}

function visualStatus(item: ReviewPackSummary): CheckpointVisualStatus {
  if (item.operationState === "failed") return "failed"
  if (item.operationState !== "history_complete") return "interrupted"
  if (item.verificationFailures > 0 || item.unresolvedRisks > 0) {
    return "attention"
  }
  return "ready"
}

function statusBadge(status: CheckpointVisualStatus, copy: GitReviewCopy) {
  if (status === "ready") {
    return (
      <Badge variant="success">
        <CheckCircle2Icon aria-hidden="true" />
        {copy.status.ready}
      </Badge>
    )
  }
  if (status === "attention") {
    return (
      <Badge variant="running">
        <TriangleAlertIcon aria-hidden="true" />
        {copy.status.attention}
      </Badge>
    )
  }
  if (status === "failed") {
    return (
      <Badge variant="destructive">
        <TriangleAlertIcon aria-hidden="true" />
        {copy.status.failed}
      </Badge>
    )
  }
  return (
    <Badge variant="outline">
      <CircleDashedIcon aria-hidden="true" />
      {copy.status.interrupted}
    </Badge>
  )
}

function matchesFilter(
  item: ReviewPackSummary,
  filter: EvidenceFilter,
): boolean {
  const status = visualStatus(item)
  if (filter === "all") return true
  if (filter === "attention") return status !== "ready"
  if (filter === "ready") return status === "ready"
  return false
}

export function CheckpointList({
  copy,
  locale,
  items,
  selectedCheckpointId,
  filter,
  query,
  loadingMore,
  hasMore,
  onFilterChange,
  onQueryChange,
  onSelect,
  onLoadMore,
}: CheckpointListProps) {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleItems = items.filter(
    (item) =>
      matchesFilter(item, filter) &&
      (normalizedQuery.length === 0 ||
        item.objective.toLocaleLowerCase().includes(normalizedQuery) ||
        item.commitSha.toLocaleLowerCase().includes(normalizedQuery)),
  )
  const dateFormatter = new Intl.DateTimeFormat(
    locale === "ja" ? "ja-JP" : "en-US",
    { dateStyle: "medium", timeStyle: "short" },
  )

  return (
    <div className="grid size-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] bg-sidebar/40">
      <header className="flex min-h-12 items-center gap-xs border-b border-divider px-md">
        <ArchiveIcon
          aria-hidden="true"
          className="size-3 text-muted-foreground"
        />
        <div className="min-w-0">
          <h2 className="m-0 text-title text-text-strong">
            {copy.checkpointList}
          </h2>
          <p className="m-0 truncate text-caption text-muted-foreground">
            {items.length} {copy.storedSuffix}
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-xs border-b border-divider p-sm">
        <Field>
          <FieldLabel className="sr-only" htmlFor="checkpoint-search">
            {copy.searchLabel}
          </FieldLabel>
          <Input
            className="h-7 text-caption"
            id="checkpoint-search"
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder={copy.searchPlaceholder}
            type="search"
            value={query}
          />
        </Field>
        <div>
          <ToggleGroup
            aria-label={copy.checkpointList}
            className="grid w-full grid-cols-2"
            onValueChange={(value) => {
              if (value !== "") onFilterChange(value as EvidenceFilter)
            }}
            type="single"
            value={filter}
          >
            {(Object.keys(copy.filters) as EvidenceFilter[]).map((value) => (
              <ToggleGroupItem className="w-full" key={value} value={value}>
                {copy.filters[value]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      <ScrollArea className="min-h-0">
        <div
          aria-label={copy.checkpointList}
          className="flex flex-col"
          role="list"
        >
          {visibleItems.map((item) => {
            const selected = item.checkpointId === selectedCheckpointId
            return (
              <div key={item.checkpointId} role="listitem">
                <button
                  aria-current={selected ? "true" : undefined}
                  className="grid min-h-[102px] w-full grid-rows-[auto_auto_auto] gap-xs border-b border-divider px-md py-sm text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-current:bg-selected-row"
                  onClick={() => onSelect(item.checkpointId)}
                  type="button"
                >
                  <span className="flex items-start justify-between gap-sm">
                    <span className="line-clamp-2 min-w-0 text-title text-text-strong">
                      {item.objective}
                    </span>
                    {statusBadge(visualStatus(item), copy)}
                  </span>
                  <span className="flex items-center gap-xs font-mono text-caption text-muted-foreground">
                    <GitCommitHorizontalIcon
                      aria-hidden="true"
                      className="size-3"
                    />
                    {item.commitSha.slice(0, 8)}
                    <span aria-hidden="true">·</span>
                    <time dateTime={item.createdAt}>
                      {dateFormatter.format(new Date(item.createdAt))}
                    </time>
                  </span>
                  <span className="flex flex-wrap gap-md text-caption text-muted-foreground">
                    <span>
                      {item.filesChanged} {copy.files}
                    </span>
                    <span>
                      {item.verificationFailures} {copy.tests}
                    </span>
                    <span>
                      {item.unresolvedRisks} {copy.unresolvedRisks}
                    </span>
                  </span>
                </button>
              </div>
            )
          })}

          {visibleItems.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-xs px-md text-center text-caption text-muted-foreground">
              <ArchiveIcon aria-hidden="true" className="size-4" />
              {copy.noCheckpoint}
            </div>
          ) : null}

          {hasMore ? (
            <div className="p-md">
              <Button
                className="w-full"
                disabled={loadingMore}
                onClick={onLoadMore}
                type="button"
                variant="secondary"
              >
                {loadingMore ? (
                  <LoaderCircleIcon
                    aria-hidden="true"
                    className="animate-spin motion-reduce:animate-none"
                  />
                ) : null}
                {copy.loadMore}
              </Button>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}
