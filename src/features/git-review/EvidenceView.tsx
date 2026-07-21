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
  GitCommitHorizontalIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
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
  CommitExplanationController,
  CommitExplanationControllerStateV1,
} from "@/lib/contracts/git-review"
import { parseCommitExplanationControllerState } from "@/lib/contracts/git-review"

export interface EvidenceViewProps {
  readonly workspaceId: string
  readonly workspaceGeneration?: number
  readonly active: boolean
  readonly locale: SupportedLocale
  readonly characterVisible?: boolean
  readonly transport: GitReviewTransport
  readonly onBackToChat: () => void
  readonly onCommitSelectionChange?: () => void
  readonly onExplanationPresentationTrigger?: (
    trigger: HTMLButtonElement,
  ) => void
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
    <div className="flex min-h-0 flex-col gap-lg p-xl" aria-live="polite">
      <span className="sr-only">{loadingText}</span>
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  )
}

function ErrorAlert({
  title,
  description,
}: {
  readonly title: string
  readonly description: string
}) {
  return (
    <Alert>
      <AlertCircleIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  )
}

export function EvidenceView({
  workspaceId,
  workspaceGeneration = 1,
  active,
  locale,
  characterVisible = false,
  transport,
  onBackToChat,
  onCommitSelectionChange,
  onExplanationPresentationTrigger,
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
  const previousSelectedCommitEvidenceId = useRef<string | null>(null)
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

  useEffect(() => {
    const previous = previousSelectedCommitEvidenceId.current
    previousSelectedCommitEvidenceId.current = review.selectedCommitEvidenceId
    if (previous !== null && previous !== review.selectedCommitEvidenceId) {
      onCommitSelectionChange?.()
    }
  }, [onCommitSelectionChange, review.selectedCommitEvidenceId])

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
  }, [active, closeDrawer, drawerOpen])

  const refreshing = review.observationStatus === "loading"
  const explanationContextReady =
    active &&
    commitExplanationController !== undefined &&
    review.observationStatus === "ready" &&
    review.observation?.supportState === "ready" &&
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
        className="grid size-full min-h-0 grid-rows-[40px_minmax(0,1fr)] bg-app-bg"
        data-evidence-character={characterVisible || undefined}
      >
        <header className="flex min-w-0 items-center gap-xs border-b border-divider bg-surface px-sm">
          <Button
            aria-controls="commit-list-drawer"
            aria-expanded={active && drawerOpen}
            aria-label={copy.openCommitList}
            className="min-w-0"
            onClick={openDrawer}
            type="button"
            variant="ghost"
          >
            <GitCommitHorizontalIcon data-icon="inline-start" />
            <span className="truncate">
              {copy.commitCount(review.items.length)}
            </span>
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={copy.refreshAccessible}
                aria-busy={refreshing}
                className="ml-auto"
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={copy.refreshAccessible}
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
            </EmptyContent>
          </Empty>
        ) : null}

        {review.collectionStatus === "error" ? (
          <Empty className="min-h-0 px-xl">
            <ErrorAlert
              description={copy.listErrorDescription}
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
          <div className="relative flex min-h-0 min-w-0 flex-col">
            {active && drawerOpen ? (
              <aside
                aria-label={copy.openCommitList}
                className="absolute inset-y-0 left-0 z-20 w-[min(300px,86%)] min-h-0 bg-sidebar shadow-overlay"
                id="commit-list-drawer"
                role="region"
              >
                {list}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label={copy.close}
                      className="absolute top-xs right-xs"
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

            {review.observationStatus === "error" ? (
              <div className="p-sm">
                <ErrorAlert
                  description={copy.observerErrorDescription}
                  title={copy.observerErrorTitle}
                />
              </div>
            ) : null}
            {review.collectionError !== null ? (
              <div className="px-sm pb-sm">
                <ErrorAlert
                  description={copy.listErrorDescription}
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
                  description={copy.listErrorDescription}
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
                onPresentExplanation={(state, mode, trigger) => {
                  onExplanationPresentationTrigger?.(trigger)
                  void review.presentExplanation(state, mode)
                }}
                onRequestExplanation={(trigger, presentationTrigger) => {
                  onExplanationPresentationTrigger?.(presentationTrigger)
                  void review.requestExplanation(locale, trigger)
                }}
                onSelectFile={(fileEvidenceId) =>
                  void review.selectFile(fileEvidenceId)
                }
                selectedFileEvidenceId={review.selectedFileEvidenceId}
              />
            ) : null}
          </div>
        ) : null}
      </main>
    </TooltipProvider>
  )
}
