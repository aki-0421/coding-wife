import path from "node:path"
import { fileURLToPath } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import { live2dAssetsPlugin } from "./scripts/live2d/vite-plugin-live2d-assets.mjs"

const projectRoot = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  plugins: [live2dAssetsPlugin(projectRoot), react(), tailwindcss()],
  resolve: {
    alias: {
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
    port: 1420,
    strictPort: true,
  },
})
