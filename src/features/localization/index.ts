export { I18nProvider } from "@/features/localization/I18nProvider"
export {
  createLocalePreferenceStore,
  type LocalePreferenceStore,
} from "@/features/localization/locale-store"
export type { TranslationKey } from "@/features/localization/resources"
export {
  detectSystemLocale,
  detectSupportedLocale,
  isSupportedLocale,
  supportedLocales,
  type SupportedLocale,
} from "@/features/localization/types"
export { useI18n } from "@/features/localization/useI18n"
