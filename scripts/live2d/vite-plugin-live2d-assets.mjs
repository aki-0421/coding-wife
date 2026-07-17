import { readFileSync } from "node:fs"
import path from "node:path"

import { HIYORI_RESOURCE_WEB_PATH } from "./constants.mjs"
import { fail, readJson } from "./file-utils.mjs"

const CONTENT_TYPES = Object.freeze({
  ".json": "application/json; charset=utf-8",
  ".moc3": "application/octet-stream",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
})

function contentType(file) {
  if (file.endsWith(".model3.json") || file.endsWith(".motion3.json")) {
    return CONTENT_TYPES[".json"]
  }
  if (file.endsWith(".physics3.json") || file.endsWith(".pose3.json")) {
    return CONTENT_TYPES[".json"]
  }
  if (file.endsWith(".cdi3.json") || file.endsWith("pack.json")) {
    return CONTENT_TYPES[".json"]
  }
  return CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream"
}

function createAssetMap(resourceRoot) {
  const pack = readJson(path.join(resourceRoot, "pack.json"))
  if (!Array.isArray(pack.files))
    fail("Hiyori pack.json files must be an array")
  const relativeFiles = [
    "pack.json",
    "NOTICE.txt",
    ...pack.files.map((file) => file.assetId),
  ]
  return new Map(
    relativeFiles.map((relative) => [
      relative,
      path.join(resourceRoot, relative),
    ]),
  )
}

export function resolveLive2dAssetRequest(requestPath, assetMap) {
  let decoded
  try {
    decoded = decodeURIComponent(requestPath.split("?")[0]).replace(/^\/+/, "")
  } catch {
    return null
  }

  if (
    decoded === "" ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").some((part) => part === "." || part === "..")
  ) {
    return null
  }
  return assetMap.get(decoded) ?? null
}

export function live2dAssetsPlugin(projectRoot) {
  const resourceRoot = path.join(
    projectRoot,
    "src-tauri/resources/characters/builtin-hiyori",
  )
  const assetMap = createAssetMap(resourceRoot)
  const route = `/${HIYORI_RESOURCE_WEB_PATH}`

  return {
    name: "coding-wife-live2d-assets",
    configureServer(server) {
      server.middlewares.use(route, (request, response, next) => {
        const file = resolveLive2dAssetRequest(request.url ?? "", assetMap)
        if (file === null) {
          next()
          return
        }

        response.statusCode = 200
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("Content-Type", contentType(file))
        response.setHeader("X-Content-Type-Options", "nosniff")
        response.end(readFileSync(file))
      })
    },
    generateBundle() {
      for (const [relative, absolute] of assetMap) {
        this.emitFile({
          type: "asset",
          fileName: `${HIYORI_RESOURCE_WEB_PATH}/${relative}`,
          source: readFileSync(absolute),
        })
      }
    },
  }
}
