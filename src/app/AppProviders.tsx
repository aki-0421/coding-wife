import type { ReactNode } from "react"

import { TooltipProvider } from "@/components/ui/tooltip"
import {
  I18nProvider,
  type LocalePreferenceStore,
} from "@/features/localization"
import {
  AppPreferencesProvider,
  type AppPreferencesController,
} from "@/features/preferences"
import {
  CharacterLibraryProvider,
  type CharacterLibraryGateway,
} from "@/features/character"
import { RuntimeProvider, type AppTransport } from "@/features/runtime"

export interface AppProvidersProps {
  readonly children: ReactNode
  readonly characterLibraryGateway: CharacterLibraryGateway
  readonly localeStore?: LocalePreferenceStore
  readonly preferencesController: AppPreferencesController
  readonly transport: AppTransport
}

export function AppProviders({
  children,
  characterLibraryGateway,
  localeStore,
  preferencesController,
  transport,
}: AppProvidersProps) {
  return (
    <AppPreferencesProvider controller={preferencesController}>
      <I18nProvider
        preferencesController={
          localeStore === undefined ? preferencesController : undefined
        }
        store={localeStore}
      >
        <CharacterLibraryProvider gateway={characterLibraryGateway}>
          <RuntimeProvider transport={transport}>
            <TooltipProvider>{children}</TooltipProvider>
          </RuntimeProvider>
        </CharacterLibraryProvider>
      </I18nProvider>
    </AppPreferencesProvider>
  )
}
