import {
  AlertTriangleIcon,
  InfoIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { CharacterRuntimeView } from "@/features/character"
import { CharacterStageSlot } from "@/features/workspace-view/CharacterStageSlot"
import { Composer } from "@/features/workspace-view/Composer"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import { Timeline } from "@/features/workspace-view/Timeline"
import type { TurnUiState } from "@/features/workspace-view/useWorkspaceViewModel"
import type {
  CharacterStageRenderer,
  ContextSnapshotItem,
  ReasoningEffort,
  WorkspaceAdapterState,
  WorkspaceDraft,
  WorkspaceTimelineItem,
} from "@/features/workspace-view/types"
import { cn } from "@/lib/utils"

interface ChatViewProps {
  readonly characterHidden: boolean
  readonly characterRuntime: CharacterRuntimeView
  readonly connected: boolean
  readonly copy: WorkspaceCopy
  readonly draft: WorkspaceDraft
  readonly history: WorkspaceAdapterState["history"]
  readonly muted: boolean
  readonly reducedMotion: boolean
  readonly renderer?: CharacterStageRenderer | undefined
  readonly runtimeError: boolean
  readonly turnState: TurnUiState
  readonly timeline: readonly WorkspaceTimelineItem[]
  readonly workspaceId: string
  readonly onAddAttachments: (files: readonly File[]) => void
  readonly onCaptureContext: (
    source: ContextSnapshotItem["source"],
  ) => void | Promise<void>
  readonly onDraftChange: (value: string) => void
  readonly onEffortChange: (effort: ReasoningEffort) => void
  readonly onMutedChange: (muted: boolean) => void
  readonly onOpenDiagnostics: () => void
  readonly onPickAttachments?: (() => void | Promise<void>) | undefined
  readonly onRegisterAttachmentPaths?:
    | ((
        source: "drop" | "paste",
        paths: readonly string[],
      ) => void | Promise<void>)
    | undefined
  readonly onRemoveAttachment: (attachmentId: string) => void
  readonly onRemoveContext: (snapshotId: string) => void
  readonly onRetryRuntime: () => void
  readonly onRetryCharacter: () => void
  readonly onSend: () => Promise<boolean>
  readonly onStop: () => void | Promise<void>
}

export function ChatView({
  characterHidden,
  characterRuntime,
  connected,
  copy,
  draft,
  history,
  muted,
  reducedMotion,
  renderer,
  runtimeError,
  turnState,
  timeline,
  workspaceId,
  onAddAttachments,
  onCaptureContext,
  onDraftChange,
  onEffortChange,
  onMutedChange,
  onOpenDiagnostics,
  onPickAttachments,
  onRegisterAttachmentPaths,
  onRemoveAttachment,
  onRemoveContext,
  onRetryRuntime,
  onRetryCharacter,
  onSend,
  onStop,
}: ChatViewProps) {
  const companionState = connected
    ? turnState === "running" || turnState === "sending"
      ? "acting"
      : "idle"
    : "disconnected"

  return (
    <div
      className={cn(
        "chat-layout grid size-full min-h-0 bg-app-bg",
        characterHidden && "character-hidden",
      )}
    >
      <section
        aria-labelledby="activity-heading"
        className="chat-pane relative min-h-0 overflow-hidden"
      >
        <h1 className="sr-only" id="activity-heading">
          {copy.timelineTitle}
        </h1>

        <div
          className={cn(
            "absolute inset-x-0 top-0 z-10 flex min-h-9 items-center gap-xs border-b border-divider bg-surface px-xl py-xs text-caption",
            runtimeError ? "text-destructive" : "text-muted-foreground",
          )}
          role={runtimeError ? "alert" : "status"}
        >
          {runtimeError ? (
            <AlertTriangleIcon aria-hidden="true" className="size-3 shrink-0" />
          ) : (
            <InfoIcon aria-hidden="true" className="size-3 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {runtimeError
              ? copy.runtimeErrorTitle
              : history.mode === "ready"
                ? copy.previewNoticeWithHistory
                : history.mode === "ephemeral"
                  ? copy.previewNoticeWithEphemeralHistory
                  : copy.previewNotice}
          </span>
          {runtimeError ? (
            <Button
              onClick={onRetryRuntime}
              size="xs"
              type="button"
              variant="ghost"
            >
              {copy.retry}
            </Button>
          ) : null}
        </div>

        <ScrollArea className="size-full pt-9">
          <div className="px-xl">
            <Timeline
              compactStatus={
                <div
                  className="companion-status-mobile hidden max-w-full items-center gap-xs rounded-control bg-surface px-xs py-xxs text-caption text-muted-foreground"
                  data-companion-status-mobile=""
                >
                  <span
                    aria-hidden="true"
                    className="size-[7px] rotate-45 border border-muted-foreground"
                  />
                  <span className="truncate">
                    {copy.character.disconnected}
                  </span>
                  <Button
                    aria-label={
                      muted ? copy.character.unmute : copy.character.mute
                    }
                    aria-pressed={muted}
                    className="-my-xxs"
                    onClick={() => onMutedChange(!muted)}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    {muted ? <VolumeXIcon /> : <Volume2Icon />}
                  </Button>
                </div>
              }
              copy={copy}
              events={timeline}
              history={history}
              onOpenDiagnostics={onOpenDiagnostics}
            />
          </div>
        </ScrollArea>

        <Composer
          connected={connected}
          copy={copy}
          draft={draft}
          onAddAttachments={onAddAttachments}
          onCaptureContext={onCaptureContext}
          onDraftChange={onDraftChange}
          onEffortChange={onEffortChange}
          onPickAttachments={onPickAttachments}
          onRegisterAttachmentPaths={onRegisterAttachmentPaths}
          onRemoveAttachment={onRemoveAttachment}
          onRemoveContext={onRemoveContext}
          onSend={onSend}
          onStop={onStop}
          turnState={turnState}
        />
      </section>

      {!characterHidden ? (
        <CharacterStageSlot
          characterRuntime={characterRuntime}
          copy={copy}
          hidden={characterHidden}
          muted={muted}
          onMutedChange={onMutedChange}
          onRetryCharacter={onRetryCharacter}
          reducedMotion={reducedMotion}
          state={companionState}
          workspaceId={workspaceId}
          {...(renderer ? { renderer } : {})}
        />
      ) : null}
    </div>
  )
}
