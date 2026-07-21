import { useEffect, useState } from "react"
import {
  ArrowUpIcon,
  AtSignIcon,
  BotIcon,
  ChartNoAxesColumnIncreasingIcon,
  FilePlus2Icon,
  FilesIcon,
  GitCompareArrowsIcon,
  InfoIcon,
  MapIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareIcon,
  TargetIcon,
  TerminalSquareIcon,
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
  WorkspaceRecord,
} from "@/features/workspace-view/types"

interface ComposerProps {
  readonly connected: boolean
  readonly copy: WorkspaceCopy
  readonly draft: WorkspaceDraft
  readonly readiness: WorkspaceCodexState["readiness"]
  readonly repositoryHealth?: WorkspaceRecord["health"]
  readonly turnState: TurnUiState
  readonly onCaptureContext: (
    source: ContextSnapshotItem["source"],
  ) => void | Promise<void>
  readonly onDraftChange: (value: string) => void
  readonly onEffortChange: (effort: ReasoningEffort) => void
  readonly onFastModeChange: (enabled: boolean) => void
  readonly onGoalModeChange: (enabled: boolean) => void
  readonly onPlanModeChange: (enabled: boolean) => void
  readonly onPickAttachments?: (() => void | Promise<void>) | undefined
  readonly onRegisterAttachmentPaths?:
    | ((
        source: "drop" | "paste",
        paths: readonly string[],
      ) => void | Promise<void>)
    | undefined
  readonly onRemoveAttachment: (attachmentId: string) => void
  readonly onRemoveContext: (snapshotId: string) => void
  readonly onReconnect: () => void | Promise<void>
  readonly onSend: () => Promise<boolean>
  readonly onStop: () => boolean | void | Promise<boolean | void>
  readonly reconnecting: boolean
}

const contextSources: readonly ContextSnapshotItem["source"][] = [
  "files",
  "git_diff",
  "terminal_output",
]

const reasoningOrder: readonly ReasoningEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
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

function safeConnectionReason(reasonCode: string | null): string {
  return reasonCode !== null &&
    /^(?:CODEX|HIST)-[A-Z0-9-]{1,96}$/u.test(reasonCode)
    ? reasonCode
    : "CODEX-NOT-CONNECTED"
}

export function Composer({
  connected,
  copy,
  draft,
  readiness,
  repositoryHealth,
  turnState,
  onCaptureContext,
  onDraftChange,
  onEffortChange,
  onFastModeChange,
  onGoalModeChange,
  onPlanModeChange,
  onPickAttachments,
  onRegisterAttachmentPaths,
  onRemoveAttachment,
  onRemoveContext,
  onReconnect,
  onSend,
  onStop,
  reconnecting,
}: ComposerProps) {
  const [addOpen, setAddOpen] = useState(false)
  const attachmentCapabilitiesAvailable =
    onPickAttachments !== undefined && onRegisterAttachmentPaths !== undefined
  const validAttachments = draft.attachments.filter((item) => item.valid)
  const hasContent =
    draft.text.trim().length > 0 ||
    validAttachments.length > 0 ||
    draft.contextSnapshots.length > 0
  const isBusy = turnState !== "idle"
  const goalObjectiveLength = Array.from(draft.text.trim()).length
  const goalObjectiveValid =
    !draft.goalMode || (goalObjectiveLength > 0 && goalObjectiveLength <= 4_000)
  const repositoryReady =
    repositoryHealth === undefined || repositoryHealth === "ready"
  const connectionReason = safeConnectionReason(readiness.reasonCode)
  const canSend =
    connected &&
    repositoryReady &&
    hasContent &&
    goalObjectiveValid &&
    turnState === "idle"
  const disabledReason = !connected
    ? copy.sendUnavailable
    : repositoryHealth !== undefined && repositoryHealth !== "ready"
      ? copy.workspaceHealth[repositoryHealth]
      : isBusy
        ? copy.sendBusy
        : !goalObjectiveValid
          ? copy.goalInstructionRequired
          : !hasContent
            ? copy.sendEmpty
            : ""
  const availableReasoningLevels = reasoningOrder.filter(
    (effort) =>
      effort === "off" ||
      readiness.supportedReasoningEfforts.includes(
        effort as Exclude<ReasoningEffort, "off">,
      ),
  )
  const nextReasoning =
    availableReasoningLevels[
      (availableReasoningLevels.indexOf(draft.effort) + 1) %
        availableReasoningLevels.length
    ] ?? "off"

  useEffect(() => {
    if (isBusy) return
    if (
      draft.effort !== "off" &&
      !readiness.supportedReasoningEfforts.includes(draft.effort)
    )
      onEffortChange("off")
    if (draft.fastMode && readiness.fastServiceTier === null)
      onFastModeChange(false)
    if (
      (draft.planMode || draft.goalMode) &&
      !readiness.experimentalModesAvailable
    ) {
      if (draft.planMode) onPlanModeChange(false)
      if (draft.goalMode) onGoalModeChange(false)
    }
  }, [
    draft.effort,
    draft.fastMode,
    draft.goalMode,
    draft.planMode,
    isBusy,
    onEffortChange,
    onFastModeChange,
    onGoalModeChange,
    onPlanModeChange,
    readiness.experimentalModesAvailable,
    readiness.fastServiceTier,
    readiness.supportedReasoningEfforts,
  ])

  const addDroppedFiles = (files: FileList | null) => {
    if (
      !files ||
      files.length === 0 ||
      onRegisterAttachmentPaths === undefined
    ) {
      return
    }
    const paths = fileSystemPaths(files)
    if (paths.length > 0) void onRegisterAttachmentPaths("drop", paths)
  }

  return (
    <div className="composer-wrap pointer-events-none absolute inset-x-0 bottom-0 z-20 px-xl pb-lg">
      <div
        className="composer-surface pointer-events-auto flex min-h-[128.25px] w-full flex-col rounded-composer border border-divider bg-surface p-[12.75px] shadow-composer transition-colors has-[textarea:focus-visible]:border-warm-active has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-ring"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          addDroppedFiles(event.dataTransfer.files)
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          {draft.attachments.length > 0 || draft.contextSnapshots.length > 0 ? (
            <div
              className="mb-xs flex min-h-6 gap-xxs overflow-x-auto"
              aria-label={copy.draftItems}
            >
              {draft.attachments.map((attachment) => (
                <span
                  className="flex h-6 max-w-44 shrink-0 items-center gap-xxs rounded-control bg-code-chip pl-xs text-label text-text-secondary"
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
                    className="flex size-6 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onRemoveAttachment(attachment.id)}
                    type="button"
                  >
                    <XIcon className="size-4" />
                  </button>
                </span>
              ))}
              {draft.contextSnapshots.map((snapshot) => (
                <span
                  className="flex h-6 max-w-44 shrink-0 items-center gap-xxs rounded-control bg-code-chip pl-xs text-label text-text-secondary"
                  key={snapshot.id}
                  title={`${snapshot.label} · ${formatBytes(snapshot.byteCount)}`}
                >
                  <AtSignIcon aria-hidden="true" className="size-3 shrink-0" />
                  <span className="truncate">{snapshot.label}</span>
                  <button
                    aria-label={`${copy.removeAttachment}: ${snapshot.label}`}
                    className="flex size-6 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onRemoveContext(snapshot.id)}
                    type="button"
                  >
                    <XIcon className="size-4" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <Textarea
            aria-describedby="composer-help composer-disabled-reason"
            aria-keyshortcuts="Meta+Enter"
            className="max-h-20 min-h-12 flex-1 overflow-y-auto border-0 p-0 shadow-none focus-visible:ring-0"
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
              if (event.clipboardData.files.length > 0) event.preventDefault()
            }}
            placeholder={copy.composerPlaceholder}
            rows={1}
            value={draft.text}
          />
        </div>

        <p
          className={
            attachmentCapabilitiesAvailable
              ? "sr-only"
              : "m-0 mt-xs flex items-start gap-xs text-pretty text-caption text-muted-foreground"
          }
          data-composer-capability-status={
            attachmentCapabilitiesAvailable ? undefined : "unavailable"
          }
          id="composer-help"
        >
          {!attachmentCapabilitiesAvailable ? (
            <InfoIcon aria-hidden="true" className="mt-xxs size-3 shrink-0" />
          ) : null}
          <span>
            {attachmentCapabilitiesAvailable
              ? copy.composerHint
              : copy.pickerUnavailable}
          </span>
        </p>

        {!connected ? (
          <div
            className="mt-xs flex min-h-8 items-center gap-sm rounded-control bg-muted/60 px-sm py-xs max-[520px]:items-start"
            data-composer-connection-recovery=""
            role="status"
          >
            <p className="m-0 min-w-0 flex-1 text-pretty text-caption text-muted-foreground">
              {copy.sendUnavailable}{" "}
              <code className="whitespace-nowrap font-mono text-label text-foreground">
                {connectionReason}
              </code>
            </p>
            <Button
              className="shrink-0"
              disabled={reconnecting}
              onClick={() => void onReconnect()}
              size="xs"
              type="button"
              variant="ghost"
            >
              <RefreshCwIcon
                className={
                  reconnecting
                    ? "animate-spin motion-reduce:animate-none"
                    : undefined
                }
                data-icon="inline-start"
              />
              {reconnecting ? copy.reconnectingCodex : copy.reconnectCodex}
            </Button>
          </div>
        ) : null}

        <div className="flex min-h-7 items-center gap-xs pt-sm">
          <div className="flex shrink-0 items-center gap-xxs">
            <Popover onOpenChange={setAddOpen} open={addOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      aria-describedby="composer-help"
                      aria-label={copy.add}
                      disabled={isBusy}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <PlusIcon />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="top">{copy.add}</TooltipContent>
              </Tooltip>
              <PopoverContent align="start" className="w-64 p-xs" side="top">
                <p className="px-xs py-xxs text-caption text-muted-foreground">
                  {copy.attachments}
                </p>
                <Button
                  className="w-full justify-start"
                  disabled={onPickAttachments === undefined}
                  onClick={() => {
                    setAddOpen(false)
                    if (onPickAttachments !== undefined)
                      void onPickAttachments()
                  }}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  <FilePlus2Icon data-icon="inline-start" />
                  {copy.attachFiles}
                </Button>
                <div className="my-xxs border-t border-divider" />
                <p className="px-xs py-xxs text-caption text-muted-foreground">
                  {copy.context}
                </p>
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
                        setAddOpen(false)
                        void onCaptureContext(source)
                      }}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      {source === "files" ? (
                        <FilesIcon data-icon="inline-start" />
                      ) : source === "git_diff" ? (
                        <GitCompareArrowsIcon data-icon="inline-start" />
                      ) : (
                        <TerminalSquareIcon data-icon="inline-start" />
                      )}
                      {label}
                    </Button>
                  )
                })}
              </PopoverContent>
            </Popover>
          </div>

          <div className="composer-execution-options flex min-w-0 items-center gap-xs">
            <span
              aria-label={`${copy.model}, ${copy.fixedModel}`}
              className="composer-model flex h-6 shrink-0 items-center gap-xxs px-xs text-label text-muted-foreground"
            >
              <BotIcon aria-hidden="true" className="size-3" />
              {copy.model}
            </span>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={`${copy.reasoningEffort}: ${copy.reasoningLevels[draft.effort]}`}
                  className="gap-xxs px-xs text-muted-foreground"
                  disabled={isBusy}
                  onClick={() => onEffortChange(nextReasoning)}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  <ChartNoAxesColumnIncreasingIcon data-icon="inline-start" />
                  <span className="composer-reasoning-label">
                    {copy.reasoningLevels[draft.effort]}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {copy.reasoningCycleHint}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    aria-label={copy.fastMode}
                    aria-pressed={draft.fastMode}
                    className={
                      draft.fastMode
                        ? "bg-warm-active/15 text-warm-active"
                        : undefined
                    }
                    disabled={isBusy || readiness.fastServiceTier === null}
                    onClick={() => onFastModeChange(!draft.fastMode)}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <ZapIcon />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                {readiness.fastServiceTier === null
                  ? copy.fastModeUnavailable
                  : copy.fastMode}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    aria-label={copy.goalsMode}
                    aria-pressed={draft.goalMode}
                    className={
                      draft.goalMode
                        ? "bg-warm-active/15 text-warm-active"
                        : undefined
                    }
                    disabled={isBusy || !readiness.experimentalModesAvailable}
                    onClick={() => onGoalModeChange(!draft.goalMode)}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <TargetIcon />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{copy.goalsMode}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    aria-label={copy.planMode}
                    aria-pressed={draft.planMode}
                    className={
                      draft.planMode
                        ? "bg-warm-active/15 text-warm-active"
                        : undefined
                    }
                    disabled={isBusy || !readiness.experimentalModesAvailable}
                    onClick={() => onPlanModeChange(!draft.planMode)}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <MapIcon />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{copy.planMode}</TooltipContent>
            </Tooltip>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-xs">
            <span
              className="composer-command-hint shrink-0 font-mono text-caption text-muted-foreground"
              data-composer-command-hint=""
            >
              {copy.commandSend}
            </span>

            {turnState === "running" || turnState === "stopping" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      aria-label={copy.stop}
                      data-composer-action=""
                      disabled={turnState === "stopping"}
                      onClick={() => void onStop()}
                      size="icon-sm"
                      type="button"
                      variant="destructive"
                    >
                      <SquareIcon />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">{copy.stop}</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      aria-describedby="composer-disabled-reason"
                      aria-keyshortcuts="Meta+Enter"
                      aria-label={copy.send}
                      data-composer-action=""
                      disabled={!canSend}
                      onClick={() => void onSend()}
                      size="icon-sm"
                      type="button"
                    >
                      <ArrowUpIcon />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {!canSend
                    ? disabledReason
                    : `${copy.send} · ${copy.commandSend}`}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
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
