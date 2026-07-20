import { describe, expect, it, vi } from "vitest"

import {
  CharacterRuntimeStatusStore,
  projectCharacterRuntime,
} from "@/features/character"
import type { CharacterControllerStatus } from "@/features/character/model"

function status(
  overrides: Partial<CharacterControllerStatus> = {},
): CharacterControllerStatus {
  return {
    phase: "ready",
    state: "idle",
    motionPolicy: "animated",
    fallbackLevel: "animated",
    error: null,
    pack: null,
    ...overrides,
  }
}

describe("CharacterRuntimeStatusStore", () => {
  it("isolates workspaces and rejects stale generations", () => {
    const store = new CharacterRuntimeStatusStore("builtin_hiyori")
    const oldSession = store.createSession("workspace-a", 1)
    const otherSession = store.createSession("workspace-b", 1)
    const currentSession = store.createSession("workspace-a", 2)
    const retry = vi.fn()

    store.report(oldSession, status({ phase: "loading" }), retry)
    store.report(otherSession, status({ motionPolicy: "reduced" }), retry)
    store.report(currentSession, status({ state: "reviewing" }), retry)
    store.report(oldSession, status({ phase: "error" }), retry)
    store.unmount(oldSession)

    expect(store.getSnapshot("workspace-a")).toMatchObject({
      generation: 2,
      mounted: true,
      status: { phase: "ready", state: "reviewing" },
    })
    expect(store.getSnapshot("workspace-b")).toMatchObject({
      generation: 1,
      mounted: true,
      status: { motionPolicy: "reduced" },
    })
  })

  it("closes unmounted sessions without accepting late status", () => {
    const store = new CharacterRuntimeStatusStore("builtin_hiyori")
    const session = store.createSession("workspace-a", 1)
    const retry = vi.fn()
    store.report(session, status(), retry)
    store.unmount(session)
    store.report(session, status({ phase: "error" }), retry)

    expect(store.getSnapshot("workspace-a")).toMatchObject({
      mounted: false,
      status: { phase: "ready" },
      lastErrorCode: null,
    })
  })

  it("retains a safe error code and exposes one retry for a recoverable error", () => {
    const store = new CharacterRuntimeStatusStore("builtin_hiyori")
    const session = store.createSession("workspace-a", 1)
    const retry = vi.fn()
    store.report(
      session,
      status({
        phase: "error",
        fallbackLevel: "text_only",
        error: {
          code: "asset_fetch_failed",
          message: "unsafe implementation detail",
          recoverable: true,
        },
      }),
      retry,
    )

    expect(store.getSnapshot("workspace-a")).toMatchObject({
      canRetry: true,
      lastErrorCode: "asset_fetch_failed",
    })
    expect(store.retry("workspace-a")).toBe(true)
    expect(store.retry("workspace-a")).toBe(false)
    expect(retry).toHaveBeenCalledOnce()

    const recovered = store.createSession("workspace-a", 1)
    store.report(recovered, status(), retry)
    expect(store.getSnapshot("workspace-a").lastErrorCode).toBe(
      "asset_fetch_failed",
    )
  })

  it("does not claim built-in status for an external renderer", () => {
    const store = new CharacterRuntimeStatusStore("external")
    const session = store.createSession("workspace-a", 1)
    store.report(session, status(), vi.fn())

    expect(
      projectCharacterRuntime(store.getSnapshot("workspace-a")),
    ).toMatchObject({
      rendererKind: "external",
      phase: "unknown",
      fallback: "unknown",
      motionPolicy: "unknown",
      readiness: "unknown",
      pack: null,
    })
  })

  it("projects reduced motion without marking inactive tabs stale", () => {
    const store = new CharacterRuntimeStatusStore("builtin_hiyori")
    const session = store.createSession("workspace-a", 1)
    store.report(
      session,
      status({ motionPolicy: "reduced", fallbackLevel: "reduced" }),
      vi.fn(),
    )

    expect(
      projectCharacterRuntime(store.getSnapshot("workspace-a")),
    ).toMatchObject({
      phase: "ready",
      fallback: "reduced",
      motionPolicy: "reduced",
      readiness: "ready",
    })
    expect(store.getSnapshot("workspace-a").mounted).toBe(true)
  })
})
