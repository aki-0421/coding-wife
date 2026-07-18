#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { HIYORI_NOTICE_SHA256 } from "../live2d/constants.mjs"

const DEFAULT_BASE = "origin/develop"
const NOTICE_PATH = "src-tauri/resources/characters/builtin-hiyori/NOTICE.txt"
const INCLUDE_ALL_PATHSPEC = ":(top)**"
const NOTICE_EXCLUDE_PATHSPEC = `:(top,exclude,literal)${NOTICE_PATH}`
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024
const GIT_TIMEOUT_MS = 30_000
const CORE_WHITESPACE = "blank-at-eol,blank-at-eof,space-before-tab"
const SAFE_BASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9./_-]{0,199}$/u

function usage() {
  process.stdout.write(
    [
      "Usage: check-diff-hygiene.mjs [--base <ref-or-sha>] [--working-tree]",
      "",
      "Default: check origin/develop...HEAD plus staged, unstaged, and untracked files.",
      "--working-tree: check only staged, unstaged, and untracked files.",
      "",
    ].join("\n"),
  )
}

function fail(code) {
  process.stderr.write(`error: ${code}\n`)
  process.exitCode = 1
}

function parseArguments(argv) {
  let base = DEFAULT_BASE
  let baseSeen = false
  let workingTreeOnly = false
  let separatorSeen = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (argument === "--" && !separatorSeen) {
      separatorSeen = true
      continue
    }
    if (argument === "--help" && argv.length === 1) {
      return { help: true }
    }
    if (argument === "--working-tree" && !workingTreeOnly) {
      workingTreeOnly = true
      continue
    }
    if (argument === "--base" && !baseSeen) {
      const value = argv[index + 1]
      if (value === undefined) {
        return null
      }
      base = value
      baseSeen = true
      index += 1
      continue
    }
    return null
  }

  if (workingTreeOnly && baseSeen) {
    return null
  }
  if (!SAFE_BASE_PATTERN.test(base) || base.includes("..")) {
    return null
  }

  return { base, help: false, workingTreeOnly }
}

function gitEnvironment() {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  }
}

function runGit(cwd, args, { capture = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: capture ? "buffer" : undefined,
    env: gitEnvironment(),
    maxBuffer: MAX_CAPTURE_BYTES,
    stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore",
    timeout: GIT_TIMEOUT_MS,
  })

  return {
    output:
      capture && Buffer.isBuffer(result.stdout)
        ? result.stdout
        : Buffer.alloc(0),
    status: result.status,
  }
}

function captureRepositoryRoot() {
  const result = runGit(process.cwd(), ["rev-parse", "--show-toplevel"], {
    capture: true,
  })
  if (result.status !== 0 || result.output.byteLength === 0) {
    return null
  }

  const root = result.output.toString("utf8").replace(/\r?\n$/u, "")
  return path.isAbsolute(root) ? root : null
}

async function noticeIsCanonical(repositoryRoot) {
  const noticePath = path.join(repositoryRoot, NOTICE_PATH)

  try {
    const metadata = await lstat(noticePath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return false
    }
    const bytes = await readFile(noticePath)
    const actualHash = createHash("sha256").update(bytes).digest("hex")
    return actualHash === HIYORI_NOTICE_SHA256
  } catch {
    return false
  }
}

function trackedDiffFailed(repositoryRoot, args) {
  const result = runGit(repositoryRoot, [
    "-c",
    "diff.external=",
    "-c",
    `core.whitespace=${CORE_WHITESPACE}`,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--check",
    ...args,
    "--",
    INCLUDE_ALL_PATHSPEC,
    NOTICE_EXCLUDE_PATHSPEC,
  ])
  return result.status !== 0
}

function parseNullTerminatedPaths(buffer) {
  if (buffer.byteLength === 0) {
    return []
  }

  const paths = []
  let start = 0
  for (let index = 0; index < buffer.byteLength; index += 1) {
    if (buffer[index] !== 0) {
      continue
    }
    paths.push(buffer.subarray(start, index).toString("utf8"))
    start = index + 1
  }
  if (start !== buffer.byteLength) {
    return null
  }
  return paths
}

function untrackedDiffFailed(repositoryRoot) {
  const listed = runGit(
    repositoryRoot,
    ["ls-files", "--others", "--exclude-standard", "--full-name", "-z"],
    { capture: true },
  )
  if (listed.status !== 0) {
    return true
  }

  const untrackedPaths = parseNullTerminatedPaths(listed.output)
  if (untrackedPaths === null) {
    return true
  }

  for (const relativePath of untrackedPaths) {
    if (relativePath === NOTICE_PATH) {
      continue
    }
    if (
      relativePath.length === 0 ||
      path.isAbsolute(relativePath) ||
      relativePath.split("/").includes("..")
    ) {
      return true
    }

    const result = runGit(repositoryRoot, [
      "-c",
      "diff.external=",
      "-c",
      `core.whitespace=${CORE_WHITESPACE}`,
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--check",
      "--",
      os.devNull,
      relativePath,
    ])
    if (result.status !== 0 && result.status !== 1) {
      return true
    }
  }

  return false
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options === null) {
    fail("INVALID_ARGUMENTS")
    return
  }
  if (options.help) {
    usage()
    return
  }

  const repositoryRoot = captureRepositoryRoot()
  if (repositoryRoot === null) {
    fail("GIT_REPOSITORY_UNAVAILABLE")
    return
  }

  if (!(await noticeIsCanonical(repositoryRoot))) {
    fail("PROTECTED_NOTICE_INVALID")
    return
  }

  if (!options.workingTreeOnly) {
    const base = runGit(repositoryRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${options.base}^{commit}`,
    ])
    if (base.status !== 0) {
      fail("DIFF_BASE_UNAVAILABLE")
      return
    }
  }

  const failedScopes = []
  if (
    !options.workingTreeOnly &&
    trackedDiffFailed(repositoryRoot, [`${options.base}...HEAD`])
  ) {
    failedScopes.push("committed")
  }
  if (trackedDiffFailed(repositoryRoot, ["--cached"])) {
    failedScopes.push("staged")
  }
  if (trackedDiffFailed(repositoryRoot, [])) {
    failedScopes.push("unstaged")
  }
  if (untrackedDiffFailed(repositoryRoot)) {
    failedScopes.push("untracked")
  }

  if (!(await noticeIsCanonical(repositoryRoot))) {
    fail("PROTECTED_NOTICE_INVALID")
    return
  }
  if (failedScopes.length > 0) {
    fail(`DIFF_HYGIENE_FAILED (${failedScopes.join(", ")})`)
    return
  }

  const scopes = options.workingTreeOnly
    ? "staged, unstaged, untracked"
    : "committed, staged, unstaged, untracked"
  process.stdout.write(`Diff hygiene passed (${scopes}).\n`)
}

main().catch(() => {
  fail("DIFF_HYGIENE_UNAVAILABLE")
})
