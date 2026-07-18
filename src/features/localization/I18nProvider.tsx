import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import { I18nContext } from "@/features/localization/context"
import type { LocalePreferenceStore } from "@/features/localization/locale-store"
import {
  translationResources,
  type TranslationKey,
} from "@/features/localization/resources"
import {
  detectSystemLocale,
  type SupportedLocale,
} from "@/features/localization/types"
import type { AppPreferencesController } from "@/features/preferences"

export interface I18nProviderProps {
  readonly children: ReactNode
  readonly preferencesController?: AppPreferencesController
  readonly store?: LocalePreferenceStore
}

export function I18nProvider({
  children,
  preferencesController,
  store,
}: I18nProviderProps) {
  const [locale, setLocaleState] = useState<SupportedLocale>(() => {
    return (
      preferencesController?.getSnapshot().snapshot.preferences.locale ??
      store?.read() ??
      detectSystemLocale()
    )
  })

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    if (preferencesController === undefined) return
    const synchronize = () => {
      setLocaleState(
        preferencesController.getSnapshot().snapshot.preferences.locale,
      )
    }
    synchronize()
    return preferencesController.subscribe(synchronize)
  }, [preferencesController])

  const setLocale = useCallback(
    async (nextLocale: SupportedLocale) => {
      if (nextLocale === locale) {
        return true
      }

      if (preferencesController !== undefined) {
        return preferencesController.update({ locale: nextLocale })
      }

      const didPersist = store?.write(nextLocale) ?? false
      if (didPersist) {
        setLocaleState(nextLocale)
      }

      return didPersist
    },
    [locale, preferencesController, store],
  )

  const t = useCallback(
    (key: TranslationKey) => translationResources[locale][key],
    [locale],
  )

  const value = useMemo(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
