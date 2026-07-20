import { useState } from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  I18nProvider,
  type LocalePreferenceStore,
} from "@/features/localization"
import { NarrationSettings } from "@/features/narration/components/NarrationSettings"
import {
  narrationSchemaVersion,
  sourceKeyFromCommitNarrationEvent,
  type CommitNarrationStartedV1,
  type NarrationVoiceListV1,
} from "@/features/narration/contracts"
import { NarrationController } from "@/features/narration/controller"
import { NarrationProvider } from "@/features/narration/provider"
import {
  DemoNarrationGateway,
  NarrationBoundaryError,
  type NarrationGateway,
} from "@/features/narration/transport"

const jaStore: LocalePreferenceStore = {
  persistence: "session-only",
  read: () => "ja",
  write: () => true,
}

const enStore: LocalePreferenceStore = {
  persistence: "session-only",
  read: () => "en",
  write: () => true,
}

const originalElementFromPoint = Object.getOwnPropertyDescriptor(
  document,
  "elementFromPoint",
)

function installAnimationFrames() {
  let nextId = 0
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
    flush() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const callback of pending) callback(performance.now())
    },
  }
}

function mockVisibleTestCaption(caption: HTMLElement): void {
  const rect = {
    x: 120,
    y: 140,
    top: 140,
    right: 620,
    bottom: 220,
    left: 120,
    width: 500,
    height: 80,
    toJSON: () => ({}),
  } satisfies DOMRect
  Object.defineProperties(caption, {
    getBoundingClientRect: {
      configurable: true,
      value: () => rect,
    },
    getClientRects: {
      configurable: true,
      value: () => ({ length: 1 }),
    },
  })
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => caption,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalElementFromPoint === undefined) {
    Reflect.deleteProperty(document, "elementFromPoint")
  } else {
    Object.defineProperty(
      document,
      "elementFromPoint",
      originalElementFromPoint,
    )
  }
})

function Harness({
  controller,
  gateway,
  heading = "音声",
  localeStore = jaStore,
  onMutedChange = () => undefined,
}: {
  readonly controller: NarrationController
  readonly gateway: NarrationGateway
  readonly heading?: string
  readonly localeStore?: LocalePreferenceStore
  readonly onMutedChange?: (muted: boolean) => void
}) {
  const [muted, setMuted] = useState(false)
  return (
    <I18nProvider store={localeStore}>
      <NarrationProvider controller={controller} gateway={gateway}>
        <NarrationSettings
          heading={heading}
          muted={muted}
          onMutedChange={(nextMuted) => {
            setMuted(nextMuted)
            onMutedChange(nextMuted)
          }}
          workspaceId="workspace-1"
        />
      </NarrationProvider>
    </I18nProvider>
  )
}

class FailingSettingsGateway extends DemoNarrationGateway {
  public override getSettings(): Promise<never> {
    return Promise.reject(
      new NarrationBoundaryError({
        code: "NARRATION-SETTINGS-READ",
        operation: "narration_get_settings",
        recoverable: true,
        userMessageKey: "narration.error.generic",
        detailRef: "narration-v1",
      }),
    )
  }
}

class ControlledVoiceGateway extends DemoNarrationGateway {
  public failVoices = false

  public override listVoices(): Promise<NarrationVoiceListV1> {
    if (this.failVoices) {
      return Promise.reject(
        new NarrationBoundaryError({
          code: "NARRATION-VOICE-LIST",
          operation: "narration_list_voices",
          recoverable: true,
          userMessageKey: "narration.error.generic",
          detailRef: "narration-v1",
        }),
      )
    }
    return Promise.resolve({
      schemaVersion: narrationSchemaVersion,
      voices: [
        { name: "Kyoko", locale: "ja_JP" },
        { name: "Otoya", locale: "ja_JP" },
        { name: "Samantha", locale: "en_US" },
      ],
    })
  }
}

interface SetupOptions {
  readonly gateway?: NarrationGateway
  readonly heading?: string
  readonly localeStore?: LocalePreferenceStore
  readonly onMutedChange?: (muted: boolean) => void
}

function setup({
  gateway = new DemoNarrationGateway(),
  heading,
  localeStore,
  onMutedChange,
}: SetupOptions = {}) {
  const controller = new NarrationController(gateway)
  const view = render(
    <Harness
      controller={controller}
      gateway={gateway}
      {...(heading === undefined ? {} : { heading })}
      {...(localeStore === undefined ? {} : { localeStore })}
      {...(onMutedChange === undefined ? {} : { onMutedChange })}
    />,
  )
  return { controller, gateway, view }
}

const started: CommitNarrationStartedV1 = {
  schemaVersion: narrationSchemaVersion,
  source: "background_support",
  trigger: "user_request",
  kind: "started",
  workspaceId: "workspace-1",
  workspaceGeneration: 2,
  commitSha: "a".repeat(40),
  requestId: "support-settings-1",
  locale: "ja",
}

async function activatePresentation(controller: NarrationController) {
  controller.consume(started)
  controller.consume({
    ...started,
    kind: "chunk",
    sequence: 0,
    text: "設定画面の状態表示です。",
  })
  await controller.activatePresentation(
    sourceKeyFromCommitNarrationEvent(started),
  )
}

describe("NarrationSettings", () => {
  it("shows the quiet local-only source and default-off state", async () => {
    setup()

    expect(
      await screen.findByText("App-generated · commit explanation"),
    ).toBeVisible()
    expect(screen.getByRole("heading", { name: "音声" })).toBeVisible()
    expect(screen.getByText("ローカルのみ · macOS")).toBeVisible()
    expect(
      screen.getByRole("switch", { name: "TTSを有効にする" }),
    ).not.toBeChecked()
    expect(screen.getByRole("button", { name: "音声をテスト" })).toBeDisabled()
  })

  it("terminalizes a settings load failure with a retry action", async () => {
    const gateway = new FailingSettingsGateway()
    setup({ gateway })

    expect(
      await screen.findByText("ローカル音声を利用できません"),
    ).toBeVisible()
    expect(screen.getByText("NARRATION-SETTINGS-READ")).toBeVisible()
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeEnabled()
  })

  it("persists a verified voice and rate before showing the test caption", async () => {
    const frames = installAnimationFrames()
    const user = userEvent.setup()
    const { controller, gateway } = setup()
    const nativeSpeak = gateway.speak.bind(gateway)
    const captionAtSpeak: Element[] = []
    const speak = vi.spyOn(gateway, "speak").mockImplementation((request) => {
      const caption = document.querySelector("[data-narration-test-status]")
      if (caption !== null) captionAtSpeak.push(caption)
      return nativeSpeak(request)
    })
    await screen.findByRole("heading", { name: "音声" })

    await user.click(screen.getByRole("switch", { name: "TTSを有効にする" }))
    expect(screen.getByLabelText("音声")).toHaveValue("Kyoko")
    await user.selectOptions(screen.getByLabelText("読み上げ速度"), "1.15")
    await user.click(screen.getByRole("button", { name: "音声設定を保存" }))

    await waitFor(() =>
      expect(controller.getSnapshot().settingsSnapshot?.settings).toMatchObject(
        {
          enabled: true,
          rate: 1.15,
          voices: { ja: "Kyoko" },
        },
      ),
    )
    await user.click(screen.getByRole("button", { name: "音声をテスト" }))
    const testCaption = (await screen.findByText("テスト字幕")).parentElement
    if (!(testCaption instanceof HTMLElement)) {
      throw new Error("test caption is missing")
    }
    expect(speak).not.toHaveBeenCalled()
    mockVisibleTestCaption(testCaption)
    act(() => frames.flush())
    expect(speak).not.toHaveBeenCalled()
    act(() => frames.flush())
    await waitFor(() => expect(speak).toHaveBeenCalledOnce())
    expect(captionAtSpeak).toEqual([testCaption])
    expect(
      screen.getByText(
        "これはローカル音声のテストです。字幕は音声より先に表示されます。",
      ),
    ).toBeVisible()
    await user.click(screen.getByRole("button", { name: "テストを停止" }))
    await waitFor(() =>
      expect(controller.getSnapshot().test.status).toBe("idle"),
    )
  })

  it("does not start test speech while its own caption is hidden", async () => {
    const frames = installAnimationFrames()
    const user = userEvent.setup()
    const { controller, gateway } = setup()
    const speak = vi.spyOn(gateway, "speak")
    await screen.findByRole("heading", { name: "音声" })
    await user.click(screen.getByRole("switch", { name: "TTSを有効にする" }))
    await user.click(screen.getByRole("button", { name: "音声設定を保存" }))
    await waitFor(() =>
      expect(controller.getSnapshot().settingsSnapshot?.settings.enabled).toBe(
        true,
      ),
    )

    await user.click(screen.getByRole("button", { name: "音声をテスト" }))
    expect(await screen.findByText("テスト字幕")).toBeVisible()
    act(() => frames.flush())
    act(() => frames.flush())

    expect(speak).not.toHaveBeenCalled()
    await controller.cancelTest()
  })

  it("mutes immediately and resets to safe defaults after confirmation", async () => {
    const user = userEvent.setup()
    const onMutedChange = vi.fn()
    const { controller } = setup({ onMutedChange })
    await screen.findByRole("heading", { name: "音声" })

    await user.click(screen.getByRole("switch", { name: "ミュート" }))
    await waitFor(() =>
      expect(controller.getSnapshot().settingsSnapshot?.settings.muted).toBe(
        true,
      ),
    )
    expect(onMutedChange).toHaveBeenCalledWith(true)

    await user.click(screen.getByRole("button", { name: "音声設定をリセット" }))
    expect(
      screen.getByRole("heading", { name: "音声設定をリセットしますか？" }),
    ).toBeVisible()
    await user.click(screen.getByRole("button", { name: "リセット" }))

    await waitFor(() =>
      expect(controller.getSnapshot().settingsSnapshot?.settings).toMatchObject(
        {
          enabled: false,
          muted: false,
          rate: 1,
        },
      ),
    )
    expect(onMutedChange).toHaveBeenCalledWith(false)
  })

  it("retains voice and rate drafts across voice retry and mute versions", async () => {
    const user = userEvent.setup()
    const gateway = new ControlledVoiceGateway()
    const { controller } = setup({ gateway })
    await screen.findByRole("heading", { name: "音声" })

    await user.click(screen.getByRole("switch", { name: "TTSを有効にする" }))
    await user.selectOptions(screen.getByLabelText("音声"), "Otoya")
    await user.selectOptions(screen.getByLabelText("読み上げ速度"), "1.15")
    gateway.failVoices = true
    await act(async () => {
      await controller.refreshVoices()
    })

    expect(screen.getByText("NARRATION-VOICE-LIST")).toBeVisible()
    expect(screen.getByRole("button", { name: "音声を再取得" })).toBeEnabled()
    expect(screen.getByLabelText("音声")).toHaveValue("Otoya")
    expect(screen.getByLabelText("読み上げ速度")).toHaveValue("1.15")

    gateway.failVoices = false
    await user.click(screen.getByRole("button", { name: "音声を再取得" }))
    await waitFor(() =>
      expect(controller.getSnapshot().voiceStatus).toBe("ready"),
    )
    await user.click(screen.getByRole("switch", { name: "ミュート" }))
    await waitFor(() =>
      expect(controller.getSnapshot().settingsSnapshot?.settings.muted).toBe(
        true,
      ),
    )

    expect(screen.getByLabelText("音声")).toHaveValue("Otoya")
    expect(screen.getByLabelText("読み上げ速度")).toHaveValue("1.15")
    expect(screen.getByText("未保存の変更")).toBeVisible()
  })

  it("localizes active caption and speech statuses in Japanese and English", async () => {
    const japanese = setup()
    await screen.findByRole("heading", { name: "音声" })
    await act(() => activatePresentation(japanese.controller))

    expect(screen.getByText("説明中")).toBeVisible()
    expect(screen.getByText("音声オフ")).toBeVisible()
    expect(screen.queryByText("streaming")).not.toBeInTheDocument()
    japanese.view.unmount()

    const englishGateway = new DemoNarrationGateway()
    const english = setup({
      gateway: englishGateway,
      heading: "Audio",
      localeStore: enStore,
    })
    await screen.findByRole("heading", { name: "Audio" })
    await act(() => activatePresentation(english.controller))

    expect(screen.getByText("Explaining")).toBeVisible()
    expect(screen.getByText("Speech off")).toBeVisible()
    expect(screen.queryByText("streaming")).not.toBeInTheDocument()
  })
})
