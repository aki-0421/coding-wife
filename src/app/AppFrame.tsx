import { useEffect } from "react"

import { AppProviders } from "@/app/AppProviders"
import type { AppLifecycleGateway } from "@/features/app-lifecycle/gateway"
import { DefaultCharacterStageRenderer } from "@/features/character/components/DefaultCharacterStageRenderer"
import type { CharacterLibraryGateway } from "@/features/character/library/transport"
import { CharacterRuntimeStatusProvider } from "@/features/character/runtime-status"
import type { CommitExplanationAppRuntime } from "@/features/git-review/commit-explanation-adapter"
import type { GitReviewTransport } from "@/features/git-review/transport"
import type { LocalePreferenceStore } from "@/features/localization"
import type { NarrationController } from "@/features/narration/controller"
import type {
  CommitNarrationConsumerPort,
  PresenceDirectionConsumerPort,
} from "@/features/narration/contracts"
import { NarrationProvider } from "@/features/narration/provider"
import type { NarrationGateway } from "@/features/narration/transport"
import type { AppPreferencesController } from "@/features/preferences/controller"
import type { NativeReadinessController } from "@/features/readiness/controller"
import type { AppTransport } from "@/features/runtime/transport"
import { WorkspaceShell } from "@/features/workspace-view/WorkspaceShell"
import type {
  CharacterStageRenderer,
  WorkspaceRecord,
  WorkspaceViewAdapter,
} from "@/features/workspace-view/types"

export interface AppFrameProps {
  readonly appLifecycleGateway: AppLifecycleGateway
  readonly appPreferencesController: AppPreferencesController
  readonly characterLibraryGateway: CharacterLibraryGateway
  readonly characterRenderer?: CharacterStageRenderer | undefined
  readonly commitExplanationRuntime: CommitExplanationAppRuntime | null
  readonly gitReviewTransport: GitReviewTransport
  readonly initialWorkspaces?: readonly WorkspaceRecord[] | undefined
  readonly localeStore?: LocalePreferenceStore | undefined
  readonly narrationController: NarrationController
  readonly narrationGateway: NarrationGateway
  readonly narrationSource?: CommitNarrationConsumerPort | null | undefined
  readonly presenceDirectionSource?:
    | PresenceDirectionConsumerPort
    | null
    | undefined
  readonly readinessController: NativeReadinessController
  readonly transport: AppTransport
  readonly workspaceAdapter: WorkspaceViewAdapter
}

export function AppFrame({
  appLifecycleGateway,
  appPreferencesController,
  characterLibraryGateway,
  characterRenderer,
  commitExplanationRuntime,
  gitReviewTransport,
  initialWorkspaces,
  localeStore,
  narrationController,
  narrationGateway,
  narrationSource,
  presenceDirectionSource,
  readinessController,
  transport,
  workspaceAdapter,
}: AppFrameProps) {
  const characterRendererKind =
    characterRenderer === undefined ? "builtin_hiyori" : "external"
  const activeCharacterRenderer =
    characterRenderer ?? DefaultCharacterStageRenderer
  const activeNarrationSource =
    narrationSource === undefined
      ? (commitExplanationRuntime?.narrationSource ?? null)
      : narrationSource
  const activePresenceDirectionSource = presenceDirectionSource ?? null

  useEffect(() => {
    if (commitExplanationRuntime === null) return
    commitExplanationRuntime.setPresentationActivator((key) =>
      narrationController.activatePresentation(key),
    )
    return () => {
      commitExplanationRuntime.setPresentationActivator(null)
    }
  }, [commitExplanationRuntime, narrationController])

  useEffect(() => {
    if (commitExplanationRuntime === null) return
    void commitExplanationRuntime.start().catch(() => undefined)
    return () => commitExplanationRuntime.dispose()
  }, [commitExplanationRuntime])

  return (
    <AppProviders
      characterLibraryGateway={characterLibraryGateway}
      localeStore={localeStore}
      preferencesController={appPreferencesController}
      readinessController={readinessController}
      transport={transport}
    >
      <NarrationProvider
        controller={narrationController}
        gateway={narrationGateway}
        presenceSource={activePresenceDirectionSource}
        source={activeNarrationSource}
      >
        <CharacterRuntimeStatusProvider rendererKind={characterRendererKind}>
          <WorkspaceShell
            adapter={workspaceAdapter}
            appLifecycleGateway={appLifecycleGateway}
            characterRenderer={activeCharacterRenderer}
            commitExplanationController={commitExplanationRuntime ?? undefined}
            gitReviewTransport={gitReviewTransport}
            initialWorkspaces={initialWorkspaces}
            narrationController={narrationController}
          />
        </CharacterRuntimeStatusProvider>
      </NarrationProvider>
    </AppProviders>
  )
}
