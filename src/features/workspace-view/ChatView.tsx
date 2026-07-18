import {
  AlertTriangleIcon,
  ArrowDownIcon,
  InfoIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { CharacterRuntimeView } from "@/features/character"
import {
  CommitNarrationCaption,
  useNarrationController,
  useNarrationSnapshot,
} from "@/features/narration"
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
  WorkspaceCodexState,
  WorkspaceDraft,
  WorkspaceTimelineItem,
} from "@/features/workspace-view/types"
import type { ApprovalDecision, PendingRequestView } from "@/lib/contracts"
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
  readonly readiness: WorkspaceCodexState["readiness"]
  readonly renderer?: CharacterStageRenderer | undefined
  readonly runtimeError: boolean
  readonly turnState: TurnUiState
  readonly timeline: readonly WorkspaceTimelineItem[]
  readonly pendingRequestIds: readonly string[]
  readonly workspaceId: string
  readonly onAddAttachments: (files: readonly File[]) => void
  readonly onAnswerApproval: (
    request: PendingRequestView,
    decision: ApprovalDecision,
  ) => Promise<boolean>
  readonly onAnswerDecision: (
    request: PendingRequestView,
    answers: Readonly<Record<string, readonly string[]>>,
  ) => Promise<boolean>
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
  readonly onStop: () => boolean | void | Promise<boolean | void>
}

interface TimelineScrollAnchor {
  readonly sequence: number
  readonly offsetFromViewportTop: number
}

const timelineScrollAnchors = new Map<string, TimelineScrollAnchor>()

function timelineRows(viewport: HTMLElement): readonly HTMLElement[] {
  return Array.from(
    viewport.querySelectorAll<HTMLElement>("[data-event-sequence]"),
  )
}

function captureTimelineAnchor(
  viewport: HTMLElement,
): TimelineScrollAnchor | null {
  const rows = timelineRows(viewport)
  if (rows.length === 0) return null
  const row = rows.reduce((nearest, candidate) =>
    Math.abs(candidate.offsetTop - viewport.scrollTop) <
    Math.abs(nearest.offsetTop - viewport.scrollTop)
      ? candidate
      : nearest,
  )
  const sequence = Number(row.dataset.eventSequence)
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null
  return {
    sequence,
    offsetFromViewportTop: row.offsetTop - viewport.scrollTop,
  }
}

function restoreTimelineAnchor(
  viewport: HTMLElement,
  anchor: TimelineScrollAnchor,
): boolean {
  const rows = timelineRows(viewport)
  if (rows.length === 0) return false
  const exact = rows.find(
    (row) => Number(row.dataset.eventSequence) === anchor.sequence,
  )
  const row =
    exact ??
    rows.reduce((nearest, candidate) =>
      Math.abs(Number(candidate.dataset.eventSequence) - anchor.sequence) <
      Math.abs(Number(nearest.dataset.eventSequence) - anchor.sequence)
        ? candidate
        : nearest,
    )
  viewport.scrollTop = row.offsetTop - anchor.offsetFromViewportTop
  return true
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
  readiness,
  renderer,
  runtimeError,
  turnState,
  timeline,
  pendingRequestIds,
  workspaceId,
  onAddAttachments,
  onAnswerApproval,
  onAnswerDecision,
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
  const narrationController = useNarrationController()
  const narration = useNarrationSnapshot()
  const scrollRootRef = useRef<HTMLDivElement>(null)
  const previousTimelineLength = useRef(timeline.length)
  const previousTimelineWorkspace = useRef(workspaceId)
  const restoredAnchor = useRef(false)
  const [scrollLocked, setScrollLocked] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const companionState = !connected
    ? "disconnected"
    : pendingRequestIds.length > 0
      ? "waiting_for_user"
      : turnState === "sending"
        ? "thinking"
        : turnState === "running" || turnState === "stopping"
          ? "acting"
          : "idle"
  const presentation =
    narration.presentation?.key.workspaceId === workspaceId &&
    narration.presentation.status !== "canceled"
      ? narration.presentation
      : null
  const presentationActive =
    presentation?.status === "preparing" ||
    presentation?.status === "streaming" ||
    presentation?.status === "ready"
  const effectiveMuted = narration.settingsSnapshot?.settings.muted ?? muted
  const companionStateLabel =
    copy.character.semanticState[
      presentationActive ? "reviewing" : companionState
    ]
  const toggleMuted = async () => {
    const nextMuted = !effectiveMuted
    if (narration.settingsSnapshot === null) {
      onMutedChange(nextMuted)
      return
    }
    if (await narrationController.setMuted(nextMuted)) {
      onMutedChange(nextMuted)
    }
  }

  const scrollToLatest = () => {
    const viewport = scrollRootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    if (!viewport) return
    if (typeof viewport.scrollTo === "function") {
      viewport.scrollTo({
        behavior: reducedMotion ? "auto" : "smooth",
        top: viewport.scrollHeight,
      })
    } else {
      viewport.scrollTop = viewport.scrollHeight
    }
    setScrollLocked(false)
    setUnreadCount(0)
  }

  useLayoutEffect(() => {
    const viewport = scrollRootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    if (!viewport) return
    const anchor = timelineScrollAnchors.get(workspaceId)
    const restored =
      anchor !== undefined && restoreTimelineAnchor(viewport, anchor)
    restoredAnchor.current = restored
    viewport.dataset.scrollRestoration = restored ? "anchor" : "latest"
    if (!restored) {
      viewport.scrollTop = viewport.scrollHeight
    }
    setScrollLocked(false)
    setUnreadCount(0)
    if (!restored || anchor === undefined) return
    const frame = window.requestAnimationFrame(() => {
      restoreTimelineAnchor(viewport, anchor)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [workspaceId])

  useEffect(() => {
    const viewport = scrollRootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    if (!viewport) return
    const updateLock = () => {
      const anchor = captureTimelineAnchor(viewport)
      if (anchor !== null) timelineScrollAnchors.set(workspaceId, anchor)
      const distance =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      const locked = distance > 48
      setScrollLocked(locked)
      if (!locked) setUnreadCount(0)
    }
    viewport.addEventListener("scroll", updateLock, { passive: true })
    updateLock()
    return () => {
      viewport.removeEventListener("scroll", updateLock)
    }
  }, [workspaceId])

  useEffect(() => {
    const viewport = scrollRootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    if (previousTimelineWorkspace.current !== workspaceId) {
      previousTimelineWorkspace.current = workspaceId
      previousTimelineLength.current = timeline.length
      restoredAnchor.current = false
      return
    }
    const added = Math.max(0, timeline.length - previousTimelineLength.current)
    previousTimelineLength.current = timeline.length
    if (!viewport) return
    if (restoredAnchor.current) {
      restoredAnchor.current = false
      return
    }
    if (added === 0) return
    const distance =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    if (distance <= 48) {
      viewport.scrollTop = viewport.scrollHeight
      return
    }
    if (added > 0) setUnreadCount((count) => count + added)
  }, [timeline, workspaceId])

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
                  ? connected
                    ? copy.interactiveDemoNotice
                    : copy.previewNoticeWithEphemeralHistory
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

        <ScrollArea
          className="size-full pt-9"
          data-scroll-locked={scrollLocked || undefined}
          ref={scrollRootRef}
        >
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
                  <span className="truncate">{companionStateLabel}</span>
                  <Button
                    aria-label={
                      effectiveMuted
                        ? copy.character.unmute
                        : copy.character.mute
                    }
                    aria-pressed={effectiveMuted}
                    className="-my-xxs"
                    disabled={narration.settingsStatus === "saving"}
                    onClick={() => void toggleMuted()}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    {effectiveMuted ? <VolumeXIcon /> : <Volume2Icon />}
                  </Button>
                </div>
              }
              copy={copy}
              events={timeline}
              history={history}
              interruptAvailable={turnState === "running"}
              onAnswerApproval={onAnswerApproval}
              onAnswerDecision={onAnswerDecision}
              onInterrupt={onStop}
              onOpenDiagnostics={onOpenDiagnostics}
              pendingRequestIds={pendingRequestIds}
            />
          </div>
        </ScrollArea>

        {presentation ? (
          <div className="absolute inset-x-md bottom-[154px] z-30 hidden max-[840px]:block">
            <CommitNarrationCaption
              onCancel={() => void narrationController.cancelPresentation()}
              onVisible={narrationController.acknowledgeCaptionVisible}
              presentation={presentation}
            />
          </div>
        ) : null}

        {scrollLocked || unreadCount > 0 ? (
          <Button
            className="absolute bottom-[154px] left-1/2 z-20 -translate-x-1/2 shadow-overlay"
            onClick={scrollToLatest}
            size="sm"
            type="button"
            variant="secondary"
          >
            <ArrowDownIcon data-icon="inline-start" />
            {unreadCount > 0
              ? `${copy.timelineEvent.newUpdates}: ${String(unreadCount)}`
              : copy.timelineEvent.latest}
          </Button>
        ) : null}

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
          readiness={readiness}
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
