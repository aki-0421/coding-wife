import { useLayoutEffect, useRef } from "react"

import {
  isCaptionTargetFullyVisible,
  scheduleAfterCaptionPaint,
} from "@/features/narration/components/caption-visibility"
import type {
  PresenceCaptionVisibilityAcknowledgment,
  PresenceDirectionPresentationSnapshot,
} from "@/features/narration/controller"

export interface PresenceDirectionCaptionProps {
  readonly presentation: PresenceDirectionPresentationSnapshot
  readonly onVisible: (
    acknowledgment: PresenceCaptionVisibilityAcknowledgment,
  ) => boolean | void
}

export function PresenceDirectionCaption({
  presentation,
  onVisible,
}: PresenceDirectionCaptionProps) {
  const captionRef = useRef<HTMLParagraphElement>(null)
  const acknowledgedGenerationRef = useRef(-1)

  useLayoutEffect(() => {
    const caption = captionRef.current
    if (
      caption === null ||
      acknowledgedGenerationRef.current === presentation.presentationGeneration
    ) {
      return
    }

    let cancelPaint: () => void = () => undefined
    const scan = () => {
      cancelPaint()
      cancelPaint = scheduleAfterCaptionPaint(() => {
        if (
          acknowledgedGenerationRef.current ===
            presentation.presentationGeneration ||
          !isCaptionTargetFullyVisible(caption)
        ) {
          return
        }
        const accepted = onVisible({
          requestId: presentation.requestId,
          presentationGeneration: presentation.presentationGeneration,
        })
        if (accepted !== false) {
          acknowledgedGenerationRef.current =
            presentation.presentationGeneration
        }
      })
    }

    window.addEventListener("resize", scan)
    document.addEventListener("visibilitychange", scan)
    scan()
    return () => {
      window.removeEventListener("resize", scan)
      document.removeEventListener("visibilitychange", scan)
      cancelPaint()
    }
  }, [onVisible, presentation.presentationGeneration, presentation.requestId])

  return (
    <p
      aria-atomic="true"
      aria-live="polite"
      className="m-0 max-w-full whitespace-nowrap rounded-control border border-divider bg-app-bg/95 px-sm py-xs text-caption text-foreground shadow-overlay backdrop-blur-sm"
      data-presence-direction-cue={presentation.cue}
      data-presence-direction-request={presentation.requestId}
      data-presence-direction-speech={presentation.speechStatus}
      ref={captionRef}
      role="status"
    >
      {presentation.utterance}
    </p>
  )
}
