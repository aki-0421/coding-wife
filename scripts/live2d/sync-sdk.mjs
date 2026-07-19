import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  CORE_DECLARATION_SHA256,
  CORE_SHA256,
  CORE_VERSION,
  FRAMEWORK_TAG,
  FRAMEWORK_TAG_COMMIT,
  SDK_ARCHIVE_SHA256,
  SDK_ROOT,
  SDK_URL,
  SDK_VENDOR_FILES,
  SDK_VERSION,
  SHADER_FILES,
} from "./constants.mjs"
import { assertHash, fail, sha256 } from "./file-utils.mjs"
import { syncReleaseNotices } from "./release-notices.mjs"

const projectRoot = fileURLToPath(new URL("../..", import.meta.url))
const vendorParent = path.join(projectRoot, "vendor/live2d")
const destination = path.join(vendorParent, `cubism-sdk-${SDK_VERSION}`)
const publicDestination = path.join(projectRoot, "public/vendor/live2d")

function getArgument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function extractFile(archive, archiveEntry, output) {
  const result = spawnSync("unzip", ["-p", archive, archiveEntry], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  })

  if (result.error) {
    fail(`unable to run unzip: ${result.error.message}`)
  }
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    const detail = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8").trim()
      : "unknown unzip failure"
    fail(`unable to extract allowlisted SDK entry ${archiveEntry}: ${detail}`)
  }

  mkdirSync(path.dirname(output), { recursive: true })
  writeFileSync(output, result.stdout)
}

function copyPublicRuntime(vendorRoot) {
  const staging = `${publicDestination}.staging-${process.pid}`
  rmSync(staging, { force: true, recursive: true })
  mkdirSync(path.join(staging, "core"), { recursive: true })
  mkdirSync(path.join(staging, "shaders/webgl"), { recursive: true })

  copyFileSync(
    path.join(vendorRoot, "Core/live2dcubismcore.min.js"),
    path.join(staging, "core/live2dcubismcore.min.js"),
  )

  for (const shader of SHADER_FILES) {
    copyFileSync(
      path.join(vendorRoot, "Framework/Shaders/WebGL", shader),
      path.join(staging, "shaders/webgl", shader),
    )
  }

  rmSync(publicDestination, { force: true, recursive: true })
  renameSync(staging, publicDestination)
}

function main() {
  const archive = path.resolve(
    getArgument("--archive") ??
      process.env.LIVE2D_SDK_ARCHIVE ??
      path.join(projectRoot, "CubismSdkForWeb-5-r.5.zip"),
  )

  try {
    assertHash(archive, SDK_ARCHIVE_SHA256, "Cubism SDK archive")
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    fail(
      `${detail}\nDownload ${SDK_URL}, accept the upstream terms, and run ` +
        "`LIVE2D_SDK_ARCHIVE=/absolute/path/CubismSdkForWeb-5-r.5.zip node scripts/live2d/sync-sdk.mjs`.",
    )
  }

  mkdirSync(vendorParent, { recursive: true })
  const staging = path.join(vendorParent, `.sdk-staging-${process.pid}`)
  rmSync(staging, { force: true, recursive: true })
  mkdirSync(staging, { recursive: true })

  try {
    for (const relative of SDK_VENDOR_FILES) {
      extractFile(
        archive,
        `${SDK_ROOT}/${relative}`,
        path.join(staging, relative),
      )
    }

    assertHash(
      path.join(staging, "Core/live2dcubismcore.min.js"),
      CORE_SHA256,
      "Cubism Core runtime",
    )
    assertHash(
      path.join(staging, "Core/live2dcubismcore.d.ts"),
      CORE_DECLARATION_SHA256,
      "Cubism Core declaration",
    )

    const upstream = {
      schemaVersion: 1,
      sdkVersion: SDK_VERSION,
      sdkUrl: SDK_URL,
      sdkArchiveSha256: SDK_ARCHIVE_SHA256,
      frameworkTag: FRAMEWORK_TAG,
      frameworkTagCommit: FRAMEWORK_TAG_COMMIT,
      coreVersion: CORE_VERSION,
      coreSha256: CORE_SHA256,
      coreDeclarationSha256: CORE_DECLARATION_SHA256,
      frameworkSourceFileCount: SDK_VENDOR_FILES.filter((file) =>
        file.startsWith("Framework/src/"),
      ).length,
      shaderFileCount: SHADER_FILES.length,
    }
    writeFileSync(
      path.join(staging, "UPSTREAM.json"),
      `${JSON.stringify(upstream, null, 2)}\n`,
    )

    const checksumFiles = [...SDK_VENDOR_FILES, "UPSTREAM.json"].sort()
    const checksums = checksumFiles
      .map((relative) => `${sha256(path.join(staging, relative))}  ${relative}`)
      .join("\n")
    writeFileSync(path.join(staging, "checksums.sha256"), `${checksums}\n`)

    rmSync(destination, { force: true, recursive: true })
    renameSync(staging, destination)
    copyPublicRuntime(destination)
    syncReleaseNotices(projectRoot)
  } catch (error) {
    rmSync(staging, { force: true, recursive: true })
    throw error
  }

  console.log(
    `[live2d] synced Cubism SDK ${SDK_VERSION}: ${SDK_VENDOR_FILES.length} allowlisted upstream files, ${SHADER_FILES.length} shaders`,
  )
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
