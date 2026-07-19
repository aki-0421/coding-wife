import type { SupportedLocale } from "@/features/localization"

const en = {
  title: "Character models",
  description:
    "Choose the bundled Live2D model or one private custom model shared by every workspace in this project.",
  importModel: "Import custom model",
  replaceModel: "Replace custom model",
  importUnavailable: "Model import is available in the desktop app.",
  loading: "Loading character models",
  loadFailed: "Character models could not be loaded.",
  retry: "Retry",
  selected: "In use",
  bundled: "Bundled",
  bundledProtected:
    "The bundled model is always available and cannot be deleted.",
  imported: "Imported",
  customSlot: "1 custom model slot",
  customSlotAvailable: "Available",
  customSlotFilled: "Filled",
  noLicenseRequired: "No license information required",
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
    "The custom model will be removed from the private app library. Every project using it will return to bundled Hiyori. Source files beside the selected .model3.json are not changed.",
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
  replaceDescription:
    "The current custom model stays available while the replacement is checked. After a successful preview, every project using the old custom model moves to the replacement.",
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
  confirmReplace: "Replace and use model",
  confirming: "Importing…",
  canceling: "Canceling…",
  operationFailed: "The model operation did not complete.",
  privateLibrary: "Private app library",
  errorMessages: {
    selection: "Choose one regular Live2D .model3.json file.",
    missingAssets:
      "Some files referenced by the model are missing or unreadable. Keep the model and all referenced assets together, then try again.",
    unsupported:
      "This Live2D model format or MOC version is not supported by this app.",
    unsafe:
      "This model contains an external path, link, URL, or file type that cannot be imported safely.",
    limits:
      "This model is too large to process safely: more than 4,096 files, more than 100 MiB total, a file over 32 MiB, an oversized texture, or unusually deep JSON.",
    preview:
      "The isolated renderer could not verify a visible frame for this model. The current model is unchanged.",
    access:
      "The app could not read or privately copy the model files. Check file access and try again.",
    generic:
      "The current model is unchanged. Try again or choose a different .model3.json file.",
  },
}

const ja: typeof en = {
  title: "キャラクターモデル",
  description:
    "このプロジェクトの全ワークスペースで共有する同梱Live2Dモデル、または1件のカスタムモデルを選びます。",
  importModel: "カスタムモデルを取り込む",
  replaceModel: "カスタムモデルを置き換える",
  importUnavailable: "モデルの取り込みはデスクトップアプリで利用できます。",
  loading: "キャラクターモデルを読み込み中",
  loadFailed: "キャラクターモデルを読み込めませんでした。",
  retry: "再試行",
  selected: "使用中",
  bundled: "同梱",
  bundledProtected: "同梱モデルは常に利用でき、削除できません。",
  imported: "取り込み済み",
  customSlot: "カスタムモデル 1枠",
  customSlotAvailable: "空き",
  customSlotFilled: "使用中",
  noLicenseRequired: "ライセンス情報の入力不要",
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
    "カスタムモデルをアプリ専用ライブラリから削除します。使用中の全プロジェクトは同梱Hiyoriへ戻ります。選択した.model3.jsonと同じ場所にある取り込み元ファイルは変更しません。",
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
  replaceDescription:
    "置き換えるモデルの検証中も現在のカスタムモデルを維持します。プレビュー成功後、旧カスタムモデルを使用中の全プロジェクトを新モデルへ引き継ぎます。",
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
  confirmReplace: "置き換えて使用",
  confirming: "取り込み中…",
  canceling: "キャンセル中…",
  operationFailed: "モデル操作を完了できませんでした。",
  privateLibrary: "アプリ専用ライブラリ",
  errorMessages: {
    selection: "Live2Dの.model3.jsonファイルを1件選んでください。",
    missingAssets:
      "モデルが参照するファイルの一部が見つからないか、読み取れません。モデルと参照素材を同じフォルダ構成に置いて再試行してください。",
    unsupported:
      "このLive2Dモデル形式、またはMOCバージョンには対応していません。",
    unsafe:
      "外部パス、リンク、URL、または安全に取り込めないファイル形式がモデルに含まれています。",
    limits:
      "安全に処理できる範囲を超えています。4,096ファイル超、合計100MiB超、1ファイル32MiB超、過大なテクスチャ、または異常に深いJSONが含まれています。",
    preview:
      "分離レンダラーで表示フレームを確認できませんでした。現在のモデルは変更していません。",
    access:
      "モデルファイルを読み取るか、アプリ専用領域へコピーできませんでした。ファイルアクセスを確認して再試行してください。",
    generic:
      "現在のモデルは変更していません。再試行するか、別の.model3.jsonファイルを選んでください。",
  },
}

export type CharacterModelLibraryCopy = typeof en

export function getCharacterModelLibraryCopy(
  locale: SupportedLocale,
): CharacterModelLibraryCopy {
  return locale === "ja" ? ja : en
}
