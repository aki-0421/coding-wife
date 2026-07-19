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

interface InFlightCommands {
  transport: AppTransport | null
  health: Promise<HealthCheckResponse> | null
  metadata: Promise<RuntimeMetadata> | null
}

export type RuntimeState =
  | { readonly status: "loading" }
  | ({ readonly status: "ready" } & ReadyRuntime)
  | { readonly status: "error"; readonly error: IpcErrorEnvelope }

export interface RuntimeProviderProps {
  readonly children: ReactNode
  readonly transport: AppTransport
}

function alignCommandCache(
  commands: InFlightCommands,
  transport: AppTransport,
): void {
  if (commands.transport !== transport) {
    commands.transport = transport
    commands.health = null
    commands.metadata = null
  }
}

function requestHealth(
  commands: InFlightCommands,
  transport: AppTransport,
): Promise<HealthCheckResponse> {
  alignCommandCache(commands, transport)
  if (commands.health !== null) {
    return commands.health
  }

  const request = transport.request(ipcCommands.healthCheck, undefined)
  commands.health = request
  void request.then(
    () => {
      if (commands.transport === transport && commands.health === request) {
        commands.health = null
      }
    },
    () => {
      if (commands.transport === transport && commands.health === request) {
        commands.health = null
      }
    },
  )
  return request
}

function requestMetadata(
  commands: InFlightCommands,
  transport: AppTransport,
): Promise<RuntimeMetadata> {
  alignCommandCache(commands, transport)
  if (commands.metadata !== null) {
    return commands.metadata
  }

  const request = transport.request(ipcCommands.getRuntimeMetadata, undefined)
  commands.metadata = request
  void request.then(
    () => {
      if (commands.transport === transport && commands.metadata === request) {
        commands.metadata = null
      }
    },
    () => {
      if (commands.transport === transport && commands.metadata === request) {
        commands.metadata = null
      }
    },
  )
  return request
}

async function requestRuntime(
  transport: AppTransport,
  commands: InFlightCommands,
): Promise<ReadyRuntime> {
  const [health, metadata] = await Promise.all([
    requestHealth(commands, transport),
    requestMetadata(commands, transport),
  ])

  validateRuntimeResponses(transport.kind, health, metadata)
  return { health, metadata }
}

export function RuntimeProvider({ children, transport }: RuntimeProviderProps) {
  const [requestVersion, setRequestVersion] = useState(0)
  const [state, setState] = useState<RuntimeState>({ status: "loading" })
  const inFlightRequest = useRef<InFlightRequest | null>(null)
  const inFlightCommands = useRef<InFlightCommands>({
    transport: null,
    health: null,
    metadata: null,
  })
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
        promise: requestRuntime(transport, inFlightCommands.current),
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
