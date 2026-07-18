import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import {
  AlertCircleIcon,
  GitBranchIcon,
  PanelLeftOpenIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { CommitDetail } from "@/features/git-review/components/CommitDetail"
import { CommitList } from "@/features/git-review/components/CommitList"
import { gitReviewCopy } from "@/features/git-review/copy"
import {
  GitReviewStore,
  type GitReviewStoreOptions,
} from "@/features/git-review/store"
import type { GitReviewTransport } from "@/features/git-review/transport"
import { useGitReview } from "@/features/git-review/use-git-review"
import type { SupportedLocale } from "@/features/localization/types"
import type {
  CommitEvidenceFilter,
  CommitExplanationController,
  CommitExplanationControllerStateV1,
} from "@/lib/contracts/git-review"
import { parseCommitExplanationControllerState } from "@/lib/contracts/git-review"

export interface EvidenceViewProps {
  readonly workspaceId: string
  readonly workspaceGeneration?: number
  readonly active: boolean
  readonly locale: SupportedLocale
  readonly transport: GitReviewTransport
  readonly onBackToChat: () => void
  readonly commitExplanationController?: CommitExplanationController | undefined
  readonly store?: GitReviewStore
}

function useCommitExplanationControllerState(
  controller: CommitExplanationController | undefined,
  workspaceId: string,
  workspaceGeneration: number,
  commitEvidenceId: string | null,
  locale: SupportedLocale,
  selectionVersion: number,
): CommitExplanationControllerStateV1 | null {
  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? (() => {}),
    [controller],
  )
  const getSnapshot = useCallback(() => {
    if (controller === undefined || commitEvidenceId === null) return null
    const state = controller.getState(
      workspaceId,
      workspaceGeneration,
      commitEvidenceId,
    )
    if (state === null) return null
    try {
      const parsed = parseCommitExplanationControllerState(state)
      if (
        (parsed.locale !== null && parsed.locale !== locale) ||
        (parsed.selectionVersion !== null &&
          parsed.selectionVersion !== selectionVersion)
      ) {
        return null
      }
      return parsed
    } catch {
      return null
    }
  }, [
    commitEvidenceId,
    controller,
    locale,
    selectionVersion,
    workspaceGeneration,
    workspaceId,
  ])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function CollectionLoading({ loadingText }: { readonly loadingText: string }) {
  return (
    <div className="grid min-h-0 grid-cols-[280px_minmax(0,1fr)] min-[1280px]:grid-cols-[300px_minmax(0,1fr)] max-[840px]:grid-cols-1">
      <aside className="flex min-h-0 flex-col gap-sm border-r border-divider p-md max-[840px]:hidden">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </aside>
      <div className="flex min-h-0 flex-col gap-lg p-xl" aria-live="polite">
        <span className="sr-only">{loadingText}</span>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  )
}

function ErrorAlert({
  title,
  description,
  code,
  errorCodeLabel,
}: {
  readonly title: string
  readonly description: string
  readonly code: string
  readonly errorCodeLabel: string
}) {
  return (
    <Alert>
      <AlertCircleIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {description} {errorCodeLabel}:{" "}
        <code className="font-mono">{code}</code>
      </AlertDescription>
    </Alert>
  )
}

export function EvidenceView({
  workspaceId,
  workspaceGeneration = 1,
  active,
  locale,
  transport,
  onBackToChat,
  commitExplanationController,
  store: providedStore,
}: EvidenceViewProps) {
  const storeOptions = useMemo<GitReviewStoreOptions>(
    () => ({
      workspaceGeneration,
      commitExplanationController,
    }),
    [commitExplanationController, workspaceGeneration],
  )
  const store = useMemo(
    () =>
      providedStore ?? new GitReviewStore(workspaceId, transport, storeOptions),
    [providedStore, storeOptions, transport, workspaceId],
  )
  const review = useGitReview(store)
  const copy = gitReviewCopy[locale]
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null)
  const drawerCloseRef = useRef<HTMLButtonElement | null>(null)
  const explanationControllerState = useCommitExplanationControllerState(
    commitExplanationController,
    workspaceId,
    workspaceGeneration,
    review.selectedCommitEvidenceId,
    locale,
    review.selectionVersion,
  )

  useEffect(() => {
    if (active) {
      void store.activate()
    } else {
      store.deactivate()
    }
    return () => {
      if (active) store.deactivate()
    }
  }, [active, store])

  const openDrawer = (event: ReactMouseEvent<HTMLButtonElement>) => {
    drawerTriggerRef.current = event.currentTarget
    setDrawerOpen(true)
  }

  const closeDrawer = useCallback((restoreFocus = true) => {
    setDrawerOpen(false)
    if (!restoreFocus) return
    const trigger = drawerTriggerRef.current
    window.requestAnimationFrame(() => trigger?.focus())
  }, [])

  useEffect(() => {
    if (active || !drawerOpen) return
    const closeFrame = window.requestAnimationFrame(() => closeDrawer(false))
    return () => window.cancelAnimationFrame(closeFrame)
  }, [active, closeDrawer, drawerOpen])

  useEffect(() => {
    if (!active || !drawerOpen) return
    const focusFrame = window.requestAnimationFrame(() => {
      drawerCloseRef.current?.focus()
    })
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      closeDrawer()
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [active, closeDrawer, drawerOpen, review.collectionStatus])

  const observation = review.observation
  const refreshing = review.observationStatus === "loading"
  const selectedWorkUnitId = review.detail?.workUnitId ?? null
  const explanationContextReady =
    active &&
    commitExplanationController !== undefined &&
    review.observationStatus === "ready" &&
    observation?.supportState === "ready" &&
    review.detailStatus === "ready"

  const selectCommit = (commitEvidenceId: string) => {
    if (drawerOpen) closeDrawer()
    void review.selectCommitEvidence(commitEvidenceId)
  }

  const list = (
    <CommitList
      copy={copy}
      hasMore={review.nextCursor !== null}
      items={review.items}
      loadingMore={review.loadingMore}
      locale={locale}
      onLoadMore={() => void review.loadMore()}
      onSelect={selectCommit}
      selectedCommitEvidenceId={review.selectedCommitEvidenceId}
    />
  )

  return (
    <TooltipProvider>
      <main
        aria-label={copy.title}
        className="grid size-full min-h-0 grid-rows-[64px_minmax(0,1fr)] bg-app-bg"
      >
        <header className="flex min-w-0 flex-wrap items-center gap-sm border-b border-divider bg-surface px-lg py-xs max-[680px]:px-md">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-controls="commit-list-drawer"
                aria-expanded={active && drawerOpen}
                aria-label={copy.openCommitList}
                className="hidden max-[840px]:inline-flex"
                onClick={openDrawer}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <PanelLeftOpenIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{copy.openCommitList}</TooltipContent>
          </Tooltip>

          <div className="flex min-w-0 items-center gap-xs">
            <GitBranchIcon
              aria-hidden="true"
              className="size-3 text-branch-selected"
            />
            <span className="truncate text-title text-text-strong">
              {observation === null
                ? copy.repository
                : observation.detached
                  ? "Detached"
                  : observation.branch}
            </span>
            {observation !== null ? (
              <code className="font-mono text-caption text-muted-foreground">
                {observation.headSha.slice(0, 8)}
              </code>
            ) : null}
            <Badge
              variant={
                review.observationStatus === "ready" &&
                observation?.supportState === "ready"
                  ? "success"
                  : review.observationStatus === "loading"
                    ? "running"
                    : "outline"
              }
            >
              {review.observationStatus === "loading"
                ? copy.refreshing
                : review.observationStatus === "ready" &&
                    observation?.supportState === "ready"
                  ? copy.fresh
                  : copy.unavailable}
            </Badge>
          </div>

          {observation !== null ? (
            <div className="min-w-0 text-caption text-muted-foreground max-[1120px]:hidden">
              <span>{copy.lastObserved}: </span>
              <time dateTime={observation.capturedAt}>
                {new Intl.DateTimeFormat(locale, {
                  dateStyle: "short",
                  timeStyle: "medium",
                }).format(new Date(observation.capturedAt))}
              </time>
              <span aria-hidden="true"> · </span>
              <span>{copy.observationReasons[observation.reason]}</span>
              {observation.preExisting.length > 0 ? (
                <>
                  <span aria-hidden="true"> · </span>
                  <span>
                    {observation.preExisting.length} {copy.protectedChanges}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}

          <div className="ml-auto flex shrink-0 items-center gap-sm">
            <ToggleGroup
              aria-label={copy.title}
              onValueChange={(value) => {
                if (value !== "") {
                  void review.setFilter(value as CommitEvidenceFilter)
                }
              }}
              type="single"
              value={review.filter}
            >
              <ToggleGroupItem value="all">{copy.filters.all}</ToggleGroupItem>
              <ToggleGroupItem
                disabled={selectedWorkUnitId === null}
                value="this_work_unit"
              >
                {copy.filters.this_work_unit}
              </ToggleGroupItem>
              <ToggleGroupItem value="needs_attention">
                {copy.filters.needs_attention}
              </ToggleGroupItem>
            </ToggleGroup>
            <Separator orientation="vertical" />
            <Badge variant="outline">{copy.readOnly}</Badge>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={copy.refreshAccessible}
                  aria-busy={refreshing}
                  disabled={!active || refreshing}
                  onClick={() => void review.refresh()}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <RefreshCwIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{copy.refreshAccessible}</TooltipContent>
            </Tooltip>
          </div>
        </header>

        {review.collectionStatus === "idle" ||
        review.collectionStatus === "loading" ? (
          <CollectionLoading loadingText={copy.loading} />
        ) : null}

        {review.collectionStatus === "empty" ? (
          <Empty className="min-h-0">
            <EmptyHeader>
              <EmptyTitle>{copy.noCommitsTitle}</EmptyTitle>
              <EmptyDescription>{copy.noCommitsDescription}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={onBackToChat} type="button" variant="secondary">
                {copy.backToChat}
              </Button>
              <Button
                disabled={!active || refreshing}
                onClick={() => void review.refresh()}
                type="button"
                variant="ghost"
              >
                <RefreshCwIcon data-icon="inline-start" />
                {copy.refresh}
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}

        {review.collectionStatus === "error" ? (
          <Empty className="min-h-0 px-xl">
            <ErrorAlert
              code={review.collectionError?.code ?? "GIT-EVIDENCE-LIST-FAILED"}
              description={copy.listErrorDescription}
              errorCodeLabel={copy.errorCode}
              title={copy.listErrorTitle}
            />
            <EmptyContent>
              <Button
                disabled={!active}
                onClick={() => void review.refresh()}
                type="button"
              >
                {copy.retry}
              </Button>
              <Button onClick={onBackToChat} type="button" variant="ghost">
                {copy.backToChat}
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}

        {review.collectionStatus === "ready" ? (
          <div className="relative grid min-h-0 grid-cols-[280px_minmax(0,1fr)] min-[1280px]:grid-cols-[300px_minmax(0,1fr)] max-[840px]:grid-cols-1">
            <div className="min-h-0 max-[840px]:hidden">{list}</div>
            {active && drawerOpen ? (
              <aside
                aria-label={copy.openCommitList}
                className="absolute inset-y-0 left-0 z-20 hidden w-[min(300px,86%)] min-h-0 bg-sidebar shadow-overlay max-[840px]:block"
                id="commit-list-drawer"
                role="region"
              >
                {list}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label={copy.close}
                      className="absolute top-xs right-10"
                      onClick={() => closeDrawer()}
                      ref={drawerCloseRef}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <XIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{copy.close}</TooltipContent>
                </Tooltip>
              </aside>
            ) : null}

            <section className="flex min-h-0 min-w-0 flex-col">
              {review.observationStatus === "error" ? (
                <div className="p-sm">
                  <ErrorAlert
                    code={
                      review.observationError?.code ?? "GIT-OBSERVATION-FAILED"
                    }
                    description={copy.observerErrorDescription}
                    errorCodeLabel={copy.errorCode}
                    title={copy.observerErrorTitle}
                  />
                </div>
              ) : null}
              {review.collectionError !== null ? (
                <div className="px-sm pb-sm">
                  <ErrorAlert
                    code={review.collectionError.code}
                    description={copy.listErrorDescription}
                    errorCodeLabel={copy.errorCode}
                    title={copy.listErrorTitle}
                  />
                </div>
              ) : null}

              {review.selectedCommitEvidenceId === null ? (
                <Empty className="min-h-0 flex-1">
                  <EmptyHeader>
                    <EmptyTitle>{copy.noSelectionTitle}</EmptyTitle>
                    <EmptyDescription>
                      {copy.noSelectionDescription}
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button
                      aria-controls="commit-list-drawer"
                      aria-expanded={active && drawerOpen}
                      className="hidden max-[840px]:inline-flex"
                      onClick={openDrawer}
                      type="button"
                      variant="secondary"
                    >
                      {copy.openCommitList}
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : null}

              {review.detailStatus === "loading" ? (
                <div
                  className="flex flex-1 flex-col gap-lg p-xl"
                  aria-live="polite"
                >
                  <span className="sr-only">{copy.loading}</span>
                  <Skeleton className="h-6 w-3/4" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-48 w-full" />
                </div>
              ) : null}

              {review.detailStatus === "error" ? (
                <div className="p-xl">
                  <ErrorAlert
                    code={
                      review.detailError?.code ?? "GIT-EVIDENCE-DETAIL-FAILED"
                    }
                    description={copy.listErrorDescription}
                    errorCodeLabel={copy.errorCode}
                    title={copy.listErrorTitle}
                  />
                </div>
              ) : null}

              {review.detailStatus === "ready" && review.detail !== null ? (
                <CommitDetail
                  copy={copy}
                  detail={review.detail}
                  diff={review.diff}
                  diffStatus={review.diffStatus}
                  explanationContextReady={explanationContextReady}
                  explanationControllerAvailable={
                    commitExplanationController !== undefined
                  }
                  explanationControllerState={explanationControllerState}
                  explanationIntent={review.explanation}
                  locale={locale}
                  onCancelExplanation={(state) =>
                    void review.cancelExplanation(state)
                  }
                  onPresentExplanation={(state, mode) =>
                    void review.presentExplanation(state, mode)
                  }
                  onRequestExplanation={(trigger) =>
                    void review.requestExplanation(locale, trigger)
                  }
                  onSelectFile={(fileEvidenceId) =>
                    void review.selectFile(fileEvidenceId)
                  }
                  selectedFileEvidenceId={review.selectedFileEvidenceId}
                />
              ) : null}
            </section>
          </div>
        ) : null}
      </main>
    </TooltipProvider>
  )
}
