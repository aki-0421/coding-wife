---
title: "GitHub Release macOS無料配布仕様"
description: "ad-hoc署名したApple Silicon DMGをGitHub Actionsで無料生成し、SHA-256付きdraft Releaseへ配置する契約を定義する。"
updated: 2026-07-21
read_when:
  - "macOS配布workflow、Tauri bundle target、ad-hoc署名、またはGitHub Releaseを変更するとき。"
  - "release tag、Gatekeeper案内、公開前install smokeの運用を確認するとき。"
last_verified: 2026-07-21 JST
---

# GitHub Release macOS無料配布仕様

## 目的

利用者がsource buildを行わず、GitHub ReleaseからDMGを取得して標準のdrag-to-Applications操作でCoding Wifeをインストールできる無料配布経路を用意する。

この経路はmacOS 14以降のApple Siliconだけを対象とする。Windows、Linux、Intel Mac、universal binary、Mac App Store、自動更新は対象外とし、対応済みと表示しない。

## 無料配布の制約

Apple Developer Programの有料membership、Developer ID Application certificate、Apple公証は使用しない。Apple Siliconが要求するcode sealはad-hoc identityで行うため、resource改変は検出できるが配布者identityは証明できない。

Tauri公式が明記するとおり、ad-hoc署名はmacOSの初回起動時に利用者がPrivacy & Securityから明示許可する操作を不要にはしない。したがって「DMGを開いてApplicationsへcopyする」までは標準GUIだけで完了するが、download後の初回launchではGatekeeperの**Open Anyway**が必要になり得る。無料配布と、Gatekeeper例外が一切不要な初回起動を同時に達成したとは表示しない。

## 正本と責務境界

- `.github/workflows/release.yml`を外部配布用workflowの正本とする。
- `pnpm release:macos`を配布candidate生成・検証commandの正本とする。
- リポジトリに固定した`@tauri-apps/cli`は`aarch64-apple-darwin`向けproduction `.app`だけをbundleする。
- repository-owned release scriptがnested executable codeからapp rootの順にad-hoc sealし、development artifact、固定依存NOTICE、resource inventory、architecture、minimum OS、bundle metadataを検証する。
- repository-owned DMG scriptが検証済みappと`/Applications` symlinkだけを持つread-only DMGをFinder・AppleScriptなしで作り、独立mountとexact byte snapshotを検証する。
- workflowは検証済みDMGのSHA-256を生成し、DMGとchecksumだけをGitHub draft Releaseへuploadする。
- 通常の`.github/workflows/ci.yml`はPR検証のread-only workflowとして維持し、write tokenやrelease作成を扱わない。

## Triggerとversion契約

| 項目 | 仕様 |
|---|---|
| Trigger | `v*` tagのpush |
| Release source | tag commitが`origin/develop`のancestorであること |
| Version | tagが`v<version>`であり、`src-tauri/tauri.conf.json`、root `package.json`、`src-tauri/Cargo.toml`のversionと一致すること |
| Runner | GitHub標準`macos-14` Apple Silicon runner |
| Target | `aarch64-apple-darwin` |
| Concurrency | tagごとに1実行、進行中releaseを自動cancelしない |
| Permission | workflow-level `contents: read`、release jobだけ`contents: write` |
| Release visibility | draft。workflowからpublic releaseへ変更しない |

tag不一致、`develop`外commit、既存のpublic release、依存準備、build、seal、DMG生成、mount、inventory、SHA-256のいずれかの失敗ではartifactをuploadしない。draftへの再実行だけは、同じtagの既存assetを検証済み同名assetで置換できる。

## Build・検証順序

1. Full historyをcredential永続化なしでcheckoutし、tag/version/develop ancestryを検証する。
2. Node.js `22.12.0`、pnpm `10.12.2`、`rust-toolchain.toml`、両lockfileから依存を準備する。
3. Apple Silicon targetのlocked Cargo dependencyをfetchする。
4. `pnpm release:macos`を実行し、production `.app`、ad-hoc seal、Finder非依存DMG、2回のcandidate mount、canonical snapshot verificationを完走する。
5. canonical DMGをtagを含む安定名へcopyし、そのexact byte列のSHA-256 sidecarを作る。
6. 同じtagのdraft Releaseを作成または更新し、DMGとSHA-256 sidecarだけをuploadする。

Tauri公式はGitHub上のbuild・uploadに`tauri-action`を利用できるとしているが、このリポジトリでは既存のresource inventory、private-path hygiene、rollback、複数mount検証をupload前に必須とする。このため固定済みproject CLIとrepository-owned release scriptを直接実行し、最後のGitHub Release操作だけを分離する。未検証bundleを先にrelease assetへ置かない。

## Artifact契約

| 項目 | 仕様 |
|---|---|
| DMG名 | `Coding-Wife-v<version>-macOS-arm64.dmg` |
| Checksum名 | DMG名に`.sha256`を付加 |
| DMG内容 | `Coding Wife.app`と`/Applications` symlink |
| App identifier | `app.codingwife.desktop` |
| Minimum OS | macOS 14.0 |
| Architecture | arm64 |
| Signature | ad-hoc。Developer ID identityなし |
| Notarization | なし。stapled ticketなし |
| Release | 同一version tagのdraft GitHub Release |

automatic updater用signatureや`latest.json`は生成しない。checksumはdownload時のbyte比較用であり、Developer ID署名、公証、GitHub provenanceの代替ではない。

## ライセンス境界

root `LICENSE`はCoding Wife contributorsが保有する独自コードをMIT Licenseで利用・再配布可能にする。third-party dependency、Live2D Cubism SDK、Hiyori modelなど、リポジトリ内で別のNOTICE、terms、licenseを持つ素材にはそれぞれの条件が優先して適用される。配布物は生成済み第三者依存台帳と既存の原文NOTICE・termsを保持する。

## 公開前の手動gate

workflow成功は公開可能なdraftを作るが、次を自動で証明しない。

- GitHub Release pageの説明、macOS 14+ Apple Silicon限定、Codex prerequisite、ad-hoc署名・未公証状態の確認
- draft assetをclean locationへdownloadした後のSHA-256一致
- fresh-profileまたは別のApple Silicon Macで、DMG open、Applicationsへのcopy、Gatekeeperのbounded Open Anyway、初回launchを完走するinstall smoke
- Hiyori、Codex preflight、primary turn、commit review、終了・再起動のinstalled artifact smoke
- third-party noticeと配布権利の最終確認

これらを記録するまでdraftをpublicへ変更しない。workflowはpublic releaseのassetを`--clobber`せず、公開後のbyte変更は新version tagで行う。

## 受け入れ条件

- 通常CIは従来どおりread-onlyである。
- `develop`上の一致するversion tagだけがrelease jobへ進む。
- workflowはApple certificate、notarization credential、application API keyを必要としない。
- `pnpm release:macos`がApple Silicon app、ad-hoc seal、DMG、inventory、read-only mount、canonical SHA-256 verificationを完走する。
- GitHubへは検証済みDMGと、そのexact byte列のSHA-256だけがdraft assetとしてuploadされる。
- 失敗時はpublic releaseを作らず、partial artifactやmountを残さない。
- 利用者向け手順がOpen Anywayを限定的に案内し、Gatekeeper無効化やquarantine一括削除を案内しない。
- 公開前install smoke完了後、利用者がsource buildなしで標準のDMG導線からインストールできる。

## 公式一次資料

- [Tauri: Distribute](https://v2.tauri.app/distribute/)
- [Tauri: macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri: GitHub Actions pipeline](https://v2.tauri.app/distribute/pipelines/github/)
- [Apple: Safely open apps on your Mac](https://support.apple.com/en-us/102445)
- [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
