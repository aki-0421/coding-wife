import type { NarrationLocale } from "@/features/narration/contracts"
import type {
  CommitNarrationPresentationStatus,
  NarrationSpeechStatus,
} from "@/features/narration/controller"

export interface NarrationCopy {
  readonly description: string
  readonly localOnly: string
  readonly sourceLabel: string
  readonly sourceValue: string
  readonly sourceDescription: string
  readonly enable: string
  readonly enableDescription: string
  readonly mute: string
  readonly muteDescription: string
  readonly voice: string
  readonly voiceDescription: string
  readonly noVoice: string
  readonly rate: string
  readonly rateDescription: string
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
  readonly retryVoices: string
  readonly errorTitle: string
  readonly activePresentation: string
  readonly noPresentation: string
  readonly status: string
  readonly speech: string
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
    description:
      "字幕を正本とし、音声は任意のローカル補助として使います。音声や説明文をネットワークへ送信しません。",
    localOnly: "ローカルのみ · macOS",
    sourceLabel: "コミット説明のソース",
    sourceValue: "アプリ内生成 · コミット説明",
    sourceDescription:
      "main session や sub-agent の出力は読み上げません。説明は「詳しく教えて」の後だけ表示します。",
    enable: "TTSを有効にする",
    enableDescription:
      "初期値はオフです。固定された /usr/bin/say だけを使用します。",
    mute: "ミュート",
    muteDescription: "現在の音声を停止します。字幕はそのまま残ります。",
    voice: "音声",
    voiceDescription: "この表示言語に対応するインストール済み音声です。",
    noVoice: "利用できる音声がありません",
    rate: "読み上げ速度",
    rateDescription: "0.75〜1.25倍（135〜225 words/minute）",
    save: "音声設定を保存",
    discard: "変更を破棄",
    reset: "音声設定をリセット",
    resetTitle: "音声設定をリセットしますか？",
    resetDescription:
      "TTSをオフ、速度を1.00倍、ミュートを解除した安全な初期値へ戻します。",
    resetConfirm: "リセット",
    resetCancel: "キャンセル",
    test: "音声をテスト",
    cancelTest: "テストを停止",
    testSample:
      "これはローカル音声のテストです。字幕は音声より先に表示されます。",
    testCaption: "テスト字幕",
    loading: "音声設定を読み込んでいます…",
    unavailable: "ローカル音声を利用できません",
    unavailableDescription:
      "字幕は引き続き利用できます。再読み込み後も失敗する場合は診断を確認してください。",
    retry: "再読み込み",
    retryVoices: "音声を再取得",
    errorTitle: "音声設定を更新できませんでした",
    activePresentation: "表示中のコミット説明",
    noPresentation: "表示中のコミット説明はありません",
    status: "字幕",
    speech: "音声",
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
    description:
      "Captions are the source of truth. Optional speech stays on this Mac and never sends narration or explanations over the network.",
    localOnly: "Local only · macOS",
    sourceLabel: "Commit explanation source",
    sourceValue: "App-generated · commit explanation",
    sourceDescription:
      "Main-session and sub-agent output is never narrated. Explanations appear only after “Tell me more.”",
    enable: "Enable TTS",
    enableDescription:
      "Off by default. Only the fixed /usr/bin/say adapter is used.",
    mute: "Mute",
    muteDescription: "Stops current speech while keeping captions visible.",
    voice: "Voice",
    voiceDescription:
      "An installed voice matching the current display language.",
    noVoice: "No compatible voice available",
    rate: "Speech rate",
    rateDescription: "0.75–1.25× (135–225 words/minute)",
    save: "Save audio settings",
    discard: "Discard changes",
    reset: "Reset audio settings",
    resetTitle: "Reset audio settings?",
    resetDescription:
      "Returns to the safe defaults: TTS off, 1.00× rate, and unmuted.",
    resetConfirm: "Reset",
    resetCancel: "Cancel",
    test: "Test voice",
    cancelTest: "Stop test",
    testSample:
      "This is a local speech test. The caption appears before the audio starts.",
    testCaption: "Test caption",
    loading: "Loading audio settings…",
    unavailable: "Local speech is unavailable",
    unavailableDescription:
      "Captions remain available. If retrying still fails, check Diagnostics.",
    retry: "Retry",
    retryVoices: "Retry voices",
    errorTitle: "Audio settings could not be updated",
    activePresentation: "Active commit explanation",
    noPresentation: "No commit explanation is being presented",
    status: "Caption",
    speech: "Speech",
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
