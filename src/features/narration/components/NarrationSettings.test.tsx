import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import {
  I18nProvider,
  type LocalePreferenceStore,
} from "@/features/localization"
import { NarrationSettings } from "@/features/narration/components/NarrationSettings"
import type { NarrationSettingsUpdateV2 } from "@/features/narration/contracts"
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

function Harness({
  controller,
  gateway,
}: {
  readonly controller: NarrationController
  readonly gateway: NarrationGateway
}) {
  return (
    <I18nProvider store={jaStore}>
      <NarrationProvider controller={controller} gateway={gateway}>
        <NarrationSettings heading="音声" workspaceId="workspace-1" />
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
        detailRef: "narration-v2",
      }),
    )
  }
}

class FailingSettingsUpdateGateway extends DemoNarrationGateway {
  public updateAttempts = 0

  public override updateSettings(
    _request: NarrationSettingsUpdateV2,
  ): Promise<never> {
    this.updateAttempts += 1
    return Promise.reject(
      new NarrationBoundaryError({
        code: "NARRATION-SETTINGS-WRITE",
        operation: "narration_update_settings",
        recoverable: true,
        userMessageKey: "narration.error.generic",
        detailRef: "narration-v2",
      }),
    )
  }
}

function setup(gateway: NarrationGateway = new DemoNarrationGateway()) {
  const controller = new NarrationController(gateway)
  render(<Harness controller={controller} gateway={gateway} />)
  return { controller, gateway }
}

describe("NarrationSettings", () => {
  it("starts with TTS first, no selectable provider, and an OpenAI tab", async () => {
    setup()

    await screen.findByRole("heading", { name: "音声" })
    const enabled = screen.getByRole("switch", { name: "TTSを有効にする" })
    const provider = screen.getByLabelText("TTSプロバイダー")
    const apiKey = screen.getByLabelText("APIキー")

    expect(enabled).toBeDisabled()
    expect(provider).toBeDisabled()
    expect(provider).toHaveTextContent("設定済みのプロバイダーがありません")
    expect(screen.getByRole("tab", { name: "OpenAI" })).toBeVisible()
    expect(apiKey).toHaveAttribute("type", "password")
    expect(
      enabled.compareDocumentPosition(provider) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.queryByRole("switch", { name: "ミュート" })).toBeNull()
    expect(screen.queryByText("表示中のコミット説明")).toBeNull()
    expect(screen.queryByRole("button", { name: "音声設定を保存" })).toBeNull()
    expect(screen.queryByRole("button", { name: "変更を破棄" })).toBeNull()
    expect(
      screen.queryByRole("button", { name: "音声設定をリセット" }),
    ).toBeNull()
  })

  it("automatically saves a hidden API key and subsequent TTS changes", async () => {
    const user = userEvent.setup()
    const { controller } = setup()
    await screen.findByRole("heading", { name: "音声" })

    const apiKey = screen.getByLabelText("APIキー")
    await user.type(apiKey, "sk-test-fixture")
    expect(apiKey).toHaveValue("sk-test-fixture")

    const enabled = screen.getByRole("switch", { name: "TTSを有効にする" })
    await waitFor(() => expect(enabled).toBeEnabled())
    expect(screen.getByLabelText("TTSプロバイダー")).toHaveTextContent("OpenAI")
    expect(apiKey).toHaveValue("")
    await user.click(enabled)

    await waitFor(() =>
      expect(controller.getSnapshot().settingsSnapshot?.settings).toMatchObject(
        {
          enabled: true,
          provider: "openai",
          model: "gpt-4o-mini-tts",
          voice: "marin",
        },
      ),
    )

    await user.click(screen.getByLabelText("ボイス"))
    await user.click(await screen.findByRole("option", { name: "cedar" }))
    await waitFor(() =>
      expect(controller.getSnapshot().settingsSnapshot?.settings.voice).toBe(
        "cedar",
      ),
    )
  })

  it("automatically saves speech speed when the slider value is committed", async () => {
    const user = userEvent.setup()
    const { controller } = setup()
    await screen.findByRole("heading", { name: "音声" })

    const speed = screen.getByRole("slider", { name: "読み上げ速度" })
    speed.focus()
    await user.keyboard("{ArrowRight}")

    await waitFor(() =>
      expect(controller.getSnapshot().settingsSnapshot?.settings.speed).toBe(
        1.05,
      ),
    )
  })

  it("removes the key and disables TTS in one automatic save", async () => {
    const user = userEvent.setup()
    const { controller } = setup()
    await screen.findByRole("heading", { name: "音声" })
    await user.type(screen.getByLabelText("APIキー"), "sk-test-fixture")
    const enabled = screen.getByRole("switch", { name: "TTSを有効にする" })
    await waitFor(() => expect(enabled).toBeEnabled())
    await user.click(enabled)
    await waitFor(() =>
      expect(controller.getSnapshot().settingsSnapshot?.settings.enabled).toBe(
        true,
      ),
    )

    await user.click(screen.getByRole("button", { name: "APIキーを削除" }))

    await waitFor(() =>
      expect(controller.getSnapshot().settingsSnapshot?.settings).toMatchObject(
        {
          enabled: false,
          provider: null,
          apiKeyConfigured: false,
        },
      ),
    )
    expect(
      screen.getByRole("switch", { name: "TTSを有効にする" }),
    ).toBeDisabled()
  })

  it("keeps a failed API key edit without retrying indefinitely", async () => {
    const user = userEvent.setup()
    const gateway = new FailingSettingsUpdateGateway()
    setup(gateway)
    await screen.findByRole("heading", { name: "音声" })

    const apiKey = screen.getByLabelText("APIキー")
    await user.type(apiKey, "sk-test-fixture")
    await user.tab()

    expect(
      await screen.findByText("音声設定を更新できませんでした"),
    ).toBeVisible()
    expect(apiKey).toHaveValue("sk-test-fixture")
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(gateway.updateAttempts).toBe(1)
  })

  it("shows a terminal settings load error with retry", async () => {
    setup(new FailingSettingsGateway())

    expect(await screen.findByText("TTSを利用できません")).toBeVisible()
    expect(screen.getByText("NARRATION-SETTINGS-READ")).toBeVisible()
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeEnabled()
  })
})
