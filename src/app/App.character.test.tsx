import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { App } from "@/app/App"
import {
  CharacterLibraryProvider,
  CharacterRuntimeStatusProvider,
  DefaultCharacterStageRenderer,
  DemoCharacterLibraryGateway,
  type CharacterLibraryGateway,
  type CharacterLibrarySnapshot,
  type CharacterPackRef,
} from "@/features/character"
import type { Live2dCharacterProps } from "@/features/character/components/Live2dCharacter"
import type { LocalePreferenceStore } from "@/features/localization"
import { DemoTransport } from "@/features/runtime"
import type {
  CharacterStageRenderProps,
  WorkspaceCodexState,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"

const live2dCalls = vi.hoisted(() => [] as Live2dCharacterProps[])
const reportedPresentations = vi.hoisted(() => new Set<string>())

vi.mock("@/features/character/components/Live2dCharacter", () => {
  function MockLive2dCharacter(props: Live2dCharacterProps) {
    live2dCalls.push(props)
    const reportKey = `${props.stateGeneration}:${props.motionPolicy}:${props.reloadToken}`
    if (!reportedPresentations.has(reportKey)) {
      reportedPresentations.add(reportKey)
      queueMicrotask(() =>
        props.onStatusChange?.({
          phase: "ready",
          state: props.state,
          motionPolicy: props.motionPolicy ?? "animated",
          fallbackLevel:
            props.motionPolicy === "reduced" ? "reduced" : "animated",
          error: null,
          pack: null,
        }),
      )
    }
    return (
      <div
        data-live2d-generation={props.stateGeneration}
        data-live2d-policy={props.motionPolicy}
        data-live2d-state={props.state}
        data-testid="live2d-character"
      />
    )
  }

  return {
    BUILTIN_HIYORI_MANIFEST_URL: "/characters/builtin-hiyori/pack.json",
    Live2dCharacter: MockLive2dCharacter,
  }
})

const englishLocaleStore: LocalePreferenceStore = {
  persistence: "session-only",
  read: () => "en",
  write: () => true,
}

function latestLive2dProps(): Live2dCharacterProps | undefined {
  return live2dCalls.at(-1)
}

describe("default App character integration", () => {
  beforeEach(() => {
    live2dCalls.length = 0
    reportedPresentations.clear()
  })

  it("updates state generations without remounting for turns and workspaces", async () => {
    const user = userEvent.setup()
    const codexListeners = new Set<(state: WorkspaceCodexState) => void>()
    const adapter: WorkspaceViewAdapter = {
      connected: true,
      sendTurn: () => Promise.resolve({ accepted: true }),
      stopTurn: () => {
        for (const listener of codexListeners) {
          listener({
            activeWorkspaceId: "build-live2d-desktop-app",
            generation: 1,
            phase: "completed",
            connected: true,
            readiness: {
              ready: true,
              fastAvailable: true,
              maxAvailable: true,
              reasonCode: null,
            },
            pendingRequests: [],
            timeline: [],
            errorCode: null,
          })
        }
        return Promise.resolve()
      },
      subscribeCodex(listener) {
        codexListeners.add(listener)
        return () => codexListeners.delete(listener)
      },
    }

    render(
      <App
        localeStore={englishLocaleStore}
        transport={new DemoTransport()}
        workspaceAdapter={adapter}
      />,
    )

    const initialNode = await screen.findByTestId("live2d-character")
    const companionPane = initialNode.closest(".companion-pane")
    expect(companionPane).not.toBeNull()
    await waitFor(() =>
      expect(
        companionPane?.querySelector(
          '[data-character-runtime-readiness="ready"]',
        ),
      ).toBeInTheDocument(),
    )
    await waitFor(() => expect(latestLive2dProps()?.state).toBe("idle"))
    const initialGeneration = latestLive2dProps()?.stateGeneration ?? 0

    const composer = screen.getByPlaceholderText(
      "Ask Codex to plan, build, explain, or fix anything…",
    )
    fireEvent.change(composer, { target: { value: "Render this turn" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() => expect(latestLive2dProps()?.state).toBe("acting"))
    expect(latestLive2dProps()?.stateGeneration).toBe(initialGeneration + 2)
    expect(screen.getByTestId("live2d-character")).toBe(initialNode)

    fireEvent.click(await screen.findByRole("button", { name: "Stop" }))
    await waitFor(() => expect(latestLive2dProps()?.state).toBe("idle"))
    const idleGeneration = latestLive2dProps()?.stateGeneration ?? 0
    expect(idleGeneration).toBe(initialGeneration + 3)

    fireEvent.click(
      within(companionPane as HTMLElement).getByRole("button", {
        name: "Mute companion",
      }),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-character-audio="muted"]'),
      ).toBeInTheDocument(),
    )
    expect(latestLive2dProps()?.motionPolicy).toBe("animated")
    expect(latestLive2dProps()?.stateGeneration).toBe(idleGeneration)

    await user.click(screen.getByRole("tab", { name: "Commit" }))
    expect(screen.getByTestId("live2d-character")).toBe(initialNode)
    expect(screen.getByTestId("live2d-character")).toBeVisible()
    expect(latestLive2dProps()?.stateGeneration).toBe(idleGeneration)

    await user.click(screen.getByRole("tab", { name: "Context" }))
    expect(screen.getByTestId("live2d-character")).toBe(initialNode)
    expect(screen.getByTestId("live2d-character")).toBeVisible()

    await user.click(screen.getByRole("tab", { name: "Settings" }))
    await waitFor(() =>
      expect(screen.getByTestId("live2d-character")).not.toBeVisible(),
    )

    await user.click(
      screen.getAllByRole("button", { name: "App settings" })[0]!,
    )
    await waitFor(() =>
      expect(screen.getByTestId("live2d-character")).not.toBeVisible(),
    )
    await user.click(screen.getByRole("button", { name: "Back to workspace" }))
    await waitFor(() =>
      expect(screen.getByTestId("live2d-character")).not.toBeVisible(),
    )

    await user.click(screen.getByRole("tab", { name: /Chat/ }))
    expect(screen.getByTestId("live2d-character")).toBe(initialNode)
    await waitFor(() =>
      expect(screen.getByTestId("live2d-character")).toBeVisible(),
    )

    const workspaceNavigation = screen.getByRole("navigation", {
      name: "Workspaces",
    })
    fireEvent.click(
      within(workspaceNavigation).getByRole("button", {
        name: "main, aki-0421/coding-wife, Done",
      }),
    )

    await waitFor(() =>
      expect(latestLive2dProps()?.stateGeneration).toBe(idleGeneration + 1),
    )
    expect(latestLive2dProps()?.state).toBe("idle")
    expect(screen.getByTestId("live2d-character")).toBe(initialNode)
    expect(latestLive2dProps()?.showCaption).toBe(false)
  })

  it("maps reduced motion without treating mute as a motion policy", () => {
    const characterGateway = new DemoCharacterLibraryGateway()
    const { rerender } = render(
      <CharacterLibraryProvider gateway={characterGateway}>
        <CharacterRuntimeStatusProvider rendererKind="builtin_hiyori">
          <DefaultCharacterStageRenderer
            muted={false}
            reducedMotion={false}
            state="reviewing"
            workspaceId="workspace-a"
          />
        </CharacterRuntimeStatusProvider>
      </CharacterLibraryProvider>,
    )
    const initialNode = screen.getByTestId("live2d-character")
    const initialGeneration = latestLive2dProps()?.stateGeneration

    rerender(
      <CharacterLibraryProvider gateway={characterGateway}>
        <CharacterRuntimeStatusProvider rendererKind="builtin_hiyori">
          <DefaultCharacterStageRenderer
            muted
            reducedMotion
            state="reviewing"
            workspaceId="workspace-a"
          />
        </CharacterRuntimeStatusProvider>
      </CharacterLibraryProvider>,
    )

    expect(screen.getByTestId("live2d-character")).toBe(initialNode)
    expect(latestLive2dProps()).toMatchObject({
      motionPolicy: "reduced",
      showCaption: false,
      state: "reviewing",
      stateGeneration: initialGeneration,
    })
    expect(
      document.querySelector('[data-character-audio="muted"]'),
    ).toBeInTheDocument()
  })

  it("loads the app-selected custom pack into the default renderer", async () => {
    const customPackId = "custom:11111111-1111-4111-8111-111111111111"
    const customPackRef: CharacterPackRef = {
      kind: "url",
      manifestUrl: "/characters/custom/pack.json",
    }
    const snapshot: CharacterLibrarySnapshot = {
      schemaVersion: 1,
      workspaceId: "workspace-custom",
      projectId: "project-custom",
      selectedPackId: customPackId,
      fallbackApplied: false,
      diagnostics: [],
      packs: [
        {
          schemaVersion: 1,
          packId: customPackId,
          displayName: "Custom Hiyori",
          kind: "custom",
          manifestHash: "d".repeat(64),
          provenanceLabel: "Local folder",
          importedAt: "2026-07-18T00:00:00.000Z",
          runtimeFileCount: 17,
          totalBytes: 4_700_000,
          textureCount: 2,
          motionCount: 10,
          expressionCount: 0,
          selectedProjectCount: 1,
          deletable: true,
          manifest: null,
          thumbnailSha256: null,
          cueInventory: {
            motions: [
              "Idle[0]",
              "Idle[1]",
              "Idle[2]",
              "Flick[0]",
              "FlickDown[0]",
              "FlickUp[0]",
              "Tap[0]",
              "Tap[1]",
              "Tap@Body[0]",
              "Flick@Body[0]",
            ],
            expressions: [],
          },
        },
      ],
      semanticMapping: {
        schemaVersion: 1,
        packId: customPackId,
        manifestHash: "d".repeat(64),
        mappingVersion: 0,
        assignments: {
          neutral: { kind: "neutral" },
          thinking: { kind: "neutral" },
          working: { kind: "neutral" },
          asking: { kind: "neutral" },
          success: { kind: "neutral" },
          warning: { kind: "neutral" },
          error: { kind: "neutral" },
        },
      },
      semanticMappingStatus: "default",
    }
    const unsupported = () => Promise.reject(new Error("unsupported"))
    const gateway: CharacterLibraryGateway = {
      kind: "native",
      getLibrary: ({ workspaceId }) =>
        Promise.resolve({ ...snapshot, workspaceId }),
      pickImport: unsupported,
      attestPreview: unsupported,
      confirmImport: unsupported,
      cancelImport: unsupported,
      selectPack: unsupported,
      deletePack: unsupported,
      saveSemanticMapping: unsupported,
      createPackRef: () => customPackRef,
      createPreviewPackRef: () => customPackRef,
    }

    render(
      <CharacterLibraryProvider gateway={gateway}>
        <CharacterRuntimeStatusProvider rendererKind="builtin_hiyori">
          <DefaultCharacterStageRenderer
            muted={false}
            reducedMotion={false}
            state="idle"
            workspaceId="workspace-custom"
          />
        </CharacterRuntimeStatusProvider>
      </CharacterLibraryProvider>,
    )

    await waitFor(() =>
      expect(latestLive2dProps()?.packRef).toBe(customPackRef),
    )
    expect(
      document.querySelector(`[data-character-pack="${customPackId}"]`),
    ).toBeInTheDocument()
  })

  it("keeps an explicitly supplied renderer as the App override", async () => {
    const user = userEvent.setup()
    const explicitCalls: CharacterStageRenderProps[] = []

    render(
      <App
        characterRenderer={(props) => {
          explicitCalls.push(props)
          return <div data-testid="explicit-character">Custom</div>
        }}
        localeStore={englishLocaleStore}
        transport={new DemoTransport()}
      />,
    )

    expect(await screen.findByTestId("explicit-character")).toBeVisible()
    expect(explicitCalls.length).toBeGreaterThan(0)
    expect(live2dCalls).toHaveLength(0)
    expect(
      document.querySelector('[data-character-stage-default="app-live2d"]'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText("External renderer · status unavailable"),
    ).toBeVisible()

    await user.click(screen.getByRole("tab", { name: "Settings" }))
    await user.click(screen.getByRole("button", { name: "Companion" }))
    expect(screen.getByText("External renderer")).toBeVisible()
    expect(
      screen.getByText("Unknown", { selector: "[data-slot=badge]" }),
    ).toBeVisible()
  })

  it("reports Hiyori provenance, preferences, errors, and retry from the mounted renderer", async () => {
    const user = userEvent.setup()
    render(
      <App localeStore={englishLocaleStore} transport={new DemoTransport()} />,
    )

    await waitFor(() =>
      expect(
        document.querySelector('[data-character-runtime-readiness="ready"]'),
      ).toBeInTheDocument(),
    )
    await user.click(screen.getByRole("tab", { name: "Settings" }))
    await user.click(screen.getByRole("button", { name: "Companion" }))
    expect(screen.getAllByText("桃瀬ひより - PRO").length).toBeGreaterThan(0)
    expect(screen.getByText("hiyori_pro_t11")).toBeVisible()
    expect(screen.getByText("かにビーム")).toBeVisible()

    fireEvent.click(screen.getAllByRole("button", { name: "App settings" })[0]!)
    fireEvent.change(screen.getByRole("combobox", { name: "Reduced motion" }), {
      target: { value: "on" },
    })
    fireEvent.click(screen.getByRole("switch", { name: "Character visible" }))
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Character visible" }),
      ).not.toBeChecked(),
    )
    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }))
    await waitFor(() =>
      expect(
        screen.getByText("Hidden", { selector: "[data-slot=badge]" }),
      ).toBeVisible(),
    )
    const presentationsBeforeShow = live2dCalls.length
    fireEvent.click(screen.getAllByRole("button", { name: "App settings" })[0]!)
    fireEvent.click(screen.getByRole("switch", { name: "Character visible" }))
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Character visible" }),
      ).toBeChecked(),
    )
    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }))
    await waitFor(() =>
      expect(live2dCalls.length).toBeGreaterThan(presentationsBeforeShow),
    )
    await waitFor(() =>
      expect(screen.getAllByText("Reduced").length).toBeGreaterThan(0),
    )

    const failedStatus = {
      phase: "error",
      state: "disconnected",
      motionPolicy: "reduced",
      fallbackLevel: "text_only",
      error: {
        code: "asset_fetch_failed",
        message: "do not render this raw detail",
        recoverable: true,
      },
      pack: null,
    } as const
    act(() => latestLive2dProps()?.onStatusChange?.(failedStatus))
    expect(
      (await screen.findAllByText("asset_fetch_failed")).length,
    ).toBeGreaterThan(0)
    expect(
      screen.queryByText("do not render this raw detail"),
    ).not.toBeInTheDocument()

    const previousReloadToken = latestLive2dProps()?.reloadToken
    fireEvent.click(
      screen.getAllByRole("button", { name: "Retry Live2D" }).at(-1)!,
    )
    await waitFor(() =>
      expect(latestLive2dProps()?.reloadToken).not.toBe(previousReloadToken),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-character-runtime-readiness="ready"]'),
      ).toBeInTheDocument(),
    )
  }, 10_000)
})
