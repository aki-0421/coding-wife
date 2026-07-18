import type { ReactNode } from "react"

import type {
  AttachmentKind,
  AttachmentRegistrationResponse,
  AttachmentSource,
  CodexFallbackDecisionRequest,
  CodexPendingResponseRequest,
  PendingRequestView,
} from "@/lib/contracts"
import type {
  CodexSemanticTimelineEvent,
  CodexWorkspacePhase,
  CodexReadiness,
} from "@/features/codex"
import type {
  CharacterContext,
  ProjectContext,
  VersionedCharacterContext,
  VersionedProjectContext,
  WorkspaceEditableContext,
  WorkspaceTurnContextSnapshot,
} from "@/lib/contracts/workspace-context"

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
  readonly attention?:
    "needs_answer" | "approval_required" | "test_failed" | "high_risk"
  readonly health?:
    | "ready"
    | "missing"
    | "changed"
    | "unreadable"
    | "read_only"
    | "stale_branch"
  readonly updatedAt?: string
}

export interface AttachmentItem {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly valid: boolean
  readonly relativePath: string
  readonly kind: AttachmentKind
  readonly source: AttachmentSource
  readonly expiresAt: string
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

export interface PersistedWorkspaceTimelineItem {
  readonly id: string
  readonly sequence: number
  readonly producer: "app" | "work" | "code" | "live" | "hist" | "git"
  readonly kind: "history"
  readonly domainKind: string
  readonly occurredAt: string
  readonly status: string
  readonly errorCode?: string
}

export type WorkspaceTimelineItem =
  PersistedWorkspaceTimelineItem | CodexSemanticTimelineEvent

export interface WorkspaceCodexState {
  readonly activeWorkspaceId: string | null
  readonly generation: number | null
  readonly phase: CodexWorkspacePhase
  readonly connected: boolean
  readonly readiness: CodexReadiness
  readonly pendingRequests: readonly PendingRequestView[]
  readonly timeline: readonly CodexSemanticTimelineEvent[]
  readonly errorCode: string | null
}

export interface WorkspaceAdapterDraft {
  readonly text: string
  readonly effort: ReasoningEffort
  readonly revision: number
  readonly contextSnapshots: readonly ContextSnapshotItem[]
}

export interface WorkspaceAdapterState {
  readonly workspaces: readonly WorkspaceRecord[]
  readonly activeWorkspaceId: string | null
  readonly draft: WorkspaceAdapterDraft | null
  readonly timeline: readonly WorkspaceTimelineItem[]
  readonly history: {
    readonly mode: "ready" | "ephemeral" | "read_only" | "recovery_required"
    readonly errorCode: string | null
    readonly backupName: string | null
  }
}

export interface WorkspaceCreateRequest {
  readonly fromWorkspaceId: string
  readonly name: string
  readonly goal: string
  readonly repository: string
  readonly branch: string
}

export interface SendTurnRequest {
  readonly workspaceId: string
  readonly instruction: string
  readonly effort: ReasoningEffort
  readonly attachments: readonly AttachmentItem[]
  readonly contextSnapshots: readonly ContextSnapshotItem[]
  readonly editableContextSnapshot: WorkspaceTurnContextSnapshot
}

export interface WorkspaceViewAdapter {
  readonly connected?: boolean
  readonly hydrationMode?: "native" | "demo"
  readonly loadState?: () => Promise<WorkspaceAdapterState>
  readonly selectWorkspace?: (
    workspaceId: string,
  ) => Promise<WorkspaceAdapterState>
  readonly cancelWorkspace?: (
    workspaceId: string,
    expectedUpdatedAt: string,
  ) => Promise<WorkspaceAdapterState>
  readonly repairWorkspace?: (
    workspaceId: string,
  ) => Promise<WorkspaceAdapterState>
  readonly unregisterWorkspace?: (
    workspaceId: string,
  ) => Promise<WorkspaceAdapterState>
  readonly saveDraft?: (
    workspaceId: string,
    text: string,
    effort: ReasoningEffort,
  ) => Promise<void>
  readonly requestAddProject?: () =>
    void | WorkspaceAdapterState | Promise<void | WorkspaceAdapterState>
  readonly requestAddWorkspace?: (
    workspace: WorkspaceCreateRequest,
  ) => void | WorkspaceAdapterState | Promise<void | WorkspaceAdapterState>
  readonly captureContext?: (
    workspaceId: string,
    source: ContextSnapshotItem["source"],
  ) => Promise<ContextSnapshotItem>
  readonly loadEditableContext?: (
    workspaceId: string,
  ) => Promise<WorkspaceEditableContext>
  readonly saveProjectContext?: (
    workspaceId: string,
    expectedVersion: number,
    context: ProjectContext,
  ) => Promise<VersionedProjectContext>
  readonly saveCharacterContext?: (
    workspaceId: string,
    expectedVersion: number,
    context: CharacterContext,
  ) => Promise<VersionedCharacterContext>
  readonly getTurnContextSnapshot?: (
    workspaceId: string,
  ) => Promise<WorkspaceTurnContextSnapshot>
  readonly sendTurn?: (
    request: SendTurnRequest,
  ) => Promise<{ readonly accepted: boolean }>
  readonly stopTurn?: (workspaceId: string) => void | Promise<void>
  readonly codexSnapshot?: () => WorkspaceCodexState
  readonly subscribeCodex?: (
    listener: (state: WorkspaceCodexState) => void,
  ) => () => void
  readonly pickAttachments?: (
    workspaceId: string,
    existingHandles: readonly string[],
  ) => Promise<AttachmentRegistrationResponse>
  readonly registerAttachmentPaths?: (
    workspaceId: string,
    source: "drop" | "paste",
    paths: readonly string[],
    existingHandles: readonly string[],
  ) => Promise<AttachmentRegistrationResponse>
  readonly respondPending?: (
    request: CodexPendingResponseRequest,
  ) => Promise<boolean>
  readonly answerFallbackDecision?: (
    request: CodexFallbackDecisionRequest,
  ) => Promise<boolean>
  readonly deleteWorkspaceHistory?: (
    workspaceId: string,
  ) => Promise<WorkspaceAdapterState>
}

export interface CharacterStageRenderProps {
  readonly workspaceId: string
  readonly state: CompanionSemanticState
  readonly muted: boolean
  readonly reducedMotion: boolean
  readonly speaking?: boolean
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
