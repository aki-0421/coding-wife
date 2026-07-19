import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  FRAMEWORK_DECLARATION_FILES,
  FRAMEWORK_SOURCE_FILES,
} from "./constants.mjs"
import { assertExactFiles, fail, listFiles, sha256 } from "./file-utils.mjs"

const defaultProjectRoot = fileURLToPath(new URL("../..", import.meta.url))
const compilerVersion = "5.9.3"

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function lockOwner(lockFile) {
  try {
    const value = JSON.parse(readFileSync(lockFile, "utf8"))
    if (
      typeof value === "object" &&
      value !== null &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.token === "string" &&
      typeof value.startedAt === "string"
    ) {
      return value
    }
  } catch {
    // A malformed lock is recovered only after the stale timeout.
  }
  return null
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    )
  }
}

function staleLock(lockFile, staleAfterMs, now) {
  try {
    const age = now() - statSync(lockFile).mtimeMs
    if (age <= staleAfterMs) return false
    const owner = lockOwner(lockFile)
    return owner === null || !processIsAlive(owner.pid)
  } catch {
    return false
  }
}

export async function withBuildLock(
  lockFile,
  operation,
  {
    now = Date.now,
    retryIntervalMs = 50,
    staleAfterMs = 10 * 60_000,
    timeoutMs = 2 * 60_000,
    wait = delay,
  } = {},
) {
  mkdirSync(path.dirname(lockFile), { recursive: true })
  const token = randomUUID()
  const deadline = now() + timeoutMs

  for (;;) {
    let descriptor
    let created = false
    try {
      descriptor = openSync(lockFile, "wx", 0o600)
      created = true
      writeFileSync(
        descriptor,
        JSON.stringify({
          pid: process.pid,
          token,
          startedAt: new Date().toISOString(),
        }),
      )
      closeSync(descriptor)
      descriptor = undefined
      break
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor)
        } catch {
          // The original lock creation error remains authoritative.
        }
      }
      if (created) {
        try {
          unlinkSync(lockFile)
        } catch {
          // The original lock creation error remains authoritative.
        }
        throw error
      }
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      )) {
        throw error
      }
      if (staleLock(lockFile, staleAfterMs, now)) {
        try {
          unlinkSync(lockFile)
        } catch (unlinkError) {
          if (!(
            typeof unlinkError === "object" &&
            unlinkError !== null &&
            "code" in unlinkError &&
            unlinkError.code === "ENOENT"
          )) {
            throw unlinkError
          }
        }
        continue
      }
      if (now() >= deadline) {
        fail(`timed out waiting for Framework build lock: ${lockFile}`)
      }
      await wait(retryIntervalMs)
    }
  }

  try {
    return await operation()
  } finally {
    const owner = lockOwner(lockFile)
    if (owner?.token === token) {
      try {
        unlinkSync(lockFile)
      } catch (error) {
        if (!(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )) {
          throw error
        }
      }
    }
  }
}

function frameworkOutputFiles() {
  return FRAMEWORK_SOURCE_FILES.flatMap((source) => {
    const stem = source.replace(/\.ts$/u, "")
    return [`${stem}.d.ts`, `${stem}.js`]
  })
}

function assertFrameworkOutput(root) {
  assertExactFiles(root, frameworkOutputFiles(), "compiled Cubism Framework")
}

function assertTrackedFrameworkTypes(stage, trackedTypes) {
  assertExactFiles(
    trackedTypes,
    [...FRAMEWORK_DECLARATION_FILES, "checksums.sha256"],
    "tracked Cubism Framework declarations",
  )
  for (const relative of FRAMEWORK_DECLARATION_FILES) {
    const generated = readFileSync(path.join(stage, relative), "utf8").replace(
      /[ \t]+$/gmu,
      "",
    )
    const tracked = readFileSync(path.join(trackedTypes, relative), "utf8")
    if (generated !== tracked) {
      fail(
        `tracked Cubism declaration differs from fixed-compiler output: ${relative}; run pnpm live2d:sync:framework-types`,
      )
    }
  }
}

function sameDirectoryContents(left, right) {
  if (!existsSync(left) || !existsSync(right)) return false
  const leftFiles = listFiles(left)
  const rightFiles = listFiles(right)
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) return false
  return leftFiles.every(
    (relative) =>
      sha256(path.join(left, relative)) === sha256(path.join(right, relative)),
  )
}

export function publishStagedFramework(stage, output, backup) {
  if (sameDirectoryContents(stage, output)) {
    rmSync(stage, { force: true, recursive: true })
    return "current"
  }

  rmSync(backup, { force: true, recursive: true })
  if (!existsSync(output)) {
    renameSync(stage, output)
    return "published"
  }

  renameSync(output, backup)
  try {
    renameSync(stage, output)
  } catch (error) {
    if (!existsSync(output) && existsSync(backup)) renameSync(backup, output)
    throw error
  }
  rmSync(backup, { force: true, recursive: true })
  return "published"
}

function clearAbandonedBuilds(cacheRoot) {
  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      (entry.name.startsWith("stage-") || entry.name.startsWith("backup-"))
    ) {
      rmSync(path.join(cacheRoot, entry.name), {
        force: true,
        recursive: true,
      })
    }
  }
}

export async function buildFramework(
  projectRoot = defaultProjectRoot,
  { verifyTrackedTypes = true } = {},
) {
  const compilerPackage = path.join(
    projectRoot,
    "node_modules/typescript-cubism/package.json",
  )
  const compiler = path.join(
    projectRoot,
    "node_modules/typescript-cubism/bin/tsc",
  )
  const config = path.join(projectRoot, "vendor/live2d/tsconfig.json")
  const output = path.join(projectRoot, "vendor/live2d/dist")
  const trackedTypes = path.join(projectRoot, "vendor/live2d/types")
  const cacheRoot = path.join(
    projectRoot,
    "node_modules/.cache/coding-wife-live2d",
  )
  const lockFile = path.join(cacheRoot, "framework.lock")

  return withBuildLock(lockFile, () => {
    const version = JSON.parse(readFileSync(compilerPackage, "utf8")).version
    if (version !== compilerVersion) {
      fail(
        `Cubism Framework compiler must be TypeScript ${compilerVersion}, found ${String(version)}`,
      )
    }

    clearAbandonedBuilds(cacheRoot)
    const token = `${String(process.pid)}-${randomUUID()}`
    const stage = path.join(cacheRoot, `stage-${token}`)
    const backup = path.join(cacheRoot, `backup-${token}`)

    try {
      const result = spawnSync(
        process.execPath,
        [compiler, "-p", config, "--outDir", stage],
        {
          cwd: projectRoot,
          stdio: "inherit",
        },
      )
      if (result.error) {
        fail(`unable to run Cubism compiler: ${result.error.message}`)
      }
      if (result.status !== 0) {
        fail(
          `Cubism Framework compilation failed with exit code ${String(result.status)}`,
        )
      }

      assertFrameworkOutput(stage)
      if (verifyTrackedTypes) assertTrackedFrameworkTypes(stage, trackedTypes)
      const publication = publishStagedFramework(stage, output, backup)
      console.log(
        publication === "current"
          ? `[live2d] Framework output is current (TypeScript ${compilerVersion})`
          : `[live2d] compiled official Framework with TypeScript ${compilerVersion}`,
      )
      return publication
    } finally {
      rmSync(stage, { force: true, recursive: true })
      rmSync(backup, { force: true, recursive: true })
    }
  })
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    await buildFramework()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
