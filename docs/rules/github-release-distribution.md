---
title: "GitHub Release 無料マルチプラットフォーム配布仕様"
description: "macOS、Windows、Linuxのinstallerを無料runnerで検証し、一つのdraft GitHub Releaseへ集約する契約を定義する。"
updated: 2026-07-21
last_verified: 2026-07-21
read_when:
  - "version tagからdesktop installerをbuildまたは公開するとき。"
  - "署名なし配布のOS警告と利用者向け手順を変更するとき。"
  - "release workflow、artifact名、installer smokeを変更するとき。"
---

# GitHub Release 無料マルチプラットフォーム配布仕様

## 目的

利用者がsource buildを行わず、GitHub Releaseから各OSのartifactを取得し、標準GUIまたは配布形式の通常操作でCoding Wifeを導入できる無料配布経路を用意する。

初回対象はmacOS 14以降のApple Silicon、Windows 11 x64、Ubuntu 22.04 / Debian 12相当のLinux x64とする。Intel Mac、Windows Arm、Linux Arm、Mac App Store、Microsoft Store、Linux repository、自動更新は対象外であり、対応済みと表示しない。

## Artifact境界

| Platform | Runner | 配布物 | 導入検証 |
|---|---|---|---|
| macOS | standard `macos-14` arm64 | ad-hoc signed、未公証DMG | `.app` seal、2回のread-only mount、inventory一致 |
| Windows | standard `windows-2025` x64 | unsigned NSIS current-user setup `.exe` | runner tempへのsilent install、実行file/legal resource、silent uninstall |
| Linux | standard `ubuntu-22.04` x64 | `.deb`とAppImage | `apt` install/remove、AppImage extract、実行file/legal resource |

WindowsではTauri公式のNSIS setupを使う。current-user installを正本とし、通常は管理者権限を要求しない。MSIはWiXとWindows optional featureに依存し、同じ用途のinstallerを重複させるため初回releaseには含めない。

Linuxでは`.deb`をUbuntu/Debian系のclick-install用artifactとし、AppImageをdistribution package managerに依存しないportable fallbackとする。AppImageはinstall形式ではなく、download後に実行bitが必要である。glibc互換性を広げるためTauri公式が適切なbaseline例とするUbuntu 22.04でbuildする。

## 無料配布と署名の制約

Apple Developer Program、Developer ID、Apple notarization、Windows code-signing certificate、GPG private keyを要求しない。

- macOSはApple Siliconに必要なresource sealをad-hoc identityで行う。配布者identityとnotarizationは証明できず、初回launchでPrivacy & Securityの**Open Anyway**が必要になり得る。
- Windows setupはunsignedであり、download時または初回実行時にMicrosoft Defender SmartScreenが警告し得る。利用者には対象releaseとSHA-256を確認した上で**More info > Run anyway**を選ぶ限定手順だけを案内する。
- Linux package signingは配布必須ではないため未署名で配布する。SHA-256はdownload破損の検出に使えるが、配布者署名の代替ではない。

GitHub公式ではpublic repositoryのstandard GitHub-hosted runnerはActions実行料金が無料である。larger runner、self-hosted paid infrastructure、外部配布serviceを要求しない。private repositoryへ変更した場合はincluded minutesとstorage quotaの対象になるため、「無条件に無料」とは扱わない。

## Codex prerequisite

production conversationには対応OSへinstall済みで認証済みのCodex CLIが必要である。OpenAI公式はmacOS/Linux用standalone installerとWindows PowerShell用standalone installerを提供し、Codex sandboxをmacOS、Linux/WSL2、native Windowsで説明している。Coding Wifeは各OSのlocal `codex app-server --listen stdio://`を起動し、CLI自体や認証credentialをbundleしない。`app-server`は公式上experimentalであるため、protocol probeとfail-closed診断を維持する。

## Workflow責務境界

- `.github/workflows/release.yml`を外部配布workflowの正本とする。
- workflow-level permissionは`contents: read`とし、各platform build jobはrepository write tokenを持たない。
- platform jobは同じtag/version/develop ancestryを検証し、locked dependency、production frontend、native bundleを固定runnerで生成する。
- macOS jobは既存の`pnpm test:release`と`pnpm release:macos`を正本とする。
- Windows/Linux jobはTauri CLIのnative bundleを生成し、installer/packageをrunner上で導入・除去してから安定名とSHA-256をstageする。
- platform間の受け渡しはretention 1日のGitHub Actions artifactだけを使う。
- 全platform job成功後にだけpublish jobへ`contents: write`を与え、artifact名、件数、SHA-256を再検証してdraft Releaseを作成または更新する。
- 通常の`.github/workflows/ci.yml`はread-onlyを維持し、release作成を扱わない。

いずれかのbuild、package、install、uninstall、resource、checksum検証が失敗した場合、publish jobは実行しない。workflow artifactはpublic配布物ではなく1日で失効する。同じtagの既存public releaseは変更せず、修正は新しいpatch versionで行う。

## Triggerとversion契約

| 項目 | 仕様 |
|---|---|
| Trigger | `v*` tagのpush |
| Release source | tag commitが`origin/develop`のancestor |
| Version | tag、`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`が一致 |
| Architectures | macOS arm64、Windows x64、Linux x64 |
| Concurrency | tagごとに1実行、進行中releaseを自動cancelしない |
| Release visibility | 全job成功後にdraft。workflowからpublicへ変更しない |

## 公開asset契約

```text
Coding-Wife-v<version>-macOS-arm64.dmg
Coding-Wife-v<version>-macOS-arm64.dmg.sha256
Coding-Wife-v<version>-Windows-x64-setup.exe
Coding-Wife-v<version>-Windows-x64-setup.exe.sha256
Coding-Wife-v<version>-Linux-x64.deb
Coding-Wife-v<version>-Linux-x64.deb.sha256
Coding-Wife-v<version>-Linux-x64.AppImage
Coding-Wife-v<version>-Linux-x64.AppImage.sha256
```

automatic updater signatureと`latest.json`は生成しない。root `LICENSE`はproject-owned codeのMIT再配布条件を定め、`pnpm licenses:generate`はrootとbyte一致する`CODING-WIFE-LICENSE.txt`を第三者通知と同じlegal resource treeへ同期する。全platform bundleはproject license、依存台帳、Live2D/Hiyoriの原文NOTICE・termsを保持する。

macOS jobは正本であるApple Silicon依存graphを再計算して`pnpm licenses:check`を通す。Windows/Linux jobはhost固有の依存解決を正本へ混ぜず、`pnpm licenses:check:packaged`でcommitted inventoryのlock hash、license policy summary、packaged legal treeのbyte一致を検証してからbundleする。Windows checkoutのCRLFも同じlock parserで受理する。

## 公開前gate

workflow成功後、draftから全8assetをclean locationへdownloadし、4つのSHA-256を検証する。release本文で対象OS/architecture、Codex prerequisite、各署名警告を日英で確認する。macOS DMG mount/copy、Windows NSIS install/uninstall、Linux `.deb` install/removeはCIでも検証し、可能なplatformではdownload後artifactでも再確認する。

利用者向け手順はGatekeeperやSmartScreenを全体無効化する案内を行わず、対象artifactだけのbounded overrideを案内する。draft確認後に手動でpublicへ変更する。公開後のbyte変更は同tagで行わず、新しいversion tagを使う。

## 受け入れ条件

- `develop`上の一致するversion tagだけがrelease jobへ進む。
- 3 OSのbuild jobが独立したstandard runnerで成功し、installer/package smokeを完走する。
- publish jobは全8assetのexact name、重複・欠落、SHA-256を再検証して一つのdraftへuploadする。
- certificate、notarization credential、application API keyをworkflow secretとして要求しない。
- 失敗時はpublic releaseを作らず、修正時に失敗tagを移動しない。
- 利用者がsource buildなしで、対象OSの標準導線からアプリを導入できる。

## 公式一次資料

- [Tauri: Distribute](https://v2.tauri.app/distribute/)
- [Tauri: Windows Installer](https://v2.tauri.app/distribute/windows-installer/)
- [Tauri: AppImage](https://v2.tauri.app/distribute/appimage/)
- [Tauri: Linux Code Signing](https://v2.tauri.app/distribute/sign/linux/)
- [Tauri: macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri: Prerequisites](https://v2.tauri.app/start/prerequisites/)
- [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [OpenAI Codex sandbox](https://learn.chatgpt.com/docs/sandboxing)
- [OpenAI Codex command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
