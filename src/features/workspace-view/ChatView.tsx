import {
  AlertTriangleIcon,
  ArrowDownIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  useNarrationController,
  useNarrationSnapshot,
} from "@/features/narration"
import { Composer } from "@/features/workspace-view/Composer"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import { Timeline } from "@/features/workspace-view/Timeline"
import type { TurnUiState } from "@/features/workspace-view/useWorkspaceViewModel"
import type {
  CharacterSemanticState,
  ContextSnapshotItem,
  ReasoningEffort,
  WorkspaceAdapterState,
  WorkspaceCodexState,
  WorkspaceDraft,
  WorkspaceRecord,
  WorkspaceTimelineItem,
} from "@/features/workspace-view/types"
import type { ApprovalDecision, PendingRequestView } from "@/lib/contracts"
import { cn } from "@/lib/utils"

interface ChatViewProps {
  readonly characterState: CharacterSemanticState
  readonly connected: boolean
  readonly copy: WorkspaceCopy
  readonly draft: WorkspaceDraft
  readonly history: WorkspaceAdapterState["history"]
  readonly lastSummary: WorkspaceAdapterState["lastSummary"]
  readonly muted: boolean
  readonly reducedMotion: boolean
  readonly readiness: WorkspaceCodexState["readiness"]
  readonly repositoryHealth?: WorkspaceRecord["health"]
  readonly runtimeError: boolean
  readonly turnState: TurnUiState
  readonly timeline: readonly WorkspaceTimelineItem[]
  readonly timelineAnchor?: {
    readonly eventId: string
    readonly sequence: number
    readonly offset: number
  } | null
  readonly pendingRequestIds: readonly string[]
  readonly workspaceId: string
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
  readonly onFastModeChange: (enabled: boolean) => void
  readonly onGoalModeChange: (enabled: boolean) => void
  readonly onPlanModeChange: (enabled: boolean) => void
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
  readonly onReconnect: () => void | Promise<void>
  readonly onRetryRuntime: () => void
  readonly onSend: () => Promise<boolean>
  readonly onStop: () => boolean | void | Promise<boolean | void>
  readonly reconnecting: boolean
  readonly onTimelineAnchorChange?: (
    eventId: string,
    sequence: number,
    offset: number,
  ) => void
}

interface TimelineScrollAnchor {
  readonly eventId: string
  readonly sequence: number
  readonly offsetFromViewportTop: number
}

const timelineScrollAnchors = new Map<string, TimelineScrollAnchor>()

function durableTimelineIdentity(
  event: WorkspaceTimelineItem,
): { readonly eventId: string; readonly sequence: number } | null {
  if (event.kind === "history") {
    return { eventId: event.id, sequence: event.sequence }
  }
  if (!event.durable) return null
  return {
    eventId: event.sourceEventId,
    sequence: event.sourceSequence,
  }
}

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
  const eventId = row.dataset.eventId
  if (
    eventId === undefined ||
    eventId.length === 0 ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1
  ) {
    return null
  }
  return {
    eventId,
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
    (row) =>
      row.dataset.eventId === anchor.eventId &&
      Number(row.dataset.eventSequence) === anchor.sequence,
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
  characterState,
  connected,
  copy,
  draft,
  history,
  lastSummary,
  muted,
  reducedMotion,
  readiness,
  repositoryHealth,
  runtimeError,
  turnState,
  timeline,
  timelineAnchor,
  pendingRequestIds,
  workspaceId,
  onAnswerApproval,
  onAnswerDecision,
  onCaptureContext,
  onDraftChange,
  onEffortChange,
  onFastModeChange,
  onGoalModeChange,
  onPlanModeChange,
  onMutedChange,
  onOpenDiagnostics,
  onPickAttachments,
  onRegisterAttachmentPaths,
  onRemoveAttachment,
  onRemoveContext,
  onReconnect,
  onRetryRuntime,
  onSend,
  onStop,
  reconnecting,
  onTimelineAnchorChange,
}: ChatViewProps) {
  const narrationController = useNarrationController()
  const narration = useNarrationSnapshot()
  const scrollRootRef = useRef<HTMLDivElement>(null)
  const previousTimelineLength = useRef(timeline.length)
  const previousTimelineWorkspace = useRef(workspaceId)
  const restoredAnchor = useRef(false)
  const anchorSaveTimer = useRef<number | null>(null)
  const [scrollLocked, setScrollLocked] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const presentation =
    narration.presentation?.key.workspaceId === workspaceId &&
    narration.presentation.status !== "canceled"
      ? narration.presentation
      : null
  const presentationActive =
    presentation?.status === "preparing" ||
    presentation?.status === "streaming" ||
    presentation?.status === "ready"
  const timelineAnchorAvailable =
    timelineAnchor !== null &&
    timelineAnchor !== undefined &&
    timeline.some((event) => {
      const identity = durableTimelineIdentity(event)
      return (
        identity?.eventId === timelineAnchor.eventId &&
        identity.sequence === timelineAnchor.sequence
      )
    })
  const timelineAnchorEventId = timelineAnchor?.eventId
  const timelineAnchorOffset = timelineAnchor?.offset
  const timelineAnchorSequence = timelineAnchor?.sequence
  const effectiveMuted = narration.settingsSnapshot?.settings.muted ?? muted
  const characterStateLabel =
    copy.character.semanticState[
      presentationActive ? "reviewing" : characterState
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
    const persistedAnchor =
      !timelineAnchorAvailable ||
      timelineAnchorEventId === undefined ||
      timelineAnchorOffset === undefined ||
      timelineAnchorSequence === undefined
        ? undefined
        : {
            eventId: timelineAnchorEventId,
            sequence: timelineAnchorSequence,
            offsetFromViewportTop: timelineAnchorOffset,
          }
    const anchor = persistedAnchor ?? timelineScrollAnchors.get(workspaceId)
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
  }, [
    timelineAnchorEventId,
    timelineAnchorOffset,
    timelineAnchorSequence,
    timelineAnchorAvailable,
    workspaceId,
  ])

  useEffect(() => {
    const viewport = scrollRootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    if (!viewport) return
    const updateLock = () => {
      const anchor = captureTimelineAnchor(viewport)
      if (anchor !== null) {
        timelineScrollAnchors.set(workspaceId, anchor)
        if (anchorSaveTimer.current !== null) {
          window.clearTimeout(anchorSaveTimer.current)
        }
        anchorSaveTimer.current = window.setTimeout(() => {
          anchorSaveTimer.current = null
          onTimelineAnchorChange?.(
            anchor.eventId,
            anchor.sequence,
            Math.round(anchor.offsetFromViewportTop),
          )
        }, 150)
      }
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
      if (anchorSaveTimer.current !== null) {
        window.clearTimeout(anchorSaveTimer.current)
        anchorSaveTimer.current = null
      }
    }
  }, [onTimelineAnchorChange, workspaceId])

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
    <div className="size-full min-h-0 bg-app-bg">
      <section
        aria-labelledby="activity-heading"
        className="chat-pane relative min-h-0 overflow-hidden"
      >
        <h1 className="sr-only" id="activity-heading">
          {copy.timelineTitle}
        </h1>

        {runtimeError ? (
          <div
            className="absolute inset-x-0 top-0 z-10 flex min-h-9 items-center gap-xs border-b border-divider bg-surface px-xl py-xs text-caption text-destructive"
            role="alert"
          >
            <AlertTriangleIcon aria-hidden="true" className="size-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {copy.runtimeErrorTitle}
            </span>
            <Button
              onClick={onRetryRuntime}
              size="xs"
              type="button"
              variant="ghost"
            >
              {copy.retry}
            </Button>
          </div>
        ) : null}

        <ScrollArea
          className={cn("size-full", runtimeError && "pt-9")}
          data-scroll-locked={scrollLocked || undefined}
          ref={scrollRootRef}
        >
          <div className="px-xl">
            <Timeline
              compactStatus={
                <div
                  className="character-status-mobile hidden max-w-full items-center gap-xs rounded-control bg-surface px-xs py-xxs text-caption text-muted-foreground"
                  data-character-status-mobile=""
                >
                  <span
                    aria-hidden="true"
                    className="size-[7px] rotate-45 border border-muted-foreground"
                  />
                  <span className="truncate">{characterStateLabel}</span>
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
              lastSummary={lastSummary}
              onAnswerApproval={onAnswerApproval}
              onAnswerDecision={onAnswerDecision}
              onInterrupt={onStop}
              onOpenDiagnostics={onOpenDiagnostics}
              pendingRequestIds={pendingRequestIds}
            />
          </div>
        </ScrollArea>

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
          onCaptureContext={onCaptureContext}
          onDraftChange={onDraftChange}
          onEffortChange={onEffortChange}
          onFastModeChange={onFastModeChange}
          onGoalModeChange={onGoalModeChange}
          onPlanModeChange={onPlanModeChange}
          onPickAttachments={onPickAttachments}
          onRegisterAttachmentPaths={onRegisterAttachmentPaths}
          onRemoveAttachment={onRemoveAttachment}
          onRemoveContext={onRemoveContext}
          onReconnect={onReconnect}
          onSend={onSend}
          onStop={onStop}
          reconnecting={reconnecting}
          readiness={readiness}
          repositoryHealth={repositoryHealth}
          turnState={turnState}
        />
      </section>
    </div>
  )
}
