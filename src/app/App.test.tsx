import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { App } from "@/app/App"
import { createLocalePreferenceStore } from "@/features/localization"
import { DemoTransport, type AppTransport } from "@/features/runtime"
import type { IpcCommand, IpcRequestMap, IpcResponseMap } from "@/lib/contracts"

class PendingDemoTransport implements AppTransport {
  readonly kind = "demo"

  request<K extends IpcCommand>(
    command: K,
    payload: IpcRequestMap[K],
  ): Promise<IpcResponseMap[K]> {
    void command
    void payload
    return new Promise(() => undefined)
  }
}

describe("App foundation shell", () => {
  it("keeps the localized loading state visible while runtime checks are pending", () => {
    render(
      <App
        localeStore={createLocalePreferenceStore("tauri")}
        transport={new PendingDemoTransport()}
      />,
    )

    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking the local runtime…",
    )
  })

  it("labels browser execution as demo mode instead of native success", async () => {
    render(
      <App
        localeStore={createLocalePreferenceStore("tauri")}
        transport={new DemoTransport()}
      />,
    )

    expect(await screen.findByText(/Runtime mode: Browser demo/i)).toBeVisible()
    expect(
      screen.getByText(
        "Demo mode does not connect to Codex, Git, Live2D, or local history.",
      ),
    ).toBeVisible()
    expect(screen.getAllByText("Not configured")).toHaveLength(4)
  })
})
