---
title: "Codex runtime実装ガイド"
description: "Codex App Server adapterのファイル責務、不変条件、fake process試験、共有契約、live smokeの実行方法を記録する。"
updated: 2026-07-21
read_when:
  - "Codex runtimeのprocess監督、IPC、event parser、session storeを変更するとき。"
  - "Codex CLI更新後の互換性、障害復旧、privacy gateを検証するとき。"
---

# Codex runtime実装ガイド

## 適用仕様

接続方式と採用判断は[Codex App Server接続契約](codex-app-server-integration.md)を正本とする。上位要件は[codex-main-session](../requirements/codex-main-session.md)と[support-agent-orchestration](../requirements/support-agent-orchestration.md)である。

現在のadapter versionとevent schema versionはそれぞれ1である。OpenAI App Serverのraw unionはRust内へ閉じ込め、WebViewにはCoding Wife固有のtyped responseと正規化済みeventだけを渡す。

## 実装上の不変条件

1. main App Server processはstartup restore後に1件だけ起動してアプリ終了まで全workspaceで共有し、turn開始と全mutationをactivation token、workspace、thread、process generationへ束縛する。workspace selectionはprocess lifecycleと独立させ、stale response/event/errorを選択中storeへ適用せず、accepted stale turnはexact旧turnをinterruptして旧workspaceへだけterminalを保存する。
2. `gpt-5.6-sol`だけを許可し、各turnでmodelと`low`または`max`を明示する。service tierは送らない。
3. 切断後にuser turnを自動再送しない。interrupt responseはterminal eventとして扱わない。
4. command approval、file change approval、permissions approvalの3 methodだけを受け付ける。未知request、invalid RUI、未登録dynamic toolはfail closedにしてactive turnをinterruptする。
5. raw reasoning、secret、home/workspaceのprivate absolute path、raw stderr、raw protocol payloadをWebView eventへ出さない。
6. thread、turn、item、pending IDはopaque handleへ変換し、WebViewからraw App Server IDを参照できないようにする。
7. support isolationは明示的なtool 0、cwdなし、filesystem/shell/MCPなしを証明できない限り`unavailable`である。現行実装のsupport capacityは0で、生成文を含まない決定的fallbackだけを返す。
8. workspaceの絶対pathと明示Codex binary pathはapp-private recordにだけ保存する。WebViewはworkspaceについてnative folder pickerが返すopaque workspace ID、alias、boolean preflightだけを受け取る。Codex pathだけは利用者が設定formへ入力した値をbounded requestとしてRustへ渡せるが、canonical pathをresponse、snapshot、history、通常logへ返さない。
9. thread開始・再開はresponseのmodel、canonical cwd、thread cwd、approval policy、sandbox type、ephemeral=falseを全て照合する。不足・不一致時はhandleを保存せずchildを停止する。
10. pending responseはresponse variantと値をimmutable recordに対して検証してからatomicに消費する。invalid responseはpendingを残し、TypeScript側もpending kindとresponse typeを一致させてからsingle-claimする。
11. native RUIが使えない場合のassistant最終完了文は`result`または`decision_request`のJSON全体だけを受理する。Codexへ渡す`outputSchema`はStructured Outputsが受理する単一root objectとし、全fieldをrequiredにしたうえでvariant固有fieldをnullableにする。`result`では`decisionId`、`question`、`options`、`context`をnullに限定し、booleanまたはnullの`allowFreeform`はdecisionへ影響しない互換fieldとして無視する。`decision_request`では必要な値がすべてnon-nullかつ`allowFreeform=false`であることをRustでも再検証する。Structured Outputのassistant deltaはJSON envelopeのtransport断片なのでWebView eventへ出さない。完了itemはApp Serverの`phase`を確認し、`commentary`ならredact・長さ制限した途中経過、`final_answer`またはphaseなしなら厳格検証した最終出力として扱う。commentaryがexact `result` envelopeの場合は`message`だけを取り出し、commentaryのplain textまたはJSON envelopeを最終回答違反としてinterruptしない。root `oneOf`、最終回答の自由文、freeform decision、approval代替、不正optionは受理せずactive turnをinterruptする。
12. fallback decisionはnative server request ledgerへ入れず、workspace、generation、source thread/turn、元のreasoning effortへ束縛した専用ledgerで管理する。source turnの正常完了後だけ、opaque decision handleとoption IDだけを含む固定JSONを同じthreadの新しいturnへ送る。invalid optionはcardを残し、同時応答は1件だけを開始し、開始失敗やchild crash後に自動再送しない。
13. binary discovery、version、schema、identity、capability probeのいずれかが失敗した時点で、以前のbinary/schema cacheとdiagnostic上のversion、hash、fingerprint、capability/account証跡を一括消去し、active childを停止する。次のconnectは必ず新しいdiscoveryとprobeから始める。connectionまたはauth/model handshakeだけの失敗では、metadata identityが一致するbinary/schema evidenceを再利用できる。
14. public textはfield別に検証する。identifier/aliasはsingle-line、prompt/assistant/tool excerpt/effect/evidenceは正規化済み`\n`と`\t`だけをcontrol例外として許可し、NUL、その他control、secret、private pathを拒否する。RustとTypeScriptはUnicode scalarで同じ上限を数える。
15. HISTのversioned CODE payloadはlive semantic eventと同じexact projectorで復元する。pending decision/approvalはsupervisor ownership照合成功時だけactionableにし、unknown/invalid payloadはraw/generic行へfallbackしない。
16. `DecisionContext`はnative RUI、fallback、normalizer、HIST、WebViewを通じてversion、effect、scope、risk、reversibility、recommendation、evidence、uncertaintyを保持する。不正contextを回答可能cardへ近似しない。
17. main turnのpublic instruction上限32,000 Unicode scalarと、contextを含む合成text上限80,000 Unicode scalarを分離する。Rust supervisorは後者をApp Server送信前に再検証し、exact 80,000を受理、80,001、NUL、空textかつattachmentなしを拒否する。multibyte文字もUTF-8 byte数ではなく1 scalarとして数える。この変更はsupport専用input/outputの64KiB byte上限を変更しない。
18. repositoryのfocus recheckとSend直前recheckが同じworkspaceのCodex activationを同時に要求した場合は、同じworkspace・history modeの1件へsingle-flight化する。readyな同一sessionをrepository recheckだけで再生成せず、送信前activationの競合で接続済みgenerationをstaleにしない。
19. Sendは`codex_turn_start`の受理後だけdraftを消去する。context取得、repository recheck、activation、preflight、transport、受理拒否のいずれで失敗してもworkspace固有draftとattachmentを保持し、raw例外ではなく安全なerror codeをComposer noticeへ表示する。
20. workspace履歴のhydrationはCodex activationを待たない。履歴snapshot適用後に通常shellを描画し、選択workspaceのconnectとthread start/resumeをbackground single-flightとして開始する。接続中はSendだけを無効にし、timeline、draft、navigationを利用可能に保つ。
21. 現在の設定pathと一致するverified binary identity、`health=ready`のactive runtimeに対する重複connectとidle workspace切替はprocessとgenerationを変更せず現在のdiagnosticを返す。workspaceごとのnormalizer、opaque thread handle、sequenceはprocess内contextとして退避・復元する。active/pending turn中はruntime contextを切り替えず、view selectionだけを変更する。明示pathの変更・解除、process crash、protocol violationではready runtimeを再利用せず、旧process treeの終了収束後にreplacementを1件だけ起動する。
22. stable initializeに成功したsetup evidenceはexact verified binary identityへ束縛する。同じidentityに対する繰り返しsetup診断は短命processを追加起動せず、通常connectionのfull handshake成功もsetup evidenceを更新する。identityまたはtrust metadataが変わったevidenceを再利用しない。

## Binary trustとprobe境界

`VerifiedBinaryIdentity`はcanonical path、owner UID、device、inode、size、mode、mtime秒・ナノ秒、ctime秒・ナノ秒、SHA-256を一組として保持する。binaryはcurrent userまたはroot所有だけを許し、対象fileと親directory chainのsymlink・writable policyを検査する。observation epochの開始時にfull SHA-256を取得し、version取得、schema生成、spawnの直前・直後では同じmetadata tupleとtrust policyを再検証する。metadataが変化した場合はprocess groupを停止し、supervisorのbinary、schema、setup evidence、runtime cacheを全て破棄してfull verificationへ戻る。同じmetadata tupleに対して連続して実行ファイル全体を読み直してはならない。詳細は[Codex App Server起動性能の設計監査](codex-startup-performance.md)を参照する。

自動探索は明示app-private path、GUI processの`PATH`、default shellの`command -v codex`、`~/.local/bin`を含む既知install位置の順で行う。default shellはaccount情報または`SHELL`からabsolute executableを得て同じtrust検証を通し、interactive login commandを3秒以内、stdout/stderr各64KiB以内でprocess groupごと終了する。結果はtrim済みの単一absolute pathだけを受理する。初回setupまたはGeneralから受けたpathはUTF-8 absolute path 4,096 byte以下として一時的にIPC requestへ入るが、binary trust、version、App Server spawnとstableな`initialize` / `initialized`に成功したcanonical pathだけをSQLite `settings`のapp-private recordへ保存し、response、diagnostics、domain event、通常logへ返さない。設定解除はrecordを削除して自動探索へ戻し、実行中sessionには適用せず次のconnectから使う。

supervisorが設定pathを既存binary identityへ束縛する時は、入力表記ではなくcanonical pathを比較する。macOSの`/var`と`/private/var`のように同じ実体へ解決される表記では以前のidentityをexpected evidenceとして維持し、同一path上の差し替えをfail closedで検知する。異なるcanonical pathへの明示変更だけは以前のidentityへ束縛せず、新しいbinaryとして検証する。

起動時は`NativeReadinessService`が`WorkspaceHistoryService`のstartup restore barrierを待ち、保存済みactive workspaceを取得してから`CodexSupervisor.connect`を開始する。これがverified binaryのdiscovery、schema生成、experimental initialize、account/read、config/read、model/listとmain App Serverの長寿命runtime確立を一度だけ行う。復元前のprocess cwdによる失敗snapshotを公開してはならない。WebViewのworkspace hydrationとNative readinessが同時にconnectしても同じsupervisor lifecycle lockへ入り、後続はready runtimeを再利用する。active workspaceがまだ無い初回setupだけはbounded setup probeを許すが、workspace作成後の最初のconnectから同じ長寿命runtimeを使う。通常接続失敗はoverviewへ戻さず、Composerに安全なreason codeと明示的な再接続操作を表示し、再試行の成否にかかわらずworkspace固有draftを保持する。

この境界を変更した時は`cargo test --manifest-path src-tauri/Cargo.toml --test codex_supervisor workspace_switch_reuses_app_server_process_and_workspace_context -- --test-threads=1`で二つのworkspaceがversion、schema、process、initializeを各1回だけ共有し、thread contextを復元することを確認する。起動順序を変更した時は`cargo test --manifest-path src-tauri/Cargo.toml workspace_history::service::tests::native_consumers_wait_for_restore_and_mutations_fail_while_pending`でnative listとreadinessの両方がrestore中に完了しないことを確認する。設定pathとidentityの束縛を変更した時は`cargo test --locked --manifest-path src-tauri/Cargo.toml --test codex_supervisor readiness_probe_blocks_a_changed_configured_binary_without_turn_mutation -- --test-threads=1`でcanonical aliasを経由しても差し替えを拒否することを確認する。UI側は`pnpm exec vitest run src/features/workspace-persistence/codex-composition.test.ts src/features/readiness/SetupOverview.test.tsx src/features/workspace-view/WorkspaceShell.test.tsx --fileParallelism=false`で実行中workspaceを止めずに別workspaceへ移動できること、旧event/pending requestを新viewへ混在させないこと、旧turn terminal後に現在selectionを同じruntimeへactivateすることを確認する。wall clockの秒数を合否条件にしない。

probeの上限はstdout/stderr各1 MiB、絶対deadline 10秒、schema depth 16、file数2,048、1 file 8 MiB、合計64 MiBである。schema tree内のfile/directory symlinkとnon-regular fileは拒否する。capabilityはmethod文字列の存在ではなく、request/notification unionのsingleton method discriminant、params `$ref`、required field、response object shapeをJSONとして構造照合した場合だけ`Supported`にする。

探索順やshell出力parserを変更した場合は`cargo test --manifest-path src-tauri/Cargo.toml codex::binary::tests`、app-private binary recordを変更した場合は`cargo test --manifest-path src-tauri/Cargo.toml private_codex_binary_setting`を実行する。readiness IPCまたは設定UIを変更した場合は`pnpm exec vitest run src/features/readiness/CodexBinaryPathSettings.test.tsx src/features/readiness/controller.test.ts src/features/readiness/SetupOverview.test.tsx --fileParallelism=false`を実行し、absolute path送信、canonical path非返却、自動検出復帰、直前snapshot保持を確認する。

schema正本fixtureは`src-tauri/tests/fixtures/codex_schema_subset_v0_144_5.json`、process tree fixtureは`src-tauri/tests/fixtures/codex_process_tree_fixture.py`である。Codex CLI versionまたは利用fieldを変えるときはactual generated schemaから前者を更新し、required field削除、params ref差し替え、method重複、descriptionへの文字列移動をmutationしてfail closedを確認する。単なるmethod一覧fixtureへ戻してはならない。

probeとApp Serverの終了はPATH上の`kill` commandを使わず、process groupへ直接TERM、期限後にKILLを送る。親processの`try_wait`成功だけを終了条件にせず、stdioを保持するgrandchildとPGIDの生存も期限内に消滅させる。TERM 200ms、KILL 500msの既存上限内でgroupが残る間はKILLを再送し、signalと同時に進行したforkが一度目の対象から外れてもgroup disappearanceへ収束させる。async futureのcancelまたはpanicでDropだけが実行できる場合も、同じ500ms以内で同期的にKILLとgroup probeを反復する。cleanup helperがdirect childのreapとgroup disappearanceを`Converged`として確定した時点で、同じownership境界がDrop guardを必ずdisarmしてからcallerへ戻る。`Unconverged`の場合だけguardをarmedのまま保つ。収束後もarmedにすると、数値PID/PGIDが別process groupへ再利用された後のreturn/dropで無関係なprocessへSIGKILLを送るため禁止する。stderrはcredential・cookie・session ID・absolute pathをredactしてからtruncateし、順序を逆転させない。

`codex_process_tree_fixture.py`は、全descendantのfork、process group継承、parent/grandchild PID fileのatomic publishが完了した後にだけready markerをatomic publishする。cancel試験はこのmarkerとparse済みPIDを確認するまでfutureをabortしない。試験はproduction cleanupの結果を2秒以内のPGID消滅で先に判定し、判定前にfallback cleanupを実行して成功を偽装してはならない。一方でtask abort handle、既知PGID/PID、state fileを所有するpanic-safe guardを保持し、setup、read、cancel結果、cleanup assertionのどこで失敗してもTERM、短いpoll、反復KILL、group disappearance確認、state file削除を行う。

probe失敗後のdiagnosticを調べるとき、以前の成功時の`cliVersion`、`binaryHashPrefix`、`schemaFingerprintPrefix`、`generatedBySameBinary`、capability/account値が残っていれば不具合である。`schema_malformed` fixtureは、成功接続後の再probeを失敗させてこれらが初期値へ戻り、その後の正常connectが新しい証跡を設定することを検証する。

## Workspaceとpublic contract境界

`codex_pick_workspace`だけが新しいworkspaceをproduction登録できる。native pickerで選択したdirectoryをcanonicalizeし、Git marker、HEAD、owner、writable policyをRust内で検査してからsupervisorへ登録する。起動時のapp-private workspace復元と明示binary復元はserializable IPC requestにせず、`AppPrivateWorkspaceRecord`と`AppPrivateBinaryRecord`からのみ適用する。利用者が明示的に変更する`configure_codex_binary`だけは未検証pathをbounded requestとして受け、検証成功後に同じprivate recordへ変換する。

public `WorkspaceRegistration`にraw pathを追加してはならない。`PendingRequestView`のapproval cardもraw command、cwd、environment ID、host、reasonを公開せず、versioned `ApprovalContext`のcategory、hashed/path alias、scope、risk、reversibility、recommendation、固定evidence codeだけを公開する。

## 通常Workspaceへのcomposition契約

通常起動のS-002は、履歴adapterとCodex runtimeを別々の成功表示として扱わず、`CodexWorkspaceSessionAdapter`相当のcomposition層で一つの`WorkspaceViewAdapter`へ束ねる。この層はReact UIへwire protocolを公開せず、既存の`TauriCodexTransport`、`CodexSessionClient`、workspace history transportをtyped portとして組み合わせる。

### 責務と正本

| 責務             | 正本                                      | composition層の動作                                                                                                                                          |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| active workspace | workspace historyのopaque workspace ID    | 選択確定後だけ`codex_connect`へ同じIDを渡す。pathを要求・保持しない                                                                                          |
| 接続可否         | `CodexDiagnostic`                         | `health=ready`、core lifecycle/model discovery supported、Sol、1件以上の広告済みreasoning effort、accountが揃う場合だけSend可能にする                         |
| thread           | Codex supervisor                          | workspace activationごとにconnect後、compositionが開始した所有threadを再利用し、所有handleが無い時だけ1件開始する。他clientの一覧結果を自動採用しない        |
| turn受理         | `codex_turn_start` response               | responseを受け取った後だけdraft clearをUIへ返す。validation、connect、thread、transport、受理拒否ではdraftとattachmentを保持し、安全なerror codeを表示する      |
| live state       | generation別`CodexSessionStore`           | workspace ID、generation、sequenceを全て照合し、旧workspaceまたは旧generation eventを現在表示へ混ぜない                                                      |
| durable timeline | workspace history writer                  | CodexEventをallowlist済みsemantic eventへ投影してから追記する。Structured Outputのassistant deltaは破棄し、検証済みcompleted message、error、decision、approval、terminalを永続正本にする |
| pending response | `CodexSessionClient`のsingle-claim ledger | approval、native user input、fallback decisionをkind一致で1回だけ応答する。unknown/invalidは操作UIを出さずfail closedにする                                  |
| stop/recovery    | supervisorのinterruptとterminal event     | Stop操作から1秒以内にinterrupt requestを開始し、5秒でackが無ければ明示errorにする。ackだけでterminalにせず、crash/EOFはInterruptedとして保持し自動再送しない |

接続状態と履歴状態は別軸である。履歴が`ready`でもCodex診断がblockedならtimeline閲覧とdraft保存だけを許可し、Sendは無効にする。逆にCodexがreadyでも履歴writerがread-only/recoveryなら新しいturnを開始しない。`connected=false`の固定値、demo successへのnative fallback、model/listを確認しないreasoning levelやFast service tier表示は禁止する。

window focusとSendはどちらもrepository healthを再確認できるが、同じworkspace・history modeへ向くCodex activationはcomposition層でsingle-flightにする。すでに同条件で接続済みの所有threadがある場合はそのsessionを再利用する。Send中に別のrecheckが`beginActivation`してgenerationとthread handleを一時消去する競合を許してはならない。

### semantic event投影

UI/HISTへ渡すCodex eventは、少なくとも次へ分類する。

- thread/turn status: idle、running、waiting、completed、failed、interrupted。
- assistant: Structured Outputのstreaming deltaはJSON envelope断片として破棄する。completed itemの`phase=commentary`はredact・長さ制限した途中経過として表示・永続化し、exact `result` envelopeなら`message`だけを表示する。`phase=final_answer`またはphaseなしだけを最終Structured Outputとして検証し、検証・redact済み`result.message`を表示・永続化する。decision requestはassistant本文を作らずdecision cardだけを作る。
- `userMessage`と`agentMessage`の内部item lifecycleは監査用HISTへ保存するが、accepted user行とassistant行に加えて重複するアクティビティ行を表示しない。特にturn完了後に内部`agentMessage: running`を残してはならない。
- plan、tool、file、diff: raw command/stdout/stderr/pathを出さず、件数、sanitized excerpt、path alias、change kind、detail refだけを使う。tool lifecycleは`tool_status`へ分離し、MCPではredact・長さ制限済みprovider/tool name、credential値を除く最大4件のtop-level引数要約、durationだけを公開する。人向けの`title`、`query`、`ref_id`等を優先し、`code`、`script`、`expression`等のsource bodyは本文を公開せずUnicode scalar数だけを示す。commandとweb searchも同じfieldへ正規化し、App Server内部型`mcpToolCall`を実tool名として表示しない。永続化は`code.tool.status.changed`を新規正本とし、旧`code.item.status.changed` tool rowは読込互換だけを維持する。
- decision/approval: 検証済みquestion/optionsまたはversioned approval contextとpending handleだけを使う。
- diagnostic/protocol/model violation: safe code、willRetry、detail refと復旧可否を使い、raw payloadへfallbackしない。
- completion/error/interrupt: turn terminal authorityをstatus eventとして保存し、interrupt ackをcompletionへ変換しない。

App Serverの`warning` notificationは`CODEX-WARNING` diagnosticとして永続化するが、turn失敗を
意味しない。live projectionとHIST復元ではnon-terminalな`status: warning`として表示し、
`Action failed`または`status: failed`へ投影してはならない。`error` notificationは従来どおり
`CODEX-TURN-ERROR`として失敗表示する。

Codex 0.144.5が接続直後またはturn実行中に送る`mcpServer/startupStatus/updated`、
`remoteControl/status/changed`、`account/rateLimits/updated`、
`thread/tokenUsage/updated`は、Coding Wifeのmain session、turn、model、approval状態を
変更しない既知の補助notificationとして明示的に破棄する。これらのmethodを
`code.protocol.unsupported`へ投影して利用者へblocked errorを表示してはならない。その他の
未知notification、未知item type、未知enumは従来どおりraw payloadを公開せず
`CODEX-PROTOCOL-UNSUPPORTED`へfail closedする。

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

Contextの編集・保存は既存のnative snapshotを正本とし、turn開始時に取得したimmutable version/hash付きsnapshotだけを固定markerとpublic instructionへ合成する。合成後のtext全体はJSON escapingとmetadataを含め80,000 Unicode scalar以下とし、WebViewとRust supervisorの双方で同じ単位を検証する。persisted public draftは32,000 scalar以下のままにしてprivate composed envelopeを保存しない。未実装の`terminal_output`を成功表示へfallbackしない。

## Workspace composition検証

通常gateに加え、次をfake App Serverと`/tmp`専用Git repositoryで通す。

1. native compositionを起動し、diagnostic→connect→thread/start→turn/start response→stream→terminalの順序を確認する。
2. turn/start拒否ではdraft/attachmentが残り、受理response後だけclear通知が1回発生することを確認する。
3. workspace切替とgeneration更新の直後に旧`turn/start` success/errorと旧eventを遅延送信し、current storeを変更せず、accepted旧turnをexact interruptし、旧workspaceへだけterminalを永続化する。二連続切替でもactive native turnが最大1件であることを確認する。
4. assistant、tool、plan、file、diff、decision、approval、error、completionをversioned semantic projectionし、reload後もstable ID・sequence順・multiline text・DecisionContext付きでexactに復元する。pending actionはownership照合時だけ操作可能にする。
5. approval/native input/fallbackを同時二重応答し、wire requestが1件だけであること、unknown requestが許可されないことを確認する。
6. Stop開始が1秒以内、ack boundaryが5秒以内で、ackだけではterminalにならないことをfake clockで確認する。
7. child crash後に受信済みevent、draft、Interruptedが残り、turn/startが自動再送されないことを確認する。
8. Solまたは全reasoning effortをmodel/list fixtureから欠落させ、Sendがfail closedになることを確認する。Fast tier欠落時はSend自体でなくFast flagだけがdisabledになることを確認する。
9. attachmentのroot外、symlink、directory、executable、permission、size/count/total、stale handleをRust integrationで拒否し、有効なimage/fileだけがapp-private snapshotのlocalImage/mentionになることを確認する。検証後にleafとancestorを差し替えるfake App Server raceでexact validated bytesだけを観測し、accepted/failed/terminal/expiry cleanupと0700/0600を確認する。
10. main turn textの80,000/80,001 Unicode scalar、multibyte scalar、NUL、empty-without-attachmentをnative境界で検証し、public draft/instructionの32,000 scalarとsupportの64KiB byte上限が変わらないことを確認する。
11. WebdriverIOで実Tauri windowを1470×836、1280×800、960×640にして、200% zoom、ja/en、keyboard、reduced motion、scroll lock、decision回答、Stopを実操作する。

実Codexを使う通常gateは既存の読み取り専用diagnostic smokeだけに限定する。user repositoryでthread、turn、review、attachmentを作らず、実行系E2Eはfake App Serverと`/tmp` repositoryだけで行う。

## Support isolation gate

Codex CLI 0.144.5 exact releaseでは、[Codex support runtime の実効権限ゼロ隔離調査](codex-support-runtime-isolation.md)のrelease constructorをすべて通過した時だけcommit explainer capacityを1にする。それ以外のrelease、canonical schema fingerprint、tool-absence boundary、permission profile、auth bridge、thread response、canaryのいずれかを検証できなければcapacity 0と決定的fallbackに戻す。

supportはmainと別process、clean `CODEX_HOME`、repositoryと無関係な空のowner-only cwd、runtime root 0、environment 0で動く。全Responses requestで`tools` field不在、wire-advertised/external-authority tool 0、`tool_choice=auto`、`parallel_tool_calls=false`を要求する。wireへ広告されていなくてもCodex内部で`update_plan` eventは発火可能なため、`turn/plan/updated`、server request、authority-bearing item、unknown event、schema不一致を受けたtaskはterminal rejectionし、partial outputを公開・保存しない。

support turnへはapp bundleでowner/mode/identity/digest検証した`coding-wife-explain-commit`のexact bytesをowner-only private run directoryへsnapshotし、そのprivate pathだけをexactly once注入する。main用`coding-wife-commit-work`と相互に混在させない。入力する`CommitEvidenceV1`の全文字列はnativeで再帰走査し、secret、絶対path、相対repository pathを検出したら`turn/start`前に拒否する。

## ファイル責務

### Rust

| ファイル                              | 責務                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `src-tauri/src/codex/binary.rs`       | binary discovery、canonical実体検査、hash、同じbinaryによるschema probe                 |
| `jsonl.rs`                            | incremental framing、UTF-8、line/buffer上限                                             |
| `rpc.rs`                              | request ID相関、timeout、server request/notification signal                             |
| `protocol.rs`                         | 使用するApp Server subset、固定outbound parameter、decision output schema、model gate   |
| `decision.rs`                         | 完了assistant JSONのvariant検証、context-bound fallback decision ledgerとsingle-claim    |
| `process.rs`                          | 子process、環境allowlist、redacted stderr ring、5秒以内の段階的終了                     |
| `requests.rs`                         | approval/RUI exact validation、duplicate request ledger                                 |
| `normalizer.rs`                       | Structured Output deltaの破棄、opaque handle、tool identity/summaryを含むredaction済みCodexEvent |
| `supervisor.rs`                       | handshake、thread/turn/review、single active turn、restart budget                       |
| `support.rs`                          | support公開contract、single-use explain turn、strict output/event policy、fallback      |
| `support_isolation.rs`                | exact release/schema検証、native sandbox・mock wire・malicious canary preflight         |
| `support_private.rs`                  | owner-only clean runtime、env allowlist、no-follow auth bridge、確実なcleanup           |
| `support_probe.rs`                    | loopback Responses capture、tool field不在、shell拒否、internal plan event fixture      |
| `attachment.rs`                       | opaque handle発行、workspace/file identity検証、送信直前再検証、localImage/mention変換  |
| `commands.rs`                         | WebViewへ公開するtyped Tauri command                                                    |
| `types.rs`                            | adapter v1のpublic DTOとserde contract                                                  |
| `workspace.rs`                        | native folder picker、Git/owner preflight、opaque workspace登録、app-private record復元 |
| `src-tauri/src/workspace_history/store.rs` | `code.tool.status.changed`を含む永続eventのexact allowlistとpublic text検証          |
| `src-tauri/tests/codex_supervisor.rs` | fake process integrationとopt-in live smoke                                             |

### TypeScript

| ファイル                                                  | 責務                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/lib/contracts/codex.ts`                              | response/eventのexact-key parserとpublic DTO                         |
| `src/lib/contracts/workspace-history.ts`                  | 永続semantic eventのexact-key parserとpublic text検証                |
| `src/features/codex/transport.ts`                         | Tauri invoke/listen境界と決定的demo transport                        |
| `src/features/codex/event-projection.ts`                  | live CodexEventを表示行と永続semantic eventへ投影                    |
| `src/features/codex/session-store.ts`                     | generation、sequence、duplicate、pending response state              |
| `src/features/codex/workspace-session-adapter.ts`         | workspace activation、turn受理、terminal Stop、HIST追記のcomposition |
| `src/features/workspace-persistence/codex-composition.ts` | historyとCodex sessionをS-002用`WorkspaceViewAdapter`へ束ねる        |
| `src/features/workspace-persistence/codex-event-projector.ts` | 永続semantic eventからliveと同じ表示行を復元                     |
| `src/features/workspace-view/Timeline.tsx`                | semantic row、decision/approval、Other/Hold、safe detail操作         |
| `src/features/workspace-view/ChatView.tsx`                | 48px scroll lock、未読更新、composerとLive2D stageの配置             |
| `src/features/codex/workspace-store.ts`                   | native pickerのsingle-flight、opaque registration、safe error state  |
| `src/features/codex/use-codex-workspace.ts`               | workspace storeを購読するReact hook                                  |
| `src/features/codex/client.ts`                            | event購読とpending responseのsingle-claim制御                        |
| `src/test/fixtures/codex-runtime.v1.json`                 | RustとTypeScriptが共有するpublic contract fixture                    |
| `src/test/fixtures/codex-attachments.v1.json`             | absolute pathを含まないattachment public contract fixture            |

`CodexEvent`はbase fieldだけでなくvariant payloadもcamelCaseでserializeする。Rust round-tripとTypeScript parser testが同じfixtureを読むため、一方だけのfield名変更はgateで失敗する。

decision envelopeまたはassistant event正規化を変更した時は、`cargo test --manifest-path src-tauri/Cargo.toml codex::decision::tests`と`cargo test --manifest-path src-tauri/Cargo.toml codex::normalizer::tests`を実行する。前者は`result`互換fieldとdecision requestのfail-closed検証、後者はJSON delta非公開、commentaryのplain textまたはexact `result.message`だけがredact済みで表示されturnをinterruptしないこと、最終完了messageのredaction、invalid final outputのinterrupt要求を確認する。output schemaを変更した時は`cargo test --manifest-path src-tauri/Cargo.toml codex::protocol::tests::decision_output_schema_uses_a_structured_outputs_root_object`も実行し、単一root objectとrequired field契約を確認する。

tool eventの正規化、表示field、永続payloadを変更した時は、`cargo test --manifest-path src-tauri/Cargo.toml codex::normalizer::tests`と`cargo test --manifest-path src-tauri/Cargo.toml workspace_history::store::tests::rich_codex_events_use_an_exact_bounded_allowlist_and_are_redacted`でApp Server itemからraw ID・result・credential・private pathが漏れず、HISTがexact allowlistだけを受理することを確認する。続けて`pnpm exec vitest run src/lib/contracts/codex.test.ts src/lib/contracts/workspace-history.test.ts src/features/codex/event-projection.test.ts src/features/workspace-persistence/adapter.test.ts src/features/workspace-view/WorkspaceShell.test.tsx --fileParallelism=false`でlive/HISTのprovider、実tool名、summary、duration、safe detailが同じ表示へ収束し、旧`mcpToolCall` item typeが実tool名として描画されないことを確認する。

## Fake App Server

### Browser用interactive demo

Viteのdevelopment buildだけは、`?demoAppServer=1`を付けると`DemoCodexTransport`とephemeral historyをcompositionした決定論的App Server demoを起動する。queryが無い通常browser previewは従来どおりCodex未接続で、production buildではqueryを付けても有効化しない。

同じ明示queryは、Commit画面のvertical E2Eに限ってin-memoryの`CommitExplanationAppRuntime`もcompositionする。このruntimeはproductionと同じcontroller/source境界を使い、検証済みdemo commitを`queued`→`running`→`generated`へ決定論的に進めるが、自動表示や自動読み上げはしない。ユーザーがExplainまたはShowを実行した時だけ、検証済み`started`、連番chunk、terminal eventを`NarrationController`へ渡す。Git/native/historyへ書き込まず、queryなしpreviewとproduction buildでは生成しない。workspace generation、commit selection、locale、Stopのscope規則もproductionと同じにし、selection/locale/Stopは表示中captionとspeechだけをdismissする一方、生成済みsupport結果はcacheとして維持する。scope更新前のtimer/eventはepoch照合で破棄する。

| composer入力    | 発生する検証用event                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `demo:workflow` | accepted user、running、plan、assistant delta、tool、file、diff、native decision。Other/Hold回答後にapprovalへ進む |
| `demo:approval` | 既知command approval。Approve once、Reject、Stopだけを表示する                                                     |
| `demo:unknown`  | 未知approval相当を`CODEX-PROTOCOL-UNSUPPORTED`としてblockedにし、許可UIを作らずInterruptedへ進む                   |
| `demo:stop`     | runningを維持し、UI Stopからinterrupt terminalを確認する                                                           |
| `demo:crash`    | `CODEX-APP-SERVER-EXITED`とInterruptedを1回だけ出し、turnを再送しない                                              |

Addはabsolute pathを持たない固定opaque attachment handleを返す。demoのsemantic eventもproductionと同じHIST validatorを通るため、private path、未知change kind、invalid approval contextを追加するとcompositionがfail closedになる。

2026-07-18の旧WebView gateでは1470×956、960×900、480×900 CSS pxで横overflow 0、ja/en即時切替、Ctrl+Tab、Shift+Ctrl+Tab、⌘K compact filter、⌘↵ send/answer、OS reduced motion、stream→tool/file→Other/Hold→approval、Approve/Reject、unknown blocked、Stop、crash後1秒間のevent count不変を確認した。この記録は480pxを含むbrowser-onlyの過去証跡であり、実Tauri desktop QAの代替にはしない。検証画像は`/tmp`だけに保存し、repositoryへ含めない。

同日のCommit説明gateでは、通常クリックでCommit tabを維持したままcaptionを共通overlayへ表示し、main history件数が1から増えないことを確認した。1470×836では3 chunkが全てviewport内かつfrontmostで、960×700のoverlayは右端942・下端682、480×800では右端468・下端788に収まり、狭幅でも全3 chunkが完全表示かつfrontmostだった。Audio設定を保存した再読上げは`speechStatus=queued`へ進み、commit選択、locale変更、ChatのStopはいずれも表示中captionを閉じた。元commitのprepared cacheは再選択後のExplainで待ち時間なく新しいselection versionへ再bindされ、再提示できた。検証画像は`/tmp`だけに保存し、repositoryへ含めない。

### Native process fixture

`src-tauri/tests/fixtures/fake_codex_app_server.py`は`--version`、schema生成、stdio app-serverを実装したtest executableである。`CODING_WIFE_CODEX_FAKE_MODE`で次を選ぶ。

| mode                                     | 検証内容                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `setup_probe`                            | setup probeがschema/account/config/modelを呼ばずstable initializeだけで完了する                 |
| `lifecycle_cache`                        | 重複connect、workspace切替でversion/schema/process/initialize回数を構造検証する                 |
| `fragmented`                             | 分割JSONL、handshake、固定turn contract、interrupt                                              |
| `out_of_order`                           | 応答順変更、ID相関、timeout後の非再送                                                           |
| `malformed`                              | 正常応答と同じreadへ入る不正frame、duplicate response                                           |
| `unknown_request`                        | 未知server requestへのerror応答とturn interrupt                                                 |
| `crash_after_ready`                      | ready後crash、bounded restart、turn非再送                                                       |
| `protocol_after_ready`                   | malformed JSONL後の3回/60秒bounded restart、turn非再送                                          |
| `experimental_rejected`                  | 新processでstable initializeへfallbackし、experimental fieldを送らずreviewをwire前block         |
| `thread_policy_*`                        | model、cwd、approval policy、sandbox、ephemeralの各mutationをfail-stop                          |
| `attachments`                            | attachment-only turnを`localImage`と`mention`へ安全に変換し、raw pathを公開しない               |
| `native_rui`                             | strict 1問/2 optionのserver requestとtyped response round trip                                  |
| `decision_fallback` / `decision_invalid` | exact decision card化、structured continuation、自由文interrupt                                 |
| `decision_continuation_crash`            | fallback継続開始中のchild crashをterminal failureにし、自動再送しないこと                       |
| `schema_malformed`                       | 成功probe後のschema失敗で以前のidentity/capability証跡を消去し、fresh connectで回復             |
| `support_invalid_output`                 | strict schemaに違反するcommit説明を結果として公開しない                                         |
| `support_plan_call`                      | wire非広告のinternal `update_plan` eventをpolicy違反としてinterruptし、partial resultを破棄する |
| `support_slow`                           | 実行中support turnをcancelし、interrupt terminalだけを受理して結果を破棄する                    |

fixtureは秘密、実account、実path、promptを含めない。新しいprotocol edge caseはproduction parserを緩める前にfake modeまたは共有fixtureへ追加する。

`src-tauri/src/codex/process.rs`のprocess-tree unit testは`--test-threads=1`で実行する。fixtureまたはgroup cleanupを変更した時はcancel試験を最低10回連続で通し、各回のproduction cleanup assertion後と全実行終了後に`codex_process_tree_fixture.py` process、process group、`coding-wife-process-tree-*` state fileが0件であることを確認する。さらに、収束直後に同じ数値PGIDが無関係groupへ再利用されたmodelで、guard Dropがsignalを0回にすることを確認する。panic-safe guardは失敗時のhost cleanup専用であり、production cleanupのdeadline、error、assertionを緩和する理由にしない。

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
- Codex release、canonical generated schema、wire tool-absence boundary、permission profileのいずれかを変える場合は、support capacityを先に0へ戻し、native preflightとmalicious canaryのrelease evidenceを再取得する。
