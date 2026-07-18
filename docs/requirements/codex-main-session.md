---
title: "CODE Codexメインセッション要件定義"
description: "固定GPT-5.6 SolによるApp Server会話、構造化イベント、判断・承認、停止・復旧を定義する。"
updated: 2026-07-18
read_when:
  - "Codex App Server supervisor、protocol adapter、Chat composerを実装するとき。"
  - "判断カード、approval、attachment、stop、reconnectを検証するとき。"
---

# Codexメインセッション 要件定義

| 項目 | 内容 |
|---|---|
| Prefix | `CODE` |
| 状態 | Approved |
| 仕様責任者 | プロダクトオーナー |
| 作成日 | 2026-07-18 |
| 最終レビュー日 | 2026-07-18 |

## 背景

生のterminal出力や単なるchatでは、長時間のCodex作業で計画、実行、失敗、判断、完了根拠を追跡しにくい。利用者の既存Codex認証を保ったまま、固定Solと構造化イベントで安全に往復するmain sessionが必要である。

## 目的

| 目的 | 達成したと判断できる状態 |
|---|---|
| 実Codex turnを完走する | S-002からpromptを送り、`gpt-5.6-sol`のstreaming result、tool event、errorを表示できる |
| 判断を理解可能にする | request/approvalを理由、選択肢、影響、危険、可逆性、根拠付きで回答できる |
| 中断・復旧を安全にする | stop、process crash、offline後もdraftとtimelineを保ち、turnを自動再送しない |

## スコープ

### 含める

| 対象 | 内容 |
|---|---|
| App Server | user-installed Codexのstdio lifecycle、initialize、capability detection |
| Main model | `gpt-5.6-sol`固定、supported reasoning effort |
| Composer | multiline prompt、file/image、read-only context、Command+Enter、stop |
| Timeline | plan、assistant、tool、file、error、decision、completion event |
| Commit interception | normalized Git commit command terminal、read-only SHA verification、app-owned explanation handoff |
| Human input | structured decision、approval、Other、hold、interrupt、fallback |
| Recovery | auth/model/process failure、reconnect、no automatic replay |

### 含めない

| 非対象 | 理由 | 扱う機能・文書 |
|---|---|---|
| model picker | 主人格と動作契約をSolへ固定する | 非対象 |
| raw terminal | 任意shell UIを提供しない | read-only tool event |
| auth token取込 | Codexの既存loginへ委任する | preflight/diagnostics |
| raw chain-of-thought | privacyと信頼性のため表示・保存しない | summary、plan、evidenceを表示 |
| 自動push/merge | main sessionの権限外 | [Git review harness](git-review-harness.md) |

## アクターと権限

| アクター | 説明 | 許可する操作 | 拒否時の動作 |
|---|---|---|---|
| ローカル利用者 | turnを開始・判断・停止する本人 | prompt、attachment、context、effort、decision、approval、interrupt | validation error時はdraftを保持し、送信しない |
| Codex main session | active workspaceで実装する唯一のcoding identity | App Server契約内のturnと通常subagent | unavailable capabilityは呼ばずfallbackまたはblocked表示にする |
| Rust supervisor | child processとprotocolの信頼境界 | executable検証、stdio、event normalization、interrupt、shutdown | malformed frame、crash、timeoutを構造化errorへ変換する |
| App-side commit interceptor | normalized command terminalとread-only Git observationを相関する | success commit commandの新しいSHAを検証し、app-owned explanation controllerへ通知する | SHA未検証、duplicate、stale generationを起動条件にせず、main conversationへ通知を注入しない |

## 機能要件

### 接続・model・turn

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `CODE-F-051` | アプリはCodex App Serverの利用可否を診断する | executable、initialize、protocol capability、login、model/listを順に確認し、失敗段階と回復操作を区別して表示する | Approved | 非該当 |
| `CODE-F-052` | main sessionは`gpt-5.6-sol`だけを使用する | thread/start payloadとheader表示が`gpt-5.6-sol`になり、UIまたは保存設定から別modelへ変更できない | Approved | 非該当 |
| `CODE-F-053` | 利用者は利用可能なreasoning effortを選べる | `gpt-5.6-sol`のmodel/listで`low`と`max`がsupportedReasoningEffortsにある時だけFast=`low`、Max=`max`として表示・送信し、model、service tier、`ultra`をこの操作で変更しない | Approved | 非該当 |
| `CODE-F-054` | appはactive workspaceのcwdでmain threadを開始する | canonical project rootとselected effortを使ってthreadを1件開始し、別workspace pathを使用しない | Approved | 非該当 |
| `CODE-F-055` | 利用者は有効なcomposer内容をturnとして送信できる | text、attachment、contextのいずれか1件以上が有効な時、Command+EnterまたはSendで1turnだけ開始する | Approved | 非該当 |
| `CODE-F-056` | 空composerは送信できない | trim後textが空かつattachmentとcontextが0件ならSendをdisabledにし、Command+Enterでturnを開始しない。attachmentまたはcontextがvalidならtext 0文字でも送信できる | Approved | 非該当 |
| `CODE-F-057` | 送信成功時だけcomposerをclearする | App Serverがturn startedを受理した後にtextをclearし、validation/transport failureではtextとattachmentを保持する | Approved | 非該当 |

### Event timeline

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `CODE-F-058` | 利用者はstreaming進捗を構造化eventで確認できる | plan、assistant text、tool start/result、file change、diff、error、decision、approval、completionをversion付きpayloadとしてsequence順に表示・保存し、再起動後も同じsemantic card、stable ID、順序へexactに再構築する。unknown versionまたはinvalid payloadはgeneric成功表示へ落とさずUnsupportedとしてfail closedにする | Approved | 非該当 |
| `CODE-F-059` | tool実行はread-only eventとして表示される | command summaryをBash/tool rowとcode chipで表示し、利用者がそのrowからshell入力または任意command実行を開始できない | Approved | 非該当 |
| `CODE-F-060` | 利用者は長いtool eventを展開・copyできる | 120文字超を一行ellipsisにし、keyboardで全文展開とcopyへ到達し、copy内容が表示全文と一致する | Approved | 非該当 |
| `CODE-F-061` | scroll中の利用者を自動で最下部へ戻さない | 利用者がbottomから48px超上へ移動中にeventが届いてもscroll位置を維持し、「最新へ」を表示する | Approved | 非該当 |
| `CODE-F-062` | errorは成功と区別して回復操作を示す | error rowにcode、短い原因、影響、retry/modify/stop/detailsの利用可能操作を表示し、completionへ自動変換しない | Approved | 非該当 |

### 判断・承認

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `CODE-F-063` | 利用者は構造化decisionへ回答できる | native user inputとfallback decisionの双方がexact versioned `DecisionContext`としてquestion、why now、options、effect/scope、risk、reversibility、recommendation/evidence、uncertaintyを一つのkeyboard-operable cardに表示・保存する。unknown/invalid contextは回答可能にせず安全に停止する | Approved | 非該当 |
| `CODE-F-064` | 利用者は既定選択肢以外を入力できる | Otherを選ぶと1〜2,000文字の入力欄が開き、送信またはcancelまでcardと入力を保持する | Approved | 非該当 |
| `CODE-F-065` | 利用者はdecisionを保留またはturnを中断できる | Holdは回答を送らずwaiting状態を維持し、Interruptは確認後にturn interruptを要求する | Approved | 非該当 |
| `CODE-F-066` | 利用者はapproval対象を確認して許可・拒否できる | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`だけをoperation、scope、対象path/host、risk、可逆性、推奨付きcardへ正規化し、Approve once、Reject、Stopを元request IDへ1回だけ返す。未知methodは許可せずBlockedにする | Approved | 非該当 |
| `CODE-F-067` | experimental user-input APIがない時も質問を失わない | initializeでexperimental APIを明示交渉し、`item/tool/requestUserInput`がない場合は通常assistant出力のversion付きdecision schemaだけを同じcardへ正規化し、schema不正や自由文だけの曖昧なapprovalは回答UIにせず安全に停止する | Approved | 非該当 |
| `CODE-F-068` | UIはキャラクターの感情で回答を誘導しない | option順、推奨根拠、riskを文字で示し、Live2D表情・音声を選択肢の有利不利に対応させない | Approved | 非該当 |

### Attachment・context・停止・復旧

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `CODE-F-069` | 利用者はfile/imageを添付できる | picker、drag/drop、pasteからworkspace root内の合計10件まで追加し、各25MiB以下、合計50MiB以下を送信前に表示する。Rustはstable root descriptorから検証済みbytesをowner-only app-private snapshotへ複製し、同じopen descriptorでfsync/hashを再検証したimmutable copyだけをimage=`localImage`、その他=`mention`としてApp Serverへ渡す。source/snapshot absolute pathはWebView、event、logへ返さない | Approved | 非該当 |
| `CODE-F-070` | アプリは許可外attachmentを拒否する | directory、symlink、実行可能file、25MiB超、読取権限なしを送信せず、他の有効attachmentを維持する | Approved | 非該当 |
| `CODE-F-071` | 利用者はread-only contextをturnへ付与できる | Files & folders、Git diff、Terminal output snapshotを選択し、capture時刻、source、byte数を送信前に確認できる | Approved | 非該当 |
| `CODE-F-072` | context menuはcomposerでclipされない | Dropdown/Popoverがportalで表示され、1470×836と960×640で全項目がviewport内またはscrollで操作できる | Approved | 非該当 |
| `CODE-F-073` | 利用者は実行中turnを停止できる | Stop後1秒以内にinterrupt requestを送信し、ackまたは5秒timeoutでStopped/Errorを表示して新規turnを二重開始しない | Approved | 非該当 |
| `CODE-F-074` | process crash後にturnを自動再送しない | child終了時にturnをInterruptedとし、draftと受信済みeventを維持してReconnect/New turnを表示する | Approved | 非該当 |
| `CODE-F-075` | loginまたはSol利用不可を区別する | unauthenticated、model unavailable、protocol unsupportedを別error codeで表示し、auth fileやtoken内容を読まない | Approved | 非該当 |
| `CODE-F-076` | workspace切替時に旧turnを混在させない | turn開始と全mutationをactivation token、workspace、thread、generationへ束縛する。切替後に遅延到着した旧workspace event/errorを旧timelineへだけ保存し、新workspace timeline、connection、Live2D stateへ表示しない。stale `turn/start`がacceptedならexact旧turnをinterruptし、そのterminalだけを旧workspaceへ保存する | Approved | 非該当 |

### Commit command interception

| 要件ID | 要件 | 受け入れ条件 | 状態 | 廃止理由・後継ID |
|---|---|---|---|---|
| `CODE-F-077` | appはmain sessionのGit commit command成功をtyped eventとして検出する | App Serverのnormalized command terminalがGit commit、exit success、active workspace generation一致の時だけcandidateを1件作り、assistant text、一般tool success、失敗command、raw文字列の部分一致では作らない | Approved | 非該当 |
| `CODE-F-078` | candidate commitはread-only observerでSHAを検証する | command前後のHEADと到達可能commitを相関し、新しいvalid SHAと`commitEvidenceId`を確定できた時だけ`auto_verified_commit`をapp-owned explanation controllerへ渡す。0件、複数件、detached/race、HIST失敗をtyped resultにし、Gitを変更しない | Approved | 非該当 |
| `CODE-F-079` | commit説明runtimeをmain conversationから完全に分離する | `auto_verified_commit`受理後のsupport root作成、status、delta、terminal、retryがmain thread/turn/subagent/event/command countを変えず、main sessionへ説明request/result/failureを1件も送らない。同じworkspace generation・commit evidence IDはidempotentに1件へ集約する | Approved | 非該当 |

## 入力項目要件

| グループ | 項目 | 初期値 | 必須 | 制約・境界 | エラー時 |
|---|---|---|---|---|---|
| Composer | prompt | workspace draft | 条件付き | 正規化済み改行・tabを含む0〜32,000 Unicode scalar、NUL/その他control不可。attachment/contextがなければtrim後1文字以上 | draft保持、共通scalar countで超過数表示 |
| Composer | attachment | なし | 任意 | 10件、各25MiB、合計50MiB、regular readable file | 無効itemだけ拒否し他を保持 |
| Composer | context | なし | 任意 | 10件、各1MiB text snapshot、sourceとtimestamp必須 | 無効snapshotを送信しない |
| Composer | effort | Fast（`low`） | 必須 | `gpt-5.6-sol`でsupportedなFast=`low` / Max=`max`だけ | 対応値がなければSendを無効にし診断理由を表示 |
| Decision | selected option | なし | 必須 | schema内optionまたはOther | card保持、回答未送信 |
| Decision | Other text | 空 | 条件付き | trim後1〜2,000 Unicode scalar、NUL/その他control不可 | 入力保持、共通scalar countで送信無効 |

## デスクトップ固有要件

| 領域 | 要件 | 対象要件ID |
|---|---|---|
| 対象OS・OS差分 | macOS 14以降、Command+Enter送信、Enter改行 | `CODE-F-055` |
| ウィンドウ生成・再利用 | active workspaceのS-002を単一windowで再利用 | `CODE-F-054`, `CODE-F-076` |
| 閉じる・アプリ終了 | childへinterrupt/shutdown後、5秒で強制終了境界 | `CODE-F-073`, `CODE-F-074` |
| 未保存データ | turn acceptedまでdraft/attachmentsを保持 | `CODE-F-057` |
| ローカルデータ | normalized eventとverified commit correlationだけをHISTへ渡す | `CODE-F-058`, `CODE-F-074`, `CODE-F-077`〜`CODE-F-079` |
| オフライン | timeline閲覧可、Send無効、Reconnect表示 | `CODE-F-074`, `CODE-F-075` |
| ファイル・OS操作 | picker/drop/pasteを同一validatorへ通す | `CODE-F-069`, `CODE-F-070` |
| メニュー・ショートカット | Command+Enter、Escapeでnon-destructive overlay close | `CODE-F-055`, `CODE-F-072` |
| Deep Link・ファイル関連付け | 非該当: MVPで登録しない | 非該当 |
| 通知 | blocking decisionはtoastにせずcardを維持 | `CODE-F-063`〜`CODE-F-067` |
| Capability・認可 | Codex process起動とstdioをRust supervisorだけに許可 | `CODE-F-051`, `CODE-F-054` |
| アップデート・互換性 | exact CLI version pinではなくcapability detectionで判定 | `CODE-F-051`, `CODE-F-067` |

## 画面・UI

| 画面ID | 画面名 | 対象要件ID | 扱い | 画面詳細仕様 |
|---|---|---|---|---|
| `S-001` | セッションダッシュボード | `CODE-F-051`, `CODE-F-075` | 変更 | [画面詳細仕様](../screen-design/S-001_session-dashboard.md) |
| `S-002` | コーディングワークスペース | `CODE-F-052`〜`CODE-F-079` | 変更 | [画面詳細仕様](../screen-design/S-002_coding-workspace.md) |
| `S-004` | 設定・診断 | `CODE-F-051`〜`CODE-F-053`, `CODE-F-075` | 変更 | [画面詳細仕様](../screen-design/S-004_settings-diagnostics.md) |

## 非機能要件

| 領域 | 要件 |
|---|---|
| セキュリティ | Codex authへ委任し、auth file/tokenを読まない。attachment/contextはsize/type/path検証する |
| 権限 | child processとstdioはRustだけが保持し、WebViewへprocess handleを渡さない |
| プライバシー | raw reasoningを要求・表示・保存しない。prompt送信先をApp Serverに限定する |
| 監査・ログ | turn ID、model、effort、decision/approval result、error code、verified commit correlationをredacted eventとして記録する。commit説明本文は記録しない |
| 性能 | event受信からtimeline表示p95 200ms、100 event burstで入力を500ms超blockしない |
| 信頼性・復旧 | malformed JSONL 1frameでappを落とさず、sessionをErrorにしてraw frameをsecret-filter後診断へ隔離する |
| アクセシビリティ | timelineはsemantic list、stream summaryはpolite live region、decisionはfocus trapを使わず論理順で操作する |
| 多言語・地域 | app-owned copyはja/en、tool/path/model/user contentは翻訳しない |

## 依存関係・前提

| 依存・前提 | 内容 | 状態 | 未解決時の影響 |
|---|---|---|---|
| User-installed Codex | stdio App Serverと既存login | 解決済み（採用決定） | 診断失敗時はChat送信不可 |
| GPT-5.6 Sol | main model固定 | 解決済み（product契約） | model/listにない場合はblocked表示 |
| WORK | active cwdとsingle execution | 解決済み（相互参照確認済み） | preflight失敗時はSend不可 |
| HIST | normalized event persistence | 解決済み（相互参照確認済み） | crash recovery品質を独立レビュー |
| GIT/SUP | read-only SHA verificationとapp-owned explanation controller | 解決済み（typed handoff） | SHA未検証時は説明を起動せず、main conversationは継続 |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| experimental requestUserInput | capability時はnative、非対応時はschema付きfallback | contract testで双方を検証する | いいえ |
| 最低Codex version | exact versionを固定せずcapabilityで判定 | release artifactで検証済みversionをREADMEへ記載 | いいえ |

## 参照資料

| 資料 | 参照理由 |
|---|---|
| [PRODUCT.md](../../PRODUCT.md) | 固定Sol、判断、制御の目的 |
| [DESIGN.md](../../DESIGN.md) | Chat、composer、decision interaction |
| [Codex統合調査](../research/03-codex-integration.md) | App Server、model、event、fallback |
| [判断・信頼・アクセシビリティ](../research/06-decision-trust-accessibility.md) | decision cardとnon-coercion |

## レビュー・合意

| 項目 | 内容 |
|---|---|
| レビュー結果 | Ready |
| 仕様責任者 | プロダクトオーナー |
| 合意日 | 2026-07-18 |
| 残る非ブロック論点 | requestUserInput capabilityと検証済みCLI versionはadapter testで確定する |

## 着手可チェック

- [x] 背景と目的が説明できる。
- [x] スコープ内・外と理由が明確である。
- [x] 全機能要件に一意な要件IDがある。
- [x] 全機能要件に検証可能な受け入れ条件がある。
- [x] 正常系、異常系、キャンセル、権限差分、空状態、境界値を確認した。
- [x] Git commit command検出、SHA検証、app-owned explanation handoffがmain conversationへ混入しないことを定義した。
- [x] デスクトップ固有要件を確認し、非該当も明記した。
- [x] 画面IDと要件IDの相互参照が一致し、承認済み画面詳細仕様を参照している。
- [x] 非機能要件と依存関係を確認した。
- [x] 着手ブロックが「はい」または「不明」の未確定事項がない。
- [x] 仕様責任者がレビューし、合意した。
