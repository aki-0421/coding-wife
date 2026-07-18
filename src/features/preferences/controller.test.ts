import { describe, expect, it, vi } from "vitest"

import { AppPreferencesController } from "@/features/preferences/controller"
import type {
  AppLocale,
  AppPreferencesResetRequestV1,
  AppPreferencesSnapshotV1,
  AppPreferencesUpdateRequestV1,
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
  overrides: Partial<AppPreferencesSnapshotV1["preferences"]> = {},
): AppPreferencesSnapshotV1 {
  return {
    schemaVersion: 1,
    preferences: {
      schemaVersion: 1,
      version,
      snapshotId: `123e4567-e89b-42d3-a456-${String(version + 1).padStart(12, "0")}`,
      locale,
      reducedMotion: "system",
      characterVisibility: "visible",
      ...overrides,
    },
    persistence: "native",
    recoveryCode: null,
  }
}

class ControlledGateway implements AppPreferencesGateway {
  readonly kind = "native" as const
  readonly updates: AppPreferencesUpdateRequestV1[] = []
  readonly updateResults: Deferred<AppPreferencesSnapshotV1>[] = []
  readonly resets: AppPreferencesResetRequestV1[] = []
  getCalls = 0
  getImplementation: (() => Promise<AppPreferencesSnapshotV1>) | null = null
  resetImplementation:
    | ((
        request: AppPreferencesResetRequestV1,
      ) => Promise<AppPreferencesSnapshotV1>)
    | null = null
  initial = snapshot(0, "en")

  get(): Promise<AppPreferencesSnapshotV1> {
    this.getCalls += 1
    if (this.getImplementation !== null) return this.getImplementation()
    return Promise.resolve(this.initial)
  }

  update(
    request: AppPreferencesUpdateRequestV1,
  ): Promise<AppPreferencesSnapshotV1> {
    this.updates.push(request)
    const result = deferred<AppPreferencesSnapshotV1>()
    this.updateResults.push(result)
    return result.promise
  }

  reset(
    request: AppPreferencesResetRequestV1,
  ): Promise<AppPreferencesSnapshotV1> {
    this.resets.push(request)
    if (this.resetImplementation !== null) {
      return this.resetImplementation(request)
    }
    return Promise.resolve(
      snapshot(request.expectedVersion + 1, request.defaultLocale),
    )
  }
}

function boundaryError(code: string): AppPreferencesBoundaryError {
  return new AppPreferencesBoundaryError({
    code,
    operation: "app_preferences_update",
    recoverable: true,
    userMessageKey: "preferences.error.generic",
    detailRef: "app-preferences-v1",
  })
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe("AppPreferencesController", () => {
  it("never publishes a late locale response after a newer locale intent", async () => {
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
    expect(gateway.updates).toHaveLength(1)
    expect(controller.getSnapshot()).toMatchObject({
      status: "saving",
      snapshot: { preferences: { locale: "en" } },
      pendingPreferences: { locale: "ja" },
    })

    const second = controller.update({ locale: "en" })
    gateway.updateResults[0]?.resolve(snapshot(1, "ja"))
    await vi.waitFor(() => expect(gateway.updates).toHaveLength(2))

    expect(controller.getSnapshot().snapshot.preferences.locale).toBe("en")
    expect(publishedLocales).not.toContain("ja")
    expect(gateway.updates[1]).toMatchObject({
      expectedVersion: 1,
      locale: "en",
    })

    gateway.updateResults[1]?.resolve(snapshot(2, "en"))
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: { preferences: { version: 2, locale: "en" } },
    })
  })

  it("serializes patches so global preferences remain one coherent snapshot", async () => {
    const gateway = new ControlledGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()

    const motion = controller.update({ reducedMotion: "on" })
    const visibility = controller.update({ characterVisibility: "hidden" })
    await flushMicrotasks()
    expect(gateway.updates).toHaveLength(1)
    expect(gateway.updates[0]).toMatchObject({
      expectedVersion: 0,
      reducedMotion: "on",
      characterVisibility: "hidden",
    })
    gateway.updateResults[0]?.resolve(
      snapshot(1, "en", {
        reducedMotion: "on",
        characterVisibility: "hidden",
      }),
    )
    await expect(Promise.all([motion, visibility])).resolves.toEqual([
      true,
      true,
    ])
    expect(controller.getSnapshot().snapshot.preferences).toMatchObject({
      reducedMotion: "on",
      characterVisibility: "hidden",
    })
  })

  it("writes only the latest follow-up after an in-flight A to B to A change", async () => {
    const gateway = new ControlledGateway()
    gateway.initial = snapshot(0, "ja")
    const controller = new AppPreferencesController(gateway, "ja")
    await controller.initialize()

    const toEnglish = controller.update({ locale: "en" })
    await flushMicrotasks()
    expect(gateway.updates).toHaveLength(1)

    const backToJapanese = controller.update({ locale: "ja" })
    expect(controller.getSnapshot()).toMatchObject({
      status: "saving",
      snapshot: { preferences: { locale: "ja", version: 0 } },
      pendingPreferences: { locale: "ja" },
    })

    gateway.updateResults[0]?.resolve(snapshot(1, "en"))
    await vi.waitFor(() => expect(gateway.updates).toHaveLength(2))
    expect(controller.getSnapshot().snapshot.preferences).toMatchObject({
      locale: "ja",
      version: 0,
    })
    expect(gateway.updates[1]).toMatchObject({
      expectedVersion: 1,
      locale: "ja",
    })

    gateway.updateResults[1]?.resolve(snapshot(2, "ja"))
    await expect(Promise.all([toEnglish, backToJapanese])).resolves.toEqual([
      true,
      true,
    ])
    expect(gateway.updates).toHaveLength(2)
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: { preferences: { locale: "ja", version: 2 } },
      pendingPreferences: null,
    })
  })

  it("keeps the newest intent when an older in-flight write fails", async () => {
    const gateway = new ControlledGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()

    const stale = controller.update({ locale: "ja" })
    await flushMicrotasks()
    const latest = controller.update({ locale: "en", reducedMotion: "on" })
    gateway.updateResults[0]?.reject(
      new AppPreferencesBoundaryError({
        code: "APP-PREFERENCES-WRITE",
        operation: "app_preferences_update",
        recoverable: true,
        userMessageKey: "preferences.error.generic",
        detailRef: "app-preferences-v1",
      }),
    )

    await vi.waitFor(() => expect(gateway.updates).toHaveLength(2))
    expect(controller.getSnapshot()).toMatchObject({
      status: "saving",
      snapshot: { preferences: { locale: "en", reducedMotion: "system" } },
      pendingPreferences: { locale: "en", reducedMotion: "on" },
      errorCode: null,
    })
    expect(gateway.updates[1]).toMatchObject({
      expectedVersion: 0,
      locale: "en",
      reducedMotion: "on",
    })

    gateway.updateResults[1]?.resolve(
      snapshot(1, "en", { reducedMotion: "on" }),
    )
    await expect(Promise.all([stale, latest])).resolves.toEqual([true, true])
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: { preferences: { locale: "en", reducedMotion: "on" } },
      pendingPreferences: null,
    })
  })

  it("treats a rejected response as success when the durable write committed", async () => {
    const gateway = new ControlledGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()

    const update = controller.update({ locale: "ja" })
    await vi.waitFor(() => expect(gateway.updates).toHaveLength(1))
    gateway.initial = snapshot(1, "ja")
    gateway.updateResults[0]?.reject(boundaryError("APP-PREFERENCES-WRITE"))

    await expect(update).resolves.toBe(true)
    expect(gateway.getCalls).toBe(2)
    expect(gateway.updates).toHaveLength(1)
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: { preferences: { version: 1, locale: "ja" } },
      pendingPreferences: null,
      errorCode: null,
    })
  })

  it("rebases the latest intent onto a fresh durable conflict version", async () => {
    const gateway = new ControlledGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()

    const update = controller.update({ locale: "ja" })
    await vi.waitFor(() => expect(gateway.updates).toHaveLength(1))
    gateway.initial = snapshot(4, "en", {
      reducedMotion: "on",
      characterVisibility: "hidden",
    })
    gateway.updateResults[0]?.reject(boundaryError("APP-PREFERENCES-CONFLICT"))

    await vi.waitFor(() => expect(gateway.updates).toHaveLength(2))
    expect(gateway.updates[1]).toMatchObject({
      expectedVersion: 4,
      locale: "ja",
      reducedMotion: "on",
      characterVisibility: "hidden",
    })
    gateway.updateResults[1]?.resolve(
      snapshot(5, "ja", {
        reducedMotion: "on",
        characterVisibility: "hidden",
      }),
    )

    await expect(update).resolves.toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: {
        preferences: {
          version: 5,
          locale: "ja",
          reducedMotion: "on",
          characterVisibility: "hidden",
        },
      },
    })
  })

  it("reconciles a stale success response before writing the latest intent", async () => {
    const gateway = new ControlledGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()

    const update = controller.update({ locale: "ja" })
    await vi.waitFor(() => expect(gateway.updates).toHaveLength(1))
    gateway.initial = snapshot(7, "en", { reducedMotion: "on" })
    gateway.updateResults[0]?.resolve(snapshot(2, "ja"))

    await vi.waitFor(() => expect(gateway.updates).toHaveLength(2))
    expect(gateway.updates[1]).toMatchObject({
      expectedVersion: 7,
      locale: "ja",
      reducedMotion: "on",
    })
    gateway.updateResults[1]?.resolve(
      snapshot(8, "ja", { reducedMotion: "on" }),
    )
    await expect(update).resolves.toBe(true)
  })

  it("surfaces a safe read error and retries the intent on a fresh version", async () => {
    const gateway = new ControlledGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    gateway.getImplementation = () =>
      Promise.reject(boundaryError("APP-PREFERENCES-READ"))

    const update = controller.update({ locale: "ja" })
    await vi.waitFor(() => expect(gateway.updates).toHaveLength(1))
    gateway.updateResults[0]?.reject(boundaryError("APP-PREFERENCES-WRITE"))

    await expect(update).resolves.toBe(false)
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      snapshot: { preferences: { version: 0, locale: "en" } },
      pendingPreferences: null,
      errorCode: "APP-PREFERENCES-READ",
    })

    gateway.initial = snapshot(5, "en", { reducedMotion: "on" })
    gateway.getImplementation = null
    const retry = controller.retry()
    await vi.waitFor(() => expect(gateway.updates).toHaveLength(2))
    expect(gateway.updates[1]).toMatchObject({
      expectedVersion: 5,
      locale: "ja",
      reducedMotion: "on",
    })
    gateway.updateResults[1]?.resolve(
      snapshot(6, "ja", { reducedMotion: "on" }),
    )
    await expect(retry).resolves.toBe(true)
  })

  it("keeps the last native snapshot and returns a safe code on save failure", async () => {
    const gateway = new ControlledGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    const update = controller.update({ locale: "ja" })
    await flushMicrotasks()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.waitFor(() => expect(gateway.updates).toHaveLength(attempt + 1))
      gateway.updateResults[attempt]?.reject(
        boundaryError("APP-PREFERENCES-WRITE"),
      )
    }

    await expect(update).resolves.toBe(false)
    expect(gateway.getCalls).toBe(4)
    expect(gateway.updates).toHaveLength(3)
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      errorCode: "APP-PREFERENCES-WRITE",
      snapshot: { preferences: { locale: "en", version: 0 } },
      pendingPreferences: null,
    })
  })

  it("stops publishing and retrying when disposed during reconciliation", async () => {
    const gateway = new ControlledGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    const durableRead = deferred<AppPreferencesSnapshotV1>()
    gateway.getImplementation = () => durableRead.promise
    const listener = vi.fn()
    controller.subscribe(listener)

    const update = controller.update({ locale: "ja" })
    await vi.waitFor(() => expect(gateway.updates).toHaveLength(1))
    gateway.updateResults[0]?.reject(boundaryError("APP-PREFERENCES-CONFLICT"))
    await vi.waitFor(() => expect(gateway.getCalls).toBe(2))
    const publicationsBeforeDispose = listener.mock.calls.length
    controller.dispose()
    durableRead.resolve(snapshot(3, "en"))

    await expect(update).resolves.toBe(false)
    expect(listener).toHaveBeenCalledTimes(publicationsBeforeDispose)
    expect(gateway.updates).toHaveLength(1)
  })

  it("resets the preference record to OS locale, system motion, and visible", async () => {
    const gateway = new ControlledGateway()
    gateway.initial = snapshot(7, "en", {
      reducedMotion: "on",
      characterVisibility: "hidden",
    })
    const controller = new AppPreferencesController(gateway, "ja")
    await controller.initialize()

    await expect(controller.reset()).resolves.toBe(true)
    expect(gateway.resets).toEqual([
      { schemaVersion: 1, expectedVersion: 7, defaultLocale: "ja" },
    ])
    expect(controller.getSnapshot().snapshot.preferences).toMatchObject({
      version: 8,
      locale: "ja",
      reducedMotion: "system",
      characterVisibility: "visible",
    })
  })

  it("supersedes an update that has not reached the native writer with one reset", async () => {
    const gateway = new ControlledGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()

    const update = controller.update({ locale: "ja", reducedMotion: "on" })
    const reset = controller.reset()

    await expect(Promise.all([update, reset])).resolves.toEqual([true, true])
    expect(gateway.updates).toHaveLength(0)
    expect(gateway.resets).toEqual([
      { schemaVersion: 1, expectedVersion: 0, defaultLocale: "en" },
    ])
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: {
        preferences: {
          version: 1,
          locale: "en",
          reducedMotion: "system",
        },
      },
    })
  })

  it("finishes one in-flight update before issuing exactly one reset", async () => {
    const gateway = new ControlledGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()

    const update = controller.update({ locale: "ja" })
    await vi.waitFor(() => expect(gateway.updates).toHaveLength(1))
    const reset = controller.reset()
    await flushMicrotasks()
    expect(gateway.resets).toHaveLength(0)

    gateway.updateResults[0]?.resolve(snapshot(1, "ja"))
    await vi.waitFor(() => expect(gateway.resets).toHaveLength(1))
    expect(gateway.resets[0]).toEqual({
      schemaVersion: 1,
      expectedVersion: 1,
      defaultLocale: "en",
    })

    await expect(Promise.all([update, reset])).resolves.toEqual([true, true])
    expect(gateway.updates).toHaveLength(1)
    expect(gateway.resets).toHaveLength(1)
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: { preferences: { version: 2, locale: "en" } },
    })
  })

  it("writes only the latest intent after an in-flight reset", async () => {
    const gateway = new ControlledGateway()
    const resetResult = deferred<AppPreferencesSnapshotV1>()
    gateway.resetImplementation = () => resetResult.promise
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()

    const reset = controller.reset()
    await vi.waitFor(() => expect(gateway.resets).toHaveLength(1))
    const locale = controller.update({ locale: "ja" })
    const motion = controller.update({ reducedMotion: "on" })
    expect(controller.getSnapshot()).toMatchObject({
      status: "saving",
      pendingPreferences: { locale: "ja", reducedMotion: "on" },
    })
    expect(gateway.updates).toHaveLength(0)

    resetResult.resolve(snapshot(1, "en"))
    await expect(reset).resolves.toBe(true)
    await vi.waitFor(() => expect(gateway.updates).toHaveLength(1))
    expect(gateway.updates[0]).toMatchObject({
      expectedVersion: 1,
      locale: "ja",
      reducedMotion: "on",
      characterVisibility: "visible",
    })
    gateway.updateResults[0]?.resolve(
      snapshot(2, "ja", { reducedMotion: "on" }),
    )

    await expect(Promise.all([locale, motion])).resolves.toEqual([true, true])
    expect(gateway.resets).toHaveLength(1)
    expect(gateway.updates).toHaveLength(1)
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: {
        preferences: { version: 2, locale: "ja", reducedMotion: "on" },
      },
    })
  })

  it("reconciles a reset whose committed response was lost", async () => {
    const gateway = new ControlledGateway()
    gateway.initial = snapshot(6, "ja", { reducedMotion: "on" })
    gateway.resetImplementation = () =>
      Promise.reject(boundaryError("APP-PREFERENCES-WRITE"))
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()

    gateway.initial = snapshot(7, "en")
    await expect(controller.reset()).resolves.toBe(true)

    expect(gateway.resets).toHaveLength(1)
    expect(gateway.getCalls).toBe(2)
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: { preferences: { version: 7, locale: "en" } },
      pendingPreferences: null,
      errorCode: null,
    })
  })

  it("rebases a conflicted reset onto the durable version exactly once", async () => {
    const gateway = new ControlledGateway()
    gateway.initial = snapshot(2, "ja", { reducedMotion: "on" })
    gateway.resetImplementation = (request) => {
      if (gateway.resets.length === 1) {
        return Promise.reject(boundaryError("APP-PREFERENCES-CONFLICT"))
      }
      return Promise.resolve(snapshot(request.expectedVersion + 1, "en"))
    }
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    gateway.initial = snapshot(9, "ja", { characterVisibility: "hidden" })

    await expect(controller.reset()).resolves.toBe(true)
    expect(gateway.resets).toEqual([
      { schemaVersion: 1, expectedVersion: 2, defaultLocale: "en" },
      { schemaVersion: 1, expectedVersion: 9, defaultLocale: "en" },
    ])
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: { preferences: { version: 10, locale: "en" } },
    })
  })

  it("bounds reset reconciliation and preserves the last durable version", async () => {
    const gateway = new ControlledGateway()
    gateway.initial = snapshot(4, "ja", { reducedMotion: "on" })
    gateway.resetImplementation = () =>
      Promise.reject(boundaryError("APP-PREFERENCES-WRITE"))
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()

    await expect(controller.reset()).resolves.toBe(false)
    expect(gateway.resets).toHaveLength(3)
    expect(gateway.getCalls).toBe(4)
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      errorCode: "APP-PREFERENCES-WRITE",
      snapshot: { preferences: { version: 4, locale: "ja" } },
      pendingPreferences: null,
    })
  })
})
