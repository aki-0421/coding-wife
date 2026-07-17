import { createContext } from "react"

import type { RuntimeState } from "@/features/runtime/RuntimeProvider"
import type { AppTransport } from "@/features/runtime/transport"

export interface RuntimeContextValue {
  readonly transportKind: AppTransport["kind"]
  readonly state: RuntimeState
  readonly refresh: () => void
}

export const RuntimeContext = createContext<RuntimeContextValue | null>(null)
