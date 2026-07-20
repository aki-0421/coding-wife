import { invoke, isTauri } from "@tauri-apps/api/core"
import { StrictMode } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"

import { StartupErrorBoundary, StartupFailure } from "@/app/StartupFailure"
import { loadApplication } from "#app-loader"
import { installNativeTitlebarControls } from "@/app/native-titlebar-controls"
import "@/index.css"

const appWindowReadyCommand = "app_window_ready" as const

const root = document.getElementById("root")
const nativeRuntime = isTauri()

if (!root) {
  throw new Error("Application root element was not found")
}

if (nativeRuntime) installNativeTitlebarControls()

function revealNativeWindow() {
  if (!nativeRuntime) return

  void invoke(appWindowReadyCommand)
}

const applicationRoot = createRoot(root)

async function prepareDesktopQaBridge() {
  if (import.meta.env.VITE_DESKTOP_QA !== "true") return
  await import("@wdio/tauri-plugin")
}

void prepareDesktopQaBridge()
  .then(loadApplication)
  .then(({ App }) => {
    flushSync(() => {
      applicationRoot.render(
        <StrictMode>
          <StartupErrorBoundary>
            <App />
          </StartupErrorBoundary>
        </StrictMode>,
      )
    })
  })
  .catch((error: unknown) => {
    console.error("Coding Wife application module failed to load", error)
    flushSync(() => {
      applicationRoot.render(<StartupFailure />)
    })
  })
  .finally(revealNativeWindow)
