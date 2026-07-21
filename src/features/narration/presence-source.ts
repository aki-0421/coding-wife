import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

import {
  presenceDirectionEventChannel,
  presenceDirectionScopeCommand,
  type PresenceDirectionConsumerPort,
  type PresenceDirectionScopeRequestV1,
} from "@/features/narration/contracts"

export type PresenceDirectionEventListener = (
  channel: string,
  listener: (payload: unknown) => void,
) => Promise<() => void>

export type PresenceDirectionScopeInvoker = (
  command: typeof presenceDirectionScopeCommand,
  argument: { readonly request: PresenceDirectionScopeRequestV1 },
) => Promise<unknown>

const listenTauri: PresenceDirectionEventListener = async (channel, listener) =>
  listen(channel, (event) => listener(event.payload))

const invokeTauri: PresenceDirectionScopeInvoker = (command, argument) =>
  invoke(command, argument)

export interface TauriPresenceDirectionSourceDependencies {
  readonly invoke?: PresenceDirectionScopeInvoker
  readonly listen?: PresenceDirectionEventListener
}

export class TauriPresenceDirectionSource
  implements PresenceDirectionConsumerPort
{
  readonly #invoke: PresenceDirectionScopeInvoker
  readonly #listen: PresenceDirectionEventListener

  public constructor(
    dependencies: TauriPresenceDirectionSourceDependencies = {},
  ) {
    this.#invoke = dependencies.invoke ?? invokeTauri
    this.#listen = dependencies.listen ?? listenTauri
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    let disposed = false
    let unlisten: (() => void) | null = null

    void this.#listen(presenceDirectionEventChannel, (payload) => {
      if (!disposed) listener(payload)
    })
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch(() => {
        // Presence direction is optional and must not affect the main session.
      })

    return () => {
      if (disposed) return
      disposed = true
      unlisten?.()
      unlisten = null
    }
  }

  public async setScope(
    request: PresenceDirectionScopeRequestV1,
  ): Promise<void> {
    await this.#invoke(presenceDirectionScopeCommand, { request })
  }
}
