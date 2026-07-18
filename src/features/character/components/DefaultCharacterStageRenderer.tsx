import { useCallback, useEffect, useMemo, useState } from "react"

import { Live2dCharacter } from "@/features/character/components/Live2dCharacter"
import type {
  CharacterControllerStatus,
  CharacterState,
} from "@/features/character/model"
import {
  useCharacterLibrary,
  useCharacterLibraryStore,
} from "@/features/character/library/provider"
import { useCharacterRuntimeStatusStore } from "@/features/character/runtime-status"
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
  speaking = false,
}: CharacterStageRenderProps) {
  const runtimeStatus = useCharacterRuntimeStatusStore()
  const characterLibrary = useCharacterLibrary(workspaceId)
  const characterLibraryStore = useCharacterLibraryStore()
  const [presentation, setPresentation] = useState(() =>
    createPresentation(workspaceId, state, 1),
  )
  const [reloadToken, setReloadToken] = useState(0)
  const selectedPackRef = useMemo(
    () =>
      characterLibrary.snapshot === null
        ? undefined
        : (characterLibraryStore.selectedPackRef(workspaceId) ?? undefined),
    [characterLibrary.snapshot, characterLibraryStore, workspaceId],
  )

  if (
    presentation.workspaceId !== workspaceId ||
    presentation.semanticState !== state
  ) {
    setPresentation(
      createPresentation(workspaceId, state, presentation.generation + 1),
    )
  }
  const retry = useCallback(() => setReloadToken((token) => token + 1), [])
  const runtimeGeneration = presentation.generation * 1_000_000 + reloadToken
  const session = useMemo(
    () =>
      runtimeStatus.createSession(presentation.workspaceId, runtimeGeneration),
    [presentation.workspaceId, runtimeGeneration, runtimeStatus],
  )
  const handleControllerChange = useCallback(
    (controller: unknown) => {
      if (controller === null) runtimeStatus.unmount(session)
      else runtimeStatus.mount(session, retry)
    },
    [retry, runtimeStatus, session],
  )
  const handleStatusChange = useCallback(
    (status: CharacterControllerStatus) => {
      runtimeStatus.report(session, status, retry)
    },
    [retry, runtimeStatus, session],
  )

  useEffect(
    () => () => {
      runtimeStatus.unmount(session)
    },
    [runtimeStatus, session],
  )

  return (
    <div
      className="size-full min-h-0"
      data-character-audio={muted ? "muted" : "unmuted"}
      data-character-generation={presentation.generation}
      data-character-pack={
        characterLibrary.snapshot?.selectedPackId ?? "builtin:hiyori_pro"
      }
      data-character-speaking={speaking ? "true" : "false"}
      data-character-stage-default="app-live2d"
    >
      <Live2dCharacter
        {...(selectedPackRef === undefined ? {} : { packRef: selectedPackRef })}
        motionPolicy={reducedMotion ? "reduced" : "animated"}
        onControllerChange={handleControllerChange}
        onStatusChange={handleStatusChange}
        reloadToken={reloadToken}
        showCaption={false}
        state={presentation.characterState}
        stateGeneration={presentation.generation}
      />
    </div>
  )
}
