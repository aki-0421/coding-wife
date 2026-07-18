---
title: "Codex runtime実装ガイド"
description: "Codex App Server adapterのファイル責務、不変条件、fake process試験、共有契約、live smokeの実行方法を記録する。"
updated: 2026-07-18
read_when:
  - "Codex runtimeのprocess監督、IPC、event parser、session storeを変更するとき。"
  - "Codex CLI更新後の互換性、障害復旧、privacy gateを検証するとき。"
---

# Codex runtime実装ガイド

## 適用仕様

接続方式と採用判断は[Codex App Server接続契約](codex-app-server-integration.md)を正本とする。上位要件は[codex-main-session](../requirements/codex-main-session.md)と[support-agent-orchestration](../requirements/support-agent-orchestration.md)である。

現在のadapter versionとevent schema versionはそれぞれ1である。OpenAI App Serverのraw unionはRust内へ閉じ込め、WebViewにはCoding Wife固有のtyped responseと正規化済みeventだけを渡す。

## 実装上の不変条件

1. active App Server processは1件だけにし、turn開始と全mutationをactivation token、workspace、thread、generationへ束縛する。stale response/event/errorをcurrent storeへ適用せず、accepted stale turnはexact旧turnをinterruptして旧workspaceへだけterminalを保存する。
2. `gpt-5.6-sol`だけを許可し、各turnでmodelと`low`または`max`を明示する。service tierは送らない。
3. 切断後にuser turnを自動再送しない。interrupt responseはterminal eventとして扱わない。
4. command approval、file change approval、permissions approvalの3 methodだけを受け付ける。未知request、invalid RUI、未登録dynamic toolはfail closedにしてactive turnをinterruptする。
5. raw reasoning、secret、home/workspaceのprivate absolute path、raw stderr、raw protocol payloadをWebView eventへ出さない。
6. thread、turn、item、pending IDはopaque handleへ変換し、WebViewからraw App Server IDを参照できないようにする。
7. support isolationは明示的なtool 0、cwdなし、filesystem/shell/MCPなしを証明できない限り`unavailable`である。現行実装のsupport capacityは0で、生成文を含まない決定的fallbackだけを返す。
8. workspaceの絶対pathと明示Codex binary pathはapp-private recordにだけ保存する。WebViewはnative folder pickerが返すopaque workspace ID、alias、boolean preflightだけを受け取る。
9. thread開始・再開はresponseのmodel、canonical cwd、thread cwd、approval policy、sandbox type、ephemeral=falseを全て照合する。不足・不一致時はhandleを保存せずchildを停止する。
10. pending responseはresponse variantと値をimmutable recordに対して検証してからatomicに消費する。invalid responseはpendingを残し、TypeScript側もpending kindとresponse typeを一致させてからsingle-claimする。
11. native RUIが使えない場合のassistant完了文は`result`または`decision_request`のJSON全体だけを受理する。自由文、freeform、approval代替、不正optionは表示せずactive turnをinterruptする。
12. fallback decisionはnative server request ledgerへ入れず、workspace、generation、source thread/turn、元のreasoning effortへ束縛した専用ledgerで管理する。source turnの正常完了後だけ、opaque decision handleとoption IDだけを含む固定JSONを同じthreadの新しいturnへ送る。invalid optionはcardを残し、同時応答は1件だけを開始し、開始失敗やchild crash後に自動再送しない。
13. binary discovery、version、schema、identity、capability probeのいずれかが失敗した時点で、以前のbinary/schema cacheとdiagnostic上のversion、hash、fingerprint、capability/account証跡を一括消去し、active childを停止する。次のconnectは必ず新しいdiscoveryとprobeから始める。
14. public textはfield別に検証する。identifier/aliasはsingle-line、prompt/assistant/tool excerpt/effect/evidenceは正規化済み`\n`と`\t`だけをcontrol例外として許可し、NUL、その他control、secret、private pathを拒否する。RustとTypeScriptはUnicode scalarで同じ上限を数える。
15. HISTのversioned CODE payloadはlive semantic eventと同じexact projectorで復元する。pending decision/approvalはsupervisor ownership照合成功時だけactionableにし、unknown/invalid payloadはraw/generic行へfallbackしない。
16. `DecisionContext`はnative RUI、fallback、normalizer、HIST、WebViewを通じてversion、effect、scope、risk、reversibility、recommendation、evidence、uncertaintyを保持する。不正contextを回答可能cardへ近似しない。

## Binary trustとprobe境界

`VerifiedBinaryIdentity`はcanonical path、owner UID、device、inode、size、mtime秒・ナノ秒、SHA-256を一組として保持する。binaryはcurrent userまたはroot所有だけを許し、対象fileと親directory chainのsymlink・writable policyを検査する。version取得、schema生成、spawnの各境界で同じtupleを再検証し、spawn直後にも再検証する。差し替えを検知した場合はprocess groupを停止し、supervisorのbinary、schema、runtime cacheを全て破棄する。

probeの上限はstdout/stderr各1 MiB、絶対deadline 10秒、schema depth 16、file数2,048、1 file 8 MiB、合計64 MiBである。schema tree内のfile/directory symlinkとnon-regular fileは拒否する。capabilityはmethod文字列の存在ではなく、request/notification unionのsingleton method discriminant、params `$ref`、required field、response object shapeをJSONとして構造照合した場合だけ`Supported`にする。

schema正本fixtureは`src-tauri/tests/fixtures/codex_schema_subset_v0_144_5.json`、process tree fixtureは`src-tauri/tests/fixtures/codex_process_tree_fixture.py`である。Codex CLI versionまたは利用fieldを変えるときはactual generated schemaから前者を更新し、required field削除、params ref差し替え、method重複、descriptionへの文字列移動をmutationしてfail closedを確認する。単なるmethod一覧fixtureへ戻してはならない。

probeとApp Serverの終了はPATH上の`kill` commandを使わず、process groupへ直接TERM、期限後にKILLを送る。親processの`try_wait`成功だけを終了条件にせず、stdioを保持するgrandchildとPGIDの生存も期限内に消滅させる。stderrはcredential・cookie・session ID・absolute pathをredactしてからtruncateし、順序を逆転させない。

probe失敗後のdiagnosticを調べるとき、以前の成功時の`cliVersion`、`binaryHashPrefix`、`schemaFingerprintPrefix`、`generatedBySameBinary`、capability/account値が残っていれば不具合である。`schema_malformed` fixtureは、成功接続後の再probeを失敗させてこれらが初期値へ戻り、その後の正常connectが新しい証跡を設定することを検証する。

## Workspaceとpublic contract境界

`codex_pick_workspace`だけが新しいworkspaceをproduction登録できる。native pickerで選択したdirectoryをcanonicalizeし、Git marker、HEAD、owner、writable policyをRust内で検査してからsupervisorへ登録する。app-private workspace復元と明示binary復元はserializable IPC requestにせず、`AppPrivateWorkspaceRecord`と`AppPrivateBinaryRecord`からのみ適用する。

public `WorkspaceRegistration`にraw pathを追加してはならない。`PendingRequestView`のapproval cardもraw command、cwd、environment ID、host、reasonを公開せず、versioned `ApprovalContext`のcategory、hashed/path alias、scope、risk、reversibility、recommendation、固定evidence codeだけを公開する。

## 通常Workspaceへのcomposition契約

通常起動のS-002は、履歴adapterとCodex runtimeを別々の成功表示として扱わず、`CodexWorkspaceSessionAdapter`相当のcomposition層で一つの`WorkspaceViewAdapter`へ束ねる。この層はReact UIへwire protocolを公開せず、既存の`TauriCodexTransport`、`CodexSessionClient`、workspace history transportをtyped portとして組み合わせる。

### 責務と正本

| 責務 | 正本 | composition層の動作 |
|---|---|---|
| active workspace | workspace historyのopaque workspace ID | 選択確定後だけ`codex_connect`へ同じIDを渡す。pathを要求・保持しない |
| 接続可否 | `CodexDiagnostic` | `health=ready`、core lifecycle/model discovery supported、Sol/Fast/Max/accountが全てtrueの場合だけSend可能にする |
| thread | Codex supervisor | workspace activationごとにconnect後、compositionが開始した所有threadを再利用し、所有handleが無い時だけ1件開始する。他clientの一覧結果を自動採用しない |
| turn受理 | `codex_turn_start` response | responseを受け取った後だけdraft clearをUIへ返す。validation、connect、thread、transport失敗ではdraftとattachmentを保持する |
| live state | generation別`CodexSessionStore` | workspace ID、generation、sequenceを全て照合し、旧workspaceまたは旧generation eventを現在表示へ混ぜない |
| durable timeline | workspace history writer | CodexEventをallowlist済みsemantic eventへ投影してから追記する。deltaは表示用にcoalesceし、completed/error/decision/approval/terminalを永続正本にする |
| pending response | `CodexSessionClient`のsingle-claim ledger | approval、native user input、fallback decisionをkind一致で1回だけ応答する。unknown/invalidは操作UIを出さずfail closedにする |
| stop/recovery | supervisorのinterruptとterminal event | Stop操作から1秒以内にinterrupt requestを開始し、5秒でackが無ければ明示errorにする。ackだけでterminalにせず、crash/EOFはInterruptedとして保持し自動再送しない |

接続状態と履歴状態は別軸である。履歴が`ready`でもCodex診断がblockedならtimeline閲覧とdraft保存だけを許可し、Sendは無効にする。逆にCodexがreadyでも履歴writerがread-only/recoveryなら新しいturnを開始しない。`connected=false`の固定値、demo successへのnative fallback、model/listを確認しないFast/Max表示は禁止する。

### semantic event投影

UI/HISTへ渡すCodex eventは、少なくとも次へ分類する。

- thread/turn status: idle、running、waiting、completed、failed、interrupted。
- assistant: streaming deltaはmemory上でitem単位に連結し、completed textを永続化する。
- plan、tool、file、diff: raw command/stdout/stderr/pathを出さず、件数、sanitized excerpt、path alias、change kind、detail refだけを使う。
- decision/approval: 検証済みquestion/optionsまたはversioned approval contextとpending handleだけを使う。
- diagnostic/protocol/model violation: safe code、willRetry、detail refと復旧可否を使い、raw payloadへfallbackしない。
- completion/error/interrupt: turn terminal authorityをstatus eventとして保存し、interrupt ackをcompletionへ変換しない。

同じCodex event IDの再配信は同内容なら履歴writerの冪等成功とし、内容差はconflictとしてingestionを停止する。history追記失敗を無視してlive表示だけ成功扱いにせず、turn中は安全なerrorを表示し、次turn開始前にwriter readinessを再確認する。

### UI操作契約

- `Approve once`、`Reject`、`Hold`、`Other`、`Interrupt`はpending kindが許す時だけ表示する。Holdはwire応答を送らずcardを維持する。
- approvalの`Other`や自由文accept、未知methodの近似許可は実装しない。
- native user inputのOtherはUIで1〜2,000文字のtrim済み自由回答として構築し、typed `user_input.answers`だけへ渡す。Holdはwire応答を送らずcardと入力を維持する。fallback decisionはcontractどおり自由文を許可しない。
- assistant/tool/plan/file/error/completionはsemantic rowとして表示し、120文字超のsanitized本文は展開とcopyを提供する。raw terminalとreasoningは表示しない。
- bottomから48px超離れている間はscrollを固定し、新event件数と`最新へ`を表示する。

### attachment/context境界

attachmentはRustが発行するopaque handleだけをturn requestへ渡す。native picker、drop、pasteは同じvalidatorを使い、active workspace内のregular readable non-symlink、non-executable fileだけを許可する。1件25MiB、10件、合計50MiBの境界をRustで再検証し、imageは`localImage`、他fileは`mention`へRust内で変換する。directory、root外、symlink、実行可能file、権限不足、期限切れhandleは無効itemだけを拒否し、draftと他のvalid itemを保持する。

handleは発行時のworkspace ID、Codex generation、canonical rootのdevice/inode、source fileのdevice/inode/size/SHA-256へ束縛し、TTLは30分とする。pickerが返すpathとdrop/pasteで受け取るpathは同じRust validatorへ渡し、drop/pasteのabsolute pathは入力にだけ使ってresponse、event、logへechoしない。validatorはroot directory descriptorから各componentを`openat`/no-followで開き、最終regular file descriptorを読み切って前後metadataとhashを確定する。PNG、JPEG、GIF、WebPのmagicに一致するraster imageだけを`localImage`、それ以外を`mention`へ投影する。

turn送信直前にroot identity、active generation、TTL、件数、合計size、source metadata/hashをstable descriptorで全件再照合する。検証済みdescriptorからowner-only app-private staging directory（0700）のimmutable snapshot file（0600）へcopyし、fileとdirectoryをfsyncしてsnapshot descriptorのmetadata/hashを再検証する。App Serverにはsnapshot pathだけを渡し、source pathを再openさせない。1件でもsnapshot化に失敗すればApp Server requestを開始せずdraftと全attachment chipを保持する。accepted response、開始失敗、terminal、interrupt/crash、TTL expiryの各境界でsnapshotを削除し、WebView/public event/logへsource/snapshot pathを出さない。

Contextは既存のnative snapshot IDだけを渡し、WebViewが本文やpathをturn payloadへ組み立てない。未実装の`terminal_output`を成功表示へfallbackしない。

## Workspace composition検証

通常gateに加え、次をfake App Serverと`/tmp`専用Git repositoryで通す。

1. native compositionを起動し、diagnostic→connect→thread/start→turn/start response→stream→terminalの順序を確認する。
2. turn/start拒否ではdraft/attachmentが残り、受理response後だけclear通知が1回発生することを確認する。
3. workspace切替とgeneration更新の直後に旧`turn/start` success/errorと旧eventを遅延送信し、current storeを変更せず、accepted旧turnをexact interruptし、旧workspaceへだけterminalを永続化する。二連続切替でもactive native turnが最大1件であることを確認する。
4. assistant、tool、plan、file、diff、decision、approval、error、completionをversioned semantic projectionし、reload後もstable ID・sequence順・multiline text・DecisionContext付きでexactに復元する。pending actionはownership照合時だけ操作可能にする。
5. approval/native input/fallbackを同時二重応答し、wire requestが1件だけであること、unknown requestが許可されないことを確認する。
6. Stop開始が1秒以内、ack boundaryが5秒以内で、ackだけではterminalにならないことをfake clockで確認する。
7. child crash後に受信済みevent、draft、Interruptedが残り、turn/startが自動再送されないことを確認する。
8. Sol、low、maxのいずれかをmodel/list fixtureから欠落させ、Sendと対応表示がfail closedになることを確認する。
9. attachmentのroot外、symlink、directory、executable、permission、size/count/total、stale handleをRust integrationで拒否し、有効なimage/fileだけがapp-private snapshotのlocalImage/mentionになることを確認する。検証後にleafとancestorを差し替えるfake App Server raceでexact validated bytesだけを観測し、accepted/failed/terminal/expiry cleanupと0700/0600を確認する。
10. agent-browserで1470/960/480 CSS px、200% zoom、ja/en、keyboard、reduced motion、scroll lock、decision回答、Stopを実操作する。

実Codexを使う通常gateは既存の読み取り専用diagnostic smokeだけに限定する。user repositoryでthread、turn、review、attachmentを作らず、実行系E2Eはfake App Serverと`/tmp` repositoryだけで行う。

## Support isolation gate

| 必要条件                   | Codex 0.144.xの証拠                              | 判定                               |
| -------------------------- | ------------------------------------------------ | ---------------------------------- |
| `ephemeral=true`           | responseで確認                                   | 対応                               |
| `thread/list`へ残らない    | 同じ接続で非列挙                                 | 対応。ただし全永続先は別監査が必要 |
| cwdなし                    | responseはAbsolutePathBufで、実測もworkspace cwd | 非対応                             |
| runtime workspace rootなし | 実測1件                                          | 非対応                             |
| dynamic tool 0             | `dynamicTools=[]`はclient-defined toolだけ       | 未証明                             |
| shell/file/MCP 0           | thread単位の完全allowlistがschemaにない          | 未証明                             |
| raw prompt/response非永続  | アプリ側では実装可能                             | 対応可能                           |

このため通常support sessionと固定reviewer support sessionはともに0件である。main event、Git/test/checkpoint metadata、既知error codeから固定summary keyを選ぶだけにし、AIの提案や自動判断を生成しない。

再評価にはbuilt-in tool deny-all、null cwd、null workspace rootをgenerated schemaとruntime probeの双方で確認する必要がある。モデルの自己申告は隔離証明にしない。

## ファイル責務

### Rust

| ファイル                              | 責務                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `src-tauri/src/codex/binary.rs`       | binary discovery、canonical実体検査、hash、同じbinaryによるschema probe                 |
| `jsonl.rs`                            | incremental framing、UTF-8、line/buffer上限                                             |
| `rpc.rs`                              | request ID相関、timeout、server request/notification signal                             |
| `protocol.rs`                         | 使用するApp Server subset、固定outbound parameter、model gate                           |
| `decision.rs`                         | 完了assistant JSONのexact parse、context-bound fallback decision ledgerとsingle-claim   |
| `process.rs`                          | 子process、環境allowlist、redacted stderr ring、5秒以内の段階的終了                     |
| `requests.rs`                         | approval/RUI exact validation、duplicate request ledger                                 |
| `normalizer.rs`                       | opaque handle、redaction済みCodexEventとDomainEvent                                     |
| `supervisor.rs`                       | handshake、thread/turn/review、single active turn、restart budget                       |
| `support.rs`                          | isolation unavailable時のcapacity 0と決定的fallback                                     |
| `attachment.rs`                       | opaque handle発行、workspace/file identity検証、送信直前再検証、localImage/mention変換   |
| `commands.rs`                         | WebViewへ公開するtyped Tauri command                                                    |
| `types.rs`                            | adapter v1のpublic DTOとserde contract                                                  |
| `workspace.rs`                        | native folder picker、Git/owner preflight、opaque workspace登録、app-private record復元 |
| `src-tauri/tests/codex_supervisor.rs` | fake process integrationとopt-in live smoke                                             |

### TypeScript

| ファイル                                    | 責務                                                                |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `src/lib/contracts/codex.ts`                | response/eventのexact-key parserとpublic DTO                        |
| `src/features/codex/transport.ts`           | Tauri invoke/listen境界と決定的demo transport                       |
| `src/features/codex/session-store.ts`       | generation、sequence、duplicate、pending response state             |
| `src/features/codex/workspace-session-adapter.ts` | workspace activation、turn受理、terminal Stop、HIST追記のcomposition |
| `src/features/workspace-persistence/codex-composition.ts` | historyとCodex sessionをS-002用`WorkspaceViewAdapter`へ束ねる         |
| `src/features/workspace-view/Timeline.tsx`  | semantic row、decision/approval、Other/Hold、safe detail操作         |
| `src/features/workspace-view/ChatView.tsx`  | 48px scroll lock、未読更新、composerとLive2D stageの配置             |
| `src/features/codex/workspace-store.ts`     | native pickerのsingle-flight、opaque registration、safe error state |
| `src/features/codex/use-codex-workspace.ts` | workspace storeを購読するReact hook                                 |
| `src/features/codex/client.ts`              | event購読とpending responseのsingle-claim制御                       |
| `src/test/fixtures/codex-runtime.v1.json`   | RustとTypeScriptが共有するpublic contract fixture                   |
| `src/test/fixtures/codex-attachments.v1.json` | absolute pathを含まないattachment public contract fixture         |

`CodexEvent`はbase fieldだけでなくvariant payloadもcamelCaseでserializeする。Rust round-tripとTypeScript parser testが同じfixtureを読むため、一方だけのfield名変更はgateで失敗する。

## Fake App Server

### Browser用interactive demo

Viteのdevelopment buildだけは、`?demoAppServer=1`を付けると`DemoCodexTransport`とephemeral historyをcompositionした決定論的App Server demoを起動する。queryが無い通常browser previewは従来どおりCodex未接続で、production buildではqueryを付けても有効化しない。

| composer入力 | 発生する検証用event |
|---|---|
| `demo:workflow` | accepted user、running、plan、assistant delta、tool、file、diff、native decision。Other/Hold回答後にapprovalへ進む |
| `demo:approval` | 既知command approval。Approve once、Reject、Stopだけを表示する |
| `demo:unknown` | 未知approval相当を`CODEX-PROTOCOL-UNSUPPORTED`としてblockedにし、許可UIを作らずInterruptedへ進む |
| `demo:stop` | runningを維持し、UI Stopからinterrupt terminalを確認する |
| `demo:crash` | `CODEX-APP-SERVER-EXITED`とInterruptedを1回だけ出し、turnを再送しない |

Addはabsolute pathを持たない固定opaque attachment handleを返す。demoのsemantic eventもproductionと同じHIST validatorを通るため、private path、未知change kind、invalid approval contextを追加するとcompositionがfail closedになる。

2026-07-18のagent-browser gateでは1470×956、960×900、480×900 CSS pxで横overflow 0、ja/en即時切替、Ctrl+Tab、Shift+Ctrl+Tab、⌘K compact filter、⌘↵ send/answer、OS reduced motion、stream→tool/file→Other/Hold→approval、Approve/Reject、unknown blocked、Stop、crash後1秒間のevent count不変を確認した。検証画像は`/tmp`だけに保存し、repositoryへ含めない。

### Native process fixture

`src-tauri/tests/fixtures/fake_codex_app_server.py`は`--version`、schema生成、stdio app-serverを実装したtest executableである。`CODING_WIFE_CODEX_FAKE_MODE`で次を選ぶ。

| mode                                     | 検証内容                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `fragmented`                             | 分割JSONL、handshake、固定turn contract、interrupt                                      |
| `out_of_order`                           | 応答順変更、ID相関、timeout後の非再送                                                   |
| `malformed`                              | 正常応答と同じreadへ入る不正frame、duplicate response                                   |
| `unknown_request`                        | 未知server requestへのerror応答とturn interrupt                                         |
| `crash_after_ready`                      | ready後crash、bounded restart、turn非再送                                               |
| `protocol_after_ready`                   | malformed JSONL後の3回/60秒bounded restart、turn非再送                                  |
| `experimental_rejected`                  | 新processでstable initializeへfallbackし、experimental fieldを送らずreviewをwire前block |
| `thread_policy_*`                        | model、cwd、approval policy、sandbox、ephemeralの各mutationをfail-stop                  |
| `attachments`                            | attachment-only turnを`localImage`と`mention`へ安全に変換し、raw pathを公開しない       |
| `native_rui`                             | strict 1問/2 optionのserver requestとtyped response round trip                          |
| `decision_fallback` / `decision_invalid` | exact decision card化、structured continuation、自由文interrupt                         |
| `decision_continuation_crash`            | fallback継続開始中のchild crashをterminal failureにし、自動再送しないこと               |
| `schema_malformed`                       | 成功probe後のschema失敗で以前のidentity/capability証跡を消去し、fresh connectで回復      |

fixtureは秘密、実account、実path、promptを含めない。新しいprotocol edge caseはproduction parserを緩める前にfake modeまたは共有fixtureへ追加する。

## 通常gate

```text
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all -- --test-threads=1
pnpm exec vitest run src/lib/contracts/codex.test.ts src/features/codex/transport.test.ts src/features/codex/session-store.test.ts src/features/codex/workspace-store.test.tsx
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

fake integrationはcrash testが環境変数を共有するため`--test-threads=1`で実行する。通常testではlive smokeはignoredのままにする。

## 読み取り専用live smoke

```text
CODEX_LIVE_SMOKE=1 cargo test \
  --manifest-path src-tauri/Cargo.toml \
  --test codex_supervisor \
  live_installed_codex_completes_read_only_handshake \
  -- --ignored --test-threads=1
```

このsmokeは選択binaryでschemaを生成し、initialize、account/read、config/read、model/listだけを行う。thread、turn、reviewを作らず、モデル利用を発生させない。出力へaccount内容、config値、`CODEX_HOME`、workspaceの絶対pathを追加してはならない。

実tokenを使うturn/review検証、ephemeral threadの非永続監査は別gateにする。特にsupport機能は、threadがlistへ残らないことだけで隔離合格にしてはならない。

## 変更時チェックリスト

- binary、version、hash、schema fingerprintのいずれかが変わったらcapabilityを再probeする。
- OpenAI method/fieldを追加するときはgenerated schema、fake fixture、Rust subset DTO、TypeScript exact parserを同時に更新する。
- 新しいserver requestは意味と権限を個別に審査し、default allowやgeneric toolへ流さない。
- error pathでraw `serde_json::Value`、stderr、invoke errorをUI error messageへ含めない。
- reconnect、workspace切替、future generationでpending approvalを再利用しない。
- fallback decisionの応答を`codex_respond_pending`へ流さず、`codex_answer_fallback_decision`だけで処理する。
- fallback continuationへprompt、label、descriptionなどの表示文を戻さず、opaque decision handleと選択option IDだけを送る。
- binary identity差し替え時に過去のbinary/schema cacheを残さない。
- probe失敗時はbinary/schemaだけでなく、diagnosticに残る以前のversion/hash/fingerprint/capability/account証跡も消去する。
- redaction fixtureはBearer/API keyだけでなくauth cookie、session ID、quoted/spaced credential key、`/Volumes`、`/Library`、`/Applications`を含める。
- stable initialize fallbackではexperimental-only fieldを送らず、unsupported operationをwire call前にblockする。
- support isolationを`supported`へ変える場合はdeny-all capabilityと`CODEX_HOME`差分のrelease evidenceを先に追加する。
