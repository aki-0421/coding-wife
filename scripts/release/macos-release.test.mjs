import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  assertArtifactSnapshot,
  collectAppInventory,
  compareAppInventory,
  createArtifactSnapshot,
  MacOSReleaseError,
  verifyReleaseApp,
  writeAppInventory,
} from "./macos-release.mjs"
import {
  createProductFixture,
  sealProductFixture,
} from "./macos-release-fixture.mjs"
import { containsPrivateAbsolutePath } from "./private-path-hygiene.mjs"

const sealScript = fileURLToPath(
  new URL("./seal-macos-app.sh", import.meta.url),
)
const buildScript = fileURLToPath(
  new URL("./build-macos-app.sh", import.meta.url),
)
const verifyScript = fileURLToPath(
  new URL("./verify-macos-release.sh", import.meta.url),
)
const releaseHelper = fileURLToPath(
  new URL("./macos-release.mjs", import.meta.url),
)
const isMacOS = process.platform === "darwin"

function expectReleaseCode(code) {
  return (error) => error instanceof MacOSReleaseError && error.code === code
}

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
  assert.equal(inventory.rootMode, "0755")
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

test("inventory rejects absolute, escaping, broken, and private symlinks and entries", async (t) => {
  const root = await temporaryDirectory(t)

  async function appWithContents(name) {
    const app = path.join(root, name)
    await mkdir(path.join(app, "Contents"), { recursive: true })
    return app
  }

  const absolute = await appWithContents("Absolute.app")
  await symlink("/Applications", path.join(absolute, "Contents", "link"))
  await assert.rejects(
    collectAppInventory(absolute),
    expectReleaseCode("APP_SYMLINK_ABSOLUTE"),
  )

  const escaping = await appWithContents("Escape.app")
  await writeFile(path.join(root, "outside.txt"), "outside")
  await symlink("../../outside.txt", path.join(escaping, "Contents", "link"))
  await assert.rejects(
    collectAppInventory(escaping),
    expectReleaseCode("APP_SYMLINK_ESCAPE"),
  )

  const broken = await appWithContents("Broken.app")
  await symlink("missing.txt", path.join(broken, "Contents", "link"))
  await assert.rejects(
    collectAppInventory(broken),
    expectReleaseCode("APP_SYMLINK_BROKEN"),
  )

  const privateEntry = await appWithContents("Private.app")
  const windowsPath = ["Z:", "Users", "alice", "secret.txt"].join("\\")
  await writeFile(path.join(privateEntry, "Contents", windowsPath), "safe")
  await assert.rejects(
    collectAppInventory(privateEntry),
    expectReleaseCode("APP_PRIVATE_PATH_ENTRY"),
  )
})

test("shared private-path hygiene covers POSIX, arbitrary drives, and UNC without rejecting placeholders", () => {
  const values = [
    ["", "Users", "alice", "project"].join("/"),
    ["", "Users", "alice"].join("/"),
    ["", "home", "builder", "project"].join("/"),
    ["", "private", "var", "folders", "build"].join("/"),
    ["", "private", "var", "folders"].join("/"),
    ["q:", "Users", "alice", "project"].join("\\"),
    ["q:", "Users", "alice"].join("\\"),
    ["", "", "server", "share", "project"].join("\\"),
    ["", "", "server", "share"].join("\\"),
  ]
  for (const value of values)
    assert.equal(containsPrivateAbsolutePath(value), true)
  assert.equal(
    containsPrivateAbsolutePath(["", "Users", "<USER>", "project"].join("/")),
    false,
  )
  assert.equal(
    containsPrivateAbsolutePath(
      `https://example.invalid${["", "Users", "alice", "project"].join("/")}`,
    ),
    false,
  )
})

test("artifact snapshots bind inode, size, and hash and reject mutation or path swap", async (t) => {
  const root = await temporaryDirectory(t)
  const source = path.join(root, "artifact.dmg")
  const snapshot = path.join(root, "snapshot.dmg")
  const metadata = path.join(root, "snapshot.json")
  await writeFile(source, "verified-bytes")
  await createArtifactSnapshot(source, snapshot, metadata)
  assert.deepEqual(await assertArtifactSnapshot(source, snapshot, metadata), {
    size: 14,
    sha256: "35b1135247e25b36525c4f5bb88038cf310f05ab54aa450e406e9ef5c5fde911",
  })

  await writeFile(source, "tampered-bytes")
  await assert.rejects(
    assertArtifactSnapshot(source, snapshot, metadata),
    expectReleaseCode("DMG_SNAPSHOT_SOURCE_CHANGED"),
  )

  const replacement = path.join(root, "replacement.dmg")
  await writeFile(replacement, "verified-bytes")
  await rename(replacement, source)
  await assert.rejects(
    assertArtifactSnapshot(source, snapshot, metadata),
    expectReleaseCode("DMG_SNAPSHOT_SOURCE_CHANGED"),
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

test("real release verifier accepts a minimal arm64 macOS product and its CLI", async (t) => {
  if (!isMacOS) {
    t.skip("macOS product verification only runs on macOS")
    return
  }
  const root = await temporaryDirectory(t)
  const fixture = await createProductFixture(root)
  const inventory = await verifyReleaseApp(
    fixture.appPath,
    fixture.inventoryPath,
  )
  assert.equal(inventory.rootMode, "0755")
  assert.match(inventory.digest, /^[a-f0-9]{64}$/u)

  const cli = spawnSync(
    process.execPath,
    [
      releaseHelper,
      "verify-app",
      "--app",
      fixture.appPath,
      "--expected",
      fixture.inventoryPath,
    ],
    { encoding: "utf8" },
  )
  assert.equal(cli.status, 0, cli.stderr)
  assert.match(
    cli.stdout,
    /^\[release\] app verified: adhoc=yes developer_id=no notarized=no inventory=[a-f0-9]{64}\n$/u,
  )
  assert.equal(`${cli.stdout}${cli.stderr}`.includes(root), false)
})

test("real release verifier fails closed for product, content, seal, and quarantine drift", async (t) => {
  if (!isMacOS) {
    t.skip("macOS product rejection matrix only runs on macOS")
    return
  }
  const root = await temporaryDirectory(t)
  let sequence = 0

  async function fixture(options) {
    sequence += 1
    const fixtureRoot = path.join(root, `case-${String(sequence)}`)
    await mkdir(fixtureRoot)
    return createProductFixture(fixtureRoot, options)
  }

  await t.test("root mode", async () => {
    const item = await fixture()
    await chmod(item.appPath, 0o700)
    await assert.rejects(
      verifyReleaseApp(item.appPath),
      expectReleaseCode("APP_ROOT_MODE_INVALID"),
    )
  })

  await t.test("bundle metadata", async () => {
    const item = await fixture()
    const info = path.join(item.appPath, "Contents", "Info.plist")
    await writeFile(
      info,
      (await readFile(info, "utf8")).replace(
        "app.codingwife.desktop",
        "app.codingwife.invalid",
      ),
    )
    await sealProductFixture(item.appPath)
    await assert.rejects(
      verifyReleaseApp(item.appPath),
      expectReleaseCode("APP_BUNDLE_METADATA_INVALID"),
    )
  })

  await t.test("architecture", async () => {
    const item = await fixture()
    const source = [
      'static const char support[] __attribute__((used)) = "CODEX-SUPPORT-RUNTIME-USED";',
      'static const char migration[] __attribute__((used)) = "CREATE TABLE IF NOT EXISTS schema_migrations";',
      "int main(void) { return support[0] == migration[0]; }",
    ].join("\n")
    const compiled = spawnSync(
      "/usr/bin/clang",
      [
        "-arch",
        "x86_64",
        "-mmacosx-version-min=14.0",
        "-x",
        "c",
        "-",
        "-o",
        item.executablePath,
      ],
      { encoding: "utf8", input: source },
    )
    assert.equal(compiled.status, 0, compiled.stderr)
    await sealProductFixture(item.appPath)
    await assert.rejects(
      verifyReleaseApp(item.appPath),
      expectReleaseCode("APP_ARCHITECTURE_INVALID"),
    )
  })

  await t.test("minimum system version", async () => {
    const item = await fixture()
    const rewritten = `${item.executablePath}.rewritten`
    const changed = spawnSync(
      "/usr/bin/vtool",
      [
        "-set-build-version",
        "macos",
        "13.0",
        "13.0",
        "-replace",
        "-output",
        rewritten,
        item.executablePath,
      ],
      { encoding: "utf8" },
    )
    assert.equal(changed.status, 0, changed.stderr)
    await rename(rewritten, item.executablePath)
    await chmod(item.executablePath, 0o755)
    await sealProductFixture(item.appPath)
    await assert.rejects(
      verifyReleaseApp(item.appPath),
      expectReleaseCode("APP_MINIMUM_SYSTEM_VERSION_INVALID"),
    )
  })

  await t.test("Mach-O build platform", async () => {
    const item = await fixture()
    const rewritten = `${item.executablePath}.rewritten`
    const changed = spawnSync(
      "/usr/bin/vtool",
      [
        "-set-build-version",
        "ios",
        "14.0",
        "14.0",
        "-replace",
        "-output",
        rewritten,
        item.executablePath,
      ],
      { encoding: "utf8" },
    )
    assert.equal(changed.status, 0, changed.stderr)
    await rename(rewritten, item.executablePath)
    await chmod(item.executablePath, 0o755)
    await sealProductFixture(item.appPath)
    await assert.rejects(
      verifyReleaseApp(item.appPath),
      expectReleaseCode("APP_BUILD_PLATFORM_INVALID"),
    )
  })

  await t.test("required resource", async () => {
    const item = await fixture()
    await unlink(
      path.join(
        item.appPath,
        "Contents",
        "Resources",
        "resources",
        "skills",
        "manifest.json",
      ),
    )
    await sealProductFixture(item.appPath)
    await assert.rejects(
      verifyReleaseApp(item.appPath),
      expectReleaseCode("APP_RESOURCE_MISSING"),
    )
  })

  await t.test("runtime marker", async () => {
    const item = await fixture({ includeRuntimeMarkers: false })
    await assert.rejects(
      verifyReleaseApp(item.appPath),
      expectReleaseCode("APP_SUPPORT_RUNTIME_MISSING"),
    )
  })

  await t.test("legal byte drift", async () => {
    const item = await fixture()
    await writeFile(
      path.join(
        item.appPath,
        "Contents",
        "Resources",
        "resources",
        "legal",
        "THIRD-PARTY-DEPENDENCIES.json",
      ),
      "{}\n",
    )
    await sealProductFixture(item.appPath)
    await assert.rejects(
      verifyReleaseApp(item.appPath),
      expectReleaseCode("APP_LEGAL_RESOURCES_MISMATCH"),
    )
  })

  await t.test("private path bytes", async () => {
    const item = await fixture()
    await writeFile(
      path.join(item.appPath, "Contents", "Resources", "private.txt"),
      ["", "home", "builder", "checkout"].join("/"),
    )
    await sealProductFixture(item.appPath)
    await assert.rejects(
      verifyReleaseApp(item.appPath),
      expectReleaseCode("APP_PRIVATE_PATH_CONTENT"),
    )
  })

  await t.test("credential bytes", async () => {
    const item = await fixture()
    await writeFile(
      path.join(item.appPath, "Contents", "Resources", "public.txt"),
      `sk-${"a".repeat(24)}`,
    )
    await sealProductFixture(item.appPath)
    await assert.rejects(
      verifyReleaseApp(item.appPath),
      expectReleaseCode("APP_CREDENTIAL_CONTENT"),
    )
  })

  await t.test("source map", async () => {
    const item = await fixture()
    await writeFile(
      path.join(item.appPath, "Contents", "Resources", "bundle.js.map"),
      "{}\n",
    )
    await sealProductFixture(item.appPath)
    await assert.rejects(
      verifyReleaseApp(item.appPath),
      expectReleaseCode("APP_FORBIDDEN_PATH"),
    )
  })

  await t.test("quarantine", async () => {
    const item = await fixture()
    const tagged = spawnSync(
      "/usr/bin/xattr",
      ["-w", "com.apple.quarantine", "0081;fixture", item.appPath],
      { encoding: "utf8" },
    )
    assert.equal(tagged.status, 0, tagged.stderr)
    await assert.rejects(
      verifyReleaseApp(item.appPath),
      expectReleaseCode("APP_QUARANTINE_PRESENT"),
    )
  })

  await t.test("post-seal tamper", async () => {
    const item = await fixture()
    await writeFile(
      path.join(item.appPath, "Contents", "Resources", "tamper.txt"),
      "tamper\n",
    )
    await assert.rejects(
      verifyReleaseApp(item.appPath),
      expectReleaseCode("APP_RELEASE_TOOL_FAILED"),
    )
  })
})
