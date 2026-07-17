import { afterEach, describe, expect, it, vi } from "vitest"

import {
  getCanonicalCubismShaderSource,
  verifyCubismShaderSources,
} from "@/features/character/runtime/shader-source-preflight"

function stubShaders(
  contentType: string | null,
  sourceForFile = getCanonicalCubismShaderSource,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: URL | RequestInfo) => {
      const url = new URL(
        input instanceof URL
          ? input.href
          : typeof input === "string"
            ? input
            : input.url,
      )
      const source = sourceForFile(url.pathname.split("/").at(-1) ?? "")
      const responseOptions =
        contentType === null
          ? undefined
          : { headers: { "content-type": contentType } }
      return Promise.resolve(
        new Response(new TextEncoder().encode(source), responseOptions),
      )
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Cubism shader source preflight", () => {
  it.each([null, "text/plain; charset=utf-8"])(
    "accepts canonical bundled bytes with media type %s",
    async (contentType) => {
      stubShaders(contentType)

      await expect(
        verifyCubismShaderSources(
          "/vendor/live2d/shaders/webgl/",
          new AbortController().signal,
        ),
      ).resolves.toBeUndefined()
    },
  )

  it("rejects an explicit unexpected shader media type", async () => {
    stubShaders("text/html")

    await expect(
      verifyCubismShaderSources(
        "/vendor/live2d/shaders/webgl/",
        new AbortController().signal,
      ),
    ).rejects.toThrow("unexpected media type")
  })

  it("rejects MIME-less shader bytes that differ from canonical source", async () => {
    stubShaders(null, (file) => `${getCanonicalCubismShaderSource(file)}\n`)

    await expect(
      verifyCubismShaderSources(
        "/vendor/live2d/shaders/webgl/",
        new AbortController().signal,
      ),
    ).rejects.toThrow("differed from the bundled canonical source")
  })

  it("rejects a cross-origin shader root before fetching", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)

    await expect(
      verifyCubismShaderSources(
        "https://example.com/shaders/",
        new AbortController().signal,
      ),
    ).rejects.toThrow("same-origin")
    expect(fetch).not.toHaveBeenCalled()
  })
})
