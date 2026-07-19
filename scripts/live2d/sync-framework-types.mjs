import { randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { buildFramework } from "./build-framework.mjs"
import { FRAMEWORK_DECLARATION_FILES } from "./constants.mjs"
import { sha256 } from "./file-utils.mjs"

const projectRoot = fileURLToPath(new URL("../..", import.meta.url))
const output = path.join(projectRoot, "vendor/live2d/dist")
const destination = path.join(projectRoot, "vendor/live2d/types")
const token = `${String(process.pid)}-${randomUUID()}`
const stage = path.join(projectRoot, "vendor/live2d", `.types-stage-${token}`)
const backup = path.join(projectRoot, "vendor/live2d", `.types-backup-${token}`)

try {
  await buildFramework(projectRoot, { verifyTrackedTypes: false })
  for (const relative of FRAMEWORK_DECLARATION_FILES) {
    const target = path.join(stage, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    const declaration = readFileSync(
      path.join(output, relative),
      "utf8",
    ).replace(/[ \t]+$/gmu, "")
    writeFileSync(target, declaration)
  }
  const checksums = FRAMEWORK_DECLARATION_FILES.map(
    (relative) => `${sha256(path.join(stage, relative))}  ${relative}`,
  )
  writeFileSync(
    path.join(stage, "checksums.sha256"),
    `${checksums.join("\n")}\n`,
  )

  rmSync(backup, { force: true, recursive: true })
  if (existsSync(destination)) renameSync(destination, backup)
  try {
    renameSync(stage, destination)
  } catch (error) {
    if (!existsSync(destination) && existsSync(backup)) {
      renameSync(backup, destination)
    }
    throw error
  }
  rmSync(backup, { force: true, recursive: true })
  console.log(
    `[live2d] synced ${String(FRAMEWORK_DECLARATION_FILES.length)} tracked Framework declarations`,
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  rmSync(stage, { force: true, recursive: true })
  rmSync(backup, { force: true, recursive: true })
}
