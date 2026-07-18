import { useEffect, useMemo, useState } from "react"

import { AppProviders } from "@/app/AppProviders"
import {
  createAppLifecycleGateway,
  type AppLifecycleGateway,
} from "@/features/app-lifecycle"
import {
  CharacterRuntimeStatusProvider,
  createCharacterLibraryGateway,
  DefaultCharacterStageRenderer,
  type CharacterLibraryGateway,
} from "@/features/character"
import {
  detectSystemLocale,
  type LocalePreferenceStore,
} from "@/features/localization"
import {
  createNarrationGateway,
  NarrationController,
  NarrationProvider,
  type CommitNarrationConsumerPort,
  type NarrationGateway,
} from "@/features/narration"
import {
  DemoCommitExplanationRuntime,
  DemoGitReviewTransport,
  TauriCommitExplanationAdapter,
  TauriGitReviewTransport,
  type CommitExplanationAppRuntime,
  type GitReviewTransport,
} from "@/features/git-review"
import {
  AppPreferencesController,
  createAppPreferencesGateway,
} from "@/features/preferences"
import { createAppTransport, type AppTransport } from "@/features/runtime"
import {
  createNativeReadinessGateway,
  NativeReadinessController,
} from "@/features/readiness"
import { createWorkspaceViewAdapter } from "@/features/workspace-persistence"
import {
  WorkspaceShell,
  type CharacterStageRenderer,
  type WorkspaceViewAdapter,
} from "@/features/workspace-view"

export interface AppProps {
  readonly appLifecycleGateway?: AppLifecycleGateway
  readonly appPreferencesController?: AppPreferencesController
  readonly characterLibraryGateway?: CharacterLibraryGateway
  readonly characterRenderer?: CharacterStageRenderer
  readonly commitExplanationRuntime?: CommitExplanationAppRuntime | null
  readonly localeStore?: LocalePreferenceStore
  readonly narrationController?: NarrationController
  readonly narrationGateway?: NarrationGateway
  readonly narrationSource?: CommitNarrationConsumerPort | null
  readonly readinessController?: NativeReadinessController
  readonly transport?: AppTransport
  readonly workspaceAdapter?: WorkspaceViewAdapter
}

function interactiveDemoEnabled(transport: AppTransport): boolean {
  return (
    import.meta.env.DEV &&
    transport.kind === "demo" &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("demoAppServer") === "1"
  )
}

export function App({
  appLifecycleGateway,
  appPreferencesController,
  characterLibraryGateway,
  characterRenderer,
  commitExplanationRuntime,
  localeStore,
  narrationController,
  narrationGateway,
  narrationSource,
  readinessController,
  transport,
  workspaceAdapter,
}: AppProps) {
  const [fallbackTransport] = useState(createAppTransport)
  const activeTransport = transport ?? fallbackTransport
  const interactiveDemo = interactiveDemoEnabled(activeTransport)
  const characterRendererKind =
    characterRenderer === undefined ? "builtin_hiyori" : "external"
  const activeCharacterRenderer =
    characterRenderer ?? DefaultCharacterStageRenderer
  const fallbackPreferencesController = useMemo(
    () =>
      new AppPreferencesController(
        createAppPreferencesGateway(
          activeTransport.kind === "tauri" ? "native" : "demo",
        ),
        detectSystemLocale(),
      ),
    [activeTransport.kind],
  )
  const activePreferencesController =
    appPreferencesController ?? fallbackPreferencesController
  const fallbackReadinessController = useMemo(
    () =>
      new NativeReadinessController(
        createNativeReadinessGateway(
          activeTransport.kind === "tauri" ? "native" : "demo",
        ),
      ),
    [activeTransport.kind],
  )
  const activeReadinessController =
    readinessController ?? fallbackReadinessController
  const fallbackWorkspaceAdapter = useMemo(
    () =>
      createWorkspaceViewAdapter(activeTransport.kind, {
        interactiveDemo,
      }),
    [activeTransport.kind, interactiveDemo],
  )
  const fallbackAppLifecycleGateway = useMemo(
    () => createAppLifecycleGateway(activeTransport.kind),
    [activeTransport.kind],
  )
  const fallbackCharacterLibraryGateway = useMemo(
    () =>
      createCharacterLibraryGateway(
        activeTransport.kind === "tauri" ? "native" : "demo",
      ),
    [activeTransport.kind],
  )
  const gitReviewTransport = useMemo<GitReviewTransport>(
    () =>
      activeTransport.kind === "tauri"
        ? new TauriGitReviewTransport()
        : new DemoGitReviewTransport(0),
    [activeTransport.kind],
  )
  const fallbackNarrationGateway = useMemo(
    () =>
      createNarrationGateway(
        activeTransport.kind === "tauri" ? "native" : "demo",
      ),
    [activeTransport.kind],
  )
  const activeNarrationGateway = narrationGateway ?? fallbackNarrationGateway
  const fallbackNarrationController = useMemo(
    () => new NarrationController(activeNarrationGateway),
    [activeNarrationGateway],
  )
  const activeNarrationController =
    narrationController ?? fallbackNarrationController
  const fallbackCommitExplanationRuntime = useMemo(
    () =>
      activeTransport.kind === "tauri"
        ? new TauriCommitExplanationAdapter()
        : interactiveDemo
          ? new DemoCommitExplanationRuntime()
          : null,
    [activeTransport.kind, interactiveDemo],
  )
  const activeCommitExplanationRuntime =
    commitExplanationRuntime === undefined
      ? fallbackCommitExplanationRuntime
      : commitExplanationRuntime
  const activeNarrationSource =
    narrationSource === undefined
      ? (activeCommitExplanationRuntime?.narrationSource ?? null)
      : narrationSource

  useEffect(() => {
    if (activeCommitExplanationRuntime === null) return
    activeCommitExplanationRuntime.setPresentationActivator((key) =>
      activeNarrationController.activatePresentation(key),
    )
    return () => {
      activeCommitExplanationRuntime.setPresentationActivator(null)
    }
  }, [activeCommitExplanationRuntime, activeNarrationController])

  useEffect(() => {
    if (activeCommitExplanationRuntime === null) return
    void activeCommitExplanationRuntime.start().catch(() => undefined)
    return () => activeCommitExplanationRuntime.dispose()
  }, [activeCommitExplanationRuntime])

  return (
    <AppProviders
      characterLibraryGateway={
        characterLibraryGateway ?? fallbackCharacterLibraryGateway
      }
      localeStore={localeStore}
      preferencesController={activePreferencesController}
      readinessController={activeReadinessController}
      transport={activeTransport}
    >
      <NarrationProvider
        controller={activeNarrationController}
        gateway={activeNarrationGateway}
        source={activeNarrationSource}
      >
        <CharacterRuntimeStatusProvider rendererKind={characterRendererKind}>
          <WorkspaceShell
            adapter={workspaceAdapter ?? fallbackWorkspaceAdapter}
            appLifecycleGateway={
              appLifecycleGateway ?? fallbackAppLifecycleGateway
            }
            characterRenderer={activeCharacterRenderer}
            commitExplanationController={
              activeCommitExplanationRuntime ?? undefined
            }
            gitReviewTransport={gitReviewTransport}
            narrationController={activeNarrationController}
          />
        </CharacterRuntimeStatusProvider>
      </NarrationProvider>
    </AppProviders>
  )
}
