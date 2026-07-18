---
title: "ワークスペース履歴ランタイム実装ガイド"
description: "ローカルSQLite履歴、ワークスペース復元、versioned editable context、native context取得、WebView adapterを安全に変更・検証するための責務と不変条件。"
updated: 2026-07-18
read_when:
  - "ワークスペースの追加・選択・下書き・タイムライン・履歴削除を変更するとき。"
  - "SQLite migration、破損復旧、Git preflight、context snapshotのprivacy境界を検証するとき。"
  - "Project / Character contextの保存、競合、次turn反映、Context / Settings UIを変更するとき。"
---

# ワークスペース履歴ランタイム実装ガイド

## 適用仕様

上位要件は[ワークスペース・セッション](../requirements/workspace-sessions.md)と[アクティビティ履歴](../requirements/activity-history.md)、画面契約は[S-001](../screen-design/S-001_session-dashboard.md)、[S-002](../screen-design/S-002_coding-workspace.md)、[S-004](../screen-design/S-004_settings-diagnostics.md)を正本とする。

履歴ランタイムは、macOSのapp-private data directoryに置く`workspace-history.sqlite3`を正本とする。WebViewはraw pathやSQLiteを直接扱わず、version 1のTauri commandとexact-key TypeScript parserを経由する。ブラウザー実行時の`DemoWorkspaceHistoryTransport`は操作確認用の決定的なメモリ実装であり、永続化済みとはみなさない。

## 実装上の不変条件

1. canonical repository pathとGit metadata pathはRustのapp-private linkage recordだけに保存する。public response、event、diagnostic、error、WebView stateへ絶対pathを出さない。
2. project登録はnative folder picker、Git preflight、DB transaction、Codex supervisor登録、active selectionの順に行う。後段が失敗した場合はDBとsupervisorをrollbackし、片側だけに登録を残さない。
3. `.git` markerと`HEAD`はregular non-symlink fileだけを許可する。current userまたはroot所有かつowner-writableで、group/world-writableなmetadataを拒否する。linked worktreeの外部gitdirは同じ検査を通す。
4. 起動復元では保存済みidentityを再検証する。repositoryの消失、identity変更、権限不足をそれぞれ`missing`、`changed`、`unreadable`として残し、履歴を削除したり自動実行したりしない。
5. eventはworkspaceごとの単調増加sequenceで追記し、同じevent IDの再送は冪等に扱う。CODE eventはexact versioned semantic payloadを保存し、live/reload共通projectorでstable ID・sequenceを保つ。unknown/invalid payloadをgeneric history rowへ近似しない。既存eventを訂正目的で更新しない。
6. draftはworkspace単位かつrevision付きで保存する。WebView adapterは同じworkspaceへの書き込みを直列化し、revision conflict時だけ最新値を再取得して1回再試行する。
7. 保存前にsecret、credential、private rootをredactする。raw reasoning、raw protocol payload、生成音声、support prompt/responseをschemaへ追加しない。
8. event payloadは256 KiB、context snapshotは1 MiB、context保持数はworkspaceごとに最新10件、timeline pageは最大200件、workspace一覧は最大200件とする。上限を緩める場合はSQLite、IPC、UIの負荷試験を先に追加する。
9. contextのlabelと本文はWebViewから受け取らない。`files`はtrusted rootで`git ls-files`、`git_diff`はexternal diffとtextconvを無効化したread-only Git commandからRustが生成する。`terminal_output`は信頼できるproducerが実装されるまで構造化errorで拒否する。
10. 履歴削除はUI確認の後にnative challenge tokenを発行し、対象workspaceのapp metadataだけをtransactionで削除する。repository file、commit、branchを変更しない。
11. migrationはtransaction内でversion順に適用し、既存versionのSQLを書き換えない。破損またはmigration失敗時は元DBを上書きせず、basenameだけをpublicに返すrecovery backupとread-only状態を使う。
12. 履歴adapter単体はCodex接続を推定しない。通常起動ではCodex composition層が`CodexDiagnostic`とcapability/model/effortを正本に送信可否を導出し、固定`connected=false`を公開しない。履歴の利用可否は引き続き`history.mode`とタイムラインのbadgeで別に表示し、履歴writerが`ready`でない時は新規turnを開始しない。
13. editableなProject / Character contextは、native producerが作るread-only Files / Git diff snapshotとは別recordである。SQLite migration version 2の`workspace_contexts`へworkspace IDをpartition keyとして保存し、ProjectとCharacterのversionを独立して増やす。片方の保存で他方のversionまたは未保存draftを変更しない。
14. editable context保存は`expectedVersion`の一致をSQLite transaction内で検証し、成功時だけversionを1増やしてcanonical JSONのSHA-256を更新する。競合時はremote versionを読み直すがlocal draftを維持し、利用者が「保存済みバージョンを再読込」を選ぶまで上書きしない。Characterの自由入力からtechnical policy keyやoverride指示を受理しない。
15. Sendは入力確定後かつCodex turn開始前に、同じread transactionでProject / Characterのversion、hash、内容を一度だけ取得する。`running` / `waiting`中の保存を既存requestへ途中注入せず、次のSendだけが新versionを使う。snapshotのworkspace IDがactive workspaceと一致しない場合はturnを開始しない。
16. Codexへ渡すprivate request textと、timeline / objectiveへ残すpublic instructionを分離する。private textはversion/hash付きJSON envelopeを含む完全な直列化後の値で80,000 Unicode scalarを上限とし、public instructionとdraftは32,000を維持する。上限はProject 32,000 + Character 12,000の単純加算ではなく、JSON escape、metadata、marker、public instructionを含む最終envelopeへ適用する。

## ファイル責務

| ファイル | 責務 |
|---|---|
| `src-tauri/src/workspace_history/store.rs` | SQLite schema、migration、transaction、redaction、pagination、delete challenge、recovery |
| `src-tauri/src/workspace_history/editable_context.rs` | Project / Character contextの境界、technical policy拒否、canonical hash |
| `src-tauri/src/workspace_history/service.rs` | pickerから選択までのatomic orchestration、起動復元、trusted-root context取得 |
| `src-tauri/src/workspace_history/commands.rs` | WebViewへ公開するtyped Tauri command |
| `src-tauri/src/workspace_history/types.rs` | version 1 DTO、serde exact field contract、public/private境界 |
| `src-tauri/src/codex/workspace.rs` | Git worktree、owner、permission、identity preflightとtrusted root管理 |
| `src/lib/contracts/workspace-history.ts` | response/errorのexact-key parserとrequest/response map |
| `src/lib/contracts/workspace-context.ts` | editable context、versioned record、turn snapshotのexact parserとWebView境界 |
| `src/features/workspace-persistence/transport.ts` | Tauri invoke envelopeとcontract boundary error |
| `src/features/workspace-persistence/adapter.ts` | persisted stateのUI projection、draft queue、context、二段階削除 |
| `src/features/workspace-persistence/turn-context.ts` | immutable snapshotとpublic instructionを80,000 scalar以内のprivate turn envelopeへ合成 |
| `src/features/workspace-persistence/codex-event-projector.ts` | versioned HIST CODE payloadからsemantic timelineへのexact fail-closed再構築 |
| `src/features/codex/workspace-session-adapter.ts` | Codex diagnostic/thread/turn/eventと履歴adapterを通常S-002へcompositionし、送信可否を導出 |
| `src/features/codex/event-projection.ts` | generationで分離されたCodexEventをsemantic timeline/HIST eventへfail-closed投影 |
| `src/features/workspace-persistence/demo-transport.ts` | ブラウザー専用の決定的demo。native成功や再起動永続化を偽装しない |
| `src/features/workspace-view/useWorkspaceViewModel.ts` | hydration、workspace切替race防止、250 ms draft debounce、UI notice |
| `src/features/workspace-view/useEditableWorkspaceContext.ts` | Context / Settings共通draft、workspace partition、save、競合保持、明示reload |
| `src/features/workspace-view/EditableContextSection.tsx` | Project / Character editor、field境界、version/hash、次turn表示、error focus |
| `src/test/fixtures/workspace-history.v1.json` | RustとTypeScriptが共有するpublic contract fixture |

## 通常gate

```text
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml workspace_history --lib
pnpm exec vitest run src/features/workspace-persistence/*.test.ts src/features/workspace-view/WorkspaceShell.test.tsx src/app/App.test.tsx
pnpm exec vitest run src/lib/contracts/workspace-context.test.ts src/features/workspace-view/useEditableWorkspaceContext.test.tsx
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Rust testはmigration rollback、破損backup、concurrent sequence、redaction、context上限、起動復元、linked worktreeに加え、editable contextの再起動復元、workspace分離、expected-version競合、policy拒否を検証する。TypeScript testはexact contract、draft直列化、project追加、session作成、context、削除、fresh adapterでの再hydration、次turn snapshot、競合時のdraft保持を検証する。UIを変更した場合は`agent-browser`でContext / Settingsの同一draft、保存後version、workspace切替、ja / en、keyboard focus、1470 / 960 / 480 pxを操作し、screenshotは`/tmp`またはignore済み`tmp/`へ保存する。

## 変更時チェックリスト

- command fieldを変更するときはRust DTO、TypeScript contract、共有fixture、transport testを同時に更新する。
- schemaを変更するときは新しいmigration versionを追加し、失敗時rollbackとN-1 backupのtestを追加する。
- 新しいevent producer/kindはallowlist、payload schema、redaction、oversize、duplicateのtestを先に追加する。
- public DTOへpathらしいfieldを追加しない。必要なfilesystem操作はopaque workspace IDをRustでtrusted rootへ解決する。
- context sourceを追加するときは利用者入力の本文を保存せず、native producer、サイズ上限、secret fixture、失敗時の構造化errorを用意する。
- draft保存失敗やworkspace切替失敗で別workspaceのdraft、timeline、selectionを上書きしない。
- editable context commandを変えるときはProject / Characterの別version、exact expected-version transaction、workspace-bound snapshotを同じ変更で検証する。
- private turn envelopeをtimeline、objective、draft、support evidenceへ保存しない。80,000 scalar上限を変える場合はfrontend composerとnative Codex supervisorの境界testを同時に更新する。
- recovery modeでwrite commandを成功扱いせず、backupの絶対pathをWebViewへ返さない。
- Demo transportへnative filesystem、Codex成功、永続化成功を示す挙動を追加しない。
