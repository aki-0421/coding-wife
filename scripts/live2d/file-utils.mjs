import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

export function fail(message) {
  throw new Error(`[live2d] ${message}`)
}

export function sha256(input) {
  const bytes = Buffer.isBuffer(input) ? input : readFileSync(input)
  return createHash("sha256").update(bytes).digest("hex")
}

export function assertHash(file, expected, label = file) {
  if (!existsSync(file)) {
    fail(`${label} is missing: ${file}`)
  }

  const actual = sha256(file)
  if (actual !== expected) {
    fail(`${label} SHA-256 mismatch: expected ${expected}, received ${actual}`)
  }
}

export function listFiles(root) {
  if (!existsSync(root)) {
    return []
  }

  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(absolute)
      } else if (entry.isFile()) {
        files.push(path.relative(root, absolute).split(path.sep).join("/"))
      } else {
        fail(`non-regular file found below ${root}: ${absolute}`)
      }
    }
  }

  visit(root)
  return files.sort()
}

export function assertExactFiles(root, expectedFiles, label) {
  const actual = listFiles(root)
  const expected = [...expectedFiles].sort()
  const missing = expected.filter((file) => !actual.includes(file))
  const extra = actual.filter((file) => !expected.includes(file))

  if (missing.length > 0 || extra.length > 0) {
    fail(
      `${label} file set mismatch; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`,
    )
  }
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    fail(`invalid JSON at ${file}: ${detail}`)
  }
}

export function fileSize(file) {
  return statSync(file).size
}

export function readPngDimensions(file) {
  const bytes = readFileSync(file)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
    fail(`invalid PNG signature: ${file}`)
  }

  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  }
}

export function posixJoin(...segments) {
  return path.posix.join(...segments)
}
