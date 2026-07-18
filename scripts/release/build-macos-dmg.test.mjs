import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { setTimeout as wait } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import { createProductFixture } from "./macos-release-fixture.mjs"

const buildDmgScript = fileURLToPath(
  new URL("./build-macos-dmg.sh", import.meta.url),
)
const verifyScript = fileURLToPath(
  new URL("./verify-macos-release.sh", import.meta.url),
)
const buildAppScript = fileURLToPath(
  new URL("./build-macos-app.sh", import.meta.url),
)
const runReleaseScript = fileURLToPath(
  new URL("./run-macos-release.sh", import.meta.url),
)
const commonScript = fileURLToPath(
  new URL("./macos-release-common.sh", import.meta.url),
)
const isMacOS = process.platform === "darwin"
const lockPath = "/private/tmp/coding-wife-macos-release.lock"
const workPrefixes = [
  ".coding-wife-app-build.",
  ".coding-wife-dmg-work.",
  ".coding-wife-release-verify.",
  ".coding-wife-sign-work.",
]

function runScript(script, args, cwd, extraEnv = {}) {
  return spawnSync("/bin/bash", [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv, LC_ALL: "C" },
  })
}

function releaseArgs(appPath, outputPath, extra = []) {
  return [
    "--app",
    appPath,
    "--output",
    outputPath,
    "--volume-name",
    "Coding Wife Test",
    ...extra,
  ]
}

function verifyArgs(appPath, outputPath) {
  return ["--app", appPath, "--dmg", outputPath]
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function assertPrivatePathsAreRedacted(result, privateValues) {
  const output = `${result.stdout}${result.stderr}`
  for (const value of privateValues) assert.equal(output.includes(value), false)
}

async function temporaryDirectory(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(async () => {
    cleanupReleaseMounts()
    await rm(root, { force: true, recursive: true })
  })
  return root
}

function cleanupReleaseMounts() {
  const info = spawnSync("/usr/bin/hdiutil", ["info"], { encoding: "utf8" })
  if (info.status !== 0) return
  let currentDevice = ""
  for (const line of info.stdout.split("\n")) {
    const device = line.match(/^\/dev\/disk[0-9]+s[0-9]+/u)?.[0]
    if (device !== undefined) currentDevice = device
    if (!line.includes(".coding-wife-") || currentDevice === "") continue
    spawnSync(
      "/usr/bin/hdiutil",
      ["detach", "-quiet", "-force", currentDevice],
      { encoding: "utf8" },
    )
  }
}

async function releaseWorkEntries() {
  const entries = await readdir("/private/tmp")
  return entries.filter(
    (entry) =>
      entry === path.basename(lockPath) ||
      workPrefixes.some((prefix) => entry.startsWith(prefix)),
  )
}

async function assertReleaseCleanup(root) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const info = spawnSync("/usr/bin/hdiutil", ["info"], { encoding: "utf8" })
    const work = await releaseWorkEntries()
    const local = (await readdir(root).catch(() => [])).filter(
      (entry) =>
        entry.startsWith(".coding-wife-dmg-ready.") ||
        entry.startsWith(".coding-wife-dmg-backup.") ||
        entry.startsWith(".coding-wife-app-ready.") ||
        entry.startsWith(".coding-wife-app-backup."),
    )
    if (
      info.status === 0 &&
      !info.stdout.includes(".coding-wife-") &&
      work.length === 0 &&
      local.length === 0
    ) {
      return
    }
    await wait(50)
  }
  assert.deepEqual(await releaseWorkEntries(), [])
  assert.equal(
    spawnSync("/usr/bin/hdiutil", ["info"], {
      encoding: "utf8",
    }).stdout.includes(".coding-wife-"),
    false,
  )
}

async function waitForWorkHook(prefix) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const entries = await readdir("/private/tmp")
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue
      const work = path.join("/private/tmp", entry)
      try {
        if ((await lstat(path.join(work, "test-hook-ready"))).isFile()) {
          return work
        }
      } catch {
        // The release process has not reached the requested hook.
      }
    }
    await wait(25)
  }
  throw new Error("RELEASE_TEST_HOOK_TIMEOUT")
}

function spawnCaptured(script, args, cwd, extraEnv = {}) {
  const child = spawn("/bin/bash", [script, ...args], {
    cwd,
    detached: true,
    env: { ...process.env, ...extraEnv, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    stdout += chunk
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) =>
      resolve({ code, signal, stderr, stdout }),
    )
  })
  return { child, closed }
}

async function interruptAtHook({ args, cwd, env, prefix, script, signal }) {
  const { child, closed } = spawnCaptured(script, args, cwd, env)
  const work = await waitForWorkHook(prefix)
  process.kill(-child.pid, signal)
  return { ...(await closed), work }
}

async function continueAfterMutation({ args, cwd, mutate }) {
  const { child, closed } = spawnCaptured(verifyScript, args, cwd, {
    CODING_WIFE_RELEASE_TEST_WAIT: "verify-after-snapshot",
  })
  const work = await waitForWorkHook(".coding-wife-release-verify.")
  try {
    await mutate(work)
    await writeFile(path.join(work, "test-hook-continue"), "continue\n")
  } catch (error) {
    process.kill(-child.pid, "SIGTERM")
    await closed
    throw error
  }
  return closed
}

test("release shell entry points use one plist-based lock and avoid GUI or pipe probes", async () => {
  for (const script of [
    buildDmgScript,
    verifyScript,
    buildAppScript,
    runReleaseScript,
    commonScript,
  ]) {
    execFileSync("/bin/bash", ["-n", script])
  }
  const sources = await Promise.all(
    [
      buildDmgScript,
      verifyScript,
      buildAppScript,
      runReleaseScript,
      commonScript,
    ].map((script) => readFile(script, "utf8")),
  )
  const combined = sources.join("\n")
  assert.equal(combined.includes("osascript"), false)
  assert.equal(combined.includes("open -a"), false)
  assert.equal(combined.includes("df -P"), false)
  assert.equal(combined.includes("grep -Fq"), false)
  assert.match(combined, /hdiutil attach -plist/u)
  assert.match(combined, /assert-mount-absent/u)
  assert.match(combined, /coding-wife-macos-release\.lock/u)
  assert.match(sources[0], /verify_candidate_mount 1/u)
  assert.match(sources[0], /verify_candidate_mount 2/u)
  assert.match(sources[1], /snapshot-create/u)
  assert.match(sources[1], /snapshot-assert/u)
  assert.match(sources[2], /CARGO_TARGET_DIR/u)
  assert.match(sources[2], /dependency-notices\.mjs --check/u)
  assert.match(sources[2], /APP_BUILD_READY_VERIFY_FAILED/u)
  assert.match(sources[2], /manifest-create/u)
  assert.match(sources[2], /APP_BUILD_PUBLISH_FAILED/u)
})

test("DMG builder rejects invalid, incomplete, unsigned, and symlink inputs without publishing", async (t) => {
  if (!isMacOS) {
    t.skip("macOS release integration only runs on macOS")
    return
  }
  const root = await temporaryDirectory(t, "coding-wife-release-invalid-")
  await assertReleaseCleanup(root)

  const secretOutput = path.join(root, "secret.dmg")
  const invalidCases = [
    [],
    ["--unknown"],
    [
      "--app",
      path.join(root, "missing.app"),
      "--app",
      path.join(root, "missing.app"),
      "--output",
      secretOutput,
      "--volume-name",
      "Test",
    ],
  ]
  for (const args of invalidCases) {
    const result = runScript(buildDmgScript, args, root)
    assert.notEqual(result.status, 0)
    assertPrivatePathsAreRedacted(result, [root, secretOutput])
  }

  const incomplete = path.join(root, "Incomplete.app")
  await mkdir(path.join(incomplete, "Contents"), { recursive: true })
  const incompleteResult = runScript(
    buildDmgScript,
    releaseArgs(incomplete, secretOutput),
    root,
  )
  assert.notEqual(incompleteResult.status, 0)
  await assert.rejects(lstat(secretOutput))

  const fixture = await createProductFixture(root)
  execFileSync("/usr/bin/codesign", ["--remove-signature", fixture.appPath])
  const unsignedOutput = path.join(root, "unsigned.dmg")
  const unsigned = runScript(
    buildDmgScript,
    releaseArgs(fixture.appPath, unsignedOutput),
    root,
  )
  assert.notEqual(unsigned.status, 0)
  await assert.rejects(lstat(unsignedOutput))
  await assert.rejects(lstat(`${unsignedOutput}.release.json`))
  assertPrivatePathsAreRedacted(unsigned, [
    root,
    fixture.appPath,
    unsignedOutput,
  ])

  const linkedOutput = path.join(root, "linked.dmg")
  const protectedTarget = path.join(root, "protected")
  await writeFile(protectedTarget, "preserve")
  await symlink(protectedTarget, linkedOutput)
  const linked = runScript(
    buildDmgScript,
    releaseArgs(fixture.appPath, linkedOutput, ["--overwrite"]),
    root,
  )
  assert.notEqual(linked.status, 0)
  assert.equal(await readFile(protectedTarget, "utf8"), "preserve")
  assert.equal((await lstat(linkedOutput)).isSymbolicLink(), true)
  await assertReleaseCleanup(root)
})

test("DMG builder and canonical verifier publish matching run manifests after real mounts", async (t) => {
  if (!isMacOS) {
    t.skip("macOS release integration only runs on macOS")
    return
  }
  const root = await temporaryDirectory(t, "coding-wife-release-smoke-")
  await assertReleaseCleanup(root)
  const fixture = await createProductFixture(root)
  const output = path.join(root, "Coding-Wife.dmg")

  const built = runScript(
    buildDmgScript,
    releaseArgs(fixture.appPath, output),
    root,
  )
  assert.equal(built.status, 0, built.stderr)
  assert.match(
    built.stdout,
    /^\[release\] macOS DMG created and verified run=[0-9a-f-]{36}\.\n$/iu,
  )
  assertPrivatePathsAreRedacted(built, [root, fixture.appPath, output])

  const appManifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"))
  const dmgManifest = JSON.parse(
    await readFile(`${output}.release.json`, "utf8"),
  )
  assert.equal(dmgManifest.runId, appManifest.runId)
  assert.equal(dmgManifest.sha256, sha256(await readFile(output)))
  assert.equal(
    spawnSync("/usr/bin/hdiutil", ["verify", "-quiet", output]).status,
    0,
  )

  const verified = runScript(
    verifyScript,
    verifyArgs(fixture.appPath, output),
    root,
  )
  assert.equal(verified.status, 0, verified.stderr)
  assert.match(
    verified.stdout,
    /^\[release\] final DMG size=[1-9][0-9]* sha256=[a-f0-9]{64}\n\[release\] macOS app and independent read-only DMG snapshot verified run=[0-9a-f-]{36}\.\n$/iu,
  )
  assertPrivatePathsAreRedacted(verified, [root, fixture.appPath, output])

  const originalDmgManifest = await readFile(`${output}.release.json`, "utf8")
  const mismatchedManifest = {
    ...JSON.parse(originalDmgManifest),
    runId: "11111111-1111-4111-8111-111111111111",
  }
  await writeFile(
    `${output}.release.json`,
    `${JSON.stringify(mismatchedManifest)}\n`,
  )
  const mismatched = runScript(
    verifyScript,
    verifyArgs(fixture.appPath, output),
    root,
  )
  assert.notEqual(mismatched.status, 0)
  assert.equal(mismatched.stdout.includes("final DMG size="), false)
  await writeFile(`${output}.release.json`, originalDmgManifest)

  const overwritten = runScript(
    buildDmgScript,
    releaseArgs(fixture.appPath, output, ["--overwrite"]),
    root,
  )
  assert.equal(overwritten.status, 0, overwritten.stderr)
  await assertReleaseCleanup(root)
})

test("DMG publish failures leave no new artifact and preserve an older run exactly", async (t) => {
  if (!isMacOS) {
    t.skip("macOS release integration only runs on macOS")
    return
  }
  const root = await temporaryDirectory(t, "coding-wife-release-atomic-")
  await assertReleaseCleanup(root)
  const fixture = await createProductFixture(root)
  const output = path.join(root, "Coding-Wife.dmg")
  assert.equal(
    runScript(buildDmgScript, releaseArgs(fixture.appPath, output), root)
      .status,
    0,
  )
  const oldBytes = await readFile(output)
  const oldManifest = await readFile(`${output}.release.json`)

  const failedOverwrite = runScript(
    buildDmgScript,
    releaseArgs(fixture.appPath, output, ["--overwrite"]),
    root,
    { CODING_WIFE_RELEASE_TEST_FAULT: "dmg-after-verified" },
  )
  assert.notEqual(failedOverwrite.status, 0)
  assert.equal(sha256(await readFile(output)), sha256(oldBytes))
  assert.deepEqual(await readFile(`${output}.release.json`), oldManifest)

  const newOutput = path.join(root, "never-published.dmg")
  const failedNew = runScript(
    buildDmgScript,
    releaseArgs(fixture.appPath, newOutput),
    root,
    { CODING_WIFE_RELEASE_TEST_FAULT: "dmg-after-verified" },
  )
  assert.notEqual(failedNew.status, 0)
  await assert.rejects(lstat(newOutput))
  await assert.rejects(lstat(`${newOutput}.release.json`))
  await assertReleaseCleanup(root)
})

test("DMG builder repeatedly cleans failure, INT, and TERM after exact-device attach", async (t) => {
  if (!isMacOS) {
    t.skip("macOS signal integration only runs on macOS")
    return
  }
  const root = await temporaryDirectory(t, "coding-wife-release-build-signals-")
  await assertReleaseCleanup(root)
  const fixture = await createProductFixture(root)

  for (let cycle = 0; cycle < 2; cycle += 1) {
    const failedOutput = path.join(root, `failed-${String(cycle)}.dmg`)
    const failed = runScript(
      buildDmgScript,
      releaseArgs(fixture.appPath, failedOutput),
      root,
      { CODING_WIFE_RELEASE_TEST_FAULT: "dmg-after-attach" },
    )
    assert.notEqual(failed.status, 0)
    await assert.rejects(lstat(failedOutput))
    await assert.rejects(lstat(`${failedOutput}.release.json`))
    await assertReleaseCleanup(root)

    for (const [signal, expectedCode] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ]) {
      const output = path.join(root, `${signal}-${String(cycle)}.dmg`)
      const interrupted = await interruptAtHook({
        args: releaseArgs(fixture.appPath, output),
        cwd: root,
        env: { CODING_WIFE_RELEASE_TEST_WAIT: "dmg-after-attach" },
        prefix: ".coding-wife-dmg-work.",
        script: buildDmgScript,
        signal,
      })
      assert.equal(interrupted.code, expectedCode, interrupted.stderr)
      assert.equal(interrupted.signal, null)
      assertPrivatePathsAreRedacted(interrupted, [
        root,
        fixture.appPath,
        output,
      ])
      await assert.rejects(lstat(output))
      await assert.rejects(lstat(`${output}.release.json`))
      await assert.rejects(lstat(interrupted.work))
      await assertReleaseCleanup(root)
    }
  }
})

test("host-global lock returns bounded owner diagnostics and serializes hdiutil", async (t) => {
  if (!isMacOS) {
    t.skip("macOS lock integration only runs on macOS")
    return
  }
  const root = await temporaryDirectory(t, "coding-wife-release-lock-")
  await assertReleaseCleanup(root)
  const fixture = await createProductFixture(root)
  const heldOutput = path.join(root, "held.dmg")
  const holder = spawnCaptured(
    buildDmgScript,
    releaseArgs(fixture.appPath, heldOutput),
    root,
    { CODING_WIFE_RELEASE_TEST_WAIT: "dmg-after-attach" },
  )
  await waitForWorkHook(".coding-wife-dmg-work.")

  const contenderOutput = path.join(root, "contender.dmg")
  const contender = runScript(
    buildDmgScript,
    releaseArgs(fixture.appPath, contenderOutput),
    root,
    { CODING_WIFE_RELEASE_TEST_LOCK_ATTEMPTS: "3" },
  )
  assert.notEqual(contender.status, 0)
  assert.match(
    contender.stderr,
    /RELEASE_LOCK_BUSY owner_pid=[0-9]+ run=[0-9A-Fa-f-]{36}/u,
  )
  assertPrivatePathsAreRedacted(contender, [
    root,
    fixture.appPath,
    contenderOutput,
  ])
  await assert.rejects(lstat(contenderOutput))

  process.kill(-holder.child.pid, "SIGTERM")
  const stopped = await holder.closed
  assert.equal(stopped.code, 143, stopped.stderr)
  await assert.rejects(lstat(heldOutput))
  await assertReleaseCleanup(root)
})

test("canonical verifier repeatedly cleans failure, INT, and TERM after exact-device attach", async (t) => {
  if (!isMacOS) {
    t.skip("macOS verify signal integration only runs on macOS")
    return
  }
  const root = await temporaryDirectory(
    t,
    "coding-wife-release-verify-signals-",
  )
  await assertReleaseCleanup(root)
  const fixture = await createProductFixture(root)
  const output = path.join(root, "Coding-Wife.dmg")
  assert.equal(
    runScript(buildDmgScript, releaseArgs(fixture.appPath, output), root)
      .status,
    0,
  )

  for (let cycle = 0; cycle < 2; cycle += 1) {
    const failed = runScript(
      verifyScript,
      verifyArgs(fixture.appPath, output),
      root,
      { CODING_WIFE_RELEASE_TEST_FAULT: "verify-after-attach" },
    )
    assert.notEqual(failed.status, 0)
    await assertReleaseCleanup(root)

    for (const [signal, expectedCode] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ]) {
      const interrupted = await interruptAtHook({
        args: verifyArgs(fixture.appPath, output),
        cwd: root,
        env: { CODING_WIFE_RELEASE_TEST_WAIT: "verify-after-attach" },
        prefix: ".coding-wife-release-verify.",
        script: verifyScript,
        signal,
      })
      assert.equal(interrupted.code, expectedCode, interrupted.stderr)
      assert.equal(interrupted.signal, null)
      assertPrivatePathsAreRedacted(interrupted, [
        root,
        fixture.appPath,
        output,
      ])
      await assert.rejects(lstat(interrupted.work))
      await assertReleaseCleanup(root)
    }
  }
})

test("canonical verifier rejects same-byte inode swaps and in-place tampering without reporting a SHA", async (t) => {
  if (!isMacOS) {
    t.skip("macOS TOCTOU integration only runs on macOS")
    return
  }
  const root = await temporaryDirectory(t, "coding-wife-release-swap-")
  await assertReleaseCleanup(root)
  const fixture = await createProductFixture(root)
  const output = path.join(root, "Coding-Wife.dmg")
  assert.equal(
    runScript(buildDmgScript, releaseArgs(fixture.appPath, output), root)
      .status,
    0,
  )
  const validBytes = await readFile(output)

  const swapped = await continueAfterMutation({
    args: verifyArgs(fixture.appPath, output),
    cwd: root,
    mutate: async () => {
      const replacement = path.join(root, "replacement.dmg")
      await writeFile(replacement, validBytes)
      await rename(replacement, output)
    },
  })
  assert.notEqual(swapped.code, 0)
  assert.match(swapped.stderr, /RELEASE_VERIFY_DMG_CHANGED/u)
  assert.equal(swapped.stdout.includes("final DMG size="), false)
  await assertReleaseCleanup(root)

  const tampered = await continueAfterMutation({
    args: verifyArgs(fixture.appPath, output),
    cwd: root,
    mutate: async () => appendFile(output, "tamper"),
  })
  assert.notEqual(tampered.code, 0)
  assert.match(tampered.stderr, /RELEASE_VERIFY_DMG_CHANGED/u)
  assert.equal(tampered.stdout.includes("final DMG size="), false)
  await writeFile(output, validBytes)

  const recovered = runScript(
    verifyScript,
    verifyArgs(fixture.appPath, output),
    root,
  )
  assert.equal(recovered.status, 0, recovered.stderr)
  await assertReleaseCleanup(root)
})
