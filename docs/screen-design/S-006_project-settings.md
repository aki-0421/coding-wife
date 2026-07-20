---
title: "S-006 ワークスペース設定"
description: "選択workspaceの履歴とプライバシー設定だけを管理する画面仕様。Project contextはS-005のProjects詳細へ移動済み。"
updated: 2026-07-20
read_when:
  - "workspaceのSettings tab、workspace history、履歴削除を実装するとき。"
  - "S-006とHIST、APP要件の対応を確認するとき。"
screen_id: "S-006"
status: "Approved"
---

# S-006 ワークスペース設定

| 項目                   | 内容                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| window label           | `main`                                                                  |
| React route / view key | `/workspace/:workspaceId/settings` / `workspace-settings`               |
| 対象OS                 | macOS 14以降、Apple Silicon                                             |
| デザイン               | [DESIGN.md](../../DESIGN.md)、Figma Desktop node `8:2`のworkspace shell |
| 共通仕様               | [デスクトップ共通仕様](desktop-common-specification.md)                 |
| 廃止理由               | 非該当                                                                  |
| 後継画面ID             | 非該当                                                                  |

## 目的

利用者が、現在選択中のworkspaceにだけ属する履歴の保存状態、プライバシー境界、削除操作を、Project ID単位のProject contextやapp-global設定と混同せず確認・復旧できるようにする。

## 対象範囲

### 含める

| section           | 内容                                                                      |
| ----------------- | ------------------------------------------------------------------------- |
| History & Privacy | 選択workspaceの保存内容、non-persistence、履歴削除、migration、recovery  |

### 含めない

| 非対象                                                      | 理由                                 | 扱う画面・文書                             |
| ----------------------------------------------------------- | ------------------------------------ | ------------------------------------------ |
| Project context                                             | registered Project ID単位のため      | [S-005](S-005_app-settings-diagnostics.md) |
| Language、reduced motion、全workspaceのcharacter visibility | app-globalのため                     | [S-005](S-005_app-settings-diagnostics.md) |
| Character context、Character                                | app-globalのため                     | [S-005](S-005_app-settings-diagnostics.md) |
| Audio、Support、native readiness                            | app-globalのため                     | [S-005](S-005_app-settings-diagnostics.md) |
| Git commit/revert/reset                                     | read-only observer境界のため         | [S-003](S-003_session-evidence.md)         |

## 表示契機と終了

| 項目           | 内容                                                                 |
| -------------- | -------------------------------------------------------------------- |
| 表示契機       | workspace headerの`Settings / 設定` tab                              |
| 表示前提       | workspaceが1件選択済み                                               |
| 初期フォーカス | level 1 headingでworkspace scopeを提示する                            |
| 正常完了       | delete成功またはreadiness更新をinline表示し、同じworkspaceを維持する |
| キャンセル     | confirm開始前の保存済み履歴を維持する                                |
| 閉じる操作     | ChatまたはCommit tab、別workspaceを選択する                           |
| 再表示         | workspaceごとのhistory stateを復元する                               |

## 画面構成

| 領域              | 表示内容                                                     | 主な操作                  |
| ----------------- | ------------------------------------------------------------ | ------------------------- |
| workspace sidebar | workspace一覧、app settings gear                             | workspace切替、S-005表示  |
| workspace header  | repository、workspace、branch、Chat / Commit / Settings      | tab移動、workspace action |
| settings main     | workspace identity、history status、privacy説明、delete      | retry、delete、cancel     |

app-global sectionやProject context navigationを表示しない。単一sectionのためsection navigationとcompact popoverは設けず、履歴の正本、削除範囲、残るGit dataを一続きの面で示す。

Workspace Settings表示中はLive2D canvasとCharacter paneを表示せず、settings mainをworkspace bodyの全幅で使う。renderer instanceは破棄せず、ChatまたはCommitへ戻った時に同じworkspace、canvas、semantic stateを継続する。runtime readiness、pack provenance、fallback、retryはApp SettingsのCharacter sectionで確認できる。

## 表示状態

| 状態       | 進入条件                  | 表示                                           | 操作可否               | 状態から抜ける条件       |
| ---------- | ------------------------- | ---------------------------------------------- | ---------------------- | ------------------------ |
| 初期化中   | history snapshot未取得    | workspace identityとskeleton                   | tab移動のみ可          | snapshot取得またはerror  |
| 通常       | snapshot取得済み          | persistence、retention、delete範囲             | 契約済み操作が可       | delete開始               |
| データなし | historyが0件              | non-persistence説明と今後保存されるdata        | read-only              | history生成              |
| 処理中     | delete中                  | progress、二重実行不可                         | cancel不可             | terminal result          |
| オフライン | Codex/network unavailable | local historyを表示                            | local delete可         | connection回復           |
| エラー     | load/delete失敗           | safe code、Retry                               | 他workspaceは利用可    | retry成功                |
| 権限不足   | history scope拒否         | localized reason                               | delete不可             | repairまたは権限回復     |

## 操作

| 操作                        | 事前条件                        | 正常結果                                                                 | キャンセル時     | 失敗時                               | 関連要件ID                              |
| --------------------------- | ------------------------------- | ------------------------------------------------------------------------ | ---------------- | ------------------------------------ | --------------------------------------- |
| Workspace settingsを開く    | workspace選択済み               | Settings tabをactiveにしS-006だけを表示                                  | 非該当           | 現在tabを維持                        | `APP-F-083`                             |
| workspaceを切り替える       | running/pending turnなし        | 新workspace identityとhistory stateへ切替                                | 旧workspace維持  | 旧snapshotを復元しsafe error         | `WORK-F-048`, `APP-F-055`               |
| workspace historyを削除する | running 0、native history ready | 選択workspaceを維持し、history、draft、timeline anchorだけを初期化する。Project context、workspace登録、worktree、branchは保持 | 何も変更しない | partial successを表示せずrecovery | `HIST-F-049`, `HIST-F-050`, `HIST-F-059` |

## ネイティブ連携

| ユーザー操作   | 実行境界                 | Tauri plugin / Command                                      | 必要なCapability・認可                  | キャンセル時       | 拒否・失敗時                              |
| -------------- | ------------------------ | ----------------------------------------------------------- | --------------------------------------- | ------------------ | ----------------------------------------- |
| history delete | Rust DB/artifact service | `workspace_issue_delete_challenge` / `workspace_delete`     | running 0、workspace ID、短命challenge | row/artifact不変   | workspace登録とGitを維持しrecovery state |

## ウィンドウ固有動作

単一`main` windowを再利用し、workspace sidebarと81px workspace headerを維持する。Settings tab bodyだけを最大780pxのhistory/privacy面へ置換する。

## メニュー・ショートカット

| 操作            | macOS                               | Windows / Linux | 有効条件                | 実行結果             |
| --------------- | ----------------------------------- | --------------- | ----------------------- | -------------------- |
| tab移動         | `Control+Tab` / `Control+Shift+Tab` | 非対応          | destructive confirmなし | 3 workspace tabs循環 |
| overlayを閉じる | `Escape`                            | 非対応          | confirm表示中           | 履歴を維持して閉じる |

## データ保持

workspace historyの正本と破棄条件は[activity history要件](../requirements/activity-history.md)に従う。履歴削除はProject context、app-global Character context、selected character、semantic mapping、AppPreferences、Narration settings、Support controls、repository、worktree、branchを変更しない。

## OS差分

MVPはmacOS 14以降のApple Siliconだけを検証する。Windows/Linuxを対応済みとして表示しない。

## アクセシビリティ

- headingに`Workspace settings / ワークスペース設定`と現在の`repository/workspace`を表示する。
- Settings tab、保存状態、errorを色だけで表現しない。
- workspace切替後は旧workspace内容を一瞬でも新scopeとして表示しない。
- 履歴削除confirmは削除対象と残るProject context / Git dataを読み上げ、Cancelへ初期focusを置く。

## 関連要件

| 要件ID                                                                                    | この画面での扱い                             | 要件定義書                                      |
| ----------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| `APP-F-055`, `APP-F-059`, `APP-F-060`, `APP-F-062`, `APP-F-066`, `APP-F-072`, `APP-F-083` | workspace settings navigation、a11y、offline | [desktop-shell](../requirements/desktop-shell.md) |
| `HIST-F-049`〜`HIST-F-056`, `HIST-F-058`, `HIST-F-059`                                    | workspace history/privacy                    | [activity-history](../requirements/activity-history.md) |

## 未確定事項

| 論点   | 初期判断                               | 確認事項 | 着手ブロック |
| ------ | -------------------------------------- | -------- | ------------ |
| 非該当 | Project contextの移動先はS-005で確定 | 非該当   | いいえ       |

## レビュー確認

| 項目         | 内容       |
| ------------ | ---------- |
| レビュー結果 | Approved   |
| レビュー日   | 2026-07-20 |

- [x] workspace-scoped historyとproject-scoped / app-global非対象が一意である。
- [x] current workspace identity、workspace切替、scope isolationを定義した。
- [x] loading、empty、processing、offline、error、permissionを定義した。
- [x] native boundary、ja/en、keyboard、focusを定義した。
- [x] `agent-docs lint`対象のfront matterと相互参照を記載した。
