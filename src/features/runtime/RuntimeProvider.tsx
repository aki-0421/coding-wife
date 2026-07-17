import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import { RuntimeContext } from "@/features/runtime/context"
import type { AppTransport } from "@/features/runtime/transport"
import {
  ipcCommands,
  normalizeIpcError,
  validateRuntimeResponses,
  type HealthCheckResponse,
  type IpcErrorEnvelope,
  type RuntimeMetadata,
} from "@/lib/contracts"

interface ReadyRuntime {
  readonly health: HealthCheckResponse
  readonly metadata: RuntimeMetadata
}

interface InFlightRequest {
  readonly transport: AppTransport
  readonly promise: Promise<ReadyRuntime>
}

export type RuntimeState =
  | { readonly status: "loading" }
  | ({ readonly status: "ready" } & ReadyRuntime)
  | { readonly status: "error"; readonly error: IpcErrorEnvelope }

export interface RuntimeProviderProps {
  readonly children: ReactNode
  readonly transport: AppTransport
}

async function requestRuntime(transport: AppTransport): Promise<ReadyRuntime> {
  const [health, metadata] = await Promise.all([
    transport.request(ipcCommands.healthCheck, undefined),
    transport.request(ipcCommands.getRuntimeMetadata, undefined),
  ])

  validateRuntimeResponses(transport.kind, health, metadata)
  return { health, metadata }
}

export function RuntimeProvider({ children, transport }: RuntimeProviderProps) {
  const [requestVersion, setRequestVersion] = useState(0)
  const [state, setState] = useState<RuntimeState>({ status: "loading" })
  const inFlightRequest = useRef<InFlightRequest | null>(null)
  const refreshQueued = useRef(false)

  const refresh = useCallback(() => {
    if (refreshQueued.current || inFlightRequest.current !== null) {
      return
    }

    refreshQueued.current = true
    setState({ status: "loading" })
    setRequestVersion((version) => version + 1)
  }, [])

  useEffect(() => {
    let isCurrent = true
    refreshQueued.current = false

    let request = inFlightRequest.current
    if (request === null || request.transport !== transport) {
      request = {
        transport,
        promise: requestRuntime(transport),
      }
      inFlightRequest.current = request
    }

    const activeRequest = request

    void activeRequest.promise
      .then(({ health, metadata }) => {
        if (isCurrent) {
          setState({ status: "ready", health, metadata })
        }
      })
      .catch((error: unknown) => {
        if (isCurrent) {
          setState({
            status: "error",
            error: normalizeIpcError(ipcCommands.healthCheck, error),
          })
        }
      })
      .finally(() => {
        if (inFlightRequest.current === activeRequest) {
          inFlightRequest.current = null
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
