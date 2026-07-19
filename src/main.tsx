import { invoke, isTauri } from "@tauri-apps/api/core"
import { StrictMode } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"

import { loadApplication } from "#app-loader"
import { installNativeTitlebarControls } from "@/app/native-titlebar-controls"
import "@/index.css"

const appWindowReadyCommand = "app_window_ready" as const
const bootstrapFailureCopy = navigator.language.toLowerCase().startsWith("ja")
  ? {
      title: "アプリを表示できませんでした",
      description: "Coding Wifeを終了して、もう一度起動してください。",
    }
  : {
      title: "The app could not be displayed",
      description: "Quit Coding Wife, then open it again.",
    }

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

void loadApplication()
  .then(({ App }) => {
    flushSync(() => {
      applicationRoot.render(
        <StrictMode>
          <App />
        </StrictMode>,
      )
    })
  })
  .catch(() => {
    flushSync(() => {
      applicationRoot.render(
        <main
          className="flex min-h-dvh items-center justify-center bg-background p-xl"
          role="alert"
        >
          <section className="flex max-w-[36rem] flex-col gap-xs">
            <h1 className="m-0 text-headline text-text-strong">
              {bootstrapFailureCopy.title}
            </h1>
            <p className="m-0 text-body text-muted-foreground">
              {bootstrapFailureCopy.description}
            </p>
          </section>
        </main>,
      )
    })
  })
  .finally(revealNativeWindow)
