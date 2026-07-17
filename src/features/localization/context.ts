import { createContext } from "react"

import type { TranslationKey } from "@/features/localization/resources"
import type { SupportedLocale } from "@/features/localization/types"

export interface I18nContextValue {
  readonly locale: SupportedLocale
  readonly setLocale: (locale: SupportedLocale) => boolean
  readonly t: (key: TranslationKey) => string
}

export const I18nContext = createContext<I18nContextValue | null>(null)
