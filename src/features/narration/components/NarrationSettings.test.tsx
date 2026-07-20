import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import {
  I18nProvider,
  type LocalePreferenceStore,
} from "@/features/localization"
import { NarrationSettings } from "@/features/narration/components/NarrationSettings"
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
    expect(provider).toHaveValue("")
    expect(screen.getByRole("tab", { name: "OpenAI" })).toBeVisible()
    expect(apiKey).toHaveAttribute("type", "password")
    expect(
      enabled.compareDocumentPosition(provider) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.queryByRole("switch", { name: "ミュート" })).toBeNull()
    expect(screen.queryByText("表示中のコミット説明")).toBeNull()
  })

  it("configures a hidden API key before allowing TTS to be enabled", async () => {
    const user = userEvent.setup()
    const { controller } = setup()
    await screen.findByRole("heading", { name: "音声" })

    const apiKey = screen.getByLabelText("APIキー")
    await user.type(apiKey, "sk-test-fixture")
    expect(apiKey).toHaveValue("sk-test-fixture")
    expect(screen.getByLabelText("TTSプロバイダー")).toHaveValue("openai")

    const enabled = screen.getByRole("switch", { name: "TTSを有効にする" })
    expect(enabled).toBeEnabled()
    await user.click(enabled)
    await user.selectOptions(screen.getByLabelText("読み上げ速度"), "1.15")
    await user.click(screen.getByRole("button", { name: "音声設定を保存" }))

    await waitFor(() =>
      expect(controller.getSnapshot().settingsSnapshot?.settings).toMatchObject(
        {
          enabled: true,
          provider: "openai",
          model: "gpt-4o-mini-tts",
          voice: "marin",
          speed: 1.15,
        },
      ),
    )
    expect(apiKey).toHaveValue("")
  })

  it("removes the key and disables TTS in one saved change", async () => {
    const user = userEvent.setup()
    const { controller } = setup()
    await screen.findByRole("heading", { name: "音声" })
    await user.type(screen.getByLabelText("APIキー"), "sk-test-fixture")
    const enabled = screen.getByRole("switch", { name: "TTSを有効にする" })
    expect(enabled).toBeEnabled()
    await user.click(enabled)
    await user.click(screen.getByRole("button", { name: "音声設定を保存" }))
    await waitFor(() =>
      expect(controller.getSnapshot().settingsSnapshot?.settings.enabled).toBe(
        true,
      ),
    )

    await user.click(screen.getByRole("button", { name: "APIキーを削除" }))
    await user.click(screen.getByRole("button", { name: "音声設定を保存" }))

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

  it("shows a terminal settings load error with retry", async () => {
    setup(new FailingSettingsGateway())

    expect(await screen.findByText("TTSを利用できません")).toBeVisible()
    expect(screen.getByText("NARRATION-SETTINGS-READ")).toBeVisible()
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeEnabled()
  })
})
