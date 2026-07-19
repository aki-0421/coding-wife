import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

import {
  appLifecycleCommands,
  appLifecycleDemoEvents,
  appLifecycleEventChannels,
  createAppQuitRequest,
  parseAppCleanupFailed,
  parseAppCloseRequested,
  type AppCleanupFailedV1,
  type AppCloseRequestedV1,
  type AppQuitAction,
  type AppQuitRequestV1,
} from "@/features/app-lifecycle/contracts"
import type { RuntimeKind } from "@/lib/contracts"

export type AppLifecycleCloseListener = (request: AppCloseRequestedV1) => void

export type AppLifecycleCleanupFailedListener = (
  failure: AppCleanupFailedV1,
) => void

export interface AppLifecycleGateway {
  listenCloseRequested(listener: AppLifecycleCloseListener): Promise<() => void>
  listenCleanupFailed(
    listener: AppLifecycleCleanupFailedListener,
  ): Promise<() => void>
  cancelQuit(requestId: string): Promise<void>
  confirmQuit(requestId: string): Promise<void>
  retryCleanup(requestId: string): Promise<void>
}

export interface AppLifecycleGatewayDependencies {
  readonly invoke?: (
    command: string,
    payload: { readonly request: AppQuitRequestV1 },
  ) => Promise<unknown>
  readonly listen?: (
    channel: string,
    listener: (payload: unknown) => void,
  ) => Promise<() => void>
}

export class AppLifecycleBoundaryError extends Error {
  readonly code: string
  readonly recoverable: boolean

  constructor(code: string, recoverable: boolean) {
    super(code)
    this.name = "AppLifecycleBoundaryError"
    this.code = code
    this.recoverable = recoverable
  }
}

const invokeTauri = (
  command: string,
  payload: { readonly request: AppQuitRequestV1 },
) => invoke(command, payload)

const listenTauri = async (
  channel: string,
  listener: (payload: unknown) => void,
) => listen(channel, (event) => listener(event.payload))

function boundaryFailure(): AppLifecycleBoundaryError {
  return new AppLifecycleBoundaryError("APP-LIFECYCLE-IPC-UNAVAILABLE", true)
}

export class TauriAppLifecycleGateway implements AppLifecycleGateway {
  readonly #invoke: NonNullable<AppLifecycleGatewayDependencies["invoke"]>
  readonly #listen: NonNullable<AppLifecycleGatewayDependencies["listen"]>

  constructor(dependencies: AppLifecycleGatewayDependencies = {}) {
    this.#invoke = dependencies.invoke ?? invokeTauri
    this.#listen = dependencies.listen ?? listenTauri
  }

  async listenCloseRequested(
    listener: AppLifecycleCloseListener,
  ): Promise<() => void> {
    try {
      return await this.#listen(
        appLifecycleEventChannels.closeRequested,
        (payload) => {
          try {
            listener(parseAppCloseRequested(payload))
          } catch {
            // Native lifecycle payloads fail closed and never open an unsafe dialog.
          }
        },
      )
    } catch {
      throw boundaryFailure()
    }
  }

  async listenCleanupFailed(
    listener: AppLifecycleCleanupFailedListener,
  ): Promise<() => void> {
    try {
      return await this.#listen(
        appLifecycleEventChannels.cleanupFailed,
        (payload) => {
          try {
            listener(parseAppCleanupFailed(payload))
          } catch {
            // Native lifecycle payloads fail closed and never expose process details.
          }
        },
      )
    } catch {
      throw boundaryFailure()
    }
  }

  cancelQuit(requestId: string): Promise<void> {
    return this.request(appLifecycleCommands.cancelQuit, requestId)
  }

  confirmQuit(requestId: string): Promise<void> {
    return this.request(appLifecycleCommands.confirmQuit, requestId)
  }

  retryCleanup(requestId: string): Promise<void> {
    return this.request(appLifecycleCommands.retryCleanup, requestId)
  }

  private async request(command: string, requestId: string): Promise<void> {
    try {
      await this.#invoke(command, { request: createAppQuitRequest(requestId) })
    } catch {
      throw boundaryFailure()
    }
  }
}

export class DemoAppLifecycleGateway implements AppLifecycleGateway {
  listenCloseRequested(
    listener: AppLifecycleCloseListener,
  ): Promise<() => void> {
    const receive = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      try {
        listener(parseAppCloseRequested(event.detail))
      } catch {
        // Browser verification uses the same strict contract as native events.
      }
    }
    window.addEventListener(appLifecycleDemoEvents.closeRequested, receive)
    return Promise.resolve(() =>
      window.removeEventListener(
        appLifecycleDemoEvents.closeRequested,
        receive,
      ),
    )
  }

  listenCleanupFailed(
    listener: AppLifecycleCleanupFailedListener,
  ): Promise<() => void> {
    const receive = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      try {
        listener(parseAppCleanupFailed(event.detail))
      } catch {
        // Browser verification uses the same strict contract as native events.
      }
    }
    window.addEventListener(appLifecycleDemoEvents.cleanupFailed, receive)
    return Promise.resolve(() =>
      window.removeEventListener(appLifecycleDemoEvents.cleanupFailed, receive),
    )
  }

  cancelQuit(requestId: string): Promise<void> {
    return this.emitAction("dont_quit", requestId)
  }

  confirmQuit(requestId: string): Promise<void> {
    return this.emitAction("stop_and_quit", requestId)
  }

  retryCleanup(requestId: string): Promise<void> {
    return this.emitAction("retry_cleanup", requestId)
  }

  private emitAction(action: AppQuitAction, requestId: string): Promise<void> {
    const request = createAppQuitRequest(requestId)
    window.dispatchEvent(
      new CustomEvent(appLifecycleDemoEvents.action, {
        detail: { action, request },
      }),
    )
    return Promise.resolve()
  }
}

export function createAppLifecycleGateway(
  runtime: RuntimeKind,
): AppLifecycleGateway {
  return runtime === "tauri"
    ? new TauriAppLifecycleGateway()
    : new DemoAppLifecycleGateway()
}
