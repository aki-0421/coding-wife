import path from "node:path"
import { fileURLToPath } from "node:url"

import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

const projectRoot = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "#app-entry": path.resolve(projectRoot, "src/app/App.tsx"),
      "#workspace-seed": path.resolve(
        projectRoot,
        "src/features/workspace-view/demo-data.ts",
      ),
      "@": path.resolve(projectRoot, "src"),
      "@cubism": path.resolve(projectRoot, "vendor/live2d/dist"),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "http://localhost:1420",
      },
    },
    setupFiles: ["./src/test/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
})
