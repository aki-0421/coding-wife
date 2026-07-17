---
title: "GIT Gitレビュー・チェックポイント要件定義"
description: "既存変更を保護する所有権判定、自動checkpoint、review pack、比較・復元を定義する。"
updated: 2026-07-18
read_when:
  - "Git baseline、owned staging、automatic checkpointを実装するとき。"
  - "Commit tabのevidence、review、restoreを検証するとき。"
---

# Gitレビュー・チェックポイント 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `GIT` |
| 状態 | Draft |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-18 |
| 最終レビュー日 | 未レビュー |

## 背景

大きな最終diffはレビュー負担を増やし、既存の利用者変更をAI変更へ混入させる危険がある。作業単位のscope、ownership、verification、riskを満たした時だけcheckpointを作り、証拠と安全な復元を提供する必要がある。

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| 既存変更を保護する | session開始前のdirty changeを特定し、自動stage/commitへ一切含めない |
| 小さなreview単位を作る | gate通過後だけautomatic commitとreview packを作成する |
| 安全に比較・復元する | Commit tabからdiff、test、decision、risk、restore方法を確認できる |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| Baseline | HEAD、index、working tree、untrackedのfingerprint |
| Ownership | work unitごとのowned path/hunk、pre-existing change除外 |
| Checkpoint | Scope/Ownership/Verification/Risk gate後のautomatic local commit |
| Review pack | SHA、diff、tests、decisions、failed attempts、risks、restore |
| Recovery | compare、revert commit、recovery branch、stale/dirty blocking |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| auto push / merge / force | remoteと共有履歴を無断変更しない | 外部Git workflow |
| manual commit button | work unit gateを迂回させない | automatic checkpoint |
| hard reset / checkout discard | user changeを破壊し得る | revert commit / recovery branch |
| interactive rebase | 履歴書換えをMVPに含めない | 外部Git client |
| submodule/LFS mutation | ownership境界が異なる | MVP非対象としてblocked表示 |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ローカル利用者 | repository所有者・reviewer | evidence閲覧、compare、safe restore、recovery branch | unsafe dirty/stale状態ではmutationを実行せず理由を表示する |
| Codex main session | work unitの変更作成者 | scope、変更候補、verification resultを提出 | 自身でstage/commit/pushを直接実行するUI契約を持たない |
| Rust Git service | repository mutationの信頼境界 | baseline、diff、owned stage、local commit、revert/branch | ownership不明、HEAD stale、権限不足、conflictで停止する |

## 機能要件

### Baseline・ownership・gate

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `GIT-F-043` | appはsession開始時のGit baselineを記録する | HEAD SHA、branch/detached、index、tracked diff、untracked pathのfingerprintをturn開始前に保存する | Draft | 非該当 |
| `GIT-F-044` | appはpre-existing changeを明示する | baseline時に存在するstaged/unstaged/untrackedをCommit tabへ「ユーザー既存変更」として表示し、AI owned扱いにしない | Draft | 非該当 |
| `GIT-F-045` | work unitは変更所有権を記録する | file path、baseline blob/hash、追加・変更hunk、作成eventをmanifestへ紐付け、所有不明hunkをUnownedにする | Draft | 非該当 |
| `GIT-F-046` | appはunowned changeをstageしない | pre-existing、外部変更、ownership不明を含むfixtureでautomatic stage対象がowned hunkだけになり、他diffがworking treeに残る | Draft | 非該当 |
| `GIT-F-047` | checkpointは4 gate通過後だけ作られる | Scope、Ownership、Verification、Riskの全resultがPassの時だけcommitし、1件でもFail/Unknownなら理由付きBlockedにする | Draft | 非該当 |
| `GIT-F-048` | verification evidenceがないwork unitを完了扱いにしない | acceptanceに必要なtest/checkが0件またはfailedならcheckpointを作らず、未実施/失敗をCommit tabへ表示する | Draft | 非該当 |
| `GIT-F-049` | high-risk changeは人間reviewを要求する | auth、permission、secret、migration、destructive data、Git historyに触れるowned diffはRisk gateをNeeds reviewにし、明示approvalまでcommitしない | Draft | 非該当 |

### Automatic checkpointとreview pack

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `GIT-F-050` | appはgate通過後にlocal checkpointを自動作成する | completed work unitでowned stageを作り、1件のlocal commitを作成してSHAとmessageをtimelineへ記録する | Draft | 非該当 |
| `GIT-F-051` | checkpoint messageは追跡可能な形式になる | 1行目がConventional Commits英語summary、2行目以降が変更と意図の英語bulletで、secret/path credentialを含まない | Draft | 非該当 |
| `GIT-F-052` | appはcheckpoint後にreview packを作る | SHA、objective、acceptance、owned files、diff stats、test results、decisions、failed attempts、known risks、restore actionを1packで表示する | Draft | 非該当 |
| `GIT-F-053` | Commit tabはmanual commit操作を提供しない | S-003に「Commit」または同義のmutation buttonがなく、checkpoint statusとreview/restore actionだけを表示する | Draft | 非該当 |
| `GIT-F-054` | appはremoteへ自動送信しない | checkpoint、review、restoreの各test後にnetwork push、merge、force、remote ref updateが0回である | Draft | 非該当 |
| `GIT-F-055` | checkpoint失敗はworking treeを保持する | hook failure、identity不足、write権限不足でcommitが失敗した時、owned/unowned file内容を変更せず、retry条件を表示する | Draft | 非該当 |

### Compare・restore・競合

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `GIT-F-056` | 利用者はcheckpoint間を比較できる | 任意の2 SHAを選ぶとfile list、add/delete、decision、test差分をread-only表示する | Draft | 非該当 |
| `GIT-F-057` | 利用者はcheckpointをrevert commitで取り消せる | HEADとworking treeが安全条件を満たす時、確認後に対象commitのrevert commitを作成し、元commitを削除しない | Draft | 非該当 |
| `GIT-F-058` | unsafe restoreは実行しない | uncommitted user change、HEAD stale、conflict予測のいずれかがある時、revertを開始せず対象pathと解決手順を表示する | Draft | 非該当 |
| `GIT-F-059` | 利用者はrecovery branchを作成できる | valid branch nameとcheckpoint SHAを指定するとlocal branchを作り、checkoutせず結果refを表示する | Draft | 非該当 |
| `GIT-F-060` | restore/branch dialogはcancelできる | cancel時にHEAD、refs、index、working treeが開始前fingerprintと一致する | Draft | 非該当 |
| `GIT-F-061` | 外部HEAD変更はstale状態になる | baseline後にHEAD/refが外部変更された場合、次mutation前に検出してgateをBlockedにし、refresh reviewを要求する | Draft | 非該当 |
| `GIT-F-062` | Git conflict/errorを成功表示しない | conflict、lock、disk full、permissionのfixtureでerror codeとaffected operationを表示し、checkpoint/revert SHAを生成済みと表示しない | Draft | 非該当 |

### 境界と性能

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `GIT-F-063` | 大きなdiffを段階表示する | 500 fileまたは50,000 changed lineまでsummaryを5秒以内に表示し、file diffを1件ずつlazy loadする | Draft | 非該当 |
| `GIT-F-064` | checkpointはgate完了後に短時間で結果を返す | 500 owned file・合計50MiB以下のreference repoでstage+local commitのp95が5秒以下になる | Draft | 非該当 |
| `GIT-F-065` | unsupported repository形態をmutation前にblockする | bare、submodule root、Git LFS pointer mutationを検出した場合、read-only evidenceは表示し、checkpoint/restoreを無効にする | Draft | 非該当 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| Work unit | objective | current goal | 必須 | 1〜500文字 | gateをBlocked、入力保持 |
| Work unit | acceptance | なし | 必須 | 1〜20項目、各1〜500文字 | gateをBlocked |
| Restore | checkpoint SHA | 選択pack | 必須 | repository内の40桁commit object | mutationせずerror |
| Recovery branch | branch name | `recovery/<short-sha>` | 必須 | Git check-ref-format、1〜200 byte、既存ref不可 | 入力保持、作成無効 |

## デスクトップ固有要件

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | macOS 14以降のuser-installed Gitを診断 | `GIT-F-043`, `GIT-F-062` |
| ウィンドウ生成・再利用 | S-003をmain window tabとして再利用 | `GIT-F-052`, `GIT-F-053` |
| 閉じる・アプリ終了 | Git mutation transaction中は完了またはsafe abort後に終了 | `GIT-F-050`, `GIT-F-057` |
| 未保存データ | baselineのuser changeを変更・破棄しない | `GIT-F-043`〜`GIT-F-046` |
| ローカルデータ | baseline/manifest/review packはHISTへ、Git objectはrepoへ保存 | `GIT-F-043`, `GIT-F-052` |
| オフライン | local Git機能は利用可能、remote操作は非対象 | `GIT-F-050`〜`GIT-F-060` |
| ファイル・OS操作 | owned stage、commit、revert、branchだけをRustへ許可 | `GIT-F-046`, `GIT-F-050`, `GIT-F-057`, `GIT-F-059` |
| メニュー・ショートカット | manual commit shortcutは提供しない | `GIT-F-053` |
| Deep Link・ファイル関連付け | 非該当 | 非該当 |
| 通知 | checkpoint完了/blockedをapp内timelineとCommit tabへ表示 | `GIT-F-047`, `GIT-F-052` |
| Capability・認可 | repository root内のGit操作へ限定し、任意git argsをWebViewから受けない | `GIT-F-046`, `GIT-F-050` |
| アップデート・互換性 | minimum Git versionをhard pinせず必要commandのcapabilityで診断 | `GIT-F-043` |

## 画面・UI

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-002` | コーディングワークスペース | `GIT-F-043`〜`GIT-F-055` | 変更 | 次工程: `docs/screen-design/S-002_coding-workspace.md` |
| `S-003` | セッション証拠 | `GIT-F-043`〜`GIT-F-065` | 変更 | 次工程: `docs/screen-design/S-003_session-evidence.md` |
| `S-004` | 設定・診断 | `GIT-F-043`, `GIT-F-062`, `GIT-F-065` | 変更 | 次工程: `docs/screen-design/S-004_settings-diagnostics.md` |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | arbitrary Git argsを受けず、repo rootとobject/refをRustで検証する |
| 権限 | read evidenceとowned mutationを分け、push/merge/force/hard resetを実装しない |
| プライバシー | diffをsupport/externalへ送る場合は明示されたfixed snapshotだけ。secret scan結果をpackへ残す |
| 監査・ログ | baseline、gate result、staged paths、commit/revert/branch SHA、failureを記録する |
| 性能 | 500 files/50,000 lines summary 5秒、500 files/50MiB checkpoint p95 5秒 |
| 信頼性・復旧 | stale/dirty/conflictでfail closed、元commitを削除しない、user changeを破棄しない |
| アクセシビリティ | diff statusを色だけで伝えず、file/status/line countをtextで表示する |
| 多言語・地域 | app copy ja/en、commit message/path/refは翻訳しない |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| Local Git | worktreeとcommit identity | 解決済み（preflight契約） | identity不足時checkpoint Blocked |
| WORK | canonical repo、single active execution | 解決済み（同時Draft） | stale時refresh必要 |
| HIST | baseline、gate、packの永続化 | 解決済み（同時Draft） | DB失敗時mutation前にBlock |
| CODE | work unit、verification、decision evidence | 解決済み（同時Draft） | evidence不足時checkpoint Blocked |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| hunk単位stageの実装方式 | patch適用またはtemporary indexのうち、user indexを変更しない方式を採用する | spikeで両方式をcontract testする | いいえ |
| signed commit | MVPは既存Git設定に従い、署名必須repoで失敗を明示する | release後に専用UXを評価する | いいえ |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [PRODUCT.md](../../PRODUCT.md) | evidence、checkpoint、reversibility |
| [Git・review調査](../research/07-review-harness-and-git.md) | ownership gateとreview pack |
| [品質評価](../research/10-quality-evaluation.md) | Scope/Ownership/Verification/Risk gate |

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Not Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 未合意 |
| 残る非ブロック論点 | hunk stage方式、signed commit専用UX |

## 着手可チェック

- [x] 背景と目的が説明できる。
- [x] スコープ内・外と理由が明確である。
- [x] 全機能要件に一意な要件IDがある。
- [x] 全機能要件に検証可能な受け入れ条件がある。
- [x] 正常系、異常系、キャンセル、権限差分、空状態、境界値を確認した。
- [x] デスクトップ固有要件を確認し、非該当も明記した。
- [ ] 画面IDと要件IDの相互参照が一致している。画面詳細仕様は次工程で作成する。
- [x] 非機能要件と依存関係を確認した。
- [x] 着手ブロックが「はい」または「不明」の未確定事項がない。
- [ ] 仕様責任者がレビューし、合意した。
