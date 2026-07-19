import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Button } from "@/components/ui/button"

describe("Button icon sizing", () => {
  it.each([
    ["icon", "size-4"],
    ["icon-xs", "size-4"],
    ["icon-sm", "size-4"],
    ["icon-lg", "size-5"],
  ] as const)("uses the app-wide glyph size for %s", (size, glyphClass) => {
    render(
      <Button aria-label={size} size={size}>
        <svg aria-hidden="true" />
      </Button>,
    )

    expect(screen.getByRole("button", { name: size })).toHaveClass(
      `[&_svg:not([class*='size-'])]:${glyphClass}`,
    )
  })

  it("keeps inline icons compact in labeled buttons", () => {
    render(
      <Button>
        <svg aria-hidden="true" />
        Save
      </Button>,
    )

    expect(screen.getByRole("button", { name: "Save" })).toHaveClass(
      "[&_svg:not([class*='size-'])]:size-3",
    )
  })
})
