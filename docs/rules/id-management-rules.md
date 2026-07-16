---
title: "ID管理ルール"
description: "画面IDと機能要件IDを安定して採番・参照・廃止するための正本。"
updated: 2026-07-17
read_when:
  - "画面または機能要件へ新しいIDを付けるとき。"
  - "既存IDを維持するか、新しいIDを発行するか判断するとき。"
---
# ID管理ルール

## 目的

名称、ファイルパス、画面遷移の実装が変わっても、同じ仕様を安定して参照できるようにする。
IDは並び順や実装場所ではなく、仕様上の同一性を表す。

## ID体系

| 対象 | 形式 | 例 | 正本 |
|---|---|---|---|
| 画面 | `S-NNN` | `S-001` | `agent-docs` 管理対象の各画面詳細仕様 |
| 機能要件 | `<PREFIX>-F-NNN` | `FILE-F-001` | 各機能の要件定義書 |

- `NNN` は `001` から始まる3桁の連番とする。
- `PREFIX` は機能を表す2〜4文字の大文字英字とする。
- Prefixの重複は[Prefix・要件定義書台帳](#prefix要件定義書台帳)で防ぐ。
- IDへ画面名、状態、優先度、担当者名を埋め込まない。
- 欠番を許容し、番号を詰めるための振り直しを行わない。

## 画面詳細仕様の管理

画面一覧のための集約文書は作成しない。画面ごとに `docs/screen-design/S-NNN_<screen-name>.md` を作成し、各画面詳細仕様を正本とする。

- 各画面詳細仕様には `agent-docs` が要求するfront matterを付ける。
- front matterの `title` は `S-NNN` から始め、`screen_id` に同じ画面IDを記録する。
- front matterの `status` は `Draft`、`Approved`、`Deprecated` のいずれかとする。
- ファイル名、`title`、`screen_id` の画面IDを一致させる。
- 画面詳細仕様は `agent-docs list docs/screen-design` で探索し、必要な本文だけを `agent-docs read <file> --body` で確認する。
- 廃止した画面詳細仕様も削除せず、`status: "Deprecated"`、廃止理由、後継画面IDを残す。

## Prefix・要件定義書台帳

機能単位で1つの要件定義書を作成し、`docs/requirements/<feature-name>/requirements.md` に置く。

| Prefix | 機能名 | 要件定義書 | 状態 | 責任者 |
|---|---|---|---|---|
| `WORK` | workspace-sessions | [要件定義書](../requirements/workspace-sessions/requirements.md) | Approved | プロダクトオーナー |
| `CODE` | codex-main-session | [要件定義書](../requirements/codex-main-session/requirements.md) | Approved | プロダクトオーナー |
| `SUP` | support-agent-orchestration | [要件定義書](../requirements/support-agent-orchestration/requirements.md) | Approved | プロダクトオーナー |
| `GIT` | git-review-harness | [要件定義書](../requirements/git-review-harness/requirements.md) | Approved | プロダクトオーナー |
| `HIST` | activity-history | [要件定義書](../requirements/activity-history/requirements.md) | Approved | プロダクトオーナー |
| `LIVE` | live2d-companion | [要件定義書](../requirements/live2d-companion/requirements.md) | Approved | プロダクトオーナー |
| `NARR` | audio-commentary | [要件定義書](../requirements/audio-commentary/requirements.md) | Approved | プロダクトオーナー |
| `APP` | desktop-shell | [要件定義書](../requirements/desktop-shell/requirements.md) | Approved | プロダクトオーナー |

### Prefixのルール

- 機能を表す2〜4文字の大文字英字とする。
- プロジェクト内で重複させない。
- チーム内で意味を説明できる略称にする。
- 組織名、担当者名、一時的なプロジェクト名を使わない。
- 機能名が変わっても、同じ機能の要件を継続する場合は既存Prefixを維持する。
- 廃止したPrefixは再利用せず、台帳に `Deprecated` として残す。

## 画面IDと実行時識別子の違い

| 識別子 | 用途 | 同一性の基準 |
|---|---|---|
| 画面ID `S-NNN` | プロダクト仕様上の画面を参照する | ユーザーが達成する目的 |
| Tauri window label | Window / WebViewとCapabilityの実行境界を識別する | Tauriのウィンドウ構成 |
| React route / view key | WebView内の表示・遷移を識別する | フロントエンドのルーティング設計 |

1つのTauriウィンドウ内に複数の画面IDが存在してよい。反対に、同じ画面を複数ウィンドウで表示する場合も、ユーザー目的と振る舞いが同一なら画面IDを共有してよい。

画面名、window label、React route / view keyのいずれかが変わっただけでは、画面IDを変更しない。

## 状態

| 状態 | 意味 | 実装着手の根拠 |
|---|---|---|
| Draft | 検討中または未レビュー | 使用しない |
| Approved | レビューと合意が完了している | 使用できる |
| Deprecated | 廃止済み。履歴参照のため保持する | 新規実装には使用しない |

## 共通ルール

1. IDはプロジェクト内で一意にする。
2. 一度発行したIDは削除・再利用しない。
3. 表示順の変更を理由にIDを振り直さない。
4. 廃止した仕様は管理対象文書から消さず、`Deprecated` と後継IDを記録する。
5. 既存仕様の説明を明確にするだけなら、同じIDを維持する。
6. 独立して合否を判定できる新しい振る舞いには、新しい要件IDを発行する。
7. 採番時は既存文書を検索し、重複がないことを確認する。

## 画面IDを付ける単位

次をすべて満たす表示単位には、原則として画面IDを付ける。

- 独立したユーザー目的がある。
- 独立した表示状態、主要操作、完了または終了条件がある。
- 要件定義書から安定して参照する必要がある。

次には原則として画面IDを付けない。

- ボタン、入力欄、カード等のUI部品。
- OS標準のファイル選択・保存ダイアログ。
- 単純な確認ダイアログや通知。
- 同じ目的の画面内にあるタブやパネル。
- 読み込み中、空状態、エラー等、同じ画面の状態差分。

モーダルであっても、独立した業務目的、複数段階の操作、独自の終了条件を持つ場合は、画面IDを付けるかを個別に判断する。

## 変更時の判断

| 変更 | IDの扱い |
|---|---|
| 誤字修正、説明の一意化 | 同じIDを維持する |
| 画面名、path、view keyの変更 | ユーザー目的が同じなら同じ画面IDを維持する |
| 画面を別のwindow labelへ移動 | ユーザー目的が同じなら同じ画面IDを維持する |
| 画面の分割・統合 | 新しい画面IDを発行し、旧IDに後継IDを記録する |
| 既存要件の受け入れ条件を明確化 | 意図が変わらなければ同じ要件IDを維持する |
| 独立した操作・振る舞いの追加 | 新しい要件IDを発行する |
| 画面または要件の廃止 | IDを削除せず `Deprecated` にする |
| 廃止仕様と似た別目的の仕様を追加 | 新しいIDを発行する |

## 要件と画面の対応管理

中央集約型のトレーサビリティマトリクスは作成しない。対応関係は次の2箇所で管理する。

- 要件定義書の「画面・UI」に、画面IDと対象要件IDを書く。
- 画面詳細仕様の「関連要件」に、要件IDを書く。

相互参照にはIDとリンクだけを持ち、要件本文や画面仕様を複製しない。文書をレビューするときは、両方向の参照が一致していることを確認する。

## 新規発行手順

### 画面ID

1. `agent-docs list docs/screen-design` で既存の画面詳細仕様を確認する。
2. 必要な仕様を `agent-docs read <file> --body` で読み、同じユーザー目的の画面がないことを確認する。
3. 既存の最大番号より大きい未使用番号を採番する。
4. [画面詳細仕様テンプレート](screen-detail-specification-template.md)から詳細仕様を作成し、front matterの `screen_id` と `status: "Draft"` を設定する。
5. 関連する要件定義書へ画面IDを追加する。
6. `agent-docs lint` を実行する。

### 要件ID

1. [Prefix・要件定義書台帳](#prefix要件定義書台帳)で機能Prefixを確認する。
2. 対象機能の要件定義書内で未使用の次番号を採番する。
3. 受け入れ条件と状態を同じ行へ記録する。
4. 画面を伴う場合は、画面IDとの対応を「画面・UI」へ記録する。
