import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const skillsRoot = path.join(root, "src-tauri/resources/skills")
const manifestPath = path.join(skillsRoot, "manifest.json")
const expectedSkills = new Map([
  ["coding-wife-commit-work", "1.0.0"],
  ["coding-wife-explain-commit", "1.0.0"],
])

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function listFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name)
    const absolute = path.join(directory, entry.name)
    assert.equal(
      entry.isSymbolicLink(),
      false,
      `skill resource must not be a symlink: ${relative}`,
    )
    if (entry.isDirectory()) return listFiles(absolute, relative)
    assert.equal(
      entry.isFile(),
      true,
      `skill resource must be a regular file: ${relative}`,
    )
    return [relative]
  })
}

test("bundled skills have an exact versioned and hashed supply chain", () => {
  assert.equal(lstatSync(manifestPath).isFile(), true)
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))

  assert.deepEqual(Object.keys(manifest).sort(), [
    "authority",
    "schemaVersion",
    "skills",
  ])
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.authority, "app_bundle")
  assert.equal(manifest.skills.length, expectedSkills.size)

  const declaredFiles = new Set(["manifest.json"])
  for (const skill of manifest.skills) {
    assert.deepEqual(Object.keys(skill).sort(), [
      "contentDigest",
      "entrypoint",
      "files",
      "implicitInvocation",
      "name",
      "version",
    ])
    assert.equal(expectedSkills.get(skill.name), skill.version)
    assert.equal(skill.implicitInvocation, false)
    assert.match(skill.contentDigest, /^sha256:[a-f0-9]{64}$/u)
    assert.equal(skill.entrypoint, `${skill.name}/SKILL.md`)
    assert.equal(skill.files.length, 2)

    for (const file of skill.files) {
      assert.deepEqual(Object.keys(file).sort(), ["path", "sha256"])
      assert.match(
        file.path,
        new RegExp(`^${skill.name}/(?:SKILL\\.md|agents/openai\\.yaml)$`, "u"),
      )
      assert.match(file.sha256, /^[a-f0-9]{64}$/u)
      const absolute = path.resolve(skillsRoot, file.path)
      assert.equal(absolute.startsWith(`${skillsRoot}${path.sep}`), true)
      assert.equal(lstatSync(absolute).isFile(), true)
      assert.equal(sha256(absolute), file.sha256)
      declaredFiles.add(file.path)
    }

    const skillDigest = skill.contentDigest.slice("sha256:".length)
    assert.equal(sha256(path.join(skillsRoot, skill.entrypoint)), skillDigest)

    const skillDocument = readFileSync(
      path.join(skillsRoot, skill.entrypoint),
      "utf8",
    )
    const frontmatter = skillDocument.match(/^---\n([\s\S]*?)\n---\n/u)?.[1]
    assert.ok(frontmatter, `${skill.name} must have frontmatter`)
    const keys = frontmatter.match(/^[a-z][a-z0-9_-]*(?=:)/gmu) ?? []
    assert.deepEqual(keys.sort(), ["description", "name"])
    assert.match(frontmatter, new RegExp(`^name: ${skill.name}$`, "mu"))
    assert.doesNotMatch(skillDocument, /\bTODO\b/u)

    const openAiYaml = readFileSync(
      path.join(skillsRoot, skill.name, "agents/openai.yaml"),
      "utf8",
    )
    assert.match(
      openAiYaml,
      new RegExp(`default_prompt: "[^"]*\\$${skill.name}[^"]*"`, "u"),
    )
    assert.match(openAiYaml, /^\s*allow_implicit_invocation: false$/mu)
    assert.doesNotMatch(openAiYaml, /^\s*allow_implicit_invocation: true$/mu)
  }

  assert.deepEqual(listFiles(skillsRoot).sort(), [...declaredFiles].sort())

  const tauriConfig = JSON.parse(
    readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
  )
  assert.equal(
    tauriConfig.bundle.resources.includes("resources/skills/**/*"),
    true,
  )
})
