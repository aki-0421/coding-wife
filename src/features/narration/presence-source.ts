import { listen } from "@tauri-apps/api/event"

import {
  presenceDirectionEventChannel,
  type PresenceDirectionConsumerPort,
} from "@/features/narration/contracts"

export type PresenceDirectionEventListener = (
  channel: string,
  listener: (payload: unknown) => void,
) => Promise<() => void>

const listenTauri: PresenceDirectionEventListener = async (channel, listener) =>
  listen(channel, (event) => listener(event.payload))

export interface TauriPresenceDirectionSourceDependencies {
  readonly listen?: PresenceDirectionEventListener
}

export class TauriPresenceDirectionSource
  implements PresenceDirectionConsumerPort
{
  readonly #listen: PresenceDirectionEventListener

  public constructor(
    dependencies: TauriPresenceDirectionSourceDependencies = {},
  ) {
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
}
