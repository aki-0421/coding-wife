import { useEffect, useRef, useState } from "react"

import type {
  CharacterSemanticState,
  WorkspaceCodexState,
} from "@/features/workspace-view/types"
import type { TurnUiState } from "@/features/workspace-view/useWorkspaceViewModel"

// Keeps the bundled 2.1-second success motion observable without delaying the
// completed turn.
export const characterCompletionDwellMs = 2_500

export interface CharacterCompletionCue {
  readonly workspaceId: string
  readonly generation: number | null
}

interface CompletionSourceSnapshot extends CharacterCompletionCue {
  readonly phase: WorkspaceCodexState["phase"]
}

function isCompletionSourcePhase(phase: WorkspaceCodexState["phase"]): boolean {
  return phase === "running" || phase === "waiting" || phase === "stopping"
}

function completionCueMatches(
  cue: CharacterCompletionCue | null,
  workspaceId: string,
  generation: number | null,
): boolean {
  return (
    cue !== null &&
    cue.workspaceId === workspaceId &&
    cue.generation === generation
  )
}

function snapshotCompletionSource(
  codex: WorkspaceCodexState,
): CompletionSourceSnapshot | null {
  if (codex.activeWorkspaceId === null) return null
  return {
    workspaceId: codex.activeWorkspaceId,
    generation: codex.generation,
    phase: codex.phase,
  }
}

export function useCompletedCharacterCue(
  codex: WorkspaceCodexState,
): CharacterCompletionCue | null {
  const previousSourceRef = useRef<CompletionSourceSnapshot | null>(
    snapshotCompletionSource(codex),
  )
  const [cue, setCue] = useState<CharacterCompletionCue | null>(null)

  useEffect(() => {
    const previous = previousSourceRef.current
    const current = snapshotCompletionSource(codex)
    previousSourceRef.current = current

    const completedSameSession =
      current !== null &&
      current.phase === "completed" &&
      previous !== null &&
      isCompletionSourcePhase(previous.phase) &&
      previous.workspaceId === current.workspaceId &&
      previous.generation === current.generation &&
      codex.connected &&
      codex.errorCode === null &&
      codex.pendingRequests.length === 0

    if (!completedSameSession) {
      if (
        current?.phase !== "completed" ||
        !codex.connected ||
        codex.errorCode !== null ||
        codex.pendingRequests.length > 0
      ) {
        setCue(null)
      }
      return
    }

    const completedCue: CharacterCompletionCue = {
      workspaceId: current.workspaceId,
      generation: current.generation,
    }
    setCue(completedCue)

    const timeout = window.setTimeout(() => {
      setCue((activeCue) =>
        completionCueMatches(
          activeCue,
          completedCue.workspaceId,
          completedCue.generation,
        )
          ? null
          : activeCue,
      )
    }, characterCompletionDwellMs)

    return () => window.clearTimeout(timeout)
  }, [
    codex.activeWorkspaceId,
    codex.connected,
    codex.errorCode,
    codex.generation,
    codex.pendingRequests.length,
    codex.phase,
  ])

  return cue
}

export interface WorkspaceCharacterStateInput {
  readonly codex: WorkspaceCodexState
  readonly completedCue: CharacterCompletionCue | null
  readonly selectedWorkspaceId: string | null
  readonly turnActive: boolean
  readonly turnState: TurnUiState
}

export function deriveWorkspaceCharacterState({
  codex,
  completedCue,
  selectedWorkspaceId,
  turnActive,
  turnState,
}: WorkspaceCharacterStateInput): CharacterSemanticState {
  const selectedOwnsExecution =
    selectedWorkspaceId !== null &&
    codex.activeWorkspaceId === selectedWorkspaceId

  if (selectedOwnsExecution && codex.pendingRequests.length > 0) {
    return "waiting_for_user"
  }
  if (turnState === "sending") return "thinking"
  if (selectedOwnsExecution && turnActive) return "acting"
  if (
    selectedOwnsExecution &&
    codex.phase === "completed" &&
    codex.connected &&
    codex.errorCode === null &&
    completionCueMatches(completedCue, selectedWorkspaceId, codex.generation)
  ) {
    return "completed"
  }
  return "idle"
}
