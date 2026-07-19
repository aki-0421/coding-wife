import type { SupportedLocale } from "@/features/localization"

const en = {
  title: "Semantic state mapping",
  description:
    "Choose a verified motion or expression for each companion state. Unassigned or invalid mappings stay neutral.",
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
  preview: "Preview",
  previewTitle: "Cue preview",
  staticPreview: "Static preview — motion is reduced",
  animatedPreview: "Animated preview on the companion stage",
  save: "Save mapping",
  saving: "Saving…",
  saved: "Mapping saved",
  reset: "Reset to neutral",
  invalidTitle: "The saved mapping is no longer valid",
  invalidDescription:
    "Its manifest or cue inventory changed. The entire mapping is neutral until you save a replacement.",
  version: "Version {version}",
}

const ja: typeof en = {
  title: "セマンティック状態マッピング",
  description:
    "各コンパニオン状態に、検証済みのモーションまたは表情を割り当てます。未割り当てや無効なマッピングはニュートラルになります。",
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
  preview: "プレビュー",
  previewTitle: "Cueプレビュー",
  staticPreview: "静的プレビュー — モーションを抑制中",
  animatedPreview: "コンパニオン表示でアニメーションをプレビュー中",
  save: "マッピングを保存",
  saving: "保存中…",
  saved: "マッピングを保存しました",
  reset: "ニュートラルへ戻す",
  invalidTitle: "保存済みマッピングを利用できません",
  invalidDescription:
    "マニフェストまたはCue一覧が変更されました。代替を保存するまで全状態をニュートラルとして扱います。",
  version: "バージョン {version}",
}

export type SemanticMappingCopy = typeof en

export function getSemanticMappingCopy(
  locale: SupportedLocale,
): SemanticMappingCopy {
  return locale === "ja" ? ja : en
}
