#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { constants as fsConstants, createReadStream } from "node:fs"
import {
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  assertProductionBundleClean,
  ProductionBundleError,
} from "./production-bundle.mjs"
import {
  containsPrivateAbsolutePath,
  privatePathRoots,
} from "./private-path-hygiene.mjs"

const projectRoot = fileURLToPath(new URL("../..", import.meta.url))
const tauriConfigPath = path.join(projectRoot, "src-tauri", "tauri.conf.json")
const inventorySchemaVersion = 2
const maximumInventoryBytes = 16 * 1024 * 1024
const scanOverlapBytes = 2048
const releaseManifestSchemaVersion = 1
const releaseRunIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const privateRoots = privatePathRoots(projectRoot)
const canonicalLegalRoot = path.join(
  projectRoot,
  "src-tauri",
  "resources",
  "legal",
)
const projectLicensePath = path.join(projectRoot, "LICENSE")
const packagedProjectLicenseName = "CODING-WIFE-LICENSE.txt"

const requiredResourceFiles = Object.freeze([
  "Contents/Resources/resources/characters/builtin-hiyori/NOTICE.txt",
  "Contents/Resources/resources/characters/builtin-hiyori/pack.json",
  `Contents/Resources/resources/legal/${packagedProjectLicenseName}`,
  "Contents/Resources/resources/legal/THIRD-PARTY-NOTICES.md",
  "Contents/Resources/resources/legal/THIRD-PARTY-DEPENDENCIES.json",
  "Contents/Resources/resources/legal/THIRD-PARTY-DEPENDENCIES.md",
  "Contents/Resources/resources/legal/live2d/cubism-sdk-5-r.5/LICENSE.md",
  "Contents/Resources/resources/skills/manifest.json",
  "Contents/Resources/resources/skills/coding-wife-commit-work/SKILL.md",
  "Contents/Resources/resources/skills/coding-wife-explain-commit/SKILL.md",
  "Contents/_CodeSignature/CodeResources",
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

function digestInventory(rootMode, entries) {
  return createHash("sha256")
    .update(JSON.stringify({ entries, rootMode }))
    .digest("hex")
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
}

function assertPathHygiene(value, code) {
  if (containsPrivateAbsolutePath(value, privateRoots)) fail(code)
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
  const canonicalRoot = await realpath(appPath).catch(() =>
    fail("APP_INVENTORY_ROOT_INVALID"),
  )
  const rootMode = normalizedMode(rootMetadata)

  const entries = []
  async function visit(absolutePath, relativePath) {
    const metadata = await lstat(absolutePath)
    const base = { path: relativePath, mode: normalizedMode(metadata) }
    assertPathHygiene(relativePath, "APP_PRIVATE_PATH_ENTRY")
    if (metadata.isSymbolicLink()) {
      const target = await readlink(absolutePath)
      assertPathHygiene(target, "APP_PRIVATE_PATH_SYMLINK")
      if (
        path.isAbsolute(target) ||
        path.win32.isAbsolute(target) ||
        target.startsWith("\\\\")
      ) {
        fail("APP_SYMLINK_ABSOLUTE")
      }
      const lexicalTarget = path.resolve(path.dirname(absolutePath), target)
      if (!isInside(path.resolve(appPath), lexicalTarget)) {
        fail("APP_SYMLINK_ESCAPE")
      }
      let resolvedTarget
      try {
        resolvedTarget = await realpath(absolutePath)
      } catch {
        fail("APP_SYMLINK_BROKEN")
      }
      if (!isInside(canonicalRoot, resolvedTarget)) fail("APP_SYMLINK_ESCAPE")
      entries.push({
        ...base,
        type: "symlink",
        target,
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
    rootMode,
    digest: digestInventory(rootMode, entries),
    entries,
  }
}

function validateInventory(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schemaVersion !== inventorySchemaVersion ||
    !/^[0-7]{4}$/u.test(value.rootMode) ||
    typeof value.digest !== "string" ||
    !Array.isArray(value.entries) ||
    value.digest !== digestInventory(value.rootMode, value.entries)
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

async function containsPrivatePath(file) {
  let carry = ""
  for await (const chunkValue of createReadStream(file, {
    highWaterMark: 64 * 1024,
  })) {
    const chunk = Buffer.isBuffer(chunkValue)
      ? chunkValue
      : Buffer.from(chunkValue)
    const content = `${carry}${chunk.toString("latin1")}`
    if (containsPrivateAbsolutePath(content, privateRoots)) return true
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
    assertPathHygiene(entry.path, "APP_PRIVATE_PATH_ENTRY")
    if (entry.type === "symlink") {
      assertPathHygiene(entry.target, "APP_PRIVATE_PATH_SYMLINK")
    }
    if (entry.type !== "file") continue
    const file = path.join(appPath, ...entry.path.split("/"))
    if (await containsPrivatePath(file)) fail("APP_PRIVATE_PATH_CONTENT")
    if (await containsCredential(file)) fail("APP_CREDENTIAL_CONTENT")
  }
}

async function collectLegalTree(root) {
  const entries = []

  async function visit(absolutePath, relativePath) {
    const metadata = await lstat(absolutePath)
    if (
      metadata.isSymbolicLink() ||
      (!metadata.isDirectory() && !metadata.isFile())
    ) {
      fail("APP_LEGAL_RESOURCES_INVALID")
    }
    if (metadata.isDirectory()) {
      const children = await readdir(absolutePath)
      children.sort(compareNames)
      for (const child of children) {
        await visit(
          path.join(absolutePath, child),
          relativePath === "" ? child : `${relativePath}/${child}`,
        )
      }
      return
    }
    entries.push({
      path: relativePath,
      size: metadata.size,
      sha256: await sha256File(absolutePath),
    })
  }

  try {
    await visit(root, "")
  } catch (error) {
    if (error instanceof MacOSReleaseError) throw error
    fail("APP_LEGAL_RESOURCES_INVALID")
  }
  return entries
}

export async function verifyPackagedLegalResources(appPath) {
  const packagedRoot = path.join(
    appPath,
    "Contents",
    "Resources",
    "resources",
    "legal",
  )
  try {
    const [canonical, packaged, projectLicense, packagedProjectLicense] =
      await Promise.all([
        collectLegalTree(canonicalLegalRoot),
        collectLegalTree(packagedRoot),
        readFile(projectLicensePath),
        readFile(path.join(canonicalLegalRoot, packagedProjectLicenseName)),
      ])
    if (
      !isDeepStrictEqual(canonical, packaged) ||
      !projectLicense.equals(packagedProjectLicense)
    ) {
      fail("APP_LEGAL_RESOURCES_MISMATCH")
    }
  } catch (error) {
    if (error instanceof MacOSReleaseError) throw error
    fail("APP_LEGAL_RESOURCES_INVALID")
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
  if (inventory.rootMode !== "0755") fail("APP_ROOT_MODE_INVALID")
  const infoPath = path.join(appPath, "Contents", "Info.plist")
  const plist = parsePlist(infoPath)
  if (
    plist.CFBundleIdentifier !== expectations.bundleId ||
    plist.CFBundleDisplayName !== expectations.productName ||
    plist.CFBundleExecutable !== expectations.executable ||
    plist.CFBundlePackageType !== "APPL" ||
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
    !/\n\s*platform (?:1|MACOS)\n/u.test(loadCommands)
  ) {
    fail("APP_BUILD_PLATFORM_INVALID")
  }
  if (!minimumPattern.test(loadCommands)) {
    fail("APP_MINIMUM_SYSTEM_VERSION_INVALID")
  }

  await verifyPackagedLegalResources(appPath)
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

async function hashFileHandle(handle, size, destination) {
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(128 * 1024)
  let position = 0
  while (position < size) {
    const length = Math.min(buffer.length, size - position)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (bytesRead !== length) fail("DMG_SNAPSHOT_SOURCE_CHANGED")
    const chunk = buffer.subarray(0, bytesRead)
    hash.update(chunk)
    if (destination !== undefined) {
      let written = 0
      while (written < bytesRead) {
        const result = await destination.write(
          chunk,
          written,
          bytesRead - written,
          position + written,
        )
        if (result.bytesWritten < 1) fail("DMG_SNAPSHOT_WRITE_FAILED")
        written += result.bytesWritten
      }
    }
    position += bytesRead
  }
  return hash.digest("hex")
}

function sameArtifactIdentity(metadata, expected) {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    String(metadata.dev) === expected.dev &&
    String(metadata.ino) === expected.ino &&
    String(metadata.size) === expected.size
  )
}

function artifactIdentity(metadata, sha256) {
  return {
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    size: String(metadata.size),
    sha256,
  }
}

async function openRegularArtifact(artifactPath) {
  let before
  try {
    before = await lstat(artifactPath)
  } catch {
    fail("DMG_SNAPSHOT_SOURCE_INVALID")
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1) {
    fail("DMG_SNAPSHOT_SOURCE_INVALID")
  }
  let handle
  try {
    handle = await open(
      artifactPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    )
  } catch {
    fail("DMG_SNAPSHOT_SOURCE_INVALID")
  }
  const opened = await handle.stat()
  const expected = artifactIdentity(before, "")
  if (!sameArtifactIdentity(opened, expected)) {
    await handle.close()
    fail("DMG_SNAPSHOT_SOURCE_CHANGED")
  }
  return { before, expected, handle }
}

export async function createArtifactSnapshot(
  sourcePath,
  snapshotPath,
  metadataPath,
) {
  const { before, expected, handle } = await openRegularArtifact(sourcePath)
  let destination
  try {
    const preHash = await hashFileHandle(handle, before.size)
    destination = await open(
      snapshotPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    )
    const copyHash = await hashFileHandle(handle, before.size, destination)
    await destination.sync()
    await destination.close()
    destination = undefined

    const postHash = await hashFileHandle(handle, before.size)
    const [openedAfter, pathAfter] = await Promise.all([
      handle.stat(),
      lstat(sourcePath),
    ])
    if (
      preHash !== copyHash ||
      preHash !== postHash ||
      !sameArtifactIdentity(openedAfter, expected) ||
      !sameArtifactIdentity(pathAfter, expected)
    ) {
      fail("DMG_SNAPSHOT_SOURCE_CHANGED")
    }

    const metadata = {
      schemaVersion: releaseManifestSchemaVersion,
      ...artifactIdentity(before, preHash),
    }
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    return { size: before.size, sha256: preHash }
  } catch (error) {
    await rm(snapshotPath, { force: true }).catch(() => {})
    await rm(metadataPath, { force: true }).catch(() => {})
    if (error instanceof MacOSReleaseError) throw error
    fail("DMG_SNAPSHOT_FAILED")
  } finally {
    await destination?.close().catch(() => {})
    await handle.close().catch(() => {})
  }
}

async function readSnapshotMetadata(metadataPath) {
  try {
    const metadataFile = await lstat(metadataPath)
    if (
      !metadataFile.isFile() ||
      metadataFile.isSymbolicLink() ||
      metadataFile.size > 4096
    ) {
      fail("DMG_SNAPSHOT_METADATA_INVALID")
    }
    const value = JSON.parse(await readFile(metadataPath, "utf8"))
    if (
      value?.schemaVersion !== releaseManifestSchemaVersion ||
      !/^[0-9]+$/u.test(value.dev) ||
      !/^[0-9]+$/u.test(value.ino) ||
      !/^[1-9][0-9]*$/u.test(value.size) ||
      !/^[a-f0-9]{64}$/u.test(value.sha256)
    ) {
      fail("DMG_SNAPSHOT_METADATA_INVALID")
    }
    return value
  } catch (error) {
    if (error instanceof MacOSReleaseError) throw error
    fail("DMG_SNAPSHOT_METADATA_INVALID")
  }
}

export async function assertArtifactSnapshot(
  sourcePath,
  snapshotPath,
  metadataPath,
) {
  const metadata = await readSnapshotMetadata(metadataPath)
  const { before, expected, handle } = await openRegularArtifact(sourcePath)
  try {
    const sourceHash = await hashFileHandle(handle, before.size)
    const [openedAfter, pathAfter, snapshot] = await Promise.all([
      handle.stat(),
      lstat(sourcePath),
      summarizeArtifact(snapshotPath),
    ])
    if (
      !sameArtifactIdentity(before, metadata) ||
      !sameArtifactIdentity(openedAfter, expected) ||
      !sameArtifactIdentity(pathAfter, expected) ||
      sourceHash !== metadata.sha256 ||
      snapshot.size !== Number(metadata.size) ||
      snapshot.sha256 !== metadata.sha256
    ) {
      fail("DMG_SNAPSHOT_SOURCE_CHANGED")
    }
    return snapshot
  } finally {
    await handle.close().catch(() => {})
  }
}

async function readInventoryDigest(inventoryPath) {
  return (await readExpectedInventory(inventoryPath)).digest
}

function validateReleaseManifest(value) {
  if (
    value?.schemaVersion !== releaseManifestSchemaVersion ||
    !["app", "dmg"].includes(value.kind) ||
    !releaseRunIdPattern.test(value.runId) ||
    typeof value.artifactName !== "string" ||
    value.artifactName.length < 1 ||
    value.artifactName.length > 127 ||
    !/^[a-f0-9]{64}$/u.test(value.inventoryDigest) ||
    (value.kind === "dmg" &&
      (!Number.isSafeInteger(value.size) ||
        value.size < 1 ||
        !/^[a-f0-9]{64}$/u.test(value.sha256))) ||
    (value.kind === "app" &&
      (value.size !== undefined || value.sha256 !== undefined))
  ) {
    fail("RELEASE_MANIFEST_INVALID")
  }
  return value
}

async function readReleaseManifest(manifestPath) {
  try {
    const metadata = await lstat(manifestPath)
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 16 * 1024
    ) {
      fail("RELEASE_MANIFEST_INVALID")
    }
    return validateReleaseManifest(
      JSON.parse(await readFile(manifestPath, "utf8")),
    )
  } catch (error) {
    if (error instanceof MacOSReleaseError) throw error
    fail("RELEASE_MANIFEST_INVALID")
  }
}

export async function createReleaseManifest({
  artifactPath,
  inventoryPath,
  kind,
  manifestPath,
  runId,
}) {
  if (!["app", "dmg"].includes(kind) || !releaseRunIdPattern.test(runId)) {
    fail("RELEASE_MANIFEST_ARGUMENT_INVALID")
  }
  const manifest = {
    schemaVersion: releaseManifestSchemaVersion,
    kind,
    runId,
    artifactName: path.basename(artifactPath),
    inventoryDigest: await readInventoryDigest(inventoryPath),
  }
  if (kind === "dmg")
    Object.assign(manifest, await summarizeArtifact(artifactPath))
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
  } catch {
    fail("RELEASE_MANIFEST_WRITE_FAILED")
  }
  return manifest
}

export async function verifyReleaseManifest({
  artifactPath,
  inventoryPath,
  kind,
  manifestPath,
  runId,
}) {
  const manifest = await readReleaseManifest(manifestPath)
  if (
    manifest.kind !== kind ||
    manifest.artifactName !== path.basename(artifactPath) ||
    manifest.inventoryDigest !== (await readInventoryDigest(inventoryPath)) ||
    (runId !== undefined && manifest.runId !== runId)
  ) {
    fail("RELEASE_MANIFEST_MISMATCH")
  }
  if (kind === "dmg") {
    const summary = await summarizeArtifact(artifactPath)
    if (manifest.size !== summary.size || manifest.sha256 !== summary.sha256) {
      fail("RELEASE_MANIFEST_MISMATCH")
    }
  }
  return manifest
}

function plistEntities(value) {
  const attached = value?.["system-entities"]
  if (Array.isArray(attached)) return attached
  const images = value?.images
  if (!Array.isArray(images)) fail("DMG_ATTACH_PLIST_INVALID")
  const entities = []
  for (const image of images) {
    if (!Array.isArray(image?.["system-entities"])) {
      fail("DMG_ATTACH_PLIST_INVALID")
    }
    entities.push(...image["system-entities"])
  }
  return entities
}

function parsePlistFile(plistPath) {
  return plistEntities(parsePlist(plistPath))
}

function deviceForMount(entities, mountPath) {
  const matches = entities.filter(
    (entity) => entity?.["mount-point"] === mountPath,
  )
  if (matches.length !== 1) fail("DMG_MOUNT_IDENTITY_INVALID")
  const device = matches[0]?.["dev-entry"]
  if (!/^\/dev\/disk[0-9]+s[0-9]+$/u.test(device)) {
    fail("DMG_MOUNT_IDENTITY_INVALID")
  }
  return device
}

export function attachedDeviceFromPlist(plistPath, mountPath) {
  return deviceForMount(parsePlistFile(plistPath), mountPath)
}

export function assertMountAbsentFromPlist(plistPath, mountPath, device) {
  if (!/^\/dev\/disk[0-9]+s[0-9]+$/u.test(device)) {
    fail("DMG_MOUNT_IDENTITY_INVALID")
  }
  const present = parsePlistFile(plistPath).some(
    (entity) =>
      entity?.["mount-point"] === mountPath || entity?.["dev-entry"] === device,
  )
  if (present) fail("DMG_MOUNT_STILL_PRESENT")
}

export function assertMountPathAbsentFromPlist(plistPath, mountPath) {
  const present = parsePlistFile(plistPath).some(
    (entity) => entity?.["mount-point"] === mountPath,
  )
  if (present) fail("DMG_MOUNT_STILL_PRESENT")
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
  if (command === "snapshot-create") {
    const values = parsePairs(args, ["--source", "--snapshot", "--metadata"])
    if (values.size !== 3) fail("APP_RELEASE_ARGUMENT_INVALID")
    const summary = await createArtifactSnapshot(
      values.get("--source"),
      values.get("--snapshot"),
      values.get("--metadata"),
    )
    process.stdout.write(
      `[release] DMG snapshot captured size=${String(summary.size)} sha256=${summary.sha256}\n`,
    )
    return
  }
  if (command === "snapshot-assert") {
    const values = parsePairs(args, ["--source", "--snapshot", "--metadata"])
    if (values.size !== 3) fail("APP_RELEASE_ARGUMENT_INVALID")
    const summary = await assertArtifactSnapshot(
      values.get("--source"),
      values.get("--snapshot"),
      values.get("--metadata"),
    )
    process.stdout.write(
      `[release] DMG snapshot unchanged size=${String(summary.size)} sha256=${summary.sha256}\n`,
    )
    return
  }
  if (command === "manifest-create") {
    const values = parsePairs(args, [
      "--kind",
      "--run-id",
      "--artifact",
      "--inventory",
      "--output",
    ])
    if (values.size !== 5) fail("APP_RELEASE_ARGUMENT_INVALID")
    const manifest = await createReleaseManifest({
      artifactPath: values.get("--artifact"),
      inventoryPath: values.get("--inventory"),
      kind: values.get("--kind"),
      manifestPath: values.get("--output"),
      runId: values.get("--run-id"),
    })
    process.stdout.write(
      `[release] ${manifest.kind} manifest created run=${manifest.runId}\n`,
    )
    return
  }
  if (command === "manifest-verify") {
    const values = parsePairs(args, [
      "--kind",
      "--run-id",
      "--artifact",
      "--inventory",
      "--manifest",
    ])
    if (
      !values.has("--kind") ||
      !values.has("--artifact") ||
      !values.has("--inventory") ||
      !values.has("--manifest") ||
      values.size < 4
    ) {
      fail("APP_RELEASE_ARGUMENT_INVALID")
    }
    const manifest = await verifyReleaseManifest({
      artifactPath: values.get("--artifact"),
      inventoryPath: values.get("--inventory"),
      kind: values.get("--kind"),
      manifestPath: values.get("--manifest"),
      runId: values.get("--run-id"),
    })
    process.stdout.write(
      `[release] ${manifest.kind} manifest verified run=${manifest.runId}\n`,
    )
    return
  }
  if (command === "manifest-run-id") {
    const values = parsePairs(args, ["--manifest"])
    if (values.size !== 1) fail("APP_RELEASE_ARGUMENT_INVALID")
    process.stdout.write(
      `${(await readReleaseManifest(values.get("--manifest"))).runId}\n`,
    )
    return
  }
  if (command === "attached-device") {
    const values = parsePairs(args, ["--plist", "--mount"])
    if (values.size !== 2) fail("APP_RELEASE_ARGUMENT_INVALID")
    process.stdout.write(
      `${attachedDeviceFromPlist(values.get("--plist"), values.get("--mount"))}\n`,
    )
    return
  }
  if (command === "assert-mount-absent") {
    const values = parsePairs(args, ["--plist", "--mount", "--device"])
    if (values.size !== 3) fail("APP_RELEASE_ARGUMENT_INVALID")
    assertMountAbsentFromPlist(
      values.get("--plist"),
      values.get("--mount"),
      values.get("--device"),
    )
    return
  }
  if (command === "assert-mount-path-absent") {
    const values = parsePairs(args, ["--plist", "--mount"])
    if (values.size !== 2) fail("APP_RELEASE_ARGUMENT_INVALID")
    assertMountPathAbsentFromPlist(values.get("--plist"), values.get("--mount"))
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
