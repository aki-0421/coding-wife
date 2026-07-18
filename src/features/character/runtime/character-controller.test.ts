import { waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  CharacterError,
  type CharacterControllerStatus,
  type CharacterFrameMetrics,
  type CharacterPackManifest,
  type CharacterPackRef,
} from "@/features/character/model"

const runtimeHarness = vi.hoisted(() => ({
  acquireRuntime: vi.fn(() => Promise.resolve()),
  createModel: vi.fn(),
  drawnPackId: null as string | null,
  loadClient: vi.fn(),
  models: new Map<string, FakeCharacterModel>(),
  renderBehaviors: new Map<string, "visible" | "transparent" | "throw">(),
}))

vi.mock("@/features/character/runtime/character-pack-client", () => ({
  CharacterPackClient: { load: runtimeHarness.loadClient },
}))

vi.mock("@/features/character/runtime/cubism-runtime", () => ({
  acquireCubismRuntime: runtimeHarness.acquireRuntime,
}))

vi.mock("@/features/character/runtime/cubism-character-model", () => ({
  CubismCharacterModel: { create: runtimeHarness.createModel },
  resetCubismWebGlResources: vi.fn(),
}))

import {
  CharacterController,
  computeCharacterBackingSize,
} from "@/features/character/runtime/character-controller"

class FakeCharacterModel {
  public readonly inventory = {
    parameterCount: 1,
    partCount: 1,
    drawableCount: 1,
    textureDecodeCount: 1,
  }
  public readonly release = vi.fn()
  public readonly resetToNeutral = vi.fn()
  public readonly resize = vi.fn()
  public readonly update = vi.fn()

  public constructor(public readonly packId: string) {}

  public readonly draw = vi.fn(() => {
    runtimeHarness.drawnPackId = this.packId
    if (runtimeHarness.renderBehaviors.get(this.packId) === "throw") {
      throw new CharacterError(
        "shader_load_failed",
        `Renderer failed for ${this.packId}`,
      )
    }
  })
}

function manifest(packId: string): CharacterPackManifest {
  return {
    schemaVersion: 1,
    packId,
    displayName: packId,
    bundledVersion: "test",
    entrypoint: "model.model3.json",
    immutable: true,
    provenance: {
      sourceKind: "user_imported",
      sourceLabel: "Local folder",
      importedAt: "2026-07-18T00:00:00.000Z",
    },
    inventory: {
      runtimeFileCount: 0,
      totalBytes: 0,
      textureCount: 0,
      motionCount: 0,
      expressionCount: 0,
      motionGroups: {},
    },
    compatibility: {
      modelSchemaVersion: 3,
      mocVersion: 3,
      expectedParameters: 1,
      expectedParts: 1,
      expectedDrawables: 1,
    },
    files: [],
    importedAt: "2026-07-18T00:00:00.000Z",
  }
}

function pack(packId: string): CharacterPackRef {
  return {
    kind: "memory",
    manifest: manifest(packId),
    assets: new Map(),
  }
}

function bounds(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => ({ width, height }),
  }
}

interface AnimationFrameHarness {
  readonly count: number
  flush(): void
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function installAnimationFrames(): AnimationFrameHarness {
  let nextId = 0
  let timestamp = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextId
    callbacks.set(id, callback)
    return id
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    callbacks.delete(id)
  })
  return {
    get count() {
      return callbacks.size
    },
    flush() {
      const pending = [...callbacks.entries()]
      callbacks.clear()
      timestamp += 16
      for (const [, callback] of pending) callback(timestamp)
    },
  }
}

function createWebGlContext(): WebGLRenderingContext {
  return {
    COLOR_BUFFER_BIT: 0x4000,
    RGBA: 0x1908,
    SCISSOR_TEST: 0x0c11,
    STENCIL_BUFFER_BIT: 0x0400,
    UNSIGNED_BYTE: 0x1401,
    clear: vi.fn(),
    clearColor: vi.fn(),
    colorMask: vi.fn(),
    disable: vi.fn(),
    flush: vi.fn(),
    getError: vi.fn(() => 0),
    getExtension: vi.fn(() => null),
    isContextLost: vi.fn(() => false),
    readPixels: vi.fn(
      (
        _x: number,
        _y: number,
        _width: number,
        _height: number,
        _format: number,
        _type: number,
        pixels: Uint8Array,
      ) => {
        const visible =
          runtimeHarness.drawnPackId !== null &&
          runtimeHarness.renderBehaviors.get(runtimeHarness.drawnPackId) !==
            "transparent"
        pixels.fill(visible ? 0xff : 0)
      },
    ),
    viewport: vi.fn(),
  } as unknown as WebGLRenderingContext
}

const controllers: CharacterController[] = []
let animationFrames: AnimationFrameHarness

async function createMountedController(): Promise<{
  canvas: HTMLCanvasElement
  controller: CharacterController
  metrics: CharacterFrameMetrics[]
  statuses: CharacterControllerStatus[]
}> {
  const statuses: CharacterControllerStatus[] = []
  const metrics: CharacterFrameMetrics[] = []
  const controller = new CharacterController({
    callbacks: {
      onMetrics: (nextMetrics) => metrics.push(nextMetrics),
      onStatus: (status) => statuses.push(status),
    },
  })
  controllers.push(controller)
  controller.setMotionPolicy("reduced")
  const canvas = document.createElement("canvas")
  vi.spyOn(canvas, "getContext").mockImplementation(() => createWebGlContext())
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(bounds(608, 755))
  vi.spyOn(canvas, "toDataURL").mockReturnValue(
    "data:image/png;base64,Y2FuZGlkYXRl",
  )
  await controller.mount(canvas)
  return { canvas, controller, metrics, statuses }
}

async function flushCandidateFrame(): Promise<void> {
  await waitFor(() => expect(animationFrames.count).toBeGreaterThan(0))
  animationFrames.flush()
  await Promise.resolve()
}

beforeEach(() => {
  runtimeHarness.drawnPackId = null
  runtimeHarness.models.clear()
  runtimeHarness.renderBehaviors.clear()
  runtimeHarness.acquireRuntime.mockClear()
  runtimeHarness.loadClient.mockReset()
  runtimeHarness.loadClient.mockImplementation(
    (packRef: CharacterPackRef, signal: AbortSignal) => {
      if (signal.aborted) {
        return Promise.reject(
          new CharacterError("disposed", "Character load was canceled"),
        )
      }
      if (packRef.kind === "url") {
        return Promise.reject(
          new CharacterError("manifest_invalid", "Unexpected URL test pack"),
        )
      }
      return Promise.resolve({ manifest: packRef.manifest })
    },
  )
  runtimeHarness.createModel.mockReset()
  runtimeHarness.createModel.mockImplementation(
    (client: { manifest: CharacterPackManifest }) => {
      const model = new FakeCharacterModel(client.manifest.packId)
      runtimeHarness.models.set(client.manifest.packId, model)
      return Promise.resolve(model)
    },
  )
  animationFrames = installAnimationFrames()
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
})

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("character canvas backing size", () => {
  it("tracks CSS pixels while capping high-density displays", () => {
    expect(computeCharacterBackingSize(607.84, 754.99, 1)).toEqual({
      width: 608,
      height: 755,
      devicePixelRatio: 1,
    })
    expect(computeCharacterBackingSize(607.84, 754.99, 3)).toEqual({
      width: 1216,
      height: 1510,
      devicePixelRatio: 2,
    })
  })

  it("normalizes invalid and collapsed dimensions safely", () => {
    expect(computeCharacterBackingSize(-10, 0, Number.NaN)).toEqual({
      width: 1,
      height: 1,
      devicePixelRatio: 1,
    })
    expect(computeCharacterBackingSize(100, 50, 0.5)).toEqual({
      width: 100,
      height: 50,
      devicePixelRatio: 1,
    })
  })
})

describe("atomic character pack switching", () => {
  it("commits the candidate only after its first non-transparent frame", async () => {
    runtimeHarness.renderBehaviors.set("committed", "visible")
    const { controller, metrics, statuses } = await createMountedController()
    const initialLoad = controller.loadPack(
      pack("committed"),
      new AbortController().signal,
      true,
    )
    await flushCandidateFrame()
    await initialLoad

    const committedModel = runtimeHarness.models.get("committed")!
    const committedMetrics = controller.metrics
    const committedStatus = statuses.at(-1)
    const statusCount = statuses.length
    const metricsCount = metrics.length
    runtimeHarness.renderBehaviors.set("candidate", "transparent")
    const candidateLoad = controller.loadPack(
      pack("candidate"),
      new AbortController().signal,
      true,
    )

    await flushCandidateFrame()
    const candidateModel = runtimeHarness.models.get("candidate")!
    expect(runtimeHarness.drawnPackId).toBe("committed")
    expect(controller.metrics).toEqual(committedMetrics)
    expect(statuses).toHaveLength(statusCount)
    expect(statuses.at(-1)).toEqual(committedStatus)
    expect(metrics).toHaveLength(metricsCount)
    expect(committedModel.release).not.toHaveBeenCalled()

    runtimeHarness.renderBehaviors.set("candidate", "visible")
    await flushCandidateFrame()
    await candidateLoad

    expect(runtimeHarness.drawnPackId).toBe("candidate")
    expect(statuses.at(-1)?.pack?.packId).toBe("candidate")
    expect(statuses).toHaveLength(statusCount + 1)
    expect(metrics).toHaveLength(metricsCount + 1)
    expect(committedModel.release).toHaveBeenCalledTimes(1)
    expect(candidateModel.release).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    "keeps the committed renderer when a candidate with trusted-frame=%s fails",
    async (candidateHasTrustedFrame) => {
      runtimeHarness.renderBehaviors.set("committed", "visible")
      const { controller, metrics, statuses } = await createMountedController()
      const initialLoad = controller.loadPack(
        pack("committed"),
        new AbortController().signal,
        true,
      )
      await flushCandidateFrame()
      await initialLoad

      const committedModel = runtimeHarness.models.get("committed")!
      const committedMetrics = controller.metrics
      const committedStatus = statuses.at(-1)
      const statusCount = statuses.length
      const metricsCount = metrics.length
      runtimeHarness.renderBehaviors.set("candidate", "throw")

      const failedLoad = controller.loadPack(
        pack("candidate"),
        new AbortController().signal,
        candidateHasTrustedFrame,
      )
      await flushCandidateFrame()
      await expect(failedLoad).rejects.toMatchObject({
        code: "shader_load_failed",
      })

      const candidateModel = runtimeHarness.models.get("candidate")!
      expect(runtimeHarness.drawnPackId).toBe("committed")
      expect(controller.metrics).toEqual(committedMetrics)
      expect(statuses).toHaveLength(statusCount)
      expect(statuses.at(-1)).toEqual(committedStatus)
      expect(metrics).toHaveLength(metricsCount)
      expect(committedModel.release).not.toHaveBeenCalled()
      expect(candidateModel.release).toHaveBeenCalledTimes(1)
    },
  )

  it("restores the committed renderer and releases only an aborted candidate", async () => {
    runtimeHarness.renderBehaviors.set("committed", "visible")
    const { controller, metrics, statuses } = await createMountedController()
    const initialLoad = controller.loadPack(
      pack("committed"),
      new AbortController().signal,
      true,
    )
    await flushCandidateFrame()
    await initialLoad

    const committedModel = runtimeHarness.models.get("committed")!
    const committedMetrics = controller.metrics
    const committedStatus = statuses.at(-1)
    const statusCount = statuses.length
    const metricsCount = metrics.length
    runtimeHarness.renderBehaviors.set("candidate", "transparent")
    const abortController = new AbortController()
    const abortedLoad = controller.loadPack(
      pack("candidate"),
      abortController.signal,
      false,
    )
    await flushCandidateFrame()
    abortController.abort()
    await expect(abortedLoad).rejects.toMatchObject({ code: "disposed" })

    const candidateModel = runtimeHarness.models.get("candidate")!
    expect(runtimeHarness.drawnPackId).toBe("committed")
    expect(controller.metrics).toEqual(committedMetrics)
    expect(statuses).toHaveLength(statusCount)
    expect(statuses.at(-1)).toEqual(committedStatus)
    expect(metrics).toHaveLength(metricsCount)
    expect(committedModel.release).not.toHaveBeenCalled()
    expect(candidateModel.release).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["reduced", false],
    ["reduced", true],
    ["hidden", false],
    ["hidden", true],
  ] as const)(
    "serializes %s context restoration before a trusted-frame=%s switch",
    async (policyDuringRestore, candidateHasTrustedFrame) => {
      runtimeHarness.renderBehaviors.set("committed", "visible")
      runtimeHarness.renderBehaviors.set("candidate", "visible")
      const { canvas, controller, metrics, statuses } =
        await createMountedController()
      const initialLoad = controller.loadPack(
        pack("committed"),
        new AbortController().signal,
        true,
      )
      await flushCandidateFrame()
      await initialLoad

      const originalModel = runtimeHarness.models.get("committed")!
      const committedMetrics = controller.metrics
      if (policyDuringRestore === "hidden") {
        controller.setMotionPolicy("hidden")
      }
      const statusesBeforeLoss = statuses.length
      const metricsBeforeLoss = metrics.length
      const restoredModel = new FakeCharacterModel("committed")
      const restore = deferred<FakeCharacterModel>()
      runtimeHarness.createModel.mockImplementationOnce(
        (client: { manifest: CharacterPackManifest }) => {
          expect(client.manifest.packId).toBe("committed")
          runtimeHarness.models.set("committed:restored", restoredModel)
          return restore.promise
        },
      )

      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }))
      canvas.dispatchEvent(new Event("webglcontextrestored"))
      await waitFor(() =>
        expect(originalModel.release).toHaveBeenCalledTimes(1),
      )
      expect(statuses.at(-1)?.phase).toBe("recovering")
      expect(controller.metrics).toEqual(committedMetrics)
      expect(metrics).toHaveLength(metricsBeforeLoss)
      await waitFor(() =>
        expect(runtimeHarness.models.get("committed:restored")).toBe(
          restoredModel,
        ),
      )

      const candidateLoad = controller.loadPack(
        pack("candidate"),
        new AbortController().signal,
        candidateHasTrustedFrame,
      )
      await Promise.resolve()
      expect(
        runtimeHarness.loadClient.mock.calls.some(
          ([packRef]) =>
            (packRef as CharacterPackRef).kind !== "url" &&
            (packRef as Exclude<CharacterPackRef, { kind: "url" }>).manifest
              .packId === "candidate",
        ),
      ).toBe(false)

      restore.resolve(restoredModel)
      await Promise.resolve()
      if (policyDuringRestore === "hidden") {
        await flushCandidateFrame()
        expect(statuses.slice(statusesBeforeLoss)).not.toContainEqual(
          expect.objectContaining({ phase: "ready" }),
        )
        expect(controller.metrics).toEqual(committedMetrics)
        controller.setMotionPolicy("reduced")
      }

      await flushCandidateFrame()
      await waitFor(() =>
        expect(runtimeHarness.models.has("candidate")).toBe(true),
      )
      expect(statuses.at(-1)?.pack?.packId).toBe("committed")
      await flushCandidateFrame()
      await candidateLoad

      const candidateModel = runtimeHarness.models.get("candidate")!
      expect(runtimeHarness.drawnPackId).toBe("candidate")
      expect(statuses.at(-1)).toMatchObject({
        phase: "ready",
        pack: { packId: "candidate" },
      })
      expect(controller.metrics.nonTransparentSamples).toBeGreaterThan(0)
      expect(controller.metrics.webglError).toBe(0)
      expect(
        statuses
          .slice(statusesBeforeLoss)
          .filter((status) => status.phase === "ready")
          .map((status) => status.pack?.packId),
      ).toEqual(["committed", "candidate"])
      expect(metrics).toHaveLength(metricsBeforeLoss + 2)
      expect(originalModel.release).toHaveBeenCalledTimes(1)
      expect(restoredModel.release).toHaveBeenCalledTimes(1)
      expect(candidateModel.release).not.toHaveBeenCalled()
    },
  )

  it("keeps the recovered renderer when a serialized candidate first frame fails", async () => {
    runtimeHarness.renderBehaviors.set("committed", "visible")
    runtimeHarness.renderBehaviors.set("candidate", "throw")
    const { canvas, controller, metrics, statuses } =
      await createMountedController()
    const initialLoad = controller.loadPack(
      pack("committed"),
      new AbortController().signal,
      true,
    )
    await flushCandidateFrame()
    await initialLoad

    const originalModel = runtimeHarness.models.get("committed")!
    const restoredModel = new FakeCharacterModel("committed")
    const restore = deferred<FakeCharacterModel>()
    runtimeHarness.createModel.mockImplementationOnce(
      (client: { manifest: CharacterPackManifest }) => {
        expect(client.manifest.packId).toBe("committed")
        runtimeHarness.models.set("committed:restored", restoredModel)
        return restore.promise
      },
    )
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }))
    canvas.dispatchEvent(new Event("webglcontextrestored"))
    await waitFor(() => expect(originalModel.release).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(runtimeHarness.models.get("committed:restored")).toBe(
        restoredModel,
      ),
    )

    const failedSwitch = controller.loadPack(
      pack("candidate"),
      new AbortController().signal,
      false,
    )
    restore.resolve(restoredModel)
    await flushCandidateFrame()
    await waitFor(() =>
      expect(runtimeHarness.models.has("candidate")).toBe(true),
    )

    const recoveredMetrics = controller.metrics
    const recoveredStatus = statuses.at(-1)
    const metricsAfterRecovery = metrics.length
    await flushCandidateFrame()
    await expect(failedSwitch).rejects.toMatchObject({
      code: "shader_load_failed",
    })

    const candidateModel = runtimeHarness.models.get("candidate")!
    expect(runtimeHarness.drawnPackId).toBe("committed")
    expect(controller.metrics).toEqual(recoveredMetrics)
    expect(statuses.at(-1)).toEqual(recoveredStatus)
    expect(statuses.at(-1)).toMatchObject({
      phase: "ready",
      pack: { packId: "committed" },
    })
    expect(metrics).toHaveLength(metricsAfterRecovery)
    expect(originalModel.release).toHaveBeenCalledTimes(1)
    expect(restoredModel.release).not.toHaveBeenCalled()
    expect(candidateModel.release).toHaveBeenCalledTimes(1)
  })

  it("restarts restoration when another restore event arrives during an aborted attempt", async () => {
    runtimeHarness.renderBehaviors.set("committed", "visible")
    const { canvas, controller, metrics, statuses } =
      await createMountedController()
    const initialLoad = controller.loadPack(
      pack("committed"),
      new AbortController().signal,
      true,
    )
    await flushCandidateFrame()
    await initialLoad

    const originalModel = runtimeHarness.models.get("committed")!
    const firstRestoredModel = new FakeCharacterModel("committed")
    const winningRestoredModel = new FakeCharacterModel("committed")
    runtimeHarness.createModel
      .mockImplementationOnce(() => {
        runtimeHarness.models.set("committed:restore-1", firstRestoredModel)
        return Promise.resolve(firstRestoredModel)
      })
      .mockImplementationOnce(() => {
        runtimeHarness.models.set("committed:restore-2", winningRestoredModel)
        return Promise.resolve(winningRestoredModel)
      })

    const metricsBeforeLoss = metrics.length
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }))
    canvas.dispatchEvent(new Event("webglcontextrestored"))
    await waitFor(() =>
      expect(runtimeHarness.models.has("committed:restore-1")).toBe(true),
    )
    await waitFor(() => expect(animationFrames.count).toBeGreaterThan(0))

    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }))
    canvas.dispatchEvent(new Event("webglcontextrestored"))
    await waitFor(() =>
      expect(runtimeHarness.models.has("committed:restore-2")).toBe(true),
    )
    await flushCandidateFrame()
    await waitFor(() =>
      expect(statuses.at(-1)).toMatchObject({
        phase: "ready",
        pack: { packId: "committed" },
      }),
    )

    expect(controller.metrics.nonTransparentSamples).toBeGreaterThan(0)
    expect(controller.metrics.webglError).toBe(0)
    expect(metrics).toHaveLength(metricsBeforeLoss + 1)
    expect(originalModel.release).toHaveBeenCalledTimes(1)
    expect(firstRestoredModel.release).toHaveBeenCalledTimes(1)
    expect(winningRestoredModel.release).not.toHaveBeenCalled()
  })

  it("terminates an aborted switch without canceling the winning restoration", async () => {
    runtimeHarness.renderBehaviors.set("committed", "visible")
    const { canvas, controller, statuses } = await createMountedController()
    const initialLoad = controller.loadPack(
      pack("committed"),
      new AbortController().signal,
      true,
    )
    await flushCandidateFrame()
    await initialLoad

    const originalModel = runtimeHarness.models.get("committed")!
    const restoredModel = new FakeCharacterModel("committed")
    const restore = deferred<FakeCharacterModel>()
    runtimeHarness.createModel.mockImplementationOnce(
      (client: { manifest: CharacterPackManifest }) => {
        expect(client.manifest.packId).toBe("committed")
        runtimeHarness.models.set("committed:restored", restoredModel)
        return restore.promise
      },
    )
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }))
    canvas.dispatchEvent(new Event("webglcontextrestored"))
    await waitFor(() => expect(originalModel.release).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(runtimeHarness.models.get("committed:restored")).toBe(
        restoredModel,
      ),
    )

    const abortController = new AbortController()
    const abortedSwitch = controller.loadPack(
      pack("candidate"),
      abortController.signal,
      false,
    )
    abortController.abort()
    await expect(abortedSwitch).rejects.toMatchObject({ code: "disposed" })
    expect(runtimeHarness.models.has("candidate")).toBe(false)

    restore.resolve(restoredModel)
    await flushCandidateFrame()
    await waitFor(() =>
      expect(statuses.at(-1)).toMatchObject({
        phase: "ready",
        pack: { packId: "committed" },
      }),
    )
    expect(originalModel.release).toHaveBeenCalledTimes(1)
    expect(restoredModel.release).not.toHaveBeenCalled()
  })
})
