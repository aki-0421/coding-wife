import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { build } from "vite"

import {
  assertProductionBundleClean,
  developmentDemoMarkers,
  inspectProductionBundle,
  ProductionBundleError,
} from "./production-bundle.mjs"

const projectRoot = fileURLToPath(new URL("../..", import.meta.url))

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "coding-wife-bundle-"))
  t.after(() => rm(root, { force: true, recursive: true }))
  return root
}

test("scanner rejects every development demo marker across stream boundaries", async (t) => {
  const root = await temporaryDirectory(t)
  await mkdir(path.join(root, "nested"))
  await Promise.all(
    developmentDemoMarkers.map((marker, index) =>
      writeFile(
        path.join(root, "nested", `${String(index)}.bin`),
        Buffer.concat([Buffer.from("prefix"), Buffer.from(marker)]),
      ),
    ),
  )

  const result = await inspectProductionBundle(root, { highWaterMark: 7 })
  assert.equal(result.fileCount, developmentDemoMarkers.length)
  for (const marker of developmentDemoMarkers) {
    assert.equal(result.markerCounts[marker], 1)
  }
  await assert.rejects(
    assertProductionBundleClean(root, { highWaterMark: 7 }),
    (error) =>
      error instanceof ProductionBundleError &&
      error.code === "PRODUCTION_BUNDLE_DEMO_MARKER",
  )
})

test("production Vite graph contains no development demo runtime markers", async (t) => {
  const root = await temporaryDirectory(t)
  const output = path.join(root, "dist")
  await build({
    root: projectRoot,
    configFile: path.join(projectRoot, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir: output, emptyOutDir: true },
  })

  const result = await assertProductionBundleClean(output)
  assert.ok(result.fileCount > 0)
  assert.deepEqual(
    Object.values(result.markerCounts),
    developmentDemoMarkers.map(() => 0),
  )
})
