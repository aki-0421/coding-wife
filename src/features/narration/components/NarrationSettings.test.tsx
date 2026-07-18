import { useState } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

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
  read: () => "ja",
  write: () => true,
}

function Harness({
  controller,
  gateway,
  onMutedChange = () => undefined,
}: {
  readonly controller: NarrationController
  readonly gateway: NarrationGateway
  readonly onMutedChange?: (muted: boolean) => void
}) {
  const [muted, setMuted] = useState(false)
  return (
    <I18nProvider store={jaStore}>
      <NarrationProvider controller={controller} gateway={gateway}>
        <NarrationSettings
          heading="音声"
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

function setup(onMutedChange?: (muted: boolean) => void) {
  const gateway = new DemoNarrationGateway()
  const controller = new NarrationController(gateway)
  render(
    <Harness
      controller={controller}
      gateway={gateway}
      onMutedChange={onMutedChange}
    />,
  )
  return { controller, gateway }
}

describe("NarrationSettings", () => {
  it("shows the quiet local-only source and default-off state", async () => {
    setup()

    expect(
      await screen.findByText("App-owned · background support"),
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
    const controller = new NarrationController(gateway)
    render(<Harness controller={controller} gateway={gateway} />)

    expect(
      await screen.findByText("ローカル音声を利用できません"),
    ).toBeVisible()
    expect(screen.getByText("NARRATION-SETTINGS-READ")).toBeVisible()
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeEnabled()
  })

  it("persists a verified voice and rate before showing the test caption", async () => {
    const user = userEvent.setup()
    const { controller } = setup()
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
    expect(await screen.findByText("テスト字幕")).toBeVisible()
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

  it("mutes immediately and resets to safe defaults after confirmation", async () => {
    const user = userEvent.setup()
    const onMutedChange = vi.fn()
    const { controller } = setup(onMutedChange)
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
})
