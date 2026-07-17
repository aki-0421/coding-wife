import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { App } from "@/app/App"
import { DefaultCharacterStageRenderer } from "@/features/character"
import type { Live2dCharacterProps } from "@/features/character/components/Live2dCharacter"
import type { LocalePreferenceStore } from "@/features/localization"
import { DemoTransport } from "@/features/runtime"
import type {
  CharacterStageRenderProps,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"

const live2dCalls = vi.hoisted(() => [] as Live2dCharacterProps[])

vi.mock("@/features/character/components/Live2dCharacter", () => {
  function MockLive2dCharacter(props: Live2dCharacterProps) {
    live2dCalls.push(props)
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
  })

  it("updates state generations without remounting for turns and workspaces", async () => {
    const adapter: WorkspaceViewAdapter = {
      connected: true,
      sendTurn: () => Promise.resolve({ accepted: true }),
      stopTurn: () => Promise.resolve(),
    }

    render(
      <App
        localeStore={englishLocaleStore}
        transport={new DemoTransport()}
        workspaceAdapter={adapter}
      />,
    )

    await screen.findByText("Ready")
    await waitFor(() => expect(latestLive2dProps()?.state).toBe("idle"))
    const initialNode = screen.getByTestId("live2d-character")
    const initialGeneration = latestLive2dProps()?.stateGeneration ?? 0

    const composer = screen.getByPlaceholderText(
      "Ask Codex to plan, build, explain, or fix anything…",
    )
    fireEvent.change(composer, { target: { value: "Render this turn" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() => expect(latestLive2dProps()?.state).toBe("acting"))
    expect(latestLive2dProps()?.stateGeneration).toBe(initialGeneration + 1)
    expect(screen.getByTestId("live2d-character")).toBe(initialNode)

    fireEvent.click(await screen.findByRole("button", { name: "Stop" }))
    await waitFor(() => expect(latestLive2dProps()?.state).toBe("idle"))
    const idleGeneration = latestLive2dProps()?.stateGeneration ?? 0
    expect(idleGeneration).toBe(initialGeneration + 2)

    const companionPane = initialNode.closest(".companion-pane")
    expect(companionPane).not.toBeNull()
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

    fireEvent.click(screen.getByRole("tab", { name: "Commit" }))
    expect(screen.getByTestId("live2d-character")).toBe(initialNode)
    expect(latestLive2dProps()?.stateGeneration).toBe(idleGeneration)
    fireEvent.click(screen.getByRole("tab", { name: /Chat/ }))

    const workspaceNavigation = screen.getByRole("navigation", {
      name: "Workspaces",
    })
    fireEvent.click(
      within(workspaceNavigation).getByRole("button", {
        name: "coding-wife/sol-desktop, main, Done",
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
    const { rerender } = render(
      <DefaultCharacterStageRenderer
        muted={false}
        reducedMotion={false}
        state="reviewing"
        workspaceId="workspace-a"
      />,
    )
    const initialNode = screen.getByTestId("live2d-character")
    const initialGeneration = latestLive2dProps()?.stateGeneration

    rerender(
      <DefaultCharacterStageRenderer
        muted
        reducedMotion
        state="reviewing"
        workspaceId="workspace-a"
      />,
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

  it("keeps an explicitly supplied renderer as the App override", async () => {
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
      document.querySelector('[data-character-stage-default="bundled-hiyori"]'),
    ).not.toBeInTheDocument()
  })
})
