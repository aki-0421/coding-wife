---
title: "S-003 セッション証拠"
description: "自動checkpointのscope、ownership、verification、risk、diff、判断、失敗、復旧方法をread-only中心に確認する画面仕様。"
updated: 2026-07-18
read_when:
  - "Commit tab、checkpoint gate、review pack、compare、revert commit、recovery branchを実装するとき。"
  - "S-003とSUP、GIT、HIST、APP要件の対応を確認するとき。"
screen_id: "S-003"
status: "Approved"
---

# S-003 セッション証拠

| 項目 | 内容 |
|---|---|
| window label | `main` |
| React route / view key | `/workspace/:workspaceId/evidence` / `session-evidence` |
| tab label | `Commit`。checkpoint/review evidenceの入口であり、manual commit操作ではない |
| 対象OS | macOS 14以降、Apple Silicon |
| デザイン | [DESIGN.md](../../DESIGN.md)、Figma Desktop node `8:2`のshell、[demo.png](../thinking/demo.png) |
| 共通仕様 | [デスクトップ共通仕様](desktop-common-specification.md) |
| 廃止理由 | 非該当 |
| 後継画面ID | 非該当 |

## 目的

利用者が、AIの作業を「終わったという主張」ではなく、work unitごとのscope、ownership、verification、risk、diff、decision、failed attemptで評価できるようにする。安全条件を満たした自動local checkpointだけを提示し、既存の利用者変更を保護したまま比較と可逆的な復旧を行えるようにする。

## 対象範囲

### 含める

| 対象 | 内容 |
|---|---|
| Baseline | HEAD、branch/detached、index、tracked diff、untracked fingerprint |
| Ownership | owned path/hunk、pre-existing、external、Unownedの分類 |
| Gate | Scope、Ownership、Verification、RiskのPass / Needs review / Fail / Unknown |
| Checkpoint | gate通過後のautomatic local commit statusとSHA |
| Review pack | objective、acceptance、diff、tests、decisions、failed attempts、risks、restore |
| Compare | 任意の2 checkpointのfile、line、decision、verification差分 |
| Recovery | revert commit、checkoutしないrecovery branch、stale/dirty/conflict blocking |
| Reviewer |明示trigger時のfixed diff snapshot reviewとschema/stale/fallback status |

### 含めない

| 非対象 | 理由 | 代替 |
|---|---|---|
| manual commit button / shortcut | 4 gateを迂回させない | work unit完了時のautomatic checkpoint |
| arbitrary stage / hunk editor | ownership判定をWebViewへ委ねない | Rust Git serviceのowned stage |
| push / merge / force / remote ref update | local reviewのMVP境界を越える | 外部Git workflow |
| hard reset / checkout discard | user changeを破壊し得る | revert commit / recovery branch |
| interactive rebase | 履歴書換えをMVPに含めない | 外部Git client |
| raw terminal / raw Git args | trust boundaryを守る | typed compare/restore action |
| submodule/LFS mutation | ownership境界が異なる | read-only evidence + unsupported status |

## 表示契機と終了

| 項目 | 内容 |
|---|---|
| 表示契機 | S-002のCommit tab、checkpoint completed/blocked event、review-ready link、restart recovery。非activeのforce-mounted panelはnative baseline inspectを開始しない |
| 表示前提 | workspace IDが存在すること。missing repo、unsupported repo、offlineでも保存済みevidenceをread-only表示する |
| 初期フォーカス | selected review pack heading。blocked/error時は最初の回復操作、0件時はChatへ戻る |
| 正常完了 | evidenceを確認してChatへ戻る、またはsafe restore/recovery branchのterminal resultを確認する |
| キャンセル | compare/restore/branch dialog開始前のselection、fingerprint、scrollを維持する |
| 閉じる操作 | Git mutation中は完了またはsafe abort後、[共通close契約](desktop-common-specification.md#windowとtitlebar)に従う |
| 再表示 | filters、selected pack、selected file、diff position、compare pair、review expansionを復元する |

## 利用者と権限

| 利用者・ロール | 表示 | 操作 | 拒否時の動作 |
|---|---|---|---|
| ローカル利用者 | baseline、gate、review pack、sanitized diff、Git result | filter、inspect、compare、review、safe restore、branch | dirty/stale/conflict/unsupported時はmutationせず理由表示 |
| React WebView | normalized evidence、typed object/ref ID | render、selection、typed IPC | arbitrary Git args、path stage、shell、raw secretを送らない |
| Rust Git service | canonical repo、objects、refs、index、working tree | fingerprint、owned stage、commit、compare、revert、branch | scope/ownership/verification/risk不明ならfail closed |
| Codex main session | work unit objective/acceptance/manifest/evidence | checkpoint候補を提出 | stage/commit/restoreを直接実行しない |
| Checkpoint reviewer | content-hash付きfixed diff最大1MiB | schemaに沿ったreview summaryを返す | repo、追加file、toolへアクセスしない |

## 情報優先順位

表示優先順位は次の順とし、Live2Dや成功演出より常に上位に置く。

1. destructive risk、permission、stale HEAD、dirty user change、conflict、unsupported repository。
2. 4 gateのFail / Unknown / Needs reviewとcheckpoint失敗。
3. acceptanceとverification failure、failed attempt、known risk。
4. ownershipとpre-existing/unowned change。
5. diff、decision、checkpoint metadata、reviewer summary。
6. success statusとcompanion。

successは4 gate、checkpoint commit、review pack persistenceの再読、history sequenceの確定がすべて成功した時だけ表示する。test failure、Unknown、`ref_updated_history_pending`を折りたたんだまま`Done`にしない。

## 画面構成

### shell

sidebarと81px headerは[S-002](S-002_coding-workspace.md)と同じ位置を維持し、Commit tabをactiveにする。standard body 1214.95×754.99pxはevidence専用に再構成し、S-002の607px Chat/Companion二分は適用しない。

| 領域 | 標準1470×836 | 表示内容 | scroll owner |
|---|---:|---|---|
| workspace sidebar | 255.04px | workspace lifecycle/attention | group list |
| summary bar | main body上72px | selected checkpoint、4 gate summary、SHA、status、filter |固定 |
| pack list | 300px | work unit/checkpoint時系列、status、risk、test count | list単独 |
| detail | 残幅 | Overview / Files / Verification / Decisions / Risks / Restore | detail単独 |
| file list | detail内240px | owned/pre-existing/unowned、status、line count | Files選択時単独 |
| diff viewer | file listの右 | lazy loaded unified/split相当のread-only diff | file単位 |

標準ではlist/detail splitを使い、960〜1279pxではpack listを280px、detailを残幅にする。200% text zoomではpack listをportal drawerへ移し、detail、gate failure、restore blocking reasonを優先する。Companion canvasは標準で描画せず、必要ならheaderへtext statusとmuteだけを残す。

### checkpoint list

| row data | 表示規則 |
|---|---|
| identity | work unit title、short SHAまたは`Checkpointなし`、created time |
| status | Ready / Needs review / Blocked / Failed / Reverted / Interruptedをtext、icon、shapeで表示 |
| gate | Pass数と最も高いseverityを表示。failure名を省略しない |
| verification | pass/fail/not run count |
| risk | highest risk categoryとunresolved count |
| ownership | owned/pre-existing/unowned file count |

filterはAll / Needs attention / Ready / Revertedとtext queryを提供する。workspace切替時はfilterを維持してselectionを同workspace内で補正する。timestampだけのcard gridにはしない。

### gate summary

| Gate | Pass | Needs review | Fail / Unknown | recovery |
|---|---|---|---|---|
| Scope | objectiveと1〜20 acceptanceが明確 |範囲が広いが確認可能 | goal/acceptance欠落、対象外path | Chatでwork unitを修正 |
| Ownership |全stage候補がowned、pre-existing除外 |外部変更の再確認が必要 | Unowned hunk、baseline不一致 | refreshし所有権を再判定 |
| Verification |必要test/checkが全Pass |高riskゆえ追加確認 |未実施、failure、stale result | Chatでverifyまたはscope修正 |
| Risk | low/mediumでpolicy通過 | auth/permission/secret/migration/data/Git history |未分類、禁止operation | evidence確認後の明示approvalまたはscope変更 |

4 gateは一つの総合色だけに畳まず、各result、根拠event、観測時fingerprint、再評価条件を表示する。全Passの時だけcheckpoint作成を開始する。RiskのNeeds reviewを単なるcheckboxで解除せず、対象、影響、可逆性を読んだ明示decision eventへ紐付ける。

### Review pack

| section | 必須内容 | 表示・操作 |
|---|---|---|
| Overview | SHA、objective、acceptance、message、baseline、duration | copy short SHA、related timelineへ移動 |
| Files | owned/pre-existing/unowned、diff stats、manifest | filter、file選択、lazy diff |
| Verification | test/check、result、duration、evidence ref | failureを初期展開、full outputはsanitized artifact |
| Decisions | question、answer、reason、fingerprint、reversibility | timeline eventへ移動 |
| Failed attempts |試行、失敗理由、残存影響、cleanup | 0件でも`記録なし`と明示 |
| Risks | known risk、severity、mitigation、unresolved owner | unresolvedを初期展開 |
| Restore | revert条件、recovery branch、対象SHA、予想影響 | preflight、confirm、result |

Conventional Commits messageは英語summaryと英語bulletを原文表示し、翻訳しない。absolute private path、credential、secretはpack作成前にredactする。support reviewerのsummaryは証拠への補助であり、gate結果を変更しない。

### diff viewer

| 項目 | 契約 |
|---|---|
| 初期load | file metadataとdiff statだけ。選択fileのdiffを1件ずつ要求する |
| 表示 | relative path、create/update/delete/rename、old/new line、owned marker |
| Ownership | owned、pre-existing、external、Unownedをlabelとline markerで区別する |
| Secret | secret scanner hitは値を表示せず`[REDACTED]`とrule IDを示す |
| Binary | metadata、size/hash変化、preview不可理由だけ表示する |
| Oversize | line countと先頭/末尾の安全なchunk navigation。全DOM化しない |
| Copy | visible sanitized hunkまたはsummaryだけ。raw artifact全copyは提供しない |

500 filesまたは50,000 changed linesまでsummaryを5秒以内に表示し、virtualized file listとchunked diffを使う。load errorは他fileやpackを巻き込まず、該当fileにretryを置く。

### Compare

任意の同一repository内checkpointをFrom/Toへ選び、file list、add/delete、gate、test、decision、riskの差をread-only表示する。working treeやHEADを移動しない。異なるrepository、未知object、到達不能objectは比較を開始せず、selectionを保持する。

### Restoreとrecovery branch

#### Revert commit

1. 対象checkpoint、現在HEAD、branch、index、working tree、user changeをRustで再fingerprintする。
2. uncommitted user change、HEAD stale、conflict予測、unsupported repoがあれば開始前にBlockedにする。
3. 対象file、予想影響、元commitを削除しないこと、新しいrevert commitを作ることを確認画面に示す。
4. 明示確認後、private index/object storeで逆変更treeとrevert commitを作り、real index/worktreeをGit実行系へ渡さずtarget refをCAS更新する。
5. 元commit、revert SHA、terminal result、必須history sequenceをimmutable packへ追記し、再読一致後だけ成功表示する。
6. conflict、hook、identity、disk、permission failureは成功表示せず、journal、working tree、index、refsの状態を再診断する。

#### Recovery branch

valid checkpoint SHAと`git check-ref-format`を通る新規branch nameからlocal branchを作る。branchはcheckoutせず、current HEAD/index/working treeを変更しない。成功時は完全なrefとsource SHAを表示する。remoteへ送信しない。

dialogをcancelした場合、HEAD、refs、index、working treeが開始前fingerprintと一致することを再確認する。違いがあれば単なるキャンセル成功にせず診断を表示する。

## 表示状態

| 状態 | 進入条件 | 表示 | 操作可否 | 状態から抜ける条件 |
|---|---|---|---|---|
| 初期化中 | pack、Git fingerprint、selected diff読込中 | shell、summary/list/detail skeleton | tab移動、Quit | queryがterminalになる |
| 通常 | 1件以上のpersisted pack | list、gate、detail、read-only action | inspect、filter、compare、条件付きrestore | selection/action/error |
| データなし | work unit/checkpoint 0件 | `まだ証拠はありません`、Chatへ戻る。空tableは出さない | Chat、Settings、Quit | first work unit event |
| gate処理中 | scope/ownership/verification/risk評価中 | gate単位progress、observed fingerprint | inspect、StopはChatへ |全gate terminal |
| checkpoint処理中 | all Pass、owned stage/commit/pack中 | prepared / objects ready / ref updated / history pendingのdurable step、elapsed、close待機理由 | read-only inspect、Cancel可能stepだけ | persisted pack再読success / failure / safe compensation |
| Needs review | Riskまたはreviewerが確認要求 |対象、影響、可逆性、根拠 | inspect、Chat decision。automatic mutationなし | valid approval/scope変更 |
| Blocked | gate Fail/Unknown、stale、dirty、unsupported | blocking gate、affected path、保持data、回復手順 | refresh、Chat、read-only evidence | precondition再評価 |
| オフライン | Codex/support/network unavailable | local Git/evidence available、reviewer unavailable | local inspect/compare/restore条件付き |明示再診断 |
| エラー | Git/DB/diff/reviewer failure | code、operation、影響、作成されていないobject、retry |影響外閲覧、retry/diagnostic | terminal recovery |
| 権限不足 | repo/object/index write不可 |拒否operation、scope、再診断。private path非表示 | read-only evidence、Settings | permission変更後のretry |
| キャンセル後 | compare/restore/branch dialog cancel | selection、fingerprint、scrollを維持 |元操作または別操作 |次の明示操作 |
| 再起動復旧 | gate/checkpoint/restoreにterminal eventなし | journal state、expected old/new ref、pack digest、before/after fingerprint、last durable pack | diagnose、read-only、exact history retryまたはsafe compensation | state分類完了 |
| stale | external HEAD/ref/working tree変更 | observed/current fingerprint差、refresh required | read-only、refresh | fresh baseline確立 |
| large diff | threshold到達 | summary first、file/chunk lazy placeholder | filter、1 file load、cancel load | selected chunk terminal |
| reviewer fallback | timeout/schema/stale/support disabled | deterministic review unavailable text、gateは不変 | main evidenceの閲覧 |次の明示review trigger |

## 操作

| 操作 | 事前条件 | 正常結果 | キャンセル時 | 失敗時 | 関連要件ID |
|---|---|---|---|---|---|
| pack選択 | workspace内のpack | summary/detailを同一packへatomicに切替 | 非該当 |前selection維持 | `GIT-F-052` |
| gate詳細を開く | gate result存在 |根拠event、fingerprint、recoveryを表示 |閉じるとtriggerへfocus | raw payloadを表示しない | `GIT-F-047`〜`GIT-F-049` |
| file diffを開く | file metadata存在 |選択fileだけをlazy load | load cancelでmetadata維持 | file単位retry | `GIT-F-045`, `GIT-F-063` |
| 2 checkpoint比較 |同一repoのvalid object 2件 | read-only差分を表示、Git状態不変 | selection維持、object不変 | reason表示、状態不変 | `GIT-F-056` |
| reviewerを起動 | explicit trigger、fixed diff 1MiB以下 | schema-valid summaryをpack補助情報へ表示 | task cancel、evidence不変 | fallback、main/gate不変 | `SUP-F-054`, `SUP-F-056`〜`SUP-F-058` |
| checkpoint結果を確認 | automatic checkpoint terminal | SHA、message、pack、gateを表示 | 非該当 | working tree保持、retry条件 | `GIT-F-050`〜`GIT-F-055` |
| revert commit | fresh/safe/confirmed、valid SHA |新しいrevert commitとpackを作成 |全Git fingerprint不変 |成功表示せず再診断 | `GIT-F-057`, `GIT-F-058`, `GIT-F-060`〜`GIT-F-062` |
| recovery branch作成 | valid SHA、新規valid ref、confirmed | checkoutせずlocal ref作成 | refs/HEAD/index/tree不変 |入力保持、作成済みと表示しない | `GIT-F-059`, `GIT-F-060`, `GIT-F-062` |
| refresh evidence | mutation非実行 | Gitを再fingerprintしgate/pack freshness更新 |前state維持 | staleのままreason表示 | `GIT-F-061`, `GIT-F-065` |

## 入力項目

| 項目 | 初期値 | 必須 | 制約・境界 | エラー表示 | 保存契機 |
|---|---|---|---|---|---|
| pack filter |前回値 | 任意 | status allowlist + query 0〜200文字 | filter保持 | valid変更時 |
| compare From / To | currentとprevious |比較時必須 |同一repoの40桁commit object、異なる2件 | field直下、selection保持 | UI selectionだけ |
| restore SHA | selected pack | revert時必須 | repository内の40桁commit object、再照合 | dialog内、mutationなし | terminal result event |
| recovery branch | `recovery/{short-sha}` | branch作成時必須 | `check-ref-format`、1〜200 byte、未使用ref | field直下、入力保持 |作成成功event |
| restore confirmation |未確認 | revert時必須 |対象SHA/影響を表示後の明示button | action disabled reason |保存しない |

## ネイティブ連携

実際のCapability設定は`src-tauri/capabilities/`を正本とし、WebViewはGit command stringやstage path listを渡さない。

| ユーザー操作・system event | 実行境界 | Tauri plugin / Command | 必要なCapability・認可 | キャンセル時 | 拒否・失敗時 |
|---|---|---|---|---|---|
| baseline/refresh | Rust Git service | `inspect_git_baseline` | canonical registered root、read-only allowlist |前snapshot維持 | stale/blocked |
| gate/checkpoint | Rust Git service | `evaluate_and_checkpoint_work_unit` | validated Codex terminal work-unit event、owned manifest、4 gate Pass、isolated temporary index、fsync journal、HIST exact event preflight。実index fingerprint不変 | safe abort可能stepだけ | source/index/user change保持、ref更新済みならhistory pendingまたはsafe compensation |
| diff/compare | Rust Git service | `read_evidence_diff` / `compare_checkpoints` | validated object ID、repo ID、size limit | loadだけ停止 |該当file/error envelope |
| revert | Rust Git service | `create_revert_checkpoint` | fresh HEAD、clean safety check、validated SHA、confirm token、private tree/object construction、journaled ref CAS、immutable restore event |開始前なら全状態不変 | conflict/lock/disk/permissionをerror、terminal未確定は再起動診断 |
| recovery branch | Rust Git service | `create_recovery_branch` | validated SHA/ref、local ref作成だけ、checkout禁止 | refs不変 | ref作成済みと表示しない |
| reviewer | Rust support policy | `review_fixed_diff_snapshot` |明示trigger、hash、UTF-8最大1MiB、tool/cwdなし | task cancel | fallback、gate不変 |
| sanitized copy | Tauri clipboard | `copy_evidence_summary` | rendered redacted textだけ | 非該当 | raw diffへfallbackしない |

## ウィンドウ固有動作

| 項目 | 動作 |
|---|---|
| 生成・再利用 |同じ`main` windowとworkspace selectionを維持してCommit tabへ切替える |
| 初期サイズ・最小サイズ |共通の1470×836 / 960×640 |
| リサイズ | detailを優先し、listはdrawer化できる。blocking reasonとrestore actionを欠落させない |
| 最大化・全画面 | detail/diffへ超過幅を与え、本文line lengthは最大100ch |
| 常に手前へ表示 | 不可 |
| 閉じる操作 | read-only時は共通どおり。Git mutation中はterminalまたはsafe abortまで明示status |
| 未保存変更がある場合 | filter/selectionは保存。restore/branch入力はcancel扱いでGit状態を変えない |

## メニュー・ショートカット

| 操作 | macOS | Windows / Linux | 有効条件 | 実行結果 |
|---|---|---|---|---|
| tab移動 | `Control+Tab` / `Control+Shift+Tab` | 非対応 | Git confirm dialogなし | main tabs循環 |
| filter focus | `Command+K` | 非対応 | evidence active | queryへfocus |
| non-destructive overlay close | `Escape` | 非対応 | detail/popover | selection維持、triggerへfocus |
| manual commit | 提供しない | 非対応 | 常時 | mutationなし |
| restore / branch | shortcutなし | 非対応 | safe preflight + explicit button |確認dialogを経由 |

## データ保持

| データ | 正本・保存先 | 保存契機 | 復元契機 | 破棄条件 | 失敗時 |
|---|---|---|---|---|---|
| Git object/ref/source | repository | Rust Git transaction成功時 | refresh/restart | appから自動削除しない | Git再診断 |
| baseline/ownership/gate | append-only SQLite + hash artifact |観測・評価terminal時 | pack/query | workspace history明示削除 | mutationをBlock |
| review pack | SQLite + content hash | checkpoint terminal後のtransaction | Commit tab/restart | workspace history明示削除 | checkpoint成功とpack失敗を分離表示 |
| support reviewer metadata | SQLite | task terminal | pack detail | history削除 | fallback status |
| support raw prompt/response |保存しない | 非該当 |復元しない | invocation終了 | summary schemaだけ使用 |
| selection/filter/diff anchor | Rust SQLite | valid UI変更/scroll settle | route return | Reset UI state | nearest valid default |
| restore dialog input | React transient |保存しない | dialog中だけ | success/cancel/route leave |入力保持できる範囲で保持 |

## OS差分

| 項目 | macOS | Windows | Linux |
|---|---|---|---|
| support | macOS 14+ Apple Silicon | MVP非対応 | MVP非対応 |
| Git | user-installed Gitの必要capabilityをpreflight | 非該当 | 非該当 |
| modifier / clipboard | Command / native clipboard | 非該当 | 非該当 |
| unsupported platform | artifactを提供しない |対応済みと表示しない |対応済みと表示しない |

## アクセシビリティ

- focus順はsummary/filter、pack list、gate、detail tabs、file list、diff、restore actionとする。
- gate、diff、file statusは色だけでなくPass/Needs review/Fail/Unknown、create/update/delete、owned/unownedのtextとshapeを付ける。
- list/detail切替時はselected pack headingへfocusを移し、diff loadでfocusを奪わない。
- code/diffはmono、横scroll、行番号のaccessible labelを持ち、赤緑だけでadd/deleteを区別しない。
- failure、known risk、restore blocking reasonはcollapsedでもheadingとcountを読み上げられるようにする。
- mutation confirmationは対象SHA、操作がrevert commitであること、元commitを削除しないことを読み上げる。
- 200% text zoomではpack listをdrawer化し、gate detailと安全なキャンセルに到達できる。
- live regionはcheckpoint terminal、blocking state、restore terminalだけに限定し、diff行を逐次読み上げない。

## 性能

| 指標 | 合格条件 |
|---|---:|
| 500 files / 50,000 lines summary | p95 5,000ms以下 |
| file diff | 1件ずつlazy loadし、他fileのinteractionをblockしない |
| 500 owned files / 50MiB checkpoint | gate完了後stage+local commit p95 5,000ms以下 |
| filter/selection feedback | p95 100ms以下 |

## 関連要件

| 要件ID | この画面での扱い | 要件定義書 |
|---|---|---|
| `SUP-F-054`, `SUP-F-056`〜`SUP-F-058` | fixed diff reviewer、schema、stale/failure fallback | [support-agent-orchestration](../requirements/support-agent-orchestration.md) |
| `GIT-F-043`〜`GIT-F-071` | baseline、ownership、gate、checkpoint、pack、compare、restore、config isolation、fingerprint、journal | [git-review-harness](../requirements/git-review-harness.md) |
| `HIST-F-038`, `HIST-F-044`〜`HIST-F-051`, `HIST-F-057`, `HIST-F-060` | evidence永続化、filter/anchor、failure/restart recovery、mutation前preflight | [activity-history](../requirements/activity-history.md) |
| `APP-F-055`, `APP-F-059`〜`APP-F-062` | Commit tab、responsive、focus、text zoom、state | [desktop-shell](../requirements/desktop-shell.md) |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| owned hunk stage方式 | user indexを変更しないtemporary index相当を第一候補にする | patch方式とのcontract testで決める | いいえ |
| signed commit failureの説明 |既存Git設定に従い、署名失敗をcheckpoint Blockedにする |署名必須repo fixtureでcopyを確認する | いいえ |
| split diff | MVP初期はunified diffを正本とし、比較結果の理解度で追加判断 | 50-file usability testで確認する | いいえ |
| reviewer 1MiB超 | reviewerを起動せずmain evidenceでreview可能にする | chunk要約はpost-MVPで評価する | いいえ |

## レビュー確認

| 項目 | 内容 |
|---|---|
| レビュー結果 | Approved |
| レビュー日 | 2026-07-18 |

- [x] front matter、title、filenameの`S-003`が一致する。
- [x] `status: Approved`である。
- [x] Commit tabをmanual commitではなくcheckpoint/review evidenceとして定義した。
- [x] Scope、Ownership、Verification、Risk gateとreview pack全項目を定義した。
- [x] normal、empty、loading、processing、offline、error、permission、cancel、restartを定義した。
- [x] compare、revert commit、recovery branch、large diff、stale/dirty/conflictを定義した。
- [x] 関連要件IDを要件定義書のS-003対応と一致させた。
- [x] 着手ブロックが「はい」または「不明」の未確定事項は0件である。
