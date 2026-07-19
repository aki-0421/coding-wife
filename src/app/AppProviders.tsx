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
import {
  NativeReadinessProvider,
  type NativeReadinessController,
} from "@/features/readiness"

export interface AppProvidersProps {
  readonly children: ReactNode
  readonly characterLibraryGateway: CharacterLibraryGateway
  readonly localeStore: LocalePreferenceStore | undefined
  readonly readinessController: NativeReadinessController
  readonly preferencesController: AppPreferencesController
  readonly transport: AppTransport
}

export function AppProviders({
  children,
  characterLibraryGateway,
  localeStore,
  readinessController,
  preferencesController,
  transport,
}: AppProvidersProps) {
  return (
    <AppPreferencesProvider controller={preferencesController}>
      <I18nProvider
        {...(localeStore === undefined
          ? { preferencesController }
          : { store: localeStore })}
      >
        <NativeReadinessProvider controller={readinessController}>
          <CharacterLibraryProvider gateway={characterLibraryGateway}>
            <RuntimeProvider transport={transport}>
              <TooltipProvider>{children}</TooltipProvider>
            </RuntimeProvider>
          </CharacterLibraryProvider>
        </NativeReadinessProvider>
      </I18nProvider>
    </AppPreferencesProvider>
  )
}
