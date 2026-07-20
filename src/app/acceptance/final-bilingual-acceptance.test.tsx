import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { App } from "@/app/App"
import {
  FinalAcceptanceLifecycleFixture,
  FinalAcceptanceWorkspaceFixture,
  MemoryLocalePreferenceStore,
} from "@/app/acceptance/final-app-fixture"
import {
  acceptanceResourceGrowth,
  FinalAcceptanceEvidenceRecorder,
  finalAcceptanceLocales,
} from "@/app/acceptance/final-acceptance-harness"
import { DemoCommitExplanationRuntime } from "@/features/git-review"
import type { SupportedLocale } from "@/features/localization"
import { DemoNarrationGateway, NarrationController } from "@/features/narration"
import { DemoTransport } from "@/features/runtime"
import type {
  WorkspaceAdapterState,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"

const copy: Readonly<
  Record<
    SupportedLocale,
    {
      readonly addWorkspace: string
      readonly createWorkspace: string
      readonly workspaceName: string
      readonly add: string
      readonly composer: string
      readonly stop: string
      readonly chatTab: string
      readonly commitTab: string
      readonly appSettings: string
      readonly projects: string
      readonly projectCard: RegExp
      readonly goal: string
      readonly saveProject: string
      readonly saved: string
      readonly explanationReady: string
      readonly showExplanation: string
      readonly caption: string
      readonly closeCaption: string
      readonly loadError: string
      readonly retry: string
      readonly preview: string
      readonly pickerUnavailable: string
      readonly settingsTab: string
      readonly workspaceActions: string
      readonly repositoryMissing: string
      readonly repair: RegExp
      readonly dontQuit: string
      readonly stopAndQuit: string
      readonly workspaces: string
    }
  >
> = {
  en: {
    addWorkspace: "Add workspace",
    createWorkspace: "Create workspace",
    workspaceName: "Workspace name",
    add: "Add",
    composer: "Ask Codex to plan, build, explain, or fix anything…",
    stop: "Stop",
    chatTab: "Chat",
    commitTab: "Commit",
    appSettings: "App settings",
    projects: "Projects",
    projectCard: /coding-wife.*3 workspaces/u,
    goal: "Goal",
    saveProject: "Save project context",
    saved: "Saved. This version will be used from the next turn.",
    explanationReady: "Explanation ready",
    showExplanation: "Show explanation",
    caption: "Commit explanation",
    closeCaption: "Close explanation",
    loadError: "Workspace history could not be restored",
    retry: "Retry",
    preview: "Preview only",
    pickerUnavailable:
      "The native operation is not connected in this preview. No local project state changed.",
    settingsTab: "Settings",
    workspaceActions: "Workspace actions",
    repositoryMissing: "Repository missing",
    repair: /Reselect repository/u,
    dontQuit: "Don’t Quit",
    stopAndQuit: "Stop and Quit",
    workspaces: "Workspaces",
  },
  ja: {
    addWorkspace: "ワークスペースを追加",
    createWorkspace: "ワークスペースを作成",
    workspaceName: "ワークスペース名",
    add: "追加",
    composer: "Codexに計画、実装、説明、修正を依頼…",
    stop: "停止",
    chatTab: "チャット",
    commitTab: "コミット",
    appSettings: "アプリ設定",
    projects: "プロジェクト",
    projectCard: /coding-wife.*3件のワークスペース/u,
    goal: "目標",
    saveProject: "プロジェクトコンテキストを保存",
    saved: "保存しました。次のturnからこのバージョンを使います。",
    explanationReady: "説明を生成済み",
    showExplanation: "説明を表示",
    caption: "コミットの説明",
    closeCaption: "説明を閉じる",
    loadError: "ワークスペース履歴を復元できませんでした",
    retry: "再試行",
    preview: "プレビューのみ",
    pickerUnavailable:
      "このプレビューではnative操作が未接続です。ローカルproject状態は変更していません。",
    settingsTab: "設定",
    workspaceActions: "ワークスペース操作",
    repositoryMissing: "リポジトリが見つかりません",
    repair: /リポジトリを再選択/u,
    dontQuit: "終了しない",
    stopAndQuit: "停止して終了",
    workspaces: "ワークスペース",
  },
}

function reducedMotionQuery(query: string): MediaQueryList {
  return {
    matches: query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }
}

describe("final bilingual App acceptance", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn(reducedMotionQuery))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(finalAcceptanceLocales)(
    "runs the explicit workspace-to-caption and project settings path in %s",
    async (locale) => {
      const localized = copy[locale]
      const recorder = new FinalAcceptanceEvidenceRecorder(
        "webview_contract_fixture",
      )
      const workspace = new FinalAcceptanceWorkspaceFixture()
      const lifecycle = new FinalAcceptanceLifecycleFixture()
      const localeStore = new MemoryLocalePreferenceStore(locale)
      const narrationGateway = new DemoNarrationGateway()
      const speak = vi.spyOn(narrationGateway, "speak")
      const narrationController = new NarrationController(narrationGateway)
      const explanationRuntime = new DemoCommitExplanationRuntime()
      const user = userEvent.setup()

      const view = render(
        <App
          appLifecycleGateway={lifecycle}
          characterRenderer={() => <div data-testid="acceptance-character" />}
          commitExplanationRuntime={explanationRuntime}
          localeStore={localeStore}
          narrationController={narrationController}
          narrationGateway={narrationGateway}
          transport={new DemoTransport()}
          workspaceAdapter={workspace}
        />,
      )

      expect(await screen.findByText(localized.preview)).toBeVisible()
      expect(document.documentElement).toHaveAttribute(
        "data-reduced-motion",
        "true",
      )
      expect(
        document.querySelector("[data-reduced-motion='true']"),
      ).not.toBeNull()
      await waitFor(() => expect(lifecycle.listenerCount).toBe(2))

      const chatTab = screen.getByRole("tab", {
        name: new RegExp(localized.chatTab, "u"),
      })
      fireEvent.keyDown(window, { ctrlKey: true, key: "Tab" })
      expect(
        screen.getByRole("tab", {
          name: new RegExp(localized.commitTab, "u"),
        }),
      ).toHaveAttribute("aria-selected", "true")
      fireEvent.keyDown(window, {
        ctrlKey: true,
        shiftKey: true,
        key: "Tab",
      })
      expect(chatTab).toHaveAttribute("aria-selected", "true")

      await user.click(
        screen.getByRole("button", { name: localized.addWorkspace }),
      )
      const createDialog = await screen.findByRole("dialog", {
        name: localized.createWorkspace,
      })
      const workspaceName = within(createDialog).getByRole("textbox", {
        name: localized.workspaceName,
      })
      await waitFor(() => expect(workspaceName).toHaveFocus())
      await user.type(workspaceName, "acceptance-flow")
      await user.click(
        within(createDialog).getByRole("button", {
          name: localized.createWorkspace,
        }),
      )

      const composer = await screen.findByPlaceholderText(localized.composer)
      await user.type(composer, "Complete the final acceptance flow")
      expect(composer).toHaveValue("Complete the final acceptance flow")
      const addAttachment = screen.getByRole("button", { name: localized.add })
      addAttachment.focus()
      await user.keyboard("{Enter}")
      const acceptedAttachment = await screen.findByText("acceptance.png")
      expect(acceptedAttachment).toBeVisible()
      expect(acceptedAttachment.closest("span[title]")).toHaveAttribute(
        "title",
        "acceptance.png · 25.0 MiB",
      )
      expect(document.body).not.toHaveTextContent(/\/(?:Users|home)\//iu)

      workspace.queueAttachmentPickerResponse({
        items: [],
        rejections: [
          {
            candidateIndex: 0,
            code: "CODEX-ATTACHMENT-FILE-TOO-LARGE",
            recoverable: true,
          },
        ],
      })
      addAttachment.focus()
      await user.keyboard("{Enter}")
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "CODEX-ATTACHMENT-FILE-TOO-LARGE",
      )
      expect(screen.getByText("acceptance.png")).toBeVisible()

      workspace.queueAttachmentPickerResponse({
        items: [],
        rejections: [
          {
            candidateIndex: 0,
            code: "CODEX-ATTACHMENT-EXECUTABLE",
            recoverable: false,
          },
        ],
      })
      addAttachment.focus()
      await user.keyboard("{Enter}")
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "CODEX-ATTACHMENT-EXECUTABLE",
      )
      expect(screen.getByText("acceptance.png")).toBeVisible()

      composer.focus()
      await user.keyboard("{Meta>}{Enter}{/Meta}")
      await waitFor(() => expect(workspace.sentTurns).toHaveLength(1))
      expect(
        await screen.findByRole("button", { name: localized.stop }),
      ).toBeVisible()
      expect(workspace.sentTurns[0]).toMatchObject({
        workspaceId: workspace.activeWorkspaceId,
        instruction: "Complete the final acceptance flow",
        effort: "fast",
        attachments: [
          {
            kind: "image",
            name: "acceptance.png",
            relativePath: "assets/acceptance.png",
            size: 25 * 1024 * 1024,
          },
        ],
      })
      expect(workspace.sentTurns[0]?.editableContextSnapshot.project.goal).toBe(
        "Ship a trustworthy local coding companion.",
      )
      const rejectedAttachment = await workspace.registerAttachmentPaths(
        workspace.activeWorkspaceId,
        "drop",
        ["/private-fixture/run.sh"],
      )
      expect(rejectedAttachment).toEqual({
        items: [],
        rejections: [
          {
            candidateIndex: 0,
            code: "CODEX-ATTACHMENT-EXECUTABLE",
            recoverable: false,
          },
        ],
      })
      expect(workspace.retainedPrivatePathCount).toBe(0)

      act(() => workspace.completeTurn())
      expect(
        await screen.findByText(
          "Acceptance implementation completed with focused verification.",
        ),
      ).toBeVisible()

      expect(
        screen.queryByRole("region", { name: localized.caption }),
      ).toBeNull()
      expect(speak).not.toHaveBeenCalled()
      await user.click(screen.getByRole("tab", { name: localized.commitTab }))
      expect(
        await screen.findByRole(
          "heading",
          { name: "feat(git): add read-only commit evidence" },
          { timeout: 3_000 },
        ),
      ).toBeVisible()
      expect(
        await screen.findByText(
          localized.explanationReady,
          {},
          { timeout: 3_000 },
        ),
      ).toBeVisible()
      expect(
        screen.queryByRole("region", { name: localized.caption }),
      ).toBeNull()
      expect(speak).not.toHaveBeenCalled()

      const showExplanation = screen.getByRole("button", {
        name: localized.showExplanation,
      })
      showExplanation.focus()
      await user.keyboard("{Enter}")
      const caption = await screen.findByRole("region", {
        name: localized.caption,
      })
      expect(caption).toBeVisible()
      expect(within(caption).getByRole("log")).toHaveAttribute(
        "aria-live",
        "polite",
      )
      expect(speak).not.toHaveBeenCalled()
      const closeCaption = within(caption).getByRole("button", {
        name: localized.closeCaption,
      })
      closeCaption.focus()
      await user.keyboard("{Enter}")
      await waitFor(() => {
        expect(
          screen.queryByRole("region", { name: localized.caption }),
        ).toBeNull()
        expect(showExplanation).toHaveFocus()
      })

      await user.click(
        screen.getAllByRole("button", { name: localized.appSettings })[0]!,
      )
      await user.click(screen.getByRole("button", { name: localized.projects }))
      await user.click(
        screen.getByRole("button", { name: localized.projectCard }),
      )
      const goal = await screen.findByRole("textbox", { name: localized.goal })
      await user.clear(goal)
      await user.type(goal, "Preserve acceptance evidence across restart")
      await user.click(
        screen.getByRole("button", { name: localized.saveProject }),
      )
      expect(await screen.findByText(localized.saved)).toBeVisible()
      expect(workspace.savedProjectContexts.at(-1)).toMatchObject({
        version: 2,
        context: { goal: "Preserve acceptance evidence across restart" },
      })
      await user.click(
        within(
          screen.getByRole("navigation", { name: localized.workspaces }),
        ).getByRole("button", { current: "page" }),
      )

      const createdWorkspaceId = workspace.activeWorkspaceId
      await user.click(screen.getByRole("tab", { name: localized.chatTab }))
      const createdDraft = screen.getByPlaceholderText(localized.composer)
      await user.type(createdDraft, "created workspace private draft")
      const navigation = screen.getByRole("navigation", {
        name: localized.workspaces,
      })
      const createdWorkspaceButton = within(navigation).getByRole("button", {
        current: "page",
      })
      await user.click(
        within(navigation).getByRole("button", {
          name: "develop, coding-wife, In Progress",
        }),
      )
      await waitFor(() =>
        expect(screen.getByPlaceholderText(localized.composer)).not.toHaveValue(
          "created workspace private draft",
        ),
      )
      const oldGeneration = workspace.codexSnapshot().generation ?? 1
      workspace.publishLateEvent(createdWorkspaceId, oldGeneration - 1)
      expect(workspace.suppressedLateEvents).toContain(
        `${createdWorkspaceId}:${String(oldGeneration - 1)}`,
      )
      await user.click(createdWorkspaceButton)
      await waitFor(() =>
        expect(screen.getByPlaceholderText(localized.composer)).toHaveValue(
          "created workspace private draft",
        ),
      )

      recorder.pass({
        scenarioId: "bilingual_happy_path",
        locale,
        viewport: "desktop",
        assertions: [
          "Created a scoped workspace and accepted one main turn.",
          "Observed trusted read-only commit evidence.",
          "Presented an explicit caption and saved versioned Context.",
        ],
      })
      recorder.pass({
        scenarioId: "explicit_caption_tts_privacy",
        locale,
        viewport: "desktop",
        assertions: [
          "Background generation remained silent before explicit presentation.",
          "The visible caption completed while default-off TTS made zero speech calls.",
          "No private path appeared in rendered evidence.",
        ],
      })
      recorder.pass({
        scenarioId: "reduced_motion",
        locale,
        viewport: "desktop",
        assertions: ["System reduced-motion preference reached the App shell."],
      })
      recorder.pass({
        scenarioId: "keyboard_focus_aria_live",
        locale,
        viewport: "desktop",
        assertions: [
          "Control-Tab cycled the App tabs in both directions.",
          "Workspace creation focused its first field.",
          "The explicit caption used a polite log and restored trigger focus on close.",
        ],
      })
      recorder.pass({
        scenarioId: "multiworkspace_isolation",
        locale,
        viewport: "desktop",
        assertions: [
          "Workspace switching preserved only the selected workspace draft.",
          "An old-scope event was suppressed before publication.",
        ],
      })
      recorder.pass({
        scenarioId: "attachment_security",
        locale,
        viewport: "desktop",
        assertions: [
          "A safe attachment reached the turn as bounded metadata.",
          "An exact-limit PNG remained an image while oversize and executable candidates were rejected.",
          "Keyboard picker activation and rejection feedback retained the valid chip without exposing source paths.",
        ],
      })
      recorder.notExecutedNative("native_restart_repair_quit", [
        "This WebView contract run does not certify SQLite cold restart or native repair.",
      ])
      recorder.notExecutedNative("native_process_cleanup", [
        "This WebView contract run does not certify descendant process disappearance.",
      ])

      await user.click(screen.getByRole("tab", { name: localized.commitTab }))
      const rapidTrigger = await screen.findByRole("button", {
        name: localized.showExplanation,
      })
      fireEvent.click(rapidTrigger)
      const rapidCaption = await screen.findByRole("region", {
        name: localized.caption,
      })
      fireEvent.click(
        within(rapidCaption).getByRole("button", {
          name: localized.closeCaption,
        }),
      )
      view.unmount()
      await act(
        () =>
          new Promise<void>((resolve) => {
            window.requestAnimationFrame(() => resolve())
          }),
      )
      expect(rapidTrigger.isConnected).toBe(false)
      await waitFor(() => {
        expect(workspace.codexListenerCount).toBe(0)
        expect(lifecycle.listenerCount).toBe(0)
      })
      recorder.pass({
        scenarioId: "listener_cleanup",
        locale,
        viewport: "desktop",
        assertions: [
          "App unmount removed the Codex and lifecycle listeners owned by this render.",
        ],
      })
      recorder.assertNoFailures()
    },
    30_000,
  )

  it.each(finalAcceptanceLocales)(
    "keeps the browser demo attachment boundary explicit in %s",
    async (locale) => {
      const localized = copy[locale]
      const user = userEvent.setup()
      const recorder = new FinalAcceptanceEvidenceRecorder("browser_demo")
      const { container } = render(
        <App
          localeStore={new MemoryLocalePreferenceStore(locale)}
          transport={new DemoTransport()}
        />,
      )

      expect(await screen.findByText(localized.preview)).toBeVisible()
      const addAttachment = screen.getByRole("button", {
        name: localized.add,
      })
      expect(addAttachment).toBeDisabled()
      expect(screen.getByText(localized.pickerUnavailable)).toBeVisible()
      expect(container.querySelector('input[type="file"]')).toBeNull()

      addAttachment.focus()
      await user.keyboard("{Enter}")
      expect(screen.queryByLabelText(/draft items|下書き項目/iu)).toBeNull()
      expect(document.body).not.toHaveTextContent(/\/(?:Users|home)\//iu)

      recorder.pass({
        scenarioId: "web_demo_boundary",
        locale,
        viewport: "zoom-200",
        assertions: [
          "The browser demo exposed no native file input or synthetic attachment handle path.",
          "The disabled attachment action named the native-only boundary in visible localized copy.",
          "Keyboard activation made no draft or private-path change.",
        ],
      })
      recorder.assertNoFailures()
    },
  )

  it.each(finalAcceptanceLocales)(
    "keeps native hydration errors recoverable and localized in %s",
    async (locale) => {
      const localized = copy[locale]
      const recorder = new FinalAcceptanceEvidenceRecorder(
        "webview_contract_fixture",
      )
      const stable = new FinalAcceptanceWorkspaceFixture(1)
      let attempts = 0
      const adapter: WorkspaceViewAdapter = {
        hydrationMode: "native",
        loadState: async (): Promise<WorkspaceAdapterState> => {
          attempts += 1
          if (attempts === 1) {
            throw new Error("private native history detail")
          }
          return stable.loadState()
        },
      }
      const user = userEvent.setup()

      render(
        <App
          characterRenderer={() => <div />}
          localeStore={new MemoryLocalePreferenceStore(locale)}
          transport={new DemoTransport()}
          workspaceAdapter={adapter}
        />,
      )

      const alert = await screen.findByRole("alert")
      expect(alert).toHaveTextContent(localized.loadError)
      expect(alert).not.toHaveTextContent("private native history detail")
      await user.click(
        within(alert).getByRole("button", { name: localized.retry }),
      )
      expect(
        await screen.findByPlaceholderText(localized.composer),
      ).toBeVisible()
      expect(attempts).toBe(2)

      recorder.pass({
        scenarioId: "major_error_and_retry",
        locale,
        viewport: "desktop",
        assertions: [
          "A sanitized blocking error exposed one localized retry.",
          "Retry restored the workspace without substituting demo rows during failure.",
        ],
      })
      recorder.assertNoFailures()
    },
  )

  it("restores locale in the fixture while suppressing late scope events and preserving native-only boundaries", async () => {
    const recorder = new FinalAcceptanceEvidenceRecorder(
      "webview_contract_fixture",
    )
    const workspace = new FinalAcceptanceWorkspaceFixture(1)
    const lifecycle = new FinalAcceptanceLifecycleFixture()
    const localeStore = new MemoryLocalePreferenceStore("en")
    const before = workspace.resourceSnapshot(lifecycle.listenerCount)
    const user = userEvent.setup()
    const first = render(
      <App
        appLifecycleGateway={lifecycle}
        characterRenderer={() => <div />}
        localeStore={localeStore}
        transport={new DemoTransport()}
        workspaceAdapter={workspace}
      />,
    )

    await user.click(
      (await screen.findAllByRole("button", { name: "App settings" }))[0]!,
    )
    await user.click(screen.getByRole("radio", { name: "日本語" }))
    expect(
      await screen.findByRole("navigation", {
        name: "アプリ設定の現在地",
      }),
    ).toBeVisible()
    expect(localeStore.value).toBe("ja")
    await waitFor(() => expect(lifecycle.listenerCount).toBe(2))

    first.unmount()
    await waitFor(() => {
      expect(workspace.codexListenerCount).toBe(0)
      expect(lifecycle.listenerCount).toBe(0)
    })
    workspace.restart()
    workspace.publishLateEvent("workspace-primary", 1)
    expect(workspace.suppressedLateEvents).toEqual(["workspace-primary:1"])
    workspace.markActiveRepositoryMissing()

    const second = render(
      <App
        appLifecycleGateway={lifecycle}
        characterRenderer={() => <div />}
        localeStore={localeStore}
        transport={new DemoTransport()}
        workspaceAdapter={workspace}
      />,
    )
    expect(await screen.findByText(copy.ja.preview)).toBeVisible()
    expect(
      (await screen.findAllByText(copy.ja.repositoryMissing)).length,
    ).toBeGreaterThan(0)
    await user.click(
      screen.getByRole("button", { name: copy.ja.workspaceActions }),
    )
    await user.click(screen.getByRole("button", { name: copy.ja.repair }))
    await waitFor(() =>
      expect(workspace.repairedWorkspaceIds).toEqual(["workspace-primary"]),
    )
    expect(screen.queryByText(copy.ja.repositoryMissing)).toBeNull()

    act(() => {
      lifecycle.emitClose({
        schemaVersion: 1,
        requestId: "app-quit-acceptance",
        workspaceId: "workspace-primary",
        workspaceGeneration: workspace.codexSnapshot().generation ?? 1,
      })
    })
    const quitDialog = await screen.findByRole("dialog")
    await waitFor(() =>
      expect(
        within(quitDialog).getByRole("button", { name: copy.ja.dontQuit }),
      ).toHaveFocus(),
    )
    await user.click(
      within(quitDialog).getByRole("button", { name: copy.ja.stopAndQuit }),
    )
    await waitFor(() => {
      expect(workspace.preparedQuitRequests).toHaveLength(1)
      expect(lifecycle.confirmedRequestIds).toEqual(["app-quit-acceptance"])
    })

    second.unmount()
    await waitFor(() =>
      expect(
        acceptanceResourceGrowth(
          before,
          workspace.resourceSnapshot(lifecycle.listenerCount),
        ),
      ).toEqual({ listeners: 0, processes: 0, queuedTasks: 0 }),
    )

    recorder.pass({
      scenarioId: "locale_restart_and_late_event",
      locale: "ja",
      viewport: "desktop",
      assertions: [
        "Japanese locale survived a fixture remount.",
        "An old-generation event was suppressed before publication.",
      ],
    })
    recorder.pass({
      scenarioId: "listener_cleanup",
      locale: "ja",
      viewport: "desktop",
      assertions: [
        "Repeated mount and quit-contract handling left zero listener or queued-task growth.",
      ],
    })
    recorder.notExecutedNative("native_restart_repair_quit", [
      "The fixture verified typed frontend dispatch only; packaged SQLite and Git repair remain unexecuted.",
    ])
    recorder.notExecutedNative("native_process_cleanup", [
      "The fixture owns no OS descendants, so native disappearance remains unexecuted.",
    ])
    recorder.assertNoFailures()
  }, 15_000)
})
