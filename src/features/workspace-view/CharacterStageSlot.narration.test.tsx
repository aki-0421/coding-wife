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
  type PresenceDirectionEventV1,
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

const presence: PresenceDirectionEventV1 = {
  schemaVersion: narrationSchemaVersion,
  requestId: "presence-1",
  workspaceId: "workspace-1",
  workspaceGeneration: 2,
  sourceEventId: "event-1",
  trigger: "decision_wait",
  locale: "ja",
  utterance: "確認が必要なところで待っています。",
  cue: "asking",
  priority: "high",
  modelRole: "presence_director",
  model: "gpt-5.6-luna",
  occurredAt: "2026-07-21T10:00:00.000Z",
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
  reducedMotion = false,
  workspaceGeneration = 2,
}: {
  readonly controller: NarrationController
  readonly gateway: DemoNarrationGateway
  readonly renderer: CharacterStageRenderer
  readonly onMutedChange?: (muted: boolean) => void
  readonly reducedMotion?: boolean
  readonly workspaceGeneration?: number | null
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
            reducedMotion={reducedMotion}
            renderer={renderer}
            state="idle"
            visible
            workspaceGeneration={workspaceGeneration}
            workspaceId="workspace-1"
          />
        </TooltipProvider>
      </NarrationProvider>
    </I18nProvider>,
  )
}

describe("CharacterStageSlot narration", () => {
  it("renders a matching Luna caption as polite wrapping semantic presence", async () => {
    const gateway = new DemoNarrationGateway()
    const controller = new NarrationController(gateway)
    await controller.initialize()
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 2,
      locale: "ja",
    })
    expect(controller.consumePresence(presence)).toBe(true)
    const renderer: CharacterStageRenderer = (props) => (
      <div
        data-reduced-motion={String(props.reducedMotion)}
        data-state={props.state}
        data-testid="renderer"
      />
    )

    renderStage({ controller, gateway, renderer, reducedMotion: true })

    const caption = screen.getByText("確認が必要なところで待っています。")
    expect(caption).toHaveAttribute("aria-live", "polite")
    expect(caption).toHaveAttribute("role", "status")
    expect(caption).toHaveClass("whitespace-normal", "break-words")
    expect(caption).not.toHaveClass("whitespace-nowrap")
    expect(caption).not.toHaveAttribute("role", "alert")
    expect(screen.getByTestId("renderer")).toHaveAttribute(
      "data-state",
      "waiting_for_user",
    )
    expect(screen.getByTestId("renderer")).toHaveAttribute(
      "data-reduced-motion",
      "true",
    )
  })

  it("does not render or cue a Luna event outside the current generation", async () => {
    const gateway = new DemoNarrationGateway()
    const controller = new NarrationController(gateway)
    await controller.initialize()
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 2,
      locale: "ja",
    })
    expect(controller.consumePresence(presence)).toBe(true)
    const renderer: CharacterStageRenderer = (props) => (
      <div data-state={props.state} data-testid="renderer" />
    )

    renderStage({
      controller,
      gateway,
      renderer,
      workspaceGeneration: 3,
    })

    expect(
      screen.queryByText("確認が必要なところで待っています。"),
    ).not.toBeInTheDocument()
    expect(screen.getByTestId("renderer")).toHaveAttribute("data-state", "idle")
  })

  it("removes Luna presence when an explicit commit explanation starts", async () => {
    const gateway = new DemoNarrationGateway()
    const controller = new NarrationController(gateway)
    await controller.initialize()
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 2,
      locale: "ja",
    })
    expect(controller.consumePresence(presence)).toBe(true)
    const key = prepare(controller)
    const renderer: CharacterStageRenderer = (props) => (
      <div data-state={props.state} data-testid="renderer" />
    )
    renderStage({ controller, gateway, renderer })
    expect(screen.getByText("確認が必要なところで待っています。")).toBeVisible()

    await act(() => controller.activatePresentation(key))

    expect(
      screen.queryByText("確認が必要なところで待っています。"),
    ).not.toBeInTheDocument()
    expect(screen.getByTestId("renderer")).toHaveAttribute(
      "data-state",
      "reviewing",
    )
  })

  it("keeps Luna visible when an unavailable Terra activation leaves a tombstone", async () => {
    const gateway = new DemoNarrationGateway()
    const controller = new NarrationController(gateway)
    await controller.initialize()
    await controller.setScope({
      workspaceId: "workspace-1",
      generation: 2,
      locale: "ja",
    })
    expect(controller.consume(started)).toBe(true)
    expect(
      controller.consume({
        ...started,
        kind: "terminal",
        status: "completed",
        errorCode: null,
      }),
    ).toBe(true)
    expect(controller.consumePresence(presence)).toBe(true)
    await controller.activatePresentation(
      sourceKeyFromCommitNarrationEvent(started),
    )
    expect(controller.getSnapshot().presentation?.status).toBe("unavailable")
    const renderer: CharacterStageRenderer = (props) => (
      <div data-state={props.state} data-testid="renderer" />
    )

    renderStage({ controller, gateway, renderer })

    expect(screen.getByText(presence.utterance)).toBeVisible()
    expect(screen.getByTestId("renderer")).toHaveAttribute(
      "data-state",
      "waiting_for_user",
    )
  })

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
