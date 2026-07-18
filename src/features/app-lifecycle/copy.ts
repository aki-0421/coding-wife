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
  readonly cleanupTitle: string
  readonly cleanupDescription: string
  readonly cleanupFailed: string
  readonly retryCleanup: string
  readonly retryingCleanup: string
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
    cleanupTitle: "Coding Wife is still open",
    cleanupDescription:
      "A local process or history writer has not finished stopping. Coding Wife will not exit until every cleanup check passes.",
    cleanupFailed:
      "Safe cleanup did not finish. Retry after the current local operation has had time to settle.",
    retryCleanup: "Retry Safe Cleanup",
    retryingCleanup: "Retrying safe cleanup…",
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
    cleanupTitle: "Coding Wife は開いたままです",
    cleanupDescription:
      "ローカルプロセスまたは履歴 writer の停止が完了していません。すべての終了確認が成功するまでアプリは終了しません。",
    cleanupFailed:
      "安全な終了処理が完了しませんでした。現在のローカル処理が落ち着いてから再試行してください。",
    retryCleanup: "安全な終了処理を再試行",
    retryingCleanup: "安全な終了処理を再試行しています…",
  },
}

export function getSafeQuitCopy(locale: SupportedLocale): SafeQuitCopy {
  return copy[locale]
}
