import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

import {
  CodexContractError,
  codexAdapterVersion,
  codexCommands,
  codexEventChannel,
  codexEventSchemaVersion,
  codexModel,
  parseCodexCommandError,
  parseCodexEvent,
  parseCodexResponse,
  type CodexCommand,
  type CodexCommandErrorEnvelope,
  type CodexDiagnostic,
  type CodexEvent,
  type CodexRequestMap,
  type CodexResponseMap,
} from "@/lib/contracts"

export type CodexTransportKind = "tauri" | "demo"
export type CodexInvoker = (
  command: CodexCommand,
  payload: unknown,
) => Promise<unknown>
export type CodexEventRegistrar = (
  handler: (payload: unknown) => void,
) => Promise<() => void>

export interface CodexEventCallbacks {
  readonly onEvent: (event: CodexEvent) => void
  readonly onContractError: (error: CodexBoundaryError) => void
}

export interface CodexTransport {
  readonly kind: CodexTransportKind
  request<K extends CodexCommand>(
    command: K,
    request: CodexRequestMap[K],
  ): Promise<CodexResponseMap[K]>
  subscribe(callbacks: CodexEventCallbacks): Promise<() => void>
}

export class CodexBoundaryError
  extends Error
  implements CodexCommandErrorEnvelope
{
  readonly code: string
  readonly operation: string
  readonly recoverable: boolean
  readonly userMessageKey: string
  readonly detailRef?: string

  constructor(envelope: CodexCommandErrorEnvelope) {
    super(envelope.code)
    this.name = "CodexBoundaryError"
    this.code = envelope.code
    this.operation = envelope.operation
    this.recoverable = envelope.recoverable
    this.userMessageKey = envelope.userMessageKey
    if (envelope.detailRef !== undefined) this.detailRef = envelope.detailRef
  }
}

function contractError(operation: string): CodexBoundaryError {
  return new CodexBoundaryError({
    code: "CODEX-IPC-CONTRACT-MISMATCH",
    operation,
    recoverable: false,
    userMessageKey: "codex.error.contract",
    detailRef: "codex-runtime-v1",
  })
}

function unavailableError(operation: string): CodexBoundaryError {
  return new CodexBoundaryError({
    code: "CODEX-IPC-UNAVAILABLE",
    operation,
    recoverable: true,
    userMessageKey: "codex.error.unavailable",
  })
}

function normalizeError(operation: string, error: unknown): CodexBoundaryError {
  if (error instanceof CodexBoundaryError) return error
  if (error instanceof CodexContractError) return contractError(operation)
  const envelope = parseCodexCommandError(error)
  return envelope === null
    ? unavailableError(operation)
    : new CodexBoundaryError(envelope)
}

const invokeTauri: CodexInvoker = (command, request) =>
  invoke(command, request === undefined ? undefined : { request })

const registerTauriEvents: CodexEventRegistrar = async (handler) =>
  listen<unknown>(codexEventChannel, (event) => {
    handler(event.payload)
  })

export class TauriCodexTransport implements CodexTransport {
  readonly kind = "tauri"

  constructor(
    private readonly invoker: CodexInvoker = invokeTauri,
    private readonly registrar: CodexEventRegistrar = registerTauriEvents,
  ) {}

  async request<K extends CodexCommand>(
    command: K,
    request: CodexRequestMap[K],
  ): Promise<CodexResponseMap[K]> {
    try {
      return parseCodexResponse(command, await this.invoker(command, request))
    } catch (error) {
      throw normalizeError(command, error)
    }
  }

  async subscribe(callbacks: CodexEventCallbacks): Promise<() => void> {
    try {
      return await this.registrar((payload) => {
        try {
          callbacks.onEvent(parseCodexEvent(payload))
        } catch (error) {
          callbacks.onContractError(normalizeError("codex_event", error))
        }
      })
    } catch (error) {
      throw normalizeError("codex_event.subscribe", error)
    }
  }
}

const demoTimestamp = "2026-07-18T00:00:00.000Z"
const demoCapabilities = {
  coreLifecycle: "supported",
  modelDiscovery: "supported",
  nativeRequestUserInput: "supported",
  dynamicTools: "supported",
  permissionsApproval: "supported",
  detachedReview: "supported",
  ephemeralThread: "supported",
  supportIsolation: "unavailable",
} as const

const demoDiagnostic: CodexDiagnostic = {
  adapterVersion: codexAdapterVersion,
  health: "ready",
  checkedAt: demoTimestamp,
  operation: "codex.demo",
  recoverable: true,
  cliVersion: "demo",
  binarySource: "test_fixture",
  binaryHashPrefix: "demo000000000000",
  schemaFingerprintPrefix: "demo000000000000",
  generatedBySameBinary: true,
  experimentalApiRequested: true,
  experimentalApiAccepted: true,
  accountPresent: true,
  authKind: "demo",
  requiresOpenaiAuth: false,
  modelAvailable: true,
  fastAvailable: true,
  maxAvailable: true,
  configModelPresent: true,
  childState: "ready",
  lastSuccessfulHandshakeAt: demoTimestamp,
  capabilities: demoCapabilities,
  errorCode: null,
  detailRef: null,
}

export class DemoCodexTransport implements CodexTransport {
  readonly kind = "demo"
  private readonly listeners = new Set<(event: CodexEvent) => void>()
  private sequence = 0

  request<K extends CodexCommand>(
    command: K,
    request: CodexRequestMap[K],
  ): Promise<CodexResponseMap[K]> {
    switch (command) {
      case codexCommands.pickWorkspace:
        return Promise.resolve({
          schemaVersion: 1,
          workspaceId: "workspace-demo",
          alias: "Demo repository",
          preflight: {
            gitRepository: true,
            ownedByCurrentUser: true,
            writable: true,
          },
        } as CodexResponseMap[K])
      case codexCommands.getDiagnostic:
      case codexCommands.probe:
      case codexCommands.connect:
        return Promise.resolve(demoDiagnostic as CodexResponseMap[K])
      case codexCommands.threadList:
        return Promise.resolve({
          data: [
            {
              threadHandle: "demo-thread-1",
              status: "idle",
              title: "Demo session",
              updatedAt: demoTimestamp,
            },
          ],
          nextCursor: null,
        } as unknown as CodexResponseMap[K])
      case codexCommands.threadStart:
        return Promise.resolve({
          threadHandle: "demo-thread-1",
          model: codexModel,
        } as CodexResponseMap[K])
      case codexCommands.threadResume:
        return Promise.resolve({
          threadHandle: (request as CodexRequestMap["codex_thread_resume"])
            .threadHandle,
          model: codexModel,
        } as CodexResponseMap[K])
      case codexCommands.turnStart: {
        const turnRequest = request as CodexRequestMap["codex_turn_start"]
        queueMicrotask(() => {
          this.emit("turn_status", {
            threadHandle: turnRequest.threadHandle,
            turnHandle: "demo-turn-1",
            status: "running",
          })
          this.emit("agent_message_completed", {
            itemHandle: "demo-item-1",
            text: "The deterministic demo turn completed.",
          })
          this.emit("turn_status", {
            threadHandle: turnRequest.threadHandle,
            turnHandle: "demo-turn-1",
            status: "completed",
          })
        })
        return Promise.resolve({
          threadHandle: turnRequest.threadHandle,
          turnHandle: "demo-turn-1",
        } as CodexResponseMap[K])
      }
      case codexCommands.answerFallbackDecision:
        return Promise.resolve({
          threadHandle: "demo-thread-1",
          turnHandle: "demo-decision-turn-1",
        } as CodexResponseMap[K])
      case codexCommands.turnInterrupt: {
        const turnRequest = request as CodexRequestMap["codex_turn_interrupt"]
        queueMicrotask(() => {
          this.emit("turn_status", {
            threadHandle: turnRequest.threadHandle,
            turnHandle: turnRequest.turnHandle,
            status: "interrupted",
          })
        })
        return Promise.resolve({ accepted: true } as CodexResponseMap[K])
      }
      case codexCommands.reviewStart:
        return Promise.resolve({
          reviewThreadHandle: "demo-review-thread-1",
          turnHandle: "demo-review-turn-1",
        } as CodexResponseMap[K])
      case codexCommands.respondPending:
        return Promise.resolve({ accepted: true } as CodexResponseMap[K])
    }
  }

  subscribe(callbacks: CodexEventCallbacks): Promise<() => void> {
    const listener = (event: CodexEvent) => callbacks.onEvent(event)
    this.listeners.add(listener)
    return Promise.resolve(() => this.listeners.delete(listener))
  }

  private emit<K extends CodexEvent["kind"]>(
    kind: K,
    payload: Extract<CodexEvent, { readonly kind: K }>["payload"],
  ): void {
    this.sequence += 1
    const event = {
      schemaVersion: codexEventSchemaVersion,
      eventId: `demo-event-${String(this.sequence)}`,
      workspaceId: "demo-workspace",
      generation: 1,
      sequence: this.sequence,
      occurredAt: demoTimestamp,
      kind,
      payload,
    } as Extract<CodexEvent, { readonly kind: K }>
    for (const listener of this.listeners) listener(event)
  }
}
