import { useEffect, useMemo, type ReactNode } from "react"

import type { CommitNarrationConsumerPort } from "@/features/narration/contracts"
import { NarrationContext } from "@/features/narration/context"
import { NarrationController } from "@/features/narration/controller"
import type { NarrationGateway } from "@/features/narration/transport"

export interface NarrationProviderProps {
  readonly children: ReactNode
  readonly controller?: NarrationController
  readonly gateway: NarrationGateway
  readonly source?: CommitNarrationConsumerPort | null
}

export function NarrationProvider({
  children,
  controller,
  gateway,
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

  return (
    <NarrationContext.Provider value={activeController}>
      {children}
    </NarrationContext.Provider>
  )
}
