---
title: "shadcn を使う読み取り専用 Commit UI 調査"
description: "Commit evidence 画面で既存 shadcn primitive を使い、読み取り専用・高密度・アクセシブルな list/detail UI を組み立てる基準を整理する。"
updated: 2026-07-20
last_verified: 2026-07-18
read_when:
  - "Commit evidence 画面の UI、状態、レスポンシブ表示を実装または変更するとき。"
  - "shadcn component の構成、icon、empty/loading/error state を監査するとき。"
---

# shadcn を使う読み取り専用 Commit UI 調査

## 結論

Commit evidence 画面は、既存の shadcn primitive を interaction と状態表現へ使い、layout、密度、色、文字、radius はリポジトリの design token を正本とする。generic card grid や nested card へ分割せず、64px observer bar、300px commit list、残幅の detail からなる連続した作業面にする。

mutation action は置かない。`Button` は local observation の Refresh、明示的な「詳しく教えて」、Cancel、list drawer、pagination に限定する。filter は3択の `ToggleGroup`、selection後の内容切替は `Tabs`、長い list/detail/diff は `ScrollArea`、観測状態は text付き `Badge`、empty/loading/error はそれぞれ `Empty`、`Skeleton`、`Alert` を使う。

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
| shadcn [Tabs](https://ui.shadcn.com/docs/components/radix/tabs) | `TabsTrigger`は`TabsList`内、contentはselection stateを維持する | Overview / Changes / Evidenceをreloadなしで切り替える |
| shadcn [Toggle Group](https://ui.shadcn.com/docs/components/radix/toggle-group) | 2〜7択のsingle selection control | All / This work unit / Needs attention filterに使う |
| shadcn [Alert](https://ui.shadcn.com/docs/components/radix/alert) | titleとdescriptionを持つcallout | observer/list/detail failureをcustom bordered divで作らない |
| shadcn [Separator](https://ui.shadcn.com/docs/components/radix/separator) | 内容上の区切りをsemantic primitiveで表現できる | tool bar内など独立した区切りに使い、row/table構造のborderは既存design systemに従う |

## ローカル正本から決める事項

次はWeb情報ではなく、既存の `PRODUCT.md`、`DESIGN.md`、`src/index.css`、`docs/screen-design/S-003_session-evidence.md` を正本にする。

- dark warm-neutralのcontinuous deskを維持し、surfaceをcardへ細分化しない。
- Inter / Noto Sans JP、JetBrains Mono、固定px type scale、3px spacing系列、4.5px radiusを変えない。
- observer barは64px、listは標準300px・中幅280px、960px未満または200% zoomではmodalでないdrawerにする。
- statusは色、text、shapeを併用し、通常文字4.5:1、visible focus、keyboard selection、JA/ENを維持する。
- commit messageとtechnical IDは翻訳せず原文表示する。
- hidden force-mounted Commit tabはnative observationを開始しない。
- selectionは`commitEvidenceId`で保持し、refresh後に消えたselectionを最新commitへ自動移動しない。
- diffはfile selection後にlazy loadし、binary、oversize、invalid UTF-8をtyped text stateで表示する。
- `詳しく教えて`は利用者操作の時だけ発火し、selection変更、再押下、Cancelをtyped eventとして扱う。

## component composition

| 領域 | component | 制約 |
|---|---|---|
| Observer bar | `Badge`, `ToggleGroup`, `Button`, `Tooltip` | Refreshのaccessible nameにlocal/read-onlyを含める |
| Commit list | `ScrollArea`, `Badge`, `Skeleton`, `Empty` | row全体をsingle selection controlにし、内部actionを置かない |
| Detail header | `Badge`, `Button` | producerとpersistedを別の事実として表示し、mutation actionを置かない |
| Detail body | `Tabs`, `ScrollArea`, `Separator` | Overview / Changes / Evidenceの3区分だけにする |
| Gate evidence | `Badge` | Pass/Fail/Needs review/Unknownをtextで明示する |
| Error | `Alert` | cached evidenceを隠さず、typed error codeと回復操作を示す |
| Explanation | `Button`, `Tooltip` | fresh observationとhandlerがない時は理由を近接textで示す |

## 実装チェック

- ButtonやBadge内iconへmanual `size-*` classを付けない。
- Button内iconは`data-icon="inline-start"`または`inline-end`を付ける。
- `className`でshadcn componentの色やtypographyを上書きせず、既存variantを使う。
- custom Empty、custom Alert、nested card、shadow付きstatus cardを作らない。
- option setをButton loopで作らず`ToggleGroup`を使う。
- conditional classは`cn()`を使う。
- loadingは`Skeleton`、statusは`Badge`、icon-only actionは`Tooltip`を使う。
