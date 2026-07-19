import { Component, type ErrorInfo, type ReactNode } from "react"

import { Button } from "@/components/ui/button"

interface StartupFailureCopy {
  readonly title: string
  readonly description: string
  readonly reload: string
}

function getStartupFailureCopy(language: string): StartupFailureCopy {
  if (language.toLowerCase().startsWith("ja")) {
    return {
      title: "Coding Wifeを起動できませんでした",
      description:
        "画面の読み込み中に問題が発生しました。アプリを再読み込みしてください。",
      reload: "再読み込み",
    }
  }

  return {
    title: "Coding Wife could not start",
    description:
      "Something went wrong while loading the interface. Reload the app to try again.",
    reload: "Reload",
  }
}

export function StartupFailure() {
  const copy = getStartupFailureCopy(globalThis.navigator?.language ?? "en")

  return (
    <main className="flex size-full min-h-dvh items-center justify-center bg-background px-xl text-foreground">
      <section
        aria-live="assertive"
        className="flex max-w-[32rem] flex-col items-start gap-md"
        role="alert"
      >
        <h1 className="m-0 text-display text-text-strong">{copy.title}</h1>
        <p className="m-0 max-w-[65ch] text-body text-muted-foreground">
          {copy.description}
        </p>
        <Button onClick={() => globalThis.location.reload()} type="button">
          {copy.reload}
        </Button>
      </section>
    </main>
  )
}

interface StartupErrorBoundaryProps {
  readonly children: ReactNode
}

interface StartupErrorBoundaryState {
  readonly failed: boolean
}

export class StartupErrorBoundary extends Component<
  StartupErrorBoundaryProps,
  StartupErrorBoundaryState
> {
  override state: StartupErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): StartupErrorBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Coding Wife failed during startup rendering", error, info)
  }

  override render() {
    return this.state.failed ? <StartupFailure /> : this.props.children
  }
}
