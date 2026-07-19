import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { fail } from "./file-utils.mjs"

const projectRoot = fileURLToPath(new URL("../..", import.meta.url))
const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), "coding-wife-clean-checkout-"),
)
const checkout = path.join(temporaryRoot, "checkout")
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  })
  if (result.error) fail(`${command} could not start: ${result.error.message}`)
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed with exit code ${String(result.status)}`,
    )
  }
}

async function runConcurrently(commands, cwd) {
  const results = await Promise.all(
    commands.map(
      ({ command, args }) =>
        new Promise((resolve) => {
          const child = spawn(command, args, {
            cwd,
            env: process.env,
            stdio: "inherit",
          })
          let startError
          child.once("error", (error) => {
            startError = error
          })
          child.once("close", (status, signal) => {
            resolve({ args, command, signal, startError, status })
          })
        }),
    ),
  )

  for (const result of results) {
    if (result.startError) {
      fail(`${result.command} could not start: ${result.startError.message}`)
    }
    if (result.status !== 0) {
      fail(
        `${result.command} ${result.args.join(" ")} failed with ${
          result.signal === null
            ? `exit code ${String(result.status)}`
            : `signal ${String(result.signal)}`
        }`,
      )
    }
  }
}

try {
  run("git", ["worktree", "add", "--detach", checkout, "HEAD"], projectRoot)

  const generatedFramework = path.join(checkout, "vendor/live2d/dist")
  if (existsSync(generatedFramework)) {
    fail("detached checkout unexpectedly contains generated Framework output")
  }

  run(pnpm, ["install", "--frozen-lockfile"], checkout)
  run(pnpm, ["lint"], checkout)
  if (existsSync(generatedFramework)) {
    fail("lint must not rely on or create generated Framework output")
  }

  run(pnpm, ["test"], checkout)
  if (!existsSync(path.join(generatedFramework, "live2dcubismframework.js"))) {
    fail("pnpm test completed without preparing the Cubism Framework")
  }

  rmSync(generatedFramework, { force: true, recursive: true })
  await runConcurrently(
    [
      { command: pnpm, args: ["typecheck"] },
      { command: pnpm, args: ["lint"] },
    ],
    checkout,
  )
  if (!existsSync(path.join(generatedFramework, "live2dcubismframework.js"))) {
    fail("parallel typecheck completed without preparing the Cubism Framework")
  }
  console.log(
    "[live2d] clean checkout passed install -> lint -> test, then parallel typecheck + lint from missing output",
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  spawnSync("git", ["worktree", "remove", "--force", checkout], {
    cwd: projectRoot,
    stdio: "ignore",
  })
  rmSync(temporaryRoot, { force: true, recursive: true })
}
