#!/usr/bin/env node

import { createReadStream } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const developmentDemoMarkers = Object.freeze([
  "demoAppServer",
  "Demo commit evidence is missing",
  "Demo diff evidence is missing",
  "workspace-demo-selected-project",
  "demo-decision-turn-1",
  "file-demo-image",
  "demo-auto-",
])

const maximumMarkerBytes = Math.max(
  ...developmentDemoMarkers.map((marker) => Buffer.byteLength(marker)),
)

export class ProductionBundleError extends Error {
  constructor(code) {
    super(code)
    this.name = "ProductionBundleError"
    this.code = code
  }
}

async function regularFiles(root) {
  const files = []

  async function visit(candidate) {
    const metadata = await lstat(candidate)
    if (metadata.isSymbolicLink()) return
    if (metadata.isFile()) {
      files.push(candidate)
      return
    }
    if (!metadata.isDirectory()) return
    const entries = await readdir(candidate, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"))
    for (const entry of entries) {
      await visit(path.join(candidate, entry.name))
    }
  }

  await visit(root)
  return files
}

async function countFileMarkers(file, counts, highWaterMark) {
  let carry = Buffer.alloc(0)
  for await (const chunkValue of createReadStream(file, { highWaterMark })) {
    const chunk = Buffer.isBuffer(chunkValue)
      ? chunkValue
      : Buffer.from(chunkValue)
    const content = Buffer.concat([carry, chunk])
    for (const marker of developmentDemoMarkers) {
      const needle = Buffer.from(marker)
      let offset = 0
      while (offset <= content.length - needle.length) {
        const index = content.indexOf(needle, offset)
        if (index === -1) break
        if (index + needle.length > carry.length) counts[marker] += 1
        offset = index + Math.max(needle.length, 1)
      }
    }
    carry = content.subarray(
      Math.max(0, content.length - (maximumMarkerBytes - 1)),
    )
  }
}

export async function inspectProductionBundle(
  root,
  { highWaterMark = 64 * 1024 } = {},
) {
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 1) {
    throw new ProductionBundleError("PRODUCTION_BUNDLE_CHUNK_INVALID")
  }
  let files
  try {
    files = await regularFiles(root)
  } catch {
    throw new ProductionBundleError("PRODUCTION_BUNDLE_ROOT_INVALID")
  }
  const markerCounts = Object.fromEntries(
    developmentDemoMarkers.map((marker) => [marker, 0]),
  )
  try {
    for (const file of files) {
      await countFileMarkers(file, markerCounts, highWaterMark)
    }
  } catch {
    throw new ProductionBundleError("PRODUCTION_BUNDLE_SCAN_FAILED")
  }
  return { fileCount: files.length, markerCounts }
}

export async function assertProductionBundleClean(root, options) {
  const result = await inspectProductionBundle(root, options)
  if (Object.values(result.markerCounts).some((count) => count !== 0)) {
    throw new ProductionBundleError("PRODUCTION_BUNDLE_DEMO_MARKER")
  }
  return result
}

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== "--root" || argv[1].length === 0) {
    throw new ProductionBundleError("PRODUCTION_BUNDLE_ARGUMENT_INVALID")
  }
  return path.resolve(argv[1])
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const result = await assertProductionBundleClean(
      parseCli(process.argv.slice(2)),
    )
    process.stdout.write(
      `[release] production bundle demo scan passed (${String(result.fileCount)} regular files)\n`,
    )
  } catch (error) {
    const code =
      error instanceof ProductionBundleError
        ? error.code
        : "PRODUCTION_BUNDLE_FAILED"
    process.stderr.write(`[release] ${code}\n`)
    process.exitCode = 1
  }
}
