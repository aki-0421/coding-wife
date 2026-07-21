---
title: "継続的インテグレーション仕様"
description: "developを保護するGitHub Actions CIのトリガー、必須ゲート、実行環境、再現性、権限、非対象を定義する。"
updated: 2026-07-21
read_when:
  - "GitHub Actions、ブランチ保護、またはリポジトリ品質ゲートを変更するとき。"
  - "CI失敗の検証範囲と担当jobを特定するとき。"
  - "macOSリリース検証と通常CIの責務境界を判断するとき。"
---

# 継続的インテグレーション仕様

## 目的

`develop`へ入るすべての変更について、レビュー時に実際に壊れ得るsource、test、contract、dependency inventoryを短時間で検証する。CIはmerge判断を支えるPR向け検証であり、リリース候補の完全検証や成果物公開の経路ではない。

## 正本と責務境界

- PR向けJavaScript test集合の正本は`pnpm test`とする。macOS固有かどうかを問わず、`pnpm test:release`配下のrelease testは呼び出さない。
- CIは`.github/workflows/ci.yml`に列挙したformat、documentation、frontend、native、dependency inventoryだけを固定依存のclean checkoutで実行する。
- 通常のローカル開発では、これらのCI検証やリリース候補向け検証を変更後の確認として自動実行しない。ローカル検証は、ユーザーが明示的に依頼した場合、または依頼された作業自体がリリース候補の作成・検証である場合に限定する。
- `pnpm quality:check`はrelease候補用の完全ゲートとして維持する。clean-checkout再構築、macOS release integration、Tauri bundle、最終diff再検査を含むため、PRごとのCIでは実行しない。
- `.github/workflows/ci.yml`は`.app`とDMGの生成・公開、Developer ID署名、公証、stapling、fresh-profileまたは別Macでのinstall smoke、Devpost提出を行わない。無料DMGのdraft作成はversion tag専用の`.github/workflows/release.yml`へ分離し、詳細は[GitHub Release macOS無料配布仕様](github-release-distribution.md)を正本とする。

## トリガー

| イベント | 対象 | 目的 |
|---|---|---|
| `pull_request` | baseが`develop`のPR | merge前の必須検証 |
| `push` | `develop` | merge後の統合状態を再検証 |
| `workflow_dispatch` | 明示的に選択したref | 障害調査と手動再検証 |

同じPRまたはrefの古い実行は、新しい実行が始まった時点でcancelする。schedule実行とpath filterは設けない。TypeScriptとRustはIPC contractとbundle resourceを共有し、ドキュメントやworkflowも品質gateへ影響するため、job単位の推測skipは行わない。

## 分離したrelease workflow

`.github/workflows/release.yml`は`v<version>` tagのpushだけで起動し、通常CIとは別の`Release macOS / Package and draft` jobを実行する。full historyからtag commitが`origin/develop`上にあることと、tagが`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`のversionへ一致することを先に検証する。

release jobは`macos-14` Apple Silicon runnerで`pnpm test:release`と`pnpm release:macos`を順に実行し、ad-hoc seal、resource inventory、Finder非依存DMG、read-only mount、canonical snapshot verificationを通したDMGだけをSHA-256 sidecarとともにdraft GitHub Releaseへ置く。Apple certificate、notarization credential、application API keyを使わない。既存public releaseは変更せず、draftだけを同tagの再実行で置換できる。public化はdownload後checksum、bounded Gatekeeper手順、別Macまたはfresh-profile install smokeの記録後に手動で行う。

## 必須job

### `CI / Frontend and repository`

| 項目 | 仕様 |
|---|---|
| Runner | `ubuntu-24.04` |
| 上限 | 30分 |
| 前提 | full Git history、Node.js `22.12.0`、pnpm `10.12.2`、agent-docs `v0.1.1` |
| 差分 | PRは`pull_request.base.sha`、pushは`push.before`をbaseに`pnpm check:diff` |
| Repository | `pnpm format:check`、`agent-docs --no-user-config lint` |
| Frontend | `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` |

`pnpm check:diff`を依存install前に実行して不正な差分を早期に拒否する。`pnpm test`はLive2Dとbundled skillのsupply-chain test、diff hygieneとquality runnerのrepository test、frontend Vitestを実行する。symlink modeなどrunner OSで意味が変わるrelease testは、部分的にLinuxへ移さず`pnpm test:release`へ集約する。production frontend buildとdemo marker除外は`pnpm build`で確認する。

Frontend VitestはLinux上のjsdomで実行する。character asset integrity testは省略せず、browser realmの`ArrayBuffer`をNode WebCryptoへ渡す境界では`Uint8Array`の`BufferSource` viewへ正規化する。UI fixtureは、target branchの現行アクセシブル名とnavigation構造を検証し、過去の表示構造を固定しない。

### `CI / Native`

| 項目 | 仕様 |
|---|---|
| Dependency | `Frontend and repository`成功後だけ開始 |
| Runner | `macos-14`の標準Apple Silicon runner |
| 上限 | 45分 |
| Node / pnpm | Node.js `22.12.0` / pnpm `10.12.2` |
| Rust | `rust-toolchain.toml`のRust `1.88.0`、Clippy、rustfmt |
| Dependency preparation | `pnpm install --frozen-lockfile`とApple Silicon targetへの`cargo fetch --locked` |
| Compliance | `pnpm licenses:check`、`node --test scripts/licenses/*.test.mjs` |
| Native | `cargo fmt --check`、warningsを拒否するlocked Clippy、serialなlocked Rust test |

Cargoの実効runtime graphと生成済み法務台帳のbyte一致を、対象platformのregistry metadataで検証する。Rust unit/integration testは実行するが、`pnpm tauri:build`とrelease packagingは実行しない。

## 再現性とcache

- Node、pnpm、Rust、agent-docsはexact versionを使う。JavaScriptとRustの依存解決は両lockfileを必須とする。
- 外部GitHub Actionはrelease tagの完全なcommit SHAへ固定し、同じ行のcommentへ対応versionを残す。version更新時は公式releaseとSHAを再確認する。
- pnpm store、Cargo registry、Cargo Git DB、Cargo targetはlockfileとtoolchainから導いたkeyでcacheしてよい。cacheは高速化だけを担い、cache missでも同じ結果になることを必須とする。
- CIはsource、lockfile、生成済み法務台帳を自動更新しない。staleな生成物は失敗として報告する。
- `third-party/THIRD-PARTY-DEPENDENCIES.json`とpackaged copyは生成器がbyte列を所有するためBiome対象外とし、`pnpm licenses:check`のbyte一致と完全性検査だけを正本とする。
- JavaScript系lintと対応形式のformatはrootの`biome.json`を共通の正本とする。YAMLとMarkdownはBiome 2.5.4のformat対象外であり、CI用に第二のformatterを導入しない。

## 通常CIの権限と秘密情報

- workflow-level permissionは`contents: read`だけとする。
- checkoutはcredentialを永続化しない。
- forkまたはPRのコードへwrite token、release credential、Apple署名情報、Codex認証情報、API keyを渡さない。
- `.github/workflows/ci.yml`からcommit、push、PR更新、release作成、artifact公開を行わない。release jobだけはjob-level `contents: write`でdraft Releaseを更新する。

## ブランチ保護

`develop`のbranch protectionまたはrulesetでは、次のcheckをrequiredにする。

- `CI / Frontend and repository`
- `CI / Native`

管理者bypass、required review数、force-push禁止などのGitHub側ルールはリポジトリ設定で管理する。workflow追加だけではrequired checkにならないため、check名変更時はrulesetも同じ変更単位で更新する。

## 受け入れ条件

- PR、`develop` push、manual dispatchで同じworkflowが起動する。
- 不正な差分では依存install前にfrontend jobが失敗し、macOS jobを開始しない。
- frontend jobがformat、managed documentation、lint、type、PR向けtest、production frontend buildを検証する。
- native jobがApple Silicon上でlicense inventoryとRust fmt、Clippy、testを検証する。
- PR CIが`pnpm quality:check`、clean-checkout smoke、macOS release integration、Tauri bundleを実行しない。
- 通常CI workflowはread-only tokenで完結し、repositoryやreleaseを変更しない。
- superseded runがcancelされ、同一PRの古い結果がmerge判断に残らない。
- CI成功を、署名済み・公証済み・install-smoke済みreleaseの証拠として扱わない。
