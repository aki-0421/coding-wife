import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { renderCharacterPreviewHtml } from "../../../../scripts/character-preview-csp"

const previewHtml = readFileSync("character-import-preview.html", "utf8")
const previewHostSource = readFileSync(
  "src/features/character/import-preview/IsolatedCharacterPreview.tsx",
  "utf8",
)
const viteConfig = readFileSync("vite.config.ts", "utf8")
const tauriConfig = JSON.parse(
  readFileSync("src-tauri/tauri.conf.json", "utf8"),
) as {
  build: { devUrl: string }
  app: { security: { csp: string; devCsp: string } }
}

const productionOrigin = "tauri://localhost"
const developmentOrigin = new URL(tauriConfig.build.devUrl).origin

function sourceAttribute(
  source: string,
  tagPattern: RegExp,
  attribute: string,
): string {
  const tag = source.match(tagPattern)?.[0]
  if (tag === undefined) throw new Error(`Missing tag matching ${tagPattern}`)
  const value = tag.match(new RegExp(`${attribute}="([^"]*)"`, "i"))?.[1]
  if (value === undefined) throw new Error(`Missing ${attribute} attribute`)
  return value
}

function directives(policy: string): Map<string, readonly string[]> {
  return new Map(
    policy
      .split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .filter((tokens) => tokens[0] !== "")
      .map(([name, ...sources]) => [name!, sources]),
  )
}

function expectSources(
  policy: Map<string, readonly string[]>,
  directive: string,
  sources: readonly string[],
) {
  expect(policy.get(directive)).toEqual(sources)
}

describe("isolated character preview CSP", () => {
  const policyFor = (command: "build" | "serve") =>
    directives(
      sourceAttribute(
        renderCharacterPreviewHtml(previewHtml, command),
        /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i,
        "content",
      ),
    )
  const productionPolicy = policyFor("build")
  const developmentPolicy = policyFor("serve")

  it("allows exactly one mode-specific application origin", () => {
    expect(developmentOrigin).toBe("http://localhost:1420")
    for (const [policy, origin] of [
      [productionPolicy, productionOrigin],
      [developmentPolicy, developmentOrigin],
    ] as const) {
      expectSources(policy, "default-src", ["'none'"])
      expectSources(policy, "script-src", [origin])
      expectSources(policy, "style-src", [origin])
      expectSources(policy, "font-src", [origin])
      expectSources(policy, "img-src", [origin, "blob:", "data:"])
      expectSources(policy, "connect-src", ["'none'"])
      expectSources(policy, "form-action", ["'none'"])
      expectSources(policy, "object-src", ["'none'"])
    }
    const productionHtml = renderCharacterPreviewHtml(previewHtml, "build")
    const developmentHtml = renderCharacterPreviewHtml(previewHtml, "serve")
    expect(productionHtml).not.toContain(developmentOrigin)
    expect(developmentHtml).not.toContain(productionOrigin)
    expect(productionHtml).not.toContain("__CHARACTER_PREVIEW_ASSET_ORIGIN__")
    expect(developmentHtml).not.toContain("__CHARACTER_PREVIEW_ASSET_ORIGIN__")
  })

  it("keeps executable content and navigation capabilities closed", () => {
    for (const policy of [productionPolicy, developmentPolicy]) {
      const serialized = [...policy.values()].flat().join(" ")
      expect(serialized).not.toMatch(
        /\*|'self'|'unsafe-inline'|'unsafe-eval'|https?:\/\/(?!localhost:1420)/,
      )
    }

    const sandbox = sourceAttribute(
      previewHostSource,
      /<iframe[\s\S]*?\/>/i,
      "sandbox",
    )
    expect(sandbox).toBe("allow-scripts")
    expect(sandbox).not.toMatch(
      /allow-same-origin|allow-forms|allow-popups|allow-top-navigation/,
    )
  })

  it("keeps parent and child module requests reachable in dev and production", () => {
    const parentProductionPolicy = directives(tauriConfig.app.security.csp)
    const parentDevelopmentPolicy = directives(tauriConfig.app.security.devCsp)
    for (const directive of [
      "script-src",
      "style-src",
      "font-src",
      "img-src",
    ]) {
      expect(parentProductionPolicy.get(directive)).toContain(productionOrigin)
      expect(parentDevelopmentPolicy.get(directive)).toContain(
        developmentOrigin,
      )
    }
    expect(parentProductionPolicy.get("img-src")).toContain(
      "https://avatars.githubusercontent.com",
    )
    expect(parentDevelopmentPolicy.get("img-src")).toContain(
      "https://avatars.githubusercontent.com",
    )
    expect(
      sourceAttribute(
        previewHtml,
        /<script\s+type="module"[\s\S]*?<\/script>/i,
        "src",
      ),
    ).toBe("/src/features/character/import-preview/main.tsx")
    expect(
      sourceAttribute(
        previewHtml,
        /<link\s+rel="stylesheet"[\s\S]*?\/>/i,
        "href",
      ),
    ).toBe("/src/features/character/import-preview/import-preview.css")
    expect(viteConfig).toMatch(/cors:\s*{\s*origin:\s*"null",?\s*}/)
    expect(previewHostSource).toContain('sandbox="allow-scripts"')
  })
})
