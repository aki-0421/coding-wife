import { describe, expect, it, vi } from "vitest"

import {
  NativeReadinessController,
  type DiagnosticsClipboard,
} from "@/features/readiness/controller"
import {
  readinessCheckIds,
  type NativeReadinessSnapshotV1,
} from "@/features/readiness/contracts"
import type { NativeReadinessGateway } from "@/features/readiness/transport"

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept
    reject = deny
  })
  return { promise, resolve, reject }
}

function snapshot(sequence: number): NativeReadinessSnapshotV1 {
  const checkedAt = `2026-07-18T00:00:0${sequence}.000Z`
  return {
    schemaVersion: 1,
    snapshotId: `123e4567-e89b-42d3-a456-${String(sequence).padStart(12, "0")}`,
    checkedAt,
    source: "native",
    checks: readinessCheckIds.map((id) => ({
      id,
      status: "ready",
      checkedAt,
      code: `READINESS-${id.toUpperCase().replace("_", "-")}-READY`,
      recoverable: false,
      recoveryAction: "none",
      facts: [],
    })),
  }
}

class ControlledGateway implements NativeReadinessGateway {
  readonly kind = "native" as const
  readonly runs: Deferred<NativeReadinessSnapshotV1>[] = []

  run(): Promise<NativeReadinessSnapshotV1> {
    const result = deferred<NativeReadinessSnapshotV1>()
    this.runs.push(result)
    return result.promise
  }

  copy(snapshotId: string) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      snapshotId,
      summary: "Coding Wife diagnostics v1\nsource=native\n",
    })
  }
}

describe("NativeReadinessController", () => {
  it("retains the previous atomic snapshot while rechecking", async () => {
    const gateway = new ControlledGateway()
    const controller = new NativeReadinessController(gateway)
    const initial = controller.initialize()
    gateway.runs[0]!.resolve(snapshot(1))
    await expect(initial).resolves.toBe(true)

    const recheck = controller.recheck()
    expect(controller.getSnapshot()).toMatchObject({
      status: "rechecking",
      snapshot: { snapshotId: snapshot(1).snapshotId },
    })
    gateway.runs[1]!.resolve(snapshot(2))
    await expect(recheck).resolves.toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: { snapshotId: snapshot(2).snapshotId },
    })
  })

  it("keeps the last snapshot and publishes only a stable code on failure", async () => {
    const gateway = new ControlledGateway()
    const controller = new NativeReadinessController(gateway)
    const initial = controller.initialize()
    gateway.runs[0]!.resolve(snapshot(1))
    await initial

    const recheck = controller.recheck()
    gateway.runs[1]!.reject(new Error("/Users/private raw stderr token=secret"))
    await expect(recheck).resolves.toBe(false)
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      errorCode: "READINESS-IPC-UNAVAILABLE",
      snapshot: { snapshotId: snapshot(1).snapshotId },
    })
  })

  it("copies only the gateway-provided sanitized summary", async () => {
    const gateway = new ControlledGateway()
    const writeText = vi.fn()
    const clipboard: DiagnosticsClipboard = { writeText }
    const controller = new NativeReadinessController(gateway, clipboard)
    const initial = controller.initialize()
    gateway.runs[0]!.resolve(snapshot(1))
    await initial

    await expect(controller.copy()).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith(
      "Coding Wife diagnostics v1\nsource=native\n",
    )
    expect(controller.getSnapshot().copyStatus).toBe("copied")
  })
})
