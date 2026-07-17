import type { ReactNode } from "react"

import { TooltipProvider } from "@/components/ui/tooltip"
import {
  I18nProvider,
  type LocalePreferenceStore,
} from "@/features/localization"
import {
  CharacterLibraryProvider,
  type CharacterLibraryGateway,
} from "@/features/character"
import { RuntimeProvider, type AppTransport } from "@/features/runtime"

export interface AppProvidersProps {
  readonly children: ReactNode
  readonly characterLibraryGateway: CharacterLibraryGateway
  readonly localeStore: LocalePreferenceStore
  readonly transport: AppTransport
}

export function AppProviders({
  children,
  characterLibraryGateway,
  localeStore,
  transport,
}: AppProvidersProps) {
  return (
    <I18nProvider store={localeStore}>
      <CharacterLibraryProvider gateway={characterLibraryGateway}>
        <RuntimeProvider transport={transport}>
          <TooltipProvider>{children}</TooltipProvider>
        </RuntimeProvider>
      </CharacterLibraryProvider>
    </I18nProvider>
  )
}
