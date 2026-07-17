import assert from "node:assert/strict"
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  getReleaseNoticeRoot,
  verifyReleaseNotices,
} from "./release-notices.mjs"
import { verifyLive2dSupplyChain } from "./verify-live2d.mjs"
import {
  live2dAssetsPlugin,
  resolveLive2dAssetRequest,
} from "./vite-plugin-live2d-assets.mjs"

const projectRoot = fileURLToPath(new URL("../..", import.meta.url))

test("the committed Cubism and Hiyori supply chain is exact", () => {
  assert.deepEqual(verifyLive2dSupplyChain(), {
    frameworkSources: 59,
    shaders: 13,
    hiyoriRuntimeFiles: 17,
    releaseNoticeFiles: 8,
  })
})

test("the release notice verifier rejects missing files and byte drift", () => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "coding-wife-live2d-notices-"),
  )
  const legalRoot = path.join(temporaryRoot, "legal")

  try {
    cpSync(getReleaseNoticeRoot(projectRoot), legalRoot, { recursive: true })
    unlinkSync(path.join(legalRoot, "live2d/cubism-sdk-5-r.5/UPSTREAM.json"))
    assert.throws(
      () => verifyReleaseNotices(projectRoot, legalRoot),
      /file set mismatch/,
    )

    rmSync(legalRoot, { force: true, recursive: true })
    cpSync(getReleaseNoticeRoot(projectRoot), legalRoot, { recursive: true })
    writeFileSync(
      path.join(legalRoot, "live2d/cubism-sdk-5-r.5/Core/LICENSE.md"),
      "drift\n",
    )
    assert.throws(
      () => verifyReleaseNotices(projectRoot, legalRoot),
      /differs from canonical source/,
    )
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true })
  }
})

test("the production build emits the complete verified release notice set", () => {
  const emitted = []
  const plugin = live2dAssetsPlugin(projectRoot)
  plugin.generateBundle.call({
    emitFile(asset) {
      emitted.push(asset)
    },
  })

  const releaseAssets = emitted.filter((asset) =>
    asset.fileName.startsWith("legal/"),
  )
  assert.equal(releaseAssets.length, 7)
  for (const asset of releaseAssets) {
    assert.deepEqual(
      asset.source,
      readFileSync(
        path.join(
          getReleaseNoticeRoot(projectRoot),
          asset.fileName.replace(/^legal\//, ""),
        ),
      ),
    )
  }

  const hiyoriNotice = emitted.find(
    (asset) => asset.fileName === "characters/builtin-hiyori/NOTICE.txt",
  )
  assert.deepEqual(
    hiyoriNotice?.source,
    readFileSync(
      path.join(
        projectRoot,
        "src-tauri/resources/characters/builtin-hiyori/NOTICE.txt",
      ),
    ),
  )
})

test("the development asset route only resolves manifest allowlisted IDs", () => {
  const assets = new Map([
    ["pack.json", "/safe/pack.json"],
    ["runtime/motion/idle.motion3.json", "/safe/idle.motion3.json"],
  ])

  assert.equal(
    resolveLive2dAssetRequest("/pack.json", assets),
    "/safe/pack.json",
  )
  assert.equal(
    resolveLive2dAssetRequest(
      "/runtime/motion/idle.motion3.json?cache=1",
      assets,
    ),
    "/safe/idle.motion3.json",
  )
  assert.equal(resolveLive2dAssetRequest("/runtime/../pack.json", assets), null)
  assert.equal(resolveLive2dAssetRequest("/%2e%2e/pack.json", assets), null)
  assert.equal(resolveLive2dAssetRequest("/%252e%252e/pack.json", assets), null)
  assert.equal(resolveLive2dAssetRequest("/runtime\\pack.json", assets), null)
  assert.equal(resolveLive2dAssetRequest("/not-in-manifest.png", assets), null)
})
