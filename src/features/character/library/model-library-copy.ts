import type { SupportedLocale } from "@/features/localization"

const en = {
  title: "Character models",
  description:
    "Choose the Live2D model shared by every workspace in this project. Imported model assets stay inside the app's private library.",
  importModel: "Import model",
  importUnavailable: "Model import is available in the desktop app.",
  loading: "Loading character models",
  loadFailed: "Character models could not be loaded.",
  retry: "Retry",
  selected: "In use",
  bundled: "Bundled",
  imported: "Imported",
  selectModel: "Character model",
  textures: "textures",
  motions: "motions",
  expressions: "expressions",
  files: "files",
  manifestHash: "Manifest",
  trustedFrameHash: "Trusted frame",
  thumbnailLoading: "Loading verified model thumbnail",
  usedByProjects: "Used by {count} project(s)",
  importedAt: "Imported {date}",
  delete: "Delete",
  deleteTitle: "Delete this character model?",
  deleteDescription:
    "The model will be removed from the private app library. Source files beside the selected .model3.json are not changed.",
  cancel: "Cancel",
  deleteConfirm: "Delete model",
  deleting: "Deleting…",
  switching: "Switching model…",
  fallbackTitle: "The bundled model was restored",
  fallbackDescription:
    "The previous model was unavailable, so this project safely fell back to Hiyori.",
  importTitle: "Review imported model",
  importDescription:
    "The selected .model3.json and its referenced local assets are copied to quarantine first. They are published only after an isolated preview renders successfully and you confirm the name.",
  previewLabel: "Isolated Live2D preview",
  preparing: "Checking model files…",
  starting: "Starting isolated renderer…",
  rendering: "Verifying a visible frame…",
  verified: "Preview verified",
  previewFailed: "The isolated preview could not verify this model.",
  retryPreview: "Retry preview",
  displayName: "Model name",
  displayNameDescription: "Enter 1–80 characters before importing.",
  confirmImport: "Import and use model",
  confirming: "Importing…",
  canceling: "Canceling…",
  operationFailed: "The model operation did not complete.",
  privateLibrary: "Private app library",
}

const ja: typeof en = {
  title: "キャラクターモデル",
  description:
    "このプロジェクトの全ワークスペースで共有するLive2Dモデルを選びます。取り込んだモデル素材はアプリ専用ライブラリ内に保存されます。",
  importModel: "モデルを取り込む",
  importUnavailable: "モデルの取り込みはデスクトップアプリで利用できます。",
  loading: "キャラクターモデルを読み込み中",
  loadFailed: "キャラクターモデルを読み込めませんでした。",
  retry: "再試行",
  selected: "使用中",
  bundled: "同梱",
  imported: "取り込み済み",
  selectModel: "キャラクターモデル",
  textures: "テクスチャ",
  motions: "モーション",
  expressions: "表情",
  files: "ファイル",
  manifestHash: "マニフェスト",
  trustedFrameHash: "信頼済みフレーム",
  thumbnailLoading: "検証済みモデル画像を読み込み中",
  usedByProjects: "{count}個のプロジェクトで使用中",
  importedAt: "{date}に取り込み",
  delete: "削除",
  deleteTitle: "このキャラクターモデルを削除しますか？",
  deleteDescription:
    "アプリ専用ライブラリからモデルを削除します。選択した.model3.jsonと同じ場所にある取り込み元ファイルは変更しません。",
  cancel: "キャンセル",
  deleteConfirm: "モデルを削除",
  deleting: "削除中…",
  switching: "モデルを切り替え中…",
  fallbackTitle: "同梱モデルへ戻しました",
  fallbackDescription:
    "以前のモデルを利用できなかったため、このプロジェクトは安全にHiyoriへ戻りました。",
  importTitle: "取り込むモデルを確認",
  importDescription:
    "選択した.model3.jsonと参照先のローカル素材は最初に隔離領域へコピーされます。分離プレビューで正常描画を確認し、名前を確定するまで公開しません。",
  previewLabel: "分離Live2Dプレビュー",
  preparing: "モデルファイルを確認中…",
  starting: "分離レンダラーを起動中…",
  rendering: "表示フレームを検証中…",
  verified: "プレビュー検証済み",
  previewFailed: "分離プレビューでこのモデルを検証できませんでした。",
  retryPreview: "プレビューを再試行",
  displayName: "モデル名",
  displayNameDescription: "取り込み前に1〜80文字で入力してください。",
  confirmImport: "取り込んで使用",
  confirming: "取り込み中…",
  canceling: "キャンセル中…",
  operationFailed: "モデル操作を完了できませんでした。",
  privateLibrary: "アプリ専用ライブラリ",
}

export type CharacterModelLibraryCopy = typeof en

export function getCharacterModelLibraryCopy(
  locale: SupportedLocale,
): CharacterModelLibraryCopy {
  return locale === "ja" ? ja : en
}
