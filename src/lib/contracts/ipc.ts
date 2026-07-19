export const ipcSchemaVersion = 1 as const

export const ipcCommands = {
  healthCheck: "health_check",
  getRuntimeMetadata: "get_runtime_metadata",
} as const

export type RuntimeKind = "tauri" | "demo"
export type FoundationState = "ready" | "demo_only"
export type IntegrationId = "codex" | "git" | "live2d" | "history"
export type IntegrationReadiness =
  | "not_configured"
  | "ready"
  | "read_only"
  | "recovery_required"

export interface HealthCheckResponse {
  readonly schemaVersion: typeof ipcSchemaVersion
  readonly runtime: RuntimeKind
  readonly foundationState: FoundationState
}

export interface RuntimeMetadata {
  readonly schemaVersion: typeof ipcSchemaVersion
  readonly runtime: RuntimeKind
  readonly appVersion: string
  readonly platform: string
  readonly architecture: string
  readonly integrations: Readonly<Record<IntegrationId, IntegrationReadiness>>
}

export interface IpcErrorEnvelope {
  readonly code: string
  readonly operation: IpcCommand
  readonly recoverable: boolean
  readonly userMessageKey: string
  readonly detailRef?: string
}

export class IpcBoundaryError extends Error implements IpcErrorEnvelope {
  readonly code: string
  readonly operation: IpcCommand
  readonly recoverable: boolean
  readonly userMessageKey: string
  readonly detailRef?: string

  constructor(envelope: IpcErrorEnvelope) {
    super(envelope.code)
    Object.defineProperty(this, "name", { value: "IpcBoundaryError" })
    this.code = envelope.code
    this.operation = envelope.operation
    this.recoverable = envelope.recoverable
    this.userMessageKey = envelope.userMessageKey

    if (envelope.detailRef !== undefined) {
      this.detailRef = envelope.detailRef
    }
  }
}

export interface IpcRequestMap {
  health_check: undefined
  get_runtime_metadata: undefined
}

export interface IpcResponseMap {
  health_check: HealthCheckResponse
  get_runtime_metadata: RuntimeMetadata
}

export type IpcCommand = keyof IpcRequestMap & keyof IpcResponseMap

const healthResponseKeys = [
  "schemaVersion",
  "runtime",
  "foundationState",
] as const
const metadataResponseKeys = [
  "schemaVersion",
  "runtime",
  "appVersion",
  "platform",
  "architecture",
  "integrations",
] as const
const integrationKeys = ["codex", "git", "live2d", "history"] as const
const errorEnvelopeRequiredKeys = [
  "code",
  "operation",
  "recoverable",
  "userMessageKey",
] as const

class IpcContractViolation extends Error {
  readonly operation: IpcCommand

  constructor(operation: IpcCommand) {
    super("The native response did not match the IPC contract.")
    this.name = "IpcContractViolation"
    this.operation = operation
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  const keys = Object.keys(value)
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys])

  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowedKeys.has(key))
  )
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isRuntimeKind(value: unknown): value is RuntimeKind {
  return value === "tauri" || value === "demo"
}

function isFoundationState(value: unknown): value is FoundationState {
  return value === "ready" || value === "demo_only"
}

function isIntegrationReadiness(value: unknown): value is IntegrationReadiness {
  return (
    value === "not_configured" ||
    value === "ready" ||
    value === "read_only" ||
    value === "recovery_required"
  )
}

function isIpcCommand(value: unknown): value is IpcCommand {
  return (
    value === ipcCommands.healthCheck ||
    value === ipcCommands.getRuntimeMetadata
  )
}

function contractViolation(operation: IpcCommand): never {
  throw new IpcContractViolation(operation)
}

export function parseHealthCheckResponse(value: unknown): HealthCheckResponse {
  const operation = ipcCommands.healthCheck

  if (!isRecord(value) || !hasExactKeys(value, healthResponseKeys)) {
    return contractViolation(operation)
  }

  if (
    value.schemaVersion !== ipcSchemaVersion ||
    !isRuntimeKind(value.runtime) ||
    !isFoundationState(value.foundationState)
  ) {
    return contractViolation(operation)
  }

  if (
    (value.runtime === "tauri" && value.foundationState !== "ready") ||
    (value.runtime === "demo" && value.foundationState !== "demo_only")
  ) {
    return contractViolation(operation)
  }

  return {
    schemaVersion: ipcSchemaVersion,
    runtime: value.runtime,
    foundationState: value.foundationState,
  }
}

export function parseRuntimeMetadata(value: unknown): RuntimeMetadata {
  const operation = ipcCommands.getRuntimeMetadata

  if (!isRecord(value) || !hasExactKeys(value, metadataResponseKeys)) {
    return contractViolation(operation)
  }

  if (!isRecord(value.integrations)) {
    return contractViolation(operation)
  }

  const integrations = value.integrations

  if (
    value.schemaVersion !== ipcSchemaVersion ||
    !isRuntimeKind(value.runtime) ||
    !isNonEmptyString(value.appVersion) ||
    !isNonEmptyString(value.platform) ||
    !isNonEmptyString(value.architecture) ||
    !hasExactKeys(integrations, integrationKeys) ||
    integrations.codex !== "not_configured" ||
    integrations.git !== "not_configured" ||
    integrations.live2d !== "not_configured" ||
    !isIntegrationReadiness(integrations.history)
  ) {
    return contractViolation(operation)
  }

  return {
    schemaVersion: ipcSchemaVersion,
    runtime: value.runtime,
    appVersion: value.appVersion,
    platform: value.platform,
    architecture: value.architecture,
    integrations: {
      codex: "not_configured",
      git: "not_configured",
      live2d: "not_configured",
      history: integrations.history,
    },
  }
}

export function parseIpcResponse(
  command: typeof ipcCommands.healthCheck,
  value: unknown,
): HealthCheckResponse
export function parseIpcResponse(
  command: typeof ipcCommands.getRuntimeMetadata,
  value: unknown,
): RuntimeMetadata
export function parseIpcResponse(
  command: IpcCommand,
  value: unknown,
): HealthCheckResponse | RuntimeMetadata {
  switch (command) {
    case ipcCommands.healthCheck:
      return parseHealthCheckResponse(value)
    case ipcCommands.getRuntimeMetadata:
      return parseRuntimeMetadata(value)
  }
}

export function isIpcErrorEnvelope(value: unknown): value is IpcErrorEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, errorEnvelopeRequiredKeys, ["detailRef"])
  ) {
    return false
  }

  return (
    isNonEmptyString(value.code) &&
    isIpcCommand(value.operation) &&
    typeof value.recoverable === "boolean" &&
    isNonEmptyString(value.userMessageKey) &&
    (value.detailRef === undefined || isNonEmptyString(value.detailRef))
  )
}

function createContractError(operation: IpcCommand): IpcErrorEnvelope {
  return {
    code: "APP-IPC-CONTRACT-MISMATCH",
    operation,
    recoverable: false,
    userMessageKey: "foundation.error",
    detailRef: "runtime-contract-v1",
  }
}

export function normalizeIpcError(
  operation: IpcCommand,
  error: unknown,
): IpcErrorEnvelope {
  if (error instanceof IpcContractViolation) {
    return createContractError(error.operation)
  }

  if (isIpcErrorEnvelope(error)) {
    return {
      code: error.code,
      operation: error.operation,
      recoverable: error.recoverable,
      userMessageKey: error.userMessageKey,
      ...(error.detailRef === undefined ? {} : { detailRef: error.detailRef }),
    }
  }

  return {
    code: "APP-IPC-UNAVAILABLE",
    operation,
    recoverable: true,
    userMessageKey: "foundation.error",
  }
}

export function validateRuntimeResponses(
  transportKind: RuntimeKind,
  health: HealthCheckResponse,
  metadata: RuntimeMetadata,
): void {
  if (
    health.schemaVersion !== metadata.schemaVersion ||
    health.runtime !== metadata.runtime ||
    health.runtime !== transportKind
  ) {
    throw new IpcBoundaryError(
      createContractError(ipcCommands.getRuntimeMetadata),
    )
  }
}
