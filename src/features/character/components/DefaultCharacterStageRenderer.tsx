import { useState } from "react"

import { Live2dCharacter } from "@/features/character/components/Live2dCharacter"
import type { CharacterState } from "@/features/character/model"
import { mapCompanionStateToCharacterState } from "@/features/character/semantic-state"
import type {
  CharacterStageRenderProps,
  CompanionSemanticState,
} from "@/features/workspace-view/types"

interface CharacterPresentation {
  readonly workspaceId: string
  readonly semanticState: CompanionSemanticState
  readonly characterState: CharacterState
  readonly generation: number
}

function createPresentation(
  workspaceId: string,
  semanticState: CompanionSemanticState,
  generation: number,
): CharacterPresentation {
  return {
    workspaceId,
    semanticState,
    characterState: mapCompanionStateToCharacterState(semanticState),
    generation,
  }
}

export function DefaultCharacterStageRenderer({
  workspaceId,
  state,
  muted,
  reducedMotion,
}: CharacterStageRenderProps) {
  const [presentation, setPresentation] = useState(() =>
    createPresentation(workspaceId, state, 1),
  )

  if (
    presentation.workspaceId !== workspaceId ||
    presentation.semanticState !== state
  ) {
    setPresentation(
      createPresentation(workspaceId, state, presentation.generation + 1),
    )
  }

  return (
    <div
      className="size-full min-h-0"
      data-character-audio={muted ? "muted" : "unmuted"}
      data-character-generation={presentation.generation}
      data-character-stage-default="bundled-hiyori"
    >
      <Live2dCharacter
        motionPolicy={reducedMotion ? "reduced" : "animated"}
        showCaption={false}
        state={presentation.characterState}
        stateGeneration={presentation.generation}
      />
    </div>
  )
}
