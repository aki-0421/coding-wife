import { invoke as tauriInvoke } from "@tauri-apps/api/core"

import {
  NativeReadinessContractError,
  nativeReadinessCommands,
  nativeReadinessSchemaVersion,
  parseNativeReadinessSnapshot,
  parseReadinessCommandError,
  parseSanitizedDiagnosticsSummary,
  readinessCheckIds,
  type NativeReadinessSnapshotV1,
  type ReadinessCheckV1,
  type ReadinessCommandErrorEnvelope,
  type SanitizedDiagnosticsSummaryV1,
} from "@/features/readiness/contracts"

type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>

export type NativeReadinessGatewayKind = "native" | "demo"

export interface NativeReadinessGateway {
  readonly kind: NativeReadinessGatewayKind
  run(): Promise<NativeReadinessSnapshotV1>
  copy(snapshotId: string): Promise<SanitizedDiagnosticsSummaryV1>
}

export class NativeReadinessBoundaryError
  extends Error
  implements ReadinessCommandErrorEnvelope
{
  public readonly code: string
  public readonly operation: string
  public readonly recoverable: boolean
  public readonly userMessageKey: string
  public readonly detailRef: string

  public constructor(error?: ReadinessCommandErrorEnvelope) {
    const envelope = error ?? {
      code: "READINESS-IPC-UNAVAILABLE",
      operation: "native_readiness_ipc",
      recoverable: true,
      userMessageKey: "readiness.error.generic",
      detailRef: "native-readiness-v1",
    }
    super(envelope.code)
    this.name = "NativeReadinessBoundaryError"
    this.code = envelope.code
    this.operation = envelope.operation
    this.recoverable = envelope.recoverable
    this.userMessageKey = envelope.userMessageKey
    this.detailRef = envelope.detailRef
  }
}

function normalizeError(error: unknown): NativeReadinessBoundaryError {
  if (error instanceof NativeReadinessBoundaryError) return error
  if (error instanceof NativeReadinessContractError) {
    return new NativeReadinessBoundaryError({
      code: error.code,
      operation: "native_readiness_contract",
      recoverable: false,
      userMessageKey: "readiness.error.generic",
      detailRef: "native-readiness-v1",
    })
  }
  return new NativeReadinessBoundaryError(
    parseReadinessCommandError(error) ?? undefined,
  )
}

export class TauriNativeReadinessGateway implements NativeReadinessGateway {
  public readonly kind = "native" as const

  public constructor(private readonly invoke: Invoke = tauriInvoke) {}

  public async run(): Promise<NativeReadinessSnapshotV1> {
    try {
      return parseNativeReadinessSnapshot(
        await this.invoke(nativeReadinessCommands.run, {
          request: { schemaVersion: nativeReadinessSchemaVersion },
        }),
      )
    } catch (error) {
      throw normalizeError(error)
    }
  }

  public async copy(
    snapshotId: string,
  ): Promise<SanitizedDiagnosticsSummaryV1> {
    try {
      return parseSanitizedDiagnosticsSummary(
        await this.invoke(nativeReadinessCommands.copy, {
          request: {
            schemaVersion: nativeReadinessSchemaVersion,
            snapshotId,
          },
        }),
        snapshotId,
      )
    } catch (error) {
      throw normalizeError(error)
    }
  }
}

function demoSnapshotId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`
}

function demoCheck(
  id: (typeof readinessCheckIds)[number],
  checkedAt: string,
): ReadinessCheckV1 {
  return {
    id,
    status: "unavailable",
    checkedAt,
    code: `READINESS-DEMO-${id.toUpperCase().replace("_", "-")}-UNAVAILABLE`,
    recoverable: false,
    recoveryAction: "none",
    facts: [],
  }
}

export class DemoNativeReadinessGateway implements NativeReadinessGateway {
  public readonly kind = "demo" as const
  #sequence = 0
  #latest: NativeReadinessSnapshotV1 | null = null

  public run(): Promise<NativeReadinessSnapshotV1> {
    this.#sequence += 1
    const checkedAt = new Date().toISOString()
    this.#latest = {
      schemaVersion: nativeReadinessSchemaVersion,
      snapshotId: demoSnapshotId(this.#sequence),
      checkedAt,
      source: "demo",
      checks: readinessCheckIds.map((id) => demoCheck(id, checkedAt)),
    }
    return Promise.resolve(structuredClone(this.#latest))
  }

  public copy(snapshotId: string): Promise<SanitizedDiagnosticsSummaryV1> {
    if (this.#latest?.snapshotId !== snapshotId) {
      return Promise.reject(
        new NativeReadinessBoundaryError({
          code: "READINESS-SNAPSHOT-STALE",
          operation: "copy_sanitized_diagnostics",
          recoverable: true,
          userMessageKey: "readiness.error.generic",
          detailRef: "native-readiness-v1",
        }),
      )
    }
    const lines = [
      "Coding Wife diagnostics v1",
      `snapshot=${this.#latest.snapshotId}`,
      `checkedAt=${this.#latest.checkedAt}`,
      "source=demo",
      ...this.#latest.checks.map(
        (check) => `${check.id} ${check.status} ${check.code}`,
      ),
      "",
    ]
    return Promise.resolve({
      schemaVersion: nativeReadinessSchemaVersion,
      snapshotId,
      summary: lines.join("\n"),
    })
  }
}

export function createNativeReadinessGateway(
  kind: NativeReadinessGatewayKind,
): NativeReadinessGateway {
  return kind === "native"
    ? new TauriNativeReadinessGateway()
    : new DemoNativeReadinessGateway()
}
