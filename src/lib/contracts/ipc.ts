export const ipcCommands = {
  healthCheck: "health_check",
  getRuntimeMetadata: "get_runtime_metadata",
} as const

export type RuntimeKind = "tauri" | "demo"
export type FoundationState = "ready" | "demo_only"
export type IntegrationId = "codex" | "git" | "live2d" | "history"
export type IntegrationReadiness = "not_configured"

export interface HealthCheckResponse {
  readonly schemaVersion: 1
  readonly runtime: RuntimeKind
  readonly foundationState: FoundationState
}

export interface RuntimeMetadata {
  readonly schemaVersion: 1
  readonly runtime: RuntimeKind
  readonly appVersion: string
  readonly platform: string
  readonly architecture: string
  readonly integrations: Readonly<Record<IntegrationId, IntegrationReadiness>>
}

export interface IpcErrorEnvelope {
  readonly code: string
  readonly operation: IpcCommand
  readonly recoverable: boolean
  readonly userMessageKey: string
  readonly detailRef?: string
}

export interface IpcRequestMap {
  health_check: undefined
  get_runtime_metadata: undefined
}

export interface IpcResponseMap {
  health_check: HealthCheckResponse
  get_runtime_metadata: RuntimeMetadata
}

export type IpcCommand = keyof IpcRequestMap & keyof IpcResponseMap
