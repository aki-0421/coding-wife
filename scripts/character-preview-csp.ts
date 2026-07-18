const originToken = "__CHARACTER_PREVIEW_ASSET_ORIGIN__"
const developmentOrigin = "http://localhost:1420"
const productionOrigin = "tauri://localhost"

export function renderCharacterPreviewHtml(
  html: string,
  command: "build" | "serve",
): string {
  const origin = command === "serve" ? developmentOrigin : productionOrigin
  return html.replaceAll(originToken, origin)
}
