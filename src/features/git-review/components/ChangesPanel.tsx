import { AlertCircleIcon, FileCode2Icon, LoaderCircleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import type { GitReviewCopy } from "@/features/git-review/copy"
import type {
  CommitDiffFile,
  CommitEvidenceDetail,
} from "@/lib/contracts/git-review"
import { cn } from "@/lib/utils"

export interface ChangesPanelProps {
  readonly copy: GitReviewCopy
  readonly detail: CommitEvidenceDetail
  readonly selectedFileEvidenceId: string | null
  readonly diffStatus: "idle" | "loading" | "ready" | "error"
  readonly diff: CommitDiffFile | null
  readonly onSelectFile: (fileEvidenceId: string) => void
}

function DiffContent({
  copy,
  diffStatus,
  diff,
}: Pick<ChangesPanelProps, "copy" | "diffStatus" | "diff">) {
  if (diffStatus === "idle") {
    return (
      <p className="m-auto text-caption text-muted-foreground">
        {copy.chooseFile}
      </p>
    )
  }
  if (diffStatus === "loading") {
    return (
      <div className="flex size-full flex-col gap-sm p-md" aria-live="polite">
        <span className="flex items-center gap-xs text-caption text-muted-foreground">
          <LoaderCircleIcon
            aria-hidden="true"
            className="size-3 animate-spin motion-reduce:animate-none"
          />
          {copy.diffLoading}
        </span>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    )
  }
  if (diffStatus === "error" || diff === null) {
    return (
      <p className="m-auto flex max-w-md items-start gap-xs px-lg text-caption text-destructive">
        <AlertCircleIcon
          aria-hidden="true"
          className="mt-xxs size-3 shrink-0"
        />
        {copy.diffError}
      </p>
    )
  }
  if (diff.state !== "text") {
    return (
      <div className="m-auto flex max-w-md flex-col items-center gap-xs px-lg text-center">
        <FileCode2Icon
          aria-hidden="true"
          className="size-5 text-muted-foreground"
        />
        <p className="m-0 text-caption text-foreground">
          {copy.diffStates[diff.state]}
        </p>
        <p className="m-0 text-caption text-muted-foreground">
          {diff.byteCount.toLocaleString()} bytes · +{diff.additions} −
          {diff.deletions}
        </p>
      </div>
    )
  }

  return (
    <ScrollArea className="size-full bg-code-chip">
      <pre className="min-w-max p-md font-mono text-code leading-relaxed text-code-text">
        {diff.content.split("\n").map((line, index) => {
          const kind = line.startsWith("+")
            ? "addition"
            : line.startsWith("-")
              ? "deletion"
              : line.startsWith("@@")
                ? "hunk"
                : "context"
          return (
            <span
              className={cn(
                "block",
                kind === "addition"
                  ? "bg-success/10 text-success"
                  : kind === "deletion"
                    ? "bg-destructive/10 text-destructive"
                    : kind === "hunk"
                      ? "text-running"
                      : undefined,
              )}
              key={`${index}-${line}`}
            >
              <span className="sr-only">{kind}: </span>
              {line || " "}
            </span>
          )
        })}
      </pre>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  )
}

export function ChangesPanel({
  copy,
  detail,
  selectedFileEvidenceId,
  diffStatus,
  diff,
  onSelectFile,
}: ChangesPanelProps) {
  return (
    <div className="grid size-full min-h-0 grid-cols-[minmax(210px,32%)_minmax(0,1fr)] max-[760px]:grid-cols-1 max-[760px]:grid-rows-[minmax(150px,36%)_minmax(0,1fr)]">
      <ScrollArea className="min-h-0 border-r border-divider bg-sidebar/10 max-[760px]:border-r-0 max-[760px]:border-b">
        <div className="sticky top-0 z-10 flex min-h-10 items-center justify-between border-b border-divider bg-surface px-sm">
          <h2 className="m-0 text-title text-text-strong">{copy.fileList}</h2>
          <Badge variant="outline">{detail.files.length}</Badge>
        </div>
        {detail.files.map((file) => (
          <button
            aria-current={
              selectedFileEvidenceId === file.fileEvidenceId
                ? "true"
                : undefined
            }
            className="flex min-h-14 w-full items-start gap-sm border-b border-divider px-sm py-xs text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-current:bg-selected-row"
            key={file.fileEvidenceId}
            onClick={() => onSelectFile(file.fileEvidenceId)}
            type="button"
          >
            <FileCode2Icon
              aria-hidden="true"
              className="mt-xxs size-3 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 flex-1">
              <span className="block break-all text-caption text-foreground">
                {file.relativePath}
              </span>
              <span className="mt-xxs block text-label text-muted-foreground">
                {copy.changeKinds[file.changeKind]} · +{file.additions} −
                {file.deletions}
              </span>
            </span>
            {file.binary ? <Badge variant="outline">BIN</Badge> : null}
          </button>
        ))}
      </ScrollArea>
      <div className="flex min-h-0 bg-code-chip/70">
        <DiffContent copy={copy} diff={diff} diffStatus={diffStatus} />
      </div>
    </div>
  )
}
