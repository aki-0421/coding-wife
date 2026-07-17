export const SDK_VERSION = "5-r.5"
export const SDK_ROOT = `CubismSdkForWeb-${SDK_VERSION}`
export const SDK_URL =
  "https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.5.zip"
export const SDK_ARCHIVE_SHA256 =
  "67064a7fb1812cf502f5c4a03bfe12cc638c75a621bb4acf06bb28763df06ba0"
export const FRAMEWORK_TAG = "5-r.5"
export const FRAMEWORK_TAG_COMMIT = "198a3769c26ca3d7b600e932590433badd392edd"
export const CORE_VERSION = 100663297
export const CORE_SHA256 =
  "8741f739779b5d5210872bd3d7d99f0f1e56e6c87409e7d26d6bb4b80aa1ef47"
export const CORE_DECLARATION_SHA256 =
  "25fcaa2a6dfe311db95ad1795a2a7e6286d9192719df4e2c3e634915dc050334"

export const FRAMEWORK_SOURCE_FILES = Object.freeze([
  "cubismdefaultparameterid.ts",
  "cubismframeworkconfig.ts",
  "cubismmodelsettingjson.ts",
  "effect/cubismbreath.ts",
  "effect/cubismeyeblink.ts",
  "effect/cubismlook.ts",
  "effect/cubismpose.ts",
  "icubismallcator.ts",
  "icubismmodelsetting.ts",
  "id/cubismid.ts",
  "id/cubismidmanager.ts",
  "live2dcubismframework.ts",
  "math/cubismmath.ts",
  "math/cubismmatrix44.ts",
  "math/cubismmodelmatrix.ts",
  "math/cubismtargetpoint.ts",
  "math/cubismvector2.ts",
  "math/cubismviewmatrix.ts",
  "model/cubismmoc.ts",
  "model/cubismmodel.ts",
  "model/cubismmodelmultiplyandscreencolor.ts",
  "model/cubismmodeluserdata.ts",
  "model/cubismmodeluserdatajson.ts",
  "model/cubismusermodel.ts",
  "motion/acubismmotion.ts",
  "motion/cubismbreathupdater.ts",
  "motion/cubismexpressionmotion.ts",
  "motion/cubismexpressionmotionmanager.ts",
  "motion/cubismexpressionupdater.ts",
  "motion/cubismeyeblinkupdater.ts",
  "motion/cubismlipsyncupdater.ts",
  "motion/cubismlookupdater.ts",
  "motion/cubismmotion.ts",
  "motion/cubismmotioninternal.ts",
  "motion/cubismmotionjson.ts",
  "motion/cubismmotionmanager.ts",
  "motion/cubismmotionqueueentry.ts",
  "motion/cubismmotionqueuemanager.ts",
  "motion/cubismphysicsupdater.ts",
  "motion/cubismposeupdater.ts",
  "motion/cubismupdatescheduler.ts",
  "motion/icubismupdater.ts",
  "motion/iparameterprovider.ts",
  "physics/cubismphysics.ts",
  "physics/cubismphysicsinternal.ts",
  "physics/cubismphysicsjson.ts",
  "rendering/cubismclippingmanager.ts",
  "rendering/cubismoffscreenmanager.ts",
  "rendering/cubismoffscreenrendertarget_webgl.ts",
  "rendering/cubismrenderer.ts",
  "rendering/cubismrenderer_webgl.ts",
  "rendering/cubismrendertarget_webgl.ts",
  "rendering/cubismshader_webgl.ts",
  "type/csmrectf.ts",
  "utils/cubismarrayutils.ts",
  "utils/cubismdebug.ts",
  "utils/cubismjson.ts",
  "utils/cubismjsonextension.ts",
  "utils/cubismstring.ts",
])

export const SHADER_FILES = Object.freeze([
  "fragshadersrcalphablend.frag",
  "fragshadersrccolorblend.frag",
  "fragshadersrccopy.frag",
  "fragshadersrcmaskinvertedpremultipliedalpha.frag",
  "fragshadersrcmaskpremultipliedalpha.frag",
  "fragshadersrcpremultipliedalpha.frag",
  "fragshadersrcpremultipliedalphablend.frag",
  "fragshadersrcsetupmask.frag",
  "vertshadersrc.vert",
  "vertshadersrcblend.vert",
  "vertshadersrccopy.vert",
  "vertshadersrcmasked.vert",
  "vertshadersrcsetupmask.vert",
])

export const SDK_VENDOR_FILES = Object.freeze([
  "LICENSE.md",
  "Core/LICENSE.md",
  "Core/RedistributableFiles.txt",
  "Core/live2dcubismcore.d.ts",
  "Core/live2dcubismcore.min.js",
  "Framework/LICENSE.md",
  ...FRAMEWORK_SOURCE_FILES.map((file) => `Framework/src/${file}`),
  ...SHADER_FILES.map((file) => `Framework/Shaders/WebGL/${file}`),
])

export const HIYORI_RUNTIME_HASHES = Object.freeze({
  "hiyori_pro_t11.2048/texture_00.png":
    "a7d930d42814d8fb69e787b0aef5b60e5afd52b4d4557551c8a58e5bea3a4bb1",
  "hiyori_pro_t11.2048/texture_01.png":
    "87fe9ab7db81ab3025e0407229e449233581e00fa92c8e911923bc6c7d98ce84",
  "hiyori_pro_t11.cdi3.json":
    "131f6819d20d924e2d101a86964a45fad19e53e2c685b9de49a1f19c7479d458",
  "hiyori_pro_t11.moc3":
    "608d62c9a65cf537ac25ca9e710e687dbef98ee0a0575e0ee8e27bfdc446cd5e",
  "hiyori_pro_t11.model3.json":
    "9e40e4dd71beab5bef5c1df9e8223b111549bf1f836d276d1b471003cd754824",
  "hiyori_pro_t11.physics3.json":
    "c7a6d641893519c0bbc615545887f03f6c5b8031b4096873740b618370452fc1",
  "hiyori_pro_t11.pose3.json":
    "c4986e9fe16fee6d4d18fdac826bfa09917a8179d1bdfd6c44d1c33174b03893",
  "motion/hiyori_m01.motion3.json":
    "c4f0d982c685b81c1af0ced96c8f6bd5118b8a3fa972c3a12a46652b8d78461d",
  "motion/hiyori_m02.motion3.json":
    "858c582874a0c4badfec38d4caf19e232fea5ba714f5a2ac6a282c617910c154",
  "motion/hiyori_m03.motion3.json":
    "fe7251179eefd36d9eeec24928e0a8fe924349bb34295d50e8712eab187ea560",
  "motion/hiyori_m04.motion3.json":
    "54ddb94d0494772e10355429c547bb7e29601f38d663087804b0c793b29cc51f",
  "motion/hiyori_m05.motion3.json":
    "1d93372b94e43883933b6eee72a2602f08425ec3be7d2b9a8b30121d6dfef3c1",
  "motion/hiyori_m06.motion3.json":
    "3506c2f0049e31f9bfdf582f34f87e09d19bc19c8f2396191b273ae95953ab61",
  "motion/hiyori_m07.motion3.json":
    "0140c5da76e7c5a214815d5b485b902e2b23df932831458af73eef762199ecb0",
  "motion/hiyori_m08.motion3.json":
    "847fdc148cac91b75b7c2632027abada8dbf8315a91648a03f746b47b861bd42",
  "motion/hiyori_m09.motion3.json":
    "0f6e3ea9cde0cfe16dbd35bc006a8ca4b8c223645f744dadce84d58c0aa4ae52",
  "motion/hiyori_m10.motion3.json":
    "6c19086df4e8e1caa1cb3958d641f4ee40d3639e2c63b4f043bbab824742124e",
})

export const HIYORI_RUNTIME_FILES = Object.freeze(
  Object.keys(HIYORI_RUNTIME_HASHES).sort(),
)
export const HIYORI_NOTICE_SHA256 =
  "d8c9600345b0230a63b1eef75166ea598323a75db3a31871e74c435277b30922"
export const HIYORI_ENTRYPOINT = "hiyori_pro_t11.model3.json"
export const HIYORI_PACK_ID = "builtin:hiyori_pro"
export const HIYORI_RESOURCE_WEB_PATH = "characters/builtin-hiyori"
