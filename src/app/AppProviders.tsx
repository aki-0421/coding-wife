import type { ReactNode } from "react"

import { TooltipProvider } from "@/components/ui/tooltip"
import {
  I18nProvider,
  type LocalePreferenceStore,
} from "@/features/localization"
import { RuntimeProvider, type AppTransport } from "@/features/runtime"

export interface AppProvidersProps {
  readonly children: ReactNode
  readonly localeStore: LocalePreferenceStore
  readonly transport: AppTransport
}

export function AppProviders({
  children,
  localeStore,
  transport,
}: AppProvidersProps) {
  return (
    <I18nProvider store={localeStore}>
      <RuntimeProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </RuntimeProvider>
    </I18nProvider>
  )
}
