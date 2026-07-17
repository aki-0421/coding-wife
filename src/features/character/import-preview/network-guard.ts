import {
  CUBISM_SHADER_FILES,
  getCanonicalCubismShaderSource,
} from "@/features/character/runtime/shader-source-preflight"

const shaderRoot = "/vendor/live2d/shaders/webgl/"

export function installCharacterPreviewNetworkGuard(): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal?.aborted === true) {
      return Promise.reject(
        new DOMException("The operation was aborted", "AbortError"),
      )
    }
    const rawUrl =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input
    const url = new URL(rawUrl, window.location.href)
    const file = url.pathname.startsWith(shaderRoot)
      ? url.pathname.slice(shaderRoot.length)
      : ""
    if (
      url.origin === window.location.origin &&
      CUBISM_SHADER_FILES.includes(file)
    ) {
      return Promise.resolve(
        new Response(getCanonicalCubismShaderSource(file), {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        }),
      )
    }
    return Promise.reject(
      new TypeError("Character preview network is disabled"),
    )
  }
}
