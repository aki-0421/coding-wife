export const supportedLocales = ["ja", "en"] as const

export type SupportedLocale = (typeof supportedLocales)[number]

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return supportedLocales.some((locale) => locale === value)
}

export function detectSupportedLocale(
  languageTags: readonly string[],
): SupportedLocale {
  return languageTags.some((languageTag) =>
    languageTag.toLowerCase().startsWith("ja"),
  )
    ? "ja"
    : "en"
}
