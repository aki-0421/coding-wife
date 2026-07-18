import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  copyFile,
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

const checkerPath = fileURLToPath(
  new URL("./check-diff-hygiene.mjs", import.meta.url),
)
const canonicalNoticePath = fileURLToPath(
  new URL(
    "../../src-tauri/resources/characters/builtin-hiyori/NOTICE.txt",
    import.meta.url,
  ),
)
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url))
const noticeRelativePath =
  "src-tauri/resources/characters/builtin-hiyori/NOTICE.txt"

function run(cwd, executable, args) {
  return spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  })
}

function git(cwd, args) {
  const result = run(cwd, "git", args)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function runChecker(cwd, args = []) {
  return run(cwd, process.execPath, [checkerPath, ...args])
}

async function writeRelative(root, relativePath, contents) {
  const target = path.join(root, relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents)
  return target
}

async function createFixture(
  context,
  { noticeInBase = true, remote = true } = {},
) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "coding-wife-diff-hygiene-"),
  )
  context.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  git(root, ["init", "-q", "-b", "develop"])
  git(root, ["config", "user.name", "Coding Wife Test"])
  git(root, ["config", "user.email", "coding-wife-test@example.invalid"])
  await writeRelative(root, "tracked.txt", "clean\n")

  if (noticeInBase) {
    const destination = path.join(root, noticeRelativePath)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(canonicalNoticePath, destination)
  }

  git(root, ["add", "--all"])
  git(root, ["commit", "-q", "-m", "test: create baseline"])
  if (remote) {
    git(root, ["update-ref", "refs/remotes/origin/develop", "HEAD"])
  }
  git(root, ["switch", "-q", "-c", "feature"])

  if (!noticeInBase) {
    const destination = path.join(root, noticeRelativePath)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(canonicalNoticePath, destination)
    git(root, ["add", "--", noticeRelativePath])
    git(root, ["commit", "-q", "-m", "test: add canonical notice"])
  }

  return root
}

function assertSafeFailure(result, code, forbidden = []) {
  assert.notEqual(result.status, 0)
  const output = `${result.stdout}${result.stderr}`
  assert.match(output, new RegExp(code, "u"))
  for (const value of forbidden) {
    assert.equal(output.includes(value), false)
  }
}

test("clean branch and working tree pass without exposing repository paths", async (context) => {
  const root = await createFixture(context)
  const result = runChecker(root)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /committed, staged, unstaged, untracked/u)
  assert.equal(result.stdout.includes(root), false)
})

test("working-tree mode does not require origin/develop", async (context) => {
  const root = await createFixture(context, { remote: false })

  const workingTree = runChecker(root, ["--working-tree"])
  assert.equal(workingTree.status, 0, workingTree.stderr)
  assert.match(workingTree.stdout, /staged, unstaged, untracked/u)
  assert.equal(workingTree.stdout.includes("committed"), false)

  assertSafeFailure(runChecker(root), "DIFF_BASE_UNAVAILABLE", [root])
  assert.equal(runChecker(root, ["--base", "HEAD"]).status, 0)
})

test("committed, staged, unstaged, and untracked whitespace fail independently", async (context) => {
  await context.test("committed", async (child) => {
    const root = await createFixture(child)
    const secret = "ghp_SECRET_COMMITTED_VALUE"
    await writeRelative(root, "committed-secret.txt", `${secret} \n`)
    git(root, ["add", "--all"])
    git(root, ["commit", "-q", "-m", "test: add bad committed whitespace"])
    assertSafeFailure(runChecker(root), "DIFF_HYGIENE_FAILED", [
      root,
      secret,
      "committed-secret.txt",
    ])
  })

  await context.test("staged", async (child) => {
    const root = await createFixture(child)
    const secret = "sk-STAGED_SECRET_VALUE"
    await writeRelative(root, "staged-secret.txt", `${secret} \n`)
    git(root, ["add", "--all"])
    assertSafeFailure(
      runChecker(root, ["--working-tree"]),
      "DIFF_HYGIENE_FAILED",
      [root, secret, "staged-secret.txt"],
    )
  })

  await context.test("unstaged", async (child) => {
    const root = await createFixture(child)
    const secret = "AKIAUNSTAGEDSECRET00"
    await writeRelative(root, "tracked.txt", `${secret} \n`)
    assertSafeFailure(
      runChecker(root, ["--working-tree"]),
      "DIFF_HYGIENE_FAILED",
      [root, secret, "tracked.txt"],
    )
  })

  await context.test("untracked", async (child) => {
    const root = await createFixture(child)
    const secret = "xoxb-UNTRACKED-SECRET-VALUE"
    await writeRelative(root, "untracked-secret.txt", `${secret} \n`)
    assertSafeFailure(
      runChecker(root, ["--working-tree"]),
      "DIFF_HYGIENE_FAILED",
      [root, secret, "untracked-secret.txt"],
    )
  })
})

test("a canonical notice added after the base is the only whitespace exclusion", async (context) => {
  const root = await createFixture(context, { noticeInBase: false })
  const rawGitCheck = run(root, "git", [
    "diff",
    "--check",
    "origin/develop...HEAD",
  ])
  assert.notEqual(rawGitCheck.status, 0)

  const accepted = runChecker(root)
  assert.equal(accepted.status, 0, accepted.stderr)

  const copiedNotice = await readFile(path.join(root, noticeRelativePath))
  await writeRelative(root, "copied-notice.txt", copiedNotice)
  assertSafeFailure(
    runChecker(root, ["--working-tree"]),
    "DIFF_HYGIENE_FAILED",
    [root, "copied-notice.txt"],
  )
})

test("notice modification, deletion, rename, and symlink replacement fail closed", async (context) => {
  await context.test("modified", async (child) => {
    const root = await createFixture(child)
    await writeRelative(root, noticeRelativePath, "modified notice\n")
    assertSafeFailure(
      runChecker(root, ["--working-tree"]),
      "PROTECTED_NOTICE_INVALID",
      [root, noticeRelativePath],
    )
  })

  await context.test("deleted", async (child) => {
    const root = await createFixture(child)
    await rm(path.join(root, noticeRelativePath))
    assertSafeFailure(
      runChecker(root, ["--working-tree"]),
      "PROTECTED_NOTICE_INVALID",
      [root, noticeRelativePath],
    )
  })

  await context.test("renamed", async (child) => {
    const root = await createFixture(child)
    git(root, ["mv", noticeRelativePath, "renamed-notice.txt"])
    assertSafeFailure(
      runChecker(root, ["--working-tree"]),
      "PROTECTED_NOTICE_INVALID",
      [root, noticeRelativePath, "renamed-notice.txt"],
    )
  })

  await context.test("symlink", async (child) => {
    const root = await createFixture(child)
    const target = path.join(root, "notice-target.txt")
    await copyFile(path.join(root, noticeRelativePath), target)
    await rm(path.join(root, noticeRelativePath))
    await symlink(target, path.join(root, noticeRelativePath))
    assertSafeFailure(
      runChecker(root, ["--working-tree"]),
      "PROTECTED_NOTICE_INVALID",
      [root, noticeRelativePath, target],
    )
  })
})

test("tracked additions and renamed content remain checked while clean untracked files pass", async (context) => {
  const root = await createFixture(context)
  await writeRelative(root, "clean-untracked.txt", "clean\n")
  assert.equal(runChecker(root, ["--working-tree"]).status, 0)

  await rm(path.join(root, "clean-untracked.txt"))
  git(root, ["mv", "tracked.txt", "renamed.txt"])
  await writeRelative(root, "renamed.txt", "renamed with bad whitespace \n")
  git(root, ["commit", "-q", "-am", "test: rename with bad whitespace"])
  assertSafeFailure(runChecker(root), "DIFF_HYGIENE_FAILED", [
    root,
    "renamed.txt",
  ])
})

test("CLI rejects unsafe or contradictory options without echoing them", async (context) => {
  const root = await createFixture(context)
  const secretRef = "--ghp_PRIVATE_BASE_VALUE"
  assertSafeFailure(
    runChecker(root, ["--base", secretRef]),
    "INVALID_ARGUMENTS",
    [root, secretRef],
  )
  assertSafeFailure(
    runChecker(root, ["--working-tree", "--base", "HEAD"]),
    "INVALID_ARGUMENTS",
    [root],
  )

  const help = runChecker(root, ["--help"])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--working-tree/u)
  assert.equal(help.stdout.includes(root), false)
})

test("README, testing instructions, package command, and CI use the repository checker", async () => {
  const [packageText, readme, testingInstructions, workflow] =
    await Promise.all([
      readFile(path.join(repositoryRoot, "package.json"), "utf8"),
      readFile(path.join(repositoryRoot, "README.md"), "utf8"),
      readFile(path.join(repositoryRoot, "docs", "testing.md"), "utf8"),
      readFile(
        path.join(repositoryRoot, ".github", "workflows", "diff-hygiene.yml"),
        "utf8",
      ),
    ])
  const packageJson = JSON.parse(packageText)

  assert.equal(
    packageJson.scripts["check:diff"],
    "node scripts/release/check-diff-hygiene.mjs",
  )
  assert.match(readme, /pnpm check:diff/u)
  assert.equal(readme.includes("git diff --check"), false)
  assert.match(testingInstructions, /pnpm check:diff/u)
  assert.match(workflow, /pnpm check:diff/u)
  assert.match(workflow, /actions\/checkout@v7/u)
  assert.match(workflow, /actions\/setup-node@v7/u)
})
