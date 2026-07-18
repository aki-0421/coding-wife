import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArchiveIcon,
  CheckCircle2Icon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  LoaderCircleIcon,
  PanelLeftOpenIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { CheckpointList } from "@/features/git-review/components/CheckpointList"
import { ReviewPackDetail } from "@/features/git-review/components/ReviewPackDetail"
import { gitReviewCopy, type EvidenceFilter } from "@/features/git-review/copy"
import { GitReviewStore } from "@/features/git-review/store"
import type { GitReviewTransport } from "@/features/git-review/transport"
import { useGitReview } from "@/features/git-review/use-git-review"
import type { SupportedLocale } from "@/features/localization/types"

export interface EvidenceViewProps {
  readonly workspaceId: string
  readonly locale: SupportedLocale
  readonly transport: GitReviewTransport
  readonly onBackToChat: () => void
  readonly store?: GitReviewStore
}

function CollectionLoading({ loadingText }: { readonly loadingText: string }) {
  return (
    <div className="grid min-h-0 grid-cols-[280px_minmax(0,1fr)] min-[1100px]:grid-cols-[300px_minmax(0,1fr)] max-[840px]:grid-cols-1">
      <aside className="flex min-h-0 flex-col gap-sm border-r border-divider p-md max-[840px]:hidden">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </aside>
      <div className="flex min-h-0 flex-col gap-lg p-xl" aria-live="polite">
        <span className="sr-only">{loadingText}</span>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-10 w-full" />
        <div className="grid grid-cols-2 gap-md max-[680px]:grid-cols-1">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      </div>
    </div>
  )
}

export function EvidenceView({
  workspaceId,
  locale,
  transport,
  onBackToChat,
  store: providedStore,
}: EvidenceViewProps) {
  const store = useMemo(
    () => providedStore ?? new GitReviewStore(workspaceId, transport),
    [providedStore, transport, workspaceId],
  )
  const review = useGitReview(store)
  const copy = gitReviewCopy[locale]
  const [filter, setFilter] = useState<EvidenceFilter>("all")
  const [query, setQuery] = useState("")
  const [drawerOpen, setDrawerOpen] = useState(false)
  const detailHeadingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    void store.initialize()
  }, [store])

  const selectedSummary = review.items.find(
    (item) => item.checkpointId === review.selectedCheckpointId,
  )
  const selectedGates = review.detail?.gates ?? []
  const passedGates = selectedGates.filter(
    (gate) => gate.outcome === "pass",
  ).length
  const refreshing =
    review.collectionStatus === "loading" || review.baselineStatus === "loading"

  const selectCheckpoint = async (checkpointId: string) => {
    setDrawerOpen(false)
    await review.selectCheckpoint(checkpointId)
    detailHeadingRef.current?.focus()
  }

  const listProps = {
    copy,
    locale,
    items: review.items,
    selectedCheckpointId: review.selectedCheckpointId,
    filter,
    query,
    loadingMore: review.loadingMore,
    hasMore: review.nextBeforeSequence !== null,
    onFilterChange: setFilter,
    onQueryChange: setQuery,
    onSelect: (checkpointId: string) => void selectCheckpoint(checkpointId),
    onLoadMore: () => void review.loadMore(),
  } as const

  return (
    <TooltipProvider>
      <main
        aria-label={copy.title}
        className="grid size-full min-h-0 grid-rows-[72px_minmax(0,1fr)] bg-app-bg"
      >
        <header className="flex min-w-0 items-center justify-between gap-lg border-b border-divider px-lg max-[680px]:px-md">
          <div className="flex min-w-0 items-center gap-sm">
            <Button
              aria-label={copy.openCheckpointList}
              className="hidden max-[840px]:inline-flex"
              onClick={() => setDrawerOpen(true)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <PanelLeftOpenIcon />
            </Button>
            <div className="min-w-0">
              <h1 className="m-0 truncate text-headline text-text-strong">
                {selectedSummary?.objective ?? copy.title}
              </h1>
              <p className="m-0 mt-xxs flex min-w-0 items-center gap-xs truncate text-caption text-muted-foreground">
                {selectedSummary === undefined ? (
                  copy.description
                ) : (
                  <>
                    <GitCommitHorizontalIcon
                      aria-hidden="true"
                      className="size-3 shrink-0"
                    />
                    <span className="font-mono">
                      {selectedSummary.commitSha.slice(0, 12)}
                    </span>
                    {review.baseline !== null ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <GitBranchIcon
                          aria-hidden="true"
                          className="size-3 shrink-0"
                        />
                        <span className="truncate">
                          {review.baseline.detached
                            ? copy.detached
                            : review.baseline.branch}
                        </span>
                      </>
                    ) : null}
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-sm">
            {selectedGates.length === 4 ? (
              <div className="flex items-center gap-xs max-[1040px]:hidden">
                {selectedGates.map((gate) => (
                  <Badge
                    key={gate.gate}
                    variant={gate.outcome === "pass" ? "success" : "running"}
                  >
                    {copy.gateLabels[gate.gate]}
                  </Badge>
                ))}
              </div>
            ) : null}
            {selectedSummary !== undefined ? (
              <Badge variant={passedGates === 4 ? "success" : "outline"}>
                {passedGates === 4 ? (
                  <CheckCircle2Icon aria-hidden="true" />
                ) : (
                  <LoaderCircleIcon aria-hidden="true" />
                )}
                {passedGates}/4
              </Badge>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={copy.refresh}
                  disabled={refreshing}
                  onClick={() => void review.refresh()}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <RefreshCwIcon
                    className={
                      refreshing
                        ? "animate-spin motion-reduce:animate-none"
                        : ""
                    }
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{copy.refresh}</TooltipContent>
            </Tooltip>
          </div>
        </header>

        {review.collectionStatus === "loading" ||
        review.collectionStatus === "idle" ? (
          <CollectionLoading loadingText={copy.loading} />
        ) : null}

        {review.collectionStatus === "empty" ? (
          <Empty className="min-h-0">
            <EmptyHeader>
              <ArchiveIcon
                aria-hidden="true"
                className="mb-xs size-5 text-muted-foreground"
              />
              <EmptyTitle>{copy.noCheckpointTitle}</EmptyTitle>
              <EmptyDescription>
                {copy.noCheckpointDescription}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={onBackToChat} type="button" variant="secondary">
                {copy.backToChat}
              </Button>
              <Button
                onClick={() => void review.refresh()}
                type="button"
                variant="ghost"
              >
                <RefreshCwIcon aria-hidden="true" />
                {copy.refresh}
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}

        {review.collectionStatus === "error" ? (
          <div className="mx-auto w-full max-w-[620px] p-xl max-[680px]:p-md">
            <Alert>
              <TriangleAlertIcon
                aria-hidden="true"
                className="text-destructive"
              />
              <AlertTitle>{copy.listError}</AlertTitle>
              <AlertDescription>
                <p className="m-0">
                  {copy.errorCode}:{" "}
                  <span className="font-mono">
                    {review.collectionError?.code}
                  </span>
                </p>
                <Button
                  className="mt-sm"
                  onClick={() => void review.refresh()}
                  type="button"
                  variant="secondary"
                >
                  {copy.retry}
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        {review.collectionStatus === "ready" ? (
          <div className="relative grid min-h-0 grid-cols-[280px_minmax(0,1fr)] min-[1100px]:grid-cols-[300px_minmax(0,1fr)] max-[840px]:grid-cols-1">
            <aside className="min-h-0 border-r border-divider max-[840px]:hidden">
              <CheckpointList {...listProps} />
            </aside>
            <section className="min-h-0 min-w-0" aria-label={copy.title}>
              <ReviewPackDetail
                copy={copy}
                headingRef={detailHeadingRef}
                locale={locale}
                review={review}
              />
            </section>

            {review.baselineStatus === "error" ? (
              <div className="absolute top-sm right-sm z-20 max-w-[420px] max-[680px]:left-sm">
                <Alert>
                  <TriangleAlertIcon
                    aria-hidden="true"
                    className="text-running"
                  />
                  <AlertTitle>{copy.status.readOnly}</AlertTitle>
                  <AlertDescription>
                    {copy.baselineWarning}{" "}
                    <span className="font-mono">
                      {review.baselineError?.code}
                    </span>
                  </AlertDescription>
                </Alert>
              </div>
            ) : null}
          </div>
        ) : null}

        <Dialog onOpenChange={setDrawerOpen} open={drawerOpen}>
          <DialogContent
            className="top-0 left-0 h-dvh max-h-dvh w-[min(330px,calc(100dvw-36px))] -translate-x-0 -translate-y-0 gap-0 rounded-none border-y-0 border-l-0 p-0"
            showCloseButton={false}
          >
            <DialogTitle className="sr-only">{copy.checkpointList}</DialogTitle>
            <DialogDescription className="sr-only">
              {copy.checkpointListDescription}
            </DialogDescription>
            <DialogClose asChild>
              <Button
                aria-label={copy.close}
                className="absolute top-sm right-sm z-20"
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </DialogClose>
            <CheckpointList {...listProps} />
          </DialogContent>
        </Dialog>
      </main>
    </TooltipProvider>
  )
}
