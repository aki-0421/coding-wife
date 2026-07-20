import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { I18nProvider } from "@/features/localization"
import { createLocalePreferenceStore } from "@/features/localization/locale-store"
import {
  NativeReadinessController,
  type DiagnosticsClipboard,
} from "@/features/readiness/controller"
import {
  readinessCheckIds,
  type NativeReadinessSnapshotV1,
} from "@/features/readiness/contracts"
import { NativeReadinessDiagnostics } from "@/features/readiness/NativeReadinessDiagnostics"
import { NativeReadinessProvider } from "@/features/readiness/provider"
import {
  DemoNativeReadinessGateway,
  type NativeReadinessGateway,
} from "@/features/readiness/transport"

function snapshot(sequence: number): NativeReadinessSnapshotV1 {
  const checkedAt = `2026-07-18T00:00:0${sequence}.000Z`
  return {
    schemaVersion: 1,
    snapshotId: `123e4567-e89b-42d3-a456-${String(sequence).padStart(12, "0")}`,
    checkedAt,
    source: "native",
    checks: readinessCheckIds.map((id) => ({
      id,
      status: id === "codex" ? "blocked" : "ready",
      checkedAt,
      code: `READINESS-${id.toUpperCase().replace("_", "-")}-${id === "codex" ? "AUTH-REQUIRED" : "READY"}`,
      recoverable: id === "codex",
      recoveryAction: id === "codex" ? "authenticate_codex" : "none",
      facts: [],
    })),
  }
}

class DeferredGateway implements NativeReadinessGateway {
  readonly kind = "native" as const
  readonly resolvers: Array<(snapshot: NativeReadinessSnapshotV1) => void> = []

  run(): Promise<NativeReadinessSnapshotV1> {
    return new Promise((resolve) => this.resolvers.push(resolve))
  }

  configureCodexBinary(): Promise<NativeReadinessSnapshotV1> {
    return this.run()
  }

  copy(snapshotId: string) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      snapshotId,
      summary: "Coding Wife diagnostics v1\nsource=native\n",
    })
  }
}

function renderDiagnostics(
  controller: NativeReadinessController,
  locale: "en" | "ja" = "en",
) {
  const store = createLocalePreferenceStore("tauri")
  store.write(locale)
  return render(
    <I18nProvider store={store}>
      <NativeReadinessProvider controller={controller}>
        <NativeReadinessDiagnostics />
      </NativeReadinessProvider>
    </I18nProvider>,
  )
}

describe("NativeReadinessDiagnostics", () => {
  it("labels demo capabilities honestly and never renders Ready", async () => {
    renderDiagnostics(
      new NativeReadinessController(new DemoNativeReadinessGateway()),
    )
    await screen.findByText("Demo preview · no native readiness")
    expect(screen.getAllByRole("article")).toHaveLength(6)
    expect(screen.queryByText("Ready")).not.toBeInTheDocument()
  })

  it("keeps the trigger focused and the prior snapshot visible while rechecking", async () => {
    const user = userEvent.setup()
    const gateway = new DeferredGateway()
    const controller = new NativeReadinessController(gateway)
    renderDiagnostics(controller)
    gateway.resolvers[0]!(snapshot(1))
    await screen.findByText(snapshot(1).snapshotId)

    const trigger = screen.getByRole("button", { name: "Recheck" })
    await user.click(trigger)
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByText(snapshot(1).snapshotId)).toBeInTheDocument()
    expect(
      document.querySelector('[data-native-readiness-state="rechecking"]'),
    ).toHaveAttribute("aria-busy", "true")

    gateway.resolvers[1]!(snapshot(2))
    await screen.findByText(snapshot(2).snapshotId)
    expect(trigger).toHaveFocus()
    expect(
      document.querySelector("[data-diagnostics-announcement]"),
    ).toHaveTextContent("Diagnostics updated.")
    expect(
      document.querySelector("[data-diagnostics-attention-announcement]"),
    ).toHaveTextContent(
      "Diagnostics updated. One or more capabilities are blocked or unavailable.",
    )
  })

  it("announces a successful all-ready recheck politely without an assertive alert", async () => {
    const gateway = new DeferredGateway()
    const controller = new NativeReadinessController(gateway)
    renderDiagnostics(controller, "ja")
    const allReady = (sequence: number): NativeReadinessSnapshotV1 => ({
      ...snapshot(sequence),
      checks: snapshot(sequence).checks.map((check) => ({
        ...check,
        status: "ready",
        code: `READINESS-${check.id.toUpperCase().replace("_", "-")}-READY`,
        recoverable: false,
        recoveryAction: "none",
      })),
    })
    gateway.resolvers[0]!(allReady(1))
    await screen.findByText(allReady(1).snapshotId)
    await userEvent.click(screen.getByRole("button", { name: "再確認" }))
    gateway.resolvers[1]!(allReady(2))
    await screen.findByText(allReady(2).snapshotId)
    expect(
      document.querySelector("[data-diagnostics-announcement]"),
    ).toHaveTextContent("診断を更新しました。")
    expect(
      document.querySelector("[data-diagnostics-attention-announcement]"),
    ).toHaveTextContent("")
  })

  it("copies the sanitized summary without moving focus", async () => {
    const user = userEvent.setup()
    const writeText = vi.fn()
    const clipboard: DiagnosticsClipboard = { writeText }
    const controller = new NativeReadinessController(
      new DemoNativeReadinessGateway(),
      clipboard,
    )
    renderDiagnostics(controller, "ja")
    const trigger = await screen.findByRole("button", {
      name: "安全な概要をコピー",
    })
    await user.click(trigger)
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    expect(trigger).toHaveFocus()
    expect(screen.getByText("安全な概要をコピーしました。")).toBeInTheDocument()
  })
})
