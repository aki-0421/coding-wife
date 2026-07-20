import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { CharacterRuntimeView } from "@/features/character"
import {
  I18nProvider,
  type LocalePreferenceStore,
} from "@/features/localization"
import {
  NarrationController,
  NarrationProvider,
  DemoNarrationGateway,
  narrationSchemaVersion,
  narrationSettingsSchemaVersion,
  sourceKeyFromCommitNarrationEvent,
  type CommitNarrationStartedV1,
} from "@/features/narration"
import { CharacterStageSlot } from "@/features/workspace-view/CharacterStageSlot"
import { getWorkspaceCopy } from "@/features/workspace-view/copy"
import type { CharacterStageRenderer } from "@/features/workspace-view/types"

const jaStore: LocalePreferenceStore = {
  persistence: "session-only",
  read: () => "ja",
  write: () => true,
}

function installVisibleAnimationFrames(): void {
  let nextFrame = 0
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({
    length: 1,
  } as DOMRectList)
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const frame = ++nextFrame
    queueMicrotask(() => callback(performance.now()))
    return frame
  })
  vi.stubGlobal("cancelAnimationFrame", () => undefined)
}

afterEach(() => vi.unstubAllGlobals())

const runtime: CharacterRuntimeView = {
  rendererKind: "external",
  phase: "unknown",
  fallback: "unknown",
  motionPolicy: "unknown",
  readiness: "unknown",
  pack: null,
  currentErrorCode: null,
  lastErrorCode: null,
  canRetry: false,
}

const started: CommitNarrationStartedV1 = {
  schemaVersion: narrationSchemaVersion,
  source: "background_support",
  trigger: "auto_verified_commit",
  kind: "started",
  workspaceId: "workspace-1",
  workspaceGeneration: 2,
  commitSha: "a".repeat(40),
  requestId: "support-1",
  locale: "ja",
}

function prepare(controller: NarrationController) {
  controller.consume(started)
  controller.consume({
    ...started,
    kind: "chunk",
    sequence: 0,
    text: "コミットの要点です。",
  })
  return sourceKeyFromCommitNarrationEvent(started)
}

function renderStage({
  controller,
  gateway,
  renderer,
  onMutedChange = () => undefined,
}: {
  readonly controller: NarrationController
  readonly gateway: DemoNarrationGateway
  readonly renderer: CharacterStageRenderer
  readonly onMutedChange?: (muted: boolean) => void
}) {
  return render(
    <I18nProvider store={jaStore}>
      <NarrationProvider controller={controller} gateway={gateway}>
        <TooltipProvider>
          <CharacterStageSlot
            characterRuntime={runtime}
            copy={getWorkspaceCopy("ja")}
            muted={false}
            onMutedChange={onMutedChange}
            onRetryCharacter={() => undefined}
            reducedMotion={false}
            renderer={renderer}
            state="idle"
            visible
            workspaceId="workspace-1"
          />
        </TooltipProvider>
      </NarrationProvider>
    </I18nProvider>,
  )
}

describe("CharacterStageSlot narration", () => {
  it("projects presentation state without owning the shared caption", async () => {
    const gateway = new DemoNarrationGateway()
    const controller = new NarrationController(gateway)
    await controller.initialize()
    const key = prepare(controller)
    const renderer: CharacterStageRenderer = (props) => (
      <div
        data-muted={String(props.muted)}
        data-speaking={String(props.speaking)}
        data-state={props.state}
        data-testid="renderer"
      />
    )
    renderStage({ controller, gateway, renderer })

    expect(screen.queryByLabelText("コミットの説明")).not.toBeInTheDocument()
    expect(screen.getByTestId("renderer")).toHaveAttribute("data-state", "idle")

    await act(() => controller.activatePresentation(key))
    expect(screen.queryByText("コミットの要点です。")).not.toBeInTheDocument()
    expect(controller.getSnapshot().presentation).toMatchObject({
      status: "streaming",
      chunks: ["コミットの要点です。"],
    })
    expect(screen.getByTestId("renderer")).toHaveAttribute(
      "data-state",
      "reviewing",
    )
    expect(screen.getByTestId("renderer")).toHaveAttribute(
      "data-speaking",
      "false",
    )

    await act(() => controller.dismissPresentation())
    await waitFor(() =>
      expect(controller.getSnapshot().presentation).toBeNull(),
    )
    expect(screen.getByTestId("renderer")).toHaveAttribute("data-state", "idle")

    await act(() => controller.activatePresentation(key))
    expect(screen.queryByText("コミットの要点です。")).not.toBeInTheDocument()
    expect(controller.getSnapshot().presentation).toMatchObject({
      status: "streaming",
      chunks: ["コミットの要点です。"],
    })
  })

  it("routes the character mute control through persisted narration settings", async () => {
    const user = userEvent.setup()
    const onMutedChange = vi.fn()
    const gateway = new DemoNarrationGateway()
    const controller = new NarrationController(gateway)
    await controller.initialize()
    const renderer: CharacterStageRenderer = (props) => (
      <div data-muted={String(props.muted)} data-testid="renderer" />
    )
    renderStage({ controller, gateway, renderer, onMutedChange })

    await user.click(
      screen.getByRole("button", { name: "キャラクターをミュート" }),
    )
    await waitFor(() =>
      expect(controller.getSnapshot().settingsSnapshot?.settings.muted).toBe(
        true,
      ),
    )
    expect(onMutedChange).toHaveBeenCalledWith(true)
    expect(screen.getByTestId("renderer")).toHaveAttribute("data-muted", "true")
  })

  it("exposes semantic speaking state only while matching speech is active", async () => {
    installVisibleAnimationFrames()
    const gateway = new DemoNarrationGateway()
    await gateway.updateSettings({
      schemaVersion: narrationSettingsSchemaVersion,
      expectedVersion: 0,
      enabled: true,
      muted: false,
      provider: "openai",
      apiKeyAction: { kind: "replace", value: "sk-test-fixture" },
      model: "gpt-4o-mini-tts",
      voice: "marin",
      speed: 1,
    })
    const controller = new NarrationController(gateway)
    await controller.initialize()
    const key = prepare(controller)
    const renderer: CharacterStageRenderer = (props) => (
      <div data-speaking={String(props.speaking)} data-testid="renderer" />
    )
    renderStage({ controller, gateway, renderer })

    await act(() => controller.activatePresentation(key))
    await waitFor(() =>
      expect(screen.getByTestId("renderer")).toHaveAttribute(
        "data-speaking",
        "true",
      ),
    )
    await act(() => controller.cancelPresentation())
    await waitFor(() =>
      expect(screen.getByTestId("renderer")).toHaveAttribute(
        "data-speaking",
        "false",
      ),
    )
  })
})
