import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { setTimeout as wait } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const scriptPath = fileURLToPath(
  new URL("./build-macos-dmg.sh", import.meta.url),
)
const isMacOS = process.platform === "darwin"

function runScript(args, cwd, extraEnv = {}) {
  return spawnSync("/bin/bash", [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv, LC_ALL: "C" },
  })
}

async function waitForMountedWorkDirectory(outputDirectory) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const entries = await readdir(outputDirectory).catch(() => [])
    for (const entry of entries) {
      if (!entry.startsWith(".coding-wife-dmg-work.")) continue
      const hookReady = path.join(outputDirectory, entry, "test-hook-ready")
      try {
        if ((await lstat(hookReady)).isFile()) {
          return path.join(outputDirectory, entry)
        }
      } catch {
        // The image has not reached the mounted test hook yet.
      }
    }
    await wait(25)
  }
  throw new Error("release script did not reach its mounted test hook")
}

async function runInterruptedScript(args, cwd, outputDirectory, signal) {
  const child = spawn("/bin/bash", [scriptPath, ...args], {
    cwd,
    detached: true,
    env: {
      ...process.env,
      CODING_WIFE_RELEASE_TEST_WAIT: "after-attach",
      LC_ALL: "C",
    },
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
  const workDirectory = await waitForMountedWorkDirectory(outputDirectory)
  process.kill(-child.pid, signal)
  const result = await new Promise((resolve) => {
    child.once("close", (code, exitSignal) =>
      resolve({ code, signal: exitSignal, stderr, stdout, workDirectory }),
    )
  })
  return result
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

async function createSyntheticApp(root, name = "Tiny App.app") {
  const appPath = path.join(root, name)
  const executablePath = path.join(appPath, "Contents", "MacOS", "tiny-app")
  await mkdir(path.dirname(executablePath), { recursive: true })
  await writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      "<key>CFBundleExecutable</key><string>tiny-app</string>",
      "<key>CFBundleIdentifier</key><string>app.codingwife.release-test</string>",
      "<key>CFBundleName</key><string>Tiny App</string>",
      "<key>CFBundlePackageType</key><string>APPL</string>",
      "<key>CFBundleVersion</key><string>1</string>",
      "</dict></plist>",
      "",
    ].join("\n"),
  )
  await writeFile(executablePath, "#!/bin/sh\nexit 0\n")
  await chmod(executablePath, 0o755)
  return appPath
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

function assertPrivatePathsAreRedacted(result, privateValues) {
  const output = `${result.stdout}${result.stderr}`
  for (const value of privateValues) {
    assert.equal(output.includes(value), false)
  }
}

function cleanupMountedImagesUnder(root) {
  const info = spawnSync("/usr/bin/hdiutil", ["info"], { encoding: "utf8" })
  if (info.status !== 0) return
  for (const line of info.stdout.split("\n")) {
    if (!line.includes(root) || !line.startsWith("/dev/disk")) continue
    const [device] = line.trim().split(/\s+/)
    if (!/^\/dev\/disk[0-9]+s[0-9]+$/.test(device ?? "")) continue
    spawnSync("/usr/bin/hdiutil", ["detach", "-quiet", "-force", device], {
      encoding: "utf8",
    })
  }
}

test("release shell passes bash syntax validation and does not invoke GUI automation", async () => {
  execFileSync("/bin/bash", ["-n", scriptPath])
  const source = await readFile(scriptPath, "utf8")
  assert.equal(source.includes("osascript"), false)
  assert.equal(source.includes("Finder"), false)
  assert.equal(source.includes("open -a"), false)
  assert.match(source, /set -euo pipefail/)
  assert.match(source, /hdiutil attach/)
  assert.match(source, /-readonly/)
  assert.match(source, /-format UDZO/)
  assert.match(source, /hdiutil verify/)
})

test("release shell rejects incomplete and duplicate arguments without printing private paths", async (context) => {
  if (!isMacOS) {
    context.skip("macOS hdiutil smoke only runs on macOS")
    return
  }

  const root = await mkdtemp(
    path.join(os.tmpdir(), "coding-wife-release-secret-"),
  )
  try {
    const appPath = await createSyntheticApp(root)
    const outputPath = path.join(root, "private-output.dmg")
    const cases = [
      [],
      ["--unknown"],
      [
        "--app",
        appPath,
        "--app",
        appPath,
        "--output",
        outputPath,
        "--volume-name",
        "Test",
      ],
      ["--app", appPath, "--output", outputPath, "--volume-name", "bad/name"],
    ]

    for (const args of cases) {
      const result = runScript(args, root)
      assert.notEqual(result.status, 0)
      assertPrivatePathsAreRedacted(result, [root, appPath, outputPath])
    }
  } finally {
    cleanupMountedImagesUnder(root)
    await rm(root, { recursive: true, force: true })
  }
})

test("release shell creates, validates, overwrites, and cleans a real read-only DMG", async (context) => {
  if (!isMacOS) {
    context.skip("macOS hdiutil smoke only runs on macOS")
    return
  }

  const root = await mkdtemp(
    path.join(os.tmpdir(), "coding-wife-release-smoke-"),
  )
  const mountPath = path.join(root, "external-mount")
  let mounted = false

  try {
    const appPath = await createSyntheticApp(root)
    const outputDir = path.join(root, "artifacts")
    const outputPath = path.join(outputDir, "Coding-Wife-Test.dmg")

    const created = runScript(releaseArgs(appPath, outputPath), root)
    assert.equal(created.status, 0, created.stderr)
    assert.equal(created.stdout.trim(), "macOS DMG created and verified.")
    assertPrivatePathsAreRedacted(created, [root, appPath, outputPath])

    const firstBytes = await readFile(outputPath)
    const firstHash = sha256(firstBytes)
    assert.ok(firstBytes.byteLength > 0)

    const refused = runScript(releaseArgs(appPath, outputPath), root)
    assert.notEqual(refused.status, 0)
    assert.equal(sha256(await readFile(outputPath)), firstHash)
    assertPrivatePathsAreRedacted(refused, [root, appPath, outputPath])

    const overwritten = runScript(
      releaseArgs(appPath, outputPath, ["--overwrite"]),
      root,
    )
    assert.equal(overwritten.status, 0, overwritten.stderr)
    assert.ok((await readFile(outputPath)).byteLength > 0)

    await mkdir(mountPath)
    const attached = spawnSync(
      "/usr/bin/hdiutil",
      [
        "attach",
        "-quiet",
        "-readonly",
        "-nobrowse",
        "-noautoopen",
        "-mountpoint",
        mountPath,
        outputPath,
      ],
      { encoding: "utf8" },
    )
    assert.equal(attached.status, 0, attached.stderr)
    mounted = true

    assert.deepEqual((await readdir(mountPath)).sort(), [
      "Applications",
      "Tiny App.app",
    ])
    assert.equal(
      (await lstat(path.join(mountPath, "Applications"))).isSymbolicLink(),
      true,
    )
    assert.equal(
      await readlink(path.join(mountPath, "Applications")),
      "/Applications",
    )
    assert.equal(
      (
        await lstat(
          path.join(mountPath, "Tiny App.app", "Contents", "Info.plist"),
        )
      ).isFile(),
      true,
    )
    await assert.rejects(
      writeFile(path.join(mountPath, ".write-probe"), "blocked"),
    )

    const detached = spawnSync(
      "/usr/bin/hdiutil",
      ["detach", "-quiet", mountPath],
      {
        encoding: "utf8",
      },
    )
    assert.equal(detached.status, 0, detached.stderr)
    mounted = false

    const leftovers = (await readdir(outputDir)).filter(
      (entry) =>
        entry.startsWith(".coding-wife-dmg-") ||
        entry !== "Coding-Wife-Test.dmg",
    )
    assert.deepEqual(leftovers, [])
  } finally {
    if (mounted) {
      spawnSync("/usr/bin/hdiutil", ["detach", "-quiet", "-force", mountPath], {
        encoding: "utf8",
      })
    }
    await rm(root, { recursive: true, force: true })
  }
})

test("release shell rejects invalid bundles and symlink outputs without replacement", async (context) => {
  if (!isMacOS) {
    context.skip("macOS hdiutil smoke only runs on macOS")
    return
  }

  const root = await mkdtemp(
    path.join(os.tmpdir(), "coding-wife-release-failure-"),
  )
  try {
    const brokenApp = path.join(root, "Broken App.app")
    await mkdir(path.join(brokenApp, "Contents"), { recursive: true })
    const outputPath = path.join(root, "broken.dmg")

    const broken = runScript(releaseArgs(brokenApp, outputPath), root)
    assert.notEqual(broken.status, 0)
    await assert.rejects(lstat(outputPath))
    assertPrivatePathsAreRedacted(broken, [root, brokenApp, outputPath])

    const validApp = await createSyntheticApp(root, "Valid App.app")
    const protectedTarget = path.join(root, "protected-target")
    const linkedOutput = path.join(root, "linked.dmg")
    await writeFile(protectedTarget, "preserve-me")
    await symlink(protectedTarget, linkedOutput)

    const linked = runScript(
      releaseArgs(validApp, linkedOutput, ["--overwrite"]),
      root,
    )
    assert.notEqual(linked.status, 0)
    assert.equal(await readFile(protectedTarget, "utf8"), "preserve-me")
    assert.equal((await lstat(linkedOutput)).isSymbolicLink(), true)
    assertPrivatePathsAreRedacted(linked, [
      root,
      validApp,
      linkedOutput,
      protectedTarget,
    ])

    const leftovers = (await readdir(root)).filter((entry) =>
      entry.startsWith(".coding-wife-dmg-"),
    )
    assert.deepEqual(leftovers, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("release shell removes mounts and work directories after failure, INT, and TERM", async (context) => {
  if (!isMacOS) {
    context.skip("macOS hdiutil fault cleanup only runs on macOS")
    return
  }

  const root = await mkdtemp(
    path.join(os.tmpdir(), "coding-wife-release-cleanup-"),
  )
  try {
    const appPath = await createSyntheticApp(root)
    const outputDirectory = path.join(root, "artifacts")
    await mkdir(outputDirectory)

    const failedOutput = path.join(outputDirectory, "failed.dmg")
    const failed = runScript(releaseArgs(appPath, failedOutput), root, {
      CODING_WIFE_RELEASE_TEST_FAULT: "after-attach",
    })
    assert.notEqual(failed.status, 0)
    await assert.rejects(lstat(failedOutput))
    assertPrivatePathsAreRedacted(failed, [root, appPath, failedOutput])
    assert.deepEqual(
      (await readdir(outputDirectory)).filter((entry) =>
        entry.startsWith(".coding-wife-dmg-"),
      ),
      [],
    )

    for (const [signal, expectedCode] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ]) {
      const outputPath = path.join(outputDirectory, `${signal}.dmg`)
      const interrupted = await runInterruptedScript(
        releaseArgs(appPath, outputPath),
        root,
        outputDirectory,
        signal,
      )
      assert.equal(interrupted.code, expectedCode, interrupted.stderr)
      assert.equal(interrupted.signal, null)
      assert.equal(interrupted.stdout.includes(root), false)
      assert.equal(interrupted.stderr.includes(root), false)
      await assert.rejects(lstat(outputPath))
      await assert.rejects(lstat(interrupted.workDirectory))
      const imageInfo = spawnSync("/usr/bin/hdiutil", ["info"], {
        encoding: "utf8",
      })
      assert.equal(imageInfo.status, 0, imageInfo.stderr)
      assert.equal(imageInfo.stdout.includes(interrupted.workDirectory), false)
    }

    assert.deepEqual(await readdir(outputDirectory), [])
  } finally {
    cleanupMountedImagesUnder(root)
    await rm(root, { recursive: true, force: true })
  }
})
