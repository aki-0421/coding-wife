import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  appendFile,
  chmod,
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
import { collectAppInventory } from "./macos-release.mjs"

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
  ".coding-wife-release-run.",
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
        entry.startsWith(".coding-wife-app-backup.") ||
        entry.startsWith(".coding-wife-release-transaction."),
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
  const deadline = Date.now() + 90_000
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
  const lockPresent = await lstat(lockPath)
    .then(() => true)
    .catch(() => false)
  throw new Error(
    `RELEASE_TEST_HOOK_TIMEOUT prefix=${prefix} lock=${lockPresent ? "present" : "absent"}`,
  )
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

async function waitForCapturedHook(captured, prefix) {
  try {
    return await Promise.race([
      waitForWorkHook(prefix),
      captured.closed.then((result) => {
        throw new Error(
          `RELEASE_TEST_PROCESS_EXITED code=${String(result.code)} signal=${String(result.signal)} stderr=${result.stderr.trim()}`,
        )
      }),
    ])
  } catch (error) {
    if (
      captured.child.exitCode === null &&
      captured.child.signalCode === null
    ) {
      process.kill(-captured.child.pid, "SIGTERM")
      await captured.closed
    }
    throw error
  }
}

async function interruptAtHook({ args, cwd, env, prefix, script, signal }) {
  const captured = spawnCaptured(script, args, cwd, env)
  const work = await waitForCapturedHook(captured, prefix)
  process.kill(-captured.child.pid, signal)
  return { ...(await captured.closed), work }
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

async function createFakeTauriBuilder(root, appPath) {
  const fakeBin = path.join(root, "fake-bin")
  const fakePnpm = path.join(fakeBin, "pnpm")
  const fakeNode = path.join(fakeBin, "node")
  await mkdir(fakeBin, { recursive: true })
  await writeFile(
    fakePnpm,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [[ \"${1:-}\" != 'exec' || \"${2:-}\" != 'tauri' || \"${3:-}\" != 'build' ]]; then",
      '  exec "$FAKE_REAL_PNPM" "$@"',
      "fi",
      "if [[ \"${FAKE_TAURI_MODE:-success}\" == 'failure' ]]; then",
      "  /usr/bin/printf 'fake builder failed: %s\\n' \"${FAKE_PRIVATE_PATH:-private}\" >&2",
      "  exit 42",
      "fi",
      'destination="$CARGO_TARGET_DIR/release/bundle/macos/Coding Wife.app"',
      '/bin/mkdir -p "$(/usr/bin/dirname "$destination")"',
      '/usr/bin/ditto "$FAKE_TAURI_APP" "$destination"',
      "",
    ].join("\n"),
  )
  await writeFile(
    fakeNode,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${FAKE_LICENSE_MODE:-success}" == \'failure\' ]] && [[ "${1:-}" == scripts/licenses/dependency-notices.mjs || "${1:-}" == */scripts/licenses/dependency-notices.mjs ]]; then',
      "  /usr/bin/printf 'fake license failure: %s\\n' \"${FAKE_PRIVATE_PATH:-private}\" >&2",
      "  exit 44",
      "fi",
      'exec "$FAKE_REAL_NODE" "$@"',
      "",
    ].join("\n"),
  )
  await chmod(fakePnpm, 0o755)
  await chmod(fakeNode, 0o755)
  const realPnpm = execFileSync("/usr/bin/which", ["pnpm"], {
    encoding: "utf8",
  }).trim()
  return {
    FAKE_PRIVATE_PATH: root,
    FAKE_REAL_NODE: process.execPath,
    FAKE_REAL_PNPM: realPnpm,
    FAKE_TAURI_APP: appPath,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  }
}

function combinedReleasePaths(outputRoot) {
  const app = path.join(outputRoot, "macos", "Coding Wife.app")
  const dmg = path.join(outputRoot, "dmg", "Coding-Wife.dmg")
  return {
    app,
    appManifest: `${app}.release.json`,
    dmg,
    dmgManifest: `${dmg}.release.json`,
  }
}

async function assertPathsAbsent(paths) {
  await Promise.all(
    Object.values(paths).map((candidate) => assert.rejects(lstat(candidate))),
  )
}

async function snapshotCombinedRelease(paths) {
  return {
    appInventory: await collectAppInventory(paths.app),
    appManifest: await readFile(paths.appManifest),
    dmg: await readFile(paths.dmg),
    dmgManifest: await readFile(paths.dmgManifest),
  }
}

async function assertCombinedReleaseSnapshot(paths, expected) {
  assert.deepEqual(await collectAppInventory(paths.app), expected.appInventory)
  assert.deepEqual(await readFile(paths.appManifest), expected.appManifest)
  assert.deepEqual(await readFile(paths.dmg), expected.dmg)
  assert.deepEqual(await readFile(paths.dmgManifest), expected.dmgManifest)
}

async function assertPrivateWorkModes(work) {
  assert.equal((await lstat(work)).mode & 0o777, 0o700)
  assert.equal((await lstat(path.join(work, "tool.log"))).mode & 0o777, 0o600)
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
  assert.match(sources[2], /chmod 755 "\$candidate_app"/u)
  assert.match(sources[2], /dependency-notices\.mjs --check/u)
  assert.match(sources[2], /classify_app_verify_failure/u)
  assert.match(sources[2], /APP_BUILD_READY_VERIFY_FAILED/u)
  assert.match(sources[2], /manifest-create/u)
  assert.match(sources[2], /APP_BUILD_PUBLISH_FAILED/u)
})

test("app builder isolates controlled Tauri output and fails closed before publication", async (t) => {
  if (!isMacOS) {
    t.skip("macOS app build integration only runs on macOS")
    return
  }
  const root = await temporaryDirectory(t, "coding-wife-release-app-build-")
  await assertReleaseCleanup(root)
  const sourceRoot = path.join(root, "source")
  await mkdir(sourceRoot)
  const fixture = await createProductFixture(sourceRoot)
  await chmod(fixture.appPath, 0o700)
  const fakeEnvironment = await createFakeTauriBuilder(root, fixture.appPath)

  const output = path.join(root, "candidate", "Controlled.app")
  const built = runScript(
    buildAppScript,
    ["--output", output],
    root,
    fakeEnvironment,
  )
  assert.equal(built.status, 0, built.stderr)
  assert.match(
    built.stdout,
    /^\[release\] macOS app built and verified run=[0-9a-f-]{36}\.\n$/iu,
  )
  assertPrivatePathsAreRedacted(built, [root, fixture.appPath, output])
  assert.equal((await lstat(output)).mode & 0o777, 0o755)
  const outputManifest = JSON.parse(
    await readFile(`${output}.release.json`, "utf8"),
  )
  assert.match(outputManifest.runId, /^[0-9a-f-]{36}$/iu)

  const interruptedOutput = path.join(root, "candidate", "Interrupted.app")
  const waiting = spawnCaptured(
    buildAppScript,
    ["--output", interruptedOutput],
    root,
    {
      ...fakeEnvironment,
      CODING_WIFE_RELEASE_TEST_WAIT: "app-after-ready",
    },
  )
  const work = await waitForCapturedHook(waiting, ".coding-wife-app-build.")
  await assertPrivateWorkModes(work)
  process.kill(-waiting.child.pid, "SIGTERM")
  const interrupted = await waiting.closed
  assert.equal(interrupted.code, 143, interrupted.stderr)
  assertPrivatePathsAreRedacted(interrupted, [
    root,
    fixture.appPath,
    interruptedOutput,
  ])
  await assertPathsAbsent({
    app: interruptedOutput,
    manifest: `${interruptedOutput}.release.json`,
  })
  await assert.rejects(lstat(work))

  const failedOutput = path.join(root, "candidate", "Failed.app")
  const failed = runScript(buildAppScript, ["--output", failedOutput], root, {
    ...fakeEnvironment,
    FAKE_TAURI_MODE: "failure",
  })
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /^\[release\] APP_BUILD_FAILED\n$/u)
  assertPrivatePathsAreRedacted(failed, [root, fixture.appPath, failedOutput])
  await assertPathsAbsent({
    app: failedOutput,
    manifest: `${failedOutput}.release.json`,
  })

  const staleOutput = path.join(root, "candidate", "StaleLicense.app")
  const stale = runScript(buildAppScript, ["--output", staleOutput], root, {
    ...fakeEnvironment,
    FAKE_LICENSE_MODE: "failure",
  })
  assert.notEqual(stale.status, 0)
  assert.match(stale.stderr, /^\[release\] APP_BUILD_LICENSE_STALE\n$/u)
  assertPrivatePathsAreRedacted(stale, [root, fixture.appPath, staleOutput])
  await assertPathsAbsent({
    app: staleOutput,
    manifest: `${staleOutput}.release.json`,
  })

  const driftRoot = path.join(root, "drift-source")
  await mkdir(driftRoot)
  const driftFixture = await createProductFixture(driftRoot)
  await writeFile(
    path.join(
      driftFixture.appPath,
      "Contents",
      "Resources",
      "resources",
      "legal",
      "THIRD-PARTY-DEPENDENCIES.json",
    ),
    "{}\n",
  )
  const driftOutput = path.join(root, "candidate", "Drift.app")
  const drift = runScript(buildAppScript, ["--output", driftOutput], root, {
    ...fakeEnvironment,
    FAKE_TAURI_APP: driftFixture.appPath,
  })
  assert.notEqual(drift.status, 0)
  assert.match(
    drift.stderr,
    /^\[release\] APP_BUILD_VERIFY_FAILED cause=APP_LEGAL_RESOURCES_MISMATCH\n$/u,
  )
  assertPrivatePathsAreRedacted(drift, [
    root,
    driftFixture.appPath,
    driftOutput,
  ])
  await assertPathsAbsent({
    app: driftOutput,
    manifest: `${driftOutput}.release.json`,
  })
  await assertReleaseCleanup(path.dirname(output))
})

test("combined release keeps private work safe and publishes only a verified four-file run", async (t) => {
  if (!isMacOS) {
    t.skip("macOS combined release integration only runs on macOS")
    return
  }
  const root = await temporaryDirectory(t, "coding-wife-release-combined-")
  await assertReleaseCleanup(root)
  const sourceRoot = path.join(root, "source")
  await mkdir(sourceRoot)
  const fixture = await createProductFixture(sourceRoot)
  const fakeEnvironment = await createFakeTauriBuilder(root, fixture.appPath)

  const permissionRoot = path.join(root, "permission-output")
  const permissionPaths = combinedReleasePaths(permissionRoot)
  const waiting = spawnCaptured(
    runReleaseScript,
    ["--output-root", permissionRoot],
    root,
    {
      ...fakeEnvironment,
      CODING_WIFE_RELEASE_TEST_WAIT: "release-after-recovery",
    },
  )
  const work = await waitForCapturedHook(waiting, ".coding-wife-release-run.")
  await assertPrivateWorkModes(work)
  process.kill(-waiting.child.pid, "SIGTERM")
  const interrupted = await waiting.closed
  assert.equal(interrupted.code, 143, interrupted.stderr)
  assertPrivatePathsAreRedacted(interrupted, [root, permissionRoot])
  await assertPathsAbsent(permissionPaths)
  await assert.rejects(lstat(work))
  await assertReleaseCleanup(permissionRoot)

  const appFailureRoot = path.join(root, "app-failure-output")
  const appFailurePaths = combinedReleasePaths(appFailureRoot)
  const appFailure = runScript(
    runReleaseScript,
    ["--output-root", appFailureRoot],
    root,
    { ...fakeEnvironment, FAKE_TAURI_MODE: "failure" },
  )
  assert.notEqual(appFailure.status, 0)
  assert.match(appFailure.stderr, /^\[release\] RELEASE_APP_FAILED\n$/u)
  assertPrivatePathsAreRedacted(appFailure, [root, appFailureRoot])
  await assertPathsAbsent(appFailurePaths)
  await assertReleaseCleanup(appFailureRoot)

  const verifyFailureSource = path.join(root, "verify-failure-source")
  await mkdir(verifyFailureSource)
  const verifyFailureFixture = await createProductFixture(verifyFailureSource)
  await writeFile(
    path.join(
      verifyFailureFixture.appPath,
      "Contents",
      "Resources",
      "resources",
      "legal",
      "THIRD-PARTY-DEPENDENCIES.json",
    ),
    "{}\n",
  )
  const verifyFailureRoot = path.join(root, "verify-failure-output")
  const verifyFailurePaths = combinedReleasePaths(verifyFailureRoot)
  const verifyFailure = runScript(
    runReleaseScript,
    ["--output-root", verifyFailureRoot],
    root,
    { ...fakeEnvironment, FAKE_TAURI_APP: verifyFailureFixture.appPath },
  )
  assert.notEqual(verifyFailure.status, 0)
  assert.match(
    verifyFailure.stderr,
    /^\[release\] RELEASE_APP_FAILED inner=APP_BUILD_VERIFY_FAILED cause=APP_LEGAL_RESOURCES_MISMATCH\n$/u,
  )
  assertPrivatePathsAreRedacted(verifyFailure, [
    root,
    verifyFailureFixture.appPath,
    verifyFailureRoot,
  ])
  await assertPathsAbsent(verifyFailurePaths)
  await assertReleaseCleanup(verifyFailureRoot)

  const dmgFailureRoot = path.join(root, "dmg-failure-output")
  const dmgFailurePaths = combinedReleasePaths(dmgFailureRoot)
  const dmgFailure = runScript(
    runReleaseScript,
    ["--output-root", dmgFailureRoot],
    root,
    {
      ...fakeEnvironment,
      CODING_WIFE_RELEASE_TEST_FAULT: "dmg-after-verified",
    },
  )
  assert.notEqual(dmgFailure.status, 0)
  assert.match(dmgFailure.stderr, /^\[release\] RELEASE_DMG_FAILED\n$/u)
  assertPrivatePathsAreRedacted(dmgFailure, [root, dmgFailureRoot])
  await assertPathsAbsent(dmgFailurePaths)
  await assertReleaseCleanup(dmgFailureRoot)

  const publishFailureRoot = path.join(root, "publish-failure-output")
  const publishFailurePaths = combinedReleasePaths(publishFailureRoot)
  const publishFailure = runScript(
    runReleaseScript,
    ["--output-root", publishFailureRoot],
    root,
    {
      ...fakeEnvironment,
      CODING_WIFE_RELEASE_TEST_FAULT: "release-after-publish",
    },
  )
  assert.notEqual(publishFailure.status, 0)
  assert.match(publishFailure.stderr, /^\[release\] TEST_INJECTED_FAILURE\n$/u)
  assertPrivatePathsAreRedacted(publishFailure, [root, publishFailureRoot])
  await assertPathsAbsent(publishFailurePaths)
  await assertReleaseCleanup(publishFailureRoot)

  const outputRoot = path.join(root, "success-output")
  const paths = combinedReleasePaths(outputRoot)
  const released = runScript(
    runReleaseScript,
    ["--output-root", outputRoot],
    root,
    fakeEnvironment,
  )
  assert.equal(released.status, 0, released.stderr)
  assert.match(
    released.stdout,
    /^\[release\] macOS release completed run=[0-9a-f-]{36}\.\n$/iu,
  )
  assertPrivatePathsAreRedacted(released, [root, outputRoot])
  const appManifest = JSON.parse(await readFile(paths.appManifest, "utf8"))
  const dmgManifest = JSON.parse(await readFile(paths.dmgManifest, "utf8"))
  assert.equal(appManifest.runId, dmgManifest.runId)
  assert.match(appManifest.runId, /^[0-9a-f-]{36}$/iu)
  assert.equal(appManifest.inventoryDigest, dmgManifest.inventoryDigest)
  await assertReleaseCleanup(outputRoot)

  const ambiguousRoot = path.join(root, "ambiguous-output")
  await mkdir(ambiguousRoot, { recursive: true })
  await mkdir(
    path.join(ambiguousRoot, ".coding-wife-release-transaction.first"),
  )
  await mkdir(
    path.join(ambiguousRoot, ".coding-wife-release-transaction.second"),
  )
  const ambiguous = runScript(
    runReleaseScript,
    ["--output-root", ambiguousRoot],
    root,
    fakeEnvironment,
  )
  assert.notEqual(ambiguous.status, 0)
  assert.match(ambiguous.stderr, /^\[release\] RELEASE_RECOVERY_AMBIGUOUS\n$/u)
  assertPrivatePathsAreRedacted(ambiguous, [root, ambiguousRoot])
  await assertPathsAbsent(combinedReleasePaths(ambiguousRoot))
  await rm(ambiguousRoot, { force: true, recursive: true })
  await assertReleaseCleanup(root)
})

for (const rollbackCase of [
  { expectedCode: undefined, name: "failure", signal: undefined },
  { expectedCode: 130, name: "SIGINT", signal: "SIGINT" },
  { expectedCode: 143, name: "SIGTERM", signal: "SIGTERM" },
]) {
  test(`combined release repeatedly rolls back ${rollbackCase.name} to the exact old run`, async (t) => {
    if (!isMacOS) {
      t.skip("macOS combined rollback integration only runs on macOS")
      return
    }
    const root = await temporaryDirectory(
      t,
      `coding-wife-release-rollback-${rollbackCase.name.toLowerCase()}-`,
    )
    await assertReleaseCleanup(root)
    const sourceRoot = path.join(root, "source")
    await mkdir(sourceRoot)
    const fixture = await createProductFixture(sourceRoot)
    const fakeEnvironment = await createFakeTauriBuilder(root, fixture.appPath)
    const outputRoot = path.join(root, "output")
    const paths = combinedReleasePaths(outputRoot)
    const seed = runScript(
      runReleaseScript,
      ["--output-root", outputRoot],
      root,
      fakeEnvironment,
    )
    assert.equal(seed.status, 0, seed.stderr)
    const oldRelease = await snapshotCombinedRelease(paths)

    for (let cycle = 0; cycle < 2; cycle += 1) {
      if (rollbackCase.signal === undefined) {
        const failed = runScript(
          runReleaseScript,
          ["--output-root", outputRoot],
          root,
          {
            ...fakeEnvironment,
            CODING_WIFE_RELEASE_TEST_FAULT: "release-after-publish",
          },
        )
        assert.notEqual(failed.status, 0)
        assert.match(failed.stderr, /^\[release\] TEST_INJECTED_FAILURE\n$/u)
        assertPrivatePathsAreRedacted(failed, [root, outputRoot])
      } else {
        const interruptedRelease = await interruptAtHook({
          args: ["--output-root", outputRoot],
          cwd: root,
          env: {
            ...fakeEnvironment,
            CODING_WIFE_RELEASE_TEST_WAIT: "release-after-publish",
          },
          prefix: ".coding-wife-release-run.",
          script: runReleaseScript,
          signal: rollbackCase.signal,
        })
        assert.equal(
          interruptedRelease.code,
          rollbackCase.expectedCode,
          interruptedRelease.stderr,
        )
        assert.equal(interruptedRelease.signal, null)
        assertPrivatePathsAreRedacted(interruptedRelease, [root, outputRoot])
        await assert.rejects(lstat(interruptedRelease.work))
      }
      await assertCombinedReleaseSnapshot(paths, oldRelease)
      await assertReleaseCleanup(outputRoot)
    }
  })
}

test("combined release parent cancellation terminates attached child work without orphans", async (t) => {
  if (!isMacOS) {
    t.skip("macOS combined parent cancellation only runs on macOS")
    return
  }
  const root = await temporaryDirectory(t, "coding-wife-release-parent-stop-")
  await assertReleaseCleanup(root)
  const sourceRoot = path.join(root, "source")
  await mkdir(sourceRoot)
  const fixture = await createProductFixture(sourceRoot)
  const fakeEnvironment = await createFakeTauriBuilder(root, fixture.appPath)

  for (const [signal, expectedCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    const outputRoot = path.join(root, `${signal}-output`)
    const interrupted = await interruptAtHook({
      args: ["--output-root", outputRoot],
      cwd: root,
      env: {
        ...fakeEnvironment,
        CODING_WIFE_RELEASE_TEST_WAIT: "dmg-after-attach",
      },
      prefix: ".coding-wife-dmg-work.",
      script: runReleaseScript,
      signal,
    })
    assert.equal(interrupted.code, expectedCode, interrupted.stderr)
    assert.equal(interrupted.signal, null)
    assertPrivatePathsAreRedacted(interrupted, [root, outputRoot])
    await assert.rejects(lstat(interrupted.work))
    await assertPathsAbsent(combinedReleasePaths(outputRoot))
    await assertReleaseCleanup(outputRoot)
  }
})

test("combined release recovers a crash-stale published transaction before a new build", async (t) => {
  if (!isMacOS) {
    t.skip("macOS combined crash integration only runs on macOS")
    return
  }
  const root = await temporaryDirectory(t, "coding-wife-release-crash-")
  await assertReleaseCleanup(root)
  const sourceRoot = path.join(root, "source")
  await mkdir(sourceRoot)
  const fixture = await createProductFixture(sourceRoot)
  const fakeEnvironment = await createFakeTauriBuilder(root, fixture.appPath)
  const outputRoot = path.join(root, "output")
  const paths = combinedReleasePaths(outputRoot)
  const seed = runScript(
    runReleaseScript,
    ["--output-root", outputRoot],
    root,
    fakeEnvironment,
  )
  assert.equal(seed.status, 0, seed.stderr)
  const oldRelease = await snapshotCombinedRelease(paths)

  const crashed = await interruptAtHook({
    args: ["--output-root", outputRoot],
    cwd: root,
    env: {
      ...fakeEnvironment,
      CODING_WIFE_RELEASE_TEST_WAIT: "release-after-publish",
    },
    prefix: ".coding-wife-release-run.",
    script: runReleaseScript,
    signal: "SIGKILL",
  })
  assert.equal(crashed.code, null)
  assert.equal(crashed.signal, "SIGKILL")
  assertPrivatePathsAreRedacted(crashed, [root, outputRoot])

  const recovered = runScript(
    runReleaseScript,
    ["--output-root", outputRoot],
    root,
    {
      ...fakeEnvironment,
      CODING_WIFE_RELEASE_TEST_FAULT: "release-after-recovery",
    },
  )
  assert.notEqual(recovered.status, 0)
  assert.match(recovered.stderr, /^\[release\] TEST_INJECTED_FAILURE\n$/u)
  assertPrivatePathsAreRedacted(recovered, [root, outputRoot])
  await assertCombinedReleaseSnapshot(paths, oldRelease)
  await assert.rejects(lstat(crashed.work))
  await assertReleaseCleanup(outputRoot)
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
