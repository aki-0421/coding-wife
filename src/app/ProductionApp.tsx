import { useState } from "react"

import { AppFrame } from "@/app/AppFrame"
import { TauriAppLifecycleGateway } from "@/features/app-lifecycle/gateway"
import { NativeCharacterLibraryGateway } from "@/features/character/library/transport"
import { TauriCodexTransport } from "@/features/codex/transport"
import { TauriCommitExplanationAdapter } from "@/features/git-review/commit-explanation-adapter"
import { TauriGitReviewTransport } from "@/features/git-review/transport"
import { detectSystemLocale } from "@/features/localization"
import { NarrationController } from "@/features/narration/controller"
import { NativeNarrationGateway } from "@/features/narration/transport"
import { AppPreferencesController } from "@/features/preferences/controller"
import { NativeAppPreferencesGateway } from "@/features/preferences/transport"
import { NativeReadinessController } from "@/features/readiness/controller"
import { TauriNativeReadinessGateway } from "@/features/readiness/transport"
import { TauriTransport } from "@/features/runtime/transport"
import { CodexComposedWorkspaceViewAdapter } from "@/features/workspace-persistence/codex-composition"
import { TauriWorkspaceHistoryTransport } from "@/features/workspace-persistence/transport"

function createProductionDependencies() {
  const narrationGateway = new NativeNarrationGateway()
  const commitExplanationRuntime = new TauriCommitExplanationAdapter()
  return {
    appLifecycleGateway: new TauriAppLifecycleGateway(),
    appPreferencesController: new AppPreferencesController(
      new NativeAppPreferencesGateway(),
      detectSystemLocale(),
    ),
    characterLibraryGateway: new NativeCharacterLibraryGateway(),
    commitExplanationRuntime,
    gitReviewTransport: new TauriGitReviewTransport(),
    narrationController: new NarrationController(narrationGateway),
    narrationGateway,
    readinessController: new NativeReadinessController(
      new TauriNativeReadinessGateway(),
    ),
    transport: new TauriTransport(),
    workspaceAdapter: new CodexComposedWorkspaceViewAdapter(
      new TauriWorkspaceHistoryTransport(),
      new TauriCodexTransport(),
    ),
  }
}

export function App() {
  const [dependencies] = useState(createProductionDependencies)
  return <AppFrame {...dependencies} />
}
