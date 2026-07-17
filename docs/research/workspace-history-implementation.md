---
title: "ワークスペース履歴ランタイム実装ガイド"
description: "ローカルSQLite履歴、ワークスペース復元、native context取得、WebView adapterを安全に変更・検証するための責務と不変条件。"
updated: 2026-07-18
read_when:
  - "ワークスペースの追加・選択・下書き・タイムライン・履歴削除を変更するとき。"
  - "SQLite migration、破損復旧、Git preflight、context snapshotのprivacy境界を検証するとき。"
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
5. eventはworkspaceごとの単調増加sequenceで追記し、同じevent IDの再送は冪等に扱う。既存eventを訂正目的で更新しない。
6. draftはworkspace単位かつrevision付きで保存する。WebView adapterは同じworkspaceへの書き込みを直列化し、revision conflict時だけ最新値を再取得して1回再試行する。
7. 保存前にsecret、credential、private rootをredactする。raw reasoning、raw protocol payload、生成音声、support prompt/responseをschemaへ追加しない。
8. event payloadは256 KiB、context snapshotは1 MiB、context保持数はworkspaceごとに最新10件、timeline pageは最大200件、workspace一覧は最大200件とする。上限を緩める場合はSQLite、IPC、UIの負荷試験を先に追加する。
9. contextのlabelと本文はWebViewから受け取らない。`files`はtrusted rootで`git ls-files`、`git_diff`はexternal diffとtextconvを無効化したread-only Git commandからRustが生成する。`terminal_output`は信頼できるproducerが実装されるまで構造化errorで拒否する。
10. 履歴削除はUI確認の後にnative challenge tokenを発行し、対象workspaceのapp metadataだけをtransactionで削除する。repository file、commit、branchを変更しない。
11. migrationはtransaction内でversion順に適用し、既存versionのSQLを書き換えない。破損またはmigration失敗時は元DBを上書きせず、basenameだけをpublicに返すrecovery backupとread-only状態を使う。
12. 永続履歴adapterの`connected=false`は意図的である。この値はCodex送信可否を表し、履歴の利用可否は`history.mode`とタイムラインのbadgeで別に表示する。

## ファイル責務

| ファイル | 責務 |
|---|---|
| `src-tauri/src/workspace_history/store.rs` | SQLite schema、migration、transaction、redaction、pagination、delete challenge、recovery |
| `src-tauri/src/workspace_history/service.rs` | pickerから選択までのatomic orchestration、起動復元、trusted-root context取得 |
| `src-tauri/src/workspace_history/commands.rs` | WebViewへ公開するtyped Tauri command |
| `src-tauri/src/workspace_history/types.rs` | version 1 DTO、serde exact field contract、public/private境界 |
| `src-tauri/src/codex/workspace.rs` | Git worktree、owner、permission、identity preflightとtrusted root管理 |
| `src/lib/contracts/workspace-history.ts` | response/errorのexact-key parserとrequest/response map |
| `src/features/workspace-persistence/transport.ts` | Tauri invoke envelopeとcontract boundary error |
| `src/features/workspace-persistence/adapter.ts` | persisted stateのUI projection、draft queue、context、二段階削除 |
| `src/features/workspace-persistence/demo-transport.ts` | ブラウザー専用の決定的demo。native成功や再起動永続化を偽装しない |
| `src/features/workspace-view/useWorkspaceViewModel.ts` | hydration、workspace切替race防止、250 ms draft debounce、UI notice |
| `src/test/fixtures/workspace-history.v1.json` | RustとTypeScriptが共有するpublic contract fixture |

## 通常gate

```text
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml workspace_history --lib
pnpm exec vitest run src/features/workspace-persistence/*.test.ts src/features/workspace-view/WorkspaceShell.test.tsx src/app/App.test.tsx
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Rust testはmigration rollback、破損backup、concurrent sequence、redaction、context上限、起動復元、linked worktreeを検証する。TypeScript testはexact contract、draft直列化、project追加、session作成、context、削除、fresh adapterでの再hydrationを検証する。UIを変更した場合は`agent-browser`で作成、workspace切替、context popover、履歴削除dialog、Preview時のSend無効を操作し、screenshotは`/tmp`またはignore済み`tmp/`へ保存する。

## 変更時チェックリスト

- command fieldを変更するときはRust DTO、TypeScript contract、共有fixture、transport testを同時に更新する。
- schemaを変更するときは新しいmigration versionを追加し、失敗時rollbackとN-1 backupのtestを追加する。
- 新しいevent producer/kindはallowlist、payload schema、redaction、oversize、duplicateのtestを先に追加する。
- public DTOへpathらしいfieldを追加しない。必要なfilesystem操作はopaque workspace IDをRustでtrusted rootへ解決する。
- context sourceを追加するときは利用者入力の本文を保存せず、native producer、サイズ上限、secret fixture、失敗時の構造化errorを用意する。
- draft保存失敗やworkspace切替失敗で別workspaceのdraft、timeline、selectionを上書きしない。
- recovery modeでwrite commandを成功扱いせず、backupの絶対pathをWebViewへ返さない。
- Demo transportへnative filesystem、Codex成功、永続化成功を示す挙動を追加しない。
