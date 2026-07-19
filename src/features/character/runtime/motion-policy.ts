import type {
  CharacterMotionPolicy,
  CharacterState,
} from "@/features/character/model"

const statePriority: Readonly<Record<CharacterState, number>> = {
  idle: 0,
  thinking: 1,
  acting: 1,
  reviewing: 1,
  disconnected: 2,
  waiting_for_user: 3,
  completed: 3,
  error: 3,
}

export interface CharacterStateCursor {
  readonly state: CharacterState
  readonly generation: number
}

export interface CharacterCue {
  readonly motionGroup: "Idle"
  readonly motionIndex: 0
}

export const neutralCharacterCue: CharacterCue = Object.freeze({
  motionGroup: "Idle",
  motionIndex: 0,
})

export function selectCharacterState(
  current: CharacterStateCursor,
  incoming: CharacterStateCursor,
): CharacterStateCursor {
  if (incoming.generation < current.generation) return current
  if (
    incoming.generation === current.generation &&
    statePriority[incoming.state] < statePriority[current.state]
  ) {
    return current
  }
  return incoming
}

export function resolveMotionPolicy(
  requested: CharacterMotionPolicy,
  systemPrefersReducedMotion: boolean,
  documentVisible: boolean,
): CharacterMotionPolicy {
  if (requested === "hidden" || !documentVisible) return "hidden"
  if (requested === "reduced" || systemPrefersReducedMotion) return "reduced"
  return "animated"
}
