export {
  PersistentWorkspaceViewAdapter,
  createWorkspaceViewAdapter,
  projectWorkspaceState,
} from "@/features/workspace-persistence/adapter"
export { DemoWorkspaceHistoryTransport } from "@/features/workspace-persistence/demo-transport"
export {
  TauriWorkspaceHistoryTransport,
  WorkspaceHistoryBoundaryError,
  type WorkspaceHistoryTransport,
} from "@/features/workspace-persistence/transport"
