import type { SupportedLocale } from "@/features/localization"

const en = {
  title: "Motion settings",
  description: "Choose how this character moves in each app state.",
  bundledDescription:
    "Hiyori uses a motion preset designed for the bundled model.",
  inactiveDescription:
    'Choose "Use this character" to edit its motion settings.',
  presetLocked: "Preset — cannot be edited",
  neutral: "Neutral",
  thinking: "Thinking",
  working: "Working",
  asking: "Asking",
  success: "Success",
  warning: "Warning",
  error: "Error",
  neutralCue: "Neutral pose",
  motionGroup: "Motions",
  expressionGroup: "Expressions",
  presetMotions: {
    neutral: "Natural idle",
    thinking: "Thinking",
    working: "Working",
    asking: "Asking",
    success: "Success",
    warning: "Warning",
    error: "Error",
  },
  save: "Save settings",
  saving: "Saving…",
  saved: "Motion settings saved",
  reset: "Reset to neutral",
  invalidTitle: "The saved motion settings are no longer valid",
  invalidDescription:
    "The model's available motions changed. All states stay neutral until you save replacement settings.",
}

const ja: typeof en = {
  title: "モーション設定",
  description: "アプリの状態ごとに、このキャラクターの動きを設定します。",
  bundledDescription:
    "桃瀬ひよりには、同梱モデル向けに調整したモーションを設定済みです。",
  inactiveDescription:
    "「このキャラクターを使う」を選ぶと、モーション設定を編集できます。",
  presetLocked: "プリセット・編集不可",
  neutral: "ニュートラル",
  thinking: "思考中",
  working: "作業中",
  asking: "確認待ち",
  success: "成功",
  warning: "警告",
  error: "エラー",
  neutralCue: "ニュートラルポーズ",
  motionGroup: "モーション",
  expressionGroup: "表情",
  presetMotions: {
    neutral: "自然な待機",
    thinking: "考え中",
    working: "作業中",
    asking: "確認待ち",
    success: "成功",
    warning: "警告",
    error: "エラー",
  },
  save: "設定を保存",
  saving: "保存中…",
  saved: "モーション設定を保存しました",
  reset: "ニュートラルへ戻す",
  invalidTitle: "保存済みのモーション設定を利用できません",
  invalidDescription:
    "モデルで利用できるモーションが変更されました。代替設定を保存するまで、すべての状態をニュートラルとして扱います。",
}

export type SemanticMappingCopy = typeof en

export function getSemanticMappingCopy(
  locale: SupportedLocale,
): SemanticMappingCopy {
  return locale === "ja" ? ja : en
}
