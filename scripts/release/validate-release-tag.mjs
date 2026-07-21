#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const projectRoot = fileURLToPath(new URL("../..", import.meta.url))
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function fail(code) {
  throw new Error(code)
}

export function parseCargoPackageVersion(contents) {
  let inPackageSection = false
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (/^\[[^\]]+\]$/u.test(trimmed)) {
      if (inPackageSection) {
        break
      }
      inPackageSection = trimmed === "[package]"
      continue
    }
    if (inPackageSection) {
      const version = line.match(
        /^version[ \t]*=[ \t]*"([^"]+)"[ \t]*$/u,
      )?.[1]
      if (version !== undefined) {
        return version
      }
    }
  }
  fail("RELEASE_TAG_CARGO_VERSION_INVALID")
}

export function validateReleaseVersions({
  tag,
  packageVersion,
  tauriVersion,
  cargoVersion,
}) {
  if (
    !VERSION_PATTERN.test(packageVersion) ||
    !VERSION_PATTERN.test(tauriVersion) ||
    !VERSION_PATTERN.test(cargoVersion)
  ) {
    fail("RELEASE_TAG_VERSION_INVALID")
  }
  if (packageVersion !== tauriVersion || packageVersion !== cargoVersion) {
    fail("RELEASE_TAG_VERSION_MISMATCH")
  }
  if (tag !== `v${packageVersion}`) {
    fail("RELEASE_TAG_REF_MISMATCH")
  }
  return packageVersion
}

function parseTagArgument(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== "--tag" ||
    argv[1].length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(argv[1])
  ) {
    fail("RELEASE_TAG_ARGUMENT_INVALID")
  }
  return argv[1]
}

function readJsonVersion(relativePath, code) {
  try {
    const value = JSON.parse(
      readFileSync(path.join(projectRoot, relativePath), "utf8"),
    ).version
    if (typeof value !== "string") {
      fail(code)
    }
    return value
  } catch (error) {
    if (error instanceof Error && error.message === code) {
      throw error
    }
    fail(code)
  }
}

function assertDevelopAncestry() {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", "HEAD", "origin/develop"],
    {
      cwd: projectRoot,
      stdio: "ignore",
    },
  )
  if (result.error !== undefined || result.status === null || result.status > 1) {
    fail("RELEASE_TAG_DEVELOP_REF_UNAVAILABLE")
  }
  if (result.status !== 0) {
    fail("RELEASE_TAG_NOT_ON_DEVELOP")
  }
}

export function validateReleaseTag(tag) {
  const packageVersion = readJsonVersion(
    "package.json",
    "RELEASE_TAG_PACKAGE_VERSION_INVALID",
  )
  const tauriVersion = readJsonVersion(
    "src-tauri/tauri.conf.json",
    "RELEASE_TAG_TAURI_VERSION_INVALID",
  )
  let cargoVersion
  try {
    cargoVersion = parseCargoPackageVersion(
      readFileSync(path.join(projectRoot, "src-tauri/Cargo.toml"), "utf8"),
    )
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "RELEASE_TAG_CARGO_VERSION_INVALID"
    ) {
      throw error
    }
    fail("RELEASE_TAG_CARGO_VERSION_INVALID")
  }
  const version = validateReleaseVersions({
    tag,
    packageVersion,
    tauriVersion,
    cargoVersion,
  })
  assertDevelopAncestry()
  return version
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    const tag = parseTagArgument(process.argv.slice(2))
    validateReleaseTag(tag)
    process.stdout.write(`[release] release tag ${tag} validated.\n`)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "RELEASE_TAG_VALIDATION_FAILED"
    process.stderr.write(`[release] ${message}\n`)
    process.exitCode = 1
  }
}
