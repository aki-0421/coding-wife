import type { CharacterState } from "@/features/character/model"
import type {
  SemanticCueSelection,
  SemanticMappingV1,
  SemanticState,
} from "@/features/character/library/contracts"

const semanticStateByCharacterState = {
  idle: "neutral",
  thinking: "thinking",
  acting: "working",
  reviewing: "working",
  waiting_for_user: "asking",
  completed: "success",
  disconnected: "warning",
  error: "error",
} as const satisfies Readonly<Record<CharacterState, SemanticState>>

export const neutralSemanticCue = Object.freeze({
  kind: "neutral",
} as const satisfies SemanticCueSelection)

export function mapCharacterStateToSemanticState(
  state: CharacterState,
): SemanticState {
  return semanticStateByCharacterState[state]
}

export function resolveSemanticCue(
  mapping: SemanticMappingV1 | null,
  status: "default" | "saved" | "invalid" | null,
  state: SemanticState,
): SemanticCueSelection {
  if (mapping === null || status !== "saved") return neutralSemanticCue
  return mapping.assignments[state]
}

export function neutralSemanticAssignments(): SemanticMappingV1["assignments"] {
  return {
    neutral: neutralSemanticCue,
    thinking: neutralSemanticCue,
    working: neutralSemanticCue,
    asking: neutralSemanticCue,
    success: neutralSemanticCue,
    warning: neutralSemanticCue,
    error: neutralSemanticCue,
  }
}
