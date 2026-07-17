import { codexCommands, type WorkspaceRegistration } from "@/lib/contracts"

import type { CodexTransport } from "@/features/codex/transport"

export type CodexWorkspaceStatus = "idle" | "picking" | "ready" | "error"

export interface CodexWorkspaceSnapshot {
  readonly status: CodexWorkspaceStatus
  readonly registration: WorkspaceRegistration | null
  readonly errorCode: string | null
}

type WorkspaceListener = () => void

const initialSnapshot: CodexWorkspaceSnapshot = {
  status: "idle",
  registration: null,
  errorCode: null,
}

function safeErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^CODEX-[A-Z0-9-]+$/u.test(error.code)
  ) {
    return error.code
  }
  return "CODEX-WORKSPACE-PICK-FAILED"
}

export class CodexWorkspaceStore {
  private current: CodexWorkspaceSnapshot = initialSnapshot
  private readonly listeners = new Set<WorkspaceListener>()
  private inFlight: Promise<WorkspaceRegistration> | null = null

  constructor(private readonly transport: CodexTransport) {}

  snapshot = (): CodexWorkspaceSnapshot => this.current

  subscribe = (listener: WorkspaceListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  pickAndRegister(): Promise<WorkspaceRegistration> {
    if (this.inFlight !== null) return this.inFlight
    this.setSnapshot({
      status: "picking",
      registration: this.current.registration,
      errorCode: null,
    })
    const request = this.transport
      .request(codexCommands.pickWorkspace, undefined)
      .then((registration) => {
        this.setSnapshot({ status: "ready", registration, errorCode: null })
        return registration
      })
      .catch((error: unknown) => {
        this.setSnapshot({
          status: "error",
          registration: this.current.registration,
          errorCode: safeErrorCode(error),
        })
        throw error
      })
      .finally(() => {
        this.inFlight = null
      })
    this.inFlight = request
    return request
  }

  private setSnapshot(snapshot: CodexWorkspaceSnapshot): void {
    this.current = snapshot
    for (const listener of this.listeners) listener()
  }
}
