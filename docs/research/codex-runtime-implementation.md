---
title: "Codex runtime実装ガイド"
description: "Codex App Server adapterのファイル責務、不変条件、fake process試験、共有契約、live smokeの実行方法を記録する。"
updated: 2026-07-18
read_when:
  - "Codex runtimeのprocess監督、IPC、event parser、session storeを変更するとき。"
  - "Codex CLI更新後の互換性、障害復旧、privacy gateを検証するとき。"
---

# Codex runtime実装ガイド

## 適用仕様

接続方式と採用判断は[Codex App Server接続契約](codex-app-server-integration.md)を正本とする。上位要件は[codex-main-session](../requirements/codex-main-session.md)と[support-agent-orchestration](../requirements/support-agent-orchestration.md)である。

現在のadapter versionとevent schema versionはそれぞれ1である。OpenAI App Serverのraw unionはRust内へ閉じ込め、WebViewにはCoding Wife固有のtyped responseと正規化済みeventだけを渡す。

## 実装上の不変条件

1. active App Server processは1件だけにし、workspace generationを跨ぐeventとpending requestを適用しない。
2. `gpt-5.6-sol`だけを許可し、各turnでmodelと`low`または`max`を明示する。service tierは送らない。
3. 切断後にuser turnを自動再送しない。interrupt responseはterminal eventとして扱わない。
4. command approval、file change approval、permissions approvalの3 methodだけを受け付ける。未知request、invalid RUI、未登録dynamic toolはfail closedにしてactive turnをinterruptする。
5. raw reasoning、secret、home/workspaceのprivate absolute path、raw stderr、raw protocol payloadをWebView eventへ出さない。
6. thread、turn、item、pending IDはopaque handleへ変換し、WebViewからraw App Server IDを参照できないようにする。
7. support isolationは明示的なtool 0、cwdなし、filesystem/shell/MCPなしを証明できない限り`unavailable`である。現行実装のsupport capacityは0で、生成文を含まない決定的fallbackだけを返す。

## Support isolation gate

| 必要条件 | Codex 0.144.xの証拠 | 判定 |
| --- | --- | --- |
| `ephemeral=true` | responseで確認 | 対応 |
| `thread/list`へ残らない | 同じ接続で非列挙 | 対応。ただし全永続先は別監査が必要 |
| cwdなし | responseはAbsolutePathBufで、実測もworkspace cwd | 非対応 |
| runtime workspace rootなし | 実測1件 | 非対応 |
| dynamic tool 0 | `dynamicTools=[]`はclient-defined toolだけ | 未証明 |
| shell/file/MCP 0 | thread単位の完全allowlistがschemaにない | 未証明 |
| raw prompt/response非永続 | アプリ側では実装可能 | 対応可能 |

このため通常support sessionと固定reviewer support sessionはともに0件である。main event、Git/test/checkpoint metadata、既知error codeから固定summary keyを選ぶだけにし、AIの提案や自動判断を生成しない。

再評価にはbuilt-in tool deny-all、null cwd、null workspace rootをgenerated schemaとruntime probeの双方で確認する必要がある。モデルの自己申告は隔離証明にしない。

## ファイル責務

### Rust

| ファイル | 責務 |
| --- | --- |
| `src-tauri/src/codex/binary.rs` | binary discovery、canonical実体検査、hash、同じbinaryによるschema probe |
| `jsonl.rs` | incremental framing、UTF-8、line/buffer上限 |
| `rpc.rs` | request ID相関、timeout、server request/notification signal |
| `protocol.rs` | 使用するApp Server subset、固定outbound parameter、model gate |
| `process.rs` | 子process、環境allowlist、redacted stderr ring、5秒以内の段階的終了 |
| `requests.rs` | approval/RUI exact validation、duplicate request ledger |
| `normalizer.rs` | opaque handle、redaction済みCodexEventとDomainEvent |
| `supervisor.rs` | handshake、thread/turn/review、single active turn、restart budget |
| `support.rs` | isolation unavailable時のcapacity 0と決定的fallback |
| `commands.rs` | WebViewへ公開するtyped Tauri command |
| `types.rs` | adapter v1のpublic DTOとserde contract |
| `src-tauri/tests/codex_supervisor.rs` | fake process integrationとopt-in live smoke |

### TypeScript

| ファイル | 責務 |
| --- | --- |
| `src/lib/contracts/codex.ts` | response/eventのexact-key parserとpublic DTO |
| `src/features/codex/transport.ts` | Tauri invoke/listen境界と決定的demo transport |
| `src/features/codex/session-store.ts` | generation、sequence、duplicate、pending response state |
| `src/features/codex/client.ts` | event購読とpending responseのsingle-claim制御 |
| `src/test/fixtures/codex-runtime.v1.json` | RustとTypeScriptが共有するpublic contract fixture |

`CodexEvent`はbase fieldだけでなくvariant payloadもcamelCaseでserializeする。Rust round-tripとTypeScript parser testが同じfixtureを読むため、一方だけのfield名変更はgateで失敗する。

## Fake App Server

`src-tauri/tests/fixtures/fake_codex_app_server.py`は`--version`、schema生成、stdio app-serverを実装したtest executableである。`CODING_WIFE_CODEX_FAKE_MODE`で次を選ぶ。

| mode | 検証内容 |
| --- | --- |
| `fragmented` | 分割JSONL、handshake、固定turn contract、interrupt |
| `out_of_order` | 応答順変更、ID相関、timeout後の非再送 |
| `malformed` | 正常応答と同じreadへ入る不正frame、duplicate response |
| `unknown_request` | 未知server requestへのerror応答とturn interrupt |
| `crash_after_ready` | ready後crash、bounded restart、turn非再送 |

fixtureは秘密、実account、実path、promptを含めない。新しいprotocol edge caseはproduction parserを緩める前にfake modeまたは共有fixtureへ追加する。

## 通常gate

~~~text
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all -- --test-threads=1
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
~~~

fake integrationはcrash testが環境変数を共有するため`--test-threads=1`で実行する。通常testではlive smokeはignoredのままにする。

## 読み取り専用live smoke

~~~text
CODEX_LIVE_SMOKE=1 cargo test \
  --manifest-path src-tauri/Cargo.toml \
  --test codex_supervisor \
  live_installed_codex_completes_read_only_handshake \
  -- --ignored --test-threads=1
~~~

このsmokeは選択binaryでschemaを生成し、initialize、account/read、config/read、model/listだけを行う。thread、turn、reviewを作らず、モデル利用を発生させない。出力へaccount内容、config値、`CODEX_HOME`、workspaceの絶対pathを追加してはならない。

実tokenを使うturn/review検証、ephemeral threadの非永続監査は別gateにする。特にsupport機能は、threadがlistへ残らないことだけで隔離合格にしてはならない。

## 変更時チェックリスト

- binary、version、hash、schema fingerprintのいずれかが変わったらcapabilityを再probeする。
- OpenAI method/fieldを追加するときはgenerated schema、fake fixture、Rust subset DTO、TypeScript exact parserを同時に更新する。
- 新しいserver requestは意味と権限を個別に審査し、default allowやgeneric toolへ流さない。
- error pathでraw `serde_json::Value`、stderr、invoke errorをUI error messageへ含めない。
- reconnect、workspace切替、future generationでpending approvalを再利用しない。
- support isolationを`supported`へ変える場合はdeny-all capabilityと`CODEX_HOME`差分のrelease evidenceを先に追加する。
