import type { WorkspaceTimelineItem } from "@/features/workspace-view/types"

export type ChatTimelineEvent = Extract<
  WorkspaceTimelineItem,
  {
    readonly kind:
      | "user"
      | "assistant"
      | "plan"
      | "tool"
      | "file"
      | "diff"
      | "decision"
      | "approval"
      | "error"
  }
>

export function isChatTimelineEvent(
  event: WorkspaceTimelineItem,
): event is ChatTimelineEvent {
  switch (event.kind) {
    case "user":
    case "assistant":
    case "plan":
    case "tool":
    case "file":
    case "diff":
    case "decision":
    case "approval":
    case "error":
      return true
    case "history":
    case "status":
    case "thread":
    case "turn":
    case "completion":
    case "request_resolved":
      return false
  }
}
