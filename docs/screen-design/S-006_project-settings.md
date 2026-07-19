---
title: "S-006 プロジェクト設定"
description: "選択中プロジェクトだけへ適用するProject contextと履歴設定を管理する画面仕様。"
updated: 2026-07-20
read_when:
  - "workspaceのSettings tab、project context、workspace historyを実装するとき。"
  - "S-006とWORK、HIST、APP要件の対応を確認するとき。"
screen_id: "S-006"
status: "Approved"
---

# S-006 プロジェクト設定

| 項目                   | 内容                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| window label           | `main`                                                                  |
| React route / view key | `/workspace/:workspaceId/settings/:section?` / `project-settings`       |
| 対象OS                 | macOS 14以降、Apple Silicon                                             |
| デザイン               | [DESIGN.md](../../DESIGN.md)、Figma Desktop node `8:2`のworkspace shell |
| 共通仕様               | [デスクトップ共通仕様](desktop-common-specification.md)                 |
| 廃止理由               | 非該当                                                                  |
| 後継画面ID             | 非該当                                                                  |

## 目的

利用者が、現在選択中のプロジェクトまたはworkspaceだけへ適用されるProject contextと履歴を、アプリ全体のcharacter presentation設定と混同せず確認・変更・復旧できるようにする。

## 対象範囲

### 含める

| section           | 内容                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| Project context   | goal、constraints、definition of done、technical references、user notes |
| History & Privacy | 選択workspaceの保存内容、non-persistence、履歴削除、migration/recovery  |

### 含めない

| 非対象                                                      | 理由                                 | 扱う画面・文書                             |
| ----------------------------------------------------------- | ------------------------------------ | ------------------------------------------ |
| Language、reduced motion、全workspaceのcharacter visibility | app-globalのため                     | [S-005](S-005_app-settings-diagnostics.md) |
| Character context、Companion                                | app-globalのため                     | [S-005](S-005_app-settings-diagnostics.md) |
| Audio voice/rate/mute                                       | app-globalのowner-only settingのため | [S-005](S-005_app-settings-diagnostics.md) |
| Support control、native readiness                           | app-globalのため                     | [S-005](S-005_app-settings-diagnostics.md) |
| Git commit/revert/reset                                     | read-only observer境界のため         | [S-003](S-003_session-evidence.md)         |

## 表示契機と終了

| 項目           | 内容                                                                 |
| -------------- | -------------------------------------------------------------------- |
| 表示契機       | workspace headerの`Settings / 設定` tab                              |
| 表示前提       | workspaceが1件選択済み                                               |
| 初期フォーカス | workspace tabの共通focus契約に従い、level 1 headingでscopeを提示する |
| 正常完了       | section単位の保存成功をinline表示し、同じworkspaceの画面を維持する   |
| キャンセル     | confirm開始前の保存済み値とdraftを維持する                          |
| 閉じる操作     | Chat/Commit/Context tabまたは別workspaceを選択する                   |
| 再表示         | workspaceごとのProject context、historyと同一WebView内のsection選択を復元する |

## 利用者と権限

| 利用者・ロール | 表示                                                                       | 操作                                               | 拒否時の動作                                                  |
| -------------- | -------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| ローカル利用者 | 選択project/workspaceのnon-secret Project context、history summary | edit、save、delete | 他projectの値を表示せず、入力と前snapshotを維持する |
| React WebView  | workspace ID、versioned Project context、sanitized state           | render、input、typed IPC | secret、raw support historyを保持しない |
| Rust service   | workspace/project-scoped store、history                            | scope検証、atomic save、delete | workspace/project不一致を拒否し、他scopeを変更しない |

## 画面構成

| 領域               | 表示内容                                                         | 主な操作                          |
| ------------------ | ---------------------------------------------------------------- | --------------------------------- |
| workspace sidebar  | workspace一覧、app settings gear                                 | workspace切替、S-005表示          |
| workspace header   | repository、workspace、branch、Chat/Commit/Context/Settings      | tab移動、workspace action         |
| section navigation | Project context、History & privacy               | section選択              |
| settings main      | project identity、選択sectionのform/status/error | edit、save、retry、delete |

headingの説明に`repository/workspace`を表示し、選択中scopeを文字で確認できるようにする。app-global sectionをnavigationへ表示しない。960〜1279pxではsection navigationをpopoverへ移す。

## 表示状態

| 状態       | 進入条件                        | 表示                                              | 操作可否                   | 状態から抜ける条件      |
| ---------- | ------------------------------- | ------------------------------------------------- | -------------------------- | ----------------------- |
| 初期化中   | workspace-scoped snapshot未取得 | project identityとfield skeleton                  | tab移動のみ可              | snapshot取得またはerror |
| 通常       | snapshot取得済み                | 2 sectionとversion/status                         | 契約済み操作が可           | edit/delete開始         |
| データなし | historyが0件                    | non-persistence説明と次action                     | context編集可              | history生成             |
| 処理中     | save/delete中                   | 対象sectionのprogress                             | 同一操作の二重実行不可     | terminal result         |
| オフライン | Codex/network unavailable       | local context/historyを表示                       | local操作可、send不可      | connection回復          |
| エラー     | load/save/delete失敗            | section-local safe code、Retry                    | 他sectionと他workspaceは可 | retry/reload成功        |
| 権限不足   | root/history scope拒否          | localized reason                                  | scope外操作不可            | repairまたは権限回復    |

## 操作

| 操作                        | 事前条件                        | 正常結果                                | キャンセル時      | 失敗時                               | 関連要件ID                 |
| --------------------------- | ------------------------------- | --------------------------------------- | ----------------- | ------------------------------------ | -------------------------- |
| Project settingsを開く      | workspace選択済み               | Settings tabをactiveにしS-006だけを表示 | 非該当            | 現在tabを維持                        | `APP-F-083`                |
| workspaceを切り替える       | running/pending turnなし        | 新workspace identityとscoped dataへ切替 | 旧workspaceを維持 | 旧snapshotを復元しsafe error         | `WORK-F-048`, `APP-F-055`  |
| Contextを保存する           | valid、expected version一致     | versionを更新し次turnから適用           | draft維持         | field errorまたはconflict、draft維持 | `WORK-F-063`, `WORK-F-066` |
| workspace historyを削除する | running 0、native history ready | 選択workspaceを維持し、app history・draft・contextだけ初期化。workspace登録、worktree、branchは保持 | 何も変更しない | partial successを表示せずrecovery | `HIST-F-049`, `HIST-F-050`, `HIST-F-059` |

## 入力項目

Project contextのfield、境界、conflict契約は[workspace sessions要件](../requirements/workspace-sessions.md)、history deleteは[activity history要件](../requirements/activity-history.md)を正本とし、S-006は選択scopeと画面遷移を追加で保証する。Character context、character import、selection、mappingは[S-005](S-005_app-settings-diagnostics.md)で扱う。

## ネイティブ連携

| ユーザー操作                       | 実行境界                    | Tauri plugin / Command     | 必要なCapability・認可                              | キャンセル時                        | 拒否・失敗時                                 |
| ---------------------------------- | --------------------------- | -------------------------- | --------------------------------------------------- | ----------------------------------- | -------------------------------------------- |
| Project context load/save          | Rust SQLite                 | workspace context commands | workspace ID、expected version、canonical reference | draft維持                           | conflictまたはsafe code                      |
| history delete                     | Rust DB/artifact service    | `workspace_issue_delete_challenge` / `workspace_delete` | running 0、workspace ID、短命challenge | row/artifact不変 | workspace登録とGitを維持しrecovery state |

## ウィンドウ固有動作

単一`main` windowを再利用し、workspace sidebarと81px workspace headerを維持する。Settings tab bodyだけをsection navigationとproject-scoped main formへ置換する。その他は共通仕様どおり。

## メニュー・ショートカット

| 操作            | macOS                               | Windows / Linux | 有効条件                | 実行結果                 |
| --------------- | ----------------------------------- | --------------- | ----------------------- | ------------------------ |
| tab移動         | `Control+Tab` / `Control+Shift+Tab` | 非対応          | destructive confirmなし | workspace tabsを循環     |
| overlayを閉じる | `Escape`                            | 非対応          | picker以外のoverlay     | 入力維持、triggerへfocus |

## データ保持

Project contextとworkspace historyの正本と破棄条件は各要件定義書に従う。S-006を開閉してもapp-global Character context、selected character、semantic mapping、AppPreferences、Narration settings、Support controls、他workspaceのdraft/historyを変更しない。

## OS差分

MVPはmacOS 14以降のApple Siliconだけを検証する。Windows/Linuxを対応済みとして表示しない。

## アクセシビリティ

- headingに`Project settings / プロジェクト設定`と現在の`repository/workspace`を表示する。
- Settings tab、section navigation、保存状態、errorを色だけで表現しない。
- workspace切替後は旧workspace内容を一瞬でも新scopeとして表示しない。
- 200% text zoomではsection navigationをpopover化し、保存・削除・cancelへ到達できる。

## 関連要件

| 要件ID                                                                                    | この画面での扱い                           | 要件定義書                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `APP-F-055`, `APP-F-059`, `APP-F-060`, `APP-F-062`, `APP-F-066`, `APP-F-072`, `APP-F-083` | project settings navigation、a11y、offline | [desktop-shell](../requirements/desktop-shell.md)           |
| `WORK-F-048`, `WORK-F-057`, `WORK-F-063`, `WORK-F-066`                                    | workspace切替、Project context             | [workspace-sessions](../requirements/workspace-sessions.md) |
| `HIST-F-049`〜`HIST-F-056`, `HIST-F-058`, `HIST-F-059`                                    | workspace history/privacy                  | [activity-history](../requirements/activity-history.md)     |

## 未確定事項

| 論点   | 初期判断                   | 確認事項 | 着手ブロック |
| ------ | -------------------------- | -------- | ------------ |
| 非該当 | 分離scopeはAPP-F-083で確定 | 非該当   | いいえ       |

## レビュー確認

| 項目         | 内容       |
| ------------ | ---------- |
| レビュー結果 | Approved   |
| レビュー日   | 2026-07-20 |

- [x] project-scoped 2 sectionとapp-global非対象が一意である。
- [x] current project identity、workspace切替、scope isolationを定義した。
- [x] loading、empty、processing、offline、error、permissionを定義した。
- [x] native boundary、ja/en、keyboard、200% zoomを定義した。
- [x] `agent-docs lint`対象のfront matterと相互参照を記載した。
