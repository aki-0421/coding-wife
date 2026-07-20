export {
  PersistentWorkspaceViewAdapter,
  projectWorkspaceState,
} from "@/features/workspace-persistence/adapter"
export { CodexComposedWorkspaceViewAdapter } from "@/features/workspace-persistence/codex-composition"
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
import { DemoCodexTransport, TauriCodexTransport } from "@/features/codex"
import type { CodexTransport } from "@/features/codex/transport"
import type { WorkspaceHistoryTransport } from "@/features/workspace-persistence/transport"
import type { WorkspaceViewAdapter } from "@/features/workspace-view/types"

export function createPersistentWorkspaceViewAdapter(
  runtimeKind: "tauri" | "demo",
): WorkspaceViewAdapter {
  return new PersistentWorkspaceViewAdapter(
    runtimeKind === "tauri"
      ? new TauriWorkspaceHistoryTransport()
      : new DemoWorkspaceHistoryTransport(),
  )
}

export function createCodexComposedWorkspaceViewAdapter(
  historyTransport: WorkspaceHistoryTransport,
  codexTransport: CodexTransport = historyTransport.kind === "tauri"
    ? new TauriCodexTransport()
    : new DemoCodexTransport(),
): WorkspaceViewAdapter {
  return new CodexComposedWorkspaceViewAdapter(historyTransport, codexTransport)
}

export function createWorkspaceViewAdapter(
  runtimeKind: "tauri" | "demo",
  options: {
    readonly interactiveDemo?: boolean
    readonly projectSetupDemo?: "git" | "github"
  } = {},
): WorkspaceViewAdapter {
  if (runtimeKind === "tauri") {
    return new CodexComposedWorkspaceViewAdapter(
      new TauriWorkspaceHistoryTransport(),
      new TauriCodexTransport(),
    )
  }
  if (options.interactiveDemo === true) {
    return new CodexComposedWorkspaceViewAdapter(
      new DemoWorkspaceHistoryTransport({
        ...(options.projectSetupDemo === undefined
          ? {}
          : { projectSetup: options.projectSetupDemo }),
      }),
      new DemoCodexTransport(),
    )
  }
  return new PersistentWorkspaceViewAdapter(
    new DemoWorkspaceHistoryTransport({
      ...(options.projectSetupDemo === undefined
        ? {}
        : { projectSetup: options.projectSetupDemo }),
    }),
  )
}
