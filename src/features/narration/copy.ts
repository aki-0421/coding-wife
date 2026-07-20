import type { NarrationLocale } from "@/features/narration/contracts"
import type {
  CommitNarrationPresentationStatus,
  NarrationSpeechStatus,
} from "@/features/narration/controller"

export interface NarrationCopy {
  readonly enable: string
  readonly provider: string
  readonly noProvider: string
  readonly providerTabsLabel: string
  readonly openAi: string
  readonly apiKey: string
  readonly apiKeyPlaceholder: string
  readonly apiKeyInvalid: string
  readonly apiKeyConfigured: string
  readonly apiKeyNotConfigured: string
  readonly clearApiKey: string
  readonly apiKeyWillBeRemoved: string
  readonly model: string
  readonly voice: string
  readonly speed: string
  readonly save: string
  readonly discard: string
  readonly reset: string
  readonly resetTitle: string
  readonly resetDescription: string
  readonly resetConfirm: string
  readonly resetCancel: string
  readonly test: string
  readonly cancelTest: string
  readonly testSample: string
  readonly testCaption: string
  readonly loading: string
  readonly unavailable: string
  readonly unavailableDescription: string
  readonly retry: string
  readonly errorTitle: string
  readonly unsaved: string
  readonly saved: string
  readonly captionTitle: string
  readonly captionPreparing: string
  readonly captionEmpty: string
  readonly cancelPresentation: string
  readonly presentationStatuses: Readonly<
    Record<CommitNarrationPresentationStatus, string>
  >
  readonly speechStatuses: Readonly<Record<NarrationSpeechStatus, string>>
}

export const narrationCopy: Readonly<Record<NarrationLocale, NarrationCopy>> = {
  ja: {
    enable: "TTSを有効にする",
    provider: "TTSプロバイダー",
    noProvider: "設定済みのプロバイダーがありません",
    providerTabsLabel: "プロバイダー設定",
    openAi: "OpenAI",
    apiKey: "APIキー",
    apiKeyPlaceholder: "sk-…",
    apiKeyInvalid:
      "APIキーには英数字、ハイフン、アンダースコア、ピリオドだけを使用できます。",
    apiKeyConfigured: "APIキー設定済み",
    apiKeyNotConfigured: "APIキー未設定",
    clearApiKey: "APIキーを削除",
    apiKeyWillBeRemoved: "保存するとAPIキーを削除し、TTSを無効にします。",
    model: "TTSモデル",
    voice: "ボイス",
    speed: "読み上げ速度",
    save: "音声設定を保存",
    discard: "変更を破棄",
    reset: "音声設定をリセット",
    resetTitle: "音声設定をリセットしますか？",
    resetDescription:
      "TTSをオフにしてAPIキーを削除し、OpenAIのモデル、ボイス、速度を初期値へ戻します。",
    resetConfirm: "リセット",
    resetCancel: "キャンセル",
    test: "音声をテスト",
    cancelTest: "テストを停止",
    testSample:
      "これはOpenAI音声のテストです。字幕は音声より先に表示されます。",
    testCaption: "テスト字幕",
    loading: "音声設定を読み込んでいます…",
    unavailable: "TTSを利用できません",
    unavailableDescription:
      "字幕は引き続き利用できます。再読み込み後も失敗する場合は診断を確認してください。",
    retry: "再読み込み",
    errorTitle: "音声設定を更新できませんでした",
    unsaved: "未保存の変更",
    saved: "保存済み",
    captionTitle: "コミットの説明",
    captionPreparing: "説明を準備しています…",
    captionEmpty: "表示できる説明はまだありません。",
    cancelPresentation: "説明を閉じる",
    presentationStatuses: {
      preparing: "準備中",
      streaming: "説明中",
      ready: "完了",
      canceled: "停止",
      unavailable: "利用不可",
    },
    speechStatuses: {
      off: "音声オフ",
      muted: "ミュート",
      idle: "待機中",
      queued: "音声待機中",
      playing: "読み上げ中",
      unavailable: "音声利用不可",
    },
  },
  en: {
    enable: "Enable TTS",
    provider: "TTS provider",
    noProvider: "No configured providers",
    providerTabsLabel: "Provider settings",
    openAi: "OpenAI",
    apiKey: "API key",
    apiKeyPlaceholder: "sk-…",
    apiKeyInvalid:
      "Use only letters, numbers, hyphens, underscores, and periods.",
    apiKeyConfigured: "API key configured",
    apiKeyNotConfigured: "API key not configured",
    clearApiKey: "Remove API key",
    apiKeyWillBeRemoved: "Saving will remove the API key and disable TTS.",
    model: "TTS model",
    voice: "Voice",
    speed: "Speech speed",
    save: "Save audio settings",
    discard: "Discard changes",
    reset: "Reset audio settings",
    resetTitle: "Reset audio settings?",
    resetDescription:
      "Turns TTS off, removes the API key, and restores the default OpenAI model, voice, and speed.",
    resetConfirm: "Reset",
    resetCancel: "Cancel",
    test: "Test voice",
    cancelTest: "Stop test",
    testSample:
      "This is an OpenAI speech test. The caption appears before the audio starts.",
    testCaption: "Test caption",
    loading: "Loading audio settings…",
    unavailable: "TTS is unavailable",
    unavailableDescription:
      "Captions remain available. If retrying still fails, check Diagnostics.",
    retry: "Retry",
    errorTitle: "Audio settings could not be updated",
    unsaved: "Unsaved changes",
    saved: "Saved",
    captionTitle: "Commit explanation",
    captionPreparing: "Preparing the explanation…",
    captionEmpty: "There is no explanation to show yet.",
    cancelPresentation: "Close explanation",
    presentationStatuses: {
      preparing: "Preparing",
      streaming: "Explaining",
      ready: "Complete",
      canceled: "Stopped",
      unavailable: "Unavailable",
    },
    speechStatuses: {
      off: "Speech off",
      muted: "Muted",
      idle: "Idle",
      queued: "Speech queued",
      playing: "Speaking",
      unavailable: "Speech unavailable",
    },
  },
}
