import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { StartupErrorBoundary, StartupFailure } from "@/app/StartupFailure"
import { loadApplication } from "#app-loader"
import "@/index.css"

const root = document.getElementById("root")

if (!root) {
  throw new Error("Application root element was not found")
}

const applicationRoot = createRoot(root)

void loadApplication()
  .then(({ App }) => {
    applicationRoot.render(
      <StrictMode>
        <StartupErrorBoundary>
          <App />
        </StartupErrorBoundary>
      </StrictMode>,
    )
  })
  .catch((error: unknown) => {
    console.error("Coding Wife application module failed to load", error)
    applicationRoot.render(<StartupFailure />)
  })
