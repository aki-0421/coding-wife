import { useEffect, useMemo, type ReactNode } from "react"

import type {
  CommitNarrationConsumerPort,
  PresenceDirectionConsumerPort,
} from "@/features/narration/contracts"
import { NarrationContext } from "@/features/narration/context"
import { NarrationController } from "@/features/narration/controller"
import type { NarrationGateway } from "@/features/narration/transport"

export interface NarrationProviderProps {
  readonly children: ReactNode
  readonly controller?: NarrationController
  readonly gateway: NarrationGateway
  readonly presenceSource?: PresenceDirectionConsumerPort | null
  readonly source?: CommitNarrationConsumerPort | null
}

export function NarrationProvider({
  children,
  controller,
  gateway,
  presenceSource = null,
  source = null,
}: NarrationProviderProps) {
  const activeController = useMemo(
    () => controller ?? new NarrationController(gateway),
    [controller, gateway],
  )

  useEffect(() => {
    void activeController.initialize()
  }, [activeController])

  useEffect(() => activeController.connect(source), [activeController, source])
  useEffect(
    () => activeController.connectPresence(presenceSource),
    [activeController, presenceSource],
  )

  return (
    <NarrationContext.Provider value={activeController}>
      {children}
    </NarrationContext.Provider>
  )
}
