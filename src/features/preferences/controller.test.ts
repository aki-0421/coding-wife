import { describe, expect, it, vi } from "vitest"

import { AppPreferencesController } from "@/features/preferences/controller"
import type {
  AppLocale,
  AppPreferencesSnapshotV2,
  AppPreferencesUpdateRequestV2,
} from "@/features/preferences/contracts"
import {
  AppPreferencesBoundaryError,
  type AppPreferencesGateway,
} from "@/features/preferences/transport"

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

function snapshot(
  version: number,
  locale: AppLocale,
): AppPreferencesSnapshotV2 {
  return {
    schemaVersion: 2,
    preferences: {
      schemaVersion: 2,
      version,
      snapshotId: `123e4567-e89b-42d3-a456-${String(version + 1).padStart(12, "0")}`,
      locale,
    },
    persistence: "native",
    recoveryCode: null,
  }
}

class ControlledGateway implements AppPreferencesGateway {
  readonly kind = "native" as const
  readonly updates: AppPreferencesUpdateRequestV2[] = []
  readonly updateResults: Deferred<AppPreferencesSnapshotV2>[] = []
  getCalls = 0
  durable = snapshot(0, "en")

  get(): Promise<AppPreferencesSnapshotV2> {
    this.getCalls += 1
    return Promise.resolve(this.durable)
  }

  update(
    request: AppPreferencesUpdateRequestV2,
  ): Promise<AppPreferencesSnapshotV2> {
    this.updates.push(request)
    const result = deferred<AppPreferencesSnapshotV2>()
    this.updateResults.push(result)
    return result.promise
  }
}

function boundaryError(code = "APP-PREFERENCES-WRITE") {
  return new AppPreferencesBoundaryError({
    code,
    operation: "app_preferences_update",
    recoverable: true,
    userMessageKey: "preferences.error.generic",
    detailRef: "app-preferences-v2",
  })
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe("AppPreferencesController", () => {
  it("persists the current locale to repair a recovery snapshot", async () => {
    const gateway = new ControlledGateway()
    gateway.durable = {
      schemaVersion: 2,
      preferences: {
        schemaVersion: 2,
        version: 0,
        snapshotId: "00000000-0000-0000-0000-000000000000",
        locale: "en",
      },
      persistence: "native",
      recoveryCode: "APP-PREFERENCES-MISSING",
    }
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()

    const repaired = controller.update({ locale: "en" })
    await vi.waitFor(() => expect(gateway.updates).toHaveLength(1))
    expect(gateway.updates[0]).toEqual({
      schemaVersion: 2,
      expectedVersion: 0,
      locale: "en",
    })

    gateway.durable = snapshot(1, "en")
    gateway.updateResults[0]?.resolve(gateway.durable)
    await expect(repaired).resolves.toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: { preferences: { version: 1, locale: "en" } },
      errorCode: null,
    })
  })

  it("never publishes a late locale response after a newer intent", async () => {
    const gateway = new ControlledGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    const publishedLocales: AppLocale[] = []
    controller.subscribe(() => {
      const state = controller.getSnapshot()
      if (state.status !== "saving") {
        publishedLocales.push(state.snapshot.preferences.locale)
      }
    })

    const first = controller.update({ locale: "ja" })
    await flushMicrotasks()
    const second = controller.update({ locale: "en" })
    gateway.durable = snapshot(1, "ja")
    gateway.updateResults[0]?.resolve(gateway.durable)

    await vi.waitFor(() => expect(gateway.updates).toHaveLength(2))
    expect(publishedLocales).not.toContain("ja")
    expect(gateway.updates[1]).toEqual({
      schemaVersion: 2,
      expectedVersion: 1,
      locale: "en",
    })

    gateway.durable = snapshot(2, "en")
    gateway.updateResults[1]?.resolve(gateway.durable)
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: { preferences: { version: 2, locale: "en" } },
      pendingPreferences: null,
    })
  })

  it("accepts an ambiguous response when a fresh read confirms the write", async () => {
    const gateway = new ControlledGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()

    const update = controller.update({ locale: "ja" })
    await vi.waitFor(() => expect(gateway.updates).toHaveLength(1))
    gateway.durable = snapshot(1, "ja")
    gateway.updateResults[0]?.reject(boundaryError())

    await expect(update).resolves.toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: { preferences: { version: 1, locale: "ja" } },
    })
  })

  it("bounds failed writes and retries the latest locale intent", async () => {
    const gateway = new ControlledGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()

    const failed = controller.update({ locale: "ja" })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.waitFor(() => expect(gateway.updates).toHaveLength(attempt + 1))
      gateway.updateResults[attempt]?.reject(boundaryError())
    }
    await expect(failed).resolves.toBe(false)
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      snapshot: { preferences: { locale: "en" } },
      errorCode: "APP-PREFERENCES-WRITE",
    })

    const retried = controller.retry()
    await vi.waitFor(() => expect(gateway.updates).toHaveLength(4))
    gateway.durable = snapshot(1, "ja")
    gateway.updateResults[3]?.resolve(gateway.durable)
    await expect(retried).resolves.toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: { preferences: { locale: "ja" } },
      errorCode: null,
    })
  })

  it("ignores late results after disposal", async () => {
    const gateway = new ControlledGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    const update = controller.update({ locale: "ja" })
    await vi.waitFor(() => expect(gateway.updates).toHaveLength(1))
    controller.dispose()
    gateway.updateResults[0]?.resolve(snapshot(1, "ja"))

    await expect(update).resolves.toBe(false)
    expect(controller.getSnapshot().snapshot.preferences.locale).toBe("en")
  })
})
