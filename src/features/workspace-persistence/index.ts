export {
  createPersistentWorkspaceViewAdapter,
  PersistentWorkspaceViewAdapter,
  projectWorkspaceState,
} from "@/features/workspace-persistence/adapter"
export {
  CodexComposedWorkspaceViewAdapter,
  createCodexComposedWorkspaceViewAdapter,
} from "@/features/workspace-persistence/codex-composition"
export { DemoWorkspaceHistoryTransport } from "@/features/workspace-persistence/demo-transport"
export {
  TauriWorkspaceHistoryTransport,
  WorkspaceHistoryBoundaryError,
  type WorkspaceHistoryTransport,
} from "@/features/workspace-persistence/transport"

import { PersistentWorkspaceViewAdapter } from "@/features/workspace-persistence/adapter"
import { CodexComposedWorkspaceViewAdapter } from "@/features/workspace-persistence/codex-composition"
import { DemoWorkspaceHistoryTransport } from "@/features/workspace-persistence/demo-transport"
import { TauriWorkspaceHistoryTransport } from "@/features/workspace-persistence/transport"
import { TauriCodexTransport } from "@/features/codex"
import type { WorkspaceViewAdapter } from "@/features/workspace-view/types"

export function createWorkspaceViewAdapter(
  runtimeKind: "tauri" | "demo",
): WorkspaceViewAdapter {
  if (runtimeKind === "tauri") {
    return new CodexComposedWorkspaceViewAdapter(
      new TauriWorkspaceHistoryTransport(),
      new TauriCodexTransport(),
    )
  }
  return new PersistentWorkspaceViewAdapter(new DemoWorkspaceHistoryTransport())
}
