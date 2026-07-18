import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { loadApplication } from "#app-loader"
import "@/index.css"

const root = document.getElementById("root")

if (!root) {
  throw new Error("Application root element was not found")
}

void loadApplication().then(({ App }) => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
