import assert from "node:assert/strict"
import test from "node:test"

import { verifyLive2dSupplyChain } from "./verify-live2d.mjs"
import { resolveLive2dAssetRequest } from "./vite-plugin-live2d-assets.mjs"

test("the committed Cubism and Hiyori supply chain is exact", () => {
  assert.deepEqual(verifyLive2dSupplyChain(), {
    frameworkSources: 59,
    shaders: 13,
    hiyoriRuntimeFiles: 17,
  })
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
