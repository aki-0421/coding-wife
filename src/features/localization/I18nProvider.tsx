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
  detectSupportedLocale,
  type SupportedLocale,
} from "@/features/localization/types"

interface BrowserLanguagePreference {
  readonly languageTags: readonly string[]
  readonly fallbackLanguage: string
}

function getBrowserLanguagePreference(): BrowserLanguagePreference {
  if (typeof navigator === "undefined") {
    return { languageTags: [], fallbackLanguage: "en" }
  }

  return {
    languageTags: navigator.languages,
    fallbackLanguage: navigator.language,
  }
}

export interface I18nProviderProps {
  readonly children: ReactNode
  readonly store: LocalePreferenceStore
}

export function I18nProvider({ children, store }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<SupportedLocale>(() => {
    const browserLanguage = getBrowserLanguagePreference()
    return (
      store.read() ??
      detectSupportedLocale(
        browserLanguage.languageTags,
        browserLanguage.fallbackLanguage,
      )
    )
  })

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback(
    (nextLocale: SupportedLocale) => {
      if (nextLocale === locale) {
        return true
      }

      const didPersist = store.write(nextLocale)
      if (didPersist) {
        setLocaleState(nextLocale)
      }

      return didPersist
    },
    [locale, store],
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
