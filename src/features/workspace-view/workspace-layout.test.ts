/// <reference types="node" />

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const workspaceCss = readFileSync("src/index.css", "utf8")

describe("workspace companion layout", () => {
  it("uses one companion width across Chat, Commit, and Context", () => {
    const sharedLayout = workspaceCss.match(
      /\.workspace-tabs\[data-companion-layout\]\s*\{([^}]*)\}/,
    )

    expect(sharedLayout?.[1]).toContain("minmax(520px, 607.11fr)")
    expect(sharedLayout?.[1]).toContain("minmax(248px, 607.84fr)")
    expect(workspaceCss).not.toMatch(
      /\.workspace-tabs\[data-companion-layout\]\[data-workspace-tab=/,
    )
  })
})
