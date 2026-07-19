import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { BrandMark } from "@/components/brand-mark"

describe("BrandMark", () => {
  it("exposes its accessible name without drawing visible text", () => {
    const { container } = render(<BrandMark label="Coding Wife" />)

    expect(screen.getByRole("img", { name: "Coding Wife" })).toBeInTheDocument()
    expect(container.querySelector("text")).toBeNull()
    expect(container.textContent).toBe("")
  })

  it("stays decorative when no accessible name is supplied", () => {
    const { container } = render(<BrandMark />)

    expect(container.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    )
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })
})
