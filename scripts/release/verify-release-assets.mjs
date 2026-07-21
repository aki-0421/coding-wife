#!/usr/bin/env node

import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

const TAG_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function fail(code) {
  throw new Error(code)
}

export function releaseAssetNames(tag) {
  if (!TAG_PATTERN.test(tag)) {
    fail("RELEASE_ASSET_TAG_INVALID")
  }
  const artifacts = [
    `Coding-Wife-${tag}-macOS-arm64.dmg`,
    `Coding-Wife-${tag}-Windows-x64-setup.exe`,
    `Coding-Wife-${tag}-Linux-x64.deb`,
    `Coding-Wife-${tag}-Linux-x64.AppImage`,
  ]
  return artifacts.flatMap((artifact) => [artifact, `${artifact}.sha256`])
}

async function sha256(file) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk)
  }
  return hash.digest("hex")
}

async function assertRegularFile(file) {
  const metadata = await lstat(file).catch(() => fail("RELEASE_ASSET_MISSING"))
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("RELEASE_ASSET_TYPE_INVALID")
  }
}

export async function verifyReleaseAssetDirectory(directory, tag) {
  if (!path.isAbsolute(directory)) {
    fail("RELEASE_ASSET_DIRECTORY_INVALID")
  }
  const expected = releaseAssetNames(tag).sort()
  const entries = await readdir(directory, { withFileTypes: true }).catch(() =>
    fail("RELEASE_ASSET_DIRECTORY_UNAVAILABLE"),
  )
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    fail("RELEASE_ASSET_TYPE_INVALID")
  }
  const observed = entries.map((entry) => entry.name).sort()
  if (
    observed.length !== expected.length ||
    observed.some((name, index) => name !== expected[index])
  ) {
    fail("RELEASE_ASSET_SET_INVALID")
  }

  for (const checksumName of expected.filter((name) =>
    name.endsWith(".sha256"),
  )) {
    const artifactName = checksumName.slice(0, -".sha256".length)
    const artifactPath = path.join(directory, artifactName)
    const checksumPath = path.join(directory, checksumName)
    await assertRegularFile(artifactPath)
    await assertRegularFile(checksumPath)
    const checksum = await readFile(checksumPath, "utf8")
    const match = checksum.match(/^([0-9a-f]{64})  ([^\r\n]+)\n?$/u)
    if (match === null || match[2] !== artifactName) {
      fail("RELEASE_ASSET_CHECKSUM_FORMAT_INVALID")
    }
    if ((await sha256(artifactPath)) !== match[1]) {
      fail("RELEASE_ASSET_CHECKSUM_MISMATCH")
    }
  }
  return expected.map((name) => path.join(directory, name))
}

function parseArguments(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== "--directory" ||
    argv[2] !== "--tag" ||
    argv[1].length === 0 ||
    argv[3].length === 0
  ) {
    fail("RELEASE_ASSET_ARGUMENT_INVALID")
  }
  return { directory: path.resolve(argv[1]), tag: argv[3] }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    const { directory, tag } = parseArguments(process.argv.slice(2))
    await verifyReleaseAssetDirectory(directory, tag)
    process.stdout.write(`[release] verified eight assets for ${tag}.\n`)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "RELEASE_ASSET_VERIFY_FAILED"
    process.stderr.write(`[release] ${message}\n`)
    process.exitCode = 1
  }
}
