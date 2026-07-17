---
title: "LIVE Live2Dコンパニオン要件定義"
description: "同梱Hiyori、semantic state、縮退、ユーザーmodelの安全なimport・選択を定義する。"
updated: 2026-07-18
read_when:
  - "Live2D renderer、character pack、state mappingを実装するとき。"
  - "ユーザーmodel importのsecurity、boundary、fallbackを検証するとき。"
---

# Live2Dコンパニオン 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `LIVE` |
| 状態 | Approved |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-18 |
| 最終レビュー日 | 2026-07-18 |

## 背景

Live2DはSolの状態を周辺視野で楽しく把握する中心体験だが、asset差分、WebGL failure、任意local pathが安全性と可用性を損なり得る。同梱Hiyoriとユーザーmodelを同じ検証済みpack境界で扱い、文字の証拠を常に残す必要がある。

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| 既定companionを確実に表示する | cold startでHiyoriがdemo比率の右paneへ収まり、状態に反応する |
| model差分へ安全に対応する | motion/expression欠落時もneutral/static/textへ縮退し、Chatを止めない |
| ユーザーmodelを設定可能にする | model3.jsonを隔離・検証・previewし、projectごとに選択・復元できる |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| Bundled pack | `tmp/hiyori_pro/runtime`由来の17 runtime fileとnotice |
| Rendering | Cubism SDK/Core、透明single canvas、resize、WebGL recovery |
| Semantic state | idle、thinking、acting、waiting、reviewing、error、completed、disconnected |
| Accessibility | text equivalent、hide、reduced motion、static/text-only fallback |
| Custom pack | model3 picker、quarantine、validation、copy、preview、mapping、project selection |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| zip/archive import | zip slipとarchive bombをMVP攻撃面から外す | 将来検討 |
| model editor | geometry、texture、motion自体は編集しない | Live2D Cubism Editor |
| marketplace/download | 外部network assetと権利処理を含めない | 将来検討 |
| 複数character同時表示 | main Solの一人格を明確にする | 非対象 |
| expression必須 | Hiyoriはexpression fileを持たない | motion/parameter/neutral fallback |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ローカル利用者 | modelの権利と選択を管理する本人 | import、preview、mapping、select、hide、delete | invalid packは登録せず現在modelを維持する |
| Rust character service | local assetの信頼境界 | picker result検証、quarantine copy、manifest、limited asset URL | root外参照、URL、symlink、過大assetを拒否する |
| WebView renderer | 検証済みpackを描画する非信頼表示層 | pack IDとrelative asset IDのload、semantic cue再生 | absolute path、任意URL、scriptをloadしない |
| Codex/support output | operational stateの入力 | allowlist semantic cueだけを要求 | path、motion file、parameter式の直接指定を無視する |

## 機能要件

### 同梱Hiyoriと描画

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `LIVE-F-055` | appは指定Hiyori runtimeを同梱する | `hiyori_pro_t11.model3.json`、moc3、texture 2件、physics、pose、cdi、motion 10件の17fileをrelease resourceから解決できる | Approved | 非該当 |
| `LIVE-F-056` | appは編集用assetを配布へ含めない | release resourceに`.cmo3`、`.can3`、`.DS_Store`がなく、runtime packとnoticeだけが存在する | Approved | 非該当 |
| `LIVE-F-057` | companionはdemo比率で表示される | 1470×836で607.84×754.99px paneへbottom-containし、頭頂、両手、裾がcanvas外へ切れない | Approved | 非該当 |
| `LIVE-F-058` | rendererはwindow resizeへ追従する | 1470×836、1280×800、960×640の各resize後500ms以内にcontain scaleを再計算し、composerまたはdecisionを覆わない | Approved | 非該当 |
| `LIVE-F-059` | rendererは一つのactive canvasだけを保持する | workspace/modelを20回切り替えても描画canvasが1枚で、旧texture/motion/WebGL resourceが参照されない | Approved | 非該当 |
| `LIVE-F-060` | appは同梱assetのprovenanceを表示する | Settingsからpack名、creator、source notice、同梱version/hashへ到達できる | Approved | 非該当 |

### Semantic stateと縮退

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `LIVE-F-061` | companionはoperational stateへ決定的に反応する | idle/thinking/acting/waiting_for_user/reviewing/error/completed/disconnectedの同じevent列で毎回同じcue優先順位になる | Approved | 非該当 |
| `LIVE-F-062` | state mappingはasset inventoryに存在するcueだけを使う | HiyoriでIdle/Flick/FlickDown/FlickUp/Tap/Tap@Body/Flick@Body以外のmotion fileを要求せず、missing cueはneutralへ戻る | Approved | 非該当 |
| `LIVE-F-063` | expressionがないpackでも全stateを表示できる | Expressionsが0件のfixtureでrendererが起動し、state labelとmotion/pose/neutral fallbackを表示する | Approved | 非該当 |
| `LIVE-F-064` | meaning stateはHTML textでも表示される | canvasをhideまたはaccessibility treeから除外しても、現在state、uncertainty、waiting、verification resultをvisible text/live regionで確認できる | Approved | 非該当 |
| `LIVE-F-065` | 利用者はcharacterをhideできる | Hideを有効にするとcanvasとGPU animationを停止し、Chat幅とtext stateを残し、再起動後も設定が戻る | Approved | 非該当 |
| `LIVE-F-066` | reduced motionはidle/decorative motionを停止する | reduced motion時はstatic poseとtext stateだけを残し、one-shot warning cueも動きではなくicon/textで伝える | Approved | 非該当 |
| `LIVE-F-067` | renderer failureは段階的に縮退する | context lostまたはasset errorでanimated→reduced→static preview→text-onlyへ移行し、Chat送信・decision・reviewを継続できる | Approved | 非該当 |

### ユーザーmodel import

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `LIVE-F-068` | 利用者はmodel3.jsonを1件選択してimportできる | OS pickerでregular `.model3.json`を選ぶと検証結果、file数、合計size、motion/expression inventoryをpreview前に表示する | Approved | 非該当 |
| `LIVE-F-069` | 利用者はimport pickerをcancelできる | cancel時にquarantine/library/DBを変更せず、現在選択modelとSettings入力を維持してerrorを表示しない | Approved | 非該当 |
| `LIVE-F-070` | importerはmodel参照closureを検証する | Moc、Textures、Physics、Pose、DisplayInfo、Expressions、Motions、UserDataの存在する参照を収集し、root内regular fileだけを受理する | Approved | 非該当 |
| `LIVE-F-071` | importerは危険参照を拒否する | `..`、absolute path、`file/http/https` URL、symlink/alias解決後のroot外参照、HTML、JavaScript、実行可能fileを含むpackを登録しない | Approved | 非該当 |
| `LIVE-F-072` | importerはresource境界を適用する | file数128以下、合計100MiB以下、1file 32MiB以下、texture各8192×8192以下、JSON depth 64以下だけを受理する | Approved | 非該当 |
| `LIVE-F-073` | importerはquarantineからatomicに昇格する | 全fileをquarantineへcopyして再hash・再検証し、manifest作成後のatomic rename成功時だけlibraryへpack IDを追加する | Approved | 非該当 |
| `LIVE-F-074` | WebViewはimport元absolute pathを受け取らない | import完了payloadとrenderer requestにpack UUIDとrelative asset IDだけが含まれ、source path/home pathがない | Approved | 非該当 |
| `LIVE-F-075` | 利用者はimport packをpreview後に選択できる | previewのfirst frameとstate testが成功した後だけSelectを有効にし、projectごとのpack IDを保存する | Approved | 非該当 |
| `LIVE-F-076` | import失敗は現在modelを壊さない | malformed、missing、unsupported MOC、I/O失敗の各fixtureで現在pack選択とrenderingが継続し、失敗packがlibraryに残らない | Approved | 非該当 |
| `LIVE-F-077` | 利用者はpackごとのsemantic mappingを設定できる | inventoryに存在するmotion/expression/parameterだけをstateへ割り当て、未割当stateをneutralとして保存できる | Approved | 非該当 |
| `LIVE-F-078` | 利用者は未使用custom packを削除できる | active projectで未選択のcustom packだけを確認後削除し、bundled Hiyoriと選択中packのDeleteを無効にする | Approved | 非該当 |

### 性能とinteraction boundary

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `LIVE-F-079` | bundled modelは短時間でfirst frameを表示する | Apple Silicon・release build・cold cacheでS-002表示からfirst frameまでのp95が3,000ms以下になる | Approved | 非該当 |
| `LIVE-F-080` | animationは基準端末で操作を妨げない | 60秒のacting stateでmedian 30fps以上、main-thread long task 100ms超が0回、Chat入力latency p95 100ms以下になる | Approved | 非該当 |
| `LIVE-F-081` | canvasは主要UIのpointerを奪わない | companion以外のChat、composer、decision、muteへpointer/keyboard操作でき、透明canvas領域がそれらをblockしない | Approved | 非該当 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| Import | model3.json | なし | 必須 | regular `.model3.json` 1件、archive不可 | 現在pack維持、理由と拒否file表示 |
| Import | pack display name | model Nameまたはfilename | 必須 | trim後1〜80文字 | 入力保持、Select無効 |
| Mapping | semantic cue | neutral | 必須 | inventory内IDまたはneutral | 不正IDを保存しない |
| Display | character visibility | visible | 必須 | visible/hidden | 保存失敗時は現在表示維持 |
| Display | reduced motion | APP設定継承 | 必須 | inherit/on/off | 不正値はinherit |

## デスクトップ固有要件

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | macOS 14以降のWebGLとfile picker | `LIVE-F-057`, `LIVE-F-068` |
| ウィンドウ生成・再利用 | main windowのsingle canvasを再利用 | `LIVE-F-059` |
| 閉じる・アプリ終了 | audio/animationを停止しGPU resourceをrelease | `LIVE-F-059`, `LIVE-F-067` |
| 未保存データ | preview中mappingはSelectまで確定しない | `LIVE-F-075`, `LIVE-F-077` |
| ローカルデータ | bundled/imported packをapp libraryで管理し、projectへpack IDを保存 | `LIVE-F-073`〜`LIVE-F-075` |
| オフライン | bundled/imported local packは表示可能 | `LIVE-F-055`, `LIVE-F-075` |
| ファイル・OS操作 | picker cancel、permission、quarantine、atomic rename | `LIVE-F-068`〜`LIVE-F-076` |
| メニュー・ショートカット | hide/muteにaccessible toggle、importに標準picker | `LIVE-F-065`, `LIVE-F-068` |
| Deep Link・ファイル関連付け | 非該当: model file associationを登録しない | 非該当 |
| 通知 | renderer/import errorはSettingsとtext statusへ表示 | `LIVE-F-067`, `LIVE-F-076` |
| Capability・認可 | character libraryと限定asset protocolだけを許可 | `LIVE-F-071`〜`LIVE-F-074` |
| アップデート・互換性 | unsupported model/MOC versionを拒否し、既存packを維持 | `LIVE-F-076` |

## 画面・UI

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-002` | コーディングワークスペース | `LIVE-F-057`〜`LIVE-F-067`, `LIVE-F-079`〜`LIVE-F-081` | 変更 | [画面詳細仕様](../screen-design/S-002_coding-workspace.md) |
| `S-004` | 設定・診断 | `LIVE-F-055`〜`LIVE-F-081` | 変更 | [画面詳細仕様](../screen-design/S-004_settings-diagnostics.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | source pathをWebViewへ渡さず、URL/symlink/traversal/script/過大assetをRustで拒否する |
| 権限 | picker選択root、quarantine、character library、限定asset protocolだけをscope化する |
| プライバシー | model fileを外部送信しない。noticeとhashはlocal保存する |
| 監査・ログ | pack ID、manifest hash、validator result、selection、fallback levelを記録し、source home pathをredactする |
| 性能 | first frame p95 3,000ms、median 30fps、input p95 100ms、file/texture境界はLIVE-F-072 |
| 信頼性・復旧 | context lost、model switch、invalid packでChatを停止せず、現在modelを維持する |
| アクセシビリティ | canvasをdecorative扱いにし、state text、hide、reduced motion、keyboard muteを提供する |
| 多言語・地域 | Settings/error/state labelはja/en、asset内固有名とfile nameは翻訳しない |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| Hiyori許諾 | 同梱・再配布の許諾済みというユーザー指示 | 解決済み | notice/provenanceは保持する |
| Cubism SDK/Core | version/hash固定でapp resourceへbundle | 解決済み（採用決定、integration test待ち） | 描画失敗時はstatic/text fallback |
| Hiyori inventory | runtime 17file、motion 10、expression 0 | 解決済み（実測） | mappingは存在cueだけを使う |
| APP | CSP、Capability、reduced motion | 解決済み（相互参照確認済み） | 独立レビューで整合確認 |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| Hiyori motionの意味 | visual QA完了まではIdle/neutralだけを確定し、他stateはfallback | motion galleryでm01〜m10を記録する | いいえ |
| zip import | MVP非対象 | model3 import利用試験後に評価する | いいえ |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [PRODUCT.md](../../PRODUCT.md) | companionの役割とanti-coercion |
| [DESIGN.md](../../DESIGN.md) | pane寸法、連続面、fallback、motion |
| [Live2D runtime調査](../research/05-live2d-runtime.md) | pack、renderer、import boundary |
| [セキュリティ調査](../research/09-security-privacy.md) | quarantine、asset URL、CSP |

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 2026-07-18 |
| 残る非ブロック論点 | motion意味のvisual QA、zip importはfallback/MVP非対象で解決済み |

## 着手可チェック

- [x] 背景と目的が説明できる。
- [x] スコープ内・外と理由が明確である。
- [x] 全機能要件に一意な要件IDがある。
- [x] 全機能要件に検証可能な受け入れ条件がある。
- [x] 正常系、異常系、キャンセル、権限差分、空状態、境界値を確認した。
- [x] デスクトップ固有要件を確認し、非該当も明記した。
- [x] 画面IDと要件IDの相互参照が一致し、承認済み画面詳細仕様を参照している。
- [x] 非機能要件と依存関係を確認した。
- [x] 着手ブロックが「はい」または「不明」の未確定事項がない。
- [x] 仕様責任者がレビューし、合意した。
