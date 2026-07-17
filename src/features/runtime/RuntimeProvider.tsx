import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import { RuntimeContext } from "@/features/runtime/context"
import type { AppTransport } from "@/features/runtime/transport"
import {
  ipcCommands,
  type HealthCheckResponse,
  type RuntimeMetadata,
} from "@/lib/contracts"

export type RuntimeState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready"
      readonly health: HealthCheckResponse
      readonly metadata: RuntimeMetadata
    }
  | { readonly status: "error"; readonly errorCode: "APP-IPC-UNAVAILABLE" }

export interface RuntimeProviderProps {
  readonly children: ReactNode
  readonly transport: AppTransport
}

export function RuntimeProvider({ children, transport }: RuntimeProviderProps) {
  const [requestVersion, setRequestVersion] = useState(0)
  const [state, setState] = useState<RuntimeState>({ status: "loading" })

  const refresh = useCallback(() => {
    setState({ status: "loading" })
    setRequestVersion((version) => version + 1)
  }, [])

  useEffect(() => {
    let isCurrent = true

    void Promise.all([
      transport.request(ipcCommands.healthCheck, undefined),
      transport.request(ipcCommands.getRuntimeMetadata, undefined),
    ])
      .then(([health, metadata]) => {
        if (isCurrent) {
          setState({ status: "ready", health, metadata })
        }
      })
      .catch(() => {
        if (isCurrent) {
          setState({ status: "error", errorCode: "APP-IPC-UNAVAILABLE" })
        }
      })

    return () => {
      isCurrent = false
    }
  }, [requestVersion, transport])

  const value = useMemo(
    () => ({ transportKind: transport.kind, state, refresh }),
    [refresh, state, transport.kind],
  )

  return (
    <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>
  )
}
