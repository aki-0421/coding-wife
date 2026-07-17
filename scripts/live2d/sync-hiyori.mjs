import {
  copyFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  HIYORI_ENTRYPOINT,
  HIYORI_NOTICE_SHA256,
  HIYORI_PACK_ID,
  HIYORI_RUNTIME_FILES,
  HIYORI_RUNTIME_HASHES,
} from "./constants.mjs"
import {
  assertExactFiles,
  assertHash,
  fail,
  fileSize,
  listFiles,
  readJson,
  readPngDimensions,
} from "./file-utils.mjs"

const projectRoot = fileURLToPath(new URL("../..", import.meta.url))
const destination = path.join(
  projectRoot,
  "src-tauri/resources/characters/builtin-hiyori",
)

function getArgument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function collectModelReferences(model) {
  const references = model?.FileReferences
  if (model?.Version !== 3 || typeof references !== "object") {
    fail("Hiyori model3.json must use the reviewed Version 3 schema")
  }

  const values = []
  for (const key of ["Moc", "Physics", "Pose", "DisplayInfo", "UserData"]) {
    if (typeof references[key] === "string" && references[key] !== "") {
      values.push(references[key])
    }
  }
  for (const texture of references.Textures ?? []) {
    values.push(texture)
  }
  for (const expression of references.Expressions ?? []) {
    values.push(expression.File)
  }
  for (const motions of Object.values(references.Motions ?? {})) {
    for (const motion of motions) {
      values.push(motion.File)
    }
  }

  if (values.some((value) => typeof value !== "string" || value === "")) {
    fail("Hiyori model3.json contains an invalid asset reference")
  }

  return [...new Set(values)].sort()
}

function roleFor(file) {
  if (file.endsWith(".moc3")) return "moc"
  if (file.endsWith(".png")) return "texture"
  if (file.endsWith(".motion3.json")) return "motion"
  if (file.endsWith(".physics3.json")) return "physics"
  if (file.endsWith(".pose3.json")) return "pose"
  if (file.endsWith(".cdi3.json")) return "display_info"
  if (file.endsWith(".model3.json")) return "model"
  fail(`unrecognized Hiyori runtime role: ${file}`)
}

function main() {
  const source = path.resolve(
    getArgument("--source") ??
      process.env.HIYORI_SOURCE ??
      path.join(projectRoot, "tmp/hiyori_pro"),
  )
  const runtimeSource = path.join(source, "runtime")
  const noticeSource = path.join(source, "ReadMe.txt")

  const sourceFiles = listFiles(runtimeSource)
  const sourceFilesWithoutFinderMetadata = sourceFiles.filter(
    (file) => file !== ".DS_Store",
  )
  const unexpectedMetadata = sourceFiles.filter(
    (file) => file.endsWith(".DS_Store") && file !== ".DS_Store",
  )
  if (unexpectedMetadata.length > 0) {
    fail(
      `unexpected Finder metadata in runtime: ${unexpectedMetadata.join(", ")}`,
    )
  }
  assertExactFiles(
    runtimeSource,
    sourceFiles.includes(".DS_Store")
      ? [...HIYORI_RUNTIME_FILES, ".DS_Store"]
      : HIYORI_RUNTIME_FILES,
    "Hiyori source runtime",
  )
  if (sourceFilesWithoutFinderMetadata.length !== 17) {
    fail(
      `Hiyori runtime must contain exactly 17 files, found ${sourceFiles.length}`,
    )
  }

  for (const relative of HIYORI_RUNTIME_FILES) {
    assertHash(
      path.join(runtimeSource, relative),
      HIYORI_RUNTIME_HASHES[relative],
      `Hiyori runtime ${relative}`,
    )
  }
  assertHash(noticeSource, HIYORI_NOTICE_SHA256, "Hiyori source notice")

  const model = readJson(path.join(runtimeSource, HIYORI_ENTRYPOINT))
  const expectedReferences = HIYORI_RUNTIME_FILES.filter(
    (file) => file !== HIYORI_ENTRYPOINT,
  )
  const references = collectModelReferences(model)
  if (JSON.stringify(references) !== JSON.stringify(expectedReferences)) {
    fail(
      `Hiyori model reference closure differs from the reviewed 16 assets: ${references.join(", ")}`,
    )
  }

  mkdirSync(path.dirname(destination), { recursive: true })
  const staging = `${destination}.staging-${process.pid}`
  rmSync(staging, { force: true, recursive: true })
  mkdirSync(path.join(staging, "runtime"), { recursive: true })

  try {
    const files = HIYORI_RUNTIME_FILES.map((relative) => {
      const sourceFile = path.join(runtimeSource, relative)
      const targetFile = path.join(staging, "runtime", relative)
      mkdirSync(path.dirname(targetFile), { recursive: true })
      copyFileSync(sourceFile, targetFile)

      const role = roleFor(relative)
      const descriptor = {
        assetId: `runtime/${relative}`,
        role,
        bytes: fileSize(sourceFile),
        sha256: HIYORI_RUNTIME_HASHES[relative],
      }
      if (role === "texture") {
        descriptor.dimensions = readPngDimensions(sourceFile)
      }
      return descriptor
    })

    copyFileSync(noticeSource, path.join(staging, "NOTICE.txt"))

    const motions = Object.fromEntries(
      Object.entries(model.FileReferences.Motions).map(([group, entries]) => [
        group,
        entries.map((entry, index) => ({
          cueId: `${group}[${index}]`,
          assetId: `runtime/${entry.File}`,
        })),
      ]),
    )
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
    const pack = {
      schemaVersion: 1,
      packId: HIYORI_PACK_ID,
      displayName: "桃瀬ひより - PRO",
      bundledVersion: "hiyori_pro_t11",
      entrypoint: `runtime/${HIYORI_ENTRYPOINT}`,
      immutable: true,
      provenance: {
        sourceKind: "developer-provided",
        sourceNotice: "NOTICE.txt",
        sourceRuntime: "tmp/hiyori_pro/runtime",
        illustration: "かにビーム",
        modeling: "Live2D",
        sdkSampleSubstitution: false,
        noticeSha256: HIYORI_NOTICE_SHA256,
      },
      inventory: {
        runtimeFileCount: files.length,
        totalBytes,
        textureCount: 2,
        motionCount: 10,
        expressionCount: 0,
        motionGroups: motions,
      },
      compatibility: {
        modelSchemaVersion: 3,
        mocVersion: 3,
        expectedParameters: 70,
        expectedParts: 24,
        expectedDrawables: 134,
      },
      files,
    }
    writeFileSync(
      path.join(staging, "pack.json"),
      `${JSON.stringify(pack, null, 2)}\n`,
    )

    rmSync(destination, { force: true, recursive: true })
    renameSync(staging, destination)
  } catch (error) {
    rmSync(staging, { force: true, recursive: true })
    throw error
  }

  console.log(
    `[live2d] synced ${HIYORI_PACK_ID}: 17 reviewed runtime files plus NOTICE and manifest`,
  )
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
