import assert from "node:assert/strict"
import test from "node:test"

import {
  parseCargoPackageVersion,
  validateReleaseVersions,
} from "./validate-release-tag.mjs"

test("reads the version from the Cargo package section only", () => {
  assert.equal(
    parseCargoPackageVersion(`
[package]
name = "coding-wife"
version = "1.2.3"

[dependencies]
version = "9.9.9"
`),
    "1.2.3",
  )
})

test("accepts an exact v-prefixed version shared by every manifest", () => {
  assert.equal(
    validateReleaseVersions({
      tag: "v1.2.3-beta.1",
      packageVersion: "1.2.3-beta.1",
      tauriVersion: "1.2.3-beta.1",
      cargoVersion: "1.2.3-beta.1",
    }),
    "1.2.3-beta.1",
  )
})

test("rejects manifest version drift", () => {
  assert.throws(
    () =>
      validateReleaseVersions({
        tag: "v1.2.3",
        packageVersion: "1.2.3",
        tauriVersion: "1.2.4",
        cargoVersion: "1.2.3",
      }),
    /RELEASE_TAG_VERSION_MISMATCH/,
  )
})

test("rejects a tag that does not exactly match the manifest version", () => {
  assert.throws(
    () =>
      validateReleaseVersions({
        tag: "release-1.2.3",
        packageVersion: "1.2.3",
        tauriVersion: "1.2.3",
        cargoVersion: "1.2.3",
      }),
    /RELEASE_TAG_REF_MISMATCH/,
  )
})

test("rejects malformed versions and Cargo package metadata", () => {
  assert.throws(
    () =>
      validateReleaseVersions({
        tag: "v01.2.3",
        packageVersion: "01.2.3",
        tauriVersion: "01.2.3",
        cargoVersion: "01.2.3",
      }),
    /RELEASE_TAG_VERSION_INVALID/,
  )
  assert.throws(
    () => parseCargoPackageVersion('[package]\nname = "coding-wife"\n'),
    /RELEASE_TAG_CARGO_VERSION_INVALID/,
  )
})
