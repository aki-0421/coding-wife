import { StrictMode } from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { I18nProvider, useI18n } from "@/features/localization"
import {
  AppPreferencesBoundaryError,
  AppPreferencesController,
  AppPreferencesProvider,
  DemoAppPreferencesGateway,
  type AppPreferencesGateway,
  type AppPreferencesResetRequestV1,
  type AppPreferencesSnapshotV1,
  type AppPreferencesUpdateRequestV1,
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

function renderSettings(
  controller: AppPreferencesController,
  { strictMode = false }: { readonly strictMode?: boolean } = {},
) {
  const settings = (
    <AppPreferencesProvider controller={controller}>
      <I18nProvider preferencesController={controller}>
        <SettingsHarness />
      </I18nProvider>
    </AppPreferencesProvider>
  )
  return render(strictMode ? <StrictMode>{settings}</StrictMode> : settings)
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept
    reject = deny
  })
  return { promise, resolve, reject }
}

function nativeSnapshot(
  version: number,
  locale: "ja" | "en",
  overrides: Partial<AppPreferencesSnapshotV1["preferences"]> = {},
): AppPreferencesSnapshotV1 {
  return {
    schemaVersion: 1,
    preferences: {
      schemaVersion: 1,
      version,
      snapshotId: `123e4567-e89b-42d3-a456-${String(version + 1).padStart(12, "0")}`,
      locale,
      reducedMotion: "system",
      characterVisibility: "visible",
      ...overrides,
    },
    persistence: "native",
    recoveryCode: null,
  }
}

class DeferredNativePreferencesGateway implements AppPreferencesGateway {
  readonly kind = "native" as const
  readonly updates: AppPreferencesUpdateRequestV1[] = []
  readonly updateResults: Deferred<AppPreferencesSnapshotV1>[] = []
  readonly resets: AppPreferencesResetRequestV1[] = []
  readonly resetResults: Deferred<AppPreferencesSnapshotV1>[] = []
  getCalls = 0
  durable = nativeSnapshot(0, "en")
  deferResets = false

  get(): Promise<AppPreferencesSnapshotV1> {
    this.getCalls += 1
    return Promise.resolve(this.durable)
  }

  update(
    request: AppPreferencesUpdateRequestV1,
  ): Promise<AppPreferencesSnapshotV1> {
    this.updates.push(request)
    const result = deferred<AppPreferencesSnapshotV1>()
    this.updateResults.push(result)
    return result.promise
  }

  reset(
    request: AppPreferencesResetRequestV1,
  ): Promise<AppPreferencesSnapshotV1> {
    this.resets.push(request)
    if (!this.deferResets) {
      return Promise.resolve(
        nativeSnapshot(request.expectedVersion + 1, request.defaultLocale),
      )
    }
    const result = deferred<AppPreferencesSnapshotV1>()
    this.resetResults.push(result)
    return result.promise
  }
}

function boundaryError(code = "APP-PREFERENCES-WRITE") {
  return new AppPreferencesBoundaryError({
    code,
    operation: "app_preferences_update",
    recoverable: true,
    userMessageKey: "preferences.error.generic",
    detailRef: "app-preferences-v1",
  })
}

async function rejectBoundedUpdates(
  gateway: DeferredNativePreferencesGateway,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitFor(() => expect(gateway.updates).toHaveLength(attempt + 1))
    gateway.updateResults[attempt]?.reject(boundaryError())
  }
}

function alertContaining(text: string): HTMLElement {
  const alert = screen.getByText(text).closest('[role="alert"]')
  if (!(alert instanceof HTMLElement)) throw new Error("Expected alert")
  return alert
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
    expect(within(dialog).getByRole("button", { name: "閉じる" })).toBeVisible()
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

  it("shows the pending native locale but applies app copy only after save succeeds", async () => {
    const user = userEvent.setup()
    const gateway = new DeferredNativePreferencesGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    renderSettings(controller)

    const japanese = screen.getByRole("radio", { name: "日本語" })
    await user.click(japanese)

    expect(japanese).toHaveAttribute("aria-checked", "true")
    expect(japanese).not.toBeDisabled()
    expect(japanese).toHaveFocus()
    expect(screen.getByText("Saving preferences…")).toBeVisible()
    expect(
      screen.getByRole("heading", { level: 2, name: "General" }),
    ).toBeVisible()
    expect(document.documentElement).toHaveAttribute("lang", "en")

    gateway.updateResults[0]?.resolve(nativeSnapshot(1, "ja"))
    expect(
      await screen.findByRole("heading", { level: 2, name: "一般" }),
    ).toBeVisible()
    expect(document.documentElement).toHaveAttribute("lang", "ja")
  })

  it("rolls back a failed native locale and retries the latest intent", async () => {
    const user = userEvent.setup()
    const gateway = new DeferredNativePreferencesGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    renderSettings(controller)

    await user.click(screen.getByRole("radio", { name: "日本語" }))
    await rejectBoundedUpdates(gateway)

    const errorMessage = await screen.findByText(
      "The language could not be saved. The previous language is unchanged.",
    )
    const error = errorMessage.parentElement
    expect(error).not.toBeNull()
    if (error === null) throw new Error("Expected an assertive locale error")
    expect(error).toHaveAttribute("role", "alert")
    expect(error).toBeVisible()
    expect(screen.getByRole("radio", { name: "English" })).toHaveAttribute(
      "aria-checked",
      "true",
    )
    expect(document.documentElement).toHaveAttribute("lang", "en")

    await user.click(within(error).getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(gateway.updates).toHaveLength(4))
    gateway.updateResults[3]?.resolve(nativeSnapshot(1, "ja"))
    expect(
      await screen.findByRole("heading", { level: 2, name: "一般" }),
    ).toBeVisible()
  })

  it("restores mounted intent tracking under StrictMode and exposes locale retry", async () => {
    const user = userEvent.setup()
    const gateway = new DeferredNativePreferencesGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    renderSettings(controller, { strictMode: true })

    await user.click(screen.getByRole("radio", { name: "日本語" }))
    await rejectBoundedUpdates(gateway)

    const languageError = await screen.findByText(
      "The language could not be saved. The previous language is unchanged.",
    )
    const localeAlert = languageError.parentElement
    expect(localeAlert).not.toBeNull()
    if (localeAlert === null) throw new Error("Expected locale retry alert")
    expect(localeAlert).toHaveAttribute("role", "alert")
    expect(screen.getByText("Preferences were not saved")).toBeVisible()

    await user.click(within(localeAlert).getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(gateway.updates).toHaveLength(4))
    gateway.updateResults[3]?.resolve(nativeSnapshot(1, "ja"))
    expect(
      await screen.findByRole("heading", { level: 2, name: "一般" }),
    ).toBeVisible()
  })

  it("retries the latest non-locale preference from the safe error alert", async () => {
    const user = userEvent.setup()
    const gateway = new DeferredNativePreferencesGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    renderSettings(controller)

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Reduced motion" }),
      "on",
    )
    await rejectBoundedUpdates(gateway)

    await screen.findByText("Preferences were not saved")
    const alert = alertContaining("Preferences were not saved")
    expect(within(alert).getByText("APP-PREFERENCES-WRITE")).toBeVisible()
    expect(
      within(alert).getByRole("button", { name: "Reset preferences" }),
    ).toBeVisible()
    const retry = within(alert).getByRole("button", { name: "Retry" })
    retry.focus()
    expect(retry).toHaveFocus()
    await user.click(retry)

    await waitFor(() => expect(gateway.updates).toHaveLength(4))
    expect(gateway.updates[3]).toMatchObject({
      expectedVersion: 0,
      reducedMotion: "on",
    })
    gateway.updateResults[3]?.resolve(
      nativeSnapshot(1, "en", { reducedMotion: "on" }),
    )
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
    expect(
      screen.getByRole("combobox", { name: "Reduced motion" }),
    ).toHaveValue("on")
  })

  it("coalesces rapid Japanese to English to Japanese intent without snapping back", async () => {
    const user = userEvent.setup()
    const gateway = new DeferredNativePreferencesGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    renderSettings(controller)

    await user.click(screen.getByRole("radio", { name: "日本語" }))
    await user.click(screen.getByRole("radio", { name: "English" }))
    const japanese = screen.getByRole("radio", { name: "日本語" })
    await user.click(japanese)

    expect(japanese).toHaveAttribute("aria-checked", "true")
    expect(japanese).toHaveFocus()
    expect(gateway.updates).toHaveLength(1)
    expect(
      screen.getByRole("heading", { level: 2, name: "General" }),
    ).toBeVisible()

    gateway.updateResults[0]?.resolve(nativeSnapshot(1, "ja"))
    expect(
      await screen.findByRole("heading", { level: 2, name: "一般" }),
    ).toBeVisible()
    expect(gateway.updates).toHaveLength(1)
  })

  it("never applies a late locale response and settles safely after unmount", async () => {
    const user = userEvent.setup()
    const gateway = new DeferredNativePreferencesGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    const view = renderSettings(controller)

    await user.click(screen.getByRole("radio", { name: "日本語" }))
    await user.click(screen.getByRole("radio", { name: "English" }))
    gateway.updateResults[0]?.resolve(nativeSnapshot(1, "ja"))
    await waitFor(() => expect(gateway.updates).toHaveLength(2))

    expect(
      screen.getByRole("heading", { level: 2, name: "General" }),
    ).toBeVisible()
    expect(document.documentElement).toHaveAttribute("lang", "en")
    expect(screen.queryByRole("heading", { level: 2, name: "一般" })).toBeNull()

    view.unmount()
    gateway.updateResults[1]?.resolve(nativeSnapshot(2, "en"))
    await waitFor(() =>
      expect(controller.getSnapshot()).toMatchObject({
        status: "ready",
        snapshot: { preferences: { locale: "en", version: 2 } },
      }),
    )
  })

  it("locks reset dismissal while saving, then closes and restores focus", async () => {
    const user = userEvent.setup()
    const gateway = new DeferredNativePreferencesGateway()
    gateway.deferResets = true
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    renderSettings(controller)

    const trigger = screen.getByRole("button", { name: "Reset preferences" })
    await user.click(trigger)
    const dialog = screen.getByRole("dialog", {
      name: "Reset app preferences?",
    })
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus()
    await user.click(
      within(dialog).getByRole("button", { name: "Reset preferences" }),
    )

    const progress = within(dialog).getByRole("button", {
      name: "Resetting…",
    })
    expect(progress).toBeDisabled()
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled()
    expect(within(dialog).queryByRole("button", { name: "Close" })).toBeNull()
    await user.keyboard("{Escape}")
    expect(dialog).toBeVisible()

    gateway.resetResults[0]?.resolve(nativeSnapshot(1, "en"))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(trigger).toHaveFocus()
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      snapshot: { preferences: { version: 1 } },
    })
  })

  it("keeps a failed reset through dialog cancel and retries the reset operation", async () => {
    const user = userEvent.setup()
    const gateway = new DeferredNativePreferencesGateway()
    gateway.deferResets = true
    gateway.durable = nativeSnapshot(5, "en", {
      reducedMotion: "on",
      characterVisibility: "hidden",
    })
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    renderSettings(controller)

    const trigger = screen.getByRole("button", { name: "Reset preferences" })
    await user.click(trigger)
    const dialog = screen.getByRole("dialog", {
      name: "Reset app preferences?",
    })
    await user.click(
      within(dialog).getByRole("button", { name: "Reset preferences" }),
    )
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await waitFor(() =>
        expect(gateway.resetResults).toHaveLength(attempt + 1),
      )
      gateway.resetResults[attempt]?.reject(boundaryError())
    }

    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Reset preferences" }),
      ).toBeEnabled(),
    )
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled()
    expect(dialog).toBeVisible()
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      snapshot: {
        preferences: {
          version: 5,
          reducedMotion: "on",
          characterVisibility: "hidden",
        },
      },
      errorCode: "APP-PREFERENCES-WRITE",
    })

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(trigger).toHaveFocus()
    const alert = alertContaining("Preferences were not saved")
    await user.click(within(alert).getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(gateway.resetResults).toHaveLength(4))
    expect(gateway.resets[3]).toEqual({
      schemaVersion: 1,
      expectedVersion: 5,
      defaultLocale: "en",
    })
    gateway.resetResults[3]?.resolve(nativeSnapshot(6, "en"))
    await waitFor(() => expect(controller.getSnapshot().status).toBe("ready"))
    expect(controller.getSnapshot().snapshot.preferences).toMatchObject({
      version: 6,
      reducedMotion: "system",
      characterVisibility: "visible",
    })
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
