import assert from "node:assert/strict"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { publishStagedFramework, withBuildLock } from "./build-framework.mjs"

function temporaryDirectory() {
  return mkdtempSync(path.join(tmpdir(), "coding-wife-framework-build-"))
}

test("the Framework build lock serializes parallel preparation", async () => {
  const root = temporaryDirectory()
  const lock = path.join(root, "framework.lock")
  let active = 0
  let maximumActive = 0
  const operation = () =>
    withBuildLock(
      lock,
      async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 30))
        active -= 1
      },
      { retryIntervalMs: 5, timeoutMs: 1_000 },
    )

  try {
    await Promise.all([operation(), operation(), operation()])
    assert.equal(maximumActive, 1)
    assert.equal(existsSync(lock), false)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test("an abandoned lock is recovered", async () => {
  const root = temporaryDirectory()
  const lock = path.join(root, "framework.lock")
  mkdirSync(root, { recursive: true })
  writeFileSync(
    lock,
    JSON.stringify({
      pid: 2_147_483_647,
      token: "abandoned",
      startedAt: "2000-01-01T00:00:00.000Z",
    }),
  )
  const stale = new Date("2000-01-01T00:00:00.000Z")
  utimesSync(lock, stale, stale)

  try {
    const result = await withBuildLock(lock, () => "recovered", {
      retryIntervalMs: 5,
      staleAfterMs: 1,
      timeoutMs: 1_000,
    })
    assert.equal(result, "recovered")
    assert.equal(existsSync(lock), false)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test("an old lock is not reclaimed while its owner is alive", async () => {
  const root = temporaryDirectory()
  const lock = path.join(root, "framework.lock")
  writeFileSync(
    lock,
    JSON.stringify({
      pid: process.pid,
      token: "live-owner",
      startedAt: "2000-01-01T00:00:00.000Z",
    }),
  )
  const stale = new Date("2000-01-01T00:00:00.000Z")
  utimesSync(lock, stale, stale)

  try {
    await assert.rejects(
      withBuildLock(lock, () => "must-not-run", {
        retryIntervalMs: 5,
        staleAfterMs: 1,
        timeoutMs: 20,
      }),
      /timed out waiting for Framework build lock/,
    )
    assert.equal(existsSync(lock), true)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test("staged output publishes atomically and identical output is reused", () => {
  const root = temporaryDirectory()
  const output = path.join(root, "dist")
  const firstStage = path.join(root, "stage-first")
  const secondStage = path.join(root, "stage-second")
  const backup = path.join(root, "backup")
  mkdirSync(output)
  mkdirSync(firstStage)
  writeFileSync(path.join(output, "framework.js"), "old")
  writeFileSync(path.join(firstStage, "framework.js"), "new")

  try {
    assert.equal(
      publishStagedFramework(firstStage, output, backup),
      "published",
    )
    assert.equal(readFileSync(path.join(output, "framework.js"), "utf8"), "new")
    assert.equal(existsSync(backup), false)

    mkdirSync(secondStage)
    writeFileSync(path.join(secondStage, "framework.js"), "new")
    assert.equal(publishStagedFramework(secondStage, output, backup), "current")
    assert.equal(existsSync(secondStage), false)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})
