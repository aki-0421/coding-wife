import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { App } from "@/app/App"
import {
  createLocalePreferenceStore,
  detectSupportedLocale,
} from "@/features/localization"
import { DemoTransport } from "@/features/runtime"

describe("localization foundation", () => {
  it("selects Japanese when any OS language tag starts with ja", () => {
    expect(detectSupportedLocale(["en-US", "ja-JP"])).toBe("ja")
    expect(detectSupportedLocale(["en-US"])).toBe("en")
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

    await user.click(screen.getByRole("button", { name: "日本語" }))

    expect(
      screen.getByRole("heading", { level: 1, name: "アプリ基盤" }),
    ).toBeInTheDocument()
    expect(document.documentElement).toHaveAttribute("lang", "ja")
  })
})
