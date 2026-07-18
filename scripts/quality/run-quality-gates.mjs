#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const projectRoot = fileURLToPath(new URL("../..", import.meta.url))
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

export const QUALITY_GATES = Object.freeze([
  { id: "format", command: pnpm, args: ["format:check"] },
  { id: "clean-checkout", command: pnpm, args: ["test:clean-checkout"] },
  { id: "typecheck", command: pnpm, args: ["typecheck"] },
  { id: "frontend-build", command: pnpm, args: ["build"] },
  { id: "live2d-inventory", command: pnpm, args: ["live2d:verify"] },
  {
    id: "rust-format",
    command: "cargo",
    args: ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"],
  },
  {
    id: "rust-clippy",
    command: "cargo",
    args: [
      "clippy",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
  },
  {
    id: "rust-test",
    command: "cargo",
    args: [
      "test",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--",
      "--test-threads=1",
    ],
  },
  {
    id: "agent-docs",
    command: "agent-docs",
    args: ["--no-user-config", "lint"],
  },
  { id: "tauri-build", command: pnpm, args: ["tauri", "build"] },
  { id: "repository-diff", command: pnpm, args: ["check:diff"] },
])

export function executeGateSequence(gates, execute) {
  for (const gate of gates) {
    const status = execute(gate)
    if (status !== 0) {
      throw new Error(`QUALITY_GATE_FAILED:${gate.id}`)
    }
  }
}

function gitStatus() {
  return spawnSync(
    "git",
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    {
      cwd: projectRoot,
      encoding: "buffer",
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  )
}

function assertCleanRepository() {
  const result = gitStatus()
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    !Buffer.isBuffer(result.stdout)
  ) {
    throw new Error("QUALITY_WORKTREE_UNAVAILABLE")
  }
  if (result.stdout.byteLength !== 0) {
    throw new Error("QUALITY_WORKTREE_NOT_CLEAN")
  }
}

export function runQualityGates() {
  assertCleanRepository()
  executeGateSequence(QUALITY_GATES, (gate) => {
    process.stdout.write(`[quality] ${gate.id}\n`)
    const result = spawnSync(gate.command, gate.args, {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
    })
    return result.error === undefined && result.status !== null
      ? result.status
      : 1
  })
  assertCleanRepository()
  process.stdout.write("[quality] all repository gates passed in sequence\n")
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    runQualityGates()
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "QUALITY_GATE_FAILED"
    process.stderr.write(`error: ${message}\n`)
    process.exitCode = 1
  }
}
