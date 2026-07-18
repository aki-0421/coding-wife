import {
  parseWorkspaceTurnContextSnapshot,
  type WorkspaceTurnContextSnapshot,
} from "@/lib/contracts/workspace-context"
import {
  hasDisallowedMultilineControl,
  unicodeScalarCount,
} from "@/lib/public-text"

export const maximumComposedTurnScalars = 80_000

export function composeTurnInstruction(
  instruction: string,
  snapshot: WorkspaceTurnContextSnapshot,
): string {
  const validated = parseWorkspaceTurnContextSnapshot(snapshot)
  const context = JSON.stringify({
    schemaVersion: validated.schemaVersion,
    workspaceId: validated.workspaceId,
    snapshotHash: validated.snapshotHash,
    capturedAt: validated.capturedAt,
    project: {
      version: validated.projectVersion,
      hash: validated.projectHash,
      context: validated.project,
    },
    character: {
      version: validated.characterVersion,
      hash: validated.characterHash,
      context: validated.character,
    },
  })
  const composed = [
    "CODING_WIFE_CONTEXT_SNAPSHOT_V1",
    `jsonScalars=${String(unicodeScalarCount(context))}`,
    context,
    "CODING_WIFE_USER_INSTRUCTION_V1",
    instruction,
  ].join("\n")
  if (hasDisallowedMultilineControl(composed)) {
    throw Object.assign(new Error("WORKSPACE-CONTEXT-TURN-UNSAFE-CONTROL"), {
      code: "WORKSPACE-CONTEXT-TURN-UNSAFE-CONTROL",
    })
  }
  if (unicodeScalarCount(composed) > maximumComposedTurnScalars) {
    throw Object.assign(new Error("WORKSPACE-CONTEXT-TURN-TOO-LARGE"), {
      code: "WORKSPACE-CONTEXT-TURN-TOO-LARGE",
    })
  }
  return composed
}
