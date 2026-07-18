import { useState } from "react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FileCode2Icon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { GitReviewCopy } from "@/features/git-review/copy"
import type { FileDiffView, ManifestEntry } from "@/lib/contracts/git-review"

interface FilesPanelProps {
  readonly copy: GitReviewCopy
  readonly files: readonly ManifestEntry[]
  readonly selectedFileId: string | null
  readonly diffStatus: "idle" | "loading" | "ready" | "error"
  readonly diff: FileDiffView | null
  readonly diffErrorCode: string | null
  readonly onSelectFile: (fileId: string) => void
}

const linesPerChunk = 160

function diffLineStyle(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "border-l-2 border-success bg-success/5 text-foreground"
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "border-l-2 border-destructive bg-destructive/5 text-foreground"
  }
  if (line.startsWith("@@")) {
    return "border-l-2 border-branch-selected bg-branch-selected/5 text-branch-selected"
  }
  return "border-l-2 border-transparent text-muted-foreground"
}

function lineMeaning(line: string, copy: GitReviewCopy): string {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return copy.diffLineKinds.addition
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return copy.diffLineKinds.deletion
  }
  if (line.startsWith("@@")) return copy.diffLineKinds.hunk
  return copy.diffLineKinds.context
}

function DiffViewer({
  copy,
  diff,
}: {
  copy: GitReviewCopy
  diff: FileDiffView
}) {
  const [chunk, setChunk] = useState(0)
  const lines = diff.content.split("\n")
  const chunkCount = Math.max(1, Math.ceil(lines.length / linesPerChunk))
  const visibleLines = lines.slice(
    chunk * linesPerChunk,
    (chunk + 1) * linesPerChunk,
  )

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex min-h-12 flex-wrap items-center justify-between gap-sm border-b border-divider px-md py-xs">
        <div className="min-w-0">
          <p className="m-0 truncate font-mono text-caption text-text-strong">
            {diff.relativePath}
          </p>
          <div className="mt-xxs flex flex-wrap gap-xs">
            <Badge variant="secondary">
              {copy.changeKinds[diff.changeKind]}
            </Badge>
            <Badge variant="outline">{copy.ownership[diff.ownership]}</Badge>
            <span className="text-caption text-muted-foreground">
              {diff.byteCount.toLocaleString()} bytes
            </span>
          </div>
        </div>
        {chunkCount > 1 ? (
          <div className="flex items-center gap-xs">
            <Button
              aria-label={copy.previousChunk}
              disabled={chunk === 0}
              onClick={() => setChunk((value) => Math.max(0, value - 1))}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <ChevronLeftIcon />
            </Button>
            <span className="font-mono text-caption text-muted-foreground">
              {chunk + 1}/{chunkCount}
            </span>
            <Button
              aria-label={copy.nextChunk}
              disabled={chunk >= chunkCount - 1}
              onClick={() =>
                setChunk((value) => Math.min(chunkCount - 1, value + 1))
              }
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <ChevronRightIcon />
            </Button>
          </div>
        ) : null}
      </header>

      <div className="min-h-0 overflow-auto bg-background" tabIndex={0}>
        <ol
          aria-label={`${diff.relativePath} diff`}
          className="m-0 min-w-max list-none py-xs font-mono text-caption"
          start={chunk * linesPerChunk + 1}
        >
          {visibleLines.map((line, index) => {
            const lineNumber = chunk * linesPerChunk + index + 1
            return (
              <li
                aria-label={`${lineMeaning(line, copy)} line ${lineNumber}`}
                className={`grid min-h-5 grid-cols-[48px_minmax(max-content,1fr)] ${diffLineStyle(line)}`}
                key={`${lineNumber}-${line}`}
              >
                <span
                  aria-hidden="true"
                  className="select-none border-r border-divider px-xs text-right text-text-disabled"
                >
                  {lineNumber}
                </span>
                <span className="whitespace-pre px-sm">{line || " "}</span>
              </li>
            )
          })}
        </ol>
      </div>

      {diff.truncated || chunkCount > 1 ? (
        <p className="sr-only">
          {diff.truncated ? copy.diffTruncated : copy.diffLocalChunk}
        </p>
      ) : null}
    </div>
  )
}

export function FilesPanel({
  copy,
  files,
  selectedFileId,
  diffStatus,
  diff,
  diffErrorCode,
  onSelectFile,
}: FilesPanelProps) {
  return (
    <div className="grid size-full min-h-0 grid-cols-[240px_minmax(0,1fr)] max-[760px]:grid-cols-1 max-[760px]:grid-rows-[220px_minmax(320px,1fr)]">
      <div className="min-h-0 overflow-y-auto border-r border-divider bg-sidebar/20 max-[760px]:border-r-0 max-[760px]:border-b">
        <div className="sticky top-0 z-10 flex min-h-10 items-center justify-between border-b border-divider bg-surface px-sm">
          <h2 className="m-0 text-title text-text-strong">{copy.files}</h2>
          <span className="text-caption text-muted-foreground">
            {files.length}
          </span>
        </div>
        <div className="flex flex-col">
          {files.map((file) => (
            <button
              aria-current={selectedFileId === file.fileId ? "true" : undefined}
              className="flex min-h-14 w-full items-start gap-sm border-b border-divider px-sm py-xs text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-current:bg-selected-row"
              key={file.fileId}
              onClick={() => onSelectFile(file.fileId)}
              type="button"
            >
              <FileCode2Icon
                aria-hidden="true"
                className="mt-xxs size-3 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-caption text-text-strong">
                  {file.relativePath}
                </span>
                <span className="mt-xxs flex flex-wrap gap-xs text-caption text-muted-foreground">
                  <span>{copy.changeKinds[file.changeKind]}</span>
                  <span aria-hidden="true">·</span>
                  <span>{copy.ownership[file.ownership]}</span>
                  <span
                    aria-label={`${file.additions} ${copy.additions}`}
                    className="text-success"
                  >
                    +{file.additions}
                  </span>
                  <span
                    aria-label={`${file.deletions} ${copy.deletions}`}
                    className="text-destructive"
                  >
                    −{file.deletions}
                  </span>
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 bg-background">
        {diffStatus === "idle" ? (
          <div className="flex size-full min-h-64 flex-col items-center justify-center gap-sm px-xl text-center">
            <FileCode2Icon
              aria-hidden="true"
              className="size-5 text-muted-foreground"
            />
            <p className="m-0 max-w-sm text-caption text-muted-foreground">
              {copy.filePrompt}
            </p>
          </div>
        ) : null}

        {diffStatus === "loading" ? (
          <div
            className="flex size-full min-h-64 flex-col gap-sm p-md"
            aria-live="polite"
          >
            <div className="flex items-center gap-xs text-caption text-muted-foreground">
              <LoaderCircleIcon
                aria-hidden="true"
                className="size-3 animate-spin motion-reduce:animate-none"
              />
              {copy.diffLoading}
            </div>
            <Skeleton className="h-5 w-3/5" />
            <Skeleton className="h-5 w-4/5" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : null}

        {diffStatus === "error" && selectedFileId !== null ? (
          <div className="p-md">
            <Alert>
              <TriangleAlertIcon
                aria-hidden="true"
                className="text-destructive"
              />
              <AlertTitle>{copy.diffError}</AlertTitle>
              <AlertDescription>
                <span className="font-mono">{diffErrorCode}</span>
                <Button
                  className="mt-sm"
                  onClick={() => onSelectFile(selectedFileId)}
                  type="button"
                  variant="secondary"
                >
                  {copy.retry}
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        {diffStatus === "ready" && diff !== null ? (
          <DiffViewer copy={copy} diff={diff} key={diff.fileId} />
        ) : null}
      </div>
    </div>
  )
}
