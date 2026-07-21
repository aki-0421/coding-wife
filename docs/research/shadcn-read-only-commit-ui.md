---
title: "shadcn を使う読み取り専用 Commit UI 調査"
description: "Commit changes画面で既存shadcn primitiveを使い、GitHub Files changed型のcompactでアクセシブルなcommit/file/diff UIを組み立てる基準を整理する。"
updated: 2026-07-22
last_verified: 2026-07-22
read_when:
  - "Commit evidence 画面の UI、状態、レスポンシブ表示を実装または変更するとき。"
  - "shadcn component の構成、icon、empty/loading/error state を監査するとき。"
---

# shadcn を使う読み取り専用 Commit UI 調査

## 結論

Commit changes画面は既存shadcn primitiveをinteractionへ使い、layout、密度、色、文字、radiusはrepository design tokenを正本とする。GitHubのPR Files changed / commit changesと同様、compact commit selector、selected identity、file navigator、1 fileのunified diffを一続きの作業面にする。generic card grid、observer dashboard、property table、Overview / Changes / Evidence tabsを作らない。

mutation actionは置かない。`Button`はcommit drawer、local refresh、copy、collapse、file navigation、単一の「詳しく教えて」state/recovery、paginationに限定する。local path filterは`Input`、narrow file selectorはportalを使う`Popover`、長いlist/diffは`ScrollArea`、loading/error/emptyは`Skeleton` / `Alert` / `Empty`を使う。controller badge、internal error code、4 gateやreason propertyは通常UIへ描画しない。

## GitHub changes UXの参照

2026-07-22にGitHub公式の[Reviewing proposed changes](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request)と、実際の[PR Files changed](https://github.com/shadcn-ui/ui/pull/2812/files)、[small PR Files changed](https://github.com/shadcn-ui/ui/pull/11/files)、[commit changes](https://github.com/shadcn-ui/ui/commit/d652624)を確認した。file treeから対象fileへ移動し、file headerとunified diffを主役にする階層を採用する。GitHub固有のcomment、Viewed、approval、split diff等は本アプリのread-only commit reviewには持ち込まない。

## 確認方法

最終確認日は2026-07-18である。`pnpm dlx shadcn@latest info --json`と`pnpm dlx shadcn@latest docs`で、このrepositoryがVite、React client、Tailwind v4、Radix Nova、Lucide、`@/components/ui` aliasを使い、対象componentがすべて導入済みであることを確認した。CLIが返したURLは公式component pageを開き、titleと内容を確認した。

| 公式資料 | 確認した事項 | 実装判断 |
|---|---|---|
| shadcn [Button](https://ui.shadcn.com/docs/components/radix/button) | `variant` / `size`、iconへ`data-icon`を付ける構成、loadingはSpinner等を子として合成する | 既存variantを使い、Button内iconにmanual size classを付けない |
| shadcn [Badge](https://ui.shadcn.com/docs/components/radix/badge) | status等のcompact labelを既存variantで表現できる | Pass/Fail/Unknown等は色だけでなくtextを常に表示する |
| shadcn [Empty](https://ui.shadcn.com/docs/components/radix/empty) | title、description、contentを持つempty state composition | 0 commits、未選択は独自calloutでなくEmptyを使う |
| shadcn [Skeleton](https://ui.shadcn.com/docs/components/radix/skeleton) | content shapeに合わせるloading placeholder | 初回list/detail loadingは中央spinnerだけにしない |
| shadcn [Tooltip](https://ui.shadcn.com/docs/components/radix/tooltip) | icon-only controlのaccessible補助 | list drawer、Refresh、Close等のicon-only actionへ使う |
| shadcn [Scroll Area](https://ui.shadcn.com/docs/components/radix/scroll-area) | bounded contentのnative-like scroll projection | list、detail、diffを独立してscrollさせ、page全体の横scrollを作らない |
| shadcn [Input](https://ui.shadcn.com/docs/components/radix/input) | accessible native text inputを既存themeで使える | local file path filterへ使い、native queryだけで全diffを取得しない |
| shadcn [Popover](https://ui.shadcn.com/docs/components/radix/popover) | portalでoverflow container外へcompact selectionを出せる | 760px以下のfile selectorへ使う |
| shadcn [Alert](https://ui.shadcn.com/docs/components/radix/alert) | titleとdescriptionを持つcallout | observer/list/detail failureをcustom bordered divで作らない |
| shadcn [Separator](https://ui.shadcn.com/docs/components/radix/separator) | 内容上の区切りをsemantic primitiveで表現できる | tool bar内など独立した区切りに使い、row/table構造のborderは既存design systemに従う |

## ローカル正本から決める事項

次はWeb情報ではなく、既存の `PRODUCT.md`、`DESIGN.md`、`src/index.css`、`docs/screen-design/S-003_session-evidence.md` を正本にする。

- dark warm-neutralのcontinuous deskを維持し、surfaceをcardへ細分化しない。
- Inter / Noto Sans JP、JetBrains Mono、固定px type scale、3px spacing系列、4.5px radiusを変えない。
- commit listは幅300px以下の非modal drawerだけにし、toolbarは40pxのcommit triggerとicon-only refreshへ絞る。
- diffはold/new line gutter、marker、背景を併用し、通常文字4.5:1、visible focus、keyboard selection、JA/ENを維持する。
- commit messageとtechnical IDは翻訳せず原文表示する。
- hidden force-mounted Commit tabはnative observationを開始しない。
- selectionは`commitEvidenceId`で保持し、refresh後に消えたselectionを最新commitへ自動移動しない。
- detail取得後に先頭fileを自動選択し、常に1 fileだけをlazy loadする。binary、oversize、invalid UTF-8をtyped text stateで表示する。
- `詳しく教えて`は利用者操作の時だけ発火し、selection変更、再押下、Cancelをtyped eventとして扱う。

## component composition

| 領域 | component | 制約 |
|---|---|---|
| Compact toolbar | `Button`, `Tooltip` | commit drawerとlocal refreshだけ。observer propertyを置かない |
| Commit list | `ScrollArea`, `Skeleton`, `Empty` | row全体をsingle selection controlにし、subject + short SHA + author-relative timeだけを置く |
| Selected header | `Button`, `Tooltip` | identity、stats、hover/focus copy、単一explanation actionだけ。mutation/internal propertyを置かない |
| File navigator | `Input`, `ScrollArea`, `Popover` | local filter、path + local stats、keyboard移動、narrow selector |
| Unified diff | `ScrollArea`, `Button`, `Tooltip` | collapse、copy path、old/new gutter、marker、semantic row background |
| Error | `Alert` | observer/list/detail failureをcustom bordered divで作らずinternal codeを出さない |

## 実装チェック

- ButtonやBadge内iconへmanual `size-*` classを付けない。
- Button内iconは`data-icon="inline-start"`または`inline-end`を付ける。
- `className`でshadcn componentの色やtypographyを上書きせず、既存variantを使う。
- custom Empty、custom Alert、nested card、shadow付きstatus cardを作らない。
- conditional classは`cn()`を使う。
- loadingは`Skeleton`、icon-only actionは`Tooltip`を使う。
