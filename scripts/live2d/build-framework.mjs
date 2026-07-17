import { spawnSync } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { fail } from "./file-utils.mjs"

const projectRoot = fileURLToPath(new URL("../..", import.meta.url))
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

try {
  const version = JSON.parse(readFileSync(compilerPackage, "utf8")).version
  if (version !== "5.9.3") {
    fail(`Cubism Framework compiler must be TypeScript 5.9.3, found ${version}`)
  }

  rmSync(output, { force: true, recursive: true })
  const result = spawnSync(process.execPath, [compiler, "-p", config], {
    cwd: projectRoot,
    stdio: "inherit",
  })
  if (result.error)
    fail(`unable to run Cubism compiler: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`Cubism Framework compilation failed with exit code ${result.status}`)
  }
  console.log("[live2d] compiled official Framework with TypeScript 5.9.3")
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
