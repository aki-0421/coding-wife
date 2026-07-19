import { useLayoutEffect, useRef } from "react"
import { MessageCircleMoreIcon, Volume2Icon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  isCaptionTargetFullyVisible,
  scrollViewportSelector,
} from "@/features/narration/components/caption-visibility"
import { narrationCopy } from "@/features/narration/copy"
import type {
  CaptionVisibilityAcknowledgment,
  CommitNarrationPresentationSnapshot,
} from "@/features/narration/controller"
import { useI18n } from "@/features/localization"

export interface CommitNarrationCaptionProps {
  readonly presentation: CommitNarrationPresentationSnapshot
  readonly onDismiss: () => void
  readonly onVisible: (
    acknowledgment: CaptionVisibilityAcknowledgment,
  ) => boolean | void
}

function scheduleFrame(callback: FrameRequestCallback): () => void {
  if (typeof window.requestAnimationFrame === "function") {
    const id = window.requestAnimationFrame(callback)
    return () => window.cancelAnimationFrame(id)
  }
  const id = window.setTimeout(() => callback(performance.now()), 16)
  return () => window.clearTimeout(id)
}

function presentationVariant(
  presentation: CommitNarrationPresentationSnapshot,
): "destructive" | "outline" | "running" | "success" {
  if (presentation.status === "unavailable") return "destructive"
  if (presentation.status === "ready") return "success"
  if (
    presentation.status === "preparing" ||
    presentation.status === "streaming"
  ) {
    return "running"
  }
  return "outline"
}

export function CommitNarrationCaption({
  presentation,
  onDismiss,
  onVisible,
}: CommitNarrationCaptionProps) {
  const rootRef = useRef<HTMLElement>(null)
  const acknowledgedRef = useRef({
    presentationGeneration: -1,
    sequences: new Set<number>(),
  })
  const { locale } = useI18n()
  const copy = narrationCopy[locale]
  const canDismiss =
    presentation.status !== "canceled" && presentation.status !== "unavailable"
  const emptyMessage =
    presentation.status === "preparing"
      ? copy.captionPreparing
      : copy.captionEmpty

  useLayoutEffect(() => {
    const root = rootRef.current
    const lastSequence = presentation.lastSequence
    if (
      root === null ||
      lastSequence === null ||
      presentation.status === "canceled" ||
      presentation.status === "unavailable"
    ) {
      return
    }

    if (
      acknowledgedRef.current.presentationGeneration !==
      presentation.presentationGeneration
    ) {
      acknowledgedRef.current = {
        presentationGeneration: presentation.presentationGeneration,
        sequences: new Set(),
      }
    }
    const acknowledged = acknowledgedRef.current.sequences
    let canceled = false
    let cancelBeforePaint: () => void = () => undefined
    let cancelAfterPaint: () => void = () => undefined
    const scan = () => {
      for (const target of root.querySelectorAll<HTMLElement>(
        "[data-narration-sequence]",
      )) {
        const sequence = Number(target.dataset.narrationSequence)
        if (
          !Number.isSafeInteger(sequence) ||
          sequence < 0 ||
          sequence > lastSequence ||
          acknowledged.has(sequence) ||
          !isCaptionTargetFullyVisible(target)
        ) {
          continue
        }
        const accepted = onVisible({
          key: presentation.key,
          presentationGeneration: presentation.presentationGeneration,
          sequence,
        })
        if (accepted !== false) acknowledged.add(sequence)
      }
    }
    const scheduleScan = () => {
      cancelBeforePaint()
      cancelAfterPaint()
      cancelAfterPaint = () => undefined
      cancelBeforePaint = scheduleFrame(() => {
        cancelAfterPaint = scheduleFrame(() => {
          if (!canceled) scan()
        })
      })
    }
    const viewport = root.querySelector<HTMLElement>(scrollViewportSelector)
    viewport?.addEventListener("scroll", scheduleScan, { passive: true })
    window.addEventListener("resize", scheduleScan)
    document.addEventListener("visibilitychange", scheduleScan)
    scheduleScan()
    return () => {
      canceled = true
      viewport?.removeEventListener("scroll", scheduleScan)
      window.removeEventListener("resize", scheduleScan)
      document.removeEventListener("visibilitychange", scheduleScan)
      cancelBeforePaint()
      cancelAfterPaint()
    }
  }, [
    onVisible,
    presentation.key,
    presentation.lastSequence,
    presentation.presentationGeneration,
    presentation.status,
  ])

  return (
    <section
      aria-label={copy.captionTitle}
      className="overflow-hidden rounded-panel border border-divider bg-app-bg/95 shadow-overlay backdrop-blur-sm"
      data-commit-narration-status={presentation.status}
      data-narration-speech={presentation.speechStatus}
      ref={rootRef}
    >
      <header className="flex min-h-9 items-center gap-sm border-b border-divider px-md py-xs">
        <MessageCircleMoreIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-primary"
        />
        <div className="min-w-0 flex-1">
          <h2 className="m-0 truncate text-title text-text-strong">
            {copy.captionTitle}
          </h2>
          <p className="m-0 font-mono text-label text-muted-foreground">
            {presentation.key.commitSha.slice(0, 8)}
          </p>
        </div>
        <Badge variant={presentationVariant(presentation)}>
          {copy.presentationStatuses[presentation.status]}
        </Badge>
        <Badge className="max-[700px]:hidden" variant="outline">
          <Volume2Icon aria-hidden="true" />
          {copy.speechStatuses[presentation.speechStatus]}
        </Badge>
        {canDismiss ? (
          <Button
            aria-label={copy.cancelPresentation}
            onClick={onDismiss}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" />
          </Button>
        ) : null}
      </header>

      {presentation.chunks.length > 0 ? (
        <ScrollArea className="max-h-52 min-h-0">
          <ol
            aria-label={copy.captionTitle}
            aria-live="polite"
            aria-relevant="additions text"
            className="m-0 flex list-none flex-col gap-sm px-md py-sm"
            role="log"
          >
            {presentation.chunks.map((chunk, sequence) => (
              <li
                className="border-l-2 border-primary/50 pl-sm text-caption leading-relaxed text-foreground"
                data-narration-sequence={sequence}
                key={`${presentation.presentationGeneration}:${sequence}`}
              >
                {chunk}
              </li>
            ))}
          </ol>
        </ScrollArea>
      ) : (
        <p
          aria-live="polite"
          className="m-0 px-md py-sm text-caption text-muted-foreground"
          role="status"
        >
          {emptyMessage}
        </p>
      )}

      {presentation.status === "unavailable" ? (
        <p
          className="m-0 border-t border-destructive/30 bg-destructive/10 px-md py-xs font-mono text-label text-destructive"
          role="alert"
        >
          {presentation.errorCode ?? "NARRATION-PRESENTATION-UNAVAILABLE"}
        </p>
      ) : null}
    </section>
  )
}
