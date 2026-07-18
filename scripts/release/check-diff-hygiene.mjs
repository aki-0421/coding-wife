#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
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
const ALLOWED_BINARY_PATHS = new Set([
  "src-tauri/icons/32x32.png",
  "src-tauri/icons/128x128.png",
  "src-tauri/icons/128x128@2x.png",
  "src-tauri/icons/icon.icns",
  "src-tauri/resources/characters/builtin-hiyori/runtime/hiyori_pro_t11.moc3",
  "src-tauri/resources/characters/builtin-hiyori/runtime/hiyori_pro_t11.2048/texture_00.png",
  "src-tauri/resources/characters/builtin-hiyori/runtime/hiyori_pro_t11.2048/texture_01.png",
])
const BUILD_COMPONENTS = new Set([
  ".cache",
  ".nyc_output",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "tmp",
])
const PRIVATE_COMPONENTS = new Set([".codex", ".context", ".ssh"])
const PRIVATE_FILENAMES = new Set([
  "auth.json",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
])
const BUILD_FILE_PATTERN =
  /(?:^|\/)[^/]+\.(?:app|dmg|log|o|orig|rej|rlib|rmeta|swp|tmp)$/u
const PRIVATE_FILE_PATTERN = /\.(?:key|mobileprovision|p12|pem)$/u
const REMOTE_URL_PREFIX_PATTERN =
  /(?:https?|ftp|sftp|ssh|git):\/\/[^\s<>"'`]*$/iu
const POSIX_HOME_PATH_PATTERN = /\/(?:Users|home)\/(?<user>[^/\s"'`]+)(?=\/)/gu
const PRIVATE_VAR_PATH_PATTERN =
  /\/private\/v\u0061r\/(?<scope>[^/\s"'`]+)(?=\/)/gu
const WINDOWS_HOME_PATH_PATTERN =
  /[A-Za-z]:[\\/]+Users[\\/]+(?<user>[^\\/\s"'`]+)(?=[\\/])/gu
const UNC_PATH_PATTERN =
  /(?:^|[\s("'`=:[{,])\\{2,}(?<server>[A-Za-z0-9][A-Za-z0-9._-]{0,62}|<[^<>]+>)\\+(?<share>[A-Za-z0-9][A-Za-z0-9$_.-]{0,79}|<[^<>]+>)(?=\\)/gu
const EXPLICIT_PLACEHOLDER_PATTERN =
  /^(?:<[^<>]+>|\{[^{}]+\}|\$\{[^{}]+\}|\$[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%|\[[^\[\]]+\]|USER(?:NAME)?|YOUR_(?:USER|USERNAME))$/iu

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

function resolveCommit(repositoryRoot, revision) {
  const result = runGit(
    repositoryRoot,
    ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`],
    { capture: true },
  )
  if (result.status !== 0) {
    return null
  }

  const commit = result.output.toString("utf8").replace(/\r?\n$/u, "")
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit) ? commit : null
}

function revisionContainsNotice(repositoryRoot, commit) {
  const result = runGit(
    repositoryRoot,
    ["ls-tree", "--full-tree", "--name-only", "-z", commit, "--", NOTICE_PATH],
    { capture: true },
  )
  if (result.status !== 0) {
    return null
  }

  const paths = parseNullTerminatedPaths(result.output)
  if (paths === null || paths.length > 1) {
    return null
  }
  if (paths.length === 0) {
    return false
  }
  return paths[0] === NOTICE_PATH ? true : null
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

function parseNoticeIndexEntry(buffer) {
  if (buffer.byteLength === 0) {
    return []
  }

  const records = parseNullTerminatedPaths(buffer)
  if (records === null) {
    return null
  }

  const entries = []
  for (const record of records) {
    const match =
      /^(?<mode>[0-9]{6}) (?<object>(?:[0-9a-f]{40}|[0-9a-f]{64})) (?<stage>[0-3])\t(?<path>.+)$/u.exec(
        record,
      )
    if (match?.groups === undefined) {
      return null
    }
    entries.push(match.groups)
  }

  return entries
}

function noticeIndexIsCanonical(repositoryRoot, required) {
  const listed = runGit(
    repositoryRoot,
    ["ls-files", "--stage", "--full-name", "-z", "--", NOTICE_PATH],
    { capture: true },
  )
  if (listed.status !== 0) {
    return false
  }

  const entries = parseNoticeIndexEntry(listed.output)
  if (entries === null || entries.length > 1) {
    return false
  }
  if (entries.length === 0) {
    return !required
  }

  const [entry] = entries
  if (
    entry.mode !== "100644" ||
    entry.stage !== "0" ||
    entry.path !== NOTICE_PATH
  ) {
    return false
  }

  const blob = runGit(repositoryRoot, ["cat-file", "blob", entry.object], {
    capture: true,
  })
  if (blob.status !== 0) {
    return false
  }

  const actualHash = createHash("sha256").update(blob.output).digest("hex")
  return actualHash === HIYORI_NOTICE_SHA256
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

function parseNameStatus(buffer) {
  const records = parseNullTerminatedPaths(buffer)
  if (records === null || records.length % 2 !== 0) {
    return null
  }
  const statuses = new Map()
  for (let index = 0; index < records.length; index += 2) {
    const status = records[index]
    const relativePath = records[index + 1]
    if (!/^[ACDMTUXB]$/u.test(status) || relativePath.length === 0) {
      return null
    }
    statuses.set(relativePath, status)
  }
  return statuses
}

function parseBinaryNumstatPaths(buffer) {
  const records = parseNullTerminatedPaths(buffer)
  if (records === null) {
    return null
  }
  const binaries = []
  for (const record of records) {
    const firstTab = record.indexOf("\t")
    const secondTab = record.indexOf("\t", firstTab + 1)
    if (firstTab <= 0 || secondTab <= firstTab + 1) {
      return null
    }
    const added = record.slice(0, firstTab)
    const deleted = record.slice(firstTab + 1, secondTab)
    const relativePath = record.slice(secondTab + 1)
    if (relativePath.length === 0) {
      return null
    }
    if (added === "-" && deleted === "-") {
      binaries.push(relativePath)
    }
  }
  return binaries
}

function repositoryPathPolicy(relativePath) {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.split("/").includes("..")
  ) {
    return "invalid-path"
  }
  if (relativePath === NOTICE_PATH) {
    return null
  }

  const components = relativePath.split("/")
  if (
    components.some((component) => BUILD_COMPONENTS.has(component)) ||
    components.some((component) => component.endsWith(".app")) ||
    BUILD_FILE_PATTERN.test(relativePath)
  ) {
    return "build-output"
  }
  const basename = components.at(-1) ?? ""
  if (
    components.some((component) => PRIVATE_COMPONENTS.has(component)) ||
    (basename !== ".env.example" &&
      (basename === ".env" || basename.startsWith(".env."))) ||
    PRIVATE_FILENAMES.has(basename) ||
    PRIVATE_FILE_PATTERN.test(basename)
  ) {
    return "private-path"
  }
  return null
}

function isExplicitPlaceholder(value) {
  return EXPLICIT_PLACEHOLDER_PATTERN.test(value)
}

function startsInsideRemoteUrl(value, index) {
  const prefix = value.slice(0, index).replaceAll("\\/", "/")
  return REMOTE_URL_PREFIX_PATTERN.test(prefix)
}

function patternContainsPrivatePath(value, pattern, placeholderGroups) {
  pattern.lastIndex = 0
  for (const match of value.matchAll(pattern)) {
    if (startsInsideRemoteUrl(value, match.index)) {
      continue
    }
    if (
      placeholderGroups.every((group) =>
        isExplicitPlaceholder(match.groups?.[group] ?? ""),
      )
    ) {
      continue
    }
    return true
  }
  return false
}

function exactRootAppears(value, roots) {
  for (const root of roots) {
    const variants = new Set([root, root.replaceAll("\\", "\\\\")])
    for (const variant of variants) {
      let offset = 0
      for (;;) {
        const index = value.indexOf(variant, offset)
        if (index === -1) {
          break
        }
        const next = value[index + variant.length]
        if (
          (next === undefined || !/[A-Za-z0-9._-]/u.test(next)) &&
          !startsInsideRemoteUrl(value, index)
        ) {
          return true
        }
        offset = index + variant.length
      }
    }
  }
  return false
}

function containsPrivateAbsolutePath(value, roots) {
  const views = new Set([value, value.replaceAll("\\/", "/")])
  for (const view of views) {
    if (
      exactRootAppears(view, roots) ||
      patternContainsPrivatePath(view, POSIX_HOME_PATH_PATTERN, ["user"]) ||
      patternContainsPrivatePath(view, PRIVATE_VAR_PATH_PATTERN, ["scope"]) ||
      patternContainsPrivatePath(view, WINDOWS_HOME_PATH_PATTERN, ["user"]) ||
      patternContainsPrivatePath(view, UNC_PATH_PATTERN, ["server", "share"])
    ) {
      return true
    }
  }
  return false
}

function trackedPatchContainsPrivatePath(repositoryRoot, range) {
  const result = runGit(
    repositoryRoot,
    [
      "-c",
      "diff.external=",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--unified=0",
      range,
      "--",
      INCLUDE_ALL_PATHSPEC,
      NOTICE_EXCLUDE_PATHSPEC,
    ],
    { capture: true },
  )
  if (result.status !== 0) {
    return null
  }

  const roots = [repositoryRoot, os.homedir()]
  for (const candidate of [...roots]) {
    try {
      roots.push(realpathSync(candidate))
    } catch {
      // The original absolute path remains the safe detection boundary.
    }
  }
  const exactRoots = [...new Set(roots)].filter(
    (value) => path.isAbsolute(value) && value !== path.parse(value).root,
  )
  return result.output
    .toString("utf8")
    .split("\n")
    .some(
      (line) =>
        line.startsWith("+") &&
        !line.startsWith("+++") &&
        containsPrivateAbsolutePath(line.slice(1), exactRoots),
    )
}

function trackedRepositoryPolicyFailures(repositoryRoot, range) {
  const names = runGit(
    repositoryRoot,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-status",
      "--no-renames",
      "-z",
      range,
    ],
    { capture: true },
  )
  const numstat = runGit(
    repositoryRoot,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--numstat",
      "--no-renames",
      "-z",
      range,
    ],
    { capture: true },
  )
  if (names.status !== 0 || numstat.status !== 0) {
    return null
  }

  const statuses = parseNameStatus(names.output)
  const binaryPaths = parseBinaryNumstatPaths(numstat.output)
  const privateContent = trackedPatchContainsPrivatePath(repositoryRoot, range)
  if (statuses === null || binaryPaths === null || privateContent === null) {
    return null
  }

  const failures = new Set()
  for (const [relativePath, status] of statuses) {
    if (status === "D") {
      continue
    }
    const failure = repositoryPathPolicy(relativePath)
    if (failure !== null) {
      failures.add(failure)
    }
  }
  for (const relativePath of binaryPaths) {
    if (
      statuses.get(relativePath) !== "D" &&
      relativePath !== NOTICE_PATH &&
      !ALLOWED_BINARY_PATHS.has(relativePath)
    ) {
      failures.add("binary")
    }
  }
  if (privateContent) {
    failures.add("private-content")
  }
  return [...failures].sort()
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

  const headCommit = resolveCommit(repositoryRoot, "HEAD")
  if (headCommit === null) {
    fail("DIFF_HEAD_UNAVAILABLE")
    return
  }

  const headContainsNotice = revisionContainsNotice(repositoryRoot, headCommit)
  if (headContainsNotice === null) {
    fail("PROTECTED_NOTICE_BASELINE_INVALID")
    return
  }

  let baseCommit = null
  let baseContainsNotice = false
  if (!options.workingTreeOnly) {
    baseCommit = resolveCommit(repositoryRoot, options.base)
    if (baseCommit === null) {
      fail("DIFF_BASE_UNAVAILABLE")
      return
    }

    baseContainsNotice = revisionContainsNotice(repositoryRoot, baseCommit)
    if (baseContainsNotice === null) {
      fail("PROTECTED_NOTICE_BASELINE_INVALID")
      return
    }
  }

  const noticeIndexRequired = headContainsNotice || baseContainsNotice
  if (!noticeIndexIsCanonical(repositoryRoot, noticeIndexRequired)) {
    fail("PROTECTED_NOTICE_INDEX_INVALID")
    return
  }

  const failedScopes = []
  if (
    baseCommit !== null &&
    trackedDiffFailed(repositoryRoot, [`${baseCommit}...${headCommit}`])
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

  if (baseCommit !== null) {
    const policyFailures = trackedRepositoryPolicyFailures(
      repositoryRoot,
      `${baseCommit}...${headCommit}`,
    )
    if (policyFailures === null) {
      fail("REPOSITORY_POLICY_UNAVAILABLE")
      return
    }
    if (policyFailures.length > 0) {
      fail(`REPOSITORY_POLICY_FAILED (${policyFailures.join(", ")})`)
      return
    }
  }

  if (!(await noticeIsCanonical(repositoryRoot))) {
    fail("PROTECTED_NOTICE_INVALID")
    return
  }
  if (!noticeIndexIsCanonical(repositoryRoot, noticeIndexRequired)) {
    fail("PROTECTED_NOTICE_INDEX_INVALID")
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
