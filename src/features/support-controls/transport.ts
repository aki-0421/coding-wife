import { invoke as tauriInvoke } from "@tauri-apps/api/core"

import {
  SupportControlContractError,
  parseSupportControlCommandError,
  parseSupportControlSnapshot,
  supportControlCommands,
  supportControlSchemaVersion,
  type SupportControlCommandErrorEnvelope,
  type SupportControlSnapshotV1,
  type SupportEffectiveState,
  type SupportSettingsUpdateRequestV1,
} from "@/features/support-controls/contracts"

type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>

export type SupportControlsGatewayKind = "native" | "demo"

export interface SupportControlsGateway {
  readonly kind: SupportControlsGatewayKind
  get(): Promise<SupportControlSnapshotV1>
  update(
    request: SupportSettingsUpdateRequestV1,
  ): Promise<SupportControlSnapshotV1>
}

export class SupportControlsBoundaryError
  extends Error
  implements SupportControlCommandErrorEnvelope
{
  public readonly code: string
  public readonly operation: string
  public readonly recoverable: boolean
  public readonly userMessageKey: string

  public constructor(error?: SupportControlCommandErrorEnvelope) {
    const envelope = error ?? {
      code: "CODEX-SUPPORT-IPC-UNAVAILABLE",
      operation: "support_settings_ipc",
      recoverable: true,
      userMessageKey: "support.error.generic",
    }
    super(envelope.code)
    this.name = "SupportControlsBoundaryError"
    this.code = envelope.code
    this.operation = envelope.operation
    this.recoverable = envelope.recoverable
    this.userMessageKey = envelope.userMessageKey
  }
}

function normalizeError(error: unknown): SupportControlsBoundaryError {
  if (error instanceof SupportControlsBoundaryError) return error
  if (error instanceof SupportControlContractError) {
    return new SupportControlsBoundaryError({
      code: error.code,
      operation: "support_settings_contract",
      recoverable: false,
      userMessageKey: "support.error.generic",
    })
  }
  return new SupportControlsBoundaryError(
    parseSupportControlCommandError(error) ?? undefined,
  )
}

export class NativeSupportControlsGateway implements SupportControlsGateway {
  public readonly kind = "native" as const

  public constructor(private readonly invoke: Invoke = tauriInvoke) {}

  public get(): Promise<SupportControlSnapshotV1> {
    return this.request(supportControlCommands.get, {
      schemaVersion: supportControlSchemaVersion,
    })
  }

  public update(
    request: SupportSettingsUpdateRequestV1,
  ): Promise<SupportControlSnapshotV1> {
    return this.request(supportControlCommands.update, request)
  }

  private async request(
    command: string,
    request: unknown,
  ): Promise<SupportControlSnapshotV1> {
    try {
      return parseSupportControlSnapshot(
        await this.invoke(command, { request }),
      )
    } catch (error) {
      throw normalizeError(error)
    }
  }
}

function demoEffectiveState(
  globalEnabled: boolean,
  commitExplainerEnabled: boolean,
): {
  readonly state: SupportEffectiveState
  readonly reason: string
} {
  if (!globalEnabled) {
    return {
      state: "user_disabled",
      reason: "CODEX-SUPPORT-DISABLED",
    }
  }
  if (!commitExplainerEnabled) {
    return {
      state: "role_disabled",
      reason: "CODEX-SUPPORT-COMMIT-EXPLAINER-DISABLED",
    }
  }
  return {
    state: "release_blocked",
    reason: "CODEX-SUPPORT-DEMO-NO-MODEL",
  }
}

export class DemoSupportControlsGateway implements SupportControlsGateway {
  public readonly kind = "demo" as const
  #version = 1
  #globalEnabled = true
  #commitExplainerEnabled = true

  public get(): Promise<SupportControlSnapshotV1> {
    return Promise.resolve(this.snapshot())
  }

  public update(
    request: SupportSettingsUpdateRequestV1,
  ): Promise<SupportControlSnapshotV1> {
    return Promise.resolve().then(() => {
      if (
        request.schemaVersion !== supportControlSchemaVersion ||
        request.expectedVersion !== this.#version
      ) {
        throw new SupportControlsBoundaryError({
          code: "CODEX-SUPPORT-SETTINGS-CONFLICT",
          operation: supportControlCommands.update,
          recoverable: true,
          userMessageKey: "support.error.generic",
        })
      }
      this.#version += 1
      this.#globalEnabled = request.globalEnabled
      this.#commitExplainerEnabled = request.commitExplainerEnabled
      return this.snapshot()
    })
  }

  private snapshot(): SupportControlSnapshotV1 {
    const effective = demoEffectiveState(
      this.#globalEnabled,
      this.#commitExplainerEnabled,
    )
    return {
      schemaVersion: supportControlSchemaVersion,
      settings: {
        schemaVersion: supportControlSchemaVersion,
        version: this.#version,
        globalEnabled: this.#globalEnabled,
        commitExplainerEnabled: this.#commitExplainerEnabled,
      },
      persistence: "demo_memory",
      recoveryCode: null,
      readiness: {
        status: "unavailable",
        approvedCliVersion: "0.144.5",
        approvedBinaryHashPrefix: "5e29ab10ca1171be",
        approvedSchemaFingerprintPrefix: "efea5c6649ccbae7",
        observedCliVersion: null,
        observedBinaryHashPrefix: null,
        observedSchemaFingerprintPrefix: null,
        skillName: "coding-wife-explain-commit",
        skillVersion: null,
        skillDigestPrefix: null,
        reasonCode: "CODEX-SUPPORT-DEMO-NO-MODEL",
        checkedAt: "2026-07-19T00:00:00Z",
      },
      effectiveState: effective.state,
      effectiveEnabled: false,
      fallbackReasonCode: effective.reason,
      capacity: {
        maximumActive: 1,
        maximumQueued: 10,
        active: 0,
        queued: 0,
      },
      usage: {
        attemptedTasks: 0,
        startedTasks: 0,
        succeededTasks: 0,
        failedTasks: 0,
        canceledTasks: 0,
        unavailableTasks: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalLatencyMs: 0,
      },
      audit: {
        role: "commit_explainer",
        modelFamily: "gpt-5.6-sol",
        reasoningEffort: "low",
        permissionProfile: "coding-wife-support-zero",
        rawTranscriptPersisted: false,
        taskTimeoutMs: 15_000,
        tokenBudget: 16_000,
        latestOutcome: null,
      },
      lastErrorCode: null,
    }
  }
}

const demoGateway = new DemoSupportControlsGateway()

export function createSupportControlsGateway(
  kind: SupportControlsGatewayKind,
): SupportControlsGateway {
  return kind === "native" ? new NativeSupportControlsGateway() : demoGateway
}
