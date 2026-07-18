#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import {
  syncReleaseNotices,
  verifyReleaseNotices,
} from "../live2d/release-notices.mjs"

export const DEPENDENCY_INVENTORY_FILE = "THIRD-PARTY-DEPENDENCIES.json"
export const DEPENDENCY_NOTICE_FILE = "THIRD-PARTY-DEPENDENCIES.md"
export const CARGO_TARGET = "aarch64-apple-darwin"

const projectRoot = fileURLToPath(new URL("../..", import.meta.url))
const canonicalRoot = path.join(projectRoot, "third-party")
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

const allowedLicenseIds = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "OFL-1.1",
  "Python-2.0",
  "Unicode-3.0",
  "Unlicense",
  "Zlib",
])

const forbiddenLicensePrefixes = [
  "AGPL-",
  "BUSL-",
  "Commons-Clause",
  "Elastic-",
  "GPL-",
  "LGPL-",
  "SSPL-",
]

const evidenceNamePattern =
  /^(licen[cs]e|copying|notice|third[-_ ]party)([-_. ].*)?$/iu
const maxEvidenceBytes = 1024 * 1024

function fail(code) {
  throw new Error(code)
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function readUtf8(relative) {
  return readFileSync(path.join(projectRoot, relative), "utf8")
}

function runJson(command, args, code) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error !== undefined || result.status !== 0) fail(code)
  try {
    return JSON.parse(result.stdout)
  } catch {
    fail(`${code}_INVALID_JSON`)
  }
}

function unquoteYamlKey(value) {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}

export function parsePnpmLockPackages(contents) {
  const packages = new Map()
  let inPackages = false
  let current

  for (const line of contents.split("\n")) {
    if (line === "packages:") {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    if (/^[^ ]/u.test(line) && line.trim() !== "") break

    const packageMatch = /^  (\S.*):$/u.exec(line)
    if (packageMatch) {
      const key = unquoteYamlKey(packageMatch[1])
      current = { key, integrity: undefined }
      if (packages.has(key)) fail("LICENSE_PNPM_LOCK_DUPLICATE")
      packages.set(key, current)
      continue
    }

    const integrityMatch =
      /^    resolution: \{integrity: ([^,}]+)(?:,|\})/u.exec(line)
    if (current && integrityMatch) {
      current.integrity = integrityMatch[1].replace(/^['"]|['"]$/gu, "")
    }
  }

  if (packages.size === 0) fail("LICENSE_PNPM_LOCK_EMPTY")
  return packages
}

function parseTomlString(block, key) {
  const match = new RegExp(`^${key} = "([^"]+)"$`, "mu").exec(block)
  return match?.[1]
}

export function parseCargoLockPackages(contents) {
  const packages = new Map()
  for (const block of contents.split("[[package]]").slice(1)) {
    const name = parseTomlString(block, "name")
    const version = parseTomlString(block, "version")
    if (!name || !version) fail("LICENSE_CARGO_LOCK_INVALID")
    const source = parseTomlString(block, "source")
    const checksum = parseTomlString(block, "checksum")
    const key = `${name}@${version}`
    if (packages.has(key)) fail("LICENSE_CARGO_LOCK_DUPLICATE")
    packages.set(key, { name, version, source, checksum })
  }
  if (packages.size === 0) fail("LICENSE_CARGO_LOCK_EMPTY")
  return packages
}

export function classifyLicense(expression) {
  if (typeof expression !== "string" || expression.trim() === "") {
    return { status: "missing", ids: [] }
  }

  const ids = expression
    .match(/[A-Za-z0-9.+-]+/gu)
    ?.filter((candidate) => !["AND", "OR", "WITH"].includes(candidate))

  if (!ids || ids.length === 0) return { status: "missing", ids: [] }
  if (
    ids.some((id) =>
      forbiddenLicensePrefixes.some((prefix) => id.startsWith(prefix)),
    )
  ) {
    return { status: "forbidden", ids }
  }
  if (ids.some((id) => !allowedLicenseIds.has(id))) {
    return { status: "unknown", ids }
  }
  return { status: "allowed", ids }
}

function normalizePerson(value) {
  if (typeof value === "string") return value.trim()
  if (!value || typeof value !== "object") return ""
  const name = typeof value.name === "string" ? value.name.trim() : ""
  const email = typeof value.email === "string" ? value.email.trim() : ""
  return [name, email ? `<${email}>` : ""].filter(Boolean).join(" ")
}

function normalizeRepository(value, homepage) {
  const repository = typeof value === "string" ? value : value?.url
  const candidate =
    typeof repository === "string" && repository.trim() !== ""
      ? repository
      : homepage
  if (typeof candidate !== "string" || candidate.trim() === "") {
    fail("LICENSE_ATTRIBUTION_MISSING")
  }
  return candidate.replace(/^git\+/u, "").trim()
}

function safePackageDirectory(packagePath) {
  if (typeof packagePath !== "string" || !path.isAbsolute(packagePath)) {
    fail("LICENSE_PACKAGE_PATH_INVALID")
  }
  const relative = path.relative(projectRoot, packagePath)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("LICENSE_PACKAGE_PATH_OUTSIDE_PROJECT")
  }
  return packagePath
}

function normalizeEvidenceText(buffer) {
  const text = buffer.toString("utf8")
  if (text.includes("\0")) fail("LICENSE_EVIDENCE_BINARY")
  return `${text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\t", "    ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .trimEnd()}\n`
}

function collectEvidence(packageDirectory, explicitFile) {
  const candidates = new Set(
    readdirSync(packageDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && evidenceNamePattern.test(entry.name))
      .map((entry) => entry.name),
  )
  if (typeof explicitFile === "string" && explicitFile.trim() !== "") {
    candidates.add(explicitFile)
  }

  return [...candidates].sort().map((relativeFile) => {
    const absoluteFile = path.resolve(packageDirectory, relativeFile)
    const relative = path.relative(packageDirectory, absoluteFile)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      fail("LICENSE_EVIDENCE_PATH_INVALID")
    }
    const stat = lstatSync(absoluteFile)
    if (!stat.isFile() || stat.size > maxEvidenceBytes) {
      fail("LICENSE_EVIDENCE_FILE_INVALID")
    }
    const contents = readFileSync(absoluteFile)
    return {
      file: relative.split(path.sep).join("/"),
      bytes: contents.byteLength,
      sha256: sha256(contents),
      text: normalizeEvidenceText(contents),
    }
  })
}

function walkPnpmDependencies(root) {
  const packages = new Map()
  const visit = (node) => {
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      if (
        typeof dependency.version !== "string" ||
        typeof dependency.resolved !== "string" ||
        typeof dependency.path !== "string"
      ) {
        fail("LICENSE_PNPM_METADATA_MISSING")
      }
      const key = `${name}@${dependency.version}`
      const previous = packages.get(key)
      if (
        previous &&
        (previous.resolved !== dependency.resolved ||
          previous.version !== dependency.version)
      ) {
        fail("LICENSE_PNPM_METADATA_CONFLICT")
      }
      if (!previous || dependency.path.localeCompare(previous.path) < 0) {
        packages.set(key, { name, ...dependency })
      }
      visit(dependency)
    }
  }
  visit(root)
  return packages
}

export function validatePnpmResolution(locked, resolved) {
  if (!locked?.integrity) fail("LICENSE_PNPM_INTEGRITY_MISSING")
  if (!/^sha(256|384|512)-[A-Za-z0-9+/=]+$/u.test(locked.integrity)) {
    fail("LICENSE_PNPM_INTEGRITY_INVALID")
  }
  if (
    typeof resolved !== "string" ||
    !resolved.startsWith("https://registry.npmjs.org/")
  ) {
    fail("LICENSE_PNPM_SOURCE_UNAPPROVED")
  }
}

function collectPnpmPackages(pnpmLock) {
  const result = runJson(
    pnpm,
    ["list", "--prod", "--depth", "Infinity", "--json"],
    "LICENSE_PNPM_LIST_FAILED",
  )
  if (!Array.isArray(result) || result.length !== 1) {
    fail("LICENSE_PNPM_LIST_INVALID")
  }

  return [...walkPnpmDependencies(result[0]).values()].map((dependency) => {
    const lockKey = `${dependency.name}@${dependency.version}`
    const locked = pnpmLock.get(lockKey)
    validatePnpmResolution(locked, dependency.resolved)

    const packageDirectory = safePackageDirectory(dependency.path)
    const manifest = JSON.parse(
      readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
    )
    if (
      manifest.name !== dependency.name ||
      manifest.version !== dependency.version
    ) {
      fail("LICENSE_PNPM_MANIFEST_MISMATCH")
    }

    return {
      ecosystem: "npm",
      name: dependency.name,
      version: dependency.version,
      source: dependency.resolved,
      integrity: locked.integrity,
      license: manifest.license,
      attribution: [
        normalizePerson(manifest.author),
        ...(Array.isArray(manifest.contributors)
          ? manifest.contributors.map(normalizePerson)
          : []),
      ].filter(Boolean),
      repository: normalizeRepository(manifest.repository, manifest.homepage),
      evidence: collectEvidence(packageDirectory),
    }
  })
}

function collectCargoPackageIds(metadata) {
  if (!metadata.resolve?.root || !Array.isArray(metadata.resolve.nodes)) {
    fail("LICENSE_CARGO_METADATA_INVALID")
  }
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const visited = new Set([metadata.resolve.root])
  const queue = [metadata.resolve.root]

  while (queue.length > 0) {
    const node = nodes.get(queue.shift())
    if (!node) fail("LICENSE_CARGO_NODE_MISSING")
    for (const dependency of node.deps) {
      const isNormal = dependency.dep_kinds.some(
        (kind) => (kind.kind ?? "normal") === "normal",
      )
      if (isNormal && !visited.has(dependency.pkg)) {
        visited.add(dependency.pkg)
        queue.push(dependency.pkg)
      }
    }
  }
  visited.delete(metadata.resolve.root)
  return visited
}

export function validateCargoResolution(locked, source) {
  if (!locked?.source || !locked.checksum) {
    fail("LICENSE_CARGO_CHECKSUM_MISSING")
  }
  if (locked.source !== source || !/^[a-f0-9]{64}$/u.test(locked.checksum)) {
    fail("LICENSE_CARGO_LOCK_MISMATCH")
  }
  if (source !== "registry+https://github.com/rust-lang/crates.io-index") {
    fail("LICENSE_CARGO_SOURCE_UNAPPROVED")
  }
}

function collectCargoPackages(cargoLock) {
  const metadata = runJson(
    "cargo",
    [
      "metadata",
      "--locked",
      "--offline",
      "--filter-platform",
      CARGO_TARGET,
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--format-version",
      "1",
    ],
    "LICENSE_CARGO_METADATA_FAILED",
  )
  const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]))

  return [...collectCargoPackageIds(metadata)].map((id) => {
    const entry = packages.get(id)
    if (!entry) fail("LICENSE_CARGO_PACKAGE_MISSING")
    const locked = cargoLock.get(`${entry.name}@${entry.version}`)
    validateCargoResolution(locked, entry.source)

    const packageDirectory = path.dirname(entry.manifest_path)
    return {
      ecosystem: "cargo",
      name: entry.name,
      version: entry.version,
      source: entry.source,
      integrity: locked.checksum,
      license: entry.license,
      attribution: Array.isArray(entry.authors)
        ? entry.authors.map(normalizePerson).filter(Boolean)
        : [],
      repository: normalizeRepository(entry.repository, entry.homepage),
      evidence: collectEvidence(packageDirectory, entry.license_file),
    }
  })
}

function compareDependency(left, right) {
  return (
    left.ecosystem.localeCompare(right.ecosystem) ||
    left.name.localeCompare(right.name) ||
    left.version.localeCompare(right.version) ||
    left.source.localeCompare(right.source)
  )
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ")
}

function markdownCodeBlock(value) {
  const longestRun = Math.max(
    0,
    ...[...value.matchAll(/`+/gu)].map(([run]) => run.length),
  )
  const fence = "`".repeat(Math.max(3, longestRun + 1))
  return `${fence}text\n${value}${fence}`
}

function renderNotice(inventory, dependencies) {
  const rows = dependencies
    .map(
      (dependency) =>
        `| ${dependency.ecosystem} | ${markdownCell(dependency.name)} | ${dependency.version} | ${markdownCell(dependency.license)} | ${markdownCell(dependency.attribution.join("; ") || dependency.repository)} | ${markdownCell(dependency.repository)} | ${dependency.evidence.map(({ sha256: digest }) => digest).join("<br>") || "None bundled"} |`,
    )
    .join("\n")

  const evidenceByDigest = new Map()
  for (const dependency of dependencies) {
    for (const evidence of dependency.evidence) {
      const previous = evidenceByDigest.get(evidence.sha256)
      if (previous && previous.text !== evidence.text) {
        fail("LICENSE_EVIDENCE_DIGEST_CONFLICT")
      }
      evidenceByDigest.set(evidence.sha256, evidence)
    }
  }
  const evidenceBlocks = [...evidenceByDigest.values()]
    .sort((left, right) => left.sha256.localeCompare(right.sha256))
    .map(
      (evidence) => `### ${evidence.sha256}

- Source bytes: \`${evidence.bytes}\`

${markdownCodeBlock(evidence.text)}`,
    )
    .join("\n\n")

  return `# Production Dependency Notices

This generated notice conservatively covers the complete locked npm \`dependencies\` closure and the Cargo normal dependency closure for \`${CARGO_TARGET}\`. The npm list is based on package-manager classification, not a claim that every listed package contributed bytes to the final Vite bundle; for example, the declared \`shadcn\` dependency brings CLI transitive packages even though the application imports its build-time stylesheet. The notice is generated offline by \`scripts/licenses/dependency-notices.mjs\`; do not edit it directly.

The Live2D Cubism SDK, Cubism Core, Cubism Framework, and bundled Hiyori terms remain indexed separately in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). This notice does not grant a license to Coding Wife itself.

## Reproducibility

- pnpm lock SHA-256: \`${inventory.generatedFrom.pnpmLockSha256}\`
- Cargo lock SHA-256: \`${inventory.generatedFrom.cargoLockSha256}\`
- npm declared production-closure dependencies: \`${inventory.summary.npm}\`
- Cargo runtime dependencies: \`${inventory.summary.cargo}\`
- Unknown licenses: \`${inventory.summary.unknown}\`
- Forbidden licenses: \`${inventory.summary.forbidden}\`
- Missing required metadata: \`${inventory.summary.missing}\`

## Dependency inventory

| Ecosystem | Package | Version | License | Attribution | Repository / homepage | Evidence SHA-256 |
| --- | --- | --- | --- | --- | --- | --- |
${rows}

## License and attribution evidence

The following unique, locally installed license/notice files are normalized only for Markdown line endings, tab display, and trailing whitespace. Their source byte counts and SHA-256 values are recorded above each copy; packages reference the hashes in the inventory table and JSON inventory. A package without a bundled evidence file remains listed with its registry license declaration and attribution; a missing license declaration, locked source, integrity/checksum, or attribution fails the generator.

${evidenceBlocks}
`
}

function publicDependency(dependency) {
  return {
    ecosystem: dependency.ecosystem,
    name: dependency.name,
    version: dependency.version,
    source: dependency.source,
    integrity: dependency.integrity,
    license: dependency.license,
    attribution: dependency.attribution,
    repository: dependency.repository,
    evidence: dependency.evidence.map(({ file, bytes, sha256: digest }) => ({
      file,
      bytes,
      sha256: digest,
    })),
  }
}

export function summarizeDependencies(dependencies) {
  const policy = dependencies.map((dependency) => ({
    dependency,
    classification: classifyLicense(dependency.license),
  }))
  const summary = {
    total: dependencies.length,
    npm: dependencies.filter(({ ecosystem }) => ecosystem === "npm").length,
    cargo: dependencies.filter(({ ecosystem }) => ecosystem === "cargo").length,
    unknown: policy.filter(
      ({ classification }) => classification.status === "unknown",
    ).length,
    forbidden: policy.filter(
      ({ classification }) => classification.status === "forbidden",
    ).length,
    missing: policy.filter(
      ({ classification }) => classification.status === "missing",
    ).length,
  }
  if (summary.unknown > 0) fail("LICENSE_POLICY_UNKNOWN")
  if (summary.forbidden > 0) fail("LICENSE_POLICY_FORBIDDEN")
  if (summary.missing > 0) fail("LICENSE_POLICY_MISSING")
  return summary
}

export function generateDependencyNoticeArtifacts() {
  const pnpmLockContents = readUtf8("pnpm-lock.yaml")
  const cargoLockContents = readUtf8("src-tauri/Cargo.lock")
  const dependencies = [
    ...collectPnpmPackages(parsePnpmLockPackages(pnpmLockContents)),
    ...collectCargoPackages(parseCargoLockPackages(cargoLockContents)),
  ].sort(compareDependency)

  const summary = summarizeDependencies(dependencies)

  const inventory = {
    schemaVersion: 1,
    generatedFrom: {
      pnpmLock: "pnpm-lock.yaml",
      pnpmLockSha256: sha256(pnpmLockContents),
      cargoLock: "src-tauri/Cargo.lock",
      cargoLockSha256: sha256(cargoLockContents),
      cargoTarget: CARGO_TARGET,
      policyVersion: 1,
    },
    summary,
    dependencies: dependencies.map(publicDependency),
  }

  return {
    inventory: `${JSON.stringify(inventory, null, 2)}\n`,
    notice: renderNotice(inventory, dependencies),
    summary,
  }
}

export function assertArtifactMatches(actual, expected, code) {
  if (actual !== expected) fail(code)
}

function canonicalFile(fileName) {
  return path.join(canonicalRoot, fileName)
}

function writeAtomic(fileName, contents) {
  mkdirSync(canonicalRoot, { recursive: true })
  const destination = canonicalFile(fileName)
  const temporary = `${destination}.tmp-${process.pid}`
  rmSync(temporary, { force: true })
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode: 0o644 })
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function writeDependencyNotices() {
  const artifacts = generateDependencyNoticeArtifacts()
  writeAtomic(DEPENDENCY_INVENTORY_FILE, artifacts.inventory)
  writeAtomic(DEPENDENCY_NOTICE_FILE, artifacts.notice)
  syncReleaseNotices(projectRoot)
  return checkDependencyNotices(artifacts)
}

export function checkDependencyNotices(precomputed) {
  const artifacts = precomputed ?? generateDependencyNoticeArtifacts()
  assertArtifactMatches(
    readFileSync(canonicalFile(DEPENDENCY_INVENTORY_FILE), "utf8"),
    artifacts.inventory,
    "LICENSE_INVENTORY_STALE",
  )
  assertArtifactMatches(
    readFileSync(canonicalFile(DEPENDENCY_NOTICE_FILE), "utf8"),
    artifacts.notice,
    "LICENSE_NOTICE_STALE",
  )
  verifyReleaseNotices(projectRoot)
  return artifacts.summary
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    const action = process.argv[2] ?? "--check"
    const summary =
      action === "--write"
        ? writeDependencyNotices()
        : action === "--check"
          ? checkDependencyNotices()
          : fail("LICENSE_ARGUMENT_INVALID")
    process.stdout.write(
      `[licenses] verified ${summary.total} dependencies (npm production closure ${summary.npm}, Cargo runtime ${summary.cargo}); unknown ${summary.unknown}, forbidden ${summary.forbidden}, missing ${summary.missing}\n`,
    )
  } catch (error) {
    const message =
      error instanceof Error && /^LICENSE_[A-Z0-9_]+$/u.test(error.message)
        ? error.message
        : "LICENSE_CHECK_FAILED"
    process.stderr.write(`error: ${message}\n`)
    process.exitCode = 1
  }
}
