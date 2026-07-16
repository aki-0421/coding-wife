---
title: "ワークスペースセッション要件定義"
description: "GitHub originを持つローカルGit repositoryから、分離されたbranchと専用worktreeを安全に作成、復元、archive、cleanupする要件。"
updated: 2026-07-17
last_verified: 2026-07-17
read_when:
  - "repository選択、workspace登録、session作成、Git worktree分離を実装するとき。"
  - "sessionの再開、archive、cleanup、Git異常状態からの復旧を検証するとき。"
status: "Draft"
prefix: "WORK"
---

# ワークスペースセッション要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `WORK` |
| 状態 | Draft |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-16 |
| 最終レビュー日 | 未レビュー |

## 背景

元checkoutへAIの変更を混在させると、既存作業の所有権と復旧境界が曖昧になる。ハッカソン版では、検証済みrepositoryからsession別branchと専用worktreeを作り、元checkoutを変えずに並行管理する。

### 用語

| 用語 | 定義 |
|---|---|
| repository | pickerで選択したbareではないlocal Git working treeと共通object database。 |
| 元checkout | repository選択時に指定したworking tree。専用worktreeとは別物。 |
| workspace | canonical root、検証済み`origin`、session一覧を持つrepository単位。 |
| session | main永続root thread、生成branch、専用worktree、7 support roleとそのオンデマンドephemeral root threadの組。 |
| clean | staged・unstaged・untrackedが0件で、merge・rebase・cherry-pick・revert・bisect中ではない状態。ignored fileは除く。 |
| 同時稼働session | main/support turnが`running`か`waiting_for_user`のsession。停止中sessionは数えない。 |

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| 元checkoutを保護する | session作成前後で、元checkoutのcurrent branch、HEAD、index、tracked・untracked状態が一致する。 |
| 作業をsession単位で分離する | 同一repositoryの各main sessionが、重複しないlocal branchと専用worktreeを持つ。 |
| 再起動後も作業を継続できる | session、main thread、branch、worktreeを復元し、ユーザーの明示操作で同じ作業環境を再開できる。 |
| 期限内に安全な並行体験を示す | 3つのsessionを同時稼働させる性能試験に合格し、4つ目以降も警告後に開始できる。 |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| 選択・base | clean local Git working treeを診断し、GitHub `origin`のfetch後default headをbaseにする。 |
| session分離 | sessionごとに生成branchとapplication data内の専用worktreeを作る。 |
| 複数session | 同一repositoryの各main sessionを別branch・worktreeへ分離し、main+7 supportでworktreeを共有する。 |
| ライフサイクル | 再起動復元、明示再開、archive、unarchive、clean worktree cleanupを提供する。 |
| 診断・復旧 | fetch・認証・default head・衝突・Git特殊状態・worktree破損を検出する。 |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| remote URLからのclone | local repository選択に限定するため | 期限後に検討 |
| GitHub以外のremote、`origin`以外のbase remote | remote契約を一意にするため | 期限後に検討 |
| bare repository | working treeを起点にした元checkout保護を検証できないため | repository診断で拒否 |
| submodule宣言、sparse checkout | multiple worktreeを3OSで保証しないため | repository診断で拒否 |
| branch名、worktree path、base branchの入力 | 衝突とpath escapeを防ぐため | アプリが生成・解決 |
| dirtyな元checkoutからの作成 | 既存変更を持ち込まないため | clean後に再選択 |
| dirty worktreeの強制cleanup | 未commit変更を守るため | Git状態解消後に再実行 |
| checkpoint復元、reset、revert | 独立した履歴操作のため | [git-review-harness要件](../git-review-harness/requirements.md) |
| shellによる自動commit、push、PR作成、merge、remote branch削除 | Git操作の判断をユーザーとmain Codex turnへ残すため | [git-review-harness要件](../git-review-harness/requirements.md) |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ユーザー | OSアカウント本人 | 選択、作成、再開、archive、unarchive、cleanup、cancel | Full access同意前は診断・作成を開始しない |
| main agent | sessionのmain root thread | 専用worktreeでturnを実行 | session・thread・worktree不一致なら開始しない |
| support agent | sessionの7 support roleがオンデマンド作成するephemeral root thread | mainと同じworktreeでassignmentを実行 | 対応不一致なら開始せずmainへ失敗を返す |
| Tauri / Rust境界 | Git・filesystem・SQLiteの信頼境界 | 固定引数の診断、fetch、add、repair、remove、保存 | 任意path・shell文字列の要求を拒否する |

## 機能要件

### repository選択と事前診断

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| WORK-F-001 | sessionが0件のworkspaceで、ユーザーがrepository選択を開始できる。 | sessionが0件の状態でrepository選択操作が表示され、実行するとOS directory pickerが開く。 | Draft | 非該当 |
| WORK-F-002 | ユーザーはOS directory pickerからdirectoryを1件選択できる。 | fileと複数directoryは選択できず、選択したdirectoryだけがRust側の診断対象になる。 | Draft | 非該当 |
| WORK-F-003 | repository選択をキャンセルすると操作前状態を維持する。 | pickerを閉じた場合、workspace、session、branch、worktreeを作成せず、エラーを表示しない。 | Draft | 非該当 |
| WORK-F-004 | 選択directoryをcanonical Git rootへ解決し、bareではなく読み書き可能なlocal working treeか検証する。 | 条件を満たす場合だけ次の診断へ進み、満たさない場合は`WORK_REPOSITORY_INVALID`を表示して選択値を保存しない。 | Draft | 非該当 |
| WORK-F-005 | dirtyな元checkoutからのsession作成を拒否する。 | staged、unstaged、untrackedのいずれかが1件以上なら件数と`WORK_SOURCE_DIRTY`を表示し、fetch、branch作成、worktree作成を実行しない。 | Draft | 非該当 |
| WORK-F-006 | detached HEADの元checkoutからのsession作成を拒否する。 | symbolic branchを解決できない場合は`WORK_SOURCE_DETACHED`を表示し、元checkoutのHEADを変更しない。 | Draft | 非該当 |
| WORK-F-007 | Git履歴操作が進行中の元checkoutからのsession作成を拒否する。 | merge、rebase、cherry-pick、revert、bisectの検出結果を列挙して`WORK_SOURCE_OPERATION_IN_PROGRESS`を表示し、Git履歴を変更しない。 | Draft | 非該当 |
| WORK-F-008 | submodule宣言またはsparse checkoutを検出したrepositoryからのsession作成を拒否する。 | どちらかを検出した場合は該当状態と`WORK_REPOSITORY_LAYOUT_UNSUPPORTED`を表示し、fetchを開始しない。 | Draft | 非該当 |
| WORK-F-009 | `origin`のfetch URLが許可したGitHub HTTPS/SSH形式か検証する。 | `https://github.com/<owner>/<repo>[.git]`、`git@github.com:<owner>/<repo>[.git]`、`ssh://git@github.com/<owner>/<repo>[.git]`を各1件だけ受理し、HTTPS userinfo、query、fragment、別host・remoteを拒否する。 | Draft | 非該当 |
| WORK-F-010 | 診断合格repositoryで`origin`をfetchする。 | 1秒以内に進行中・cancelを表示し、成功結果を記録する。credential helper/SSH agentで認証できなければ秘密値なしで`WORK_ORIGIN_AUTH_FAILED`を表示する。 | Draft | 非該当 |
| WORK-F-011 | fetchの失敗時にsessionを作成しない。 | network、認証、remote不在、Git process失敗のいずれでもsession、local branch、専用worktreeが0件のままになり、ユーザー操作による再試行を表示する。 | Draft | 非該当 |
| WORK-F-012 | fetch後に`origin`が広告するdefault branchと対応remote-tracking headを解決する。 | default branch名と`refs/remotes/origin/<branch>`のcommitを一意に解決し、そのcommit SHAを新規sessionのbase evidenceとして保存する。 | Draft | 非該当 |
| WORK-F-013 | `origin`のdefault branchを解決できない場合に推測せず停止する。 | remote HEAD不在、対応remote-tracking ref不在、複数解釈のいずれかでは`main`または`master`を補完せず、`WORK_DEFAULT_BRANCH_UNKNOWN`を表示してbranchを作成しない。 | Draft | 非該当 |

### branchと専用worktreeの作成

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| WORK-F-014 | session用local branch名を衝突なく生成する。 | `sol/session-<32文字の小文字16進UUID>`を生成し、local・`origin` tracking・worktree branchとの衝突時は最大5回再生成する。全失敗時は`WORK_BRANCH_COLLISION`で停止する。 | Draft | 非該当 |
| WORK-F-015 | session用worktree pathをapplication data内へ一意に生成する。 | `<appDataDir>/worktrees/<repository UUID>/<session UUID>`がcanonical root内かつfilesystem・worktree一覧に未登録なら使う。最大5回の再生成後も衝突すれば`WORK_WORKTREE_COLLISION`で停止する。 | Draft | 非該当 |
| WORK-F-016 | アプリが発行する同一repositoryのworkspace Git操作を直列化する。 | Rust側が発行するfetch、worktree add、repair、removeだけをrepositoryごとのFIFO queueで同時に1件とし、待機中は変更前にcancelできる。このqueueがagentまたは外部processのGit操作を防ぐとは扱わない。 | Draft | 非該当 |
| WORK-F-017 | 解決済みbase commitから新しいlocal branchと専用linked worktreeを作る。 | 作成後の専用worktreeが生成branchをcheckoutし、HEADがWORK-F-012で保存したcommitと一致し、アプリはbranchへupstreamを設定しない。 | Draft | 非該当 |
| WORK-F-018 | session作成で元checkoutのcheckout状態を変更しない。 | 作成前後の元checkoutについてsymbolic branch、HEAD commit、index、staged・unstaged・untracked一覧が一致する。`origin`のremote-tracking refsと`FETCH_HEAD`の更新は差分判定から除く。 | Draft | 非該当 |
| WORK-F-019 | 作成したworktreeを検証してからsessionを利用可能にする。 | directoryの存在、Git common directory、生成branch、base HEAD、clean状態、読み書き可をすべて確認した後だけsessionを`available`にし、1項目でも不一致ならturn開始操作を表示しない。 | Draft | 非該当 |
| WORK-F-020 | sessionの復元情報をSQLiteへ保存する。 | workspace/repository/session ID、sanitized origin、default branch、base commit、local branch、worktree、main thread ID、support assignment証跡、lifecycleを1 transactionで保存し、support thread IDは保存しない。 | Draft | 非該当 |
| WORK-F-021 | 作成途中の失敗でアプリが作ったartifactだけを安全に回収する。 | app-owned worktreeがcleanかつbase commitのままならforceなしでremoveし、app-owned branchに追加commitがなければ削除する。安全条件を満たさないartifactは削除せず`repair_required` recordとして表示する。 | Draft | 非該当 |
| WORK-F-022 | session作成中のキャンセル要求を外部Git操作の終了後に整合させる。 | ユーザーがキャンセルすると進行中Git processへ終了要求を送り、process終了後にWORK-F-021を実行し、`available` sessionを作らない。回収できない場合は回復対象を表示する。 | Draft | 非該当 |

### 複数sessionとagentのworktree共有

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| WORK-F-023 | 同一repositoryから複数のmain sessionを作成できる。 | 同じworkspaceで2件以上を作成したとき、各sessionのsession ID、local branch、worktree pathが相互に異なり、各baseは作成直前のfetch後default headである。 | Draft | 非該当 |
| WORK-F-024 | 1つのsessionのmainと7つのsupport roleへ同じcanonical worktreeとexclusive turn leaseを割り当てる。 | mainと7 root threadは同じworktreeを使い、全`turn/start`がRust管理のpath別lease取得後だけ送信される。同一pathのactive turnは1件、別pathは並行可とする。AskUserQuestion待機中もterminalまで保持し、Quit・timeout・crash時はterminalまたはprocess tree消滅と安定post snapshotを確認して解放する。再起動時はowner不在と安定snapshotを確認したstale leaseだけを回収する。 | Draft | 非該当 |
| WORK-F-025 | 保存session数と同時稼働session数へhard capを設けない。 | 任意の正整数件のsession recordを保存でき、利用可能resourceがある限り4件目以降の作成・開始を件数だけを理由に拒否しない。 | Draft | 非該当 |
| WORK-F-026 | 4件目以降の同時稼働sessionを開始する前にresource warningを出す。 | 開始後の同時稼働数が4以上になる操作では現在数、CPU・memory・model利用増加の可能性、`続行`、`キャンセル`を表示し、続行時は開始し、キャンセル時はsessionとturn状態を変更しない。 | Draft | 非該当 |

### 再起動、再開、外部変更

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| WORK-F-027 | アプリ再起動時に保存済みworkspaceとsessionの対応を復元する。 | 正常終了またはクラッシュ後の起動で、session一覧、選択session、lifecycle state、main thread ID、branch、worktreeをSQLiteから復元し、Git実体の再検証結果を併記する。 | Draft | 非該当 |
| WORK-F-028 | 終了またはクラッシュで中断したturnを自動再実行しない。 | 完了記録のないturnを`アプリ終了により中断`または`予期しない中断`と表示し、起動後にprompt送信、thread resume、Git変更を自動実行しない。 | Draft | 非該当 |
| WORK-F-029 | ユーザーは保存済みsessionを同じmain thread、local branch、専用worktreeで明示再開できる。 | `再開`実行後の新しいmain turnが保存済みmain thread IDとcanonical worktreeを使用し、別branchまたは新規worktreeを作らない。 | Draft | 非該当 |
| WORK-F-030 | dirtyなsession worktreeを変更を保ったまま再開できる。 | staged、unstaged、untrackedの件数とdirty表示を出し、stash、reset、clean、commitを実行せず、ユーザーの`再開`後に同じworktreeで新しいturnを始める。 | Draft | 非該当 |
| WORK-F-031 | detached HEADまたはGit履歴操作中のsessionを注意状態として扱う。 | detached HEAD、merge、rebase、cherry-pick、revert、bisectを検出すると通常prompt送信を停止し、状態名と`解消のため再開`を表示する。ユーザーが実行した場合だけ同じmain threadとworktreeで新しいturnを始める。 | Draft | 非該当 |
| WORK-F-032 | session worktreeが保存済みbranchとは別のattached branchへ変更された場合に通常再開を拒否する。 | branch不一致を検出すると`WORK_SESSION_BRANCH_MISMATCH`と期待branch・現在branchを表示し、自動checkoutせず、外部で期待branchへ戻るまで通常promptを開始しない。 | Draft | 非該当 |
| WORK-F-033 | session worktreeの外部削除またはGit linkage破損時にturnを開始しない。 | path不在、`.git` linkage不正、repository不一致、読取不可、書込不可、`prunable`のいずれかを検出すると`repair_required`にし、原因、再診断、archiveを表示してworktreeを自動再作成しない。 | Draft | 非該当 |
| WORK-F-034 | directoryが存在するsession worktreeのlinkageをユーザー操作でrepairできる。 | 確認後に対象pathだけへGit worktree repairを実行し、repository、branch、HEAD、dirty状態を再検証して合格時だけ元のlifecycle stateへ戻す。失敗時は既存fileを削除しない。 | Draft | 非該当 |
| WORK-F-035 | 既存sessionをremote default headへ自動追従させない。 | `origin`のdefault branch名またはhead commitが変わっても、既存sessionのlocal branchへrebase、merge、reset、checkoutを実行せず、新規sessionだけが次回fetch後のheadを使用する。 | Draft | 非該当 |

### archiveとcleanup

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| WORK-F-036 | turnが動いていないsessionをarchiveできる。 | archive後はactive一覧と新規turn対象から外れ、main thread ID、support assignment証跡、local branch、専用worktree、dirty file、timeline evidenceを変更せず保持する。 | Draft | 非該当 |
| WORK-F-037 | 実行中またはユーザー回答待ちturnがあるsessionのarchiveを拒否する。 | mainまたはsupportに`running`が1件以上ある場合、またはmainが`waiting_for_user`の場合は対象turnを表示し、interruptもarchiveも実行しない。 | Draft | 非該当 |
| WORK-F-038 | archived sessionを再検証後にunarchiveできる。 | WORK-F-032からWORK-F-034の検証に合格したsessionだけを`available`へ戻し、不合格時は`repair_required`のまま原因を表示する。 | Draft | 非該当 |
| WORK-F-039 | cleanupの確認またはキャンセルをユーザーが選べる。 | archived sessionの名前、local branch、worktree path、保持されるbranch・evidence、削除されるworktreeを表示し、キャンセル時はGit、filesystem、SQLiteを変更しない。 | Draft | 非該当 |
| WORK-F-040 | cleanかつ正常なapp-owned archived worktreeだけをforceなしでcleanupする。 | no-running-turn、turn lease ownerなし、correct branch、attached HEAD、no-operation-in-progress、cleanをすべて満たす場合だけ`git worktree remove`相当をforceなしで実行し、満たさない場合は該当条件を表示して削除しない。 | Draft | 非該当 |
| WORK-F-041 | cleanup後もlocal branchとsession evidenceを保持する。 | worktree directory削除後にlocal branch、commit、main thread ID、support assignment証跡、timeline evidence、test evidenceを残し、sessionを`cleaned`と表示する。local branchとremote branchを削除するGit操作を発行しない。 | Draft | 非該当 |

### 禁止操作と証跡

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| WORK-F-042 | desktop shellはworkspace lifecycleを契機にcommit、push、PR作成、merge、remote branch削除を自動実行しない。 | session作成、再開、archive、unarchive、cleanup、turn完了の各試験で、shellが発行したGit・GitHub操作に前記5操作が0件である。ユーザー指示に基づくmain Codex turnの操作は別 actorとしてtimelineへ記録する。 | Draft | 非該当 |
| WORK-F-043 | workspace lifecycleとGit診断の結果を構造化eventとして保存する。 | repository診断、fetch、default head解決、作成、再検証、再開、archive、unarchive、repair、cleanup、キャンセルごとにsession ID、event type、status、UTC時刻、短いerror codeを保存し、credential、remote userinfo、絶対pathを永続ログへ含めない。 | Draft | 非該当 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| repository選択 | directory | 未選択 | 必須 | OS pickerで1件。file、複数選択、bare、dirty、detached、履歴操作中、submodule宣言、sparse checkout、非GitHub `origin`を拒否する | 選択値を保存せず、WORK-F-004からWORK-F-013のerror codeと再選択を表示する |
| 同時稼働 | 4件目以降の開始判断 | 未選択 | 条件付き | 開始後の同時稼働sessionが4以上のとき`続行`または`キャンセル` | キャンセルではsessionとturn状態を維持する |
| repair | worktree repair確認 | 未選択 | 条件付き | directoryが存在し、app-owned session IDとpathが一致する場合だけ確認できる | キャンセルまたはrepair失敗ではfileを変更しない |
| cleanup | archived session cleanup確認 | 未選択 | 条件付き | WORK-F-040の全条件合格時だけ実行できる | キャンセルまたは条件不合格ではworktreeを維持する |

branch名、worktree path、base branch、Git credentialの自由入力欄は提供しない。Git credentialはユーザーの既存Git credential helperまたはSSH agentを使用し、アプリへ入力・保存しない。

### repository作成可否デシジョンテーブル

上から順に評価し、最初に一致した結果を適用する。

| 条件 | 結果 |
|---|---|
| dirty | `WORK_SOURCE_DIRTY`で停止 |
| detached | `WORK_SOURCE_DETACHED`で停止 |
| 履歴操作中 | `WORK_SOURCE_OPERATION_IN_PROGRESS`で停止 |
| layout非対応 | `WORK_REPOSITORY_LAYOUT_UNSUPPORTED`で停止 |
| `origin`非対応 | `WORK_ORIGIN_UNSUPPORTED`で停止 |
| fetch失敗 | fetch error分類で停止 |
| default head不明 | `WORK_DEFAULT_BRANCH_UNKNOWN`で停止 |
| 上記なし | branch・worktree作成へ進む |

## デスクトップ固有要件

[デスクトップ共通仕様](../../screen-design/desktop-common-specification.md)との差分だけを次に定義する。

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | macOSは実機E2E、Windows・UbuntuはCIでpath separator、case sensitivity、Git process終了、turn lease回復を検証する。 | WORK-F-002、WORK-F-014〜WORK-F-024 |
| ウィンドウ生成・再利用 | 共通仕様どおり単一`main`を再利用し、repository pickerはOS native dialogとして開く。追加windowを作らない。 | WORK-F-001〜WORK-F-003 |
| 閉じる・アプリ終了 | window closeではworkspace operationとturnを継続する。明示Quitでは共通仕様どおりinterrupt・保存し、次回起動で自動再実行しない。 | WORK-F-027、WORK-F-028 |
| 未保存データ | 元checkoutへ未保存データを作らない。session worktreeのdirty fileはSQLiteへ複製せずfilesystem上に保持する。 | WORK-F-018、WORK-F-030 |
| ローカルデータ | workspace/session mappingはSQLite、branch・HEAD・dirty状態はGitとfilesystemを正本とし、起動時に両者を照合する。 | WORK-F-020、WORK-F-027、WORK-F-033 |
| オフライン | 保存済みsession一覧とevidenceは閲覧できる。新規session作成はfetch前に停止し、再接続後も自動再試行しない。 | WORK-F-010、WORK-F-011、WORK-F-027 |
| ファイル・OS操作 | picker、canonical path検証、application data内のadd・repair・removeをRust側で実行する。 | WORK-F-002〜WORK-F-004、WORK-F-015、WORK-F-022、WORK-F-034、WORK-F-039〜WORK-F-041 |
| メニュー・ショートカット | workspace固有のapp menuとglobal shortcutは追加しない。キーボード操作は各画面詳細仕様で定義する。 | WORK-F-001、WORK-F-029、WORK-F-036〜WORK-F-040 |
| Deep Link・ファイル関連付け | 非該当: ハッカソン版ではrepository pathの外部受信を提供しない。 | WORK-F-002 |
| 通知 | workspace作成、archive、cleanupではOS通知を送らない。回復不能失敗の通知は共通仕様どおりとする。 | WORK-F-011、WORK-F-033 |
| Capability・認可 | `main`へdirectory open dialogに必要な権限だけを付与し、Gitとfilesystem操作はsession IDからRust側でpathを再解決する。 | WORK-F-002、WORK-F-015〜WORK-F-022、WORK-F-034、WORK-F-040 |
| アップデート・互換性 | SQLite migration後もrepository UUID、session UUID、branch、worktree mappingを維持し、移行失敗時は共通仕様どおり旧DBを上書きしない。 | WORK-F-020、WORK-F-027 |

## 画面・UI

画面レイアウト、表示状態、操作フローは各画面詳細仕様を正本とし、この文書では画面IDと要件IDの対応だけを管理する。

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-001` | セッションダッシュボード | WORK-F-001〜WORK-F-026、WORK-F-036〜WORK-F-041 | 新規 | [S-001 セッションダッシュボード](../../screen-design/S-001_session-dashboard.md) |
| `S-002` | コーディングワークスペース | WORK-F-024、WORK-F-027〜WORK-F-035 | 新規 | [S-002 コーディングワークスペース](../../screen-design/S-002_coding-workspace.md) |
| `S-003` | セッション証跡 | WORK-F-012、WORK-F-020、WORK-F-027、WORK-F-028、WORK-F-043 | 新規 | [S-003 セッション証跡](../../screen-design/S-003_session-evidence.md) |
| `S-004` | 設定・診断 | WORK-F-004〜WORK-F-013、WORK-F-021、WORK-F-022、WORK-F-031〜WORK-F-034 | 新規 | [S-004 設定・診断](../../screen-design/S-004_settings-diagnostics.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | Gitは固定commandと引数配列で実行する。branch allowlistとcanonical containmentを必須とする。worktreeは作業分離でありFull accessのsandboxではない。 |
| 権限 | WebViewは任意path、任意Git argument、任意shellを渡せない。Rust側はworkspace ID、session ID、thread IDを照合し、app-owned worktrees root外への作成、repair、removeを拒否する。 |
| プライバシー | repository/worktree pathとsanitized originはlocal SQLiteだけに保存する。ログ・通知に絶対path、GitHub owner、credential、prompt、file内容を含めない。 |
| 監査・ログ | WORK-F-043を保存する。Git command種別、exit分類、開始・終了UTCを記録し、stdout・stderrはcredentialと絶対pathをredactした要約だけを保持する。 |
| 性能 | macOS Apple Silicon（8 CPU core、16 GB RAM）、1,000 file・100 MiB・submodule/sparseなしのfixtureを使う。3 main turn同時稼働中、30回のsession切替表示p95を500 ms以下、Git状態更新p95を3秒以下とする。model応答とfetch待ちは除外する。3同時を保証し、4件目以降はWORK-F-026を適用して実測値を保証しない。 |
| 信頼性・復旧 | アプリ発行のworkspace Git操作はWORK-F-016、同一worktreeのagent turnはWORK-F-024で直列化する。外部processは遮断せず変化として記録する。クラッシュ後はGit実体を再検証し、確認できないartifactを削除、reset、stash、checkoutしない。 |
| アクセシビリティ | 共通仕様どおり、repository選択、session選択・作成・再開、resource warning回答、archive、unarchive、cleanup、キャンセルをkeyboardだけで実行できる。状態とerrorを色だけで伝えない。 |
| 多言語・地域 | 日本語・英語を提供する。branch、Git ref、error codeは翻訳せず、pathはOSのcase sensitivityとseparatorを保つ。 |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| Git executable | `fetch`、`remote`、`worktree add/list/repair/remove`を実行できるGitがOS上で利用可能である。起動時診断でcommand対応を確認する。 | 解決済み: 不在・非対応時の停止契約を定義済み | session作成、repair、cleanupを開始できない |
| GitHub `origin` | 1件の許可形式fetch URL、remote HEAD、default branchが存在し、fetchに必要な既存credential helperまたはSSH agentが利用できる。 | 解決済み: runtime診断を定義済み | WORK-F-009からWORK-F-013で停止する |
| Tauri dialog・path | native directory pickerとapplication data directoryを使用する。 | 解決済み | repository選択または専用worktree作成を開始できない |
| [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) | lifecycle、SQLite、Full access同意、Capability、OS差分、ログ秘匿を適用する。 | 解決済み | 全sessionの安全な起動・復元を保証できない |
| [codex-main-session要件](../codex-main-session/requirements.md) | main root threadの作成、turn開始、AskUserQuestion、interruptを提供する。 | Draft間で整合確認予定 | main sessionを開始・再開できない |
| [support-agent-orchestration要件](../support-agent-orchestration/requirements.md) | 7つのsupport role、ephemeral root thread、[canonical worktree別turn lease](../support-agent-orchestration/requirements.md#同一worktreeの競合制御)を提供する。 | Draft | WORK-F-024の共有と直列化を検証できない |
| [activity-history要件](../activity-history/requirements.md) | lifecycle eventとGit evidenceをtimelineへ表示する。 | Draft間で整合確認予定 | WORK-F-043のeventをユーザーが追跡できない |
| [git-review-harness要件](../git-review-harness/requirements.md) | Codex turnによるGit操作、diff、test、reviewの証跡を扱う。 | Draft間で整合確認予定 | shell操作とCodex Git操作のactorを区別できない |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| なし | 本文の契約でハッカソン版を実装する | 仕様責任者レビューで8機能間のID対応だけを確認する | いいえ |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [要件定義基準](../../rules/requirements-definition-standards.md) | 1挙動1ID、受け入れ条件、desktop境界、異常系の記述基準 |
| [ID管理ルール](../../rules/id-management-rules.md) | `WORK` Prefix、要件ID、画面IDの正本 |
| [デスクトップ共通仕様](../../screen-design/desktop-common-specification.md) | window、Quit、復元、SQLite、Capability、Full access、3OS共通契約 |
| [Git公式 git-worktree](https://git-scm.com/docs/git-worktree) | linked worktreeの作成・一覧・repair・remove、branch重複、clean remove、submodule制約の根拠 |
| [Git公式 git-fetch](https://git-scm.com/docs/git-fetch) | `origin`からobjectとrefを取得しremote-tracking branchを更新する契約の根拠 |
| [Git公式 git-remote](https://git-scm.com/docs/git-remote) | remote HEADとdefault branchの解決契約の根拠 |
| [Tauri公式 Dialog](https://v2.tauri.app/plugin/dialog/) | native directory pickerとキャンセル結果の根拠 |
| [Tauri公式 path API](https://v2.tauri.app/reference/javascript/api/namespacepath/#appdatadir) | bundle identifierに対応するapplication data directoryの根拠 |

外部資料は2026-07-16に確認した。

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Not Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 未合意 |
| 残る非ブロック論点 | 8機能のDraft間における画面ID・thread lifecycle・timeline eventの相互参照確認 |

## 着手可チェック

- [x] 背景と目的が説明できる。
- [x] スコープ内・外と理由が明確である。
- [x] 全機能要件に一意な要件IDがある。
- [x] 全機能要件に検証可能な受け入れ条件がある。
- [x] 正常系、異常系、キャンセル、権限差分、空状態、境界値を確認した。
- [x] デスクトップ固有要件を確認し、非該当も明記した。
- [ ] 画面IDと要件IDの相互参照が一致している。
- [x] 非機能要件と依存関係を確認した。
- [x] 着手ブロックが「はい」または「不明」の未確定事項がない。
- [ ] 仕様責任者がレビューし、合意した。
