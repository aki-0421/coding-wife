import type { SupportedLocale } from "@/features/localization/types"

const en = {
  "app.name": "Coding Wife",
  "foundation.title": "Application foundation",
  "foundation.description":
    "The desktop shell is initializing its local runtime boundary.",
  "foundation.loading": "Checking the local runtime…",
  "foundation.error": "The local runtime could not be reached.",
  "foundation.retryHint":
    "Retry the runtime check. If it continues to fail, review the local diagnostics.",
  "action.retry": "Retry",
  "runtime.modeLabel": "Runtime mode",
  "runtime.native": "Native desktop",
  "runtime.demo": "Browser demo",
  "runtime.nativeDescription":
    "The typed Tauri boundary is available. Product integrations are not configured yet.",
  "runtime.demoDescription":
    "Demo mode does not connect to Codex, Git, Live2D, or local history.",
  "runtime.integrationsLabel": "Integration readiness",
  "runtime.notConfigured": "Not configured",
  "runtime.platformLabel": "Platform",
  "runtime.versionLabel": "App version",
  "integration.codex": "Codex",
  "integration.git": "Git",
  "integration.live2d": "Live2D",
  "integration.history": "Local history",
  "locale.switchLabel": "Display language",
  "locale.saveError":
    "The display language could not be saved. The current language is unchanged.",
  "locale.ja": "日本語",
  "locale.en": "English",
} as const

export type TranslationKey = keyof typeof en
export type TranslationResource = Readonly<Record<TranslationKey, string>>

const ja = {
  "app.name": "Coding Wife",
  "foundation.title": "アプリ基盤",
  "foundation.description":
    "デスクトップシェルがローカル実行境界を初期化しています。",
  "foundation.loading": "ローカル実行環境を確認しています…",
  "foundation.error": "ローカル実行環境へ接続できませんでした。",
  "foundation.retryHint":
    "実行環境の確認を再試行してください。失敗が続く場合はローカル診断を確認してください。",
  "action.retry": "再試行",
  "runtime.modeLabel": "実行モード",
  "runtime.native": "ネイティブデスクトップ",
  "runtime.demo": "ブラウザデモ",
  "runtime.nativeDescription":
    "型付きTauri境界は利用できます。プロダクト連携はまだ構成されていません。",
  "runtime.demoDescription":
    "デモモードはCodex、Git、Live2D、ローカル履歴へ接続しません。",
  "runtime.integrationsLabel": "連携準備状況",
  "runtime.notConfigured": "未構成",
  "runtime.platformLabel": "プラットフォーム",
  "runtime.versionLabel": "アプリバージョン",
  "integration.codex": "Codex",
  "integration.git": "Git",
  "integration.live2d": "Live2D",
  "integration.history": "ローカル履歴",
  "locale.switchLabel": "表示言語",
  "locale.saveError":
    "表示言語を保存できませんでした。現在の言語を維持しています。",
  "locale.ja": "日本語",
  "locale.en": "English",
} as const satisfies TranslationResource

export const translationResources: Readonly<
  Record<SupportedLocale, TranslationResource>
> = { ja, en }
