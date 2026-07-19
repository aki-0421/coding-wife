import { useCallback, useSyncExternalStore } from "react"

import type { WorkspaceRegistration } from "@/lib/contracts"

import {
  type CodexWorkspaceSnapshot,
  CodexWorkspaceStore,
} from "@/features/codex/workspace-store"

export interface CodexWorkspaceController extends CodexWorkspaceSnapshot {
  readonly pickAndRegister: () => Promise<WorkspaceRegistration>
}

export function useCodexWorkspace(
  store: CodexWorkspaceStore,
): CodexWorkspaceController {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  )
  const pickAndRegister = useCallback(() => store.pickAndRegister(), [store])
  return { ...snapshot, pickAndRegister }
}
