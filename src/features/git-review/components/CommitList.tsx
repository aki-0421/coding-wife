import { useRef } from "react"
import { GitCommitHorizontalIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { GitReviewCopy } from "@/features/git-review/copy"
import type {
  CommitEvidenceSummary,
  GateOutcome,
} from "@/lib/contracts/git-review"

export interface CommitListProps {
  readonly copy: GitReviewCopy
  readonly locale: "ja" | "en"
  readonly items: readonly CommitEvidenceSummary[]
  readonly selectedCommitEvidenceId: string | null
  readonly loadingMore: boolean
  readonly hasMore: boolean
  readonly onSelect: (commitEvidenceId: string) => void
  readonly onLoadMore: () => void
}

function outcomeVariant(outcome: GateOutcome) {
  if (outcome === "pass") return "success" as const
  if (outcome === "fail") return "destructive" as const
  if (outcome === "needs_review") return "running" as const
  return "outline" as const
}

function formatDate(value: string, locale: "ja" | "en") {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

export function CommitList({
  copy,
  locale,
  items,
  selectedCommitEvidenceId,
  loadingMore,
  hasMore,
  onSelect,
  onLoadMore,
}: CommitListProps) {
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])

  const moveSelection = (index: number, direction: -1 | 1) => {
    const target = Math.min(items.length - 1, Math.max(0, index + direction))
    const item = items[target]
    if (item === undefined) return
    onSelect(item.commitEvidenceId)
    rowRefs.current[target]?.focus()
  }

  return (
    <aside
      aria-label={copy.title}
      className="flex min-h-0 flex-col border-r border-divider bg-sidebar/20"
    >
      <div className="flex min-h-10 items-center gap-xs border-b border-divider px-md">
        <GitCommitHorizontalIcon
          aria-hidden="true"
          className="size-3 text-muted-foreground"
        />
        <h2 className="m-0 text-headline text-text-strong">{copy.title}</h2>
        <Badge className="ml-auto" variant="outline">
          {items.length}
        </Badge>
      </div>
      <ScrollArea className="flex-1">
        <div aria-label={copy.title} role="listbox">
          {items.map((item, index) => {
            const lineCount =
              item.diffSummary.additions + item.diffSummary.deletions
            const selected = item.commitEvidenceId === selectedCommitEvidenceId
            return (
              <button
                aria-selected={selected}
                className="grid min-h-[99px] w-full gap-xs border-b border-divider px-md py-sm text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-selected:bg-selected-row"
                key={item.commitEvidenceId}
                onClick={() => onSelect(item.commitEvidenceId)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault()
                    moveSelection(index, 1)
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault()
                    moveSelection(index, -1)
                  }
                }}
                ref={(node) => {
                  rowRefs.current[index] = node
                }}
                role="option"
                type="button"
              >
                <span className="line-clamp-2 text-title text-text-strong">
                  {item.subject}
                </span>
                <span className="flex min-w-0 items-center gap-xs text-caption text-muted-foreground">
                  <code className="font-mono text-foreground">
                    {item.commitSha.slice(0, 8)}
                  </code>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">
                    {formatDate(item.authoredAt, locale)}
                  </span>
                </span>
                <span className="truncate text-caption text-muted-foreground">
                  {item.workUnitId ?? copy.uncorrelated}
                </span>
                <span className="flex flex-wrap items-center gap-xs">
                  <Badge variant={outcomeVariant(item.verificationOutcome)}>
                    {copy.verification}:{" "}
                    {copy.gateOutcomes[item.verificationOutcome]}
                  </Badge>
                  <Badge variant={outcomeVariant(item.riskOutcome)}>
                    {copy.risk}: {copy.gateOutcomes[item.riskOutcome]}
                  </Badge>
                </span>
                <span className="text-caption text-muted-foreground">
                  {item.diffSummary.filesChanged} {copy.filesChanged} ·{" "}
                  {lineCount} {copy.linesChanged}
                  {item.parentCount > 1 ? ` · ${copy.mergeCommit}` : ""}
                </span>
              </button>
            )
          })}
        </div>
        {hasMore ? (
          <div className="p-sm">
            <Button
              className="w-full"
              disabled={loadingMore}
              onClick={onLoadMore}
              type="button"
              variant="ghost"
            >
              {loadingMore ? copy.loading : copy.loadMore}
            </Button>
          </div>
        ) : null}
      </ScrollArea>
    </aside>
  )
}
