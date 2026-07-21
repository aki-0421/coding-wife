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
  activeWorkspaceId: string | null,
  generation: number | null,
  phase: WorkspaceCodexState["phase"],
): CompletionSourceSnapshot | null {
  if (activeWorkspaceId === null) return null
  return {
    workspaceId: activeWorkspaceId,
    generation,
    phase,
  }
}

function cueFromCompletionTransition(
  previous: CompletionSourceSnapshot | null,
  current: CompletionSourceSnapshot | null,
  connected: boolean,
  errorCode: string | null,
  pendingRequestCount: number,
): CharacterCompletionCue | null {
  if (
    current === null ||
    current.phase !== "completed" ||
    previous === null ||
    !isCompletionSourcePhase(previous.phase) ||
    previous.workspaceId !== current.workspaceId ||
    previous.generation !== current.generation ||
    !connected ||
    errorCode !== null ||
    pendingRequestCount > 0
  ) {
    return null
  }
  return {
    workspaceId: current.workspaceId,
    generation: current.generation,
  }
}

export function useCompletedCharacterCue(
  codex: WorkspaceCodexState,
): CharacterCompletionCue | null {
  const { activeWorkspaceId, connected, errorCode, generation, phase } = codex
  const pendingRequestCount = codex.pendingRequests.length
  const previousSourceRef = useRef<CompletionSourceSnapshot | null>(
    snapshotCompletionSource(activeWorkspaceId, generation, phase),
  )
  const [cue, setCue] = useState<CharacterCompletionCue | null>(null)
  const currentSource = snapshotCompletionSource(
    activeWorkspaceId,
    generation,
    phase,
  )
  const transitionCue = cueFromCompletionTransition(
    previousSourceRef.current,
    currentSource,
    connected,
    errorCode,
    pendingRequestCount,
  )

  useEffect(() => {
    const previous = previousSourceRef.current
    const current = snapshotCompletionSource(
      activeWorkspaceId,
      generation,
      phase,
    )
    previousSourceRef.current = current

    const completedCue = cueFromCompletionTransition(
      previous,
      current,
      connected,
      errorCode,
      pendingRequestCount,
    )
    const completionIdentityChanged =
      current !== null &&
      previous !== null &&
      !completionCueMatches(previous, current.workspaceId, current.generation)

    if (completedCue === null) {
      if (
        current?.phase !== "completed" ||
        completionIdentityChanged ||
        !connected ||
        errorCode !== null ||
        pendingRequestCount > 0
      ) {
        setCue(null)
      }
      return
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
    activeWorkspaceId,
    connected,
    errorCode,
    generation,
    pendingRequestCount,
    phase,
  ])

  const activeCue =
    currentSource?.phase === "completed" &&
    connected &&
    errorCode === null &&
    pendingRequestCount === 0 &&
    completionCueMatches(
      cue,
      currentSource.workspaceId,
      currentSource.generation,
    )
      ? cue
      : null

  return transitionCue ?? activeCue
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
