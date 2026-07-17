import { CharacterError } from "@/features/character/model"
import { isAcceptedCharacterResourceContentType } from "@/features/character/runtime/character-pack-client"

export const CUBISM_SHADER_FILES = Object.freeze([
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

const importedShaderSources = import.meta.glob<string>(
  "../../../../vendor/live2d/cubism-sdk-5-r.5/Framework/Shaders/WebGL/*.{frag,vert}",
  {
    eager: true,
    import: "default",
    query: "?raw",
  },
)

const canonicalShaderSources = new Map(
  Object.entries(importedShaderSources).map(([sourcePath, source]) => [
    sourcePath.split("/").at(-1) ?? "",
    source,
  ]),
)

export function getCanonicalCubismShaderSource(file: string): string {
  const source = canonicalShaderSources.get(file)
  if (source === undefined || !CUBISM_SHADER_FILES.includes(file)) {
    throw new CharacterError(
      "asset_fetch_failed",
      `Canonical Cubism shader source is unavailable: ${file}`,
      false,
    )
  }
  return source
}

function matchesCanonicalBytes(
  actual: ArrayBuffer,
  canonical: string,
): boolean {
  const actualBytes = new Uint8Array(actual)
  const canonicalBytes = new TextEncoder().encode(canonical)
  if (actualBytes.byteLength !== canonicalBytes.byteLength) return false
  return actualBytes.every((byte, index) => byte === canonicalBytes[index])
}

export async function verifyCubismShaderSources(
  shaderPath: string,
  signal: AbortSignal,
): Promise<void> {
  const baseUrl = new URL(shaderPath, window.location.href)
  if (baseUrl.origin !== window.location.origin) {
    throw new CharacterError(
      "asset_not_allowed",
      "Cubism shader sources must be same-origin",
      false,
    )
  }

  await Promise.all(
    CUBISM_SHADER_FILES.map(async (file) => {
      const url = new URL(file, baseUrl)
      if (url.origin !== baseUrl.origin) {
        throw new CharacterError(
          "asset_not_allowed",
          "Cubism shader source escaped the same-origin boundary",
          false,
        )
      }

      let response: Response
      try {
        response = await fetch(url, {
          cache: "force-cache",
          credentials: "same-origin",
          signal,
        })
      } catch (error) {
        throw new CharacterError(
          "asset_fetch_failed",
          `Unable to load Cubism shader ${file}`,
          true,
          { cause: error },
        )
      }

      if (!response.ok) {
        throw new CharacterError(
          "asset_fetch_failed",
          `Cubism shader ${file} returned HTTP ${response.status}`,
        )
      }
      if (
        !isAcceptedCharacterResourceContentType(
          "shader",
          response.headers.get("content-type"),
        )
      ) {
        throw new CharacterError(
          "asset_type_mismatch",
          `Cubism shader ${file} used an unexpected media type`,
          false,
        )
      }

      const bytes = await response.arrayBuffer()
      if (!matchesCanonicalBytes(bytes, getCanonicalCubismShaderSource(file))) {
        throw new CharacterError(
          "asset_fetch_failed",
          `Cubism shader ${file} differed from the bundled canonical source`,
          false,
        )
      }
    }),
  )
}
