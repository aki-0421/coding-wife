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

function getBrowserLanguageTags(): readonly string[] {
  if (typeof navigator === "undefined") {
    return ["en"]
  }

  return navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language]
}

export interface I18nProviderProps {
  readonly children: ReactNode
  readonly store: LocalePreferenceStore
}

export function I18nProvider({ children, store }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<SupportedLocale>(() => {
    return store.read() ?? detectSupportedLocale(getBrowserLanguageTags())
  })

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback(
    (nextLocale: SupportedLocale) => {
      setLocaleState(nextLocale)
      return store.write(nextLocale)
    },
    [store],
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
