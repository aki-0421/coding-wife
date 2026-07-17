import type { CharacterState } from "@/features/character/model"
import type { CompanionSemanticState } from "@/features/workspace-view/types"

export const characterStateByCompanionState = {
  idle: "idle",
  thinking: "thinking",
  acting: "acting",
  waiting_for_user: "waiting_for_user",
  reviewing: "reviewing",
  error: "error",
  completed: "completed",
  disconnected: "disconnected",
} as const satisfies Readonly<Record<CompanionSemanticState, CharacterState>>

export function mapCompanionStateToCharacterState(
  state: CompanionSemanticState,
): CharacterState {
  return characterStateByCompanionState[state]
}
