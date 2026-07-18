---
title: "HIST アクティビティ履歴要件定義"
description: "構造化イベントの追記保存、秘匿化、再構築、検索・削除、破損復旧を定義する。"
updated: 2026-07-18
read_when:
  - "SQLite schema、event timeline、crash recoveryを実装するとき。"
  - "保存対象、redaction、retention、query性能を検証するとき。"
---

# アクティビティ履歴 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `HIST` |
| 状態 | Approved |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-18 |
| 最終レビュー日 | 2026-07-18 |

## 背景

長時間作業を再開・レビューするには、成功結果だけでなく、目的、判断、試行、失敗、検証、Git observation、commit evidenceを時系列で再構築できる必要がある。一方、raw reasoning、secret、音声、支援sessionとcommit説明の生履歴を保存してはならない。

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| 作業を再構築する | app再起動後にworkspace timeline、decision、work unit、Git observation、commit evidenceを到着順で表示できる |
| 秘密を残さない | persistence前redactionによりtoken、API key、raw reasoning、support raw historyをDBから取得できない |
| 破損から安全に復旧する | migration/I/O/crash失敗で元DBを保持し、他workspaceを閲覧できる |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| Structured timeline | workspace、turn、event、decision、work unit、Git observation、commit evidence、skill injection audit、support usage metadata |
| Persistence | app-private SQLite、single writer、migration、UTC timestamp |
| Rehydration | active selection、draft、summary、interrupted stateの再構築 |
| Privacy | write-before-redact禁止、secret/raw reasoning/audio/support history非保存 |
| User control | filter、workspace history削除、empty/corruption state |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| cloud sync | local-first MVPで競合と認証を増やさない | 将来検討 |
| full-text source index | source code複製と容量増を避ける | Git evidence/path metadata |
| raw audio保存 | transcriptを正本とする | [Audio commentary](audio-commentary.md) |
| raw chain-of-thought | privacyとproduct契約 | summary/evidenceのみ |
| support session / commit explanation transcript | ephemeral分離を守る | usage/status metadataのみ |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ローカル利用者 | 履歴所有者 | 閲覧、filter、workspace単位削除、diagnostic確認 | 実行中workspace削除は停止またはcancelまで拒否する |
| Domain event producers | CODE/GIT/WORK/LIVE/SUP/NARR | version付きnormalized eventをwriterへ提出 | schema不正eventを隔離し、UIへerror codeを返す |
| Rust persistence service | DBの唯一writer | validation、redaction、transaction、migration、query | secret疑い、oversize、unknown schemaを永続化しない |

## 機能要件

### 保存・順序・秘匿

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `HIST-F-037` | appはnormalized domain eventを追記保存する | valid eventを新しいrowとして保存する。同じevent IDの再送はworkspace、session、producer、kind、schema version、timestamp、redaction後payloadがすべて一致する場合だけ元sequenceを返し、一項目でも異なる再送または別workspace所属sessionの参照は保存せずconflictにする | Approved | 非該当 |
| `HIST-F-038` | appは重要event typeを区別する | goal、plan、tool、file、error、decision、approval、verification、git_observation、commit_observed、skill_injection、support_statusをtype filterで識別できる | Approved | 非該当 |
| `HIST-F-039` | appはevent順序を安定させる | UTC timestampが同一でもworkspace単調増加sequenceで順序が一意になり、再起動前後で表示順が変わらない | Approved | 非該当 |
| `HIST-F-040` | appはworkspace再開に必要な正本を保存する | project、workspace、turn、work unit、decision、last Git observation、commit evidence、skill injection audit、selected character、locale、draftをRust DBから復元できる | Approved | 非該当 |
| `HIST-F-041` | appは秘密を永続化前にredactする | API key、Bearer token、auth cookie、home path fixtureがnormalized event writerへ入る時、目的限定のproject linkage recordを除くDB/WAL/log/artifactの検索でraw値が0件になる。linkageからevent、diagnostic、support payloadへ派生するpathは必ずredactする | Approved | 非該当 |
| `HIST-F-042` | appはraw reasoningを保存しない | reasoning fixtureを受け取ってもsummary、decision rationale、evidenceだけを保存し、chain-of-thought fieldをschemaが受理しない | Approved | 非該当 |
| `HIST-F-043` | appはaudioとsupport raw historyを保存しない | generated audio byte、support prompt/response、commit explanation transcriptをDBへ渡すtestが拒否され、opaque request/commit IDとusage/latency/error metadataだけが残る | Approved | 非該当 |
| `HIST-F-044` | event correctionは追記で表す | 既存eventの内容訂正時に元rowを更新・削除せず、対象event IDを参照するcorrection eventを追加する | Approved | 非該当 |

### 再構築・閲覧・削除

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `HIST-F-045` | appは起動時にactive workspaceを再構築する | native読込中はdemo rowを表示せずskeletonだけを表示しmutation actionを提供しない。20 workspace・各1,000 eventのfixtureはshell表示後に非同期復元し、成功時だけactive selection、last summary、draft、last observed commitとversioned CODE semantic event（assistant/tool/file/diff/plan/completion/error/decision/approval）をstable ID・sequence順でexactに再構築する。pending actionはsupervisorが同じworkspace/thread/generationのownershipを確認した時だけactionableにし、invalid/unknown payloadはUnsupportedとしてfail closedにする | Approved | 非該当 |
| `HIST-F-046` | crash中のturnをInterruptedにする | startedでterminal eventのないturnを再起動時にInterruptedとして表示し、自動再送・自動commitを行わない | Approved | 非該当 |
| `HIST-F-047` | 利用者はtimelineを種類と期間でfilterできる | All/Decisions/Errors/Verification/CommitsとUTC期間を選び、0件時にfilter解除とempty説明を表示する | Approved | 非該当 |
| `HIST-F-048` | timelineはpage単位で読み込む | 1page最大200 eventを取得し、100,000 eventのworkspaceで初回query p95 200ms以下、次page p95 200ms以下になる | Approved | 非該当 |
| `HIST-F-049` | 利用者はworkspace historyを削除できる | 実行中turnがない対象で確認すると対象のpending draft saveを新規開始不可にして既開始分を完了待ちし、app DB/artifactとUI/native draft cacheを削除する。成功後に遅延save errorを表示せず、Git repository、commit、branchを変更しない | Approved | 非該当 |
| `HIST-F-050` | 利用者は履歴削除をcancelできる | confirmation cancel時にrow/artifact数が変わらず、workspace selectionとfilterを維持する | Approved | 非該当 |
| `HIST-F-051` | empty historyは次の操作を示す | eventが0件なら「最初のturnを開始」「project診断を確認」を表示し、空のtable/card gridを表示しない | Approved | 非該当 |

### Migration・破損・監査

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `HIST-F-052` | schema migrationはtransactionで適用される | 実fileのN-1 fixtureを一意なbackup名へ複製してNへ移行し、途中failure後に同じ元DBを再openできる。同一秒内の複数backupは互いを上書きしない | Approved | 非該当 |
| `HIST-F-053` | DB破損は他データを黙って削除しない | integrity check failureでread-only recovery mode、backupのbasename、error codeを表示し、自動初期化で既存DBを上書きしない | Approved | 非該当 |
| `HIST-F-054` | writerは一つのtransaction queueで順序を保つ | 1,000 event concurrent input testでsequence重複・欠番・partial payloadが0件になる | Approved | 非該当 |
| `HIST-F-055` | appはevent schema versionを保持する | 各eventにinteger versionがあり、unknown future versionをraw表示せずUnsupported event placeholderとdiagnosticへ隔離する | Approved | 非該当 |
| `HIST-F-056` | appはsupport利用を透明に記録する | support invocationごとにrole、trigger、model family、token usage、latency、statusを記録し、prompt/response本文を記録しない | Approved | 非該当 |
| `HIST-F-057` | event表示時刻はlocaleへ適応する | 保存UTC値をja/en localeで表示し、timezone変更後も同一instantとsequenceを維持する | Approved | 非該当 |
| `HIST-F-058` | app-private履歴のpermissionをfail closedにする | DB directory、DB/WAL/SHM、migration/recovery backupのowner-only permission適用に失敗するとwrite-readyで起動せず、既存dataを保持して構造化errorまたはread-only recoveryへ移行する | Approved | 非該当 |
| `HIST-F-059` | appは履歴のdurabilityを実態どおり表示する | native SQLiteの`ready`、`read_only`、`recovery_required`と、browser demoの`ephemeral`を別状態として契約する。`ephemeral`を`Persisted locally`または再起動後も残る履歴として表示せず、Chat、timeline、Diagnostics、History & Privacyで同じdemo memory表示を使う。demo resetは現在のpreview memoryだけを変更し、再起動でfixtureへ戻ることを明示する | Approved | 非該当 |
| `HIST-F-060` | 外部mutation producerはexact eventを事前検証する | native Git mutation producerを廃止したため使用しない | Deprecated | `HIST-F-061`へ置換 |
| `HIST-F-061` | Git observer evidenceをmutationなしでexact保存する | redaction後のobservation/commit evidence/skill auditが256KiB以下、schema-valid、canonical digest確定済みの場合だけ追記し、同一eventはexact replayだけを受理する。失敗時もGit index/object/ref/worktreeとmain turn resultを変更しない | Approved | 非該当 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| Filter | event type | All | 必須 | 定義済みtype集合 | Allへ戻し、診断記録 |
| Filter | from/to | なし | 任意 | UTC instant、from ≤ to | 入力保持、query実行せずerror |
| Delete | confirmation | 未確認 | 必須 | 対象workspace名の明示確認 | 削除せずdialog維持 |
| Domain event | payload | なし | 必須 | versioned schema、1event最大256KiB | 永続化せずproducerへerror |

## デスクトップ固有要件

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | macOS app-private data directoryへSQLite/WAL/artifactを保存 | `HIST-F-037`, `HIST-F-040` |
| ウィンドウ生成・再利用 | single main windowのS-002/S-003へpage queryを供給 | `HIST-F-045`, `HIST-F-048` |
| 閉じる・アプリ終了 | writer queueを5秒以内にflushまたはtransaction rollback | `HIST-F-054` |
| 未保存データ | composer draftをturnと別にworkspaceへ保存 | `HIST-F-040`, `HIST-F-046` |
| ローカルデータ | SQLiteを正本、artifactはcontent hash参照 | `HIST-F-037`〜`HIST-F-055` |
| オフライン | 全query、filter、delete、rehydrationが利用可能 | `HIST-F-045`〜`HIST-F-051` |
| ファイル・OS操作 | recovery backup以外の任意exportはMVP非対象 | `HIST-F-052`, `HIST-F-053` |
| メニュー・ショートカット | 非該当: feature固有shortcutなし | 非該当 |
| Deep Link・ファイル関連付け | 非該当: 履歴fileを関連付けない | 非該当 |
| 通知 | corruption/migration failureをblocking bannerで表示 | `HIST-F-052`, `HIST-F-053` |
| Capability・認可 | app-private DB/artifact directoryだけをRustに許可 | `HIST-F-037`, `HIST-F-049` |
| アップデート・互換性 | N-1からNのmigrationとunknown event隔離 | `HIST-F-052`, `HIST-F-055` |

## 画面・UI

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-001` | セッションダッシュボード | `HIST-F-040`, `HIST-F-045`, `HIST-F-051` | 変更 | [画面詳細仕様](../screen-design/S-001_session-dashboard.md) |
| `S-002` | コーディングワークスペース | `HIST-F-037`〜`HIST-F-048`, `HIST-F-057`, `HIST-F-059`, `HIST-F-061` | 変更 | [画面詳細仕様](../screen-design/S-002_coding-workspace.md) |
| `S-003` | セッション証拠 | `HIST-F-038`, `HIST-F-044`〜`HIST-F-051`, `HIST-F-057`, `HIST-F-061` | 変更 | [画面詳細仕様](../screen-design/S-003_session-evidence.md) |
| `S-004` | 設定・診断 | `HIST-F-049`〜`HIST-F-056`, `HIST-F-058`, `HIST-F-059` | 変更 | [画面詳細仕様](../screen-design/S-004_settings-diagnostics.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | schema validationとredactionをwrite前に行い、SQL parameter bindingを使う |
| 権限 | DB/artifact/recovery backupをapp-private directoryへ限定する |
| プライバシー | local-only、raw reasoning/secret/audio/support本文非保存、canonical project rootは目的限定linkageだけに保存し、workspace単位削除を提供する |
| 監査・ログ | event sequence、schema version、migration、deletion、corruption、support usage metadataを記録する |
| 性能 | 100,000 eventでpage query p95 200ms、20,000 event rehydrate 3秒以下、1event 256KiB以下 |
| 信頼性・復旧 | append-only、single writer、transaction migration、read-only recovery、exact replay only。履歴失敗時もGitを変更しない |
| アクセシビリティ | semantic list/table、filter label、empty/error heading、keyboard paginationを提供する |
| 多言語・地域 | app copy ja/en、UTC保存、locale表示、user/agent本文は翻訳しない |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| SQLite | app-private local database、single writer | 解決済み（採用決定） | 非該当 |
| DomainEvent | CODE/GIT/WORK/LIVE/SUP/NARRのversioned normalized event | 解決済み（境界決定） | schema不正は隔離 |
| APP | lifecycle、locale、app-private path | 解決済み（相互参照確認済み） | 独立レビューで整合確認 |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| 自動retention | MVPは自動削除せず、利用者のworkspace削除だけ | 100,000 event性能試験後にpolicyを評価する | いいえ |
| 履歴export | MVP非対象 | 審査後の利用者需要で形式を決める | いいえ |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [PRODUCT.md](../../PRODUCT.md) | traceability、recovery、privacy |
| [活動履歴・体験設計](../research/02-experience-design.md) | structured timelineとfailed attempts |
| [品質評価](../research/10-quality-evaluation.md) | evidenceとrecovery gate |
| [セキュリティ調査](../research/09-security-privacy.md) | redactionとlocal data |

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 2026-07-18 |
| 残る非ブロック論点 | 自動retentionとexportはMVP非対象 |

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
