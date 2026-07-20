---
title: package scripts 仕様
description: Coding Wifeの開発、CI、リリースで公開するpnpmコマンドと、内部処理をpackage scriptsへ公開しない基準を定義する。
updated: 2026-07-19
read_when:
  - package.jsonのscriptsを追加、削除、改名するとき。
  - ローカル開発、CI、またはリリースの正規コマンドを判断するとき。
---

# package scripts 仕様

## 目的

`package.json`の`scripts`は、開発者が直接選ぶ安定したワークフローだけを公開する。npm lifecycle hook、個別test file、Live2Dの内部生成工程、リリース実装の診断用substepをトップレベルへ並べず、コマンド一覧から通常の入口を判断できる状態を保つ。

## 公開コマンド

| コマンド | 責務 |
|---|---|
| `pnpm dev` | Live2Dの固定入力を準備し、browser用Vite serverを起動する |
| `pnpm tauri:dev` | Tauriのnative development appを起動する |
| `pnpm build` | Live2D準備、TypeScript、Vite production build、production bundle検査を連続実行する |
| `pnpm tauri:build` | Tauri production appをbuildする。通常のローカル検証には使わない |
| `pnpm format` | Biome対応形式の対象fileを更新する |
| `pnpm format:check` | Biome対応形式の対象fileを変更せず検査する |
| `pnpm lint` | Live2D固定入力とBiome linterを検査する |
| `pnpm typecheck` | Live2Dを準備し、application TypeScriptを検査する |
| `pnpm test` | PR向けのsupply-chain、repository、frontend testを実行する |
| `pnpm test:desktop` | QA専用debug binaryをbuildし、WebdriverIOでmacOSの実Tauri appを操作する |
| `pnpm test:watch` | Live2Dを準備し、Vitest watch modeを起動する |
| `pnpm test:release` | macOS release実装の重いintegration testを実行する |
| `pnpm check:diff` | repository差分のhygieneを検査する |
| `pnpm licenses:generate` | dependency noticeを明示的に再生成する |
| `pnpm licenses:check` | dependency noticeのbyte一致と完全性を検査する |
| `pnpm quality:check` | cleanなrelease候補に対する全品質gateを順番に実行する |
| `pnpm release:macos` | sealed appとDMGをbuild、検証、transactional publishする |

## 境界

- `predev`、`prebuild`、`postbuild`、`prelint`、`pretest*`は定義しない。必要な準備と検査は、対応する公開コマンド本体へ明示する。
- CIは公開コマンドを使う。同じPR向けtest集合を別名の`test:pr`として重複公開しない。
- `@tauri-apps/cli`の任意のsubcommandが必要なときは`pnpm exec tauri ...`を使う。日常起動、desktop QA、release候補buildだけは`tauri:dev`、`test:desktop`、`tauri:build`を安定入口として公開する。
- `scripts/live2d/`、`scripts/licenses/`、`scripts/quality/`、`scripts/release/`、`scripts/skills/`配下の個別処理は、公開ワークフローの内部から実体fileを直接呼ぶ。保守担当が個別診断するときも実体fileを使い、package scriptsへ一処理一aliasを追加しない。
- macOS releaseのapp、DMG、verify単体診断は`scripts/release/`配下のshell scriptを直接使う。審査用成果物の正規入口は`pnpm release:macos`だけとする。
- scriptを追加する場合は、既存の公開コマンドへoptionを追加できず、人が独立して選ぶ反復可能なworkflowであり、CIまたは文書から安定名を参照する必要があることを説明できなければならない。
- lintとformatの対象、除外、ruleは[Biome運用仕様](biome.md)とrootの`biome.json`を正本とする。公開コマンドから別のlintまたはformatterを呼ばない。

## 受け入れ条件

- `package.json`のscriptsは上記17個だけである。
- `pnpm tauri:dev`だけでVite serverとnative appの起動が始まり、別terminalで`pnpm dev`を先に実行する必要がない。
- `pnpm test`はrelease integrationを含まず、CIのPR向けtest集合と一致する。
- `pnpm quality:check`はlicense test、clean-checkout再現、release integration、Rust、documentation、Tauri build、diff hygieneを引き続き含む。
- README、CI、管理文書、source内の案内に削除済みpackage scriptが残らない。
