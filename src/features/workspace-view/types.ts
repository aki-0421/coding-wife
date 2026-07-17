import type { ReactNode } from "react"

export type WorkspaceTab = "chat" | "commit" | "context" | "settings"
export type WorkspaceLifecycle =
  "done" | "in_review" | "in_progress" | "backlog" | "canceled"

export type ReasoningEffort = "fast" | "max"
export type CompanionSemanticState =
  | "idle"
  | "thinking"
  | "acting"
  | "waiting_for_user"
  | "reviewing"
  | "error"
  | "completed"
  | "disconnected"

export interface WorkspaceRecord {
  readonly id: string
  readonly repository: string
  readonly name: string
  readonly branch: string
  readonly lifecycle: WorkspaceLifecycle
  readonly attention?: "needs_answer" | "test_failed" | "high_risk"
}

export interface AttachmentItem {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly valid: boolean
}

export interface ContextSnapshotItem {
  readonly id: string
  readonly source: "files" | "git_diff" | "terminal_output"
  readonly label: string
  readonly capturedAt: string
  readonly byteCount: number
}

export interface WorkspaceDraft {
  readonly text: string
  readonly effort: ReasoningEffort
  readonly attachments: readonly AttachmentItem[]
  readonly contextSnapshots: readonly ContextSnapshotItem[]
}

export interface SendTurnRequest {
  readonly workspaceId: string
  readonly instruction: string
  readonly effort: ReasoningEffort
  readonly attachments: readonly AttachmentItem[]
  readonly contextSnapshots: readonly ContextSnapshotItem[]
}

export interface WorkspaceViewAdapter {
  readonly connected?: boolean
  readonly requestAddProject?: () => void | Promise<void>
  readonly requestAddWorkspace?: (
    workspace: Pick<WorkspaceRecord, "name" | "repository" | "branch">,
  ) => void | Promise<void>
  readonly captureContext?: (
    workspaceId: string,
    source: ContextSnapshotItem["source"],
  ) => Promise<ContextSnapshotItem>
  readonly sendTurn?: (
    request: SendTurnRequest,
  ) => Promise<{ readonly accepted: boolean }>
  readonly stopTurn?: (workspaceId: string) => void | Promise<void>
}

export interface CharacterStageRenderProps {
  readonly workspaceId: string
  readonly state: CompanionSemanticState
  readonly muted: boolean
  readonly reducedMotion: boolean
}

export type CharacterStageRenderer = (
  props: CharacterStageRenderProps,
) => ReactNode

export type SettingsSection =
  | "general"
  | "project_context"
  | "character_context"
  | "companion"
  | "audio"
  | "support"
  | "diagnostics"
  | "history"
