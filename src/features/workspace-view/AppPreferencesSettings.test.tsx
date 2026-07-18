import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { I18nProvider, useI18n } from "@/features/localization"
import {
  AppPreferencesController,
  AppPreferencesProvider,
  DemoAppPreferencesGateway,
  type AppPreferencesGateway,
  type AppPreferencesSnapshotV1,
} from "@/features/preferences"
import type { RuntimeState } from "@/features/runtime"
import { AppPreferencesSettings } from "@/features/workspace-view/AppPreferencesSettings"
import { getWorkspaceCopy } from "@/features/workspace-view/copy"

const runtimeState: RuntimeState = {
  status: "ready",
  health: {
    schemaVersion: 1,
    runtime: "demo",
    foundationState: "demo_only",
  },
  metadata: {
    schemaVersion: 1,
    runtime: "demo",
    appVersion: "demo",
    platform: "browser",
    architecture: "web",
    integrations: {
      codex: "not_configured",
      git: "not_configured",
      live2d: "not_configured",
      history: "not_configured",
    },
  },
}

function SettingsHarness() {
  const { locale } = useI18n()
  return (
    <AppPreferencesSettings
      copy={getWorkspaceCopy(locale)}
      onResetUi={() => undefined}
      runtimeState={runtimeState}
    />
  )
}

function renderSettings(controller: AppPreferencesController) {
  return render(
    <AppPreferencesProvider controller={controller}>
      <I18nProvider preferencesController={controller}>
        <SettingsHarness />
      </I18nProvider>
    </AppPreferencesProvider>,
  )
}

describe("AppPreferencesSettings", () => {
  it("labels demo memory honestly and applies all three preferences immediately", async () => {
    const user = userEvent.setup()
    const controller = new AppPreferencesController(
      new DemoAppPreferencesGateway(),
      "en",
    )
    renderSettings(controller)

    expect(
      await screen.findByText(
        /Demo memory · resets when this preview restarts/,
      ),
    ).toBeVisible()
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Reduced motion" }),
      "on",
    )
    await waitFor(() =>
      expect(controller.getSnapshot().snapshot.preferences.reducedMotion).toBe(
        "on",
      ),
    )

    expect(document.documentElement).toHaveAttribute(
      "data-reduced-motion",
      "true",
    )

    await user.click(screen.getByRole("switch", { name: "Character visible" }))
    await waitFor(() =>
      expect(
        controller.getSnapshot().snapshot.preferences.characterVisibility,
      ).toBe("hidden"),
    )

    await user.click(screen.getByRole("radio", { name: "日本語" }))
    expect(
      await screen.findByRole("heading", { level: 2, name: "一般" }),
    ).toBeVisible()
    expect(document.documentElement).toHaveAttribute("lang", "ja")
  })

  it("focuses the safe cancel action and resets only AppPreferencesV1 defaults", async () => {
    const user = userEvent.setup()
    const controller = new AppPreferencesController(
      new DemoAppPreferencesGateway(),
      "en",
    )
    await controller.initialize()
    await controller.update({
      locale: "ja",
      reducedMotion: "on",
      characterVisibility: "hidden",
    })
    renderSettings(controller)

    await user.click(screen.getByRole("button", { name: "設定をリセット" }))
    const dialog = screen.getByRole("dialog", {
      name: "アプリ設定をリセットしますか？",
    })
    const cancel = within(dialog).getByRole("button", { name: "キャンセル" })
    expect(cancel).toHaveFocus()
    expect(dialog).toHaveTextContent("AppPreferencesV1だけを置き換えます")

    await user.click(
      within(dialog).getByRole("button", { name: "設定をリセット" }),
    )
    await waitFor(() =>
      expect(controller.getSnapshot().snapshot.preferences).toMatchObject({
        locale: "en",
        reducedMotion: "system",
        characterVisibility: "visible",
      }),
    )
    expect(
      await screen.findByRole("heading", { level: 2, name: "General" }),
    ).toBeVisible()
  })

  it("shows only the sanitized recovery code and offers preference reset", async () => {
    const recovery: AppPreferencesSnapshotV1 = {
      schemaVersion: 1,
      preferences: {
        schemaVersion: 1,
        version: 0,
        snapshotId: "00000000-0000-0000-0000-000000000000",
        locale: "en",
        reducedMotion: "system",
        characterVisibility: "visible",
      },
      persistence: "native",
      recoveryCode: "APP-PREFERENCES-CORRUPT",
    }
    const gateway: AppPreferencesGateway = {
      kind: "native",
      get: () => Promise.resolve(recovery),
      update: () => Promise.resolve(recovery),
      reset: vi.fn(() =>
        Promise.resolve({
          ...recovery,
          preferences: {
            ...recovery.preferences,
            version: 1,
            snapshotId: "123e4567-e89b-42d3-a456-426614174000",
          },
          recoveryCode: null,
        }),
      ),
    }
    const controller = new AppPreferencesController(gateway, "en")
    renderSettings(controller)

    expect(await screen.findByText("Preferences need recovery")).toBeVisible()
    expect(screen.getByText("APP-PREFERENCES-CORRUPT")).toBeVisible()
    expect(screen.queryByText(/\/Users\/|token=|raw/i)).not.toBeInTheDocument()
    expect(
      screen.getAllByRole("button", { name: "Reset preferences" }),
    ).not.toHaveLength(0)
  })
})
