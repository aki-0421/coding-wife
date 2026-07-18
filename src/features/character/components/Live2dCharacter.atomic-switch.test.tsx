import { act, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  CharacterControllerStatus,
  CharacterFrameMetrics,
  CharacterMotionPolicy,
  CharacterNativePackRef,
  CharacterPackManifest,
  CharacterPackRef,
  CharacterState,
} from "@/features/character/model"
import { Live2dCharacter } from "@/features/character/components/Live2dCharacter"

interface ControllerCallbacks {
  readonly onMetrics?: (metrics: CharacterFrameMetrics) => void
  readonly onStaticPreview?: (dataUrl: string) => void
  readonly onStatus?: (status: CharacterControllerStatus) => void
}

interface MockControllerInstance {
  emitCommittedStaticFallback(): void
  emitRecovering(): void
  readonly loadPack: ReturnType<typeof vi.fn>
  resolveCandidate(): void
}

interface DeferredCandidateLoad {
  readonly hasTrustedStaticPreview: boolean
  readonly manifest: CharacterPackManifest
  readonly onAbort: () => void
  readonly resolve: () => void
  readonly signal: AbortSignal
}

const controllerHarness = vi.hoisted(() => ({
  candidateMode: "reject",
  instances: [] as MockControllerInstance[],
  loadCalls: [] as Readonly<{
    packId: string
    hasTrustedStaticPreview: boolean
  }>[],
}))

const trustedFrameHarness = vi.hoisted(() => ({
  frames: new Map<string, ArrayBuffer | null>(),
  load: vi.fn((pack: CharacterPackRef) => {
    const packId = pack.kind === "url" ? null : pack.manifest.packId
    const frame =
      packId === null ? null : trustedFrameHarness.frames.get(packId)
    return Promise.resolve(frame?.slice(0) ?? null)
  }),
}))

vi.mock("@/features/character/runtime/character-controller", () => {
  class MockCharacterController implements MockControllerInstance {
    public readonly dispose = vi.fn()
    public readonly resize = vi.fn()
    public readonly syncDocumentVisibility = vi.fn()
    private readonly callbacks: ControllerCallbacks
    private committedManifest: CharacterPackManifest | null = null
    private deferredCandidate: DeferredCandidateLoad | null = null
    private motionPolicy: CharacterMotionPolicy = "animated"
    private state: CharacterState = "idle"

    public constructor(options: { callbacks?: ControllerCallbacks }) {
      this.callbacks = options.callbacks ?? {}
      controllerHarness.instances.push(this)
    }

    public readonly mount = vi.fn(() => Promise.resolve())
    public readonly setState = vi.fn(
      (state: CharacterState, generation: number) => {
        void generation
        this.state = state
      },
    )
    public readonly setMotionPolicy = vi.fn((policy: CharacterMotionPolicy) => {
      this.motionPolicy = policy
    })
    public readonly setSemanticCue = vi.fn()
    public readonly setSystemPrefersReducedMotion = vi.fn()

    public readonly loadPack = vi.fn(
      (
        pack: CharacterPackRef,
        signal: AbortSignal,
        hasTrustedStaticPreview: boolean,
      ): Promise<void> => {
        if (pack.kind === "url") throw new Error("Unexpected URL test pack")
        controllerHarness.loadCalls.push({
          packId: pack.manifest.packId,
          hasTrustedStaticPreview,
        })
        if (pack.manifest.packId === "candidate") {
          if (controllerHarness.candidateMode === "defer") {
            return new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                signal.removeEventListener("abort", onAbort)
                if (this.deferredCandidate?.onAbort === onAbort) {
                  this.deferredCandidate = null
                }
                reject(new Error("Candidate load was canceled"))
              }
              this.deferredCandidate = {
                hasTrustedStaticPreview,
                manifest: pack.manifest,
                onAbort,
                resolve,
                signal,
              }
              signal.addEventListener("abort", onAbort, { once: true })
              if (signal.aborted) onAbort()
            })
          }
          return Promise.reject(new Error("Candidate first frame failed"))
        }
        this.committedManifest = pack.manifest
        this.callbacks.onStatus?.(this.status("animated"))
        return Promise.resolve()
      },
    )

    public emitCommittedStaticFallback(): void {
      this.callbacks.onStatus?.(this.status("static"))
    }

    public emitRecovering(): void {
      this.callbacks.onStatus?.({
        ...this.status("static"),
        phase: "recovering",
      })
    }

    public resolveCandidate(): void {
      const deferred = this.deferredCandidate
      if (deferred === null || deferred.signal.aborted) return
      deferred.signal.removeEventListener("abort", deferred.onAbort)
      this.deferredCandidate = null
      this.committedManifest = deferred.manifest
      this.callbacks.onStatus?.(this.status("animated"))
      if (!deferred.hasTrustedStaticPreview) {
        this.callbacks.onStaticPreview?.(
          "data:image/png;base64,cmVuZGVyZWQtY2FuZGlkYXRl",
        )
      }
      deferred.resolve()
    }

    private status(
      fallbackLevel: CharacterControllerStatus["fallbackLevel"],
    ): CharacterControllerStatus {
      return {
        phase: "ready",
        state: this.state,
        motionPolicy: this.motionPolicy,
        fallbackLevel,
        error: null,
        pack: this.committedManifest,
      }
    }
  }

  return { CharacterController: MockCharacterController }
})

vi.mock(
  "@/features/character/runtime/character-pack-client",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/character/runtime/character-pack-client")
    >()),
    loadTrustedCharacterFrame: trustedFrameHarness.load,
  }),
)

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
    trustedFrame: {
      assetId: "__coding-wife/trusted-frame.png",
      bytes: 3,
      sha256: "a".repeat(64),
      dimensions: { width: 608, height: 755 },
    },
  }
}

function nativePack(packId: string): CharacterNativePackRef {
  return {
    kind: "native",
    manifest: manifest(packId),
    manifestHash: "b".repeat(64),
    previewToken: null,
    readAsset: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
  }
}

beforeEach(() => {
  controllerHarness.candidateMode = "reject"
  controllerHarness.instances.length = 0
  controllerHarness.loadCalls.length = 0
  trustedFrameHarness.frames.clear()
  trustedFrameHarness.load.mockClear()
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Live2dCharacter atomic pack switching", () => {
  it.each([false, true])(
    "keeps the committed pack and static frame when failed candidate trusted-frame=%s",
    async (candidateHasTrustedFrame) => {
      const committedPack = nativePack("committed")
      const candidatePack = nativePack("candidate")
      const committedFrame = new Uint8Array([1, 2, 3]).buffer
      const candidateFrame = new Uint8Array([4, 5, 6]).buffer
      const committedDataUrl = "data:image/png;base64,AQID"
      const candidateDataUrl = "data:image/png;base64,BAUG"
      trustedFrameHarness.frames.set("committed", committedFrame)
      trustedFrameHarness.frames.set(
        "candidate",
        candidateHasTrustedFrame ? candidateFrame : null,
      )
      const statuses: CharacterControllerStatus[] = []
      const staticPreviews: string[] = []
      const { container, rerender } = render(
        <Live2dCharacter
          motionPolicy="reduced"
          onStaticPreviewChange={(preview) => staticPreviews.push(preview)}
          onStatusChange={(status) => statuses.push(status)}
          packRef={committedPack}
          showCaption={false}
          state="idle"
          stateGeneration={1}
        />,
      )

      await waitFor(() =>
        expect(controllerHarness.loadCalls).toContainEqual({
          packId: "committed",
          hasTrustedStaticPreview: true,
        }),
      )
      await waitFor(() =>
        expect(statuses.at(-1)?.pack?.packId).toBe("committed"),
      )
      expect(staticPreviews).toContain(committedDataUrl)
      await waitFor(() =>
        expect(
          container.querySelector<HTMLImageElement>(
            '[data-character-static-preview="trusted-frame"]',
          )?.src,
        ).toBe(committedDataUrl),
      )
      expect(
        container.querySelector<HTMLCanvasElement>(
          '[data-character-canvas="live2d"]',
        ),
      ).toHaveAttribute("hidden")
      expect(container.firstElementChild).toHaveAttribute(
        "data-character-reduced-presentation",
        "static",
      )

      rerender(
        <Live2dCharacter
          motionPolicy="reduced"
          onStaticPreviewChange={(preview) => staticPreviews.push(preview)}
          onStatusChange={(status) => statuses.push(status)}
          packRef={candidatePack}
          showCaption={false}
          state="idle"
          stateGeneration={1}
        />,
      )

      await waitFor(() =>
        expect(controllerHarness.loadCalls).toContainEqual({
          packId: "candidate",
          hasTrustedStaticPreview: candidateHasTrustedFrame,
        }),
      )
      expect(statuses.at(-1)?.pack?.packId).toBe("committed")
      expect(staticPreviews).not.toContain(candidateDataUrl)

      act(() => {
        controllerHarness.instances[0]?.emitCommittedStaticFallback()
      })
      const staticPreview = container.querySelector<HTMLImageElement>(
        '[data-character-static-preview="trusted-frame"]',
      )
      expect(staticPreview).not.toBeNull()
      expect(staticPreview?.src).toBe(committedDataUrl)
      expect(statuses.at(-1)?.pack?.packId).toBe("committed")
      expect(staticPreviews).not.toContain(candidateDataUrl)
    },
  )

  it.each([false, true])(
    "commits a deferred candidate preview only after controller acceptance when trusted-frame=%s",
    async (candidateHasTrustedFrame) => {
      controllerHarness.candidateMode = "defer"
      const committedPack = nativePack("committed")
      const candidatePack = nativePack("candidate")
      const committedDataUrl = "data:image/png;base64,AQID"
      const candidateDataUrl = "data:image/png;base64,BAUG"
      const renderedCandidateDataUrl =
        "data:image/png;base64,cmVuZGVyZWQtY2FuZGlkYXRl"
      trustedFrameHarness.frames.set(
        "committed",
        new Uint8Array([1, 2, 3]).buffer,
      )
      trustedFrameHarness.frames.set(
        "candidate",
        candidateHasTrustedFrame ? new Uint8Array([4, 5, 6]).buffer : null,
      )
      const statuses: CharacterControllerStatus[] = []
      const staticPreviews: string[] = []
      const { container, rerender } = render(
        <Live2dCharacter
          motionPolicy="reduced"
          onStaticPreviewChange={(preview) => staticPreviews.push(preview)}
          onStatusChange={(status) => statuses.push(status)}
          packRef={committedPack}
          showCaption={false}
          state="idle"
          stateGeneration={1}
        />,
      )

      await waitFor(() =>
        expect(statuses.at(-1)?.pack?.packId).toBe("committed"),
      )
      act(() => controllerHarness.instances[0]?.emitRecovering())
      rerender(
        <Live2dCharacter
          motionPolicy="reduced"
          onStaticPreviewChange={(preview) => staticPreviews.push(preview)}
          onStatusChange={(status) => statuses.push(status)}
          packRef={candidatePack}
          showCaption={false}
          state="idle"
          stateGeneration={1}
        />,
      )

      await waitFor(() =>
        expect(controllerHarness.loadCalls).toContainEqual({
          packId: "candidate",
          hasTrustedStaticPreview: candidateHasTrustedFrame,
        }),
      )
      expect(statuses.at(-1)).toMatchObject({
        phase: "recovering",
        pack: { packId: "committed" },
      })
      expect(staticPreviews.length).toBeGreaterThan(0)
      expect(new Set(staticPreviews)).toEqual(new Set([committedDataUrl]))
      expect(staticPreviews).not.toContain(candidateDataUrl)
      expect(staticPreviews).not.toContain(renderedCandidateDataUrl)

      act(() => controllerHarness.instances[0]?.resolveCandidate())
      await waitFor(() =>
        expect(statuses.at(-1)).toMatchObject({
          phase: "ready",
          pack: { packId: "candidate" },
        }),
      )
      const acceptedPreview = candidateHasTrustedFrame
        ? candidateDataUrl
        : renderedCandidateDataUrl
      expect(staticPreviews.at(-1)).toBe(acceptedPreview)

      act(() => controllerHarness.instances[0]?.emitCommittedStaticFallback())
      expect(
        container.querySelector<HTMLImageElement>(
          '[data-character-static-preview="trusted-frame"]',
        )?.src,
      ).toBe(acceptedPreview)
    },
  )

  it("drops an aborted deferred trusted preview without changing the committed pack", async () => {
    controllerHarness.candidateMode = "defer"
    const committedPack = nativePack("committed")
    const candidatePack = nativePack("candidate")
    const committedDataUrl = "data:image/png;base64,AQID"
    const candidateDataUrl = "data:image/png;base64,BAUG"
    trustedFrameHarness.frames.set(
      "committed",
      new Uint8Array([1, 2, 3]).buffer,
    )
    trustedFrameHarness.frames.set(
      "candidate",
      new Uint8Array([4, 5, 6]).buffer,
    )
    const statuses: CharacterControllerStatus[] = []
    const staticPreviews: string[] = []
    const { container, rerender } = render(
      <Live2dCharacter
        motionPolicy="reduced"
        onStaticPreviewChange={(preview) => staticPreviews.push(preview)}
        onStatusChange={(status) => statuses.push(status)}
        packRef={committedPack}
        showCaption={false}
        state="idle"
        stateGeneration={1}
      />,
    )
    await waitFor(() => expect(statuses.at(-1)?.pack?.packId).toBe("committed"))

    rerender(
      <Live2dCharacter
        motionPolicy="reduced"
        onStaticPreviewChange={(preview) => staticPreviews.push(preview)}
        onStatusChange={(status) => statuses.push(status)}
        packRef={candidatePack}
        showCaption={false}
        state="idle"
        stateGeneration={1}
      />,
    )
    await waitFor(() =>
      expect(controllerHarness.loadCalls).toContainEqual({
        packId: "candidate",
        hasTrustedStaticPreview: true,
      }),
    )

    rerender(
      <Live2dCharacter
        motionPolicy="reduced"
        onStaticPreviewChange={(preview) => staticPreviews.push(preview)}
        onStatusChange={(status) => statuses.push(status)}
        packRef={committedPack}
        reloadToken={1}
        showCaption={false}
        state="idle"
        stateGeneration={1}
      />,
    )
    await waitFor(() =>
      expect(
        controllerHarness.loadCalls.filter(
          ({ packId }) => packId === "committed",
        ),
      ).toHaveLength(2),
    )
    act(() => controllerHarness.instances[0]?.resolveCandidate())
    act(() => controllerHarness.instances[0]?.emitCommittedStaticFallback())

    expect(statuses.at(-1)?.pack?.packId).toBe("committed")
    expect(staticPreviews).not.toContain(candidateDataUrl)
    expect(
      container.querySelector<HTMLImageElement>(
        '[data-character-static-preview="trusted-frame"]',
      )?.src,
    ).toBe(committedDataUrl)
  })
})
