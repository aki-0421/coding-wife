export const domainEventSchemaVersion = 1 as const

export interface DomainEventPayloadMap {
  "app.runtime.changed": {
    readonly mode: "tauri" | "demo"
    readonly state: "ready" | "demo_only" | "unavailable"
  }
  "work.workspace.lifecycle.changed": {
    readonly lifecycle:
      "backlog" | "in_progress" | "in_review" | "done" | "canceled"
  }
  "code.session.status.changed": {
    readonly semanticVersion: 1
    readonly generation: number
    readonly sourceSequence: number
    readonly threadHandle: string
    readonly turnHandle: string
    readonly status:
      "idle" | "running" | "waiting" | "interrupted" | "failed" | "completed"
  }
  "live.renderer.status.changed": {
    readonly level: "animated" | "reduced" | "static" | "text_only"
    readonly errorCode?: string
  }
  "hist.writer.status.changed": {
    readonly status: "ready" | "read_only" | "blocked"
    readonly errorCode?: string
  }
  "git.checkpoint.status.changed": {
    readonly status: "pending" | "blocked" | "review_ready" | "failed"
    readonly checkpointId?: string
  }
}

export interface DomainEventProducerMap {
  "app.runtime.changed": "app"
  "work.workspace.lifecycle.changed": "work"
  "code.session.status.changed": "code"
  "live.renderer.status.changed": "live"
  "hist.writer.status.changed": "hist"
  "git.checkpoint.status.changed": "git"
}

export type DomainEventKind = keyof DomainEventPayloadMap
export type DomainEventProducer = DomainEventProducerMap[DomainEventKind]

export interface DomainEvent<K extends DomainEventKind> {
  readonly schemaVersion: typeof domainEventSchemaVersion
  readonly eventId: string
  readonly producer: DomainEventProducerMap[K]
  readonly kind: K
  readonly occurredAt: string
  readonly workspaceId?: string
  readonly sequence?: number
  readonly payload: Readonly<DomainEventPayloadMap[K]>
}

export type AnyDomainEvent = {
  [K in DomainEventKind]: DomainEvent<K>
}[DomainEventKind]

const baseRequiredKeys = [
  "schemaVersion",
  "eventId",
  "producer",
  "kind",
  "occurredAt",
  "payload",
] as const
const baseOptionalKeys = ["workspaceId", "sequence"] as const

export class DomainEventContractError extends Error {
  constructor() {
    super("The value did not match the domain event contract.")
    this.name = "DomainEventContractError"
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

function isTimestamp(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    value.includes("T") &&
    Number.isFinite(Date.parse(value))
  )
}

function eventViolation(): never {
  throw new DomainEventContractError()
}

interface ParsedEventBase {
  readonly eventId: string
  readonly occurredAt: string
  readonly workspaceId?: string
  readonly sequence?: number
}

function parseEventBase(
  value: Readonly<Record<string, unknown>>,
): ParsedEventBase {
  if (
    value.schemaVersion !== domainEventSchemaVersion ||
    !isNonEmptyString(value.eventId) ||
    !isTimestamp(value.occurredAt) ||
    (value.workspaceId !== undefined && !isNonEmptyString(value.workspaceId)) ||
    (value.sequence !== undefined &&
      (!Number.isSafeInteger(value.sequence) ||
        typeof value.sequence !== "number" ||
        value.sequence < 0))
  ) {
    return eventViolation()
  }

  return {
    eventId: value.eventId,
    occurredAt: value.occurredAt,
    ...(value.workspaceId === undefined
      ? {}
      : { workspaceId: value.workspaceId }),
    ...(value.sequence === undefined ? {} : { sequence: value.sequence }),
  }
}

function buildEvent<K extends DomainEventKind>(
  base: ParsedEventBase,
  producer: DomainEventProducerMap[K],
  kind: K,
  payload: Readonly<DomainEventPayloadMap[K]>,
): DomainEvent<K> {
  return {
    schemaVersion: domainEventSchemaVersion,
    eventId: base.eventId,
    producer,
    kind,
    occurredAt: base.occurredAt,
    ...(base.workspaceId === undefined
      ? {}
      : { workspaceId: base.workspaceId }),
    ...(base.sequence === undefined ? {} : { sequence: base.sequence }),
    payload,
  }
}

function assertProducer(
  actualProducer: unknown,
  expectedProducer: DomainEventProducer,
): void {
  if (actualProducer !== expectedProducer) {
    eventViolation()
  }
}

function parseAppEvent(
  value: Readonly<Record<string, unknown>>,
  base: ParsedEventBase,
): DomainEvent<"app.runtime.changed"> {
  assertProducer(value.producer, "app")

  if (
    !isRecord(value.payload) ||
    !hasExactKeys(value.payload, ["mode", "state"]) ||
    (value.payload.mode !== "tauri" && value.payload.mode !== "demo") ||
    (value.payload.state !== "ready" &&
      value.payload.state !== "demo_only" &&
      value.payload.state !== "unavailable")
  ) {
    return eventViolation()
  }

  return buildEvent(base, "app", "app.runtime.changed", {
    mode: value.payload.mode,
    state: value.payload.state,
  })
}

function parseWorkEvent(
  value: Readonly<Record<string, unknown>>,
  base: ParsedEventBase,
): DomainEvent<"work.workspace.lifecycle.changed"> {
  assertProducer(value.producer, "work")

  if (!isRecord(value.payload)) {
    return eventViolation()
  }

  const payload = value.payload

  const lifecycles = [
    "backlog",
    "in_progress",
    "in_review",
    "done",
    "canceled",
  ] as const

  if (
    !hasExactKeys(payload, ["lifecycle"]) ||
    !lifecycles.some((lifecycle) => lifecycle === payload.lifecycle)
  ) {
    return eventViolation()
  }

  return buildEvent(base, "work", "work.workspace.lifecycle.changed", {
    lifecycle: payload.lifecycle as (typeof lifecycles)[number],
  })
}

function parseCodeEvent(
  value: Readonly<Record<string, unknown>>,
  base: ParsedEventBase,
): DomainEvent<"code.session.status.changed"> {
  assertProducer(value.producer, "code")

  if (!isRecord(value.payload)) {
    return eventViolation()
  }

  const payload = value.payload

  const statuses = [
    "idle",
    "running",
    "waiting",
    "interrupted",
    "failed",
    "completed",
  ] as const

  if (
    !hasExactKeys(payload, [
      "semanticVersion",
      "generation",
      "sourceSequence",
      "threadHandle",
      "turnHandle",
      "status",
    ]) ||
    payload.semanticVersion !== 1 ||
    typeof payload.generation !== "number" ||
    !Number.isSafeInteger(payload.generation) ||
    payload.generation < 1 ||
    typeof payload.sourceSequence !== "number" ||
    !Number.isSafeInteger(payload.sourceSequence) ||
    payload.sourceSequence < 0 ||
    !isNonEmptyString(payload.threadHandle) ||
    !isNonEmptyString(payload.turnHandle) ||
    !statuses.some((status) => status === payload.status)
  ) {
    return eventViolation()
  }

  return buildEvent(base, "code", "code.session.status.changed", {
    semanticVersion: 1,
    generation: payload.generation,
    sourceSequence: payload.sourceSequence,
    threadHandle: payload.threadHandle,
    turnHandle: payload.turnHandle,
    status: payload.status as (typeof statuses)[number],
  })
}

function parseLiveEvent(
  value: Readonly<Record<string, unknown>>,
  base: ParsedEventBase,
): DomainEvent<"live.renderer.status.changed"> {
  assertProducer(value.producer, "live")

  if (!isRecord(value.payload)) {
    return eventViolation()
  }

  const payload = value.payload

  const levels = ["animated", "reduced", "static", "text_only"] as const

  if (
    !hasExactKeys(payload, ["level"], ["errorCode"]) ||
    !levels.some((level) => level === payload.level) ||
    (payload.errorCode !== undefined && !isNonEmptyString(payload.errorCode))
  ) {
    return eventViolation()
  }

  return buildEvent(base, "live", "live.renderer.status.changed", {
    level: payload.level as (typeof levels)[number],
    ...(payload.errorCode === undefined
      ? {}
      : { errorCode: payload.errorCode }),
  })
}

function parseHistoryEvent(
  value: Readonly<Record<string, unknown>>,
  base: ParsedEventBase,
): DomainEvent<"hist.writer.status.changed"> {
  assertProducer(value.producer, "hist")

  if (!isRecord(value.payload)) {
    return eventViolation()
  }

  const payload = value.payload

  const statuses = ["ready", "read_only", "blocked"] as const

  if (
    !hasExactKeys(payload, ["status"], ["errorCode"]) ||
    !statuses.some((status) => status === payload.status) ||
    (payload.errorCode !== undefined && !isNonEmptyString(payload.errorCode))
  ) {
    return eventViolation()
  }

  return buildEvent(base, "hist", "hist.writer.status.changed", {
    status: payload.status as (typeof statuses)[number],
    ...(payload.errorCode === undefined
      ? {}
      : { errorCode: payload.errorCode }),
  })
}

function parseGitEvent(
  value: Readonly<Record<string, unknown>>,
  base: ParsedEventBase,
): DomainEvent<"git.checkpoint.status.changed"> {
  assertProducer(value.producer, "git")

  if (!isRecord(value.payload)) {
    return eventViolation()
  }

  const payload = value.payload

  const statuses = ["pending", "blocked", "review_ready", "failed"] as const

  if (
    !hasExactKeys(payload, ["status"], ["checkpointId"]) ||
    !statuses.some((status) => status === payload.status) ||
    (payload.checkpointId !== undefined &&
      !isNonEmptyString(payload.checkpointId))
  ) {
    return eventViolation()
  }

  return buildEvent(base, "git", "git.checkpoint.status.changed", {
    status: payload.status as (typeof statuses)[number],
    ...(payload.checkpointId === undefined
      ? {}
      : { checkpointId: payload.checkpointId }),
  })
}

export function parseDomainEvent(value: unknown): AnyDomainEvent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, baseRequiredKeys, baseOptionalKeys)
  ) {
    return eventViolation()
  }

  const base = parseEventBase(value)

  switch (value.kind) {
    case "app.runtime.changed":
      return parseAppEvent(value, base)
    case "work.workspace.lifecycle.changed":
      return parseWorkEvent(value, base)
    case "code.session.status.changed":
      return parseCodeEvent(value, base)
    case "live.renderer.status.changed":
      return parseLiveEvent(value, base)
    case "hist.writer.status.changed":
      return parseHistoryEvent(value, base)
    case "git.checkpoint.status.changed":
      return parseGitEvent(value, base)
    default:
      return eventViolation()
  }
}
