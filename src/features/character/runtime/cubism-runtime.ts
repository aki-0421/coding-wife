import { CharacterError } from "@/features/character/model"
import { loadLive2dCore } from "@/features/character/runtime/live2d-core-loader"

type CubismFrameworkModule = typeof import("@cubism/live2dcubismframework")

let frameworkPromise: Promise<CubismFrameworkModule> | null = null

export async function acquireCubismRuntime(): Promise<CubismFrameworkModule> {
  await loadLive2dCore()
  if (frameworkPromise !== null) return frameworkPromise

  frameworkPromise = import("@cubism/live2dcubismframework").then((module) => {
    if (!module.CubismFramework.isStarted()) {
      const option = new module.Option()
      option.loggingLevel = module.LogLevel.LogLevel_Error
      option.logFunction = (message: string) => {
        console.error(`[Cubism] ${message}`)
      }
      if (!module.CubismFramework.startUp(option)) {
        throw new CharacterError(
          "framework_initialize_failed",
          "Cubism Framework refused to start",
          false,
        )
      }
    }
    if (!module.CubismFramework.isInitialized()) {
      module.CubismFramework.initialize()
    }
    if (!module.CubismFramework.isInitialized()) {
      throw new CharacterError(
        "framework_initialize_failed",
        "Cubism Framework did not initialize",
        false,
      )
    }
    return module
  })

  return frameworkPromise
}

export async function disposeCubismRuntime(): Promise<void> {
  if (frameworkPromise === null) return
  const module = await frameworkPromise
  if (module.CubismFramework.isInitialized()) {
    module.CubismFramework.dispose()
  }
  if (module.CubismFramework.isStarted()) {
    module.CubismFramework.cleanUp()
  }
  frameworkPromise = null
}
