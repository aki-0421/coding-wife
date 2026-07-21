---
title: "S-002 コーディングワークスペース"
description: "Codex main session、構造化tool event、意思決定、read-only Context、Live2D characterを一つの安全な作業面で扱う画面仕様。"
updated: 2026-07-21
read_when:
  - "Chat tab、composer、Codex event timeline、decision、Live2D characterを実装するとき。"
  - "S-002とWORK、CODE、SUP、GIT、HIST、LIVE、NARR、APP要件の対応を確認するとき。"
screen_id: "S-002"
status: "Approved"
---

# S-002 コーディングワークスペース

| 項目 | 内容 |
|---|---|
| window label | `main` |
| React route / view key | `/workspace/:workspaceId/chat` / `coding-workspace` |
| subview | 非該当 |
| 対象OS | macOS 14以降、Apple Silicon |
| デザイン | [DESIGN.md](../../DESIGN.md)、Figma Desktop node `8:2`、[demo.png](../thinking/demo.png) |
| 共通仕様 | [デスクトップ共通仕様](desktop-common-specification.md) |
| 廃止理由 | 非該当 |
| 後継画面ID | 非該当 |

## 目的

利用者が一つのworkspaceと一つのCodex main sessionを理解可能な形で監督し、自然言語の指示、構造化された実行経過、必要な意思決定、検証結果を同じ時系列で扱えるようにする。Live2D characterと音声は作業状態を補助するが、判断根拠、失敗、待機、権限要求を隠したり感情的に誘導したりしない。

## 対象範囲

### 含める

| 対象 | 内容 |
|---|---|
| Main session | Codex App Serverのinitialize、thread、turn、stop、reconnect、resume |
| Timeline | user/assistant text、plan/tool、file/diff、decision/approval、errorの会話向けprojection |
| Composer | multiline指示、attachment、project context参照、reasoning effort、send、stop |
| Decision | 選択肢、自由入力、保留、中断、明示承認、理由・影響・可逆性 |
| Character | default/custom Live2D、状態表現、mute、visible caption、static/text fallback |
| Continuity | draft、timeline位置、turn、event sequence、selected contextの復元 |

### 含めない

| 非対象 | 理由 | 扱う画面・文書 |
|---|---|---|
| raw terminal / arbitrary shell | trust boundaryと理解可能性を守る | typed tool eventだけ表示 |
| Git mutation control | native observerをread-onlyに保ち、commit producerをmain Codexへ一本化する | [S-003](S-003_session-evidence.md)はevidence閲覧だけ |
| support agentへの直接chat | coding identityと支援runtimeを分離する | commit説明はapp-owned controllerが管理し、main conversationへrequest/resultを注入しない |
| model picker | MVPの固定契約は`GPT-5.6 Sol` | availabilityはpreflightで診断 |
| microphone / speech input | MVPは音声出力だけ | [S-005](S-005_app-settings-diagnostics.md) |
| character context / asset import | character libraryとpackごとのpresentation設定のため | [S-005](S-005_app-settings-diagnostics.md) |

## 表示契機と終了

| 項目 | 内容 |
|---|---|
| 表示契機 | [S-001](S-001_session-dashboard.md)でworkspace選択、Chat tab、notification内のworkspace link、再起動復旧 |
| 表示前提 | valid workspace ID。missing repoまたはCodex blocked時もread-only timelineは表示する |
| 初期フォーカス | normal/emptyはcomposer、decision時はdecision heading、error/recovery時は最初の回復操作 |
| 正常完了 | validated terminal work-unit eventを1回だけread-only Git observerへ渡し、before/after HEAD、new commit、verification/decision/risk相関をHISTへ追記する。success commit commandと新しいSHAを検証できた時はapp-owned explanation controllerへ`auto_verified_commit`を渡し、main conversationを変更しない |
| キャンセル |未送信draftとtimeline位置を維持する。running turnのStopは別操作として確認する |
| 閉じる操作 | [共通close契約](desktop-common-specification.md#windowとtitlebar)に従う |
| 再表示 | Project ID、workspace、tab、draft、timeline anchor ID/sequence/offset、repository health、unanswered decisionをworkspace storeから、app-global character選択をcharacter library storeから復元する。互換性のため保存済みlast summaryを読込結果に含めても、Chatでは消費・表示しない |

## 利用者と権限

| 利用者・ロール | 表示 | 操作 | 拒否時の動作 |
|---|---|---|---|
| ローカル利用者 | redacted event、repo/branch、context、decision、verification | send、stop、answer、inspect、copy、mute | permission、ownership、stale stateを理由付きで表示 |
| React WebView | normalized event、typed action、asset handle | render、input、focus、route、typed IPC | raw shell、Git args、absolute private path、secretを保持しない |
| Rust supervisor | workspace scope、Codex process、event sequence、DB | spawn、validate、normalize、redact、persist、cancel | invalid/stale/duplicateを構造化errorにする |
| Codex main agent | project context、approved tool scope、decision answer | plan、delegate、implement、verify、summarize | allowlist外operationを実行せずdecisionへ戻す |
| App-owned explanation controller / Support agent | verified commit、bounded redacted task context | mainと別のisolated taskを実行しcontroller stateとcaptionへ結果を返す | main thread/turn/subagent/event/commandを作らず、UIへGit commandを出さない |
| TTS provider | redacted eligible transcriptだけ | enable時にspeech生成 | secret/source/path/event payloadを受け取らない |

## 画面構成

### 標準1470×836の再現

| 領域 | 実装拘束値 | 表示内容 | 主な操作 |
|---|---:|---|---|
| workspace sidebar | 255.04×836px | [S-001](S-001_session-dashboard.md)と同じlifecycle一覧、main turn送信開始・実行・停止処理中だけ対象rowのrepository avatarと置き換わるspinner、App settings gear | filter、workspace選択、App settings |
| breadcrumb row | main上段40.5px | owner avatar、`owner/repo` / workspace、branch、connection、attention | repository / workspace / branchの値をcopy |
| tab row | main下段40.5px | Chat / Commit / Settings | view切替 |
| Chat pane | 607.11×754.99px | event timeline、decision、composer | inspect、copy、send、stop、answer |
| Character pane | 607.84×754.99px | Live2D canvas、visible caption、mute | mute、fallback詳細 |
| composer | Chat内571.11×128.25px、left/right 18px、bottom 15px | input、draft item、補助操作、実行操作 | draft編集、attachment/context追加、effort選択、send/stop |

標準geometryではsidebar、81px header、primary work surface/Character境界、composerをFigma node `8:2`の±2 CSS px以内に合わせる。ChatとCommitは同じCharacter instanceを右paneへ継続表示し、tab切替でcanvasを再生成しない。Settingsでは同じrenderer instanceを非表示のまま保持する。primary work surfaceとCharacterの間へcard、rail、shadow、visible dividerを追加しない。Character背景は大きなdecorative gradientやparticleを使わず、Live2Dと状態captionの可読性を優先する。

### headerとtab

| 要素 | 規則 |
|---|---|
| repository avatar | GitHub `origin`の`owner/repo`がある時はownerの24px GitHub avatarを`https://avatars.githubusercontent.com`から`no-referrer`で表示する。CSPの外部画像許可は同originだけに限定し、画像失敗時はneutral user fallback、GitHub metadataがないlocal repositoryではneutral Git worktree fallbackを使う。app iconはrepository identityとして使わない |
| breadcrumb | avatarの次にGitHub `origin`由来の`owner/repo`、workspace名をこの順で一行表示する。GitHub metadataがない時は保存済みlocal repo名へfallbackする。repositoryとworkspace名は長い時も一行ellipsisを維持し、hover / focus-visibleで背景と文字色を変えて操作可能性を示す。pointer clickまたはkeyboard activationで省略前のexact valueをclipboardへcopyし、tooltipとnative `title`は表示しない。copy icon、成功check icon、その予約領域は表示せず、hoverとcopy成功でtext buttonのinline幅を変えない |
| branch | Git観測値をbranch iconとmono textで表示する。長い時は一行ellipsisを維持し、repository / workspace名と同じhover、focus-visible、clipboard copy、幅不変の契約を使う。stale時の状態説明はrepository healthへ分離し、branch値のtooltipやcopy結果iconは表示しない |
| repository health | `healthy` / `missing` / `changed` / `unreadable` / `read_only` / `stale_branch`をja/en text、icon、shapeで表示し、色だけにしない。`healthy`以外はSend不可理由とRepair/Recheckを関連付ける |
| connection | Ready / Working / Needs answer / Interruptedをtextとshapeで表示する。offline時はpersistent bannerとSend不可理由を正本とし、breadcrumb rowへ`Offline / オフライン`のicon、text、空のplaceholderを表示しない |
| workspace action | breadcrumb rowへ3点actionを表示しない。Cancel / Repair / Recheck / Archiveをこのrowへ置かず、workspace Archiveはsidebar rowからだけ開始する |
| Chat | 本画面のmain route。unread error/decision countをbadge表示する |
| Commit | [S-003](S-003_session-evidence.md)へ遷移する。manual commit buttonではない |

### Chat timeline

eventはworkspace内のvalidated `sequence`順に表示する。live/HISTは共通のversioned projectorでstable IDとsemantic cardを復元する。pending actionはsupervisorが同じworkspace/thread/generationを所有する時だけ操作可能にする。unknown/invalid payloadは生値やgeneric成功行へ落とさずChatでは描画せずに診断へ隔離する。

Chatは保存済みeventの監査一覧ではなく、現在の会話を理解して次の操作を決めるためのprojectionとする。tab名が領域名を担うため、本文上端に`Activity / アクティビティ`見出しと説明を置かない。Chatへ表示するのは`user`、`assistant`、`plan`、`tool`、`file`、`diff`、`decision`、`approval`、`error`だけとし、raw `history`、generic `status`、`thread` / `turn` lifecycle、`completion`、`request_resolved`は永続化しても描画しない。成功した同一tool itemの開始・終了更新はstable IDで一行へ統合し、異なるtool itemはcompact rowのまま保持する。検証結果は対応するtool/error、Git evidenceはCommit tab、support状態は専用controller surfaceを正本にする。turnの正常終了では検証・redact済み`result.message`のAssistant本文を会話の最後に表示し、`completion`を最終出力の代替にしない。

| event kind | compact表示 | 展開表示 | 主要action |
|---|---|---|---|
| User instruction | avatarなしのtext block、送信時刻 | attachment名、参照context version | copy |
| Assistant commentary | plain text、phase label | related work unit / support result | copy |
| Tool activity | icon、利用者が識別できる提供元と実tool名、目的またはtarget、running/result、duration | sanitized args summary、result/error category、detail ref | expand、copy summary |
| File change | create/update/delete、relative path、line count | redacted patch summary、ownership | Commit tabで確認 |
| Verification | tool rowのtest/lint/build名、pass/fail、duration | command allowlist名、failure excerpt、artifact ref | evidenceを開く |
| Decision / Approval | question、reason、impact、reversibility | options、Other、hold/interrupt/approve条件 | answer |
| Error / Interrupted | code、影響、保持data、回復操作 | safe detail、retry condition、diagnostic ref | retry、modify、stop、diagnostic |

MCP toolはApp Server itemの`server`と`tool`をredact・長さ制限したsemantic fieldへ分離し、compact rowを`提供元 · 実tool名 · 安全な対象要約 · 状態 · 所要時間 · 時刻`の順に構成する。内部item typeの`mcpToolCall`をtool名として表示しない。引数はtop-level scalarを最大4件まで一行要約し、`title`、`query`、`ref_id`等の人向けtargetを優先する。credential相当keyは値を常に`[redacted]`へ置換し、`code`、`script`、`expression`等のsource bodyは本文でなく文字数だけを示す。array/objectは内容を展開せず件数だけを示し、raw JSON、MCP result content、secret、absolute private pathをWebViewまたは履歴へ渡さない。commandとweb searchも同じsemantic tool statusへ正規化し、commandはredact済み一行command、web searchはredact済みqueryをtarget summaryにする。旧`code.item.status.changed` tool履歴は互換表示できるが、新規tool statusはprovider/tool/summary/durationを持つ`code.tool.status.changed`を正本にする。

App Serverの`agentMessage.phase=commentary`はturn途中のassistant messageとして会話へ表示し、後続toolまたは最終回答を待つ。commentary itemの完了を最終Structured Output違反として`CODEX-TURN-INTERRUPTED`へ変換してはならない。`phase=final_answer`またはphaseなしの完了itemだけを最終回答として扱い、厳格検証済み`result.message`を会話の最後へ表示する。

連続する同種tool eventは同一work unit内だけgroup化し、running数とterminal数を見出しへ出す。groupを閉じてもerror、decision、verification failureを隠さない。toolのstdout/stderr全文、hidden reasoning、secret、home directory、unredacted promptは表示・保存しない。

timeline rendererは表示対象を`message`、`operation`、`intervention`の三つへ分類する。User / Assistantは会話本文を主役にし、tool / file / diff / plan / errorは一行summaryと展開可能なsanitized detail、decision / approvalは単独の介入surfaceとして描画する。completed operationは初期状態で閉じ、running、failed、interruptedは開く。展開前もkind、targetまたは結果、terminal state、error code、時刻を確認できなければならない。

表示対象eventが0件で回復alertもない場合、timeline領域にはplaceholder、見出し、説明、icon、枠、CTAを一切描画しない。last summaryのcard、見出し、説明、本文も描画しない。composerは通常位置に残し、初期focusもcomposerとする。

commit explainerのrequest、status、delta、result、failureはChat timelineとmain conversationへ追加しない。これらはapp-owned explanation controller、S-003の状態表示、Character captionだけで扱う。

timeline最下部から48px以内なら新eventで追従する。48pxを超えて離れた場合は位置を固定し、`新しい更新 N件 / 最新へ`をcomposer上へ表示する。復元時はevent anchor IDとoffsetを使い、消失時だけ最寄りsequenceへ補正する。

Chatには正常時のdurability badgeを表示しない。native SQLiteの`read_only` / `recovery_required`だけを回復alertとして表示し、browser demoはheaderの`Preview only / プレビューのみ`、詳細な履歴状態はDiagnosticsを正本とする。Chat上端にはCodex、Git、履歴の接続状態をまとめた汎用noticeを表示しない。nativeでCodex activationまたはruntimeが利用不能な場合はChatを描画せず、[S-001](S-001_session-dashboard.md)の全viewport overview setupへ戻す。`ephemeral`は利用可能なpreview timelineであり、nativeのread-only/recovery alertとして扱わない。

### Composer

| control | 表示・動作 | 無効条件 |
|---|---|---|
| instruction | 1〜8行auto-grow。Enterは改行、`Command+Enter`で送信 | text、attachment、read-only contextがすべて空またはinvalid、offline、blocked preflight、decision未回答、別workspace実行競合 |
| Add | icon-onlyの`+`からattachment、`Files & folders`、`Git diff`、`Terminal output`を一つのmenuで選ぶ。menuはportalで描画し、項目をattachmentとContextのgroupへ分ける | turn開始中。attachmentはpermission不足、Contextはsnapshot取得または検証不可 |
| model | `GPT-5.6 Sol`固定label。picker chevronを出さない | 常時read-only |
| reasoning | bar iconと現在levelの短いlabelを一つのbuttonにする。clickごとに`Off`から`model/list`が広告したlevelを低い順に一段上げ、最高levelの次は`Off`へ戻る。`Off`は`turn/start.effort=null`でsession既定へ戻す | turn実行中。広告済みlevelがない時は`Off`だけを表示 |
| Fast | 稲妻だけのflag button。選択時は`model/list.serviceTiers`が広告したFast tier IDを`turn/start.serviceTier`へ渡し、解除時は`null`で明示解除する | turn実行中、Fast tier未広告 |
| Plan | map iconのflag button。選択中は`turn/start.collaborationMode`へ固定modelと選択reasoningを含む`plan` presetを渡し、解除時は`null`で明示解除する | turn実行中、experimental API未受理 |
| Goals | target iconの一回性flag button。選択して送信すると、trim済みinstructionを`thread/goal/set.objective`へ設定してから同じinstructionのturnを開始し、turn受理後にflagだけ解除する | turn実行中、experimental API未受理、instructionが空、または4,000 scalar超 |
| Send | primary icon button、accessible label `Send / 送信` | instruction条件不成立 |
| Stop | running時にSend位置へ表示。明示clickだけ | turn非実行時 |

composerは一つの入力surfaceとして、上から`draft item`、instruction、footerの順に積む。footerは左の`+`、中央の固定model・Reasoning・Fast・Goals・Plan flags、右のkeyboard hintとSend/Stopへ視線が流れる三群構成にする。Fast、Goals、Planはicon-onlyにして選択状態をfill、`aria-pressed`、tooltipで伝え、Send/Stopはfooter末尾の円形icon buttonにする。固定modelとReasoningは実行条件のため残すが、primary actionと競合するborderやfillを持たせない。

通常時はpaste/drop/@の長い説明文をsurface内へ常設せず、Addのtooltipとinstructionのaccessible descriptionへまとめる。native pickerが利用不能な時だけ、理由とdraft保持をinstruction直下へvisible statusとして表示する。`Command+Enter` hintはSendの直前へ置き、狭幅ではvisual textを省略してもaccessible descriptionとshortcut動作を維持する。draft itemはinstructionより上で横scrollし、basenameまたはsnapshot label、種別icon、削除操作を24pxの同一行へ収める。invalid attachmentは色だけでなく`!`と送信不可説明を残す。

Add menuはpaneの`overflow`にclipされないbody-level portalとし、`+` triggerへanchorする。viewport外では上下反転し、Escape、outside click、route変更で閉じる。attachmentはfile内容をcomposerへ貼らず、basename、relative path、size、validation statusだけをchip表示する。Context snapshotはsource、capture時刻、byte数を表示し、App settings > Projects > project detailのProject Context編集やApp settings > Character > character detailのCharacter Context編集とは別の送信時参照として扱う。

送信時はworkspace、draft hash、context version、Git fingerprint、effort、attachmentをRustで再検証する。public instructionは32,000 Unicode scalar以下を維持し、開始時に固定したProject/Character context、version/hash metadata、JSON escaping、固定markerとの合成text全体を80,000 Unicode scalar以下にする。WebViewとRustはUTF-8 byte数ではなくUnicode scalar数で同じexact boundaryを検査し、80,001 scalar、NUL、その他controlをApp Server送信前に拒否してdraftとcontext versionを保持する。sourceはstable root dirfdからno-followで開き、descriptorから0700/0600のapp-private snapshotへcopy、fsync、hash再検証する。App Serverへはsnapshotだけを渡し、accepted/failed/terminal/expiryで削除する。二重操作は同じidempotency keyへ集約する。

### 構造化decision

| 項目 | 契約 |
|---|---|
| 必須説明 | `何を決めるか`、`なぜ今必要か`、`各選択の影響`、`可逆性`、`推奨と不確実性` |
| option | 2〜5件。labelと一文の結果を持ち、推奨を根拠なしに色で優位化しない |
| Other | optional。選択時だけ1〜2,000文字の入力を必須にする |
| Hold |作業を待機し、Git/sourceを変更しない。decisionを未回答のまま残す |
| Interrupt | current turnとsupport taskを停止し、観測済みcommitと未完了workを分ける |
| Approve | 既知のApp Server approval request ID、具体的operation、scope、期限を示した場合だけ表示。包括承認や未知methodの許可を作らない |
| Answer | 1回だけ送信し、answer eventと選択時fingerprintを履歴化する |

native/fallbackのdecisionは共通のexact versioned `DecisionContext`を使う。`effect`、`scope`、`risk`、`reversibility`、`recommendation`、bounded evidence、`uncertainty`をsafe public textだけで構成し、unknown field/version、NUL/control、secret、private pathを含むcontextはcardをactionableにせずturnを安全に停止する。再起動後も同じcontextを復元する。

decisionはtimeline内の強いoutline surfaceとして表示し、必要時だけ同じDOM内容をportal overlayでも提示する。Live2Dの表情、音声、色、animationで回答を急かさない。背景のSendは無効にするが、timeline、Commit、Settingsのread-only閲覧は許可する。

### Character

| layer | 内容 | fallback |
|---|---|---|
| Canvas | 選択中Live2D modelを最大1 canvasでrender | static preview、それも失敗ならtext-only |
| State | versioned semantic state `neutral` / `thinking` / `working` / `asking` / `success` / `warning` / `error` | 同じja/en HTML visible state textを常時同期 |
| Uncertainty |確信度を断定表情へ変換せず、`確認中`、`判断が必要`等のtextを出す | text-onlyで同一情報 |
| Audio | eligible commentaryとcommit explanation確定chunkの再生status、mute | TTS off/失敗時も同じcaption textを欠落させない |
| Control | mute、fallback detail。model変更はApp settings > Character link | keyboard操作とaccessible name |

canvasはpointer eventを奪わず、decorative扱いとする。選択packの正本はapp-globalなowner-only character library stateであり、全workspaceは選択変更を即時共有する。model animationはevent severityを誇張せず、error/decisionを祝福表現にしない。tabがbackground、window occluded、reduced motion、thermal pressure時はFPSを下げ、Chat入力とevent描画を優先する。

operational eventはversioned mapperで`idle`→`neutral`、`thinking`→`thinking`、`acting` / `reviewing` / explicit commit presentation→`working`、`waiting_for_user`→`asking`、`completed`→`success`、`disconnected`→`warning`、`error`→`error`へ決定的に変換する。unknown/unsupported eventは`neutral`へ戻す。semantic stateからは検証済みmanifest inventory内のmotion cue、expression cue、またはneutralだけを使い、Codex/support output、path、URL、parameter式、任意file名をcueとして採用しない。unknown mapping version、manifest hash不一致、invalid/deleted cueではmapping全体を実行せずneutral/static/textへ戻す。

verified commit後にapp-owned explanation controllerが`queued` / `running`へ遷移しても、Commit UIのbackground生成statusだけを更新し、caption/live region/TTSは開始しない。利用者が「詳しく教えて」または再表示を1回選んだ時だけ、そのselection/request/presentation intent epochへ束縛した`working`状態とsequence付きのredacted narration chunkをvisible HTML captionへ表示する。未生成、生成中、background生成済みcacheのどれも同じ1回で表示し、captionをTTSより先に確定して、TTS enabled時だけ同じtextを同じ順で読む。`Close explanation`、workspace/locale/selection変更、main turnのStop、stale/schema invalidはpresentation intentだけをrevokeし、旧chunkを表示・再生せず、background explanation job/cacheを維持する。queued/running jobをterminal化するのはS-003の明示`Cancel explanation generation`、timeout、またはapp process終了時の共通runtime cleanupだけである。

## responsive behavior

| effective width / mode | Chat | Character | Composer / decision |
|---:|---|---|---|
| 1470px以上 | 607.11pxを基準に1:1で拡張 | 607.84pxを基準に1:1で拡張 | Chat左右18px、composer最大720px |
| 1280〜1469px | 残幅の1/2、最低500px | 残幅の1/2から先に縮小 | composerはpane幅-36px |
| 960〜1279px | 最低520pxを優先 | compact pane、caption/mute維持。decision/review時はhide可 | portalをviewportへfit、controls wrap |
| 200% text zoom | main幅を優先、横方向縮小禁止 | hide toggle、text statusをChat側にも表示 | inputを最低3行、actionをoverflow menuにしない |

evidence failure、blocking decision、permission errorはCharacterより表示優先度が高い。Characterをhideしてもcaption相当のstatusをChat headerへ残す。

## 表示状態

| 状態 | 進入条件 | 表示 | 操作可否 | 状態から抜ける条件 |
|---|---|---|---|---|
| 初期化中 | workspace、event、Codex、characterを読込中 | shell、timeline/composer/characterのshape skeleton。demo workspace、draft、timelineを表示しない | tab read-only、Quit。workspace mutationとSendは開始しない | 全queryがterminalになる |
| 通常 | connected、turnなし、decisionなし | timeline、enabled composer、idle character | send、inspect、read-only context snapshot、Chat/Commit tab移動 | send、offline、error |
| データなし | event 0件 |一文の開始案内、composerをprimaryにする | draft、context、send | first turn作成 |
| 処理中 | turn running | live timeline、phase、Stop、`thinking` / `acting` caption | stop、inspect、read-only tab、mute | completed、failed、stopped、decision |
| 意思決定待ち | structured decision受信 | decisionをtimelineとattentionへ表示、`waiting_for_user` caption | answer、hold、interrupt、read-only閲覧 | answer accepted、interrupt terminal |
| オフライン | Codex disconnect/auth loss | persistent banner、last sequence、draft、Reconnect | local history、Commit、App SettingsのProject detail / Character detail、Stop可能ならStop |明示reconnectとsequence照合成功 |
| エラー | turn/tool/normalize/persist failure | code、operation、impact、保持data、retry/modify/stop/details |安全な回復操作、影響外閲覧 | terminal recovery event |
| 権限不足 | filesystem/process/Git/attachment拒否 |拒否operation、scope、再選択/診断。raw path非表示 | modify、Settings、Stop | valid permissionで明示retry |
| キャンセル後 | attachment picker、popover、App Settingsのcontext editをcancel |開始前のdraft、selection、event位置 |元操作または別操作 |次の明示操作 |
| Stop処理中 | 利用者がStop | stopping phase、重複Stop disabled | read-only閲覧 | stopped/failed timeout |
| 再起動復旧 | started turnにterminal eventなし | Interrupted marker、draft、last observed commit、review/new turn/diagnostic | read-only inspect、Commit、new turn前preflight |利用者が次操作を選ぶ |
| stale event | sequence gap、duplicate、workspace mismatch | affected pointでingestion pause、diagnostic | local history、Stop | supervisorがgap解消またはterminal error |
| character fallback | WebGL/model/render/audio failure | staticまたはtext-only、visible reason、Chatは継続 | Chat全操作、Settings | retryまたは別model選択 |
| repository blocked | healthが`missing` / `changed` / `unreadable` / `read_only` / `stale_branch` | header/rowのlocalized status、保持timeline/draft、Send不可理由 | Commit/Settings、Repair/Recheck | `healthy`のfresh snapshot |
| workspace切替確認 | old workspaceにactive/pending turnがあり別workspaceを選択/Send | new selectionを保留し、old workspaceをactive表示したまま`停止して切替 / Stop and Switch`、`戻る / Back`だけ | 明示2操作だけ | exact old terminal interrupt + cleanup、またはBack |
| commit説明準備中 | app controllerがverified commitを`queued` / `running`としているが明示presentation intentはない | background生成status、「詳しく教えて」、`Cancel explanation generation`。caption/live region/TTSは0件でmain timelineへmessageを追加しない | read-only tab、詳しく教えて、生成cancel | 明示intent、generated/canceled/failed/unavailable/selection変更 |
| commit説明表示中 | `user_request` / `user_retry` / 明示Showのintentとcontroller stateがexact一致する | semantic `working`、streamed HTML caption、`Close explanation`、queued/running時だけ`Cancel explanation generation`、mute。active tabは維持 | read-only tab、Close、条件付き生成Cancel、mute | generated/canceled/failed/unavailable/selection/locale/workspace変更、Stop、Close |
| demo memory | browser previewの決定的memory adapter | Chatには履歴badgeを表示せず、headerの`Preview only`とDiagnosticsでruntime/durabilityを識別する | preview内のworkspace、draft、timeline操作 | native adapterへ切替またはpreview再起動 |

## 操作

| 操作 | 事前条件 | 正常結果 | キャンセル時 | 失敗時 | 関連要件ID |
|---|---|---|---|---|---|
| turn送信 | valid draft、online、preflight ready、repository health `healthy`、active execution競合なし | focus/Send直前のidentity、HEAD、branch、read/write再検査とContext snapshot成功後、main sessionへ1 turn作成、user event永続化、composerをclear |送信前ならdraft維持 | draft/context/fingerprintを維持し、staleなら再preflightまでSend不可 | `CODE-F-052`〜`CODE-F-061`, `WORK-F-061`, `WORK-F-066` |
| turn停止 | running turn | main interruptと`turn_stop` narration dismissを同時に開始し、stopped terminal event、完了済み変更を区別する。visible caption/TTSは閉じるが、別のapp-owned commit explainer生成自体は継続しS-003のCancelで管理する | confirmを閉じれば継続 | timeout時にsupervisor強制停止とInterrupted | `CODE-F-073`, `SUP-F-059`〜`SUP-F-061` |
| timeline展開 | event/groupが存在 | sanitized detailを同じpositionで表示 |元のcompact表示 | raw payloadをfallback表示しない | `CODE-F-056`, `HIST-F-037`〜`HIST-F-044` |
| 最新へ移動 | bottomから48px超 | newest terminal/eventへscroll、unread 0 | 非該当 | anchor不明なら最終sequenceへ | `HIST-F-045`〜`HIST-F-048` |
| decision回答 | unanswered、option valid | idempotent answer event、turn resume | Holdなら未回答維持 |重複送信せず選択を保持 | `CODE-F-062`〜`CODE-F-069` |
| interrupt | decisionまたはrunning turn | main/support停止、completed/partial/unknownを分類 |確認cancelで継続 | Interruptedとしてreviewへ誘導 | `SUP-F-057`〜`SUP-F-061` |
| attachment追加 | picker起動可能 | validated handleをdraftへ追加 | draft不変、errorなし | chipを追加せずreason表示 | `CODE-F-053`, `APP-F-066`〜`APP-F-069` |
| workspace切替 | 別workspace選択、old active/pending turnなし、または確認済みinterrupt | old presentation/audio停止後、new workspaceのdraft、anchor ID/sequence/offsetをatomic復元。app-globalなcharacter選択とpack-scoped設定は維持 | `戻る`でold state完全維持 | old workspaceをactiveのままerror、new activation 0件 | `WORK-F-058`〜`WORK-F-060` |
| mute切替 | audio/character利用可能 |即時再生停止または次eligible textから再開、設定保存 | 非該当 | text表示は継続 | `NARR-F-068`〜`NARR-F-075` |
| Commit tabを開く | workspace valid | same workspaceの[S-003](S-003_session-evidence.md)を表示し、初回active表示時だけread-only observationを取得 | 非該当 | Chatを維持してerror | `GIT-F-072`〜`GIT-F-089` |

## 入力項目

| 項目 | 初期値 | 必須 | 制約・境界 | エラー表示 | 保存契機 |
|---|---|---|---|---|---|
| instruction | workspace draft | 条件付き | 0〜32,000 Unicode scalar、NUL不可。attachment/contextがなければtrim後1文字以上 | composer内、draft保持 | redaction合格後のdebounceとroute leave。secret-bearing raw値はReact transientだけに保持しDBへ保存しない |
| composed turn text | instructionと開始時context snapshotから生成 | 条件付き | 固定marker、Project最大32,000 scalar、Character最大12,000 scalar、version/hash metadata、JSON escapingを含む全体で0〜80,000 Unicode scalar。multibyte文字も1 scalarとして数える | composer上の送信error、instruction/contextを保持 | 保存しない。App Serverへの当該turn inputだけに使用 |
| attachment | なし | 任意 | 10件、各25MiB、合計50MiB、workspace root内のregular readable file。directory/symlink/executable不可 | chip単位、無効handleは除外 | draftにはhandle metadataだけ |
| read-only context | なし | 任意 | Files & folders / Git diffを各1MiB、workspaceごとにcapture順の最新10件。sourceとcapture時刻必須。Terminal outputはtrusted producer実装までunavailable | 無効snapshotを追加せず理由表示 | redacted snapshot metadataとcontent hash |
| reasoning | 前回valid値、初回`Off` | 任意 | `Off`、または`gpt-5.6-sol`の`model/list.supportedReasoningEfforts`が広告した値。未知値は選択・送信しない | capability更新で選択値が消えた時は`Off`へ戻して理由表示 | valid変更時workspace preference |
| Fast flag | off | 任意 | `model/list.serviceTiers`でFastとして広告されたexact tier IDだけ | 未広告時はoffへ戻してdisabled理由をtooltip表示 | WebView session内。turnへ明示送信 |
| Plan flag | off | 任意 | `collaborationMode.mode=plan`、固定model、現在reasoning。offでは`null` | experimental API未受理時はoffへ戻してdisabled理由をtooltip表示 | WebView session内。turnへ明示送信 |
| Goals flag | off | 任意 | 選択時はtrim済みinstruction 1〜4,000 scalarをobjectiveにする。attachment/contextだけの送信では選択不可 | instructionを保持し、goal未設定のままSend不可理由 | turn受理後だけoffへ戻す |
| decision option | 未選択 |回答時必須 | server提示IDの1件 | decision surface | answer accepted時event |
| Other text |空 | Other選択時必須 | trim後1〜2,000 Unicode scalar | field直下、入力保持 | answer accepted時event |

composerへsecret patternを検出した場合は送信前に対象範囲とredaction案を示し、`修正する`をprimaryにする。検出結果そのものへsecretを複製しない。

## ネイティブ連携

実際のCapability設定は`src-tauri/capabilities/`を正本とし、以下のcommand名は設計上の責務名である。

| ユーザー操作 | 実行境界 | Tauri plugin / Command | 必要なCapability・認可 | キャンセル時 | 拒否・失敗時 |
|---|---|---|---|---|---|
| session開始/turn送信 | Rust → Codex stdio | `start_or_send_main_turn` | active workspace、Codex executable、typed payload、1 active execution。public instruction 32,000 scalarとcomposed text 80,000 scalarを別々に検証し、imageは`localImage`、fileは`mention`へRust内で変換し、`coding-wife-commit-work`を各turnのexplicit skill inputへ1件注入する | spawn前ならdraft維持 | 上限/NUL/control違反またはskill version/digest/注入を証明できなければturnを開始せず、thread自動重複作成なし |
| Stop | WorkspaceShell → Rust supervisor / NarrationController | `codex_turn_interrupt` + narration `turn_stop` dismiss | owned process/thread/turn ID、active narration presentation generation。support explanation controller cancelへは転送しない | confirmation cancelは継続 | timeout後process tree停止、Interrupted。caption/TTS失敗でもmain interruptを妨げない |
| event購読 | Rust event bridge | `subscribe_workspace_events` | workspace ID、monotonic sequence、schema allowlist | route leaveでUI購読だけ解除 | gapでpauseし診断表示 |
| workspace切替 | WorkspaceShell → Rust supervisor/DB | `interrupt_and_switch_workspace` | old workspace/thread/turn/generation、pending new workspace、terminal cleanup proof | old selection/draft/anchor/caption/TTS維持 | old workspaceをactiveのままtyped error |
| terminal Git observation handoff | Codex composition → Rust Git observer | `observe_terminal_work_unit` | validated terminal authority、work unit ID、workspace ID/generation、source event ID/sequence/time。observerがbefore/after HEAD、status、new commitとverification/decision/risk evidenceをread-onlyで相関し、同一eventをexact replayだけに制限 | terminal前は開始しない | observation/HIST失敗をUnavailable/Unknownにし、main resultとGit状態を変更しない |
| verified commit explanation handoff | App Server event bridge → Rust Git observer → app-owned explanation controller | `intercept_auto_verified_commit_for_explanation` | normalized Git commit command success、workspace generation、before/after HEAD、新しい到達可能SHA、commit evidence ID。`CommitExplanationRequestedV1(trigger=auto_verified_commit)`をmain session外で1件だけ作る | SHA検証前は開始しない | controllerを`failed` / `unavailable`にし、main conversationへrequest/result/failureを注入しない |
| attachment選択 | Tauri dialog → Rust | `select_workspace_attachments` | file picker、canonical workspace root、size/type |変更なし | invalid fileをhandle化しない |
| read-only context取得 | Rust context adapter | `capture_turn_context` | source allowlist、5秒deadline、stdout 1MiB、stderr 4KiB、process tree cleanup、timestamp、redaction、content hash | draft不変 | raw terminal/pathへfallbackせず、Terminal outputはunsupportedを返す |
| decision / approval回答 | Rust App Server adapter | `answer_decision_or_approval` | negotiated requestUserInputまたは既知approval method、元request ID、idempotency | Hold/cancelは未回答維持 | 未知method/schemaは許可せずBlocked |
| Live2D読込 | Rust asset protocol → WebView renderer | `load_character_pack` | selected verified pack ID、app-private root |前model維持 | static/text fallback |
| mute/audio | Rust audio/TTS | `set_mute` / `stop_audio` | 設定済みprovider、selected model/voice、redacted eligible text、native-only credential |前設定維持 | text-only継続 |
| clipboard copy | Tauri clipboard | `copy_event_summary` | redacted rendered textだけ | 非該当 | copy失敗notice、raw payload不可 |

## ウィンドウ固有動作

| 項目 | 動作 |
|---|---|
| 生成・再利用 | 現行S-001〜S-003、S-005と同じ`main`を再利用し、workspace IDだけをatomicに切替える |
| 初期サイズ・最小サイズ |共通の1470×836 / 960×640 |
| リサイズ | breakpoint表に従い、Chat/decisionをCharacterより優先する |
| 最大化・全画面 | Chat/Characterを1:1で拡張し、composerは最大720px |
| 常に手前へ表示 | 不可 |
| 閉じる操作 | running時は共通の停止して終了/終了しないを表示 |
| 未保存変更がある場合 | composer draftをDBへ保存してからroute/close。失敗時は閉じない |

## メニュー・ショートカット

| 操作 | macOS | Windows / Linux | 有効条件 | 実行結果 |
|---|---|---|---|---|
| turn送信 | `Command+Enter` | 非対応 | Sendと同条件 | 1 turnだけ作成 |
|改行 | `Enter` | 非対応 | composer focus | newline追加 |
| tab移動 | `Control+Tab` / `Control+Shift+Tab` | 非対応 | main window active | 3 tab循環 |
| popover/previewを閉じる | `Escape` | 非対応 | non-destructive overlay |入力維持、triggerへfocus |
| decision回答 | `Command+Enter` | 非対応 | valid selection/Other | answerを1回送信 |
| Stop | shortcutなし | 非対応 | running | buttonだけで実行 |

## データ保持

| データ | 正本・保存先 | 保存契機 | 復元契機 | 破棄条件 | 失敗時 |
|---|---|---|---|---|---|
| thread/turn/work unit | Codex + Rust SQLite mapping | validated lifecycle event | route return/restart | history明示削除 | Interrupted/read-only |
| normalized event | append-only SQLite + hash | versioned semantic schema/redaction合格後 | exact projectorでstable ID・sequence順にassistant/tool/file/diff/plan/completion/error/decision/approvalを復元し、completionはChatへ描画しない | workspace history明示削除 | unknown/invalidはUnsupportedへ隔離、raw event非保存 |
| draft/attachment handle/effort | Rust SQLite | debounce、valid変更、route leave | workspace選択 | send成功または明示clear | UI入力保持とretry |
| project context | Rust SQLite project row | App settingsのproject detailでexpected-version save | project detail/turn開始 | project登録解除契約 | expected version conflict |
| character context | Rust SQLite opaque pack ID-scoped row | App settings > Character detailのexpected-version save | character detail/選択packのturn開始 | app data reset契約 | expected version conflict |
| last summary/timeline anchor/tab | Rust SQLite | terminal summary、scroll settle/tab移動 | route return/restart。last summaryはschema互換のため保持するがChatでは消費しない | history削除契約 | 同workspaceのnearest valid sequenceだけへ補正 |
| repository identity/health snapshot | Rust SQLite、Git read-only再検査 | window focus、selection、Send直前 | route return/restart | project登録解除 | stale status、Repair/Recheck |
| selected character | app-global state → app-private library pack ID | App settingsのatomic選択成功 | startup/全workspaceへ即時同期 | 選択変更後だけ旧packを削除可 | invalid legacy値はbundled Hiyori、render失敗はstatic/text fallback |
| audio byte | owner-only temporary file | provider response完了後から再生中だけ |復元しない | playback/stop/route/quitの全terminal path | textは保持 |
| raw reasoning/support raw history/commit explanation transcript |保存しない | 非該当 |復元しない | task終了時 | redacted summaryまたはusage/status metadataだけ保持 |

## OS差分

| 項目 | macOS | Windows | Linux |
|---|---|---|---|
| support | macOS 14+ Apple Silicon | MVP非対応 | MVP非対応 |
| modifier | Command / Control+Tab | 非該当 | 非該当 |
| file picker / clipboard / audio | native adapter | 非該当 | 非該当 |
| Live2D acceleration | WKWebView/WebGLの検証済み経路 | 非該当 | 非該当 |

## アクセシビリティ

- focus順はheaderのrepository / workspace / branch copy control、header tabs、new updates、events、decision、composer controls、Character controlsとする。空のChat timelineはfocus targetを追加しない。
- timelineは`role=feed`相当を使う場合も追加eventごとに読み上げず、完了、decision、errorだけをlive regionへ要約する。
- tool groupのcollapsed/expanded、running/failed、file create/update/deleteをtextでも示す。
- decisionはheading、説明、option、Other、Hold/Interrupt/Approve、submitのDOM順とし、keyboardだけで完結する。
- Live2D canvasはpresentation扱いとし、state、uncertainty、waiting、verificationをvisible HTML captionへ複製する。
- Context conflictは手元draftを保持し、Reload/CancelのDOM順、section単位のfocus return、polite saved/assertive error regionをja/enで同等にする。
- workspace切替確認は`戻る`へ初期focus、dialog内focus trap、Escape=`戻る`とし、成功後はnew view heading、失敗/Cancel後は起点workspace itemまたはSendへfocusを戻す。
- commit background生成statusはcaption live regionへ流さず、明示presentation開始後の確定chunkだけをpolite、terminal errorだけをassertiveに1回通知する。
- muteは音量iconだけにせず`Mute / ミュート`と現在値をaccessible nameへ含める。
- 200% text zoomではChatを維持し、Characterが消えてもstatusとmuteへ到達できる。
- ja/enの長いerrorとrelative pathは文字を縮小せずwrap、必要なellipsis + tooltip、horizontal code scrollで扱う。headerのrepository / workspace / branchはellipsis + exact value copyで扱い、tooltipを表示しない。

## 性能と失敗隔離

| 指標 | 合格条件 |
|---|---:|
| workspace/tab feedback | p95 100ms以下 |
| event receiptからrender | p95 200ms以下 |
| timeline 10,000 event初期表示 | visible range virtualizationでp95 1,000ms以下 |
| composer input | p95 100ms以下、Live2Dによる100ms超long task 0件 |
| character failure | Chat、decision、Stop、evidence navigationを停止させない |

## 関連要件

| 要件ID | この画面での扱い | 要件定義書 |
|---|---|---|
| `WORK-F-052`〜`WORK-F-066` | workspace切替、active execution、state分離、bounded context、復元、repository health/repair、native初期化境界 | [workspace-sessions](../requirements/workspace-sessions.md) |
| `CODE-F-052`〜`CODE-F-079` | main session、event、composer、decision、Stop、reconnect、Sol、commit interceptor分離 | [codex-main-session](../requirements/codex-main-session.md) |
| `SUP-F-051`, `SUP-F-057`〜`SUP-F-061`, `SUP-F-069`〜`SUP-F-078` | app-owned commit explainer status、failure、interrupt、stream統合、main conversation分離 | [support-agent-orchestration](../requirements/support-agent-orchestration.md) |
| `GIT-F-072`〜`GIT-F-096` | read-only observation、main commit skill、typed terminal handoff、background説明生成と明示presentation、Commit tab | [git-review-harness](../requirements/git-review-harness.md) |
| `HIST-F-037`〜`HIST-F-048`, `HIST-F-057`, `HIST-F-059`, `HIST-F-061` | normalized timeline、sequence、scroll、restart recovery、observation/evidence appendとdurability表示 | [activity-history](../requirements/activity-history.md) |
| `LIVE-F-057`〜`LIVE-F-067`, `LIVE-F-075`, `LIVE-F-077`, `LIVE-F-079`〜`LIVE-F-081`, `LIVE-F-083` | app-global selection、semantic mapping、canvas、fallback、text parity、performance、character用語契約 | [live2d-character](../requirements/live2d-character.md) |
| `NARR-F-057`〜`NARR-F-063`, `NARR-F-068`〜`NARR-F-089` | eligible speech、explicit commit presentation、text parity、queue、mute、dismiss/cancel分離、fallback | [audio-commentary](../requirements/audio-commentary.md) |
| `APP-F-053`〜`APP-F-069` | shell、tabs、responsive、focus、native boundary、picker | [desktop-shell](../requirements/desktop-shell.md) |

## 未確定事項

| 論点 | 初期判断 | 確認事項 | 着手ブロック |
|---|---|---|---|
| 1280px時のCharacter最小幅 | Chat 500pxを守り、残りをCharacterへ与える | WebdriverIOで実Tauri windowを操作しcaptionとmuteの欠落を確認する | いいえ |
| timeline groupの初期展開 | running、failure、decisionを展開し、成功済みtoolをcompactにする | 100 eventの可読性testで調整する | いいえ |
| TTS読み上げ密度 | default off。enable後もcompletion/decision/errorだけ | demoの聴取時間とqueue backlogを記録する | いいえ |
| static preview生成 | import時に1枚生成しapp-privateへ保存 | model種別ごとの生成成功率を確認する | いいえ |

## レビュー確認

| 項目 | 内容 |
|---|---|
| レビュー結果 | Approved |
| レビュー日 | 2026-07-21 |

- [x] front matter、title、filenameの`S-002`が一致する。
- [x] `status: Approved`である。
- [x] demo/Figmaのsidebar、81px header、Chat、Character、composer寸法を定義した。
- [x] modelは`GPT-5.6 Sol`固定で、Reasoning、Fast service tier、Plan、Goalsを独立したcomposer controlとして定義した。
- [x] composerをdraft item、instruction、補助操作、実行操作の優先順位で整理し、狭幅でもSend/Stopと無効理由を維持する。
- [x] normal、empty、loading、processing、offline、error、permission、cancel、restartを定義した。
- [x] timeline、decision、Context、Live2D、audio、native boundary、data retentionを定義した。
- [x] verified commitからapp-owned explanation controllerへのbackground handoffとmain conversation非介入を定義した。
- [x] App SettingsのContext conflict/next-turn、repository health、active-turn切替、timeline anchor、app-global semantic mappingの状態とfocusを定義した。
- [x] 関連要件IDを要件定義書のS-002対応と一致させた。
- [x] 着手ブロックが「はい」または「不明」の未確定事項は0件である。
