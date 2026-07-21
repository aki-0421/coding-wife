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
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "0"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  caption:
    fontFamily: "Inter, Noto Sans JP, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  sidebarHeading:
    fontFamily: "Inter, Noto Sans JP, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0"
  sidebarStatus:
    fontFamily: "Inter, Noto Sans JP, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0"
  sidebarItem:
    fontFamily: "Inter, Noto Sans JP, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "0"
  sidebarMeta:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  sidebarHelper:
    fontFamily: "Inter, Noto Sans JP, system-ui, sans-serif"
    fontSize: "12px"
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
    glyphSize: "16px"
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
    typography: "{typography.sidebarItem}"
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

Figma node `8:2` を scan source とし、1470×836 CSS px の一つの作業面を基準にする。左 255.04px の workspace sidebar、上 81px の二段 header、中央 607.11px の Chat、右 607.84px の Live2D character を一続きの暗い面として構成する。標準サイズでは sidebar / chat / character を `255 / 607 / 608` の比率で固定し、Chat と character の間へ可視 divider や card を置かない。

色戦略は Restrained。ほぼ無彩色の暗い面を基礎に、温かいローズを active state、状態色を証拠、Hiyori の色を人格表現へ限定する。shadcn は Tabs、Button、Textarea、ScrollArea、Popover、Dialog、RadioGroup、Tooltip、Skeleton の interaction primitive としてだけ使い、layout、密度、色、文字、radius はこの文書へ合わせる。

これは terminal clone、game HUD、neon purple AI dashboard ではない。glassmorphism と generic card grid を拒み、通常の message、tool event、error をカードへ分断せず、文字階層と 3px 系列の rhythm で読む。chatty mascot や emotional coercion によって判断を誘導せず、キャラクターは証拠の横で静かに状態を伝える。

**Key Characteristics:**

- 1470×836 を基準にした 255 / 607 / 608 の三領域
- 同じ背景へ同居し、枠へ閉じ込めない Live2D character
- 3px 刻みの高密度な spacing と 4.5px 中心の小さな radius
- Inter / Noto Sans JP と JetBrains Mono の二系統だけ
- 文字・形・icon を併用する証拠中心の semantic state
- 150〜250ms の状態 transition と完全な reduced-motion 代替

**The Continuous Desk Rule.** Chat、Commitのprimary work surfaceとcharacterは一つの机である。通常状態で二つのcardや中央dividerに分割してはならない。App Settingsではcharacterを表示せず、設定面を全幅で使う。

**The Evidence Priority Rule.** 判断、error、review diff、test result が必要な時も作業tab間でcharacterの横幅を変えない。証拠と操作の可読領域はprimary surface内のdrawer、折り返し、内部scroll、必要時の静止poseで確保する。

## Brand Mark

Coding Wife のmarkは、人とagentを表す二つの穏やかな流れが、一つの検証済み作業面へ収束する抽象形である。人格や魔術性を付与せず、共同作業が読み取り可能な成果へまとまることだけを示す。

- **Concept:** 左から入る上下一対の流線を独立したまま中央へ寄せ、右へ進む一枚の作業面で受け止める。流線は交差、接触、分岐せず、作業面の背後へ自然に収束する。右端は尖った矢印にせず、丸めた前進方向として開放感を残す。
- **Geometry:** 正本は `src-tauri/icons/app-icon.svg` の 1024×1024 viewBox とする。角丸160の暗色squareの中へ、左側約22〜48%を通るround-capの二曲線と、中央約41%から右側約80%を占める非対称なround work surfaceを置く。中心円、外周ring、交差線、細い装飾、内側glyphを追加しない。二曲線の間には最小72pxのnegative spaceを保つ。
- **No text / no letter:** mark内部へ文字、頭文字、monogram、数字、顔、目、星、sparkle、check、魔術・占星術記号を描かない。特に `H`、`W`、`Y`、目、門、檻、警告標識へ見える中心対称・縦横接続・囲い込みを禁止する。名称は隣接HTML text、tooltip、`aria-label`で伝え、図形へ埋め込まない。
- **Colors:** 背景は App BG `#171514`、上の流線は Warm Active `#d0b1a3`、下の流線は Primary Text `#d4d4d8`、作業面は Action Fill `#d7d4d2` を使う。gradient、glow、shadow、暗い円環は使わず、既存のrestrained paletteから色を増やさない。
- **Small-size rules:** 24pxのinline mark、32pxのbundle icon、128px、256pxで同じsilhouetteを保つ。24/32pxでは二流線、流線間の空間、前進する作業面の三要素が個別に読める太さを下限とし、1px未満になるdetailを持ち込まない。角丸square外はtransparentのまま、edgeへ接触させない。app identityを示すinline表示は共通の`BrandMark` SVG componentを使い、装飾用途以外ではaccessible nameを保持する。workspace headerの先頭はapp identityではなくrepository owner identityを示すため、このmarkを置かない。

### Source and regeneration

`src-tauri/icons/app-icon.svg` だけをvector正本とし、`32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.icns`を手編集しない。変更時は一時directoryへ生成して対象assetだけを置き換える。

```bash
icon_output="$(mktemp -d)"
pnpm exec tauri icon src-tauri/icons/app-icon.svg --output "$icon_output"
cp "$icon_output/32x32.png" "$icon_output/128x128.png" "$icon_output/128x128@2x.png" "$icon_output/icon.icns" src-tauri/icons/
```

生成後は32 / 128 / 256px rasterとICNS内の最大representationを目視し、transparent corner、edge clearance、二流線の分離、文字・顔・目・星・魔術記号への誤読がないことを確認する。

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

- **Continuous Desk** (`app-bg`): Chat と character を連続させる最深面。
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
- **Headline**（600、13.5px、20.25px）: panel heading。
- **Title**（500、12px、18px）: tabs、status group、decision title。
- **Body**（400、13.5px、21px）: assistant message と説明。長文は 65〜75ch を上限にする。
- **Label**（500、11px、16.5px）: compact control、menu、metadata。
- **Mono**（400、11px、16.5px）: branch、tool summary、SHA、path。長い値は ellipsis と全文表示を併用する。
- **Caption**（400、11px、16.5px）: helper と shortcut。Figma の 8.25〜9px source 値は通常表示に使わず、11px へ引き上げる。

Sidebarは255.04px幅と49.5px itemに合わせた固定4段階を使う。**Sidebar Heading**は600、14px、21px、**Sidebar Item**は500、13px、19.5px、**Sidebar Status**は600、12px、18px、**Sidebar Meta**は400、11px、16.5pxとする。project filter 0件のhelperは400、12px、18pxとする。workspace selectionでfont weightや文字幅を変えず、背景色とstrong textで現在地を示す。branchだけJetBrains Monoを使い、他はUI sansを維持する。

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

- **Shape:** compact controls は緩い矩形（4.5px radius）、height 24px。icon-only control は24〜36pxの外形を維持し、標準glyphを16px、`icon-lg`だけ20pxにする。ラベル付きbuttonのinline iconは12pxを維持し、hit targetは24×24px以上を確保する。
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
- **Selection:** 有限の単一選択は共通のshadcn `Select`を使い、候補をbody-level portalへ描画する。production UI、設定、dialog、開発用previewを含む`src/`配下でnative `<select>`と`NativeSelect`を使わない。triggerはcompact controlのdensity、visible focus、disabled / invalid state、accessible nameを維持し、候補は`SelectGroup`単位で構成する。
- **Attachments:** Add、drop、paste を一つの attachment model へ統合し、Context menu は portal して composer の overflow に clip させない。

### Navigation

Sidebar は 255.04px、workspace footer は 40.5px で固定し、その間の list だけを scroll させる。workspace item は 242.25×49.5px、先頭に24px owner avatar、続いてbranch icon付きtitleと`owner/repo`の二行を置き、active item だけ selected-row を持つ。header は 40.5px の breadcrumb row と 40.5px の tab row。breadcrumb rowはGitHub originがある時にowner avatar、`owner/repo`、workspace名を順に置く。repository、workspace名、branchはellipsis可能なtext buttonとし、hover / focus-visibleでselected-rowを示し、activationで省略前のexact valueをclipboardへcopyする。これらのvalue controlへtooltipまたはnative `title`を付けない。copy icon、成功check icon、その予約領域は表示せず、copy結果はbuttonのinline contentと幅を変えないaccessible statusだけで通知する。offline時はpersistent bannerを正本とし、breadcrumb rowへoffline icon、text、placeholderを表示しない。3点workspace actionはheaderへ置かず、Archiveはsidebar rowからだけ開始する。sidebarとheaderは同じavatar sourceを使い、GitHub originがない時またはavatar取得失敗時はapp markではなくneutral repository fallbackを使う。active tab は strong text と 1.5px warm-active underline、inactive は readable muted text とし、keyboard roving focus を提供する。960〜1279px では sidebar を 64px rail または drawer へ畳み、960px 未満は MVP native window で許可しない。200% text zoom などで有効幅が 700px 以下になる場合は、永続化状態と character 状態を同じ status region で縦積みし、timeline、composer、Send、mute を隠さない。

### Commit Evidence

Commit tab は main Codex が作成したコミットを確認する読み取り専用面とし、上 64px の observer bar、300px の commit list、残幅の detail を連続した作業面として構成する。list row は subject、SHA、time、work unit相関、Verification / Risk、change summaryのsingle selection controlとし、detailは Overview / Changes / Evidence の3 tabだけを持つ。Commit、Stage、Restore、Revert、Branch等のGit mutation actionを置かない。

file summaryを先に表示し、sanitized diffはfile selection後に1件ずつlazy loadする。binary、oversize、invalid UTF-8は本文を表示せず、text付きtyped stateを残す。960px未満または200% text zoom時はlistをmodalでないdrawerへ移し、detailとerror reasonを隠さない。

新しいcommitは、App Serverのsuccess commit commandとread-only observerのSHA検証後にapp-owned explanation controllerが`not_generated`から`queued`へ自動遷移する。起動前から存在するcommitなど本当に`not_generated`の選択には「詳しく教えて」を表示し、mainではなくapp controllerへ`user_request`を送る。`queued` / `running`はpresentation表示とCancel、`generated`はcached presentation表示と任意の同一transcript再読上げ、`failed` / `canceled`は`user_retry`、`unavailable`は理由とretryableな場合だけ`user_retry`を示す。path、raw diff、secretを除去したevidenceだけをisolated supportへ渡し、説明はcanvasに依存しないvisible HTML captionへstreamする。isolated supportはmain非継承のclean runtime、external-authority tool 0件、wire上のexact inert `update_plan` 1件、permission profile、release proofが揃う時だけcapacity 1とし、`update_plan`の実callやtool schema/hash不一致では当該説明をfailedとして非表示にする。TTSを使う場合もcaptionと同じ確定文だけを読み、selection変更、Cancel、stale response後のchunkを適用しない。commit説明のrequest、status、result、failureをmain conversationへ入れない。

### Live2D Character

607.84×754.99px の透明な単一canvasをContinuous Desk上へbottom-containし、頭、手、裾を切らない。選択workspaceのChat、Commitでは常に同じcanvas instanceと同じpane幅を継続し、tab切替でrendererを再生成またはresizeしない。Commitのevidence detailはcharacterを縮小せず、commit listを非modal drawerへ退避して可読幅を確保する。App Settingsではcanvasを表示せずprimary surfaceを全幅へ戻す。canvas自体はpointerとaccessibility treeを占有せず、muteは右下21px insetの27×27px circleとする。renderer failureはanimated → reduced → static preview → text-onlyの順に縮退する。

### Decision Card

質問、why now、options、impact/scope、risk、reversibility、recommendation/evidence、uncertainty を 9px radius の一面へ載せる。option は shadcn RadioGroup の標準 keyboard interaction を保持し、Other、hold、interrupt を同じ面から選べる。blocking decision を toast やキャラクター吹き出しだけにしない。

## Do's and Don'ts

### Do:

- **Do** 1470×836 で sidebar 255.04px、header 81px、Chat 607.11px、character 607.84px を基準にし、主要 boundary を Figma node `8:2` の ±2 CSS px に収める。
- **Do** card を selected workspace、code chip、composer、必要な overlay へ限定し、通常 message と tool event は連続面へ置く。
- **Do** status を色、label、icon、fill/outline/dash の少なくとも三つで示す。
- **Do** normal text contrast 4.5:1、visible focus、24×24px 以上の hit target、200% text zoom を検証する。
- **Do** shadcn を interaction primitive に限定し、この文書の density、radius、color、type で theme する。
- **Do** すべての motion に reduced-motion の静止または短い crossfade 代替を用意する。

### Don't:

- **Don't** 「汎用 AI chat の複製」にし、状態、コミット、検証証拠、app-owned commit説明を会話の奥へ隠す。
- **Don't** 「terminal clone」にし、shell の生入出力や汎用 terminal control を主画面へ置く。
- **Don't** 「game HUD」の常時点滅、報酬演出、過剰な gauge で作業を奪う。
- **Don't** 「neon purple AI dashboard」の紫 gradient、発光 border、full-saturation accent を装飾として使う。
- **Don't** 「glassmorphism と generic card grid」で作業面を半透明 card へ分断する。
- **Don't** 「chatty mascot」として Live2D の発話、表情、音声だけで承認、危険、失敗を伝える。
- **Don't** 「emotional coercion」によって、キャラクターへの好意や罪悪感から推奨や継続を選ばせる。
- **Don't** colored side stripe、gradient text、decorative grid background、32px 以上の card radius、border と 16px 以上の soft shadow を組み合わせる。
- **Don't** dropdown を overflow container 内へ absolute 配置する。portal を使う。
- **Don't** native `<select>`または`NativeSelect`を使う。有限の単一選択は共通のshadcn `Select`へ統一する。
- **Don't** Inter / Noto Sans JP / JetBrains Mono 以外の font、Tailwind class 名、shadcn default の大 radius を design vocabulary として持ち込む。
