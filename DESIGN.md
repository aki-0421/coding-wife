---
name: Coding Wife
description: 証拠中心のCodex作業面へLive2Dの温かさを重ねる、抑制された暗色デザインシステム。
colors:
  app-bg: "#171514"
  sidebar: "#1c1a19"
  surface: "#211f1e"
  selected-row: "#2b2928"
  code-chip: "#292624"
  divider: "#302d2b"
  text-primary: "#d4d4d8"
  text-strong: "#f4f4f5"
  text-secondary: "#9f9fa9"
  text-muted-accessible: "#898993"
  text-disabled: "#71717b"
  warm-active: "#d0b1a3"
  branch-selected: "#b6a7ff"
  error: "#ed575d"
  success: "#3bd677"
  running: "#e5c400"
  canceled: "#52525c"
  action-fill: "#d7d4d2"
typography:
  display:
    fontFamily: "Inter, Noto Sans JP, system-ui, sans-serif"
    fontSize: "14.25px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0"
  headline:
    fontFamily: "Inter, Noto Sans JP, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0"
  title:
    fontFamily: "Inter, Noto Sans JP, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "0"
  body:
    fontFamily: "Inter, Noto Sans JP, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.5556
    letterSpacing: "0"
  label:
    fontFamily: "Inter, Noto Sans JP, system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "0"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "10.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  caption:
    fontFamily: "Inter, Noto Sans JP, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
rounded:
  control: "4.5px"
  window: "7.5px"
  composer: "9px"
  circle: "9999px"
spacing:
  xxs: "3px"
  xs: "6px"
  sm: "9px"
  md: "12px"
  lg: "15px"
  xl: "18px"
  2xl: "21px"
components:
  button-primary:
    backgroundColor: "{colors.action-fill}"
    textColor: "{colors.app-bg}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "4px 9px"
    height: "24px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "4px 9px"
    height: "24px"
  icon-toggle:
    backgroundColor: "{colors.selected-row}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.circle}"
    size: "27px"
  composer-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.composer}"
    padding: "12.75px"
    height: "128.25px"
  tab-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-strong}"
    typography: "{typography.title}"
    padding: "11px 3px 9.5px"
    height: "40.5px"
  workspace-selected:
    backgroundColor: "{colors.selected-row}"
    textColor: "{colors.text-strong}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "6px 9px"
    height: "49.5px"
  code-chip:
    backgroundColor: "{colors.code-chip}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.mono}"
    rounded: "{rounded.control}"
    padding: "3px 6px"
  decision-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.composer}"
    padding: "15px"
---

# Design System: Coding Wife

## Overview

**Creative North Star: "静かな作戦室"**

Figma node `8:2` を scan source とし、1470×836 CSS px の一つの作業面を基準にする。左 255.04px の workspace sidebar、上 81px の二段 header、中央 607.11px の Chat、右 607.84px の Live2D companion を一続きの暗い面として構成する。標準サイズでは sidebar / chat / companion を `255 / 607 / 608` の比率で固定し、Chat と companion の間へ可視 divider や card を置かない。

色戦略は Restrained。ほぼ無彩色の暗い面を基礎に、温かいローズを active state、状態色を証拠、Hiyori の色を人格表現へ限定する。shadcn は Tabs、Button、Textarea、ScrollArea、Popover、Dialog、RadioGroup、Tooltip、Skeleton の interaction primitive としてだけ使い、layout、密度、色、文字、radius はこの文書へ合わせる。

これは terminal clone、game HUD、neon purple AI dashboard ではない。glassmorphism と generic card grid を拒み、通常の message、tool event、error をカードへ分断せず、文字階層と 3px 系列の rhythm で読む。chatty mascot や emotional coercion によって判断を誘導せず、キャラクターは証拠の横で静かに状態を伝える。

**Key Characteristics:**

- 1470×836 を基準にした 255 / 607 / 608 の三領域
- 同じ背景へ同居し、枠へ閉じ込めない Live2D companion
- 3px 刻みの高密度な spacing と 4.5px 中心の小さな radius
- Inter / Noto Sans JP と JetBrains Mono の二系統だけ
- 文字・形・icon を併用する証拠中心の semantic state
- 150〜250ms の状態 transition と完全な reduced-motion 代替

**The Continuous Desk Rule.** Chat と companion は一つの机である。通常状態で二つの card や中央 divider に分割してはならない。

**The Evidence Priority Rule.** 判断、error、review diff、test result が必要な時は companion を縮小または静止し、証拠と操作の可読領域を優先する。

## Colors

暗い暖色寄り neutral を面の深さへ使い、ローズ、branch violet、semantic status を面積 10% 未満の意味ある場所にだけ使う。

### Primary

- **Warm Active** (`warm-active`): active tab の underline、選択 effort、focus の強調へ限定する。装飾面を塗りつぶさない。
- **Action Fill** (`action-fill`): Send のように現在の主操作が一つだけ存在する時の compact action fill。

### Secondary

- **Branch Violet** (`branch-selected`): 選択 workspace の Git branch icon と branch 関連の focus に限定する。

### Tertiary

- **Evidence Red / Green / Yellow** (`error`, `success`, `running`): error、review-ready、in-progress の意味を label、icon、stroke pattern と一緒に伝える。

### Neutral

- **Continuous Desk** (`app-bg`): Chat と companion を連続させる最深面。
- **Workspace Rail** (`sidebar`): workspace navigation を一段だけ持ち上げる。
- **Working Surface** (`surface`): header、composer、popover の構造面。
- **Selected Row / Code Chip / Divider** (`selected-row`, `code-chip`, `divider`): 選択、compact code、領域境界にだけ用いる。
- **Strong / Primary / Secondary Text** (`text-strong`, `text-primary`, `text-secondary`): 現在地、本文、補助情報の三段階。
- **Accessible Muted Text** (`text-muted-accessible`): inactive tab、placeholder、helper の最小文字色。Figma の dim 値は通常文字の contrast を満たさないため、この token を実装値とする。
- **Disabled Text** (`text-disabled`): 操作不能な control の icon と補助 label にだけ使い、通常本文や placeholder へ使わない。

**The Ten Percent Rule.** warm active、branch violet、semantic status を合わせても一画面の 10% を超えさせない。色の希少性が意味を守る。

**The Evidence Is Not Color Rule.** error、success、running、canceled は label、icon、fill/outline/dash の形と併用し、色だけで区別しない。

## Typography

**Display Font:** Inter（日本語は Noto Sans JP、次に system-ui）

**Body Font:** Inter（日本語は Noto Sans JP、次に system-ui）

**Label/Mono Font:** JetBrains Mono（次に ui-monospace / SFMono-Regular）

**Character:** 一つの UI sans で breadcrumb、navigation、message、control を統一し、branch、command、SHA、shortcut にだけ mono を使う。product UI に display face や流動的な見出しを持ち込まない。

### Hierarchy

- **Display**（600、14.25px、21.375px）: current workspace を示す header breadcrumb。marketing hero には使用しない。
- **Headline**（600、13.5px、20.25px）: Workspaces heading と panel heading。
- **Title**（500、12px、18px）: tabs、status group、decision title。
- **Body**（400、13.5px、21px）: assistant message と説明。長文は 65〜75ch を上限にする。
- **Label**（500、10.5px、15.75px）: compact control、menu、metadata。
- **Mono**（400、10.5px、15.75px）: branch、tool summary、SHA、path。長い値は ellipsis と全文表示を併用する。
- **Caption**（400、11px、16.5px）: helper と shortcut。Figma の 8.25〜9px source 値は通常表示に使わず、11px へ引き上げる。

**The Two-Family Rule.** UI sans と code mono 以外の font family を追加しない。button、tab、label に display font を使うことは禁止する。

**The Fixed Density Rule.** product UI の type scale は固定 px とし、`clamp()` で流動化しない。200% text zoom 時は container を拡張または折り返し、文字を縮めない。

## Elevation

深さは tonal layering と細い divider が正本であり、shadow は window、composer、portal overlay の三箇所だけに限定する。selected row、tool event、message、Live2D pane は flat のままにする。

### Shadow Vocabulary

- **Window Ambient** (`0 18.75px 37.5px -9px rgba(0, 0, 0, 0.25)`): OS window preview または window-level visual にだけ使う。
- **Composer Lift** (`0 9px 9px rgba(0, 0, 0, 0.18)`): timeline から固定 composer を分離する。
- **Overlay Lift** (`0 9px 10.5px rgba(0, 0, 0, 0.42)`): portal された dropdown、popover、decision overlay にだけ使う。

**The Flat-by-Default Rule.** surface は静止時に flat。border と 16px 以上の soft shadow を同じ card に組み合わせる ghost-card pattern を禁止する。

**The Semantic Stack Rule.** z-order は timeline < sticky composer < dropdown/popover < decision overlay < toast/tooltip とし、任意の巨大な z-index を使わない。

## Components

### Buttons

- **Shape:** compact controls は緩い矩形（4.5px radius）、height 24px。icon-only hit target は見た目が 12〜27px でも 24×24px 以上を確保する。
- **Primary:** action fill 上に app-bg の文字、左右 9px。通常画面で primary action は一つだけにする。
- **Hover / Focus / Active:** hover は面の lightness を一段だけ上げ、focus-visible は 2px warm-active ring + 2px offset、active は 120ms の 1px translate。disabled は opacity だけにせず label と `aria-disabled` を持つ。
- **Secondary / Ghost:** surface または透明背景、1px divider border。hover で selected-row を使い、shadow を付けない。
- **Motion:** feedback は 150ms ease-out、popover と tab は 200ms ease-out-quart。reduced motion 時は即時切替または 80ms crossfade。

### Chips

- **Style:** code chip は code-chip 背景、4.5px radius、3px 6px padding、mono。status chip は label と icon shape を持つ。
- **State:** selected effort だけに warm tint を使う。tool chip は action button に見せず、hover/focus で copy と全文展開へ到達できる。

### Cards / Containers

- **Corner Style:** composer と decision surface は 9px、selected row と compact container は 4.5px。一般 card は 16px を超えない。
- **Background:** composer、overlay、decision は Working Surface。通常 message と tool row は Continuous Desk に直接置く。
- **Shadow Strategy:** composer と overlay だけ Elevation の語彙を使う。
- **Border:** 0.75px source は実装で 1px divider とし、DPR によるぼけを避ける。colored side stripe は禁止する。
- **Internal Padding:** 3px 系列を守り、composer 12.75px、decision 15px、workspace item 6px 9px を基準にする。

### Inputs / Fields

- **Style:** composer は 571.11×128.25px の surface、9px radius、12.75px padding。textarea は上部 48px から伸長し、footer control を押し出さない。
- **Focus:** container border を warm-active へ変更し、2px focus ring を外側へ置く。placeholder は `text-muted-accessible` を使う。
- **Error / Disabled:** error は保持した draft の下へ icon、短い理由、回復操作を表示する。空入力かつ attachment/context がない時は Send を disabled にする。
- **Attachments:** Add、drop、paste を一つの attachment model へ統合し、Context menu は portal して composer の overflow に clip させない。

### Navigation

Sidebar は 255.04px、workspace footer は 40.5px で固定し、その間の list だけを scroll させる。workspace item は 242.25×49.5px、active item だけ selected-row を持つ。header は 40.5px の breadcrumb row と 40.5px の tab row。active tab は strong text と 1.5px warm-active underline、inactive は readable muted text とし、keyboard roving focus を提供する。960〜1279px では sidebar を 64px rail または drawer へ畳み、960px 未満は MVP native window で許可しない。

### Live2D Companion

607.84×754.99px の透明な単一 canvas を Continuous Desk 上へ bottom-contain し、頭、手、裾を切らない。canvas 自体は pointer と accessibility tree を占有せず、mute は右下 21px inset の 27×27px circle とする。renderer failure は animated → reduced → static preview → text-only の順に縮退する。

### Decision Card

質問、why now、options、impact/scope、risk、reversibility、recommendation/evidence、uncertainty を 9px radius の一面へ載せる。option は shadcn RadioGroup の標準 keyboard interaction を保持し、Other、hold、interrupt を同じ面から選べる。blocking decision を toast やキャラクター吹き出しだけにしない。

## Do's and Don'ts

### Do:

- **Do** 1470×836 で sidebar 255.04px、header 81px、Chat 607.11px、companion 607.84px を基準にし、主要 boundary を Figma node `8:2` の ±2 CSS px に収める。
- **Do** card を selected workspace、code chip、composer、必要な overlay へ限定し、通常 message と tool event は連続面へ置く。
- **Do** status を色、label、icon、fill/outline/dash の少なくとも三つで示す。
- **Do** normal text contrast 4.5:1、visible focus、24×24px 以上の hit target、200% text zoom を検証する。
- **Do** shadcn を interaction primitive に限定し、この文書の density、radius、color、type で theme する。
- **Do** すべての motion に reduced-motion の静止または短い crossfade 代替を用意する。

### Don't:

- **Don't** 「汎用 AI chat の複製」にし、状態、証拠、復元を会話の奥へ隠す。
- **Don't** 「terminal clone」にし、shell の生入出力や汎用 terminal control を主画面へ置く。
- **Don't** 「game HUD」の常時点滅、報酬演出、過剰な gauge で作業を奪う。
- **Don't** 「neon purple AI dashboard」の紫 gradient、発光 border、full-saturation accent を装飾として使う。
- **Don't** 「glassmorphism と generic card grid」で作業面を半透明 card へ分断する。
- **Don't** 「chatty mascot」として Live2D の発話、表情、音声だけで承認、危険、失敗を伝える。
- **Don't** 「emotional coercion」によって、キャラクターへの好意や罪悪感から推奨や継続を選ばせる。
- **Don't** colored side stripe、gradient text、decorative grid background、32px 以上の card radius、border と 16px 以上の soft shadow を組み合わせる。
- **Don't** dropdown を overflow container 内へ absolute 配置する。portal を使う。
- **Don't** Inter / Noto Sans JP / JetBrains Mono 以外の font、Tailwind class 名、shadcn default の大 radius を design vocabulary として持ち込む。
