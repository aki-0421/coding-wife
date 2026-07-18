---
title: "macOS release packagingとFinder非依存DMG調査"
description: "Tauriの.app生成とhdiutilのread-only DMG生成を分離し、Finder AppleEventに依存しないハッカソン配布物の契約を整理する。"
updated: 2026-07-18
read_when:
  - "macOSの.app・DMG生成、Tauri bundle target、release commandを変更するとき。"
  - "Finder AppleScript timeout、Gatekeeper、未署名・未公証artifactの検証手順を確認するとき。"
last_verified: 2026-07-18 JST
---

# macOS release packagingとFinder非依存DMG調査

## 結論

Build Week MVPのrelease pathは、Tauri CLIの責務を`.app`生成までに限定し、DMGはrepository-owned scriptがmacOS標準の`ditto`と`hdiutil`で生成する。Finder、AppleScript、`osascript`は起動しない。

DMGは`.app`と`/Applications`へのsymlinkだけを持つ。一時出力をcompressed read-only imageへ変換し、`-readonly -nobrowse -noautoopen`でmountしてcontentsとwrite rejectionを検証した後だけfinal pathへ置く。これによりFinder AppleEvent timeoutをCI/releaseの成否から外す。

## 確認した一次情報

### Tauri v2

Tauri公式の[DMG配布ガイド](https://v2.tauri.app/distribute/dmg/)は、DMGをApp BundleとApplications folderを持つmacOSの一般的なインストーラとして説明している。ページが扱うwindow size、background、icon positionはFinderで見せるlayoutのcustomizationであり、artifactの完全性に必須ではない。

リポジトリに固定したTauri CLI 2.11.4の`tauri build --help`も`--bundles app` / `--bundles dmg`を別targetとして公開している。したがって`.app`だけをTauriでbundleし、DMG生成を明示手順へ分離できる。

### macOS `hdiutil`

macOS 14+のlocal `hdiutil(1)`は、`create -srcfolder`がsource directoryのcontentsを新しいfilesystem imageへcopyすること、`attach -readonly`がdeviceをread-onlyでattachすること、`-nobrowse`がFinder等からvolumeを隠すことを定義する。`-noautoopen`も利用し、release scriptの成否にGUI sessionを含めない。

### Gatekeeper

Apple公式の[Safely open apps on your Mac](https://support.apple.com/en-us/102445)（Published May 27, 2026）は、署名・公証されていないsoftwareがcomputerとpersonal informationを危険にさらす可能性を明記する。信頼でき改変されていないと判断したappだけを、一度openを試した後にSystem SettingsのPrivacy & SecurityからOpen Anywayで一時例外にできる。

## 実装契約

1. `tauri.conf.json` のdefault bundle targetは`app`だけにする。
2. `pnpm release:macos:app` がTauriの`.app`生成を担う。
3. `pnpm release:macos:dmg` が検証済み`.app`からDMGを作る。
4. DMG scriptは入力、出力、volume name、overwrite意図を引数で確定し、shell文字列連結を使わない。
5. candidateはread-only mount後にroot entry、Applications symlink target、`.app/Contents/Info.plist`、write rejectionを検証する。
6. `--overwrite`は既存artifactの即時削除を意味しない。candidate検証後の置換だけを許可する。
7. raw command stderr、input/output/tempのabsolute pathはconsoleへ返さない。失敗はstep単位のsafe codeと非0 exitで表す。
8. trapはattached volumeを先にdetachし、一時directoryを後に削除する。cleanup失敗時もfinal artifactを公開しない。

## 配布境界

ハッカソンMVPのDMGは、local buildを審査者が再現するための未署名・未公証artifactである。DMGがmountできることはDeveloper ID署名、notarization、staplingを証明しない。

審査者には、sourceとcommitを確認してlocal buildする経路を優先し、未署名artifactを開く場合のsecurity trade-offとApple公式のOpen Anyway手順を[testing instructions](../testing.md)に明記する。`xattr`によるquarantineの一括削除は案内しない。外部配布を開始する場合は、署名・公証・staplingを独立したrelease gateとして追加する。

## 検証

- Synthetic tiny `.app`でDMG生成、read-only attach、2 root entries、Applications symlink、Info.plist、write rejection、detach、cleanupを自動testする。
- missing/invalid app、invalid argument、existing output、explicit overwrite、redacted errorを自動testする。
- 既存real `.app`がある場合は再buildせず同じscriptでDMG smokeを行う。
- 署名・公証、別MacのGatekeeper、初回起動はsynthetic DMG testの対象外とし、release evidenceで別に確認する。
