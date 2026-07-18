import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { App } from "@/app/App"
import {
  FinalAcceptanceWorkspaceFixture,
  MemoryLocalePreferenceStore,
} from "@/app/acceptance/final-app-fixture"
import {
  buildFinalAcceptanceMatrix,
  finalAcceptanceViewports,
  type FinalAcceptanceViewportId,
} from "@/app/acceptance/final-acceptance-harness"
import { DemoTransport } from "@/features/runtime"
import { getWorkspaceCopy } from "@/features/workspace-view/copy"
import type { WorkspaceViewAdapter } from "@/features/workspace-view/types"

const viewportLayout: Readonly<
  Record<FinalAcceptanceViewportId, "desktop" | "compact" | "narrow">
> = {
  desktop: "desktop",
  compact: "compact",
  "zoom-200": "narrow",
}

const originalViewport = {
  width: window.innerWidth,
  height: window.innerHeight,
  devicePixelRatio: window.devicePixelRatio,
}

function setViewport(viewportId: FinalAcceptanceViewportId): void {
  const viewport = finalAcceptanceViewports.find(({ id }) => id === viewportId)
  if (viewport === undefined) throw new Error(`Unknown viewport: ${viewportId}`)
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: viewport.width },
    innerHeight: { configurable: true, value: viewport.height },
    devicePixelRatio: {
      configurable: true,
      value: viewportId === "zoom-200" ? 2 : 1,
    },
  })
  window.dispatchEvent(new Event("resize"))
}

function recoveringAdapter(fixture: FinalAcceptanceWorkspaceFixture): {
  readonly adapter: WorkspaceViewAdapter
  readonly attempts: () => number
} {
  let loadAttempts = 0
  return {
    adapter: {
      ...fixture,
      hydrationMode: "native",
      loadState: () => {
        loadAttempts += 1
        return loadAttempts === 1
          ? Promise.reject(new Error("WORKSPACE-HISTORY-UNAVAILABLE"))
          : fixture.loadState()
      },
    },
    attempts: () => loadAttempts,
  }
}

describe("production App final responsive matrix", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/")
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      })),
    )
  })

  afterEach(() => {
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: originalViewport.width },
      innerHeight: { configurable: true, value: originalViewport.height },
      devicePixelRatio: {
        configurable: true,
        value: originalViewport.devicePixelRatio,
      },
    })
    vi.unstubAllGlobals()
  })

  it.each(buildFinalAcceptanceMatrix())(
    "renders production $journey UI for $locale at $viewport",
    async ({ journey, locale, viewport }) => {
      setViewport(viewport)
      const localized = getWorkspaceCopy(locale)
      const fixture = new FinalAcceptanceWorkspaceFixture()
      const recovery = recoveringAdapter(fixture)
      const adapter = journey === "major_error" ? recovery.adapter : fixture
      const user = userEvent.setup({ delay: null })
      const view = render(
        <App
          characterRenderer={() => <div data-testid="matrix-character" />}
          localeStore={new MemoryLocalePreferenceStore(locale)}
          transport={new DemoTransport()}
          workspaceAdapter={adapter}
        />,
      )

      if (journey === "major_error") {
        const alert = await screen.findByRole("alert")
        expect(alert).toHaveTextContent(localized.workspaceLoadFailedTitle)
        expect(alert.closest("main")).toHaveAttribute(
          "data-workspace-viewport",
          viewportLayout[viewport],
        )
        const retry = screen.getByRole("button", { name: localized.retry })
        retry.focus()
        await user.keyboard("{Enter}")
        await waitFor(() => expect(recovery.attempts()).toBe(2))
      }

      const composer = await screen.findByPlaceholderText(
        localized.composerPlaceholder,
      )
      expect(composer).toBeVisible()
      const shell =
        view.container.querySelector<HTMLElement>(".workspace-shell")
      expect(shell).not.toBeNull()
      expect(shell).toHaveAttribute(
        "data-workspace-viewport",
        viewportLayout[viewport],
      )
      expect(shell?.querySelector(".workspace-tabs")).not.toBeNull()
      expect(
        shell?.querySelector(
          '.workspace-view[data-state="active"] [data-slot="scroll-area-viewport"]',
        ),
      ).not.toBeNull()

      const chatTab = screen.getByRole("tab", {
        name: new RegExp(localized.tabs.chat, "u"),
      })
      fireEvent.keyDown(window, { ctrlKey: true, key: "Tab" })
      expect(
        screen.getByRole("tab", {
          name: new RegExp(localized.tabs.commit, "u"),
        }),
      ).toHaveAttribute("aria-selected", "true")
      fireEvent.keyDown(window, {
        ctrlKey: true,
        shiftKey: true,
        key: "Tab",
      })
      expect(chatTab).toHaveAttribute("aria-selected", "true")

      if (viewportLayout[viewport] === "narrow") {
        const compactNavigation = screen.getByRole("button", {
          name: localized.compactSidebar,
        })
        compactNavigation.focus()
        await user.keyboard("{Enter}")
        expect(
          await screen.findByRole("dialog", {
            name: localized.workspaces,
          }),
        ).toBeVisible()
        await user.keyboard("{Escape}")
        await waitFor(() => expect(compactNavigation).toHaveFocus())
      }
    },
  )
})
