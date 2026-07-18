import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { App } from "@/app/App"
import {
  DemoCommitExplanationRuntime,
  demoCurrentCommitEvidenceId,
} from "@/features/git-review"
import type { LocalePreferenceStore } from "@/features/localization"
import { DemoNarrationGateway, NarrationController } from "@/features/narration"
import { DemoTransport } from "@/features/runtime"
import type {
  SendTurnRequest,
  WorkspaceAdapterState,
  WorkspaceCodexState,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"

const localeStore: LocalePreferenceStore = {
  persistence: "session-only",
  read: () => "en",
  write: () => true,
}

const workspaceId = "workspace-commit-demo"

const workspaceState: WorkspaceAdapterState = {
  workspaces: [
    {
      id: workspaceId,
      repository: "coding-wife/demo",
      name: "commit-demo",
      branch: "feature/commit-explanation",
      lifecycle: "in_progress",
    },
  ],
  activeWorkspaceId: workspaceId,
  draft: {
    text: "",
    effort: "fast",
    revision: 0,
    contextSnapshots: [],
  },
  timeline: [],
  history: { mode: "ephemeral", errorCode: null, backupName: null },
}

function codexState(phase: WorkspaceCodexState["phase"]): WorkspaceCodexState {
  return {
    activeWorkspaceId: workspaceId,
    generation: 1,
    phase,
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
  }
}

function timelineEventCount(): number {
  return document.querySelectorAll("[data-event-kind]").length
}

describe("App interactive commit explanation demo", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/?demoAppServer=1")
  })

  afterEach(() => {
    window.history.replaceState({}, "", "/")
  })

  it("runs verified evidence through caption and TTS while selection, locale, and Stop only dismiss presentation", async () => {
    const user = userEvent.setup()
    const gateway = new DemoNarrationGateway()
    const speak = vi.spyOn(gateway, "speak")
    const controller = new NarrationController(gateway)
    const runtime = new DemoCommitExplanationRuntime()
    const codexListeners = new Set<(state: WorkspaceCodexState) => void>()
    let currentCodexState = codexState("ready")
    const publishCodex = (phase: WorkspaceCodexState["phase"]) => {
      currentCodexState = codexState(phase)
      for (const listener of codexListeners) listener(currentCodexState)
    }
    const adapter: WorkspaceViewAdapter = {
      connected: true,
      hydrationMode: "demo",
      loadState: () => Promise.resolve(workspaceState),
      codexSnapshot: () => currentCodexState,
      subscribeCodex(listener) {
        codexListeners.add(listener)
        return () => codexListeners.delete(listener)
      },
      sendTurn(request: SendTurnRequest) {
        if (request.instruction === "demo:stop") publishCodex("running")
        return Promise.resolve({ accepted: true })
      },
      stopTurn() {
        publishCodex("ready")
        return Promise.resolve()
      },
    }

    render(
      <App
        characterRenderer={() => <div data-testid="test-character" />}
        commitExplanationRuntime={runtime}
        localeStore={localeStore}
        narrationController={controller}
        narrationGateway={gateway}
        transport={new DemoTransport()}
        workspaceAdapter={adapter}
      />,
    )

    await waitFor(() =>
      expect(controller.getSnapshot().settingsStatus).toBe("ready"),
    )
    await user.click(await screen.findByRole("tab", { name: "Commit" }))
    await waitFor(
      () =>
        expect(
          runtime.getState(workspaceId, 1, demoCurrentCommitEvidenceId),
        ).toMatchObject({ status: "generated", selectionVersion: 1 }),
      { timeout: 3_000 },
    )
    await screen.findByRole(
      "heading",
      { name: "feat(git): add read-only commit evidence" },
      { timeout: 3_000 },
    )
    expect(
      await screen.findByText("Explanation ready", {}, { timeout: 3_000 }),
    ).toBeVisible()
    const historyBeforePresentation = timelineEventCount()

    await user.click(screen.getByRole("button", { name: "Show explanation" }))
    await waitFor(() =>
      expect(controller.getSnapshot().presentation).toMatchObject({
        status: "ready",
        speechStatus: "off",
      }),
    )
    expect(screen.getByRole("tab", { name: /Commit/ })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    expect(
      await screen.findByRole("region", { name: "Commit explanation" }),
    ).toBeVisible()
    expect(
      document.querySelector("[data-workspace-narration-overlay]"),
    ).toHaveAttribute("data-workspace-tab", "commit")
    expect(
      screen.getAllByText(
        "This commit makes verified work understandable through read-only evidence.",
      ).length,
    ).toBeGreaterThan(0)
    expect(speak).not.toHaveBeenCalled()
    expect(timelineEventCount()).toBe(historyBeforePresentation)

    let settingsSaved = false
    await act(async () => {
      settingsSaved = await controller.saveSettings({
        enabled: true,
        muted: false,
        voices: { ja: "Kyoko", en: "Samantha" },
        rate: 1,
      })
    })
    expect(settingsSaved).toBe(true)

    await user.click(screen.getByRole("button", { name: "Read aloud again" }))
    await waitFor(() => {
      expect(controller.getSnapshot().presentation?.speechStatus).toBe("queued")
    })
    const replay = controller.getSnapshot().presentation
    if (replay === null || replay.lastSequence === null) {
      throw new Error("replayed caption is missing")
    }
    act(() => {
      for (let sequence = 0; sequence <= replay.lastSequence!; sequence++) {
        controller.acknowledgeCaptionVisible({
          key: replay.key,
          presentationGeneration: replay.presentationGeneration,
          sequence,
        })
      }
    })
    await waitFor(() => expect(speak).toHaveBeenCalled())

    await user.click(screen.getByRole("tab", { name: "Settings" }))
    await user.click(screen.getByRole("radio", { name: "日本語" }))
    await waitFor(() =>
      expect(controller.getSnapshot().presentation).toBeNull(),
    )
    await user.click(screen.getByRole("radio", { name: "English" }))
    await user.click(await screen.findByRole("tab", { name: "Commit" }))
    expect(
      await screen.findByText("Explanation ready", {}, { timeout: 3_000 }),
    ).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Show explanation" }))

    await user.click(screen.getByRole("tab", { name: /Chat/ }))
    const composer = screen.getByPlaceholderText(
      "Ask Codex to plan, build, explain, or fix anything…",
    )
    fireEvent.change(composer, { target: { value: "demo:stop" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    const stop = await screen.findByRole("button", { name: "Stop" })
    fireEvent.click(stop)
    await waitFor(() =>
      expect(controller.getSnapshot().presentation).toBeNull(),
    )

    await user.click(screen.getByRole("tab", { name: "Commit" }))
    expect(
      await screen.findByText("Explanation ready", {}, { timeout: 3_000 }),
    ).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Show explanation" }))
    await waitFor(() =>
      expect(controller.getSnapshot().presentation).not.toBeNull(),
    )

    const previousCommit = screen
      .getByText("chore: update local project metadata")
      .closest("button")
    if (previousCommit === null) throw new Error("previous commit is missing")
    fireEvent.click(previousCommit)
    await waitFor(() =>
      expect(controller.getSnapshot().presentation).toBeNull(),
    )
    expect(
      await screen.findByRole("heading", {
        name: "chore: update local project metadata",
      }),
    ).toBeVisible()
  }, 15_000)
})
