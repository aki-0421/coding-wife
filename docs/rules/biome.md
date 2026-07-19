---
title: "Biome運用仕様"
description: "Coding WifeのJavaScript系lintと対応形式のformatterをBiomeへ統一する設定、対象範囲、除外、公開コマンドを定義する。"
updated: 2026-07-19
read_when:
  - "biome.json、lint、formatter、またはJavaScript系の静的解析ルールを変更するとき。"
  - "Biomeの対応形式、除外対象、CIでの実行方法を確認するとき。"
---

# Biome運用仕様

## 目的

JavaScript系sourceのlintと、Biomeが対応するrepository fileのformatを`@biomejs/biome`へ統一する。ESLint、Prettier、およびそれらのpluginや個別設定を併用せず、ルール、対象範囲、除外をrootの`biome.json`だけで判断できる状態にする。

## 正本と公開コマンド

- 設定の正本はrootの`biome.json`とし、`@biomejs/biome`は`package.json`と`pnpm-lock.yaml`でexact versionへ固定する。
- `pnpm format`はBiome formatterで対象fileを書き換える。
- `pnpm format:check`は同じ対象を変更せず検査する。
- `pnpm lint`はLive2D固定入力を先に検査し、Biome linterのwarningを含むdiagnosticを拒否する。
- CIとrelease候補品質gateは上記の公開コマンドを使い、別のlintまたはformatter executableを直接呼ばない。

## format規約

- JavaScript / TypeScriptはsemicolonなし、double quote、indent幅2、複数行の末尾commaありを維持する。
- Biomeが正式対応するJavaScript、TypeScript、JSX、TSX、JSON、CSSを対象とする。rootのapplication HTMLもHTML formatterを明示的に有効化して対象にする。
- `src/index.css`はTailwind v4の`@custom-variant`、`@theme`、`@apply`を使うため、`css.parser.tailwindDirectives`を有効なまま維持する。
- YAMLとMarkdownはBiome 2.5.4のformatter対象外である。第二のformatterは導入せず、`.github/workflows/*.yml`とMarkdownはformat gateの対象外とする。
- dependency notice、Live2D runtime、minified vendor code、build output、private state、tooling assetなど、生成器または外部供給元がbyte列を所有するfileは変更しない。

## lint規約

- Biome recommended rulesを基準とし、React Hooksのtop-level呼び出しと不足dependency、Vite Fast Refreshのcomponent export制約を維持する。Biome固有の不要dependency診断は、旧React Hooks ruleとの互換性を保つため無効にする。
- Fast Refresh制約を意図的に適用しないmoduleは`biome.json`の限定overrideへ列挙し、旧tool名のinline suppressionをsourceへ残さない。
- BiomeはTypeScript compilerの型検査を置き換えない。型、unused local / parameter、switch fallthroughなどのcompiler制約は`pnpm typecheck`で引き続き検査する。
- lint対象は旧ESLintと同じapplication TS / TSX、repository script TS、root config TSとする。formatter対象であってもMJS、CSS、JSON、HTMLはlint対象へ暗黙に追加しない。vendored source、generated output、bundled third-party runtime、`.agents/`、`.context/`、`tmp/`も対象外とする。
- 旧ESLint configに対応しないBiome ruleは、移行時のbehavior changeを避けるためroot設定で明示的に無効化する。新しいlint policyとして導入する場合は、別の仕様変更として既存diagnosticの解消と同時に行う。

## 変更時の条件

- `biome.json`の対象または除外を変更した場合は、生成物やvendor byte列を所有権なく書き換えないことを確認する。
- ruleを無効化する場合は、repository全体ではなく必要なpathだけへ限定し、理由をこの文書または近接する永続文書へ残す。
- Biomeのmajor / minor versionを更新する場合は、公式language supportとmigration noteを確認し、新対応形式を自動的にgateへ加えず差分をレビューする。

## 受け入れ条件

- `package.json`にESLint、Prettier、それらのplugin、`globals`、`typescript-eslint`が残らない。
- `.prettierrc.json`、`.prettierignore`、`eslint.config.js`が存在せず、`biome.json`だけがJavaScript系lintと対応形式のformatを設定する。
- `pnpm format`、`pnpm format:check`、`pnpm lint`の公開名を維持し、すべてBiomeを使用する。
- React HooksとFast Refreshの既存保護をBiome ruleへ対応付ける。
- CI、管理文書、source内に削除したtoolを実行する案内や旧tool用suppressionが残らない。
