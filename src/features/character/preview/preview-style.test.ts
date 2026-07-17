/// <reference types="node" />

import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const themeCss = readFileSync("src/index.css", "utf8")
const previewCss = readFileSync(
  "src/features/character/preview/preview.css",
  "utf8",
)

function readHexToken(name: string): string {
  const match = themeCss.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`))
  if (!match?.[1]) throw new Error(`Missing hex color token: ${name}`)
  return match[1]
}

function readPixelToken(name: string): number {
  const match = themeCss.match(new RegExp(`--${name}:\\s*([0-9.]+)px;`))
  if (!match?.[1]) throw new Error(`Missing pixel token: ${name}`)
  return Number.parseFloat(match[1])
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255)

  if (!channels || channels.length !== 3) {
    throw new Error(`Invalid hex color: ${hex}`)
  }

  const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  )
  return red * 0.2126 + green * 0.7152 + blue * 0.0722
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

describe("Live2D preview typography", () => {
  it("keeps label and preview microcopy at the accessible floor", () => {
    expect(readPixelToken("text-label")).toBeGreaterThanOrEqual(11)

    const literalFontSizes = [
      ...previewCss.matchAll(/font-size:\s*([0-9.]+)px/g),
    ]
      .map((match) => Number.parseFloat(match[1] ?? "0"))
      .filter((size) => size < 11)
    expect(literalFontSizes).toEqual([])
    expect(previewCss.match(/font-size:\s*var\(--text-label\);/g)).toHaveLength(
      8,
    )
  })

  it("uses semantic text colors that pass AA on preview surfaces", () => {
    const selectedSecondary = readHexToken("selected-row-secondary")
    const selectedRow = readHexToken("selected-row")
    const mutedForeground = readHexToken("muted-foreground")
    const sidebar = readHexToken("sidebar")
    const surface = readHexToken("surface")
    const textSecondary = readHexToken("text-secondary")
    const codeChip = readHexToken("code-chip")

    expect(
      contrastRatio(selectedSecondary, selectedRow),
    ).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(mutedForeground, sidebar)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(mutedForeground, surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(textSecondary, codeChip)).toBeGreaterThanOrEqual(4.5)

    expect(previewCss).toMatch(
      /\.preview-workspace-row small\s*{[^}]*color:\s*var\(--selected-row-secondary\);/s,
    )
    expect(previewCss).toMatch(
      /#live2d-metrics\s*{[^}]*color:\s*var\(--muted-foreground\);/s,
    )
    expect(previewCss).toMatch(
      /\.preview-tool-row code,[^{]*\.preview-success code\s*{[^}]*color:\s*var\(--text-secondary\);/s,
    )
    expect(previewCss).toMatch(
      /\.preview-composer > p\s*{[^}]*color:\s*var\(--muted-foreground\);/s,
    )
    expect(previewCss).toMatch(
      /\.preview-header nav button\s*{[^}]*color:\s*var\(--muted-foreground\);/s,
    )
  })
})
