import { Volume2Icon, VolumeXIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  getCharacterErrorMessage,
  type CharacterRuntimeView,
} from "@/features/character"
import { useI18n } from "@/features/localization"
import {
  CommitNarrationCaption,
  useNarrationController,
  useNarrationSnapshot,
} from "@/features/narration"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import type {
  CharacterStageRenderer,
  CompanionSemanticState,
} from "@/features/workspace-view/types"

interface CharacterStageSlotProps {
  readonly copy: WorkspaceCopy
  readonly characterRuntime: CharacterRuntimeView
  readonly hidden: boolean
  readonly muted: boolean
  readonly reducedMotion: boolean
  readonly renderer?: CharacterStageRenderer | undefined
  readonly state: CompanionSemanticState
  readonly workspaceId: string
  readonly onMutedChange: (muted: boolean) => void
  readonly onRetryCharacter: () => void
}

export function CharacterStageSlot({
  copy,
  characterRuntime,
  hidden,
  muted,
  reducedMotion,
  renderer,
  state,
  workspaceId,
  onMutedChange,
  onRetryCharacter,
}: CharacterStageSlotProps) {
  const { locale } = useI18n()
  const narrationController = useNarrationController()
  const narration = useNarrationSnapshot()
  const CharacterRenderer = renderer
  const presentation =
    narration.presentation?.key.workspaceId === workspaceId &&
    narration.presentation.status !== "canceled"
      ? narration.presentation
      : null
  const presentationActive =
    presentation?.status === "preparing" ||
    presentation?.status === "streaming" ||
    presentation?.status === "ready"
  const speaking =
    presentation?.speechStatus === "queued" ||
    presentation?.speechStatus === "playing"
  const effectiveMuted = narration.settingsSnapshot?.settings.muted ?? muted
  const semanticState = presentationActive ? "reviewing" : state
  const stateLabel = copy.character.semanticState[semanticState]
  const runtimeDetail = (() => {
    if (characterRuntime.rendererKind === "external") {
      return copy.character.externalRenderer
    }
    if (characterRuntime.currentErrorCode !== null) {
      return `${getCharacterErrorMessage(locale, characterRuntime.currentErrorCode)} ${copy.settingsView.characterFallbacks[characterRuntime.fallback]}`
    }
    if (characterRuntime.readiness === "loading") {
      return copy.settingsView.live2dLoading
    }
    if (characterRuntime.readiness === "recovering") {
      return `${copy.settingsView.live2dRecovering} · ${copy.settingsView.characterFallbacks[characterRuntime.fallback]}`
    }
    if (characterRuntime.readiness === "degraded") {
      return `${copy.settingsView.live2dDegraded} · ${copy.settingsView.characterFallbacks[characterRuntime.fallback]}`
    }
    return null
  })()
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

  return (
    <aside
      aria-labelledby="companion-state"
      className="companion-pane relative min-h-0 overflow-hidden bg-app-bg"
      data-narration-presentation={presentation?.status ?? "inactive"}
      data-narration-speech={presentation?.speechStatus ?? "idle"}
    >
      {!hidden && CharacterRenderer ? (
        <div className="absolute inset-0" data-character-stage-slot="ready">
          <CharacterRenderer
            muted={effectiveMuted}
            reducedMotion={reducedMotion}
            speaking={speaking}
            state={semanticState}
            workspaceId={workspaceId}
          />
        </div>
      ) : !hidden ? (
        <div
          className="absolute inset-0 flex items-center justify-center px-2xl pb-20 text-center"
          data-character-stage-slot="pending"
        >
          <div className="flex max-w-64 flex-col items-center gap-xs">
            <span
              aria-hidden="true"
              className="mb-xs size-9 rounded-circle border border-dashed border-muted-foreground"
            />
            <p className="m-0 text-title text-text-strong">
              {copy.character.rendererPending}
            </p>
            <p className="m-0 text-caption text-muted-foreground">
              {copy.character.rendererDescription}
            </p>
          </div>
        </div>
      ) : null}

      {presentation ? (
        <div className="absolute inset-x-xl bottom-20 z-20 max-[700px]:inset-x-md">
          <CommitNarrationCaption
            onDismiss={() => void narrationController.dismissPresentation()}
            onVisible={narrationController.acknowledgeCaptionVisible}
            presentation={presentation}
          />
        </div>
      ) : null}

      <div className="absolute inset-x-xl bottom-lg flex items-end justify-between gap-md">
        <div
          aria-live="polite"
          className="min-w-0 max-w-[34ch] rounded-control bg-app-bg/90 px-xs py-xxs"
          data-character-runtime-readiness={characterRuntime.readiness}
          role={characterRuntime.currentErrorCode ? "alert" : "status"}
        >
          <p className="m-0 text-label text-muted-foreground">
            {copy.character.state}
          </p>
          <p
            className="m-0 truncate text-caption text-foreground"
            id="companion-state"
          >
            {stateLabel} ·{" "}
            {effectiveMuted ? copy.character.muted : copy.character.unmuted}
          </p>
          {runtimeDetail ? (
            <p className="m-0 text-caption text-muted-foreground">
              {runtimeDetail}
            </p>
          ) : null}
          {characterRuntime.canRetry ? (
            <Button
              className="mt-xs"
              onClick={onRetryCharacter}
              size="xs"
              type="button"
              variant="secondary"
            >
              {copy.character.retryRenderer}
            </Button>
          ) : null}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={
                effectiveMuted ? copy.character.unmute : copy.character.mute
              }
              aria-pressed={effectiveMuted}
              className="shrink-0 rounded-circle border-white/10 bg-selected-row/80"
              disabled={narration.settingsStatus === "saving"}
              onClick={() => void toggleMuted()}
              size="icon-sm"
              type="button"
              variant="secondary"
            >
              {effectiveMuted ? <VolumeXIcon /> : <Volume2Icon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {effectiveMuted ? copy.character.unmute : copy.character.mute}
          </TooltipContent>
        </Tooltip>
      </div>
    </aside>
  )
}
