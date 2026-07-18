import { useState, type RefObject } from "react"
import {
  CheckCircle2Icon,
  GitCommitHorizontalIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ComparePanel } from "@/features/git-review/components/ComparePanel"
import {
  AttemptsSection,
  DecisionsSection,
  OverviewSection,
  RisksSection,
  VerificationSection,
} from "@/features/git-review/components/EvidenceSections"
import { FilesPanel } from "@/features/git-review/components/FilesPanel"
import { RestorePanel } from "@/features/git-review/components/RestorePanel"
import type { GitReviewCopy } from "@/features/git-review/copy"
import type { GitReviewController } from "@/features/git-review/use-git-review"
import type { SupportedLocale } from "@/features/localization/types"

type ReviewTab =
  | "overview"
  | "files"
  | "verification"
  | "decisions"
  | "attempts"
  | "risks"
  | "compare"
  | "restore"

interface ReviewPackDetailProps {
  readonly copy: GitReviewCopy
  readonly locale: SupportedLocale
  readonly review: GitReviewController
  readonly headingRef: RefObject<HTMLHeadingElement | null>
}

function DetailLoading({ copy }: { readonly copy: GitReviewCopy }) {
  return (
    <div className="flex size-full flex-col gap-lg p-xl" aria-live="polite">
      <span className="sr-only">{copy.loading}</span>
      <div className="flex items-center justify-between gap-md">
        <div className="flex flex-1 flex-col gap-xs">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="h-5 w-20" />
      </div>
      <Skeleton className="h-9 w-full" />
      <div className="grid grid-cols-2 gap-md max-[680px]:grid-cols-1">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    </div>
  )
}

export function ReviewPackDetail({
  copy,
  locale,
  review,
  headingRef,
}: ReviewPackDetailProps) {
  const [tab, setTab] = useState<ReviewTab>("overview")
  const pack = review.detail

  if (review.detailStatus === "loading") return <DetailLoading copy={copy} />

  if (review.detailStatus === "error" && review.selectedCheckpointId !== null) {
    return (
      <div className="p-xl max-[680px]:p-md">
        <Alert>
          <TriangleAlertIcon aria-hidden="true" className="text-destructive" />
          <AlertTitle>{copy.detailError}</AlertTitle>
          <AlertDescription>
            <p className="m-0">
              {copy.errorCode}:{" "}
              <span className="font-mono">{review.detailError?.code}</span>
            </p>
            <Button
              className="mt-sm"
              onClick={() => {
                if (review.selectedCheckpointId !== null) {
                  void review.selectCheckpoint(review.selectedCheckpointId)
                }
              }}
              type="button"
              variant="secondary"
            >
              {copy.retry}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  if (pack === null) return null

  return (
    <Tabs
      className="size-full"
      onValueChange={(value) => setTab(value as ReviewTab)}
      value={tab}
    >
      <header className="flex min-h-[62px] items-center justify-between gap-lg border-b border-divider px-lg py-sm max-[680px]:px-md">
        <div className="min-w-0">
          <h1
            className="m-0 truncate text-headline text-text-strong outline-none"
            ref={headingRef}
            tabIndex={-1}
          >
            {pack.objective}
          </h1>
          <p className="m-0 mt-xxs flex items-center gap-xs font-mono text-caption text-muted-foreground">
            <GitCommitHorizontalIcon aria-hidden="true" className="size-3" />
            {pack.checkpoint.commitSha.slice(0, 12)}
            <span aria-hidden="true">·</span>
            {pack.workUnitId}
          </p>
        </div>
        <Badge variant="success">
          <CheckCircle2Icon aria-hidden="true" />
          {copy.status.ready}
        </Badge>
      </header>

      <div className="overflow-x-auto border-b border-divider bg-surface/35">
        <TabsList
          aria-label={copy.title}
          className="min-h-10 gap-lg px-lg max-[680px]:gap-md max-[680px]:px-md"
        >
          {(Object.keys(copy.tabs) as ReviewTab[]).map((value) => (
            <TabsTrigger
              className="h-10 border-b-2 border-transparent data-[state=active]:border-warm-active"
              key={value}
              value={value}
            >
              {copy.tabs[value]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent
        className="data-[state=inactive]:hidden"
        forceMount
        value="overview"
      >
        <ScrollArea className="size-full">
          <OverviewSection copy={copy} locale={locale} pack={pack} />
        </ScrollArea>
      </TabsContent>

      <TabsContent
        className="data-[state=inactive]:hidden"
        forceMount
        value="files"
      >
        <FilesPanel
          copy={copy}
          diff={review.diff}
          diffErrorCode={review.diffError?.code ?? null}
          diffStatus={review.diffStatus}
          files={pack.manifest}
          onSelectFile={(fileId) => void review.selectFile(fileId)}
          selectedFileId={review.selectedFileId}
        />
      </TabsContent>

      <TabsContent
        className="data-[state=inactive]:hidden"
        forceMount
        value="verification"
      >
        <ScrollArea className="size-full">
          <VerificationSection copy={copy} locale={locale} pack={pack} />
        </ScrollArea>
      </TabsContent>

      <TabsContent
        className="data-[state=inactive]:hidden"
        forceMount
        value="decisions"
      >
        <ScrollArea className="size-full">
          <DecisionsSection copy={copy} locale={locale} pack={pack} />
        </ScrollArea>
      </TabsContent>

      <TabsContent
        className="data-[state=inactive]:hidden"
        forceMount
        value="attempts"
      >
        <ScrollArea className="size-full">
          <AttemptsSection copy={copy} locale={locale} pack={pack} />
        </ScrollArea>
      </TabsContent>

      <TabsContent
        className="data-[state=inactive]:hidden"
        forceMount
        value="risks"
      >
        <ScrollArea className="size-full">
          <RisksSection copy={copy} locale={locale} pack={pack} />
        </ScrollArea>
      </TabsContent>

      <TabsContent
        className="data-[state=inactive]:hidden"
        forceMount
        value="compare"
      >
        <ScrollArea className="size-full">
          <ComparePanel
            copy={copy}
            errorCode={review.compare.error?.code ?? null}
            fromCheckpointId={review.compare.fromCheckpointId}
            items={review.items}
            onCompare={() => void review.compareCheckpoints()}
            onSelectionChange={review.setCompareSelection}
            result={review.compare.result}
            status={review.compare.status}
            toCheckpointId={review.compare.toCheckpointId}
          />
        </ScrollArea>
      </TabsContent>

      <TabsContent
        className="data-[state=inactive]:hidden"
        forceMount
        value="restore"
      >
        <ScrollArea className="size-full">
          <RestorePanel
            checkpointSha={pack.checkpoint.commitSha}
            copy={copy}
            errorCode={review.restore.error?.code ?? null}
            guidance={pack.restoreGuidance}
            key={pack.checkpoint.checkpointId}
            kind={review.restore.kind}
            onCancel={() => void review.cancelRestore()}
            onConfirm={() => void review.confirmRestore()}
            onDismissResult={review.clearRestoreResult}
            onPreview={(kind, recoveryBranch) =>
              void review.previewRestore(kind, recoveryBranch)
            }
            preview={review.restore.preview}
            result={review.restore.result}
            status={review.restore.status}
          />
        </ScrollArea>
      </TabsContent>
    </Tabs>
  )
}
