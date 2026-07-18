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
  private readonly pendingTurns = new Map<
    string,
    {
      readonly kind: "decision" | "approval"
      readonly turnHandle: string
      readonly workspaceId: string
    }
  >()
  private sequence = 0
  private turnCounter = 0
  private activeWorkspaceId = "demo-workspace"
  private activeThreadHandle = "demo-thread-1"

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
        return Promise.resolve(demoDiagnostic as CodexResponseMap[K])
      case codexCommands.connect:
        this.activeWorkspaceId = (
          request as CodexRequestMap["codex_connect"]
        ).workspaceId
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
      case codexCommands.threadStart: {
        const threadRequest = request as CodexRequestMap["codex_thread_start"]
        this.activeWorkspaceId = threadRequest.workspaceId
        this.activeThreadHandle = "demo-thread-1"
        return Promise.resolve({
          threadHandle: this.activeThreadHandle,
          model: codexModel,
          generation: 1,
        } as CodexResponseMap[K])
      }
      case codexCommands.threadResume: {
        const threadRequest = request as CodexRequestMap["codex_thread_resume"]
        this.activeWorkspaceId = threadRequest.workspaceId
        this.activeThreadHandle = threadRequest.threadHandle
        return Promise.resolve({
          threadHandle: this.activeThreadHandle,
          model: codexModel,
          generation: 1,
        } as CodexResponseMap[K])
      }
      case codexCommands.pickAttachments: {
        return Promise.resolve({
          items: [
            this.demoAttachment(
              "picker",
              "demo-evidence.md",
              "attachment-00000000-0000-4000-8000-000000000001",
            ),
          ],
          rejections: [],
        } as unknown as CodexResponseMap[K])
      }
      case codexCommands.registerAttachmentPaths: {
        const attachmentRequest =
          request as CodexRequestMap["codex_register_attachment_paths"]
        return Promise.resolve({
          items: attachmentRequest.paths.map((path, index) => {
            const name = path.split(/[\\/]/u).at(-1) || "attachment"
            const suffix = String(index + 2).padStart(12, "0")
            return this.demoAttachment(
              attachmentRequest.source,
              name,
              `attachment-00000000-0000-4000-8000-${suffix}`,
            )
          }),
          rejections: [],
        } as unknown as CodexResponseMap[K])
      }
      case codexCommands.turnStart: {
        const turnRequest = request as CodexRequestMap["codex_turn_start"]
        this.turnCounter += 1
        const turnHandle = `demo-turn-${String(this.turnCounter)}`
        this.activeWorkspaceId = turnRequest.workspaceId
        this.activeThreadHandle = turnRequest.threadHandle
        this.startDemoTurn(
          turnRequest.text,
          turnRequest.workspaceId,
          turnHandle,
        )
        return Promise.resolve({
          threadHandle: turnRequest.threadHandle,
          turnHandle,
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
          this.emit(
            "turn_status",
            {
              threadHandle: turnRequest.threadHandle,
              turnHandle: turnRequest.turnHandle,
              status: "interrupted",
            },
            turnRequest.workspaceId,
          )
        })
        return Promise.resolve({ accepted: true } as CodexResponseMap[K])
      }
      case codexCommands.reviewStart:
        return Promise.resolve({
          reviewThreadHandle: "demo-review-thread-1",
          turnHandle: "demo-review-turn-1",
        } as CodexResponseMap[K])
      case codexCommands.respondPending: {
        const pendingRequest =
          request as CodexRequestMap["codex_respond_pending"]
        const pending = this.pendingTurns.get(pendingRequest.pendingId)
        if (pending === undefined) {
          return Promise.resolve({ accepted: false } as CodexResponseMap[K])
        }
        this.pendingTurns.delete(pendingRequest.pendingId)
        queueMicrotask(() => {
          this.emit(
            "pending_request_resolved",
            { pendingId: pendingRequest.pendingId, status: "accepted" },
            pending.workspaceId,
          )
          if (pending.kind === "decision") {
            this.emitApproval(pending.workspaceId, pending.turnHandle)
            return
          }
          const decision =
            pendingRequest.response.type === "approval"
              ? pendingRequest.response.decision
              : "reject"
          this.emit(
            "agent_message_completed",
            {
              itemHandle: `${pending.turnHandle}-result`,
              text:
                decision === "approve_once"
                  ? "The bounded operation was approved once and completed."
                  : "The bounded operation was not run; the turn completed without changing it.",
            },
            pending.workspaceId,
          )
          this.emit(
            "turn_status",
            {
              threadHandle: this.activeThreadHandle,
              turnHandle: pending.turnHandle,
              status: decision === "stop" ? "interrupted" : "completed",
            },
            pending.workspaceId,
          )
        })
        return Promise.resolve({ accepted: true } as CodexResponseMap[K])
      }
    }
  }

  subscribe(callbacks: CodexEventCallbacks): Promise<() => void> {
    const listener = (event: CodexEvent) => callbacks.onEvent(event)
    this.listeners.add(listener)
    return Promise.resolve(() => this.listeners.delete(listener))
  }

  private demoAttachment(
    source: "picker" | "drop" | "paste",
    name: string,
    handle: string,
  ) {
    const image = /\.(?:gif|jpe?g|png|webp)$/iu.test(name)
    return {
      schemaVersion: 1 as const,
      handle,
      name,
      relativePath: `attachments/${name}`,
      sizeBytes: image ? 1_024 : 512,
      kind: image ? ("image" as const) : ("file" as const),
      source,
      expiresAt: "2026-07-18T00:30:00.000Z",
    }
  }

  private startDemoTurn(
    instruction: string,
    workspaceId: string,
    turnHandle: string,
  ): void {
    const publicInstructionMarker = "\nCODING_WIFE_USER_INSTRUCTION_V1\n"
    const markerIndex = instruction.indexOf(publicInstructionMarker)
    const publicInstruction =
      markerIndex === -1
        ? instruction
        : instruction.slice(markerIndex + publicInstructionMarker.length)
    const scenario = publicInstruction.trim().toLocaleLowerCase()
    if (!scenario.startsWith("demo:")) {
      queueMicrotask(() => {
        this.emit(
          "turn_status",
          {
            threadHandle: this.activeThreadHandle,
            turnHandle,
            status: "running",
          },
          workspaceId,
        )
        this.emit(
          "agent_message_completed",
          {
            itemHandle: `${turnHandle}-assistant`,
            text: "The deterministic demo turn completed.",
          },
          workspaceId,
        )
        this.emit(
          "turn_status",
          {
            threadHandle: this.activeThreadHandle,
            turnHandle,
            status: "completed",
          },
          workspaceId,
        )
      })
      return
    }

    this.schedule(40, () =>
      this.emit(
        "turn_status",
        {
          threadHandle: this.activeThreadHandle,
          turnHandle,
          status: "running",
        },
        workspaceId,
      ),
    )

    if (scenario === "demo:stop") return
    if (scenario === "demo:crash") {
      this.schedule(140, () =>
        this.emit(
          "diagnostic",
          {
            code: "CODEX-APP-SERVER-EXITED",
            willRetry: false,
            detailRef: "demo-crash-no-replay",
          },
          workspaceId,
        ),
      )
      this.schedule(220, () =>
        this.emit(
          "turn_status",
          {
            threadHandle: this.activeThreadHandle,
            turnHandle,
            status: "interrupted",
          },
          workspaceId,
        ),
      )
      return
    }
    if (scenario === "demo:unknown") {
      this.schedule(140, () =>
        this.emit(
          "protocol_unsupported",
          {
            methodHash: "demo-unknown-approval",
            byteCount: 96,
            detailRef: "unknown-request-blocked",
          },
          workspaceId,
        ),
      )
      this.schedule(220, () =>
        this.emit(
          "turn_status",
          {
            threadHandle: this.activeThreadHandle,
            turnHandle,
            status: "interrupted",
          },
          workspaceId,
        ),
      )
      return
    }
    if (scenario === "demo:approval") {
      this.schedule(140, () => this.emitApproval(workspaceId, turnHandle))
      return
    }

    this.schedule(100, () =>
      this.emit("plan_updated", { stepCount: 3 }, workspaceId),
    )
    this.schedule(160, () =>
      this.emit(
        "agent_message_delta",
        {
          itemHandle: `${turnHandle}-assistant`,
          delta: "Inspecting the bounded workspace. ",
        },
        workspaceId,
      ),
    )
    this.schedule(220, () =>
      this.emit(
        "agent_message_delta",
        {
          itemHandle: `${turnHandle}-assistant`,
          delta: "Preparing verified changes.",
        },
        workspaceId,
      ),
    )
    this.schedule(280, () =>
      this.emit(
        "item_status",
        {
          itemHandle: `${turnHandle}-tool`,
          itemType: "commandExecution",
          status: "running",
        },
        workspaceId,
      ),
    )
    this.schedule(340, () =>
      this.emit(
        "tool_output",
        {
          itemHandle: `${turnHandle}-tool`,
          excerpt: "pnpm test: 37 focused checks passed",
        },
        workspaceId,
      ),
    )
    this.schedule(400, () =>
      this.emit(
        "file_change",
        {
          itemHandle: `${turnHandle}-file`,
          pathAlias: "src/features/workspace-view/Timeline.tsx",
          changeKind: "update",
        },
        workspaceId,
      ),
    )
    this.schedule(460, () =>
      this.emit(
        "diff_updated",
        { byteCount: 2_048, detailRef: "demo-diff-safe" },
        workspaceId,
      ),
    )
    this.schedule(520, () => this.emitDecision(workspaceId, turnHandle))
  }

  private emitDecision(workspaceId: string, turnHandle: string): void {
    const pendingId = `${turnHandle}-decision`
    this.pendingTurns.set(pendingId, {
      kind: "decision",
      turnHandle,
      workspaceId,
    })
    this.emit(
      "pending_request",
      {
        request: {
          pendingId,
          kind: "user_input",
          responseKind: "native_server_request",
          operation: "item/tool/requestUserInput",
          targetAlias: "current demo turn",
          reason: "Choose a bounded next step or provide another safe answer.",
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "How should the verified change continue?",
              options: [
                {
                  id: "bounded",
                  label: "One bounded unit",
                  description: "Complete one reviewable unit.",
                },
                {
                  id: "stop",
                  label: "Stop at this boundary",
                  description: "Do not continue into another work unit.",
                },
              ],
            },
          ],
          allowedDecisions: [],
          decisionContext: {
            schemaVersion: 1,
            category: "user_decision",
            targetKind: "active_turn",
            targetAlias: "current demo turn",
            effect: "continue_turn",
            scope: "turn",
            risk: "medium",
            reversibility: "unknown",
            recommendation: "bounded",
            evidence: [
              "A bounded continuation keeps the next change reviewable.",
            ],
            uncertainty: "limited_context",
          },
        },
      },
      workspaceId,
    )
  }

  private emitApproval(workspaceId: string, turnHandle: string): void {
    const pendingId = `${turnHandle}-approval`
    this.pendingTurns.set(pendingId, {
      kind: "approval",
      turnHandle,
      workspaceId,
    })
    this.emit(
      "pending_request",
      {
        request: {
          pendingId,
          kind: "command_approval",
          responseKind: "native_server_request",
          operation: "item/commandExecution/requestApproval",
          targetAlias: "focused verification command",
          reason: "The command writes only bounded test output.",
          questions: [],
          allowedDecisions: ["approve_once", "reject", "stop"],
          decisionContext: {
            schemaVersion: 1,
            category: "command_execution",
            targetKind: "workspace",
            targetAlias: "focused verification command",
            effect: "execute_command",
            scope: "command",
            risk: "low",
            reversibility: "reversible",
            recommendation: "approve_once",
            evidence: ["No network or Git history operation is requested."],
            uncertainty: "none",
          },
        },
      },
      workspaceId,
    )
  }

  private schedule(milliseconds: number, callback: () => void): void {
    globalThis.setTimeout(callback, milliseconds)
  }

  private emit<K extends CodexEvent["kind"]>(
    kind: K,
    payload: Extract<CodexEvent, { readonly kind: K }>["payload"],
    workspaceId = this.activeWorkspaceId,
  ): void {
    this.sequence += 1
    const event = {
      schemaVersion: codexEventSchemaVersion,
      eventId: `demo-event-${String(this.sequence)}`,
      workspaceId,
      generation: 1,
      sequence: this.sequence,
      occurredAt: new Date().toISOString(),
      kind,
      payload,
    } as Extract<CodexEvent, { readonly kind: K }>
    for (const listener of this.listeners) listener(event)
  }
}
