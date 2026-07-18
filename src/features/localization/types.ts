export const supportedLocales = ["ja", "en"] as const

export type SupportedLocale = (typeof supportedLocales)[number]

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return supportedLocales.some((locale) => locale === value)
}

export function detectSupportedLocale(
  languageTags: readonly string[],
  fallbackLanguage = "en",
): SupportedLocale {
  const primaryLanguage = languageTags[0] ?? fallbackLanguage

  return primaryLanguage.toLowerCase().startsWith("ja") ? "ja" : "en"
}

export function detectSystemLocale(): SupportedLocale {
  if (typeof navigator === "undefined") return "en"
  return detectSupportedLocale(navigator.languages, navigator.language)
}
