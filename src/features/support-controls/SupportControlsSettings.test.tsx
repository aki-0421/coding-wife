import { StrictMode } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import {
  I18nProvider,
  type LocalePreferenceStore,
  type SupportedLocale,
} from "@/features/localization"
import { SupportControlsSettings } from "@/features/support-controls/SupportControlsSettings"
import {
  DemoSupportControlsGateway,
  SupportControlsBoundaryError,
  type SupportControlsGateway,
} from "@/features/support-controls/transport"

class MemoryLocaleStore implements LocalePreferenceStore {
  public readonly persistence = "session-only"

  public constructor(private value: SupportedLocale) {}

  public read(): SupportedLocale {
    return this.value
  }

  public write(locale: SupportedLocale): boolean {
    this.value = locale
    return true
  }
}

function renderSettings(locale: SupportedLocale) {
  return render(
    <I18nProvider store={new MemoryLocaleStore(locale)}>
      <SupportControlsSettings
        gateway={new DemoSupportControlsGateway()}
        gatewayKind="demo"
      />
    </I18nProvider>,
  )
}

describe("SupportControlsSettings", () => {
  it("shows only implemented controls and an honest no-model fallback", async () => {
    const user = userEvent.setup()
    renderSettings("en")
    expect(
      await screen.findByRole("heading", { level: 2, name: "Support" }),
    ).toBeVisible()
    expect(screen.getByText("Deterministic fallback is active")).toBeVisible()
    expect(screen.getByText("CODEX-SUPPORT-DEMO-NO-MODEL")).toBeVisible()
    expect(screen.queryByText(/presence narration/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/decision explainer/i)).not.toBeInTheDocument()
    expect(screen.getByText("0.144.5 · 5e29ab10ca1171be")).toBeVisible()
    expect(screen.getByText("gpt-5.6-sol · low")).toBeVisible()

    const global = screen.getByRole("switch", {
      name: "Enable isolated support",
    })
    expect(global).toBeChecked()
    await user.click(global)
    await waitFor(() => expect(global).not.toBeChecked())
    expect(screen.getAllByText("Disabled globally").length).toBeGreaterThan(0)
    expect(screen.getByText("CODEX-SUPPORT-DISABLED")).toBeVisible()
  })

  it("renders the same control and safety evidence in Japanese", async () => {
    renderSettings("ja")
    expect(
      await screen.findByRole("heading", { level: 2, name: "支援" }),
    ).toBeVisible()
    expect(
      screen.getByRole("switch", { name: "分離支援を有効化" }),
    ).toBeVisible()
    expect(screen.getByRole("switch", { name: "コミット説明" })).toBeVisible()
    expect(screen.getByText("決定的fallbackを使用中")).toBeVisible()
  })

  it("loads after the development Strict Mode effect replay", async () => {
    render(
      <StrictMode>
        <I18nProvider store={new MemoryLocaleStore("en")}>
          <SupportControlsSettings
            gateway={new DemoSupportControlsGateway()}
            gatewayKind="demo"
          />
        </I18nProvider>
      </StrictMode>,
    )
    expect(
      await screen.findByRole("switch", { name: "Enable isolated support" }),
    ).toBeVisible()
    expect(
      screen.queryByText("Loading support controls"),
    ).not.toBeInTheDocument()
  })

  it("makes an initial native boundary failure visible and retryable", async () => {
    const user = userEvent.setup()
    const demo = new DemoSupportControlsGateway()
    let reads = 0
    const gateway: SupportControlsGateway = {
      kind: "demo",
      get: () => {
        reads += 1
        return reads === 1
          ? Promise.reject(new SupportControlsBoundaryError())
          : demo.get()
      },
      update: (request) => demo.update(request),
    }
    render(
      <I18nProvider store={new MemoryLocaleStore("en")}>
        <SupportControlsSettings gateway={gateway} gatewayKind="demo" />
      </I18nProvider>,
    )
    expect(
      await screen.findByText("Support settings were not updated"),
    ).toBeVisible()
    expect(screen.getByText("CODEX-SUPPORT-IPC-UNAVAILABLE")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(
      await screen.findByRole("switch", { name: "Enable isolated support" }),
    ).toBeVisible()
  })
})
