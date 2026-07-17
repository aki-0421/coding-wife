import {
  isSupportedLocale,
  type SupportedLocale,
} from "@/features/localization/types"

const demoLocaleStorageKey = "coding-wife:demo:locale:v1"

export type LocaleStorePersistence = "demo-local" | "session-only"

export interface LocalePreferenceStore {
  readonly persistence: LocaleStorePersistence
  read(): SupportedLocale | null
  write(locale: SupportedLocale): boolean
}

class SessionLocalePreferenceStore implements LocalePreferenceStore {
  readonly persistence = "session-only"
  private locale: SupportedLocale | null = null

  read(): SupportedLocale | null {
    return this.locale
  }

  write(locale: SupportedLocale): boolean {
    this.locale = locale
    return true
  }
}

class BrowserDemoLocalePreferenceStore implements LocalePreferenceStore {
  readonly persistence = "demo-local"

  read(): SupportedLocale | null {
    try {
      const value = window.localStorage.getItem(demoLocaleStorageKey)
      return isSupportedLocale(value) ? value : null
    } catch {
      return null
    }
  }

  write(locale: SupportedLocale): boolean {
    try {
      window.localStorage.setItem(demoLocaleStorageKey, locale)
      return true
    } catch {
      return false
    }
  }
}

export function createLocalePreferenceStore(
  runtime: "tauri" | "demo",
): LocalePreferenceStore {
  if (runtime === "demo" && typeof window !== "undefined") {
    return new BrowserDemoLocalePreferenceStore()
  }

  return new SessionLocalePreferenceStore()
}
