import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  releaseAssetNames,
  verifyReleaseAssetDirectory,
} from "./verify-release-assets.mjs"

async function writeFixture(directory, tag) {
  for (const name of releaseAssetNames(tag).filter(
    (candidate) => !candidate.endsWith(".sha256"),
  )) {
    const contents = Buffer.from(`fixture:${name}\n`)
    await writeFile(path.join(directory, name), contents)
    const checksum = createHash("sha256").update(contents).digest("hex")
    await writeFile(
      path.join(directory, `${name}.sha256`),
      `${checksum}  ${name}\n`,
    )
  }
}

test("accepts only the exact four artifacts and four matching checksums", async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "coding-wife-release-assets-"),
  )
  context.after(() => rm(directory, { force: true, recursive: true }))
  const tag = "v1.2.3-beta.1"
  await writeFixture(directory, tag)

  const verified = await verifyReleaseAssetDirectory(directory, tag)

  assert.equal(verified.length, 8)
})

test("rejects extra files and checksum drift", async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "coding-wife-release-assets-"),
  )
  context.after(() => rm(directory, { force: true, recursive: true }))
  const tag = "v1.2.3"
  await writeFixture(directory, tag)
  await writeFile(path.join(directory, "unexpected.txt"), "unexpected")
  await assert.rejects(
    verifyReleaseAssetDirectory(directory, tag),
    /RELEASE_ASSET_SET_INVALID/u,
  )
  await rm(path.join(directory, "unexpected.txt"))

  const artifact = `Coding-Wife-${tag}-Linux-x64.deb`
  await writeFile(path.join(directory, artifact), "changed")
  await assert.rejects(
    verifyReleaseAssetDirectory(directory, tag),
    /RELEASE_ASSET_CHECKSUM_MISMATCH/u,
  )
})
