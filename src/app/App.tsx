import { useMemo, useState } from "react"

import { AppProviders } from "@/app/AppProviders"
import {
  createLocalePreferenceStore,
  type LocalePreferenceStore,
} from "@/features/localization"
import { FoundationShell } from "@/features/runtime/FoundationShell"
import { createAppTransport, type AppTransport } from "@/features/runtime"

export interface AppProps {
  readonly localeStore?: LocalePreferenceStore
  readonly transport?: AppTransport
}

export function App({ localeStore, transport }: AppProps) {
  const [fallbackTransport] = useState(createAppTransport)
  const activeTransport = transport ?? fallbackTransport
  const fallbackLocaleStore = useMemo(
    () => createLocalePreferenceStore(activeTransport.kind),
    [activeTransport.kind],
  )

  return (
    <AppProviders
      localeStore={localeStore ?? fallbackLocaleStore}
      transport={activeTransport}
    >
      <FoundationShell />
    </AppProviders>
  )
}
