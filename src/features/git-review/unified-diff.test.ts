import { describe, expect, it } from "vitest"

import {
  maximumRenderedDiffLines,
  parseUnifiedDiff,
} from "@/features/git-review/unified-diff"

describe("parseUnifiedDiff", () => {
  it("drops Git metadata and assigns old and new line numbers", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/src/example.ts b/src/example.ts",
        "index 1111111..2222222 100644",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -21,3 +21,4 @@ export function example() {",
        "-  return oldValue",
        "+  const value = nextValue",
        "+  return value",
        " }",
      ].join("\n"),
    )

    expect(parsed.status).toBe("ready")
    if (parsed.status !== "ready") return
    expect(parsed.lines).toEqual([
      expect.objectContaining({ kind: "hunk", oldLine: null, newLine: null }),
      expect.objectContaining({ kind: "deletion", oldLine: 21, newLine: null }),
      expect.objectContaining({ kind: "addition", oldLine: null, newLine: 21 }),
      expect.objectContaining({ kind: "addition", oldLine: null, newLine: 22 }),
      expect.objectContaining({ kind: "context", oldLine: 22, newLine: 23 }),
    ])
    expect(JSON.stringify(parsed)).not.toContain("diff --git")
    expect(JSON.stringify(parsed)).not.toContain("index 1111111")
  })

  it("accepts metadata-free bounded hunk excerpts", () => {
    const parsed = parseUnifiedDiff("@@ -4,12 +4,15 @@\n-old\n+new\n context")
    expect(parsed.status).toBe("ready")
    if (parsed.status !== "ready") return
    expect(parsed.lines.at(-1)).toMatchObject({
      kind: "context",
      oldLine: 5,
      newLine: 5,
    })
  })

  it("handles added and deleted files with zero-sided hunk ranges", () => {
    const added = parseUnifiedDiff("@@ -0,0 +1,2 @@\n+one\n+two")
    const deleted = parseUnifiedDiff("@@ -1,2 +0,0 @@\n-one\n-two")

    expect(added.status).toBe("ready")
    expect(deleted.status).toBe("ready")
    if (added.status !== "ready" || deleted.status !== "ready") return
    expect(added.lines.slice(1)).toEqual([
      expect.objectContaining({ oldLine: null, newLine: 1 }),
      expect.objectContaining({ oldLine: null, newLine: 2 }),
    ])
    expect(deleted.lines.slice(1)).toEqual([
      expect.objectContaining({ oldLine: 1, newLine: null }),
      expect.objectContaining({ oldLine: 2, newLine: null }),
    ])
  })

  it("keeps code-like markers inside a hunk and localizes newline notes later", () => {
    const parsed = parseUnifiedDiff(
      "@@ -1 +1 @@\n--- old label\n+++ new label\n\\ No newline at end of file",
    )
    expect(parsed.status).toBe("ready")
    if (parsed.status !== "ready") return
    expect(parsed.lines.map((line) => line.kind)).toEqual([
      "hunk",
      "deletion",
      "addition",
      "no_newline",
    ])
  })

  it("fails soft for metadata-only, empty, and render-limit input", () => {
    expect(parseUnifiedDiff("")).toEqual({ status: "empty", lines: [] })
    expect(
      parseUnifiedDiff(
        "old mode 100644\nnew mode 100755\nrename from before\nrename to after",
      ),
    ).toEqual({ status: "empty", lines: [] })
    const tooManyLines = Array.from(
      { length: maximumRenderedDiffLines + 1 },
      () => " context",
    ).join("\n")
    expect(parseUnifiedDiff(tooManyLines)).toEqual({
      status: "render_limit",
      lines: [],
    })
  })
})
