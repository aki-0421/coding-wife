import { act, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  CharacterControllerStatus,
  CharacterMotionPolicy,
  CharacterState,
} from "@/features/character/model"
import { Live2dCharacter } from "@/features/character/components/Live2dCharacter"

interface MockControllerInstance {
  readonly resize: ReturnType<typeof vi.fn>
  readonly syncDocumentVisibility: ReturnType<typeof vi.fn>
}

const controllerHarness = vi.hoisted(() => ({
  instances: [] as MockControllerInstance[],
}))
const loadTrustedCharacterFrameMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve(null)),
)

vi.mock("@/features/character/runtime/character-controller", () => {
  class MockCharacterController implements MockControllerInstance {
    public readonly resize = vi.fn()
    public readonly loadPack = vi.fn(() => Promise.resolve())
    public readonly dispose = vi.fn()
    public readonly syncDocumentVisibility = vi.fn(() => {
      const visible = document.visibilityState === "visible"
      if (visible === this.documentVisible) return
      this.documentVisible = visible
      this.emitStatus()
    })
    private readonly onStatus:
      ((status: CharacterControllerStatus) => void) | undefined
    private state: CharacterState = "idle"
    private requestedPolicy: CharacterMotionPolicy = "animated"
    private systemPrefersReducedMotion = false
    private documentVisible = true

    public constructor(options: {
      callbacks?: {
        onStatus?: (status: CharacterControllerStatus) => void
      }
    }) {
      this.onStatus = options.callbacks?.onStatus
      controllerHarness.instances.push(this)
    }

    public readonly mount = vi.fn(() => {
      this.syncDocumentVisibility()
      return Promise.resolve()
    })

    public readonly setState = vi.fn(
      (state: CharacterState, generation: number) => {
        void generation
        this.state = state
        this.emitStatus()
      },
    )

    public readonly setMotionPolicy = vi.fn((policy: CharacterMotionPolicy) => {
      this.requestedPolicy = policy
      this.emitStatus()
    })
    public readonly setSemanticCue = vi.fn()

    public readonly setSystemPrefersReducedMotion = vi.fn(
      (prefersReducedMotion: boolean) => {
        this.systemPrefersReducedMotion = prefersReducedMotion
        this.emitStatus()
      },
    )

    private get effectivePolicy(): CharacterMotionPolicy {
      if (this.requestedPolicy === "hidden" || !this.documentVisible) {
        return "hidden"
      }
      if (
        this.requestedPolicy === "reduced" ||
        this.systemPrefersReducedMotion
      ) {
        return "reduced"
      }
      return "animated"
    }

    private emitStatus(): void {
      const motionPolicy = this.effectivePolicy
      this.onStatus?.({
        phase: "idle",
        state: this.state,
        motionPolicy,
        fallbackLevel: motionPolicy === "hidden" ? "text_only" : motionPolicy,
        error: null,
        pack: null,
      })
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
    loadTrustedCharacterFrame: loadTrustedCharacterFrameMock,
  }),
)

interface MediaQueryHarness {
  setMatches(matches: boolean): void
}

function installReducedMotionQuery(initialMatches: boolean): MediaQueryHarness {
  let matches = initialMatches
  const listeners = new Set<() => void>()
  const mediaQuery = {
    get matches() {
      return matches
    },
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener)
    },
  } as unknown as MediaQueryList
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mediaQuery),
  )
  return {
    setMatches(nextMatches) {
      matches = nextMatches
      for (const listener of listeners) listener()
    },
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

function renderCharacter(motionPolicy: CharacterMotionPolicy = "animated") {
  return render(
    <Live2dCharacter
      motionPolicy={motionPolicy}
      showCaption={false}
      state="idle"
      stateGeneration={1}
    />,
  )
}

let documentVisibility: DocumentVisibilityState

beforeEach(() => {
  controllerHarness.instances.length = 0
  loadTrustedCharacterFrameMock.mockClear()
  documentVisibility = "visible"
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => documentVisibility,
  )
  installReducedMotionQuery(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Live2dCharacter lifecycle policy", () => {
  it("recovers a missed visibility transition when compact becomes desktop", async () => {
    documentVisibility = "hidden"
    const { container } = renderCharacter()
    const host = container.firstElementChild as HTMLDivElement
    let currentBounds = bounds(0, 0)
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(
      () => currentBounds,
    )

    await waitFor(() =>
      expect(host).toHaveAttribute("data-character-policy", "hidden"),
    )

    documentVisibility = "visible"
    currentBounds = bounds(608, 879)
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })

    await waitFor(() =>
      expect(host).toHaveAttribute("data-character-policy", "animated"),
    )
    const controller = controllerHarness.instances[0]!
    expect(controller.syncDocumentVisibility).toHaveBeenCalled()
    expect(controller.resize).toHaveBeenLastCalledWith(608, 879, 1)
  })

  it("keeps layout collapse separate across desktop, compact, and desktop", async () => {
    const { container } = renderCharacter()
    const host = container.firstElementChild as HTMLDivElement
    let currentBounds = bounds(608, 879)
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(
      () => currentBounds,
    )
    await waitFor(() => expect(controllerHarness.instances).toHaveLength(1))
    const controller = controllerHarness.instances[0]!
    controller.resize.mockClear()

    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    currentBounds = bounds(0, 0)
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    currentBounds = bounds(608, 879)
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })

    expect(controller.resize.mock.calls).toEqual([
      [608, 879, 1],
      [0, 0, 1],
      [608, 879, 1],
    ])
    expect(host).toHaveAttribute("data-character-policy", "animated")
  })

  it("follows system reduced motion and allow-motion changes", async () => {
    const reducedMotion = installReducedMotionQuery(true)
    const { container } = renderCharacter()
    const host = container.firstElementChild as HTMLDivElement

    await waitFor(() =>
      expect(host).toHaveAttribute("data-character-policy", "reduced"),
    )
    act(() => reducedMotion.setMatches(false))
    expect(host).toHaveAttribute("data-character-policy", "animated")
    act(() => reducedMotion.setMatches(true))
    expect(host).toHaveAttribute("data-character-policy", "reduced")
  })

  it.each([
    ["en", "The character is unavailable. Work can continue."],
    ["ja", "キャラクターを表示できません。作業は継続できます。"],
  ] as const)(
    "uses an accessible %s text fallback while a reduced-motion static frame is unavailable",
    async (locale, fallback) => {
      const { container } = render(
        <Live2dCharacter
          locale={locale}
          motionPolicy="reduced"
          state="idle"
          stateGeneration={1}
        />,
      )
      const host = container.firstElementChild as HTMLDivElement

      await waitFor(() =>
        expect(host).toHaveAttribute(
          "data-character-reduced-presentation",
          "text_only",
        ),
      )
      expect(
        container.querySelector(
          '[data-character-static-preview="trusted-frame"]',
        ),
      ).not.toBeInTheDocument()
      expect(
        container.querySelector('[data-character-canvas="live2d"]'),
      ).toHaveAttribute("hidden")
      expect(container.querySelector('[role="status"]')).toHaveTextContent(
        fallback,
      )
    },
  )

  it("does not clear an explicit hidden policy during lifecycle recovery", async () => {
    const { container, rerender } = renderCharacter("hidden")
    const host = container.firstElementChild as HTMLDivElement
    let currentBounds = bounds(0, 0)
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(
      () => currentBounds,
    )
    await waitFor(() =>
      expect(host).toHaveAttribute("data-character-policy", "hidden"),
    )

    documentVisibility = "hidden"
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    documentVisibility = "visible"
    currentBounds = bounds(608, 879)
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    expect(host).toHaveAttribute("data-character-policy", "hidden")

    rerender(
      <Live2dCharacter
        motionPolicy="animated"
        showCaption={false}
        state="idle"
        stateGeneration={1}
      />,
    )
    expect(host).toHaveAttribute("data-character-policy", "animated")
  })
})
