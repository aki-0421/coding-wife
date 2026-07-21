import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardIcon,
  FileCode2Icon,
  FilesIcon,
  LoaderCircleIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { GitReviewCopy } from "@/features/git-review/copy"
import { parseUnifiedDiff } from "@/features/git-review/unified-diff"
import type {
  CommitDiffFile,
  CommitEvidenceDetail,
  CommitFileSummary,
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

function FileOptions({
  copy,
  files,
  selectedFileEvidenceId,
  onSelectFile,
}: {
  readonly copy: GitReviewCopy
  readonly files: readonly CommitFileSummary[]
  readonly selectedFileEvidenceId: string | null
  readonly onSelectFile: (fileEvidenceId: string) => void
}) {
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])

  const moveFile = (index: number, direction: -1 | 1) => {
    const target = Math.min(files.length - 1, Math.max(0, index + direction))
    const file = files[target]
    if (file === undefined) return
    onSelectFile(file.fileEvidenceId)
    rowRefs.current[target]?.focus()
  }

  if (files.length === 0) {
    return (
      <p className="m-0 px-sm py-md text-caption text-muted-foreground">
        {copy.noMatchingFiles}
      </p>
    )
  }

  return (
    <div aria-label={copy.fileList} role="listbox">
      {files.map((file, index) => (
        <button
          aria-current={
            selectedFileEvidenceId === file.fileEvidenceId ? "true" : undefined
          }
          aria-label={`${file.relativePath} ${copy.fileStats(file.additions, file.deletions)}`}
          aria-selected={selectedFileEvidenceId === file.fileEvidenceId}
          className="flex min-h-11 w-full items-center gap-sm border-b border-divider px-sm py-xs text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-current:bg-selected-row"
          key={file.fileEvidenceId}
          onClick={() => onSelectFile(file.fileEvidenceId)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault()
              moveFile(index, 1)
            } else if (event.key === "ArrowUp") {
              event.preventDefault()
              moveFile(index, -1)
            }
          }}
          ref={(node) => {
            rowRefs.current[index] = node
          }}
          role="option"
          type="button"
        >
          <FileCode2Icon
            aria-hidden="true"
            className="size-3 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-foreground">
            {file.relativePath}
          </span>
          <span className="shrink-0 text-label" aria-hidden="true">
            <span className="text-success">+{file.additions}</span>{" "}
            <span className="text-destructive">−{file.deletions}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

function DiffContent({
  copy,
  diffStatus,
  diff,
}: Pick<ChangesPanelProps, "copy" | "diffStatus" | "diff">) {
  if (diffStatus === "idle") {
    return (
      <div className="flex min-h-0 w-full min-w-0 flex-1 self-stretch">
        <p className="m-auto w-full min-w-0 max-w-[28rem] px-lg text-center text-caption whitespace-normal text-muted-foreground break-words">
          {copy.chooseFile}
        </p>
      </div>
    )
  }
  if (diffStatus === "loading") {
    return (
      <div
        className="flex size-full min-w-0 flex-1 self-stretch flex-col gap-sm p-md"
        aria-live="polite"
      >
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
      <div className="flex min-h-0 w-full min-w-0 flex-1 self-stretch">
        <p className="m-auto flex w-full min-w-0 max-w-[28rem] items-start gap-xs px-lg text-caption whitespace-normal text-destructive break-words">
          <AlertCircleIcon
            aria-hidden="true"
            className="mt-xxs size-3 shrink-0"
          />
          {copy.diffError}
        </p>
      </div>
    )
  }
  if (diff.state !== "text") {
    return (
      <div
        className="flex min-h-0 w-full min-w-0 flex-1 self-stretch"
        data-git-diff-state={diff.state}
      >
        <div className="m-auto flex w-full min-w-0 max-w-[28rem] flex-col items-center gap-xs px-lg text-center">
          <FileCode2Icon
            aria-hidden="true"
            className="size-5 text-muted-foreground"
          />
          <p className="m-0 w-full min-w-0 text-caption whitespace-normal text-foreground break-words">
            {copy.diffStates[diff.state]}
          </p>
        </div>
      </div>
    )
  }

  const parsed = parseUnifiedDiff(diff.content)
  if (parsed.status !== "ready") {
    return (
      <div className="flex min-h-0 w-full min-w-0 flex-1 self-stretch">
        <p className="m-auto w-full min-w-0 max-w-[28rem] px-lg text-center text-caption whitespace-normal text-muted-foreground break-words">
          {parsed.status === "render_limit"
            ? copy.diffRenderLimit
            : copy.diffEmpty}
        </p>
      </div>
    )
  }

  return (
    <ScrollArea
      aria-label={copy.diffLabel(diff.relativePath)}
      className="size-full min-w-0 flex-1 self-stretch bg-code-chip"
      data-git-diff-scroll=""
    >
      <div className="min-w-max py-xs font-mono text-code leading-relaxed text-code-text">
        {parsed.lines.map((line, index) => {
          const positions = [
            line.oldLine === null ? null : copy.oldLine(line.oldLine),
            line.newLine === null ? null : copy.newLine(line.newLine),
          ].filter((position): position is string => position !== null)
          const marker =
            line.kind === "addition"
              ? "+"
              : line.kind === "deletion"
                ? "-"
                : line.kind === "context"
                  ? " "
                  : line.kind === "no_newline"
                    ? "\\"
                    : ""
          const renderedText =
            line.kind === "no_newline" ? copy.noNewline : line.text
          return (
            <div
              className={cn(
                "grid min-h-[18px] grid-cols-[3.25rem_3.25rem_1.25rem_minmax(max-content,1fr)]",
                line.kind === "addition"
                  ? "bg-success/10"
                  : line.kind === "deletion"
                    ? "bg-destructive/10"
                    : line.kind === "hunk"
                      ? "bg-branch-selected/10 text-branch-selected"
                      : line.kind === "no_newline"
                        ? "text-muted-foreground"
                        : undefined,
              )}
              data-diff-kind={line.kind}
              data-git-diff-line=""
              data-new-line={line.newLine ?? ""}
              data-old-line={line.oldLine ?? ""}
              key={`${index}-${line.kind}-${line.oldLine ?? ""}-${line.newLine ?? ""}`}
            >
              <span
                className="border-r border-divider bg-app-bg/25 px-xs text-right text-muted-foreground select-none"
                aria-hidden="true"
              >
                {line.oldLine ?? ""}
              </span>
              <span
                className="border-r border-divider bg-app-bg/25 px-xs text-right text-muted-foreground select-none"
                aria-hidden="true"
              >
                {line.newLine ?? ""}
              </span>
              <span
                className="text-center text-muted-foreground select-none"
                aria-hidden="true"
              >
                {marker}
              </span>
              <code className="whitespace-pre pr-md">
                <span className="sr-only">
                  {copy.diffKinds[line.kind]}
                  {positions.length > 0
                    ? `${copy.diffMetadataSeparator}${positions.join(copy.diffMetadataSeparator)}`
                    : ""}
                  :{" "}
                </span>
                {renderedText || " "}
              </code>
            </div>
          )
        })}
      </div>
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
  const [filter, setFilter] = useState("")
  const [fileSelectorOpen, setFileSelectorOpen] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const [copiedPath, setCopiedPath] = useState(false)
  const selectedIndex = detail.files.findIndex(
    (file) => file.fileEvidenceId === selectedFileEvidenceId,
  )
  const selectedFile =
    selectedIndex < 0 ? null : (detail.files[selectedIndex] ?? null)
  const normalizedFilter = filter.trim().toLocaleLowerCase()
  const filteredFiles = useMemo(
    () =>
      normalizedFilter === ""
        ? detail.files
        : detail.files.filter((file) =>
            file.relativePath.toLocaleLowerCase().includes(normalizedFilter),
          ),
    [detail.files, normalizedFilter],
  )

  useEffect(() => {
    setFilter("")
  }, [detail.commitEvidenceId])

  useEffect(() => {
    setExpanded(true)
    setCopiedPath(false)
  }, [selectedFileEvidenceId])

  const chooseFile = (fileEvidenceId: string) => {
    onSelectFile(fileEvidenceId)
    setFileSelectorOpen(false)
  }

  const selectAdjacentFile = (direction: -1 | 1) => {
    const target = detail.files[selectedIndex + direction]
    if (target !== undefined) onSelectFile(target.fileEvidenceId)
  }

  const copyPath = async () => {
    if (selectedFile === null) return
    try {
      await navigator.clipboard.writeText(selectedFile.relativePath)
      setCopiedPath(true)
      window.setTimeout(() => setCopiedPath(false), 1_500)
    } catch {
      setCopiedPath(false)
    }
  }

  return (
    <section
      className="git-changes-panel flex size-full min-h-0 min-w-0 flex-col"
      data-git-file-section=""
    >
      <div
        className="git-file-compact-selector hidden min-h-10 items-center border-b border-divider px-sm"
        data-git-path-navigation="compact"
      >
        <Popover open={fileSelectorOpen} onOpenChange={setFileSelectorOpen}>
          <PopoverTrigger asChild>
            <Button
              aria-label={copy.selectFile}
              className="min-w-0 max-w-full"
              type="button"
              variant="ghost"
            >
              <FilesIcon data-icon="inline-start" />
              <span className="truncate font-mono text-caption">
                {selectedFile?.relativePath ?? copy.selectFile}
              </span>
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[min(30rem,calc(100vw-24px))]">
            <div className="border-b border-divider p-xs">
              <Input
                aria-label={copy.filterFiles}
                onChange={(event) => setFilter(event.currentTarget.value)}
                placeholder={copy.filterFiles}
                type="search"
                value={filter}
              />
            </div>
            <ScrollArea className="max-h-72">
              <FileOptions
                copy={copy}
                files={filteredFiles}
                onSelectFile={chooseFile}
                selectedFileEvidenceId={selectedFileEvidenceId}
              />
            </ScrollArea>
          </PopoverContent>
        </Popover>
      </div>

      <div className="git-changes-layout grid min-h-0 w-full min-w-0 flex-1 grid-cols-[minmax(210px,32%)_minmax(0,1fr)]">
        <aside
          className="git-file-navigator flex min-h-0 flex-col border-r border-divider bg-sidebar/10"
          data-git-path-navigation="desktop"
        >
          <div className="border-b border-divider p-xs">
            <Input
              aria-label={copy.filterFiles}
              onChange={(event) => setFilter(event.currentTarget.value)}
              placeholder={copy.filterFiles}
              type="search"
              value={filter}
            />
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <FileOptions
              copy={copy}
              files={filteredFiles}
              onSelectFile={chooseFile}
              selectedFileEvidenceId={selectedFileEvidenceId}
            />
          </ScrollArea>
        </aside>

        <div className="flex min-h-0 w-full min-w-0 flex-col bg-code-chip/70">
          {selectedFile === null ? (
            <p className="m-auto text-caption text-muted-foreground">
              {copy.chooseFile}
            </p>
          ) : (
            <>
              <header
                className="group flex min-h-10 min-w-0 items-center gap-xs border-b border-divider bg-surface px-xs"
                data-git-file-header=""
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-expanded={expanded}
                      aria-label={
                        expanded ? copy.collapseFile : copy.expandFile
                      }
                      onClick={() => setExpanded((current) => !current)}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {expanded ? copy.collapseFile : copy.expandFile}
                  </TooltipContent>
                </Tooltip>
                <code className="min-w-0 flex-1 truncate font-mono text-caption text-text-strong">
                  {selectedFile.relativePath}
                </code>
                <span className="shrink-0 text-label" aria-hidden="true">
                  <span className="text-success">
                    +{selectedFile.additions}
                  </span>{" "}
                  <span className="text-destructive">
                    −{selectedFile.deletions}
                  </span>
                </span>
                <span className="sr-only">
                  {copy.fileStats(
                    selectedFile.additions,
                    selectedFile.deletions,
                  )}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label={copy.copyPath}
                      className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
                      onClick={() => void copyPath()}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <ClipboardIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{copy.copyPath}</TooltipContent>
                </Tooltip>
                {copiedPath ? (
                  <span aria-live="polite" className="sr-only" role="status">
                    {copy.copied}
                  </span>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label={copy.previousFile}
                      disabled={selectedIndex <= 0}
                      onClick={() => selectAdjacentFile(-1)}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <ChevronLeftIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{copy.previousFile}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label={copy.nextFile}
                      disabled={selectedIndex >= detail.files.length - 1}
                      onClick={() => selectAdjacentFile(1)}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <ChevronRightIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{copy.nextFile}</TooltipContent>
                </Tooltip>
              </header>
              {expanded ? (
                <div className="flex min-h-0 w-full min-w-0 flex-1 self-stretch">
                  <DiffContent
                    copy={copy}
                    diff={diff}
                    diffStatus={diffStatus}
                  />
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
