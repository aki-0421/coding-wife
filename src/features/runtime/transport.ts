import { invoke, isTauri } from "@tauri-apps/api/core"

import {
  IpcBoundaryError,
  ipcCommands,
  normalizeIpcError,
  parseHealthCheckResponse,
  parseRuntimeMetadata,
  type HealthCheckResponse,
  type IpcCommand,
  type IpcRequestMap,
  type IpcResponseMap,
  type RuntimeKind,
  type RuntimeMetadata,
} from "@/lib/contracts"

export type IpcInvoker = (
  command: IpcCommand,
  payload: unknown,
) => Promise<unknown>

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

const invokeTauri: IpcInvoker = (command, payload) => {
  return invoke(
    command,
    payload as Readonly<Record<string, unknown>> | undefined,
  )
}

export class TauriTransport implements AppTransport {
  readonly kind = "tauri"

  constructor(private readonly invoker: IpcInvoker = invokeTauri) {}

  async request<K extends IpcCommand>(
    command: K,
    payload: IpcRequestMap[K],
  ): Promise<IpcResponseMap[K]> {
    try {
      const response = await this.invoker(command, payload)

      if (command === ipcCommands.healthCheck) {
        return parseHealthCheckResponse(response) as IpcResponseMap[K]
      }

      return parseRuntimeMetadata(response) as IpcResponseMap[K]
    } catch (error) {
      throw new IpcBoundaryError(normalizeIpcError(command, error))
    }
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
