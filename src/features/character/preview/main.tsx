import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@/index.css"
import "@/features/character/preview/preview.css"
import { Live2dPreviewHarness } from "@/features/character/preview/Live2dPreviewHarness"

const root = document.querySelector<HTMLDivElement>("#live2d-preview-root")

if (root === null) {
  throw new Error("Live2D preview root is missing")
}

createRoot(root).render(
  <StrictMode>
    <Live2dPreviewHarness />
  </StrictMode>,
)
