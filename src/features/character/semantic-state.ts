import type { CharacterState } from "@/features/character/model"
import type { CharacterSemanticState } from "@/features/workspace-view/types"

export const characterStateBySemanticState = {
  idle: "idle",
  thinking: "thinking",
  acting: "acting",
  waiting_for_user: "waiting_for_user",
  reviewing: "reviewing",
  error: "error",
  completed: "completed",
  disconnected: "disconnected",
} as const satisfies Readonly<Record<CharacterSemanticState, CharacterState>>

export function mapSemanticStateToCharacterState(
  state: CharacterSemanticState,
): CharacterState {
  return characterStateBySemanticState[state]
}
