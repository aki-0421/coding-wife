import { invoke, isTauri } from "@tauri-apps/api/core"

import {
  ipcCommands,
  type HealthCheckResponse,
  type IpcCommand,
  type IpcRequestMap,
  type IpcResponseMap,
  type RuntimeKind,
  type RuntimeMetadata,
} from "@/lib/contracts"

export interface AppTransport {
  readonly kind: RuntimeKind
  request<K extends IpcCommand>(
    command: K,
    payload: IpcRequestMap[K],
  ): Promise<IpcResponseMap[K]>
}

const notConfiguredIntegrations = {
  codex: "not_configured",
  git: "not_configured",
  live2d: "not_configured",
  history: "not_configured",
} as const

class TauriTransport implements AppTransport {
  readonly kind = "tauri"

  request<K extends IpcCommand>(
    command: K,
    payload: IpcRequestMap[K],
  ): Promise<IpcResponseMap[K]> {
    return invoke<IpcResponseMap[K]>(command, payload)
  }
}

export class DemoTransport implements AppTransport {
  readonly kind = "demo"

  request<K extends IpcCommand>(
    command: K,
    payload: IpcRequestMap[K],
  ): Promise<IpcResponseMap[K]> {
    void payload

    if (command === ipcCommands.healthCheck) {
      const response: HealthCheckResponse = {
        schemaVersion: 1,
        runtime: "demo",
        foundationState: "demo_only",
      }
      return Promise.resolve(response as IpcResponseMap[K])
    }

    const response: RuntimeMetadata = {
      schemaVersion: 1,
      runtime: "demo",
      appVersion: "demo",
      platform: "browser",
      architecture: "web",
      integrations: notConfiguredIntegrations,
    }
    return Promise.resolve(response as IpcResponseMap[K])
  }
}

export function createAppTransport(): AppTransport {
  return isTauri() ? new TauriTransport() : new DemoTransport()
}
