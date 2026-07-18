import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import test from "node:test"

import {
  assertArtifactMatches,
  checkDependencyNotices,
  classifyLicense,
  DEPENDENCY_INVENTORY_FILE,
  DEPENDENCY_NOTICE_FILE,
  parseCargoLockPackages,
  parsePnpmLockPackages,
  summarizeDependencies,
  validateCargoResolution,
  validatePnpmResolution,
} from "./dependency-notices.mjs"

const projectRoot = fileURLToPath(new URL("../..", import.meta.url))

test("pnpm lock parser retains exact integrity for scoped packages", () => {
  const packages = parsePnpmLockPackages(`lockfileVersion: '9.0'

packages:

  '@scope/example@1.2.3':
    resolution: {integrity: sha512-YWJjZA==}
    engines: {node: '>=22'}

snapshots:
`)
  assert.deepEqual(packages.get("@scope/example@1.2.3"), {
    key: "@scope/example@1.2.3",
    integrity: "sha512-YWJjZA==",
  })
})

test("Cargo lock parser retains exact registry source and checksum", () => {
  const packages = parseCargoLockPackages(`version = 4

[[package]]
name = "example"
version = "1.2.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
`)
  assert.deepEqual(packages.get("example@1.2.3"), {
    name: "example",
    version: "1.2.3",
    source: "registry+https://github.com/rust-lang/crates.io-index",
    checksum:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  })
})

test("license policy allows reviewed SPDX expressions and fails closed", () => {
  assert.deepEqual(classifyLicense("MIT OR Apache-2.0"), {
    status: "allowed",
    ids: ["MIT", "Apache-2.0"],
  })
  assert.equal(classifyLicense("Mystery-1.0").status, "unknown")
  assert.equal(classifyLicense("AGPL-3.0-only").status, "forbidden")
  assert.equal(classifyLicense("").status, "missing")

  assert.throws(
    () => summarizeDependencies([{ ecosystem: "npm", license: "Mystery-1.0" }]),
    /LICENSE_POLICY_UNKNOWN/u,
  )
  assert.throws(
    () =>
      summarizeDependencies([{ ecosystem: "cargo", license: "GPL-3.0-only" }]),
    /LICENSE_POLICY_FORBIDDEN/u,
  )
  assert.throws(
    () => summarizeDependencies([{ ecosystem: "npm", license: "" }]),
    /LICENSE_POLICY_MISSING/u,
  )
})

test("locked source and integrity metadata fail closed", () => {
  assert.throws(
    () => validatePnpmResolution({}, "https://registry.npmjs.org/a/-/a.tgz"),
    /LICENSE_PNPM_INTEGRITY_MISSING/u,
  )
  assert.throws(
    () =>
      validatePnpmResolution(
        { integrity: "sha512-YWJjZA==" },
        "https://packages.example.invalid/a.tgz",
      ),
    /LICENSE_PNPM_SOURCE_UNAPPROVED/u,
  )
  assert.throws(
    () =>
      validateCargoResolution(
        { source: "registry+https://github.com/rust-lang/crates.io-index" },
        "registry+https://github.com/rust-lang/crates.io-index",
      ),
    /LICENSE_CARGO_CHECKSUM_MISSING/u,
  )
  assert.throws(
    () =>
      validateCargoResolution(
        {
          source: "registry+https://github.com/rust-lang/crates.io-index",
          checksum:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        "git+https://example.invalid/repository",
      ),
    /LICENSE_CARGO_LOCK_MISMATCH/u,
  )
  assert.throws(
    () =>
      validateCargoResolution(
        {
          source: "git+https://example.invalid/repository",
          checksum:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        "git+https://example.invalid/repository",
      ),
    /LICENSE_CARGO_SOURCE_UNAPPROVED/u,
  )
})

test("stale generated artifacts are rejected byte-for-byte", () => {
  assert.doesNotThrow(() =>
    assertArtifactMatches("expected\n", "expected\n", "STALE"),
  )
  assert.throws(
    () => assertArtifactMatches("old\n", "expected\n", "STALE"),
    /STALE/u,
  )
})

test("committed and packaged dependency notices match the offline locks", () => {
  const summary = checkDependencyNotices()
  assert.equal(summary.total, summary.npm + summary.cargo)
  assert.equal(summary.unknown, 0)
  assert.equal(summary.forbidden, 0)
  assert.equal(summary.missing, 0)

  for (const file of [DEPENDENCY_INVENTORY_FILE, DEPENDENCY_NOTICE_FILE]) {
    assert.deepEqual(
      readFileSync(path.join(projectRoot, "third-party", file)),
      readFileSync(path.join(projectRoot, "src-tauri/resources/legal", file)),
    )
  }

  const index = readFileSync(
    path.join(projectRoot, "src-tauri/resources/legal/THIRD-PARTY-NOTICES.md"),
    "utf8",
  )
  assert.match(index, /THIRD-PARTY-DEPENDENCIES\.json/u)
  assert.match(index, /THIRD-PARTY-DEPENDENCIES\.md/u)
})
