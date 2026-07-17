import type { Plugin } from "vite"

export function resolveLive2dAssetRequest(
  requestPath: string,
  assetMap: ReadonlyMap<string, string>,
): string | null

export function live2dAssetsPlugin(projectRoot: string): Plugin
