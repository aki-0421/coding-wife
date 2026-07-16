---
title: "要件定義索引"
description: "OpenAI Build WeekのDeveloper Toolsトラックへ提出する8機能の要件定義書と、全機能に適用する確定事項の索引。"
updated: 2026-07-16
read_when:
  - "ハッカソン版の必須機能、要件定義書、共通の実行契約を確認するとき。"
  - "機能の追加、削除、実装優先順位の変更が提出範囲へ与える影響を判断するとき。"
---
# 要件定義索引

このディレクトリは、ハッカソン「OpenAI Build Week」のDeveloper Toolsトラックへ提出するデスクトップアプリの要件正本を管理する。

## 提出境界

| 項目 | 決定 |
|---|---|
| トラック | Developer Tools |
| 提出期限 | 2026年7月22日 09:00 JST |
| 必須機能数 | 8機能 |
| 完了条件 | 8機能すべてが統合され、macOS実機E2E、Windows CI、Ubuntu CI、3OS artifactの合格条件を満たす |
| 機能削減 | 8機能の一部だけを提出する案は採用しない |

8機能はすべて提出必須である。各機能は要件定義書の「含める」をハッカソン版へ実装し、「含めない」は期限後の拡張として扱う。追加機能は、8機能の統合導線と提出検証が完了するまで着手しない。

ハッカソン要件と提出準備は[ハッカソン文書索引](../hackathon/README.md)を正本とする。

## 機能索引

| Prefix | 機能 | 要件定義書 | 提出で示す価値 | 状態 |
|---|---|---|---|---|
| `WORK` | workspace-sessions | [要件定義書](workspace-sessions/requirements.md) | repositoryを診断し、同一repositoryから複数の専用worktree sessionを管理できる | Draft |
| `CODE` | codex-main-session | [要件定義書](codex-main-session/requirements.md) | Solとのmain chatを中心にCodexの作業とユーザー判断を進められる | Draft |
| `SUP` | support-agent-orchestration | [要件定義書](support-agent-orchestration/requirements.md) | 7つのsupport roleが独立threadでmainを支援し、同じworktreeで協働できる | Draft |
| `GIT` | git-review-harness | [要件定義書](git-review-harness/requirements.md) | diff、test、reviewの結果を収集し、Git操作の判断材料を提示できる | Draft |
| `HIST` | activity-history | [要件定義書](activity-history/requirements.md) | agent、turn、test、Git、modelの構造化された実行証跡を追跡できる | Draft |
| `LIVE` | live2d-companion | [要件定義書](live2d-companion/requirements.md) | 同梱Live2D companionが作業状態を視覚的に伝えられる | Draft |
| `NARR` | audio-commentary | [要件定義書](audio-commentary/requirements.md) | 重要な作業状況を日本語または英語のtextとAI生成音声で実況できる | Draft |
| `APP` | desktop-shell | [要件定義書](desktop-shell/requirements.md) | 3OS artifact、tray、復元、設定・診断、安全停止を一体化できる | Draft |

Prefix、状態、責任者、正規pathは[ID管理ルール](../rules/id-management-rules.md#prefix要件定義書台帳)を正本とする。

## 全機能に適用する確定事項

### アプリとOS

- React + TypeScript + Vite + Tauri v2で単一のメインwindowとsystem trayを実装する。
- window closeではwindowだけを非表示にし、全workspace session、実行中turn、TTS生成・再生を継続する。
- 明示Quitでは全実行中turnをinterruptし、SQLiteへ状態を保存し、Codex App Server sidecarを終了する。再起動時は同じsessionとworktreeを復元し、中断turnを自動再実行しない。
- 二重起動は既存プロセスへ集約し、新しいsidecar、tray、SQLite writerを作成しない。
- macOS 13以降のApple Siliconを実機E2E保証対象とする。Windows 11 x64とUbuntu 24.04 x64はCI buildとautomated testを必須とし、Live2DとTauri WebViewの実機動作は保証しない。
- macOS `.dmg`、Windows `.msi`、Ubuntu `.AppImage`の3OS artifactを作成する。

詳細は[デスクトップ共通仕様](../screen-design/desktop-common-specification.md)を正本とする。

### Codex実行契約

- mainとsupportは`danger-full-access`と`approval: never`を固定し、ユーザーが変更する設定を提供しない。
- 通常のtool approvalでは停止せず、mainの`AskUserQuestion`だけがユーザー回答を待つ停止状態を作成できる。
- 7つのsupport roleはそれぞれ別のCodex App Server root threadを持ち、対応するmain sessionと同じ専用worktreeを共有する。
- supportは`AskUserQuestion`を利用できない。質問候補はsupport結果としてmainへ返す。
- main modelは`gpt-5.6-sol`に固定する。support modelはrole mappingとApp Serverの`model/list`結果から自動選択する。
- 内蔵skillsの実行順をアプリで固定せず、各agentがskillのtriggerとtaskに基づいて選択する。

### Gitと証跡

- desktop shellはtask完了を契機にcommit、push、PR作成、mergeを自動実行しない。
- Git操作はユーザー指示とSolの判断に従うCodex turnが実行し、操作と結果をtimelineへ記録する。
- workspace、session、thread、turn、support assignment、timeline、diff、test、commit、modelの証跡をローカルSQLiteへ構造化して保存する。

### 安全性、秘密情報、通知

- Full accessの既知リスクを初回session開始前に表示し、ユーザーの明示同意が完了するまでsidecarとsessionを起動しない。
- コーディング画面とtrayから緊急停止を実行できる。緊急停止は全実行中turnをinterruptし、TTSを停止するが、既存のファイル変更とGit操作を取り消さない。
- TTS API keyはmacOS Keychain、Windows Credential Manager、UbuntuのSecret Service互換credential storeへ保存する。平文設定、SQLite、Web Storage、環境変数へのfallbackを実装しない。
- OS通知は、非表示または非アクティブ時のmain `AskUserQuestion`、main turn完了、回復不能失敗の3イベントだけに使用する。

### UIと言語

- 日本語と英語を提供する。
- TTSの全発話に同一内容のtext transcriptを表示する。
- keyboardだけでsession開始、prompt送信、`AskUserQuestion`回答、緊急停止、設定変更、Quitを実行できる。
- Live2D表示だけに状態伝達を依存せず、status、role、結果、エラーをtextでも表示する。

## 文書管理

- 要件定義書は[要件定義基準](../rules/requirements-definition-standards.md)と[要件定義書テンプレート](../rules/requirements-definition-template.md)に従う。
- 8機能の要件定義書は`Draft`から開始し、仕様責任者のレビューと合意後に`Approved`へ変更する。
- 要件IDと画面IDは[ID管理ルール](../rules/id-management-rules.md)に従い、廃止後も再利用しない。
- 要件の根拠として参照する外部資料は、OpenAI、Tauri、Live2Dを含む提供元の恒久的な一次資料に限定する。変更され得る仕様には`last_verified`を記録する。
- 本索引、8機能の要件定義書、`docs/rules/`、`docs/screen-design/`、`docs/hackathon/`の管理対象文書だけを要件の参照先とし、調査入力と作業用資料へリンクしない。
