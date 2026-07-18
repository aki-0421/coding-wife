import type { SupportedLocale } from "@/features/localization"
import type {
  CharacterControllerStatus,
  CharacterErrorCode,
  CharacterState,
} from "@/features/character/model"

interface CharacterCopy {
  readonly state: Readonly<Record<CharacterState, string>>
  readonly loading: string
  readonly recovering: string
  readonly hidden: string
  readonly staticFallback: string
  readonly textFallback: string
  readonly errors: Readonly<Record<CharacterErrorCode, string>>
}

const characterCopy: Readonly<Record<SupportedLocale, CharacterCopy>> = {
  ja: {
    state: {
      idle: "待機中です",
      thinking: "考えています",
      acting: "作業しています",
      waiting_for_user: "確認が必要です",
      reviewing: "変更を確認しています",
      error: "問題が発生しました",
      completed: "作業が完了しました",
      disconnected: "接続が切れています",
    },
    loading: "キャラクターを準備しています",
    recovering: "描画を復旧しています",
    hidden: "キャラクター表示はオフです",
    staticFallback: "静止画で表示しています。作業は継続できます。",
    textFallback: "キャラクターを表示できません。作業は継続できます。",
    errors: {
      core_load_failed: "Live2Dの描画機能を読み込めませんでした。",
      core_version_mismatch: "Live2Dの描画機能を確認できませんでした。",
      framework_initialize_failed: "Live2Dを初期化できませんでした。",
      manifest_invalid: "キャラクターデータを確認できませんでした。",
      asset_not_allowed: "許可されていないキャラクターデータです。",
      asset_fetch_failed: "キャラクターデータを読み込めませんでした。",
      asset_type_mismatch: "キャラクターデータの形式を確認できませんでした。",
      moc_invalid: "Live2Dモデルを確認できませんでした。",
      model_inventory_mismatch: "Live2Dモデルの構成を確認できませんでした。",
      texture_decode_failed: "キャラクター画像を読み込めませんでした。",
      webgl_unavailable: "この環境ではLive2Dを描画できません。",
      shader_load_failed: "Live2Dの描画を開始できませんでした。",
      context_lost: "Live2Dの描画が一時停止しました。",
      context_restore_failed: "Live2Dの描画を復旧できませんでした。",
      disposed: "Live2Dの描画を終了しました。",
    },
  },
  en: {
    state: {
      idle: "Standing by",
      thinking: "Thinking",
      acting: "Working",
      waiting_for_user: "Your input is needed",
      reviewing: "Reviewing changes",
      error: "Something went wrong",
      completed: "Work completed",
      disconnected: "Disconnected",
    },
    loading: "Preparing the character",
    recovering: "Restoring the renderer",
    hidden: "Character display is off",
    staticFallback: "Showing a still preview. Work can continue.",
    textFallback: "The character is unavailable. Work can continue.",
    errors: {
      core_load_failed: "The Live2D renderer could not be loaded.",
      core_version_mismatch: "The Live2D renderer could not be verified.",
      framework_initialize_failed: "Live2D could not be initialized.",
      manifest_invalid: "The character data could not be verified.",
      asset_not_allowed: "This character data is not allowed.",
      asset_fetch_failed: "The character data could not be loaded.",
      asset_type_mismatch: "The character data format could not be verified.",
      moc_invalid: "The Live2D model could not be verified.",
      model_inventory_mismatch:
        "The Live2D model inventory could not be verified.",
      texture_decode_failed: "The character textures could not be loaded.",
      webgl_unavailable: "Live2D cannot be rendered in this environment.",
      shader_load_failed: "Live2D rendering could not start.",
      context_lost: "Live2D rendering was interrupted.",
      context_restore_failed: "Live2D rendering could not be restored.",
      disposed: "Live2D rendering has stopped.",
    },
  },
}

export function getCharacterCaption(
  locale: SupportedLocale,
  status: CharacterControllerStatus,
): Readonly<{ state: string; detail: string | null }> {
  const copy = characterCopy[locale]
  const state = copy.state[status.state]

  if (status.motionPolicy === "hidden") {
    return { state, detail: copy.hidden }
  }
  if (status.phase === "loading") {
    return { state, detail: copy.loading }
  }
  if (status.phase === "recovering") {
    return { state, detail: copy.recovering }
  }
  if (status.error !== null) {
    const fallback =
      status.fallbackLevel === "static"
        ? copy.staticFallback
        : copy.textFallback
    return {
      state,
      detail: `${copy.errors[status.error.code]} ${fallback}`,
    }
  }
  if (status.motionPolicy === "reduced") {
    return {
      state,
      detail:
        status.fallbackLevel === "static"
          ? copy.staticFallback
          : copy.textFallback,
    }
  }
  return { state, detail: null }
}

export function getCharacterErrorMessage(
  locale: SupportedLocale,
  code: CharacterErrorCode,
): string {
  return characterCopy[locale].errors[code]
}
