import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

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
  sourceKeyFromCommitNarrationEvent,
  type CommitNarrationStartedV1,
} from "@/features/narration"
import { CharacterStageSlot } from "@/features/workspace-view/CharacterStageSlot"
import { getWorkspaceCopy } from "@/features/workspace-view/copy"
import type { CharacterStageRenderer } from "@/features/workspace-view/types"

const jaStore: LocalePreferenceStore = {
  read: () => "ja",
  write: () => true,
}

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
            hidden={false}
            muted={false}
            onMutedChange={onMutedChange}
            onRetryCharacter={() => undefined}
            reducedMotion={false}
            renderer={renderer}
            state="idle"
            workspaceId="workspace-1"
          />
        </TooltipProvider>
      </NarrationProvider>
    </I18nProvider>,
  )
}

describe("CharacterStageSlot narration", () => {
  it("keeps background chunks hidden until activation, then closes both channels", async () => {
    const user = userEvent.setup()
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
    expect(await screen.findByText("コミットの要点です。")).toBeVisible()
    expect(screen.getByTestId("renderer")).toHaveAttribute(
      "data-state",
      "reviewing",
    )
    expect(screen.getByTestId("renderer")).toHaveAttribute(
      "data-speaking",
      "false",
    )

    await user.click(screen.getByRole("button", { name: "説明を閉じる" }))
    await waitFor(() =>
      expect(screen.queryByLabelText("コミットの説明")).not.toBeInTheDocument(),
    )
    expect(controller.getSnapshot().presentation?.status).toBe("canceled")
  })

  it("routes the companion mute control through persisted narration settings", async () => {
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
      screen.getByRole("button", { name: "コンパニオンをミュート" }),
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
    const gateway = new DemoNarrationGateway()
    await gateway.updateSettings({
      schemaVersion: narrationSchemaVersion,
      expectedVersion: 0,
      enabled: true,
      muted: false,
      voices: { ja: "Kyoko", en: null },
      rate: 1,
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
