import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  collectAppInventory,
  compareAppInventory,
  MacOSReleaseError,
  writeAppInventory,
} from "./macos-release.mjs"

const sealScript = fileURLToPath(
  new URL("./seal-macos-app.sh", import.meta.url),
)
const buildScript = fileURLToPath(
  new URL("./build-macos-app.sh", import.meta.url),
)
const verifyScript = fileURLToPath(
  new URL("./verify-macos-release.sh", import.meta.url),
)
const isMacOS = process.platform === "darwin"

async function temporaryDirectory(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "coding-wife-release-unit-"),
  )
  t.after(() => rm(root, { force: true, recursive: true }))
  return root
}

test("app inventory is sorted, mode-aware, symlink-aware, and content-addressed", async (t) => {
  const root = await temporaryDirectory(t)
  const app = path.join(root, "Inventory.app")
  await mkdir(path.join(app, "Contents", "Resources"), { recursive: true })
  await writeFile(path.join(app, "Contents", "z.txt"), "z")
  await writeFile(path.join(app, "Contents", "Resources", "a.txt"), "alpha")
  await chmod(path.join(app, "Contents", "z.txt"), 0o640)
  await symlink("Resources/a.txt", path.join(app, "Contents", "resource-link"))

  const inventory = await collectAppInventory(app)
  assert.deepEqual(
    inventory.entries.map((entry) => entry.path),
    [...inventory.entries.map((entry) => entry.path)].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    ),
  )
  assert.deepEqual(
    inventory.entries.find((entry) => entry.path === "Contents/resource-link"),
    {
      path: "Contents/resource-link",
      mode: "0755",
      type: "symlink",
      target: "Resources/a.txt",
    },
  )
  const regular = inventory.entries.find(
    (entry) => entry.path === "Contents/Resources/a.txt",
  )
  assert.equal(regular?.type, "file")
  assert.equal(regular?.size, 5)
  assert.match(regular?.sha256 ?? "", /^[a-f0-9]{64}$/)

  const expected = path.join(root, "inventory.json")
  await writeAppInventory(app, expected)
  assert.equal(
    (await compareAppInventory(app, expected)).digest,
    inventory.digest,
  )
  await writeFile(path.join(app, "Contents", "Resources", "a.txt"), "changed")
  await assert.rejects(
    compareAppInventory(app, expected),
    (error) =>
      error instanceof MacOSReleaseError &&
      error.code === "APP_INVENTORY_MISMATCH",
  )
})

test("release shell entry points pass syntax checks and keep signing non-recursive", async () => {
  for (const script of [sealScript, buildScript, verifyScript]) {
    execFileSync("/bin/bash", ["-n", script])
  }
  const sealSource = await readFile(sealScript, "utf8")
  assert.match(sealSource, /--timestamp=none/)
  assert.match(sealSource, /codesign --verify --deep --strict/)
  assert.equal(sealSource.includes("codesign --force --deep"), false)
  const verifySource = await readFile(verifyScript, "utf8")
  assert.match(verifySource, /hdiutil attach/)
  assert.match(verifySource, /-readonly/)
  assert.match(verifySource, /macos-release\.mjs.*verify-app/)
})

test("sealer signs nested Mach-O code before sealing the app ad hoc", async (t) => {
  if (!isMacOS) {
    t.skip("macOS codesign smoke only runs on macOS")
    return
  }
  const root = await temporaryDirectory(t)
  const app = path.join(root, "Signed.app")
  const executable = path.join(app, "Contents", "MacOS", "signed-test")
  await mkdir(path.dirname(executable), { recursive: true })
  await writeFile(
    path.join(app, "Contents", "Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>signed-test</string><key>CFBundleIdentifier</key><string>app.codingwife.sign-test</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n',
  )
  const compiled = spawnSync(
    "/usr/bin/clang",
    [
      "-arch",
      "arm64",
      "-mmacosx-version-min=14.0",
      "-x",
      "c",
      "-",
      "-o",
      executable,
    ],
    { encoding: "utf8", input: "int main(void) { return 0; }\n" },
  )
  assert.equal(compiled.status, 0, compiled.stderr)

  const sealed = spawnSync("/bin/bash", [sealScript, "--app", app], {
    encoding: "utf8",
  })
  assert.equal(sealed.status, 0, sealed.stderr)
  assert.equal(sealed.stdout.includes(root), false)
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app])
  const details = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", app], {
    encoding: "utf8",
  })
  assert.equal(details.status, 0)
  assert.match(`${details.stdout}${details.stderr}`, /^Signature=adhoc$/m)
  assert.match(
    `${details.stdout}${details.stderr}`,
    /^TeamIdentifier=not set$/m,
  )
})
