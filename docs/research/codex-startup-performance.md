---
title: "Codex App Server起動性能の設計監査"
description: "Coding Wifeのアプリ起動とCodexセッション開始を遅らせていた待機依存、重複プロセス、バイナリ検証を公式仕様と公開実装に照らして整理する。"
updated: 2026-07-21
last_verified: 2026-07-21
read_when:
  - "アプリ起動、workspace復元、Codex接続、thread開始の待機時間を変更または診断するとき。"
  - "Codex binary trust、schema probe、App Server processの再利用境界を変更するとき。"
---

# Codex App Server起動性能の設計監査

## 結論

遅延の主因はCodex App Server自体ではなく、Coding Wife側で独立して実装された三つの待機が直列・重複していたことにある。

1. Reactのworkspace hydrationが、履歴取得だけでなく`codex_connect`、schema生成、全handshake、`thread/start`まで待っていた。
2. Native readinessの短命setup processと、workspace用の常駐processが同じ復元barrier後に並行起動し、同じbinary discoveryを重複実行していた。
3. 約260 MiBのCodex実行ファイルについて、1回のdiscovery・schema probe・spawnの各境界でSHA-256全量読込を繰り返していた。ローカル観測ではschema生成そのものより、重複した実行ファイル読込の方が支配的だった。

したがって、秒数を緩和したりtimeoutを延ばしたりするのではなく、表示・接続・検証の所有境界を変更する。

- workspace履歴を復元した時点でshellを描画し、Codex activationは購読可能なbackground stateとして開始する。
- supervisorは同じworkspaceのready runtimeを冪等に再利用する。
- setup probeと通常connectを同じlifecycle lockへ入れ、直前に検証したbinary evidenceを共有する。
- SHA-256はbinary observation epochの開始時に一度取得する。その後の直近process境界はcanonical path、owner、device、inode、size、mtime、ctime、mode、親directory trustを照合し、metadataが変化した場合だけcacheを破棄してfull verificationへ戻る。
- schemaはexact verified binary identityへ束縛したin-memory cacheとして再利用し、binary metadataまたは選択pathが変わった場合だけ再生成する。

これは「N秒以内」を合否にする最適化ではない。回帰試験は、未完了Promiseを使った待機依存と、fake App Serverのprocess・version・schema・initialize呼出回数を検証する。

## 公式App Server契約との照合

2026-07-21に[Codex App Server公式ドキュメント](https://developers.openai.com/codex/app-server/)と[公式app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)を再確認した。

| 公式契約 | Coding Wifeの修正前実装 | 判断 |
| --- | --- | --- |
| transport connectionごとに`initialize`を1回送り、`initialized`通知後に他methodを使う。再initializeは拒否される | workspace recheckや重複activationでready processを終了し、新しいconnectionを初期化し直せる | 同一workspace・同一binary・ready runtimeへの`connect`を冪等化する |
| 1 connection上でthread APIとserver notificationを継続利用できる | setup診断とmain sessionを別processにすること自体は正しいが、同じ起動barrierで無調整に競合していた | setupとmainをlifecycle single-flight化し、mainが既にreadyならsetup processを作らない |
| `thread/resume`は`excludeTurns: true`で過去turn本体を除外できる | 既に`excludeTurns: true`を送っている | 維持する。履歴本体はapp-owned HISTから復元する |
| `generate-json-schema` / `generate-ts`はversion固有client artifactを生成するcommand | 通常connectのたびにschemaを再生成していた | exact binary identity単位で生成・構造検証し、同一process世代内でcacheする |
| account、config、modelは各専用methodで取得する | 通常handshakeで毎回取得していた | 新connectionのpreflightとして維持するが、ready connectionの再要求では繰り返さない |

公式仕様は複数workspaceを1 processで扱うことも妨げない。しかし現行supervisorはevent、opaque handle、approval、turnを1 active workspace generationへ強く束縛している。今回processをworkspace横断で共有すると安全性の再設計が必要になるため、常駐processは引き続きactive workspace単位とし、binary/schema evidenceだけを安全に共有する。

## 公開実装との比較

公開実装はwire payloadをコピーする対象ではなく、process lifecycleの比較材料として確認した。

| 実装 | 確認した設計 | Coding Wifeへの採否 |
| --- | --- | --- |
| [OpenAI `app-server-client`](https://github.com/openai/codex/tree/main/codex-rs/app-server-client) | process開始、initialize、bounded queue、graceful shutdownを一つのclient lifecycleに集約する | lifecycle集約とinitialize-onceを採用する。公式typed protocolを正本にする |
| [Jean `codex_server.rs`](https://github.com/coollabsio/jean/blob/main/jean-core/src/chat/codex_server.rs) | globalな長寿命server、idempotentな`ensure_running`、thread別event routing、idle後のwarm保持 | idempotent reuseを採用する。detached socketと長時間warm policyは今回採用しない |
| [Eclaire `manager.ts`](https://github.com/eclaire-labs/eclaire/blob/main/packages/ai/src/cli/appserver/manager.ts) | long-lived server、二重確認付き初期化mutex、thread mutex、crash restart | single-flightとcrash recoveryの考え方だけを採用する。wire contractは公式schemaを優先する |
| [Symphony `app-server-client.ts`](https://github.com/OasAIStudio/symphony-ts/blob/main/src/codex/app-server-client.ts) | lazy startと単一start Promiseで、一つのsession中はchildを保持する | lazy/single-flightを採用する。shell経由spawnは採用しない |

一部公開実装は`bash -lc`経由でApp Serverを起動する。Coding Wifeでは、利用者のdefault login shellを`command -v codex`による探索だけに使う。認証はCodexが所有する`HOME`、`CODEX_HOME`、credential storeとallowlist済み環境をexact canonical binaryへ継承するため、App Server本体をshell scriptの評価対象にする必要はない。これによりユーザー認証を維持しつつ、stdout JSONL汚染、profile副作用、探索後のbinary差し替えを避ける。

## 修正前のクリティカルパス

```text
workspace restore barrier
  ├─ Native readiness
  │    └─ discover + version + short-lived app-server + initialize + shutdown
  └─ workspace loadState
       └─ history snapshot
            └─ discover + version + schema generation + main app-server
                 └─ initialize + account/read + config/read + model/list
                      └─ thread/start or thread/resume
                           └─ React hydration complete
```

`WorkspaceShell`はさらにnative readiness snapshotも待ち、pending中は内容のない`main`だけを返していた。このため、binary verificationとnetwork-backed model discoveryの遅延が、そのまま空windowの長さに見えていた。

## 修正後の所有境界

```text
workspace restore barrier
  ├─ history snapshot ──> shellを描画
  │                         └─ background activationを状態表示
  └─ supervisor lifecycle single-flight
       ├─ setupが先: verify once -> short initialize -> cache evidence -> main connect
       └─ mainが先: verify/schema/connect -> setupはready evidenceを再利用
```

通常接続の完了前はSendだけを無効にし、timeline、draft、workspace navigationは利用可能にする。接続失敗はsetup overviewへ巻き戻さず、Composerの安全なerror codeとReconnectに反映する。

## Binary trustとcache失効

full hashを省略できるのは、直前のfull verificationと同じ観測epoch内で次をすべて満たす場合だけである。

- canonical pathが一致する。
- owner UID、device、inode、size、mtime秒・ナノ秒、ctime秒・ナノ秒が一致する。
- regular executableで、group/other writableではない。
- 親directory chainのowner・symlink・writable policyが引き続き成立する。
- 明示pathがある場合は、そのcanonical pathとcacheのpathが一致する。

一つでも変化した場合、binaryとschemaのcacheを同時に捨て、discovery、full SHA-256、version、schema構造検証から再開する。spawn直後にもmetadata identityを照合し、差し替え時はprocess groupを終了する。初回full hash中もopen file descriptorのidentityを前後比較する既存境界を維持する。

## 非目標

- timeout値を大きくして遅延を隠さない。
- wall clockの秒数をassertするtestを追加しない。
- auth fileやtokenをアプリ側cacheへコピーしない。
- readyでないconnection、binary identityが変化したcache、別workspaceのthread handleを再利用しない。
- 今回の変更で複数workspaceを一つのApp Server processへ多重化しない。
