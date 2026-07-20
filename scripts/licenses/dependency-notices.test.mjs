import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import test from "node:test"

import {
  assertArtifactMatches,
  cargoPackageIdentityKey,
  checkDependencyNotices,
  classifyLicense,
  DEPENDENCY_INVENTORY_FILE,
  DEPENDENCY_NOTICE_FILE,
  parseCargoLockPackages,
  parseCargoTreePackageIds,
  parseLicenseExpression,
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

[[package]]
name = "example"
version = "1.2.3"
source = "registry+https://example.invalid/index"
checksum = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
`)
  assert.deepEqual(
    packages.get(
      cargoPackageIdentityKey(
        "example",
        "1.2.3",
        "registry+https://github.com/rust-lang/crates.io-index",
      ),
    ),
    {
      name: "example",
      version: "1.2.3",
      source: "registry+https://github.com/rust-lang/crates.io-index",
      checksum:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
  )
  assert.equal(packages.size, 2)
})

test("Cargo tree parser uses the effective normal target graph and exact package identities", () => {
  const root = "path+file:///repo/src-tauri#coding-wife@0.1.0"
  const workspaceHelper = "path+file:///repo/helper#workspace-helper@0.2.0"
  const normalV1 =
    "registry+https://github.com/rust-lang/crates.io-index#normal@1.0.0"
  const normalV2 =
    "registry+https://github.com/rust-lang/crates.io-index#normal@2.0.0"
  const procMacro =
    "registry+https://github.com/rust-lang/crates.io-index#normal-macro@1.0.0"
  const metadata = {
    packages: [
      { id: root, name: "coding-wife", version: "0.1.0" },
      { id: workspaceHelper, name: "workspace-helper", version: "0.2.0" },
      { id: normalV1, name: "normal", version: "1.0.0" },
      { id: normalV2, name: "normal", version: "2.0.0" },
      { id: procMacro, name: "normal-macro", version: "1.0.0" },
      {
        id: "registry#index#optional-only@1.0.0",
        name: "optional-only",
        version: "1.0.0",
      },
      {
        id: "registry#index#wrong-target@1.0.0",
        name: "wrong-target",
        version: "1.0.0",
      },
      {
        id: "registry#index#build-only@1.0.0",
        name: "build-only",
        version: "1.0.0",
      },
    ],
    workspace_members: [root, workspaceHelper],
    resolve: { root },
  }
  const ids = parseCargoTreePackageIds(
    `coding-wife v0.1.0 (/repo/src-tauri)
workspace-helper v0.2.0 (/repo/helper)
normal v1.0.0
normal v2.0.0
normal v1.0.0 (*)
normal-macro v1.0.0 (proc-macro)
normal-macro v1.0.0 (proc-macro) (*)
`,
    metadata,
  )

  assert.deepEqual(ids, new Set([normalV1, normalV2, procMacro]))
  assert.equal(ids.has(root), false)
  assert.equal(ids.has(workspaceHelper), false)
  assert.equal(
    [...ids].some((id) => id.includes("optional-only")),
    false,
  )
  assert.equal(
    [...ids].some((id) => id.includes("wrong-target")),
    false,
  )
  assert.equal(
    [...ids].some((id) => id.includes("build-only")),
    false,
  )
})

test("Cargo tree parser rejects ambiguous, unknown, malformed, and rootless displays", () => {
  const root = "path+file:///repo#app@0.1.0"
  const metadata = {
    packages: [
      { id: root, name: "app", version: "0.1.0" },
      {
        id: "registry#one#duplicate@1.0.0",
        name: "duplicate",
        version: "1.0.0",
      },
      {
        id: "registry#two#duplicate@1.0.0",
        name: "duplicate",
        version: "1.0.0",
      },
    ],
    workspace_members: [root],
    resolve: { root },
  }

  assert.throws(
    () =>
      parseCargoTreePackageIds(
        "app v0.1.0 (/repo)\nduplicate v1.0.0\n",
        metadata,
      ),
    /LICENSE_CARGO_TREE_PACKAGE_AMBIGUOUS/u,
  )
  assert.throws(
    () =>
      parseCargoTreePackageIds(
        "app v0.1.0 (/repo)\nunknown v1.0.0\n",
        metadata,
      ),
    /LICENSE_CARGO_TREE_PACKAGE_UNKNOWN/u,
  )
  assert.throws(
    () => parseCargoTreePackageIds(" app v0.1.0 (/repo)\n", metadata),
    /LICENSE_CARGO_TREE_FORMAT_INVALID/u,
  )
  assert.throws(
    () => parseCargoTreePackageIds("duplicate v1.0.0\n", metadata),
    /LICENSE_CARGO_TREE_PACKAGE_AMBIGUOUS/u,
  )
  assert.throws(
    () =>
      parseCargoTreePackageIds("duplicate v2.0.0\n", {
        packages: [
          { id: root, name: "app", version: "0.1.0" },
          {
            id: "registry#duplicate@2.0.0",
            name: "duplicate",
            version: "2.0.0",
          },
        ],
        workspace_members: [root],
        resolve: { root },
      }),
    /LICENSE_CARGO_TREE_ROOT_MISSING/u,
  )
})

test("license policy parses strict SPDX expressions and reviewed legacy slash forms", () => {
  assert.deepEqual(classifyLicense("MIT OR Apache-2.0"), {
    status: "allowed",
    ids: ["MIT", "Apache-2.0"],
  })
  assert.deepEqual(parseLicenseExpression("MIT/Apache-2.0"), {
    normalized: "MIT OR Apache-2.0",
    licenseIds: ["MIT", "Apache-2.0"],
    exceptionIds: [],
  })
  assert.deepEqual(classifyLicense("(MIT OR Apache-2.0) AND Unicode-3.0"), {
    status: "allowed",
    ids: ["MIT", "Apache-2.0", "Unicode-3.0"],
  })
  assert.deepEqual(classifyLicense("Apache-2.0 WITH LLVM-exception"), {
    status: "allowed",
    ids: ["Apache-2.0", "LLVM-exception"],
  })
  assert.equal(classifyLicense("LicenseRef-Internal").status, "unknown")
  assert.equal(
    classifyLicense("DocumentRef-vendor:LicenseRef-Internal").status,
    "unknown",
  )
  assert.equal(
    classifyLicense("Apache-2.0 WITH Unknown-exception").status,
    "unknown",
  )
  assert.equal(classifyLicense("Mystery-1.0").status, "unknown")
  assert.equal(classifyLicense("AGPL-3.0-only").status, "forbidden")
  assert.equal(classifyLicense("").status, "missing")

  for (const malformed of [
    "MIT OR",
    "(MIT",
    "MIT Apache-2.0",
    "MIT OR OR Apache-2.0",
    "MIT / / Apache-2.0",
    "MIT WITH",
    "(MIT) WITH LLVM-exception",
    "MIT WITH LicenseRef-Exception",
    "MIT WITH LLVM-exception WITH OpenSSL-exception",
  ]) {
    assert.throws(
      () => classifyLicense(malformed),
      /LICENSE_EXPRESSION_INVALID/u,
      malformed,
    )
  }

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
  assert.deepEqual(summary, {
    total: 632,
    npm: 397,
    cargo: 235,
    unknown: 0,
    forbidden: 0,
    missing: 0,
  })

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
