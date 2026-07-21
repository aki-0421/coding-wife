import { useRef } from "react"
import { GitCommitHorizontalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { GitReviewCopy } from "@/features/git-review/copy"
import { formatRelativeTime } from "@/features/git-review/relative-time"
import type { CommitEvidenceSummary } from "@/lib/contracts/git-review"

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
    <div className="flex size-full min-h-0 flex-col bg-sidebar">
      <div className="flex min-h-10 items-center gap-xs border-b border-divider px-md">
        <GitCommitHorizontalIcon
          aria-hidden="true"
          className="size-3 text-muted-foreground"
        />
        <h2 className="m-0 text-title text-text-strong">
          {copy.commitCount(items.length)}
        </h2>
      </div>
      <ScrollArea className="flex-1">
        <div aria-label={copy.openCommitList} role="listbox">
          {items.map((item, index) => {
            const selected = item.commitEvidenceId === selectedCommitEvidenceId
            return (
              <button
                aria-selected={selected}
                className="grid min-h-[66px] w-full gap-xxs border-b border-divider px-md py-sm text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-selected:bg-selected-row"
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
                  <code className="shrink-0 font-mono text-foreground">
                    {item.commitSha.slice(0, 7)}
                  </code>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{item.authorName}</span>
                  <span aria-hidden="true">·</span>
                  <time className="shrink-0" dateTime={item.authoredAt}>
                    {formatRelativeTime(item.authoredAt, locale)}
                  </time>
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
    </div>
  )
}
