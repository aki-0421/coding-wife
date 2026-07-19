import path from "node:path"
import { fileURLToPath } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

import { renderCharacterPreviewHtml } from "./scripts/character-preview-csp"
import { live2dAssetsPlugin } from "./scripts/live2d/vite-plugin-live2d-assets.mjs"

const projectRoot = fileURLToPath(new URL(".", import.meta.url))

function characterPreviewCspPlugin(command: "build" | "serve"): Plugin {
  return {
    name: "character-preview-mode-csp",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        return context.path.endsWith("/character-import-preview.html")
          ? renderCharacterPreviewHtml(html, command)
          : html
      },
    },
  }
}

export default defineConfig(({ command }) => ({
  plugins: [
    characterPreviewCspPlugin(command),
    live2dAssetsPlugin(projectRoot),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "#app-loader": path.resolve(
        projectRoot,
        command === "build"
          ? "src/app/production-app-loader.ts"
          : "src/app/development-app-loader.ts",
      ),
      "@": path.resolve(projectRoot, "src"),
      "@cubism": path.resolve(projectRoot, "vendor/live2d/dist"),
    },
  },
  clearScreen: false,
  build: {
    rollupOptions: {
      input: {
        app: path.resolve(projectRoot, "index.html"),
        characterImportPreview: path.resolve(
          projectRoot,
          "character-import-preview.html",
        ),
        live2dPreview: path.resolve(projectRoot, "live2d-preview.html"),
      },
    },
  },
  server: {
    cors: {
      origin: "null",
    },
    port: 1420,
    strictPort: true,
  },
}))
