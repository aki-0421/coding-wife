import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  CORE_DECLARATION_SHA256,
  CORE_SHA256,
  CORE_VERSION,
  FRAMEWORK_SOURCE_FILES,
  FRAMEWORK_TAG,
  FRAMEWORK_TAG_COMMIT,
  HIYORI_ENTRYPOINT,
  HIYORI_NOTICE_SHA256,
  HIYORI_PACK_ID,
  HIYORI_RUNTIME_FILES,
  HIYORI_RUNTIME_HASHES,
  SDK_ARCHIVE_SHA256,
  SDK_URL,
  SDK_VENDOR_FILES,
  SDK_VERSION,
  SHADER_FILES,
} from "./constants.mjs"
import {
  assertExactFiles,
  assertHash,
  fail,
  fileSize,
  readJson,
  sha256,
} from "./file-utils.mjs"
import { verifyReleaseNotices } from "./release-notices.mjs"

const projectRoot = fileURLToPath(new URL("../..", import.meta.url))
const vendorRoot = path.join(
  projectRoot,
  `vendor/live2d/cubism-sdk-${SDK_VERSION}`,
)
const publicRoot = path.join(projectRoot, "public/vendor/live2d")
const hiyoriRoot = path.join(
  projectRoot,
  "src-tauri/resources/characters/builtin-hiyori",
)

function verifyChecksums() {
  const checksumFile = path.join(vendorRoot, "checksums.sha256")
  const lines = readFileSync(checksumFile, "utf8").trim().split("\n")
  const expectedFiles = [...SDK_VENDOR_FILES, "UPSTREAM.json"].sort()
  if (lines.length !== expectedFiles.length) {
    fail(
      `Cubism checksum manifest must contain ${expectedFiles.length} entries, found ${lines.length}`,
    )
  }

  lines.forEach((line, index) => {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    if (!match) fail(`invalid checksum line: ${line}`)
    const [, expectedHash, relative] = match
    if (relative !== expectedFiles[index]) {
      fail(
        `checksum manifest file order mismatch: expected ${expectedFiles[index]}, received ${relative}`,
      )
    }
    assertHash(path.join(vendorRoot, relative), expectedHash, relative)
  })
}

function verifySdk() {
  assertExactFiles(
    vendorRoot,
    [...SDK_VENDOR_FILES, "UPSTREAM.json", "checksums.sha256"],
    "Cubism SDK vendor",
  )
  verifyChecksums()

  assertHash(
    path.join(vendorRoot, "Core/live2dcubismcore.min.js"),
    CORE_SHA256,
    "Cubism Core runtime",
  )
  assertHash(
    path.join(vendorRoot, "Core/live2dcubismcore.d.ts"),
    CORE_DECLARATION_SHA256,
    "Cubism Core declaration",
  )

  const upstream = readJson(path.join(vendorRoot, "UPSTREAM.json"))
  const expectedUpstream = {
    schemaVersion: 1,
    sdkVersion: SDK_VERSION,
    sdkUrl: SDK_URL,
    sdkArchiveSha256: SDK_ARCHIVE_SHA256,
    frameworkTag: FRAMEWORK_TAG,
    frameworkTagCommit: FRAMEWORK_TAG_COMMIT,
    coreVersion: CORE_VERSION,
    coreSha256: CORE_SHA256,
    coreDeclarationSha256: CORE_DECLARATION_SHA256,
    frameworkSourceFileCount: FRAMEWORK_SOURCE_FILES.length,
    shaderFileCount: SHADER_FILES.length,
  }
  if (JSON.stringify(upstream) !== JSON.stringify(expectedUpstream)) {
    fail("Cubism UPSTREAM.json does not match the reviewed version contract")
  }

  const publicFiles = [
    "core/live2dcubismcore.min.js",
    ...SHADER_FILES.map((file) => `shaders/webgl/${file}`),
  ]
  assertExactFiles(publicRoot, publicFiles, "Cubism public runtime")
  assertHash(
    path.join(publicRoot, "core/live2dcubismcore.min.js"),
    CORE_SHA256,
    "public Cubism Core runtime",
  )
  for (const shader of SHADER_FILES) {
    const vendorShader = path.join(
      vendorRoot,
      "Framework/Shaders/WebGL",
      shader,
    )
    const publicShader = path.join(publicRoot, "shaders/webgl", shader)
    if (sha256(vendorShader) !== sha256(publicShader)) {
      fail(`public shader differs from reviewed vendor source: ${shader}`)
    }
  }
}

function verifyHiyori() {
  const expectedFiles = [
    "NOTICE.txt",
    "pack.json",
    ...HIYORI_RUNTIME_FILES.map((file) => `runtime/${file}`),
  ]
  assertExactFiles(hiyoriRoot, expectedFiles, "bundled Hiyori pack")
  assertHash(
    path.join(hiyoriRoot, "NOTICE.txt"),
    HIYORI_NOTICE_SHA256,
    "bundled Hiyori notice",
  )

  for (const relative of HIYORI_RUNTIME_FILES) {
    assertHash(
      path.join(hiyoriRoot, "runtime", relative),
      HIYORI_RUNTIME_HASHES[relative],
      `bundled Hiyori ${relative}`,
    )
  }

  const pack = readJson(path.join(hiyoriRoot, "pack.json"))
  if (
    pack.schemaVersion !== 1 ||
    pack.packId !== HIYORI_PACK_ID ||
    pack.entrypoint !== `runtime/${HIYORI_ENTRYPOINT}` ||
    pack.immutable !== true ||
    pack.provenance?.sdkSampleSubstitution !== false ||
    pack.provenance?.noticeSha256 !== HIYORI_NOTICE_SHA256 ||
    pack.inventory?.runtimeFileCount !== 17 ||
    pack.inventory?.motionCount !== 10 ||
    pack.inventory?.expressionCount !== 0 ||
    !Array.isArray(pack.files) ||
    pack.files.length !== 17
  ) {
    fail("bundled Hiyori pack.json does not match the reviewed pack contract")
  }

  const expectedAssetIds = HIYORI_RUNTIME_FILES.map((file) => `runtime/${file}`)
  const actualAssetIds = pack.files.map((file) => file.assetId).sort()
  if (JSON.stringify(actualAssetIds) !== JSON.stringify(expectedAssetIds)) {
    fail("bundled Hiyori pack.json asset allowlist is incomplete or reordered")
  }

  let totalBytes = 0
  for (const descriptor of pack.files) {
    const relative = descriptor.assetId.replace(/^runtime\//, "")
    const file = path.join(hiyoriRoot, descriptor.assetId)
    if (
      descriptor.sha256 !== HIYORI_RUNTIME_HASHES[relative] ||
      descriptor.bytes !== fileSize(file)
    ) {
      fail(`bundled Hiyori descriptor mismatch: ${descriptor.assetId}`)
    }
    totalBytes += descriptor.bytes
  }
  if (pack.inventory.totalBytes !== totalBytes) {
    fail("bundled Hiyori total byte count mismatch")
  }

  for (const relative of expectedFiles) {
    if (/\.cmo3$|\.can3$|\.DS_Store$/.test(relative)) {
      fail(`authoring or metadata file entered the Hiyori bundle: ${relative}`)
    }
  }
}

export function verifyLive2dSupplyChain() {
  verifySdk()
  verifyHiyori()
  const releaseNotices = verifyReleaseNotices(projectRoot)
  return {
    frameworkSources: FRAMEWORK_SOURCE_FILES.length,
    shaders: SHADER_FILES.length,
    hiyoriRuntimeFiles: HIYORI_RUNTIME_FILES.length,
    releaseNoticeFiles: releaseNotices.files,
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    const result = verifyLive2dSupplyChain()
    console.log(
      `[live2d] verified vendor: ${result.frameworkSources} Framework sources, ${result.shaders} shaders, ${result.hiyoriRuntimeFiles} Hiyori runtime files, ${result.releaseNoticeFiles} third-party notice files`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
