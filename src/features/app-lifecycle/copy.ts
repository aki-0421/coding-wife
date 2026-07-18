import type { SupportedLocale } from "@/features/localization"

export interface SafeQuitCopy {
  readonly title: string
  readonly description: string
  readonly dontQuit: string
  readonly stopAndQuit: string
  readonly stopping: string
  readonly canceling: string
  readonly stopFailed: string
  readonly cancelFailed: string
}

const copy: Readonly<Record<SupportedLocale, SafeQuitCopy>> = {
  en: {
    title: "Stop the active turn and quit?",
    description:
      "Coding Wife will wait for the current turn to stop and save its local history before quitting.",
    dontQuit: "Don’t Quit",
    stopAndQuit: "Stop and Quit",
    stopping: "Stopping and quitting…",
    canceling: "Keeping the app open…",
    stopFailed:
      "The active turn could not be stopped safely. Coding Wife is still open and the turn may still be running.",
    cancelFailed:
      "The quit request could not be canceled safely. This confirmation remains open; try again.",
  },
  ja: {
    title: "実行中のターンを停止して終了しますか？",
    description:
      "現在のターンが停止し、ローカル履歴の保存が完了するまで待ってから終了します。",
    dontQuit: "終了しない",
    stopAndQuit: "停止して終了",
    stopping: "停止して終了しています…",
    canceling: "アプリを開いたままにしています…",
    stopFailed:
      "実行中のターンを安全に停止できませんでした。アプリは開いたままで、ターンがまだ実行中の可能性があります。",
    cancelFailed:
      "終了要求を安全に取り消せませんでした。この確認画面を開いたまま、もう一度お試しください。",
  },
}

export function getSafeQuitCopy(locale: SupportedLocale): SafeQuitCopy {
  return copy[locale]
}
