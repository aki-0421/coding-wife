import { useEffect, useRef, useState } from "react"
import {
  ArrowUpIcon,
  AtSignIcon,
  BotIcon,
  FilePlus2Icon,
  GaugeIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
  ZapIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import type { TurnUiState } from "@/features/workspace-view/useWorkspaceViewModel"
import type {
  ContextSnapshotItem,
  ReasoningEffort,
  WorkspaceCodexState,
  WorkspaceDraft,
} from "@/features/workspace-view/types"

interface ComposerProps {
  readonly connected: boolean
  readonly copy: WorkspaceCopy
  readonly draft: WorkspaceDraft
  readonly readiness: WorkspaceCodexState["readiness"]
  readonly turnState: TurnUiState
  readonly onAddAttachments: (files: readonly File[]) => void
  readonly onCaptureContext: (
    source: ContextSnapshotItem["source"],
  ) => void | Promise<void>
  readonly onDraftChange: (value: string) => void
  readonly onEffortChange: (effort: ReasoningEffort) => void
  readonly onPickAttachments?: (() => void | Promise<void>) | undefined
  readonly onRegisterAttachmentPaths?:
    | ((
        source: "drop" | "paste",
        paths: readonly string[],
      ) => void | Promise<void>)
    | undefined
  readonly onRemoveAttachment: (attachmentId: string) => void
  readonly onRemoveContext: (snapshotId: string) => void
  readonly onSend: () => Promise<boolean>
  readonly onStop: () => boolean | void | Promise<boolean | void>
}

const contextSources: readonly ContextSnapshotItem["source"][] = [
  "files",
  "git_diff",
  "terminal_output",
]

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

function fileSystemPaths(files: FileList | readonly File[]): string[] {
  return Array.from(files).flatMap((file) => {
    const path = (file as File & { readonly path?: unknown }).path
    return typeof path === "string" && path.length > 0 ? [path] : []
  })
}

function clipboardFilePaths(data: DataTransfer): string[] {
  const paths = fileSystemPaths(data.files)
  const uriList = data.getData("text/uri-list")
  for (const line of uriList.split(/\r?\n/u)) {
    if (line.length === 0 || line.startsWith("#")) continue
    try {
      const url = new URL(line)
      if (url.protocol === "file:") paths.push(decodeURIComponent(url.pathname))
    } catch {
      // Non-file clipboard text remains composer text.
    }
  }
  return [...new Set(paths)]
}

export function Composer({
  connected,
  copy,
  draft,
  readiness,
  turnState,
  onAddAttachments,
  onCaptureContext,
  onDraftChange,
  onEffortChange,
  onPickAttachments,
  onRegisterAttachmentPaths,
  onRemoveAttachment,
  onRemoveContext,
  onSend,
  onStop,
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [contextOpen, setContextOpen] = useState(false)
  const validAttachments = draft.attachments.filter((item) => item.valid)
  const hasContent =
    draft.text.trim().length > 0 ||
    validAttachments.length > 0 ||
    draft.contextSnapshots.length > 0
  const isBusy = turnState !== "idle"
  const canSend = connected && hasContent && turnState === "idle"
  const disabledReason = !connected
    ? copy.sendUnavailable
    : isBusy
      ? copy.sendBusy
      : !hasContent
        ? copy.sendEmpty
        : ""
  const unavailableEffort =
    !readiness.fastAvailable && !readiness.maxAvailable
      ? copy.effortAvailability.none
      : !readiness.fastAvailable
        ? copy.effortAvailability.fast
        : !readiness.maxAvailable
          ? copy.effortAvailability.max
          : null

  useEffect(() => {
    if (isBusy) return
    if (
      draft.effort === "fast" &&
      !readiness.fastAvailable &&
      readiness.maxAvailable
    ) {
      onEffortChange("max")
    } else if (
      draft.effort === "max" &&
      !readiness.maxAvailable &&
      readiness.fastAvailable
    ) {
      onEffortChange("fast")
    }
  }, [
    draft.effort,
    isBusy,
    onEffortChange,
    readiness.fastAvailable,
    readiness.maxAvailable,
  ])

  const addDroppedFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    const paths = fileSystemPaths(files)
    if (onRegisterAttachmentPaths !== undefined) {
      if (paths.length > 0) void onRegisterAttachmentPaths("drop", paths)
      return
    }
    onAddAttachments(Array.from(files))
  }

  return (
    <div className="composer-wrap pointer-events-none absolute inset-x-0 bottom-0 z-20 px-xl pb-lg">
      <div
        className="pointer-events-auto flex min-h-[128.25px] w-full flex-col rounded-composer border border-divider bg-surface p-[12.75px] shadow-composer transition-colors focus-within:border-warm-active focus-within:ring-2 focus-within:ring-ring"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          addDroppedFiles(event.dataTransfer.files)
        }}
      >
        <input
          className="sr-only"
          multiple
          onChange={(event) => {
            addDroppedFiles(event.currentTarget.files)
            event.currentTarget.value = ""
          }}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />

        <div className="flex min-h-0 flex-1 flex-col">
          {draft.attachments.length > 0 || draft.contextSnapshots.length > 0 ? (
            <div
              className="mb-xxs flex min-h-5 gap-xxs overflow-x-auto"
              aria-label={copy.draftItems}
            >
              {draft.attachments.map((attachment) => (
                <span
                  className="flex h-5 max-w-44 shrink-0 items-center gap-xxs rounded-control bg-code-chip pl-xs text-label text-text-secondary"
                  key={attachment.id}
                  title={`${attachment.name} · ${formatBytes(attachment.size)}`}
                >
                  <FilePlus2Icon
                    aria-hidden="true"
                    className="size-3 shrink-0"
                  />
                  <span className="truncate">{attachment.name}</span>
                  {!attachment.valid ? (
                    <span className="text-destructive">!</span>
                  ) : null}
                  <button
                    aria-label={`${copy.removeAttachment}: ${attachment.name}`}
                    className="flex size-6 shrink-0 items-center justify-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => onRemoveAttachment(attachment.id)}
                    type="button"
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
              {draft.contextSnapshots.map((snapshot) => (
                <span
                  className="flex h-5 max-w-44 shrink-0 items-center gap-xxs rounded-control bg-code-chip pl-xs text-label text-text-secondary"
                  key={snapshot.id}
                  title={`${snapshot.label} · ${formatBytes(snapshot.byteCount)}`}
                >
                  <AtSignIcon aria-hidden="true" className="size-3 shrink-0" />
                  <span className="truncate">{snapshot.label}</span>
                  <button
                    aria-label={`${copy.removeAttachment}: ${snapshot.label}`}
                    className="flex size-6 shrink-0 items-center justify-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => onRemoveContext(snapshot.id)}
                    type="button"
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <Textarea
            aria-describedby="composer-help composer-disabled-reason"
            className="max-h-12 min-h-8 flex-1 border-0 p-0 shadow-none focus-visible:ring-0"
            onChange={(event) =>
              onDraftChange(
                Array.from(event.currentTarget.value).slice(0, 32_000).join(""),
              )
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.metaKey) {
                event.preventDefault()
                if (canSend) void onSend()
              }
            }}
            onPaste={(event) => {
              if (onRegisterAttachmentPaths !== undefined) {
                const paths = clipboardFilePaths(event.clipboardData)
                if (paths.length > 0) {
                  event.preventDefault()
                  void onRegisterAttachmentPaths("paste", paths)
                }
                return
              }
              const files = Array.from(event.clipboardData.files)
              if (files.length > 0) onAddAttachments(files)
            }}
            placeholder={copy.composerPlaceholder}
            rows={2}
            value={draft.text}
          />
        </div>

        <p
          className="m-0 h-[17px] truncate text-caption leading-[16.5px] text-muted-foreground"
          id="composer-help"
          title={copy.composerHint}
        >
          {copy.composerHint}
        </p>

        <div className="flex min-h-8 flex-wrap items-end gap-xs pt-sm">
          <Button
            disabled={turnState === "sending" || turnState === "stopping"}
            onClick={() => {
              if (onPickAttachments !== undefined) {
                void onPickAttachments()
              } else {
                fileInputRef.current?.click()
              }
            }}
            size="xs"
            type="button"
            variant="outline"
          >
            <PlusIcon data-icon="inline-start" />
            {copy.add}
          </Button>

          <Popover onOpenChange={setContextOpen} open={contextOpen}>
            <PopoverTrigger asChild>
              <Button
                disabled={isBusy}
                size="xs"
                type="button"
                variant="outline"
              >
                <AtSignIcon data-icon="inline-start" />
                {copy.context}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top">
              {contextSources.map((source) => {
                const label =
                  source === "files"
                    ? copy.filesFolders
                    : source === "git_diff"
                      ? copy.gitDiff
                      : copy.terminalOutput
                return (
                  <Button
                    className="w-full justify-start"
                    key={source}
                    onClick={() => {
                      setContextOpen(false)
                      void onCaptureContext(source)
                    }}
                    size="xs"
                    type="button"
                    variant="ghost"
                  >
                    {label}
                  </Button>
                )
              })}
            </PopoverContent>
          </Popover>

          <span
            aria-label={`${copy.model}, ${copy.fixedModel}`}
            className="hidden h-6 shrink-0 items-center gap-xxs px-xs text-label text-foreground min-[1080px]:flex"
          >
            <BotIcon aria-hidden="true" className="size-3" />
            {copy.model}
          </span>

          <ToggleGroup
            aria-label={copy.reasoningEffort}
            disabled={isBusy}
            onValueChange={(value) => {
              if (value === "fast" || value === "max") onEffortChange(value)
            }}
            type="single"
            value={draft.effort}
          >
            <ToggleGroupItem
              aria-label={copy.fast}
              className="data-[state=on]:bg-warm-active/15 data-[state=on]:text-warm-active"
              disabled={isBusy || !readiness.fastAvailable}
              value="fast"
            >
              <ZapIcon aria-hidden="true" className="size-3" />
              <span className="hidden min-[1080px]:inline">{copy.fast}</span>
            </ToggleGroupItem>
            <ToggleGroupItem
              aria-label={copy.max}
              disabled={isBusy || !readiness.maxAvailable}
              value="max"
            >
              <GaugeIcon aria-hidden="true" className="size-3" />
              <span className="hidden min-[1080px]:inline">{copy.max}</span>
            </ToggleGroupItem>
          </ToggleGroup>

          {unavailableEffort !== null ? (
            <span
              className="max-w-40 text-label text-muted-foreground"
              data-effort-availability=""
              role="status"
            >
              {unavailableEffort}
            </span>
          ) : null}

          <span
            className="ml-auto hidden shrink-0 font-mono text-caption text-muted-foreground min-[1120px]:inline"
            data-composer-command-hint=""
          >
            {copy.commandSend}
          </span>

          {turnState === "running" || turnState === "stopping" ? (
            <Button
              disabled={turnState === "stopping"}
              onClick={() => void onStop()}
              size="xs"
              type="button"
              variant="destructive"
            >
              <SquareIcon data-icon="inline-start" />
              {copy.stop}
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    aria-describedby="composer-disabled-reason"
                    disabled={!canSend}
                    onClick={() => void onSend()}
                    size="xs"
                    type="button"
                  >
                    <ArrowUpIcon data-icon="inline-start" />
                    {copy.send}
                  </Button>
                </span>
              </TooltipTrigger>
              {!canSend ? (
                <TooltipContent side="top">{disabledReason}</TooltipContent>
              ) : null}
            </Tooltip>
          )}
        </div>

        <span className="sr-only" id="composer-disabled-reason">
          {!canSend ? disabledReason : ""}
        </span>
        {draft.attachments.some((attachment) => !attachment.valid) ? (
          <span className="sr-only" role="alert">
            {copy.attachmentRejected}
          </span>
        ) : null}
      </div>
    </div>
  )
}
