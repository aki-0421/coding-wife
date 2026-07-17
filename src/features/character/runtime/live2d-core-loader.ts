import { CharacterError } from "@/features/character/model"

export const LIVE2D_CORE_SCRIPT_URL =
  "/vendor/live2d/core/live2dcubismcore.min.js"
export const LIVE2D_CORE_VERSION = 100_663_297

interface CubismCoreGlobal {
  readonly Version: Readonly<{
    csmGetVersion(): number
  }>
}

type GlobalWithCubismCore = typeof globalThis & {
  Live2DCubismCore?: CubismCoreGlobal
}

let loadPromise: Promise<CubismCoreGlobal> | null = null

function getCore(): CubismCoreGlobal | null {
  return (globalThis as GlobalWithCubismCore).Live2DCubismCore ?? null
}

function verifyCore(core: CubismCoreGlobal): CubismCoreGlobal {
  const version = core.Version.csmGetVersion()
  if (version !== LIVE2D_CORE_VERSION) {
    throw new CharacterError(
      "core_version_mismatch",
      `Cubism Core version mismatch: expected ${LIVE2D_CORE_VERSION}, received ${version}`,
      false,
    )
  }
  return core
}

export function loadLive2dCore(): Promise<CubismCoreGlobal> {
  const existing = getCore()
  if (existing !== null) {
    try {
      return Promise.resolve(verifyCore(existing))
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new CharacterError(
              "core_load_failed",
              "Unable to verify the bundled Cubism Core",
              false,
            ),
      )
    }
  }
  if (loadPromise !== null) return loadPromise

  loadPromise = new Promise<CubismCoreGlobal>((resolve, reject) => {
    const script = document.createElement("script")
    script.async = true
    script.dataset.codingWifeLive2dCore = "5-r.5"
    script.src = LIVE2D_CORE_SCRIPT_URL

    script.addEventListener(
      "load",
      () => {
        const core = getCore()
        if (core === null) {
          reject(
            new CharacterError(
              "core_load_failed",
              "Cubism Core loaded without exposing its reviewed API",
              false,
            ),
          )
          return
        }
        try {
          resolve(verifyCore(core))
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new CharacterError(
                  "core_load_failed",
                  "Unable to verify the bundled Cubism Core",
                  false,
                ),
          )
        }
      },
      { once: true },
    )
    script.addEventListener(
      "error",
      () => {
        reject(
          new CharacterError(
            "core_load_failed",
            "Unable to load the bundled Cubism Core",
          ),
        )
      },
      { once: true },
    )
    document.head.append(script)
  })

  return loadPromise
}

export function resetLive2dCoreLoaderForTests(): void {
  loadPromise = null
}
