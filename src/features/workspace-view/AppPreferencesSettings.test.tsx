import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { I18nProvider, useI18n } from "@/features/localization"
import {
  AppPreferencesBoundaryError,
  AppPreferencesController,
  AppPreferencesProvider,
  DemoAppPreferencesGateway,
  type AppPreferencesGateway,
  type AppPreferencesSnapshotV2,
  type AppPreferencesUpdateRequestV2,
} from "@/features/preferences"
import type { RuntimeState } from "@/features/runtime"
import {
  DemoNativeReadinessGateway,
  NativeReadinessController,
  NativeReadinessProvider,
} from "@/features/readiness"
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
    appVersion: "0.1.3",
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
      runtimeState={runtimeState}
    />
  )
}

function renderSettings(controller: AppPreferencesController) {
  return render(
    <NativeReadinessProvider
      controller={
        new NativeReadinessController(new DemoNativeReadinessGateway())
      }
    >
      <AppPreferencesProvider controller={controller}>
        <I18nProvider preferencesController={controller}>
          <SettingsHarness />
        </I18nProvider>
      </AppPreferencesProvider>
    </NativeReadinessProvider>,
  )
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
): AppPreferencesSnapshotV2 {
  return {
    schemaVersion: 2,
    preferences: {
      schemaVersion: 2,
      version,
      snapshotId: `123e4567-e89b-42d3-a456-${String(version + 1).padStart(12, "0")}`,
      locale,
    },
    persistence: "native",
    recoveryCode: null,
  }
}

class DeferredNativePreferencesGateway implements AppPreferencesGateway {
  readonly kind = "native" as const
  readonly updates: AppPreferencesUpdateRequestV2[] = []
  readonly updateResults: Deferred<AppPreferencesSnapshotV2>[] = []
  durable = nativeSnapshot(0, "en")

  get(): Promise<AppPreferencesSnapshotV2> {
    return Promise.resolve(this.durable)
  }

  update(
    request: AppPreferencesUpdateRequestV2,
  ): Promise<AppPreferencesSnapshotV2> {
    this.updates.push(request)
    const result = deferred<AppPreferencesSnapshotV2>()
    this.updateResults.push(result)
    return result.promise
  }
}

function boundaryError() {
  return new AppPreferencesBoundaryError({
    code: "APP-PREFERENCES-WRITE",
    operation: "app_preferences_update",
    recoverable: true,
    userMessageKey: "preferences.error.generic",
    detailRef: "app-preferences-v2",
  })
}

describe("AppPreferencesSettings", () => {
  it("shows only language and app version in General", async () => {
    const controller = new AppPreferencesController(
      new DemoAppPreferencesGateway(),
      "en",
    )
    renderSettings(controller)

    expect(await screen.findByText("Language")).toBeVisible()
    expect(screen.getByText("App version")).toBeVisible()
    expect(screen.getByText("0.1.3")).toBeVisible()
    expect(screen.queryByText("Reduced motion")).toBeNull()
    expect(screen.queryByText("Character visibility")).toBeNull()
    expect(
      screen.queryByText("Demo memory · resets when this preview restarts"),
    ).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Reset preferences" }),
    ).toBeNull()
    expect(screen.queryByRole("button", { name: "Reset UI state" })).toBeNull()
  })

  it("does not expose native persistence or preference record versions", async () => {
    const gateway = new DeferredNativePreferencesGateway()
    gateway.durable = nativeSnapshot(9, "ja")
    renderSettings(new AppPreferencesController(gateway, "ja"))

    expect(
      await screen.findByRole("heading", { level: 2, name: "一般" }),
    ).toBeVisible()
    expect(screen.queryByText("ネイティブ設定 · バージョン 9")).toBeNull()
    expect(screen.getByText("アプリバージョン")).toBeVisible()
    expect(screen.getByText("0.1.3")).toBeVisible()
  })

  it("applies locale copy only after the native save succeeds", async () => {
    const user = userEvent.setup()
    const gateway = new DeferredNativePreferencesGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    renderSettings(controller)

    await user.click(screen.getByRole("radio", { name: "日本語" }))
    expect(screen.getByText("Saving preferences…")).toBeVisible()
    expect(
      screen.getByRole("heading", { level: 2, name: "General" }),
    ).toBeVisible()

    gateway.durable = nativeSnapshot(1, "ja")
    gateway.updateResults[0]?.resolve(gateway.durable)
    expect(
      await screen.findByRole("heading", { level: 2, name: "一般" }),
    ).toBeVisible()
    expect(document.documentElement).toHaveAttribute("lang", "ja")
  })

  it("retries a failed locale without exposing reset actions", async () => {
    const user = userEvent.setup()
    const gateway = new DeferredNativePreferencesGateway()
    const controller = new AppPreferencesController(gateway, "en")
    await controller.initialize()
    renderSettings(controller)

    await user.click(screen.getByRole("radio", { name: "日本語" }))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await waitFor(() => expect(gateway.updates).toHaveLength(attempt + 1))
      gateway.updateResults[attempt]?.reject(boundaryError())
    }

    const alert = await screen.findByRole("alert")
    expect(within(alert).getByText("APP-PREFERENCES-WRITE")).toBeVisible()
    expect(within(alert).queryByRole("button", { name: /Reset/ })).toBeNull()
    await user.click(within(alert).getByRole("button", { name: "Retry" }))

    await waitFor(() => expect(gateway.updates).toHaveLength(4))
    gateway.durable = nativeSnapshot(1, "ja")
    gateway.updateResults[3]?.resolve(gateway.durable)
    expect(
      await screen.findByRole("heading", { level: 2, name: "一般" }),
    ).toBeVisible()
  })

  it("shows only the sanitized recovery code", async () => {
    const recovery: AppPreferencesSnapshotV2 = {
      schemaVersion: 2,
      preferences: {
        schemaVersion: 2,
        version: 0,
        snapshotId: "00000000-0000-0000-0000-000000000000",
        locale: "en",
      },
      persistence: "native",
      recoveryCode: "APP-PREFERENCES-CORRUPT",
    }
    const gateway: AppPreferencesGateway = {
      kind: "native",
      get: () => Promise.resolve(recovery),
      update: () => Promise.resolve(recovery),
    }
    renderSettings(new AppPreferencesController(gateway, "en"))

    expect(await screen.findByText("Preferences need recovery")).toBeVisible()
    expect(screen.getByText("APP-PREFERENCES-CORRUPT")).toBeVisible()
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible()
    expect(screen.queryByRole("button", { name: /Reset/ })).toBeNull()
    expect(screen.queryByText(/token=|raw/i)).toBeNull()
  })
})
