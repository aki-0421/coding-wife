import { useEffect, type ReactNode } from "react"

import { NativeReadinessContext } from "@/features/readiness/context"
import type { NativeReadinessController } from "@/features/readiness/controller"

export function NativeReadinessProvider({
  children,
  controller,
}: {
  readonly children: ReactNode
  readonly controller: NativeReadinessController
}) {
  useEffect(() => {
    void controller.initialize()
  }, [controller])

  return (
    <NativeReadinessContext.Provider value={controller}>
      {children}
    </NativeReadinessContext.Provider>
  )
}
