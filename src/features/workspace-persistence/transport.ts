import { invoke } from "@tauri-apps/api/core"

import {
  parseWorkspaceCommandError,
  parseWorkspaceHistoryResponse,
  type WorkspaceCommandErrorEnvelope,
  type WorkspaceHistoryCommand,
  type WorkspaceHistoryRequestMap,
  type WorkspaceHistoryResponseMap,
} from "@/lib/contracts/workspace-history"

export type WorkspaceHistoryInvoker = (
  command: WorkspaceHistoryCommand,
  payload: unknown,
) => Promise<unknown>

export interface WorkspaceHistoryTransport {
  readonly kind: "tauri" | "demo"
  request<K extends WorkspaceHistoryCommand>(
    command: K,
    request: WorkspaceHistoryRequestMap[K],
  ): Promise<WorkspaceHistoryResponseMap[K]>
}

export class WorkspaceHistoryBoundaryError
  extends Error
  implements WorkspaceCommandErrorEnvelope
{
  readonly code: string
  readonly operation: WorkspaceHistoryCommand
  readonly recoverable: boolean
  readonly userMessageKey: string
  readonly detailRef?: string

  constructor(envelope: WorkspaceCommandErrorEnvelope) {
    super(envelope.code)
    this.name = "WorkspaceHistoryBoundaryError"
    this.code = envelope.code
    this.operation = envelope.operation
    this.recoverable = envelope.recoverable
    this.userMessageKey = envelope.userMessageKey
    if (envelope.detailRef !== undefined) this.detailRef = envelope.detailRef
  }
}

const invokeTauri: WorkspaceHistoryInvoker = (command, request) =>
  invoke(command, request === undefined ? undefined : { request })

function boundaryError(
  operation: WorkspaceHistoryCommand,
  error: unknown,
): WorkspaceHistoryBoundaryError {
  if (error instanceof WorkspaceHistoryBoundaryError) return error
  const envelope = parseWorkspaceCommandError(error)
  if (envelope !== null && envelope.operation === operation) {
    return new WorkspaceHistoryBoundaryError(envelope)
  }
  return new WorkspaceHistoryBoundaryError({
    code: "WORKSPACE-IPC-CONTRACT-MISMATCH",
    operation,
    recoverable: false,
    userMessageKey: "workspace.error.generic",
    detailRef: "workspace-history-v1",
  })
}

export class TauriWorkspaceHistoryTransport
  implements WorkspaceHistoryTransport
{
  readonly kind = "tauri"

  constructor(
    private readonly invoker: WorkspaceHistoryInvoker = invokeTauri,
  ) {}

  async request<K extends WorkspaceHistoryCommand>(
    command: K,
    request: WorkspaceHistoryRequestMap[K],
  ): Promise<WorkspaceHistoryResponseMap[K]> {
    try {
      const response = await this.invoker(command, request)
      return parseWorkspaceHistoryResponse(command, response)
    } catch (error) {
      throw boundaryError(command, error)
    }
  }
}
