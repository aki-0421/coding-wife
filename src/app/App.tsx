import { useMemo, useState } from "react"

import { AppProviders } from "@/app/AppProviders"
import {
  CharacterRuntimeStatusProvider,
  createCharacterLibraryGateway,
  DefaultCharacterStageRenderer,
  type CharacterLibraryGateway,
} from "@/features/character"
import {
  createLocalePreferenceStore,
  type LocalePreferenceStore,
} from "@/features/localization"
import {
  DemoGitReviewTransport,
  TauriGitReviewTransport,
  type GitReviewTransport,
} from "@/features/git-review"
import { createAppTransport, type AppTransport } from "@/features/runtime"
import { createWorkspaceViewAdapter } from "@/features/workspace-persistence"
import {
  WorkspaceShell,
  type CharacterStageRenderer,
  type WorkspaceViewAdapter,
} from "@/features/workspace-view"

export interface AppProps {
  readonly characterLibraryGateway?: CharacterLibraryGateway
  readonly characterRenderer?: CharacterStageRenderer
  readonly localeStore?: LocalePreferenceStore
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
  characterLibraryGateway,
  characterRenderer,
  localeStore,
  transport,
  workspaceAdapter,
}: AppProps) {
  const [fallbackTransport] = useState(createAppTransport)
  const activeTransport = transport ?? fallbackTransport
  const characterRendererKind =
    characterRenderer === undefined ? "builtin_hiyori" : "external"
  const activeCharacterRenderer =
    characterRenderer ?? DefaultCharacterStageRenderer
  const fallbackLocaleStore = useMemo(
    () => createLocalePreferenceStore(activeTransport.kind),
    [activeTransport.kind],
  )
  const fallbackWorkspaceAdapter = useMemo(
    () =>
      createWorkspaceViewAdapter(activeTransport.kind, {
        interactiveDemo: interactiveDemoEnabled(activeTransport),
      }),
    [activeTransport],
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

  return (
    <AppProviders
      characterLibraryGateway={
        characterLibraryGateway ?? fallbackCharacterLibraryGateway
      }
      localeStore={localeStore ?? fallbackLocaleStore}
      transport={activeTransport}
    >
      <CharacterRuntimeStatusProvider rendererKind={characterRendererKind}>
        <WorkspaceShell
          adapter={workspaceAdapter ?? fallbackWorkspaceAdapter}
          characterRenderer={activeCharacterRenderer}
          gitReviewTransport={gitReviewTransport}
        />
      </CharacterRuntimeStatusProvider>
    </AppProviders>
  )
}
