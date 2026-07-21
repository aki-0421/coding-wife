import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createReleaseManifest, writeAppInventory } from "./macos-release.mjs"

const projectRoot = fileURLToPath(new URL("../..", import.meta.url))
const sealScript = fileURLToPath(
  new URL("./seal-macos-app.sh", import.meta.url),
)

export async function sealProductFixture(appPath) {
  const result = spawnSync("/bin/bash", [sealScript, "--app", appPath], {
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error("PRODUCT_FIXTURE_SEAL_FAILED")
  }
}

export async function refreshProductFixtureIdentity(fixture) {
  await rm(fixture.inventoryPath, { force: true })
  await rm(fixture.manifestPath, { force: true })
  await writeAppInventory(fixture.appPath, fixture.inventoryPath)
  await createReleaseManifest({
    artifactPath: fixture.appPath,
    inventoryPath: fixture.inventoryPath,
    kind: "app",
    manifestPath: fixture.manifestPath,
    runId: fixture.runId,
  })
}

export async function createProductFixture(
  root,
  { includeRuntimeMarkers = true, runId = randomUUID() } = {},
) {
  const bundleVersion = JSON.parse(
    await readFile(
      path.join(projectRoot, "src-tauri", "tauri.conf.json"),
      "utf8",
    ),
  ).version
  if (typeof bundleVersion !== "string" || bundleVersion.length === 0) {
    throw new Error("PRODUCT_FIXTURE_VERSION_INVALID")
  }
  const appPath = path.join(root, "Coding Wife.app")
  const executablePath = path.join(appPath, "Contents", "MacOS", "coding-wife")
  const resources = path.join(appPath, "Contents", "Resources", "resources")
  const runtime = path.join(
    resources,
    "characters",
    "builtin-hiyori",
    "runtime",
  )
  await mkdir(path.dirname(executablePath), { recursive: true })
  await mkdir(runtime, { recursive: true })
  await chmod(appPath, 0o755)

  await writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      "<key>CFBundleDisplayName</key><string>Coding Wife</string>",
      "<key>CFBundleExecutable</key><string>coding-wife</string>",
      "<key>CFBundleIdentifier</key><string>app.codingwife.desktop</string>",
      "<key>CFBundleName</key><string>Coding Wife</string>",
      "<key>CFBundlePackageType</key><string>APPL</string>",
      `<key>CFBundleShortVersionString</key><string>${bundleVersion}</string>`,
      `<key>CFBundleVersion</key><string>${bundleVersion}</string>`,
      "<key>LSMinimumSystemVersion</key><string>14.0</string>",
      "</dict></plist>",
      "",
    ].join("\n"),
  )

  const markerSource = includeRuntimeMarkers
    ? [
        'static const char support[] __attribute__((used)) = "CODEX-SUPPORT-RUNTIME-USED";',
        'static const char migration[] __attribute__((used)) = "CREATE TABLE IF NOT EXISTS schema_migrations";',
        "int main(void) { return support[0] == migration[0]; }",
      ].join("\n")
    : "int main(void) { return 0; }\n"
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
      executablePath,
    ],
    { encoding: "utf8", input: markerSource },
  )
  if (compiled.status !== 0) throw new Error("PRODUCT_FIXTURE_COMPILE_FAILED")
  await chmod(executablePath, 0o755)

  const characterRoot = path.dirname(runtime)
  await writeFile(path.join(characterRoot, "NOTICE.txt"), "Fixture notice\n")
  await writeFile(path.join(characterRoot, "pack.json"), "{}\n")
  for (let index = 0; index < 17; index += 1) {
    await writeFile(
      path.join(runtime, `fixture-${String(index).padStart(2, "0")}.bin`),
      `runtime-${String(index)}\n`,
    )
  }

  await cp(
    path.join(projectRoot, "src-tauri", "resources", "legal"),
    path.join(resources, "legal"),
    { recursive: true },
  )
  await cp(
    path.join(projectRoot, "src-tauri", "resources", "skills"),
    path.join(resources, "skills"),
    { recursive: true },
  )

  await sealProductFixture(appPath)
  const fixture = {
    appPath,
    executablePath,
    inventoryPath: path.join(root, "app-inventory.json"),
    manifestPath: `${appPath}.release.json`,
    runId,
  }
  await refreshProductFixtureIdentity(fixture)
  return fixture
}
