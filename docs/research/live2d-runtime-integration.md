---
title: "Live2D実ランタイム統合調査"
description: "Cubism SDK for Web 5-r.5、同梱Hiyori PRO、Tauri資産プロトコルを使い、実描画・モーション・リサイズ・安全な任意モデル追加を成立させる実装契約。"
updated: 2026-07-20
last_verified: 2026-07-18
read_when:
  - "Live2Dの実描画、モーション制御、同梱モデル、任意モデルインポートを実装または検証するとき。"
  - "Cubism SDK/Coreを更新し、互換性、配布物、ハッシュ、ビルド手順を再検証するとき。"
---

# Live2D実ランタイム統合調査

## 結論

`tmp/hiyori_pro` と公式 **Cubism SDK for Web 5-r.5** の組み合わせで、Coding Wife の Tauri WebView に実際の Live2D 描画を組み込める。ローカル検証では、Core 06.00.0001 が Hiyori の moc3 を正常と判定し、モデル生成に必要な Canvas、Parameter、Part、Drawable 情報を取得できた。

採用する最小構成は次の通り。

- 公式 Cubism Core と公式 Cubism Web Framework だけを、版と SHA-256 を固定してアプリへ同梱する。
- `pixi-live2d-display` などの非公式 wrapper や実行時 CDN は使わない。
- React 側は 1 個の透明 WebGL canvas と、canvas の寿命から独立した `CharacterController` を持つ。
- Core は同一オリジンの classic script として Framework より先に一度だけ読み込む。Framework はアプリの TypeScript 6 から隔離し、公式と同じ TypeScript 5.9.3 で事前コンパイルする。
- 同梱モデルには、SDK サンプル内の別版 Hiyori ではなく、指定された `tmp/hiyori_pro/runtime` の 17 ファイルを使う。
- 任意モデルは Rust 側で閉包、正規化、容量、画像寸法、MOC 整合性を検査し、隔離領域で描画確認した後にだけライブラリへ原子的に移す。
- WebView へ絶対パスを渡さない。`pack_id` と検証済みの相対 asset ID だけを受け付ける read-only プロトコルから配信する。
- Hiyori の各モーションの意味は画像で確認するまで断定しない。最初の実装では全状態をテキストで区別し、映像はニュートラルな `Idle[0]` を基本にする。

本書は `../requirements/live2d-character.md`、`../screen-design/S-002_coding-workspace.md`、`../screen-design/S-005_app-settings-diagnostics.md`、`../../PRODUCT.md`、`../../DESIGN.md` を実装可能な契約へ落とした補足調査である。競合時は Approved の要件・画面設計を優先する。

## 調査方法と一次資料

公開情報は 2026-07-18 に `agent-browser` で公式一次資料を確認した。取得した zip と Core はローカルでハッシュを取り、指定モデルは公式 Core を実際に読み込ませて互換性を検証した。

| 公式資料 | 確認した内容 |
| --- | --- |
| [Cubism SDK for Web ダウンロード](https://www.live2d.com/en/sdk/download/web/) | 2026-04-02 公開の R5 が現行であること、SDK/Core の取得導線 |
| [CubismWebFramework 5-r.5 release](https://github.com/Live2D/CubismWebFramework/releases/tag/5-r.5) | Framework の版、公開日、tag commit `198a3769c26ca3d7b600e932590433badd392edd` |
| [CubismWebSamples 5-r.5 release](https://github.com/Live2D/CubismWebSamples/releases/tag/5-r.5) | 公式 Web サンプルの版、tag commit `ed1e0b714826d92469b9e51cacc3346f4e393f03` |
| [Web Framework の利用手順](https://docs.live2d.com/en/cubism-sdk-manual/use-framework-web/) | Core を先に読み、`CubismFramework.startUp()`、`initialize()`、モデル更新、描画、破棄を行うライフサイクル |
| [Web サンプルのビルド手順](https://docs.live2d.com/en/cubism-sdk-tutorials/sample-build-web/) | Core、Framework、Resources、TypeScript サンプルの配置とビルド |
| [Core CHANGELOG 5-r.5](https://raw.githubusercontent.com/Live2D/CubismWebSamples/5-r.5/Core/CHANGELOG.md) | Core 06.00.0001、MOC 整合性と MOC version API |
| [Core RedistributableFiles](https://raw.githubusercontent.com/Live2D/CubismWebSamples/5-r.5/Core/RedistributableFiles.txt) | 再配布対象として列挙された Core の `.d.ts`、`.js`、`.min.js` |
| [Framework LICENSE](https://raw.githubusercontent.com/Live2D/CubismWebFramework/5-r.5/LICENSE.md) | Framework に添付されるライセンス本文 |

### 取得物を固定する

公式ダウンロード画面で同意後に取得できる SDK archive を正本にする。

| 取得物 | 固定値 |
| --- | --- |
| SDK URL | `https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.5.zip` |
| SDK archive | `CubismSdkForWeb-5-r.5.zip`、20 MB |
| SDK SHA-256 | `67064a7fb1812cf502f5c4a03bfe12cc638c75a621bb4acf06bb28763df06ba0` |
| Core runtime | `Core/live2dcubismcore.min.js`、228,042 bytes |
| Core SHA-256 | `8741f739779b5d5210872bd3d7d99f0f1e56e6c87409e7d26d6bb4b80aa1ef47` |
| Core declaration SHA-256 | `25fcaa2a6dfe311db95ad1795a2a7e6286d9192719df4e2c3e634915dc050334` |
| Core version | decimal `100663297`、hex `0x06000001`、06.00.0001 |
| latest MOC enum | `6`、Cubism 5.3 |

`https://cubism.live2d.com/sdk-web/core/06/live2dcubismcore.min.js` と、検証時の latest Core URL は SDK archive 内 Core と同じ SHA-256 だった。ただし、将来内容が変わり得る latest URL はビルド入力に使わない。

SDK の利用同意を CI が暗黙に代行しないよう、同期スクリプトはネットワークから自動取得せず、開発者が取得した `LIVE2D_SDK_ARCHIVE` の SHA-256 を検証して必要ファイルだけを抽出する。版を上げる場合は公式資料、archive、Core、Hiyori の実ロードを再確認し、本書の `updated` と `last_verified` を更新する。

## ローカル Hiyori PRO の確認結果

### 同梱対象

`tmp/hiyori_pro/runtime` から次の **17 runtime files** だけをコピーする。`.DS_Store`、`cmo3`、`can3`、その他の制作ファイルは同梱しない。クレジットと来歴を残すため、runtime 外の `ReadMe.txt` は pack の notice として別途コピーする。

- `hiyori_pro_t11.model3.json`
- `hiyori_pro_t11.moc3`
- `hiyori_pro_t11.physics3.json`
- `hiyori_pro_t11.pose3.json`
- `hiyori_pro_t11.cdi3.json`
- `hiyori_pro_t11.2048/texture_00.png`
- `hiyori_pro_t11.2048/texture_01.png`
- `motion/hiyori_m01.motion3.json` から `motion/hiyori_m10.motion3.json`

合計は約 4.7 MB、texture は 2 枚とも 2048 x 2048 である。`model3.json` の `Version` は 3。Expressions はなく、Physics、Pose、DisplayInfo がある。LipSync は `ParamMouthOpenY`、EyeBlink は `ParamEyeLOpen` と `ParamEyeROpen`、hit area は `Body` である。

重要なソースファイルの SHA-256 は次の通り。実装時は同期スクリプトが 17 ファイルすべての manifest を生成し、欠落・余分・ハッシュ差分を fail closed にする。

| file | SHA-256 |
| --- | --- |
| `hiyori_pro_t11.model3.json` | `9e40e4dd71beab5bef5c1df9e8223b111549bf1f836d276d1b471003cd754824` |
| `hiyori_pro_t11.moc3` | `608d62c9a65cf537ac25ca9e710e687dbef98ee0a0575e0ee8e27bfdc446cd5e` |
| `hiyori_pro_t11.physics3.json` | `c7a6d641893519c0bbc615545887f03f6c5b8031b4096873740b618370452fc1` |
| `hiyori_pro_t11.pose3.json` | `c4986e9fe16fee6d4d18fdac826bfa09917a8179d1bdfd6c44d1c33174b03893` |
| `texture_00.png` | `a7d930d42814d8fb69e787b0aef5b60e5afd52b4d4557551c8a58e5bea3a4bb1` |
| `texture_01.png` | `87fe9ab7db81ab3025e0407229e449233581e00fa92c8e911923bc6c7d98ce84` |

SDK archive にも同名系統の Hiyori sample があるが、moc3、texture、motion の一部のハッシュが指定モデルと異なる。SDK sample で代用してはならない。

### Core での実ロード

公式 Core 06.00.0001 をローカル WebView 相当の browser context へ読み込み、指定された `hiyori_pro_t11.moc3` を検査した。

| 項目 | 結果 |
| --- | --- |
| moc bytes | `444480` |
| MOC version enum | `3`、Cubism 4.0 |
| `hasMocConsistency` | `1`、正常 |
| canvas | width `2976`、height `4175`、origin `(1488, 2087.5)`、pixels per unit `2976` |
| Framework logical canvas | 約 `1.0 x 1.4028898` |
| parameters / parts / drawables | `70 / 24 / 134` |

`model3.json` の schema version と moc binary version は別の値であり、どちらか一方だけで互換性を判断してはならない。インポート時は JSON schema、Core の MOC version、`CubismMoc.hasMocConsistency()`、実モデル生成、texture decode、初回描画を順に検証する。

### モーショングループ

| group | files | metadata |
| --- | --- | --- |
| `Idle` | m01、m02、m05 | 4.70 s、5.93 s、8.57 s |
| `Flick` | m03 | 4.20 s |
| `FlickDown` | m04 | 4.43 s |
| `FlickUp` | m06 | 5.37 s |
| `Tap` | m07、m08 | 1.90 s、2.10 s |
| `Tap@Body` | m09 | 1.60 s |
| `Flick@Body` | m10 | 4.17 s |

全 10 motion は 30 fps かつ `Loop: true` である。名前だけから「成功」「エラー」などの感情を割り当てると誤解を招く。motion gallery の目視検証が完了するまでは `Idle[0]` をニュートラル表示に使い、`thinking`、`acting`、`waiting`、`reviewing`、`error`、`completed`、`disconnected` の区別は、承認済み画面設計にある HTML の状態文言と配色で必ず伝える。

## SDK の配置とビルド契約

### vendor layout

次の配置を実装時の正本とする。実際のディレクトリ名は package build に合わせてよいが、責務を混ぜない。

```text
vendor/live2d/cubism-sdk-5-r.5/
  Framework/src/**
  Framework/Shaders/WebGL/**
  Framework/LICENSE.md
  Core/live2dcubismcore.d.ts
  Core/live2dcubismcore.min.js
  Core/LICENSE.md
  Core/RedistributableFiles.txt
  LICENSE.md
  checksums.sha256

src-tauri/resources/characters/builtin-hiyori/
  pack.json
  NOTICE.txt
  runtime/**

public/vendor/live2d/
  core/live2dcubismcore.min.js
  shaders/webgl/*.vert
  shaders/webgl/*.frag
```

Core runtime と 13 個の WebGL shader は app-owned same-origin resource として package する。Framework の TypeScript は Vite bundle に入る JavaScript へ事前コンパイルする。モデル resource は bundled と custom で同じ pack protocol を通し、WebView に Rust の実パスを見せない。

### TypeScript の隔離

公式 Framework 5-r.5 は private package であり、利用できる公式 npm runtime package ではない。公式 `package.json` は TypeScript 5.9.3 を開発依存に持ち、`tsc` で `dist` を生成する。現在のアプリは TypeScript 6.0.2、`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` を使うため、Framework source を `src/` に直接置くと大量の型エラーになった。さらに公式 `moduleResolution: node` は TypeScript 6 では非推奨エラーになる。

したがって `package.json` に、アプリ用 TypeScript とは別名の build-only dependency を固定する。

```json
{
  "devDependencies": {
    "typescript-cubism": "npm:typescript@5.9.3"
  }
}
```

`node node_modules/typescript-cubism/bin/tsc -p vendor/live2d/tsconfig.json` を `build:live2d` とし、`dev` と `build` の前に実行する。生成先は `vendor/live2d/dist` など `src/` 外に置く。アプリの `tsconfig.app.json` は既に `skipLibCheck: true` なので、生成 declaration の内部を TypeScript 6 で再検査せずに利用できる。SDK sample のアプリ shell、背景、複数 canvas、document 全体の pointer listener はコピーしない。

### Core と shader の読み込み順

1. `Live2DCoreLoader.load()` が `/vendor/live2d/core/live2dcubismcore.min.js` を classic script で一度だけ読み、`globalThis.Live2DCubismCore` を確認する。
2. その後で compiled Framework module を import する。
3. app singleton が `CubismFramework.startUp(option)` と `CubismFramework.initialize()` を一度だけ呼ぶ。
4. renderer 初期化後、13 shader の same-origin base URL を `loadShaders(shaderPath)` または renderer の draw path に渡す。R5 の shader は `.vert` / `.frag` を `fetch` するため、既定の相対パスへ依存しない。
5. model switch では model、motions、textures、renderer を release するが、Framework global は維持する。
6. app shutdown で最後の controller を止めた後にだけ `CubismFramework.dispose()` と `cleanUp()` を行う。

script loader は promise を cache し、同時 mount、React Strict Mode の mount/unmount、load failure を冪等に扱う。CSP は `script-src 'self'` を維持し、remote Core、`eval`、inline script を許可しない。

## 描画 controller

### 責務と API

React component は canvas と表示状態だけを管理し、Cubism object を React state に入れない。推奨する境界は次の通り。

```ts
type CharacterState =
  | "idle"
  | "thinking"
  | "acting"
  | "waiting"
  | "reviewing"
  | "error"
  | "completed"
  | "disconnected";

interface CharacterController {
  mount(canvas: HTMLCanvasElement): Promise<void>;
  loadPack(pack: CharacterPackRef, signal: AbortSignal): Promise<void>;
  setState(state: CharacterState, generation: number): void;
  setMotionPolicy(policy: "animated" | "reduced" | "hidden"): void;
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void;
  dispose(): void;
}
```

モデル読み込みは `CubismModelSettingJson` で `model3.json` を解釈し、Moc、Textures、Physics、Pose、DisplayInfo、Expressions、Motions、UserData の相対参照を pack asset client で取得する。`CubismUserModel.loadModel(buffer, true)`、texture upload/bind、`createRenderer(width, height)`、renderer `startUp(gl)`、shader load の順で初期化する。途中失敗時は作成済み object と object URL を逆順で必ず release/revoke する。

1 frame の更新順は公式 Framework の意味を保つ。

1. monotonic clock から delta を求め、異常値と background 復帰時の delta を clamp する。
2. motion manager と expression manager を更新する。
3. eye blink、breath、physics、pose、必要な gaze/lip sync を更新する。
4. `_model.update()` 相当を行う。
5. projection と model matrix を乗算し、renderer の MVP を更新する。
6. transparent clear 後に draw する。

clear は `gl.clearColor(0, 0, 0, 0)`、context creation は alpha と premultiplied alpha を明示する。canvas は装飾であり、`pointer-events: none`、`aria-hidden="true"` または presentation role とする。状態の意味、エラー、操作は HTML へ置き、canvas だけに持たせない。

### bottom-contain と resize

S-002 の 1470 x 836 基準では、character pane は約 607.84 x 754.99。Hiyori の logical aspect は約 `1 / 1.4028898` なので、高さ制約で contain するとモデル幅は約 538 px となり、左右も切れない。

- CSS box を pane 全体に合わせ、backing store は `round(css * min(devicePixelRatio, 2))` とする。
- projection で縦横の contain scale を選び、水平中央、下端 0 に合わせる。CSS の画像 stretch で moc を変形しない。
- `ResizeObserver` を pane に 1 個だけ置き、同一値を除外して次 animation frame に反映する。
- resize 時は viewport、projection、renderer buffer を更新し、500 ms 以内に安定させる。
- 1470、1280、960 px 幅で頭頂、両手、スカート裾が切れないことを screenshot の非透明 pixel bounds でも検査する。

### motion scheduler

初期 mapping は保守的にする。

| semantic state | visual motion | HTML state |
| --- | --- | --- |
| 全状態 | `Idle[0]`、motion gallery 完了後に版管理した mapping へ拡張 | 状態ごとの既定文言を必ず表示 |
| `reduced` | motion を進めず、neutral pose の 1 frame を描画 | 通常通り |
| `hidden` | RAF を停止し、canvas を非表示 | text-only character を維持 |

motion gallery 後に拡張する場合も、状態から pack 内の allowlisted group/index へ決定的に変換し、モデルや assistant の自由文字列を asset path にしない。優先度は `error/waiting/completed > acting/thinking/reviewing > idle` を基準にし、同一 generation 内だけで割り込ませる。古い turn から遅れて届いた cue は捨て、TTL 後は `Idle[0]` に戻す。全 Hiyori motion が loop metadata を持つため、one-shot cue は明示的に停止して idle を再開する。

### pause、context loss、品質低下

- `document.visibilityState !== "visible"`、zero-size、hidden のときは RAF を停止する。
- `prefers-reduced-motion: reduce` とアプリ設定のうち厳しい方を採用する。
- `webglcontextlost` で `preventDefault()`、RAF 停止、診断イベント記録。`webglcontextrestored` では同一 manifest から一度だけ完全再構築する。
- 復旧失敗、shader fetch failure、Core mismatch、GPU 不足の順で animated から reduced/static preview、最後に text-only へ落とす。空白にはしない。
- static preview は信頼済み pack の初回成功 frame を PNG 化して app data へ保存する。未検証の外部画像や偽の人物画像を fallback にしない。

## 任意モデルの安全なインポート

### 基本方針

ユーザーは native file picker で **1 個の `*.model3.json`** を選ぶ。archive、URL、フォルダー内の自動探索、JavaScript plugin は受け付けない。現在のモデルは import と preview の全工程が成功するまで変更しない。

Rust が authority となり、model3 から次の参照閉包だけを解決する。

- Moc
- Textures
- Physics
- Pose
- DisplayInfo
- Expressions
- Motions
- UserData

各参照は percent decode や Unicode 正規化による別名を作らず、入力 JSON 文字列を platform path に一度だけ変換する。空文字、絶対パス、drive/UNC、`..`、`.` component、backslash を separator として混ぜた path、NUL、URL scheme、symlink、alias、非 regular file、root 外へ canonicalize される file を拒否する。重複参照は canonical identity で 1 file として数える。

許可する role と MIME は model JSON 群、`.moc3`、`.png` のみとし、HTML、JavaScript、SVG、実行ファイル、未知拡張子は拒否する。拡張子だけでなく magic/header と parser でも確認する。

### 制限

Approved 要件に合わせ、import 前に次を適用する。

- 最大 128 files。
- 参照閉包の合計最大 100 MiB。
- 1 file 最大 32 MiB。
- texture 最大 8192 x 8192。
- JSON nesting depth 最大 64。
- `model3.json` は現在実装する Cubism schema/version のみ。
- Core の MOC version が同梱 Core の対応範囲内であること。

Rust の PNG header parser または `image` crate の dimension reader で寸法を先に確認し、上限超過画像を WebView で decode しない。JSON parser の再帰上限だけに頼らず、parse 前後の明示的 depth walk を持つ。すべての error は安定した code、対象 role、安全なユーザー文言へ変換し、ローカル絶対パスや file content を diagnostics に残さない。

### quarantine と publish

```text
native picker
  -> validate model3 + referenced closure at source
  -> copy to app-data/characters/quarantine/<uuid>.tmp
  -> hash every copied file and re-validate from copied bytes
  -> write immutable manifest
  -> isolated preview: Core consistency, texture decode, first frame, state change
  -> fsync files + directory
  -> atomic rename to app-data/characters/library/<pack-id>
  -> database transaction marks pack selectable
```

source と copied bytes を二度検査することで、検査とコピーの間の差し替えを検出する。manifest は pack version、entrypoint、role、normalized relative asset ID、byte length、SHA-256、texture dimensions、MOC version、imported timestamp、display name、provenance を持つ。publish 後の directory はアプリから read-only として扱う。

cancel、validation failure、preview failure では quarantine を消し、選択中 pack ID を変更しない。起動時に期限切れ quarantine を掃除する。library の削除時は現在利用中かを確認し、fallback pack へ切り替えて controller が release した後に削除する。

### WebView への asset 配信

推奨は Tauri の custom URI protocol による read-only endpoint である。概念上は次の形にする。

```text
character://asset/<pack-id>/<relative-asset-id>
```

handler は `<pack-id, relative-asset-id>` が immutable manifest に完全一致する場合だけ bytes を返す。URL component を一度だけ decode し、空 component、dot segment、backslash、NUL、未知 role を拒否する。JSON は `application/json`、MOC は `application/octet-stream`、PNG は `image/png` とし、`X-Content-Type-Options: nosniff` を付ける。quarantine preview は `Cache-Control: no-store`、published pack は hash-based immutable cache を使える。

custom scheme の platform 差異が初期実装を止める場合の安全な代替は、`read_character_asset(pack_id, relative_asset_id) -> bytes` の typed Tauri command と Blob URL である。`convertFileSrc(absolutePath)` や広い filesystem scope は使わない。この代替では `blob:` を CSP の `img-src` / `connect-src` に必要最小限追加し、pack switch と dispose で全 URL を revoke する。

preview renderer は本画面と分離する。第一候補は capabilities を持たない dedicated preview WebView とし、ネットワーク、shell、filesystem command を許可せず、quarantine protocol だけを読めるようにする。first frame、neutral、state cue を確認して thumbnail を返したら破棄する。OffscreenCanvas worker は WKWebView 対応を受け入れ試験で証明できた場合だけ置き換え候補にする。

## 同梱モデルのライセンス前提と provenance

このプロジェクトでは、ユーザーから `tmp/hiyori_pro` の同梱・再配布に必要な許諾があり、Live2D の定める再配布やライセンス上の懸念はないという前提が明示されている。本調査ではその前提を公開 blocker に戻さない。

一方、将来の更新時に由来を失わないため、以下は技術的な供給網管理として維持する。

- Hiyori pack に `ReadMe.txt` を NOTICE として含め、作者表記「かにビーム」と modeler 表記「Live2D」を保持する。
- SDK/Core/Framework の LICENSE、RedistributableFiles、version、source URL、SHA-256 を package と配布物に保持する。
- custom pack は個人利用のlocal modelとしてsourceを`Local folder`へ固定し、license、権利宣言、取得元の入力を要求しない。appは同梱HiyoriのnoticeとSDKの配布条件だけを保持する。
- SDK sample Hiyori と指定 Hiyori を混ぜず、pack manifest のハッシュで差し替えを検出する。

## 実装ファイルと依存関係

### frontend

| file | 責務 |
| --- | --- |
| `src/features/character/runtime/live2d-core-loader.ts` | Core classic script の一度だけの読み込み、version check |
| `src/features/character/runtime/cubism-runtime.ts` | Framework global lifecycle、controller factory |
| `src/features/character/runtime/character-controller.ts` | model lifecycle、RAF、update/draw、resize、context recovery |
| `src/features/character/runtime/character-pack-client.ts` | pack ID と asset ID だけを使う fetch、AbortSignal、MIME 検査 |
| `src/features/character/runtime/motion-policy.ts` | semantic state から allowlisted cue への決定的 mapping |
| `src/features/character/components/Live2dCharacter.tsx` | 1 canvas、ResizeObserver、reduced/hidden、HTML fallback |
| `src/features/character/model.ts` | `CharacterState`、manifest DTO、安定した error code |
| `src/features/character/**/*.test.ts(x)` | lifecycle、state、resize、fallback の unit/component tests |

`pixi.js`、`pixi-live2d-display`、remote loader は追加しない。frontend の追加 runtime dependency は公式 Framework の compiled output のみ。build-only で `typescript-cubism@npm:typescript@5.9.3` を追加する。

### Rust / Tauri

| file | 責務 |
| --- | --- |
| `src-tauri/src/character/mod.rs` | command/protocol の狭い公開面 |
| `src-tauri/src/character/import.rs` | picker result から quarantine/publish までの transaction |
| `src-tauri/src/character/manifest.rs` | versioned manifest と role schema |
| `src-tauri/src/character/path_policy.rs` | canonical root、relative component、regular file の検査 |
| `src-tauri/src/character/validation.rs` | count/size/depth/PNG/MOC 前段検査 |
| `src-tauri/src/character/protocol.rs` | read-only pack asset protocol、MIME、cache header |
| `src-tauri/src/character/storage.rs` | app-data path、fsync、atomic rename、cleanup |
| `src-tauri/src/character/error.rs` | secret-free stable error contract |

必要な crate は、既存の `serde` / `serde_json` に加え、SHA-256、UUID、PNG dimension、安全な temporary file / atomic publish を担う小さい dependency に限定する。候補は `sha2`、`uuid`、`image` の `default-features = false, features = ["png"]`、`tempfile`、`thiserror`。実装時に workspace の既存 crate と重複を確認し、Cargo.lock で固定する。file picker は既存 Tauri dialog plugin があれば再利用し、新しい汎用 filesystem plugin permission は追加しない。

### reproducible asset scripts

| file | 責務 |
| --- | --- |
| `scripts/live2d/sync-sdk.mjs` | developer-provided archive の SHA 検査、allowlist 抽出、shader 数と Core version の検査 |
| `scripts/live2d/sync-hiyori.mjs` | `tmp/hiyori_pro` から 17 files + NOTICE だけをコピーし manifest 生成 |
| `vendor/live2d/checksums.sha256` | upstream input と抽出物の reviewable な固定値 |

同期スクリプトは source tree の未知ファイルを自動採用せず、期待 file set が変わったら停止する。

実装済み経路の操作、数値証跡、障害切り分け、後続境界は [Live2Dランタイム実装・検証ガイド](live2d-runtime-implementation.md) を正本とする。

## 受け入れ試験

### build と supply chain

- clean checkout で SDK archive の指定がない場合、意味のある手順を示して fail するか、review 済み vendor artifact だけで再現可能にする。ネットワーク latest を暗黙取得しない。
- SDK archive、Core、Hiyori のハッシュ差分、shader 13 files の不足、LICENSE/NOTICE 欠落で build が失敗する。
- Core が Framework import より先に一度だけ読み込まれ、React Strict Mode の再 mount でも重複初期化しない。
- `pnpm build` は Cubism Framework を TypeScript 5.9.3 で隔離 build し、アプリ TypeScript 6 の strict check も通る。

### 実描画と motion

- bundled Hiyori で MOC consistency、70 parameters、24 parts、134 drawables を smoke assertion できる。
- alpha 付き canvas に Hiyori の非透明 pixel が描かれ、背面の desk gradient が透ける。
- 1470、1280、960 px 幅で頭、手、裾が欠けず、水平中央・下端揃えになる。resize 後 500 ms 以内に安定する。
- `idle -> acting -> waiting -> completed -> idle` の generation test で古い cue が新しい状態を上書きしない。全状態の HTML 文言は canvas と独立して正しい。
- motion policy `reduced` は一枚の neutral frame、`hidden` は RAF 0、復帰時に巨大 delta を適用しない。
- WebGL context loss を人工的に起こし、一度だけ復旧する。復旧不能時も static/text fallback が残る。

### custom import の adversarial tests

- 正常な copied Hiyori pack は preview 後に選択でき、再起動後も manifest から描画できる。
- `../`、absolute、URL、UNC、backslash 混在、percent encoded traversal、symlink、hard-link race、root 外 canonical path を拒否する。
- 129 files、100 MiB 超、32 MiB/file 超、8193 px texture、depth 65 JSON、invalid PNG、invalid/truncated moc3、unsupported MOC version を拒否する。
- JSON が HTML/JS/SVG/executable を参照した場合、拡張子偽装を含めて拒否する。
- source 検査後に file を差し替える race で copied hash/revalidation が失敗する。
- cancel と全 failure で現行 pack が変わらず、quarantine と Blob URL が残らない。
- protocol は manifest にない asset、別 pack の asset、double decode、dot segment、未知 MIME を返さず、WebView console/diagnostics に絶対 path を出さない。

### 性能と UX

- release build、代表 Mac、cold bundled model load の first meaningful Live2D frame は p95 3 秒未満。
- idle 30 秒の median は 30 fps 以上。100 ms を超える main-thread long task を作らず、coding input latency p95 は 100 ms 未満。
- model load、texture decode、shader fetch、context restore の時間と error code を秘密なしで diagnostics に出す。
- `agent-browser` で S-002 の reference screenshot と実画面を 1470 x 836、1280、960 で比較し、continuous desk、透明 canvas、bottom-contain、mute control、text fallback を目視確認する。
- keyboard、screen reader、reduced motion、character hidden の各経路で coding、approval、interrupt、review の操作性が変わらない。

## 実装順序と完了ゲート

1. SDK/Core/Hiyori の同期スクリプト、hash、NOTICE、隔離 build を先に作る。
2. bundled Hiyori を pack manifest と read-only protocol で配信する。
3. 1 canvas の controller で neutral frame、transparent draw、resize、release を成立させる。
4. state generation、Idle scheduler、reduced/hidden、context fallback を追加する。
5. 設定画面へ picker、Rust quarantine validator、isolated preview、atomic publish を追加する。
6. motion gallery を目視レビューし、意味が確認できた cue だけを versioned mapping に追加する。
7. adversarial、performance、accessibility、`agent-browser` visual acceptance を通す。

最初の「実ランタイム」完了ゲートは、同梱 Hiyori が transparent canvas へ描画され、Idle が動き、状態文言と同期し、resize/reduced/hidden/context loss を安全に処理できること。任意モデル機能の完了ゲートは、失敗時に現行モデルを一切変えず、絶対パスを WebView に渡さず、quarantine から preview と atomic publish を通った pack だけを再起動後も選択できることである。

## 採用しない案

- SDK sample app を丸ごと React へ移植する。document listener、複数 canvas、sample background と app lifecycle が要件に合わない。
- `pixi-live2d-display` などの community wrapper を採用する。Core/Framework の版整合、配布面、障害解析の層が増える。
- runtime を CDN から読む。offline desktop、CSP、再現性、供給網の要件を満たさない。
- SDK sample Hiyori を指定 asset の代わりに使う。実ファイルのハッシュが異なる。
- custom model directory を filesystem scope で WebView に公開する。絶対 path と未検証 file を露出する。
- model3 を選んだ時点で現行モデルを切り替える。preview failure 時の回復不能な状態を作る。
- motion filename や assistant の文章から感情を推測する。状態の誤伝達と非決定的挙動を生む。
