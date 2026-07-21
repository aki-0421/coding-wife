import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PendingRequestView } from "@/lib/contracts"
import type { WorkspaceCodexState } from "@/features/workspace-view/types"
import {
  characterCompletionDwellMs,
  deriveWorkspaceCharacterState,
  useCompletedCharacterCue,
} from "@/features/workspace-view/workspace-character-state"

const pendingRequest: PendingRequestView = {
  pendingId: "pending-approval",
  responseKind: "native_server_request",
  operation: "item/commandExecution/requestApproval",
  targetAlias: "targeted test",
  reason: "Approval is required before continuing.",
  kind: "command_approval",
  questions: [],
  allowedDecisions: ["approve_once", "reject", "stop"],
  decisionContext: {
    schemaVersion: 1,
    category: "command_execution",
    targetKind: "workspace",
    targetAlias: "targeted test",
    effect: "execute_command",
    scope: "command",
    risk: "low",
    reversibility: "reversible",
    recommendation: "approve_once",
    evidence: ["The command is scoped to a targeted test."],
    uncertainty: "none",
  },
}

function codexState(
  overrides: Partial<WorkspaceCodexState> = {},
): WorkspaceCodexState {
  return {
    activeWorkspaceId: "workspace-a",
    generation: 7,
    phase: "running",
    connected: true,
    readiness: {
      ready: true,
      fastServiceTier: "priority",
      supportedReasoningEfforts: ["low", "max"],
      experimentalModesAvailable: true,
      reasonCode: null,
    },
    pendingRequests: [],
    timeline: [],
    errorCode: null,
    ...overrides,
  }
}

describe("workspace character state", () => {
  beforeEach(() => vi.useFakeTimers())

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("shows a completed cue for one bounded dwell after the active session completes", () => {
    const running = codexState()
    const completed = codexState({ phase: "completed" })
    const { result, rerender } = renderHook(
      ({ codex }) => useCompletedCharacterCue(codex),
      { initialProps: { codex: running } },
    )

    rerender({ codex: completed })
    expect(result.current).toEqual({
      workspaceId: "workspace-a",
      generation: 7,
    })

    act(() => vi.advanceTimersByTime(characterCompletionDwellMs - 1))
    expect(result.current).not.toBeNull()

    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBeNull()
  })

  it("does not replay a stale or generation-mismatched completion", () => {
    const { result, rerender } = renderHook(
      ({ codex }) => useCompletedCharacterCue(codex),
      {
        initialProps: {
          codex: codexState({ phase: "completed" }),
        },
      },
    )

    expect(result.current).toBeNull()
    rerender({ codex: codexState({ phase: "running" }) })
    rerender({
      codex: codexState({ generation: 8, phase: "completed" }),
    })
    expect(result.current).toBeNull()
    act(() => vi.advanceTimersByTime(characterCompletionDwellMs))
    expect(result.current).toBeNull()
  })

  it("cancels a completion cue when a new turn or invalid session state arrives", () => {
    const { result, rerender } = renderHook(
      ({ codex }) => useCompletedCharacterCue(codex),
      { initialProps: { codex: codexState() } },
    )

    rerender({ codex: codexState({ phase: "completed" }) })
    expect(result.current).not.toBeNull()

    rerender({ codex: codexState({ phase: "running" }) })
    expect(result.current).toBeNull()

    rerender({ codex: codexState({ phase: "completed" }) })
    expect(result.current).not.toBeNull()

    rerender({
      codex: codexState({
        connected: false,
        errorCode: "CODEX-DISCONNECTED",
        phase: "failed",
      }),
    })
    expect(result.current).toBeNull()
  })

  it("clears the active cue and timeout when its session identity changes", () => {
    const clearTimeout = vi.spyOn(window, "clearTimeout")
    const { result, rerender } = renderHook(
      ({ codex }) => useCompletedCharacterCue(codex),
      { initialProps: { codex: codexState() } },
    )

    rerender({ codex: codexState({ phase: "completed" }) })
    expect(result.current).not.toBeNull()
    expect(vi.getTimerCount()).toBe(1)

    rerender({
      codex: codexState({
        activeWorkspaceId: "workspace-b",
        phase: "completed",
      }),
    })
    expect(result.current).toBeNull()
    expect(clearTimeout).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    rerender({
      codex: codexState({
        activeWorkspaceId: "workspace-b",
        generation: 8,
        phase: "running",
      }),
    })
    rerender({
      codex: codexState({
        activeWorkspaceId: "workspace-b",
        generation: 8,
        phase: "completed",
      }),
    })
    expect(result.current).not.toBeNull()
    expect(vi.getTimerCount()).toBe(1)

    rerender({
      codex: codexState({
        activeWorkspaceId: "workspace-b",
        generation: 9,
        phase: "completed",
      }),
    })
    expect(result.current).toBeNull()
    expect(clearTimeout).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("preserves pending-input and active-turn precedence around completion", () => {
    const completed = codexState({ phase: "completed" })
    const completedCue = { workspaceId: "workspace-a", generation: 7 }

    expect(
      deriveWorkspaceCharacterState({
        codex: completed,
        completedCue,
        selectedWorkspaceId: "workspace-a",
        turnActive: false,
        turnState: "idle",
      }),
    ).toBe("completed")

    expect(
      deriveWorkspaceCharacterState({
        codex: { ...completed, pendingRequests: [pendingRequest] },
        completedCue,
        selectedWorkspaceId: "workspace-a",
        turnActive: false,
        turnState: "idle",
      }),
    ).toBe("waiting_for_user")

    expect(
      deriveWorkspaceCharacterState({
        codex: codexState(),
        completedCue,
        selectedWorkspaceId: "workspace-a",
        turnActive: true,
        turnState: "running",
      }),
    ).toBe("acting")

    expect(
      deriveWorkspaceCharacterState({
        codex: completed,
        completedCue,
        selectedWorkspaceId: "workspace-a",
        turnActive: false,
        turnState: "sending",
      }),
    ).toBe("thinking")
  })

  it("keeps completion scoped to its selected workspace and healthy session", () => {
    const completedCue = { workspaceId: "workspace-a", generation: 7 }

    expect(
      deriveWorkspaceCharacterState({
        codex: codexState({ phase: "completed" }),
        completedCue,
        selectedWorkspaceId: "workspace-b",
        turnActive: false,
        turnState: "idle",
      }),
    ).toBe("idle")

    expect(
      deriveWorkspaceCharacterState({
        codex: codexState({
          connected: false,
          phase: "completed",
        }),
        completedCue,
        selectedWorkspaceId: "workspace-a",
        turnActive: false,
        turnState: "idle",
      }),
    ).toBe("idle")

    expect(
      deriveWorkspaceCharacterState({
        codex: codexState({
          errorCode: "CODEX-TURN-FAILED",
          phase: "completed",
        }),
        completedCue,
        selectedWorkspaceId: "workspace-a",
        turnActive: false,
        turnState: "idle",
      }),
    ).toBe("idle")
  })
})
