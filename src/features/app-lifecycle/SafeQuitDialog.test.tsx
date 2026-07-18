import { useState } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import {
  getSafeQuitCopy,
  SafeQuitDialog,
  type SafeQuitDialogStatus,
} from "@/features/app-lifecycle"

function Harness({
  locale,
  status = "confirming",
  onDontQuit = vi.fn(),
  onStopAndQuit = vi.fn(),
}: {
  readonly locale: "ja" | "en"
  readonly status?: SafeQuitDialogStatus
  readonly onDontQuit?: () => void
  readonly onStopAndQuit?: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        origin
      </button>
      <SafeQuitDialog
        copy={getSafeQuitCopy(locale)}
        onDontQuit={() => {
          onDontQuit()
          setOpen(false)
        }}
        onStopAndQuit={onStopAndQuit}
        open={open}
        status={status}
      />
    </>
  )
}

describe("SafeQuitDialog", () => {
  it.each([
    ["en", "Stop the active turn and quit?", "Don’t Quit", "Stop and Quit"],
    ["ja", "実行中のターンを停止して終了しますか？", "終了しない", "停止して終了"],
  ] as const)(
    "renders the %s choices and gives initial focus to the safe action",
    (locale, title, safeLabel, destructiveLabel) => {
      render(<Harness locale={locale} />)
      fireEvent.click(screen.getByRole("button", { name: "origin" }))

      expect(screen.getByRole("dialog")).toHaveAccessibleName(title)
      expect(
        screen.getByRole("button", { name: safeLabel }),
      ).toHaveFocus()
      expect(
        screen.getByRole("button", { name: destructiveLabel }),
      ).toBeEnabled()
    },
  )

  it("treats Escape as Don't Quit and restores the exact prior focus", async () => {
    const onDontQuit = vi.fn()
    render(<Harness locale="en" onDontQuit={onDontQuit} />)
    const origin = screen.getByRole("button", { name: "origin" })
    origin.focus()
    fireEvent.click(origin)
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
      code: "Escape",
    })

    expect(onDontQuit).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(origin).toHaveFocus())
  })

  it("does not let Escape bypass an in-progress terminalization", () => {
    const onDontQuit = vi.fn()
    render(
      <Harness
        locale="en"
        onDontQuit={onDontQuit}
        status="stopping"
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "origin" }))
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
      code: "Escape",
    })
    expect(onDontQuit).not.toHaveBeenCalled()
    expect(screen.getByRole("status")).toHaveTextContent(
      "Stopping and quitting…",
    )
  })
})
