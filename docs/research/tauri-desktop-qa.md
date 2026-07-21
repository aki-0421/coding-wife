---
title: AIエージェント向けTauriデスクトップQA
description: WebdriverIOとembedded WebDriverでmacOS上の実Tauriアプリを安全に起動・操作・診断する開発時契約を定義する。
updated: 2026-07-20
read_when:
  - AIエージェントまたは開発者がCoding Wifeの実ウィンドウを操作してUI、IPC、Rust連携を調査するとき。
  - WebdriverIO、TauriのQA用plugin、デスクトップE2E、スクリーンショット証跡を変更するとき。
---

# AIエージェント向けTauriデスクトップQA

## 結論

macOSでCoding WifeのUIと挙動を検証するときは、WebdriverIO、
`@wdio/tauri-service`、embedded WebDriverを使う。通常のブラウザへVite画面だけを
表示する方法は、Tauri IPC、Rust backend、WKWebView、native windowの検証を代替しない。

```text
AI agent / WebdriverIO
  -> embedded WebDriver
  -> debug-only Coding Wife QA binary
     -> React in WKWebView
     -> Tauri IPC
     -> Rust backend
```

公開Web情報の調査と、Coding Wife実アプリのQAは別の責務である。公開情報は利用可能な
Web検索またはHTTP取得手段で公式一次資料を確認し、アプリQAには本書のデスクトップ経路を
使う。旧Webフロントエンド自動化CLIはどちらの正規経路にも含めない。

## 対象

- 実Tauri window上の表示、click、入力、scroll、keyboard操作。
- ReactからTauri IPCを経由するhappy pathとerror path。
- `browser.tauri.execute()`によるread-onlyなruntime診断。
- frontend consoleとRust標準出力の取得。
- 失敗時のスクリーンショットとログ保存。
- 1470 x 836、1280 x 800、最小960 x 640論理pxのnative window。
- 日本語、英語、keyboard、reduced motionを含む主要な受け入れ条件。

対象外はmacOSのファイル選択・権限dialog、Dock、menu barなど、WebView外のOS UIである。
必要になった時点でAppium Mac2またはXCTestを別レイヤーとして評価する。Coding Wifeの
native最小幅は960pxなので、480pxのブラウザviewportをnative QAの完了証拠にしない。

## ビルドと実行契約

正規入口は次とする。

```bash
pnpm test:desktop
```

このcommandは、QA専用Tauri設定とCargo featureでdebug binaryを作り、
`e2e/desktop/**/*.spec.ts`を実行する。調査中に一つのspecだけを再実行するときは、先に
同じQA buildを作ったうえでWebdriverIOへ`--spec`を渡してよい。

通常featureの`cargo test`、`cargo build`または別のTauri buildは、同じ
`src-tauri/target/debug/coding-wife`をQA pluginなしのbinaryで上書きできる。Rustの検証を
QA build後に実行した場合は、WebdriverIOを再実行する前に必ずQA専用Tauri buildを作り直す。
embedded WebDriverへ接続できない状態をUI不具合として調査してはならない。

WebdriverIOがbinaryを起動・終了し、既に起動している`pnpm tauri:dev`へ後付け接続しない。
同時実行数は1とする。embedded WebDriver portは
`CODING_WIFE_WDIO_PORT`、次にConductorの`CONDUCTOR_PORT + 5`、最後に4445の順で決める。
`wdio.conf.ts`は決定したportを`TAURI_WEBDRIVER_PORT`にも設定する。
embedded providerの`browser.tauri.execute()`はこの環境変数からdirect-evalの接続先を読むため、
設定を外すとDOM操作は成功してもRust IPCだけが`fetch failed`になる。

app data directoryはportごとに再利用される。setup overviewを期待するstartup/window sizing
specを手動で繰り返す場合は、未使用の`CODING_WIFE_WDIO_PORT`を指定してpristine stateを作る。
過去のsetup済みdataを持つportでoverviewが出ない状態をUI退行として扱ってはならない。
同じportの再利用は、workspace restoreや履歴復元を意図的に検証するときだけ行う。

`@wdio/tauri-service@1.2.0`は`installMockSyncOverride`をimportするが、同packageが指定する
`@wdio/native-utils@2.4.0`はそのexportを含まない。`package.json`のpnpm overrideで2.5.0へ
固定しているのはこの公開package間の不整合を避けるためである。overrideを外すのは、上流の
依存指定が修正された版へ更新し、`pnpm test:desktop`で実起動とIPCの両方を確認するときに限る。

## ウィンドウサイズ契約

受け入れ条件の幅と高さはCSS viewportと同じ論理pxを表す。macOSのembedded WebDriverは
`setWindowSize`と`getWindowSize`を物理pxとして扱うため、Retina環境で
`browser.setWindowSize(960, 640)`を直接呼ぶとCSS viewportは480 x 320になる。
この状態を960 x 640のnative検証として報告してはならない。

デスクトップspecは`e2e/desktop/support/window.ts`の`setLogicalWindowSize`を使う。
helperは`window.devicePixelRatio`を掛けた物理サイズをWebDriverへ渡し、最終的な
`document.documentElement.clientWidth`と`clientHeight`が要求した論理サイズに一致するまで
待機して検証する。スクリーンショットは物理pxで保存されるため、device pixel ratioが2の
環境では960 x 640論理pxの画像が1920 x 1280pxになるのが正しい。

## Productionとデータの境界

- `tauri-plugin-wdio`と`tauri-plugin-wdio-webdriver`はCargoの`desktop-qa` featureでのみ
  有効にする。
- `desktop-qa` featureをrelease profileで有効にしたbuildはcompile errorにする。
- global Tauri APIと`wdio:*` capabilityはQA専用Tauri設定だけへ追加する。
- frontend bridgeは`VITE_DESKTOP_QA=true`のQA buildだけへ含める。
- app processは`TAURI_WEBDRIVER_PORT`がある場合だけQA pluginを登録する。
- QAのapp dataは`tmp/desktop-qa/app-data-<port>`へ隔離し、通常のCoding Wifeデータを
  読み書きしない。
- E2Eからprojectを登録する場合は`/tmp`またはrepositoryのignore済み`tmp/`に作った
  disposable repositoryだけを使う。利用者の実repositoryを使わない。
- macOS folder pickerを介さずCodex接続を縦断検証するときは、`desktop-qa` featureと
  `CODING_WIFE_DESKTOP_QA_DATA_DIR`の両方が有効なbinaryにだけcompileされる
  `desktop_qa_register_workspace_fixture`を使ってよい。このcommandはabsolute pathをQA
  process内だけで受け、productionと同じGit repository、owner、writable policyのvalidatorを
  通す。production invoke handlerへcommandまたはraw path requestを含めない。
- screenshot、log、一時specは`tmp/desktop-qa/`または`.context/`へ保存し、commitしない。

QA pluginは任意JavaScript実行とIPC mockを提供するため、release binaryへ登録しないことを
安全条件とする。production build、release app、DMGにQA markerまたはQA bridgeが含まれない
ことは既存のproduction bundle検査とrelease検証の責務に含める。

## Agent workflow

1. `.agents/skills/tauri-wdio-debug/SKILL.md`を読み、対象scenarioと期待結果を明文化する。
2. 既存specで再現できない場合だけ、commit対象のspecまたは`.context/`の一時specを作る。
3. semantic role、accessible name、安定した`data-testid`を優先して要素を選ぶ。
4. 実Tauri binaryをWebdriverIOから起動し、UI操作と必要最小限のread-only診断を行う。
5. frontend/backend log、screenshot、観測結果から原因を特定する。
6. 作業で起動したprocessが終了したことを確認し、証跡はignore済み領域だけへ残す。

テストを通すためにproduction挙動をmockへ置換しない。IPC mockは狭いfrontend error stateを
決定論的に再現する場合に限り、実IPCのvertical pathとは別scenarioとして扱う。

## CIとreleaseの境界

`pnpm test:desktop`はmacOS GUI sessionとdebug Tauri buildを必要とするため、通常の
Pull Request CI、`pnpm test`、`pnpm quality:check`へ暗黙には追加しない。ハッカソンの
release候補では、対象commitを固定した後に明示的に実行し、実行環境、scenario、結果、
保存した証跡をevidenceへ記録する。未実施のdesktop QAを成功として報告しない。

## 参考一次資料

- [Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/)
- [WebdriverIO Tauri plugin setup](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup/)
- [WebdriverIO Tauri configuration](https://webdriver.io/docs/desktop-testing/tauri/configuration/)
- [WebdriverIO Tauri platform support](https://webdriver.io/docs/desktop-testing/tauri/platform-support/)
