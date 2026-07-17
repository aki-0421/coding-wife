import { useMemo, useState } from "react"

import { AppProviders } from "@/app/AppProviders"
import {
  CharacterRuntimeStatusProvider,
  DefaultCharacterStageRenderer,
} from "@/features/character"
import {
  createLocalePreferenceStore,
  type LocalePreferenceStore,
} from "@/features/localization"
import { createAppTransport, type AppTransport } from "@/features/runtime"
import {
  WorkspaceShell,
  type CharacterStageRenderer,
  type WorkspaceViewAdapter,
} from "@/features/workspace-view"

export interface AppProps {
  readonly characterRenderer?: CharacterStageRenderer
  readonly localeStore?: LocalePreferenceStore
  readonly transport?: AppTransport
  readonly workspaceAdapter?: WorkspaceViewAdapter
}

export function App({
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

  return (
    <AppProviders
      localeStore={localeStore ?? fallbackLocaleStore}
      transport={activeTransport}
    >
      <CharacterRuntimeStatusProvider rendererKind={characterRendererKind}>
        <WorkspaceShell
          adapter={workspaceAdapter}
          characterRenderer={activeCharacterRenderer}
        />
      </CharacterRuntimeStatusProvider>
    </AppProviders>
  )
}
