import { Volume2Icon, VolumeXIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { WorkspaceCopy } from "@/features/workspace-view/copy"
import type {
  CharacterStageRenderer,
  CompanionSemanticState,
} from "@/features/workspace-view/types"

interface CharacterStageSlotProps {
  readonly copy: WorkspaceCopy
  readonly hidden: boolean
  readonly muted: boolean
  readonly reducedMotion: boolean
  readonly renderer?: CharacterStageRenderer | undefined
  readonly state: CompanionSemanticState
  readonly workspaceId: string
  readonly onMutedChange: (muted: boolean) => void
}

export function CharacterStageSlot({
  copy,
  hidden,
  muted,
  reducedMotion,
  renderer,
  state,
  workspaceId,
  onMutedChange,
}: CharacterStageSlotProps) {
  const stateLabel =
    state === "disconnected"
      ? copy.character.disconnected
      : state.replaceAll("_", " ")

  return (
    <aside
      aria-labelledby="companion-state"
      className="companion-pane relative min-h-0 overflow-hidden bg-app-bg"
    >
      {!hidden && renderer ? (
        <div className="absolute inset-0" data-character-stage-slot="ready">
          {renderer({ workspaceId, state, muted, reducedMotion })}
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

      <div className="absolute inset-x-xl bottom-lg flex items-end justify-between gap-md">
        <div className="min-w-0 rounded-control bg-app-bg/90 px-xs py-xxs">
          <p className="m-0 text-label text-muted-foreground">
            {copy.character.state}
          </p>
          <p
            className="m-0 truncate text-caption text-foreground"
            id="companion-state"
          >
            {stateLabel} ·{" "}
            {muted ? copy.character.muted : copy.character.unmuted}
          </p>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={muted ? copy.character.unmute : copy.character.mute}
              aria-pressed={muted}
              className="shrink-0 rounded-circle border-white/10 bg-selected-row/80"
              onClick={() => onMutedChange(!muted)}
              size="icon-sm"
              type="button"
              variant="secondary"
            >
              {muted ? <VolumeXIcon /> : <Volume2Icon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {muted ? copy.character.unmute : copy.character.mute}
          </TooltipContent>
        </Tooltip>
      </div>
    </aside>
  )
}
