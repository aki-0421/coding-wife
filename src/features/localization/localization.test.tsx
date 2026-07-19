import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { App } from "@/app/App"
import {
  createLocalePreferenceStore,
  detectSystemLocale,
  detectSupportedLocale,
  type LocalePreferenceStore,
  type SupportedLocale,
} from "@/features/localization"
import { DemoTransport } from "@/features/runtime"

class FailingOnceLocaleStore implements LocalePreferenceStore {
  readonly persistence = "session-only"
  private locale: SupportedLocale = "en"
  private writeCount = 0

  read(): SupportedLocale {
    return this.locale
  }

  write(locale: SupportedLocale): boolean {
    this.writeCount += 1
    if (this.writeCount === 1) {
      return false
    }

    this.locale = locale
    return true
  }
}

describe("localization foundation", () => {
  it("uses only the primary OS language tag with a language fallback", () => {
    expect(detectSupportedLocale(["en-US", "ja-JP"], "ja-JP")).toBe("en")
    expect(detectSupportedLocale(["ja-JP", "en-US"], "en-US")).toBe("ja")
    expect(detectSupportedLocale([], "ja-JP")).toBe("ja")
    expect(detectSystemLocale()).toBe(
      detectSupportedLocale(navigator.languages, navigator.language),
    )
  })

  it("keeps browser persistence inside the explicit demo namespace", () => {
    const store = createLocalePreferenceStore("demo")

    expect(store.persistence).toBe("demo-local")
    expect(store.write("ja")).toBe(true)
    expect(store.read()).toBe("ja")
    expect(window.localStorage.getItem("coding-wife:demo:locale:v1")).toBe("ja")
  })

  it("switches all visible foundation copy without a restart", async () => {
    const user = userEvent.setup()
    const localeStore = createLocalePreferenceStore("tauri")

    render(<App localeStore={localeStore} transport={new DemoTransport()} />)

    await user.click(
      screen.getAllByRole("button", { name: "App settings" })[0]!,
    )
    await user.click(screen.getByRole("radio", { name: "日本語" }))

    expect(
      screen.getByRole("heading", { level: 1, name: "アプリ設定" }),
    ).toBeInTheDocument()
    expect(document.documentElement).toHaveAttribute("lang", "ja")
  })

  it("keeps the current locale when persistence fails and retries it", async () => {
    const user = userEvent.setup()
    const localeStore = new FailingOnceLocaleStore()

    render(<App localeStore={localeStore} transport={new DemoTransport()} />)

    await user.click(
      screen.getAllByRole("button", { name: "App settings" })[0]!,
    )
    const japaneseButton = screen.getByRole("radio", { name: "日本語" })
    const englishButton = screen.getByRole("radio", { name: "English" })

    expect(englishButton).toHaveAttribute("aria-checked", "true")
    await user.click(japaneseButton)

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "App settings",
      }),
    ).toBeVisible()
    expect(document.documentElement).toHaveAttribute("lang", "en")
    expect(englishButton).toHaveAttribute("aria-checked", "true")
    expect(japaneseButton).toHaveAttribute("aria-checked", "false")
    expect(
      screen.getByText(
        "The language could not be saved. The previous language is unchanged.",
      ),
    ).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Retry" }))

    expect(
      screen.getByRole("heading", { level: 1, name: "アプリ設定" }),
    ).toBeVisible()
    expect(document.documentElement).toHaveAttribute("lang", "ja")
    expect(japaneseButton).toHaveAttribute("aria-checked", "true")
    expect(screen.queryByText(/could not be saved/i)).not.toBeInTheDocument()
  })
})
