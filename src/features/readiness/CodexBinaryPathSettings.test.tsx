import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { I18nProvider } from "@/features/localization"
import { createLocalePreferenceStore } from "@/features/localization/locale-store"
import { CodexBinaryPathSettings } from "@/features/readiness/CodexBinaryPathSettings"
import {
  readinessCheckIds,
  type NativeReadinessSnapshotV1,
} from "@/features/readiness/contracts"
import { NativeReadinessController } from "@/features/readiness/controller"
import { NativeReadinessProvider } from "@/features/readiness/provider"
import type { NativeReadinessGateway } from "@/features/readiness/transport"

function snapshot(source: "automatic" | "explicit"): NativeReadinessSnapshotV1 {
  const checkedAt = "2026-07-20T00:00:00.000Z"
  return {
    schemaVersion: 1,
    snapshotId:
      source === "automatic"
        ? "123e4567-e89b-42d3-a456-426614174001"
        : "123e4567-e89b-42d3-a456-426614174002",
    checkedAt,
    source: "native",
    checks: readinessCheckIds.map((id) => ({
      id,
      status: id === "codex" ? "blocked" : "ready",
      checkedAt,
      code:
        id === "codex"
          ? "READINESS-CODEX-AUTH-REQUIRED"
          : `READINESS-${id.toUpperCase().replace("_", "-")}-READY`,
      recoverable: id === "codex",
      recoveryAction: id === "codex" ? "authenticate_codex" : "none",
      facts:
        id === "codex"
          ? ([
              { key: "codex_binary", value: "trusted" },
              { key: "codex_binary_source", value: source },
            ] as const)
          : [],
    })),
  }
}

describe("CodexBinaryPathSettings", () => {
  it("verifies a custom path and can return to automatic detection", async () => {
    const user = userEvent.setup()
    const configureCodexBinary = vi.fn((path: string | null) =>
      Promise.resolve(snapshot(path === null ? "automatic" : "explicit")),
    )
    const gateway: NativeReadinessGateway = {
      kind: "native",
      run: () => Promise.resolve(snapshot("automatic")),
      configureCodexBinary,
      copy: (snapshotId) =>
        Promise.resolve({ schemaVersion: 1, snapshotId, summary: "safe" }),
    }
    const store = createLocalePreferenceStore("tauri")
    store.write("en")
    render(
      <I18nProvider store={store}>
        <NativeReadinessProvider
          controller={new NativeReadinessController(gateway)}
        >
          <CodexBinaryPathSettings />
        </NativeReadinessProvider>
      </I18nProvider>,
    )

    const input = await screen.findByRole("textbox", {
      name: "Custom Codex CLI path",
    })
    await user.type(input, "/Users/test/.local/bin/codex")
    await user.click(screen.getByRole("button", { name: "Use this path" }))
    expect(configureCodexBinary).toHaveBeenLastCalledWith(
      "/Users/test/.local/bin/codex",
    )
    expect(
      await screen.findByText("A custom path is currently configured."),
    ).toBeVisible()

    await user.click(
      screen.getByRole("button", { name: "Use automatic detection" }),
    )
    expect(configureCodexBinary).toHaveBeenLastCalledWith(null)
  })
})
