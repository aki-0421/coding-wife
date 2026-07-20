import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { I18nProvider } from "@/features/localization"
import { createLocalePreferenceStore } from "@/features/localization/locale-store"
import {
  readinessCheckIds,
  type NativeReadinessSnapshotV1,
} from "@/features/readiness/contracts"
import { NativeReadinessController } from "@/features/readiness/controller"
import { NativeReadinessProvider } from "@/features/readiness/provider"
import {
  SetupOverview,
  type SetupRequirementOverrides,
  shouldShowSetupOverview,
  unresolvedSetupRequirements,
} from "@/features/readiness/SetupOverview"
import type { NativeReadinessGateway } from "@/features/readiness/transport"

function readinessSnapshot(
  codexStatus: "ready" | "blocked" = "ready",
): NativeReadinessSnapshotV1 {
  const checkedAt = "2026-07-20T00:00:00.000Z"
  return {
    schemaVersion: 1,
    snapshotId: "123e4567-e89b-42d3-a456-426614174000",
    checkedAt,
    source: "native",
    checks: readinessCheckIds.map((id) => ({
      id,
      status: id === "codex" ? codexStatus : "ready",
      checkedAt,
      code:
        id === "codex" && codexStatus === "blocked"
          ? "READINESS-CODEX-DISCONNECTED"
          : `READINESS-${id.toUpperCase().replace("_", "-")}-READY`,
      recoverable: id === "codex" && codexStatus === "blocked",
      recoveryAction:
        id === "codex" && codexStatus === "blocked" ? "recheck" : "none",
      facts:
        id === "git"
          ? ([{ key: "git_executable", value: "available" }] as const)
          : [],
    })),
  }
}

function renderOverview(
  snapshot: NativeReadinessSnapshotV1,
  projectCount: number,
  locale: "en" | "ja" = "en",
  onAddProject = vi.fn(),
  requirementOverrides?: SetupRequirementOverrides,
  onRecheck?: () => void | Promise<void>,
) {
  const gateway: NativeReadinessGateway = {
    kind: "native",
    run: () => Promise.resolve(snapshot),
    configureCodexBinary: () => Promise.resolve(snapshot),
    copy: (snapshotId) =>
      Promise.resolve({
        schemaVersion: 1,
        snapshotId,
        summary: "Coding Wife diagnostics v1\nsource=native\n",
      }),
  }
  const store = createLocalePreferenceStore("tauri")
  store.write(locale)
  return {
    onAddProject,
    ...render(
      <I18nProvider store={store}>
        <NativeReadinessProvider
          controller={new NativeReadinessController(gateway)}
        >
          <SetupOverview
            onAddProject={onAddProject}
            projectCount={projectCount}
            {...(onRecheck === undefined ? {} : { onRecheck })}
            {...(requirementOverrides === undefined
              ? {}
              : { requirementOverrides })}
          />
        </NativeReadinessProvider>
      </I18nProvider>,
    ),
  }
}

describe("SetupOverview", () => {
  it("derives only unresolved requirements from the native snapshot", () => {
    const requirements = unresolvedSetupRequirements(readinessSnapshot(), 0)
    expect(requirements.map((item) => item.key)).toEqual(["project"])

    const state = {
      status: "ready" as const,
      snapshot: readinessSnapshot(),
      errorCode: null,
      copyStatus: "idle" as const,
      recheckSequence: 0,
      recheckOutcome: "idle" as const,
    }
    expect(shouldShowSetupOverview("native", state, 0)).toBe(true)
    expect(shouldShowSetupOverview("native", state, 1)).toBe(false)
    expect(shouldShowSetupOverview("demo", state, 0)).toBe(false)

    expect(
      shouldShowSetupOverview(
        "native",
        {
          ...state,
          status: "loading",
          snapshot: null,
        },
        0,
      ),
    ).toBe(false)

    expect(
      unresolvedSetupRequirements(readinessSnapshot(), 1, {
        runtimeUnavailable: true,
      }).map((item) => item.key),
    ).toEqual(["diagnostics"])
    expect(
      shouldShowSetupOverview("native", state, 1, {
        runtimeUnavailable: true,
      }),
    ).toBe(true)
  })

  it("hides ready Git and internal checks while showing Codex recovery and the first project", async () => {
    renderOverview(readinessSnapshot("blocked"), 0)

    expect(
      await screen.findByRole("heading", { name: "Prepare Codex CLI" }),
    ).toBeVisible()
    expect(
      screen.getByRole("heading", { name: "Add your first project" }),
    ).toBeVisible()
    expect(screen.queryByText("codex login")).not.toBeInTheDocument()
    expect(
      screen.getByText(
        "Codex was found, but its App Server could not start and initialize.",
      ),
    ).toBeVisible()
    expect(screen.getAllByRole("button", { name: "Recheck" })).toHaveLength(1)
    expect(screen.queryByLabelText("Coding Wife")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("heading", { name: "Install Git" }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("heading", { name: "Use a supported Mac" }),
    ).not.toBeInTheDocument()
  })

  it("starts the real project picker action from the Japanese overview", async () => {
    const user = userEvent.setup()
    const onAddProject = vi.fn()
    renderOverview(readinessSnapshot(), 0, "ja", onAddProject)

    await user.click(
      await screen.findByRole("button", {
        name: "プロジェクトフォルダを選択…",
      }),
    )
    expect(onAddProject).toHaveBeenCalledOnce()
    expect(screen.getAllByRole("button", { name: "再確認" })).toHaveLength(1)
    expect(
      screen.queryByRole("heading", { name: "Gitをインストール" }),
    ).not.toBeInTheDocument()
  })

  it("rechecks native setup readiness from the single global action", async () => {
    const user = userEvent.setup()
    const onRecheck = vi.fn().mockResolvedValue(undefined)
    renderOverview(
      readinessSnapshot("blocked"),
      1,
      "en",
      vi.fn(),
      undefined,
      onRecheck,
    )

    expect(
      await screen.findByRole("heading", { name: "Prepare Codex CLI" }),
    ).toBeVisible()
    const recheck = screen.getByRole("button", { name: "Recheck" })
    expect(screen.getAllByRole("button", { name: "Recheck" })).toHaveLength(1)
    await user.click(recheck)

    expect(onRecheck).toHaveBeenCalledOnce()
  })

  it("reconnects the selected workspace after a custom Codex path is accepted", async () => {
    const user = userEvent.setup()
    const onRecheck = vi.fn().mockResolvedValue(undefined)
    renderOverview(
      readinessSnapshot("blocked"),
      1,
      "en",
      vi.fn(),
      undefined,
      onRecheck,
    )

    await user.type(
      await screen.findByRole("textbox", {
        name: "Custom Codex CLI path",
      }),
      "/opt/homebrew/bin/codex",
    )
    await user.click(screen.getByRole("button", { name: "Use this path" }))

    expect(onRecheck).toHaveBeenCalledOnce()
    expect(screen.getAllByRole("button", { name: "Recheck" })).toHaveLength(1)
  })
})
