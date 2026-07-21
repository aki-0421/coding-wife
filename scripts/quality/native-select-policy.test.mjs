import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url))
const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url))
const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".html",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
])
const forbiddenPatterns = [
  { label: "native <select> element", pattern: /<select(?:\s|>)/u },
  { label: "NativeSelect component", pattern: /\bNativeSelect\w*\b/u },
  { label: "HTMLSelectElement type", pattern: /\bHTMLSelectElement\b/u },
  {
    label: "programmatic select element",
    pattern: /createElement\(\s*["']select["']/u,
  },
]

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) return sourceFiles(path)
      const extension = entry.name.slice(entry.name.lastIndexOf("."))
      return sourceExtensions.has(extension) ? [path] : []
    }),
  )
  return files.flat()
}

test("frontend source never uses native select controls", async () => {
  const violations = []
  for (const file of await sourceFiles(sourceRoot)) {
    const source = await readFile(file, "utf8")
    for (const { label, pattern } of forbiddenPatterns) {
      if (pattern.test(source)) {
        violations.push(`${file.slice(repositoryRoot.length)}: ${label}`)
      }
    }
  }

  assert.deepEqual(violations, [])
})
