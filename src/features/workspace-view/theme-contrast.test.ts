/// <reference types="node" />

import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const themeCss = readFileSync("src/index.css", "utf8")

function readHexToken(name: string): string {
  const match = themeCss.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`))
  if (!match?.[1]) throw new Error(`Missing hex color token: ${name}`)
  return match[1]
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

describe("workspace theme contrast", () => {
  const selectedRow = readHexToken("selected-row")
  const selectedRowSecondary = readHexToken("selected-row-secondary")
  const sidebar = readHexToken("sidebar")
  const surface = readHexToken("surface")
  const mutedForeground = readHexToken("muted-foreground")
  const focusRing = readHexToken("ring")

  it("keeps selected and hover secondary text above the AA threshold", () => {
    expect(
      contrastRatio(selectedRowSecondary, selectedRow),
    ).toBeGreaterThanOrEqual(4.8)
  })

  it("keeps default secondary text legible on dark application surfaces", () => {
    expect(contrastRatio(mutedForeground, sidebar)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(mutedForeground, surface)).toBeGreaterThanOrEqual(4.5)
  })

  it("keeps the focus ring distinguishable around selected rows", () => {
    expect(contrastRatio(focusRing, selectedRow)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(focusRing, sidebar)).toBeGreaterThanOrEqual(3)
  })
})
