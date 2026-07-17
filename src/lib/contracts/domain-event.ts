export const domainEventSchemaVersion = 1 as const

export type DomainEventProducer =
  "app" | "work" | "code" | "live" | "hist" | "git"

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

export type DomainEventKind = keyof DomainEventPayloadMap

export interface DomainEvent<K extends DomainEventKind> {
  readonly schemaVersion: typeof domainEventSchemaVersion
  readonly eventId: string
  readonly producer: DomainEventProducer
  readonly kind: K
  readonly occurredAt: string
  readonly workspaceId?: string
  readonly sequence?: number
  readonly payload: Readonly<DomainEventPayloadMap[K]>
}

export type AnyDomainEvent = {
  [K in DomainEventKind]: DomainEvent<K>
}[DomainEventKind]
