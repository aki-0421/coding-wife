#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readFile, readdir, readlink, writeFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  assertProductionBundleClean,
  ProductionBundleError,
} from "./production-bundle.mjs"

const projectRoot = fileURLToPath(new URL("../..", import.meta.url))
const tauriConfigPath = path.join(projectRoot, "src-tauri", "tauri.conf.json")
const inventorySchemaVersion = 1
const maximumInventoryBytes = 16 * 1024 * 1024
const scanOverlapBytes = 256

const requiredResourceFiles = Object.freeze([
  "Contents/Resources/resources/characters/builtin-hiyori/NOTICE.txt",
  "Contents/Resources/resources/characters/builtin-hiyori/pack.json",
  "Contents/Resources/resources/legal/THIRD-PARTY-NOTICES.md",
  "Contents/Resources/resources/legal/THIRD-PARTY-DEPENDENCIES.json",
  "Contents/Resources/resources/legal/THIRD-PARTY-DEPENDENCIES.md",
  "Contents/Resources/resources/legal/live2d/cubism-sdk-5-r.5/LICENSE.md",
  "Contents/Resources/resources/skills/manifest.json",
  "Contents/Resources/resources/skills/coding-wife-commit-work/SKILL.md",
  "Contents/Resources/resources/skills/coding-wife-explain-commit/SKILL.md",
  "Contents/_CodeSignature/CodeResources",
])

const privatePathMarkers = Object.freeze([
  "/Users/",
  "/home/",
  "C:\\Users\\",
  "file:///Users/",
])

const credentialPatterns = Object.freeze([
  /sk-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /AKIA[A-Z0-9]{16}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
])

export class MacOSReleaseError extends Error {
  constructor(code) {
    super(code)
    this.name = "MacOSReleaseError"
    this.code = code
  }
}

function fail(code) {
  throw new MacOSReleaseError(code)
}

function compareNames(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function normalizedMode(metadata) {
  return (metadata.mode & 0o7777).toString(8).padStart(4, "0")
}

async function sha256File(file) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

function digestEntries(entries) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex")
}

export async function collectAppInventory(appPath) {
  let rootMetadata
  try {
    rootMetadata = await lstat(appPath)
  } catch {
    fail("APP_INVENTORY_ROOT_INVALID")
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail("APP_INVENTORY_ROOT_INVALID")
  }

  const entries = []
  async function visit(absolutePath, relativePath) {
    const metadata = await lstat(absolutePath)
    const base = { path: relativePath, mode: normalizedMode(metadata) }
    if (metadata.isSymbolicLink()) {
      entries.push({
        ...base,
        type: "symlink",
        target: await readlink(absolutePath),
      })
      return
    }
    if (metadata.isDirectory()) {
      entries.push({ ...base, type: "directory" })
      const children = await readdir(absolutePath)
      children.sort(compareNames)
      for (const child of children) {
        await visit(path.join(absolutePath, child), `${relativePath}/${child}`)
      }
      return
    }
    if (metadata.isFile()) {
      entries.push({
        ...base,
        type: "file",
        size: metadata.size,
        sha256: await sha256File(absolutePath),
      })
      return
    }
    fail("APP_INVENTORY_SPECIAL_FILE")
  }

  const children = await readdir(appPath)
  children.sort(compareNames)
  for (const child of children) await visit(path.join(appPath, child), child)
  entries.sort((left, right) => compareNames(left.path, right.path))
  return {
    schemaVersion: inventorySchemaVersion,
    digest: digestEntries(entries),
    entries,
  }
}

function validateInventory(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schemaVersion !== inventorySchemaVersion ||
    typeof value.digest !== "string" ||
    !Array.isArray(value.entries) ||
    value.digest !== digestEntries(value.entries)
  ) {
    fail("APP_INVENTORY_EXPECTED_INVALID")
  }
  return value
}

export async function writeAppInventory(appPath, outputPath) {
  const inventory = await collectAppInventory(appPath)
  try {
    await writeFile(outputPath, `${JSON.stringify(inventory)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
  } catch {
    fail("APP_INVENTORY_WRITE_FAILED")
  }
  return inventory
}

async function readExpectedInventory(expectedPath) {
  let metadata
  try {
    metadata = await lstat(expectedPath)
  } catch {
    fail("APP_INVENTORY_EXPECTED_INVALID")
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > maximumInventoryBytes
  ) {
    fail("APP_INVENTORY_EXPECTED_INVALID")
  }
  try {
    return validateInventory(JSON.parse(await readFile(expectedPath, "utf8")))
  } catch (error) {
    if (error instanceof MacOSReleaseError) throw error
    fail("APP_INVENTORY_EXPECTED_INVALID")
  }
}

export async function compareAppInventory(appPath, expectedPath) {
  const [actual, expected] = await Promise.all([
    collectAppInventory(appPath),
    readExpectedInventory(expectedPath),
  ])
  if (!isDeepStrictEqual(actual, expected)) fail("APP_INVENTORY_MISMATCH")
  return actual
}

function runTool(tool, args, acceptedStatuses = [0]) {
  const result = spawnSync(tool, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 16 * 1024 * 1024,
  })
  if (
    result.error !== undefined ||
    result.status === null ||
    !acceptedStatuses.includes(result.status)
  ) {
    fail("APP_RELEASE_TOOL_FAILED")
  }
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  }
}

async function releaseExpectations() {
  try {
    const config = JSON.parse(await readFile(tauriConfigPath, "utf8"))
    return {
      bundleId: config.identifier,
      executable: "coding-wife",
      minimumSystemVersion: config.bundle.macOS.minimumSystemVersion,
      productName: config.productName,
      version: config.version,
    }
  } catch {
    fail("APP_RELEASE_CONFIG_INVALID")
  }
}

async function containsAnyMarker(file, markers) {
  const needles = markers.map((marker) => Buffer.from(marker))
  let carry = Buffer.alloc(0)
  for await (const chunkValue of createReadStream(file, {
    highWaterMark: 64 * 1024,
  })) {
    const chunk = Buffer.isBuffer(chunkValue)
      ? chunkValue
      : Buffer.from(chunkValue)
    const content = Buffer.concat([carry, chunk])
    if (needles.some((needle) => content.indexOf(needle) !== -1)) return true
    carry = content.subarray(Math.max(0, content.length - scanOverlapBytes))
  }
  return false
}

async function containsCredential(file) {
  let carry = ""
  for await (const chunkValue of createReadStream(file, {
    highWaterMark: 64 * 1024,
  })) {
    const chunk = Buffer.isBuffer(chunkValue)
      ? chunkValue
      : Buffer.from(chunkValue)
    const content = `${carry}${chunk.toString("latin1")}`
    if (credentialPatterns.some((pattern) => pattern.test(content))) return true
    carry = content.slice(-scanOverlapBytes)
  }
  return false
}

function forbiddenPath(relativePath) {
  const lower = relativePath.toLowerCase()
  const segments = lower.split("/")
  const name = segments.at(-1) ?? ""
  return (
    segments.some((segment) =>
      [".git", "__fixtures__", "fixtures", "node_modules", "target"].includes(
        segment,
      ),
    ) ||
    /(?:^|[._-])demo(?:[._-]|$)/.test(name) ||
    /(?:\.map|\.ts|\.tsx|\.rs|\.py)$/.test(name) ||
    name === ".env" ||
    name.startsWith(".env.") ||
    /(?:^|[._-])(?:credentials?|secrets?|tokens?|cookies?|auth-state)(?:[._-]|$)/.test(
      name,
    )
  )
}

async function verifyForbiddenContent(appPath, inventory) {
  for (const entry of inventory.entries) {
    if (forbiddenPath(entry.path)) fail("APP_FORBIDDEN_PATH")
    if (entry.type !== "file") continue
    const file = path.join(appPath, ...entry.path.split("/"))
    if (await containsAnyMarker(file, privatePathMarkers)) {
      fail("APP_PRIVATE_PATH_CONTENT")
    }
    if (await containsCredential(file)) fail("APP_CREDENTIAL_CONTENT")
  }
}

function assertRequiredResources(inventory, executablePath) {
  const entriesByPath = new Map(
    inventory.entries.map((entry) => [entry.path, entry]),
  )
  for (const required of requiredResourceFiles) {
    if (entriesByPath.get(required)?.type !== "file")
      fail("APP_RESOURCE_MISSING")
  }
  const runtimePrefix =
    "Contents/Resources/resources/characters/builtin-hiyori/runtime/"
  const runtimeFiles = inventory.entries.filter(
    (entry) => entry.type === "file" && entry.path.startsWith(runtimePrefix),
  )
  if (runtimeFiles.length !== 17) fail("APP_HIYORI_INVENTORY_INVALID")
  const executable = entriesByPath.get(executablePath)
  if (
    executable?.type !== "file" ||
    (Number.parseInt(executable.mode, 8) & 0o111) === 0
  ) {
    fail("APP_EXECUTABLE_INVALID")
  }
}

function parsePlist(infoPath) {
  const result = runTool("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    infoPath,
  ])
  try {
    return JSON.parse(result.output)
  } catch {
    fail("APP_INFO_PLIST_INVALID")
  }
}

function verifySignature(appPath) {
  runTool("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ])
  const details = runTool("/usr/bin/codesign", [
    "-d",
    "--verbose=4",
    appPath,
  ]).output
  if (!/^Signature=adhoc$/m.test(details)) fail("APP_SIGNATURE_NOT_ADHOC")
  if (!/^TeamIdentifier=not set$/m.test(details))
    fail("APP_TEAM_IDENTIFIER_PRESENT")
  if (/^Authority=/m.test(details)) fail("APP_DEVELOPER_ID_PRESENT")

  const staple = runTool(
    "/usr/bin/xcrun",
    ["stapler", "validate", appPath],
    [0, 65],
  )
  if (staple.status === 0) fail("APP_NOTARIZATION_UNEXPECTED")
  if (!staple.output.includes("does not have a ticket stapled to it")) {
    fail("APP_NOTARIZATION_UNCLASSIFIED")
  }
}

async function verifyQuarantineAbsent(appPath) {
  const result = runTool("/usr/bin/xattr", ["-lr", appPath], [0, 1])
  if (result.output.includes("com.apple.quarantine:"))
    fail("APP_QUARANTINE_PRESENT")
}

async function verifyEmbeddedRuntime(executablePath) {
  if (
    !(await containsAnyMarker(executablePath, ["CODEX-SUPPORT-RUNTIME-USED"]))
  ) {
    fail("APP_SUPPORT_RUNTIME_MISSING")
  }
  if (
    !(await containsAnyMarker(executablePath, [
      "CREATE TABLE IF NOT EXISTS schema_migrations",
    ]))
  ) {
    fail("APP_SCHEMA_MIGRATION_MISSING")
  }
}

export async function verifyReleaseApp(appPath, expectedInventoryPath) {
  if (process.platform !== "darwin") fail("APP_RELEASE_PLATFORM_UNSUPPORTED")
  const expectations = await releaseExpectations()
  const inventory =
    expectedInventoryPath === undefined
      ? await collectAppInventory(appPath)
      : await compareAppInventory(appPath, expectedInventoryPath)
  const infoPath = path.join(appPath, "Contents", "Info.plist")
  const plist = parsePlist(infoPath)
  if (
    plist.CFBundleIdentifier !== expectations.bundleId ||
    plist.CFBundleDisplayName !== expectations.productName ||
    plist.CFBundleExecutable !== expectations.executable ||
    plist.CFBundleShortVersionString !== expectations.version ||
    plist.CFBundleVersion !== expectations.version ||
    plist.LSMinimumSystemVersion !== expectations.minimumSystemVersion
  ) {
    fail("APP_BUNDLE_METADATA_INVALID")
  }

  const executableRelativePath = `Contents/MacOS/${expectations.executable}`
  const executablePath = path.join(
    appPath,
    ...executableRelativePath.split("/"),
  )
  assertRequiredResources(inventory, executableRelativePath)
  const architectures = runTool("/usr/bin/lipo", [
    "-archs",
    executablePath,
  ]).output.trim()
  if (architectures !== "arm64") fail("APP_ARCHITECTURE_INVALID")
  const loadCommands = runTool("/usr/bin/otool", ["-l", executablePath]).output
  const minimumPattern = new RegExp(
    `\\n\\s*minos ${expectations.minimumSystemVersion.replace(".", "\\.")}(?:\\.0)?\\n`,
  )
  if (
    !loadCommands.includes("LC_BUILD_VERSION") ||
    !minimumPattern.test(loadCommands)
  ) {
    fail("APP_MINIMUM_SYSTEM_VERSION_INVALID")
  }

  verifySignature(appPath)
  await verifyQuarantineAbsent(appPath)
  await verifyEmbeddedRuntime(executablePath)
  try {
    await assertProductionBundleClean(appPath)
  } catch (error) {
    if (error instanceof ProductionBundleError) fail("APP_DEMO_RUNTIME_PRESENT")
    throw error
  }
  await verifyForbiddenContent(appPath, inventory)
  return inventory
}

export async function summarizeArtifact(artifactPath) {
  let metadata
  try {
    metadata = await lstat(artifactPath)
  } catch {
    fail("DMG_ARTIFACT_INVALID")
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1) {
    fail("DMG_ARTIFACT_INVALID")
  }
  return { size: metadata.size, sha256: await sha256File(artifactPath) }
}

function parsePairs(args, allowed) {
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (
      key === undefined ||
      value === undefined ||
      !allowed.includes(key) ||
      values.has(key) ||
      value.length === 0
    ) {
      fail("APP_RELEASE_ARGUMENT_INVALID")
    }
    values.set(key, value)
  }
  return values
}

async function main(argv) {
  const [command, ...args] = argv
  if (command === "inventory") {
    const values = parsePairs(args, ["--app", "--output"])
    if (values.size !== 2) fail("APP_RELEASE_ARGUMENT_INVALID")
    const inventory = await writeAppInventory(
      values.get("--app"),
      values.get("--output"),
    )
    process.stdout.write(
      `[release] app inventory recorded: ${inventory.digest}\n`,
    )
    return
  }
  if (command === "compare") {
    const values = parsePairs(args, ["--app", "--expected"])
    if (values.size !== 2) fail("APP_RELEASE_ARGUMENT_INVALID")
    const inventory = await compareAppInventory(
      values.get("--app"),
      values.get("--expected"),
    )
    process.stdout.write(
      `[release] app inventory matched: ${inventory.digest}\n`,
    )
    return
  }
  if (command === "verify-app") {
    const values = parsePairs(args, ["--app", "--expected"])
    if (!values.has("--app") || values.size > 2)
      fail("APP_RELEASE_ARGUMENT_INVALID")
    const inventory = await verifyReleaseApp(
      values.get("--app"),
      values.get("--expected"),
    )
    process.stdout.write(
      `[release] app verified: adhoc=yes developer_id=no notarized=no inventory=${inventory.digest}\n`,
    )
    return
  }
  if (command === "dmg-summary") {
    const values = parsePairs(args, ["--dmg"])
    if (values.size !== 1) fail("APP_RELEASE_ARGUMENT_INVALID")
    const summary = await summarizeArtifact(values.get("--dmg"))
    process.stdout.write(
      `[release] final DMG size=${String(summary.size)} sha256=${summary.sha256}\n`,
    )
    return
  }
  fail("APP_RELEASE_ARGUMENT_INVALID")
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    const code =
      error instanceof MacOSReleaseError ? error.code : "APP_RELEASE_FAILED"
    process.stderr.write(`[release] ${code}\n`)
    process.exitCode = 1
  }
}
