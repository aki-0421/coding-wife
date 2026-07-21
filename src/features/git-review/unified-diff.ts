const hunkHeaderPattern =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?.*)?$/

const metadataPatterns = [
  /^diff --git /,
  /^index /,
  /^--- /,
  /^\+\+\+ /,
  /^(?:new|deleted) file mode /,
  /^(?:old|new) mode /,
  /^(?:similarity|dissimilarity) index /,
  /^(?:rename|copy) (?:from|to) /,
  /^Binary files /,
  /^GIT binary patch$/,
  /^(?:literal|delta) \d+$/,
] as const

export const maximumRenderedDiffLines = 10_000

export type ParsedDiffLine =
  | {
      readonly kind: "hunk"
      readonly text: string
      readonly oldLine: null
      readonly newLine: null
    }
  | {
      readonly kind: "context" | "addition" | "deletion"
      readonly text: string
      readonly oldLine: number | null
      readonly newLine: number | null
    }
  | {
      readonly kind: "no_newline"
      readonly text: string
      readonly oldLine: null
      readonly newLine: null
    }

export type ParsedUnifiedDiff =
  | { readonly status: "ready"; readonly lines: readonly ParsedDiffLine[] }
  | { readonly status: "empty" | "render_limit"; readonly lines: readonly [] }

function exceedsRenderLimit(content: string) {
  let lines = content.length === 0 ? 0 : 1
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1
    if (lines > maximumRenderedDiffLines) return true
  }
  return false
}

export function parseUnifiedDiff(content: string): ParsedUnifiedDiff {
  if (content === "") return { status: "empty", lines: [] }
  if (exceedsRenderLimit(content)) return { status: "render_limit", lines: [] }

  const rawLines = content.split("\n")
  if (content.endsWith("\n")) rawLines.pop()

  const lines: ParsedDiffLine[] = []
  let insideHunk = false
  let oldLine: number | null = null
  let newLine: number | null = null

  for (const rawLine of rawLines) {
    const hunk = hunkHeaderPattern.exec(rawLine)
    if (hunk !== null) {
      const oldCount = Number(hunk[2] ?? "1")
      const newCount = Number(hunk[4] ?? "1")
      oldLine = oldCount === 0 ? null : Number(hunk[1])
      newLine = newCount === 0 ? null : Number(hunk[3])
      insideHunk = true
      lines.push({ kind: "hunk", text: rawLine, oldLine: null, newLine: null })
      continue
    }

    if (!insideHunk) {
      if (metadataPatterns.some((pattern) => pattern.test(rawLine))) continue
      continue
    }

    if (rawLine === "\\ No newline at end of file") {
      lines.push({
        kind: "no_newline",
        text: rawLine,
        oldLine: null,
        newLine: null,
      })
      continue
    }

    if (rawLine.startsWith("+")) {
      lines.push({
        kind: "addition",
        text: rawLine.slice(1),
        oldLine: null,
        newLine,
      })
      if (newLine !== null) newLine += 1
      continue
    }

    if (rawLine.startsWith("-")) {
      lines.push({
        kind: "deletion",
        text: rawLine.slice(1),
        oldLine,
        newLine: null,
      })
      if (oldLine !== null) oldLine += 1
      continue
    }

    if (rawLine.startsWith(" ")) {
      lines.push({
        kind: "context",
        text: rawLine.slice(1),
        oldLine,
        newLine,
      })
      if (oldLine !== null) oldLine += 1
      if (newLine !== null) newLine += 1
    }
  }

  return lines.length === 0
    ? { status: "empty", lines: [] }
    : { status: "ready", lines }
}
