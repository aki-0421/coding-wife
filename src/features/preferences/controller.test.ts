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
  initial = snapshot(0, "en")

  get(): Promise<AppPreferencesSnapshotV1> {
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
    return Promise.resolve(snapshot(request.expectedVersion + 1, "ja"))
  }
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

  it("keeps the last native snapshot and returns a safe code on save failure", async () => {
    const gateway = new ControlledGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    const update = controller.update({ locale: "ja" })
    await flushMicrotasks()
    gateway.updateResults[0]?.reject(
      new AppPreferencesBoundaryError({
        code: "APP-PREFERENCES-WRITE",
        operation: "app_preferences_update",
        recoverable: true,
        userMessageKey: "preferences.error.generic",
        detailRef: "app-preferences-v1",
      }),
    )

    await expect(update).resolves.toBe(false)
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      errorCode: "APP-PREFERENCES-WRITE",
      snapshot: { preferences: { locale: "en", version: 0 } },
      pendingPreferences: null,
    })
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
      locale: "ja",
      reducedMotion: "system",
      characterVisibility: "visible",
    })
  })
})
