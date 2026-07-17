import { describe, expect, expectTypeOf, it } from "vitest"

import {
  domainEventSchemaVersion,
  parseDomainEvent,
  type DomainEvent,
} from "@/lib/contracts/domain-event"

const eventBase = {
  schemaVersion: domainEventSchemaVersion,
  eventId: "evt-foundation-1",
  occurredAt: "2026-07-18T00:00:00.000Z",
  workspaceId: "workspace-1",
  sequence: 1,
} as const

describe("domain event runtime contract", () => {
  it("binds each event kind to its producer in the type system", () => {
    expectTypeOf<
      DomainEvent<"app.runtime.changed">["producer"]
    >().toEqualTypeOf<"app">()
    expectTypeOf<
      DomainEvent<"git.checkpoint.status.changed">["producer"]
    >().toEqualTypeOf<"git">()
  })

  it.each([
    {
      producer: "app",
      kind: "app.runtime.changed",
      payload: { mode: "tauri", state: "ready" },
    },
    {
      producer: "work",
      kind: "work.workspace.lifecycle.changed",
      payload: { lifecycle: "in_progress" },
    },
    {
      producer: "code",
      kind: "code.session.status.changed",
      payload: { status: "running" },
    },
    {
      producer: "live",
      kind: "live.renderer.status.changed",
      payload: { level: "static", errorCode: "LIVE-STATIC" },
    },
    {
      producer: "hist",
      kind: "hist.writer.status.changed",
      payload: { status: "read_only", errorCode: "HIST-READ-ONLY" },
    },
    {
      producer: "git",
      kind: "git.checkpoint.status.changed",
      payload: { status: "review_ready", checkpointId: "checkpoint-1" },
    },
  ])("accepts the $kind producer contract", (event) => {
    expect(parseDomainEvent({ ...eventBase, ...event })).toMatchObject(event)
  })

  it("rejects version drift and an incorrect producer", () => {
    const event = {
      ...eventBase,
      producer: "app",
      kind: "app.runtime.changed",
      payload: { mode: "demo", state: "demo_only" },
    }

    expect(() => parseDomainEvent({ ...event, schemaVersion: 2 })).toThrow(
      "domain event contract",
    )
    expect(() => parseDomainEvent({ ...event, producer: "git" })).toThrow(
      "domain event contract",
    )
  })

  it("rejects malformed payloads and unknown fields", () => {
    const event = {
      ...eventBase,
      producer: "code",
      kind: "code.session.status.changed",
      payload: { status: "unknown" },
    }

    expect(() => parseDomainEvent(event)).toThrow("domain event contract")
    expect(() =>
      parseDomainEvent({ ...event, payload: { status: "running" }, raw: true }),
    ).toThrow("domain event contract")
  })
})
