---
title: "ワークスペース履歴ランタイム実装ガイド"
description: "ローカルSQLite履歴、ワークスペース復元、Project ID-scoped Project context、pack ID-scoped Character context、native context取得、WebView adapterを安全に変更・検証するための責務と不変条件。"
updated: 2026-07-20
read_when:
  - "ワークスペースの追加・選択・下書き・タイムライン・履歴削除を変更するとき。"
  - "SQLite migration、破損復旧、Git preflight、context snapshotのprivacy境界を検証するとき。"
  - "Project / Character contextの保存、競合、次turn反映、App / Workspace settings UIを変更するとき。"
---

# ワークスペース履歴ランタイム実装ガイド

## 適用仕様

上位要件は[ワークスペース・セッション](../requirements/workspace-sessions.md)と[アクティビティ履歴](../requirements/activity-history.md)、現行画面契約は[S-001](../screen-design/S-001_session-dashboard.md)、[S-002](../screen-design/S-002_coding-workspace.md)を正本とする。[S-006](../screen-design/S-006_project-settings.md)は廃止履歴としてのみ参照する。

履歴ランタイムは、macOSのapp-private data directoryに置く`workspace-history.sqlite3`を正本とする。WebViewはraw pathやSQLiteを直接扱わず、version 1のTauri commandとexact-key TypeScript parserを経由する。ブラウザー実行時の`DemoWorkspaceHistoryTransport`は操作確認用の決定的なメモリ実装であり、永続化済みとはみなさない。

## 実装上の不変条件

1. canonical repository pathとGit metadata pathはRustのapp-private linkage recordだけに保存する。public response、event、diagnostic、error、WebView stateへ絶対pathを出さない。
2. project登録はnative folder picker、Git preflight、DB transaction、Codex supervisor登録、active selectionの順に行う。後段が失敗した場合はDBとsupervisorをrollbackし、片側だけに登録を残さない。
3. `.git` markerと`HEAD`はregular non-symlink fileだけを許可する。current userまたはroot所有かつowner-writableで、group/world-writableなmetadataを拒否する。linked worktreeの外部gitdirは同じ検査を通す。
4. 起動復元では保存済みidentityを再検証する。repositoryの消失、identity変更、権限不足をそれぞれ`missing`、`changed`、`unreadable`として残し、履歴を削除したり自動実行したりしない。
5. eventはworkspaceごとの単調増加sequenceで追記し、同じevent IDの再送は冪等に扱う。CODE eventはexact versioned semantic payloadを保存し、live/reload共通projectorでstable ID・sequenceを保つ。unknown/invalid payloadをgeneric history rowへ近似しない。既存eventを訂正目的で更新しない。
6. draftはworkspace単位かつrevision付きで保存する。WebView adapterは同じworkspaceへの書き込みを直列化し、revision conflict時だけ最新値を再取得して1回再試行する。
7. 保存前にsecret、credential、private rootをredactする。raw reasoning、raw protocol payload、生成音声、support prompt/responseをschemaへ追加しない。
8. event payloadは256 KiB、context snapshotは1 MiB、context保持数はworkspaceごとに最新10件、timeline pageは最大200件、workspace一覧は最大200件とする。上限を緩める場合はSQLite、IPC、UIの負荷試験を先に追加する。
9. contextのlabelと本文はWebViewから受け取らない。`files`はtrusted rootで`git ls-files`、`git_diff`はexternal diffとtextconvを無効化したread-only Git commandからRustが生成する。`terminal_output`は信頼できるproducerが実装されるまで構造化errorで拒否する。
10. 履歴削除はUI確認の後にnative challenge tokenを発行し、対象workspaceのapp metadataだけをtransactionで削除する。repository file、commit、branchを変更しない。
11. migrationはtransaction内でversion順に適用し、既存versionのSQLを書き換えない。破損またはmigration失敗時は元DBを上書きせず、basenameだけをpublicに返すrecovery backupとread-only状態を使う。
12. 履歴adapter単体はCodex接続を推定しない。通常起動ではCodex composition層が`CodexDiagnostic`とcapability/model/effortを正本に送信可否を導出し、固定`connected=false`を公開しない。履歴の利用可否は引き続き`history.mode`とタイムラインのbadgeで別に表示し、履歴writerが`ready`でない時は新規turnを開始しない。
13. editableなProject / Character contextは、native producerが作るread-only Files / Git diff snapshotとは別recordである。ProjectはSQLite migration version 10の`project_contexts`へProject ID、Characterはmigration version 11の`character_contexts`へopaque pack IDをpartition keyとして保存する。同じprojectの全workspaceはProjectを共有するが、Characterのversionと未保存draftはpack間で共有しない。旧workspace Project値はmigration時に`last_selected_at DESC, updated_at DESC, workspace_id ASC`でprojectごとに一つだけ選び、workspaceがないprojectには空recordを作る。migration version 9のapp-global Character値はbundled Hiyoriへ一度だけ移す。利用者が編集済みのJSON、version、hashは保持し、旧factory defaultの`Sol`とその既知hashが完全一致するrecordだけは、versionを維持したまま編集可能な桃瀬ひよりpresetとそのcanonical hashへ置換する。fresh databaseも同じ経路でHiyori presetを持つ。
14. editable context保存は`expectedVersion`の一致をSQLite transaction内で検証し、成功時だけversionを1増やしてcanonical JSONのSHA-256を更新する。競合時はremote versionを読み直すがlocal draftを維持し、利用者が「保存済みバージョンを再読込」を選ぶまで上書きしない。Definition of done、技術参照、禁止表現は入力中のraw multiline draftを保持し、blurまたは保存時だけtrim、空行除去、改行正規化を行う。
15. Sendは入力確定後かつCodex turn開始前に、owner-only character libraryから選択pack IDと表示名を解決し、同じread transactionでactive workspaceが属するProject IDのProjectと選択packのCharacterのversion、hash、内容を一度だけ取得する。`running` / `waiting`中の保存またはpack選択を既存requestへ途中注入せず、次のSendだけが新versionとpackを使う。Project snapshotのProject IDがactive workspaceのProject IDと一致しない場合はturnを開始しない。
16. Codexへ渡すprivate request textと、timeline / objectiveへ残すpublic instructionを分離する。private textはversion/hash付きJSON envelopeを含む完全な直列化後の値で80,000 Unicode scalarを上限とし、public instructionとdraftは32,000を維持する。context JSONは`CODING_WIFE_UNTRUSTED_CONTEXT_V1`と明示したquoted data境界へ置き、permission、approval、safety、verification、tool、model、Git policyの権限を持たせない。その後に`CODING_WIFE_AUTHORITATIVE_USER_INSTRUCTION_V1`として利用者の指示を置く。上限はProject 32,000 + Character 12,000の単純加算ではなく、JSON escape、metadata、marker、public instructionを含む最終envelopeへ適用する。
17. Characterの自由入力は技術・安全policyを変更できない。NFKC、case、句読点を正規化し、表示文言・結果・error・実行中の発話状態などpresentation clauseとして明示的に分類できる部分を除いた後、permission、approval、verification、tool等のpolicy-domain objectが残れば、命令・同義語・説明文の別を問わずRustとTypeScriptの両境界でfail-closed拒否する。共通corpus `src/test/fixtures/workspace-context-policy.v1.json`のja / en accepted・rejectedケースを両実装で通す。
18. 技術参照は`doc:`を除きtrusted repository rootからの相対pathだけを受理し、`.`や重複separatorを保存前にcanonicalizeする。native保存時は参照の存在、各symlink componentのroot内解決、rootとtargetのdevice / inodeを検証し、migration version 3のprivate `project_reference_manifest_json`へidentityを保存する。Send snapshotは同じtransaction内で再検証し、参照の消失・置換、symlink retarget、repository root交換を検知したらturnを開始しない。旧recordは自動で信頼せず、技術参照がある場合は利用者の明示再保存でmanifestを作る。
19. UIのvalidation errorはsection alertだけで終えず、fieldとreasonの構造化情報を保持する。対象fieldに`aria-invalid`と`aria-describedby`を設定してfocusを戻し、fieldを特定できないerrorはsection headingへ戻す。競合後の「保存済みバージョンを再読込」もsection headingへfocusを移し、更新されたversionを読み上げ可能にする。
20. Project登録解除はworkspace-history operation lockの後にCharacter select/deleteと共有するproject operation lockを取得する。active Projectのselectionを履歴DB更新前に削除し、DB失敗時はselectionとCodex workspace activationをrollbackする。登録解除済みProjectはCharacter resolverで解決せず、再起動時にもorphan selectionを削除する。登録解除は履歴本文、context source、repository file、commit、branchを変更しない。

## ファイル責務

| ファイル | 責務 |
|---|---|
| `src-tauri/src/workspace_history/store.rs` | SQLite schema、migration、transaction、redaction、pagination、delete challenge、recovery |
| `src-tauri/src/workspace_history/editable_context.rs` | Project / Character contextの境界、technical policy拒否、canonical hash |
| `src-tauri/src/workspace_history/service.rs` | pickerから選択までのatomic orchestration、起動復元、trusted-root context取得 |
| `src-tauri/src/workspace_history/commands.rs` | WebViewへ公開するtyped Tauri command |
| `src-tauri/src/workspace_history/types.rs` | version 1 DTO、serde exact field contract、public/private境界 |
| `src-tauri/src/codex/workspace.rs` | Git worktree、owner、permission、identity preflightとtrusted root管理 |
| `src/lib/contracts/workspace-history.ts` | response/errorのexact-key parserとrequest/response map |
| `src/lib/contracts/workspace-context.ts` | editable context、versioned record、turn snapshotのexact parserとWebView境界 |
| `src/features/workspace-persistence/transport.ts` | Tauri invoke envelopeとcontract boundary error |
| `src/features/workspace-persistence/adapter.ts` | persisted stateのUI projection、draft queue、context、二段階削除 |
| `src/features/workspace-persistence/turn-context.ts` | immutable snapshotとpublic instructionを80,000 scalar以内のprivate turn envelopeへ合成 |
| `src/features/workspace-persistence/codex-event-projector.ts` | versioned HIST CODE payloadからsemantic timelineへのexact fail-closed再構築 |
| `src/features/codex/workspace-session-adapter.ts` | Codex diagnostic/thread/turn/eventと履歴adapterを通常S-002へcompositionし、送信可否を導出 |
| `src/features/codex/event-projection.ts` | generationで分離されたCodexEventをsemantic timeline/HIST eventへfail-closed投影 |
| `src/features/workspace-persistence/demo-transport.ts` | ブラウザー専用の決定的demo。native成功や再起動永続化を偽装しない |
| `src/features/workspace-view/useWorkspaceViewModel.ts` | hydration、workspace切替race防止、250 ms draft debounce、UI notice |
| `src/features/workspace-view/useEditableSettingsContext.ts` | Project ID-scoped Project draftとpack ID-scoped Character draft、save、競合保持、明示reload |
| `src/features/workspace-view/EditableContextSection.tsx` | Project / Character editor、field境界、次turn表示、error focus。Projectではversion/hashを表示し、Character detailでは技術metadataを表示しない |
| `src/features/workspace-view/SettingsView.tsx` | S-005の5 sectionとProjects内のProject ID-scoped detail、Character内のpack ID-scoped detailを構成する |
| `src/features/workspace-view/WorkspaceShell.tsx` | Chat / Commitの2 tab、sidebar gearのS-005遷移、project / character detail selection、直前tabとfocusの復元を所有する |
| `src/test/fixtures/workspace-context-policy.v1.json` | RustとTypeScriptで共有するCharacter policyのja / en accepted・rejected corpus |
| `src/test/fixtures/workspace-history.v1.json` | RustとTypeScriptが共有するpublic contract fixture |

## 通常gate

```text
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml workspace_history --lib
pnpm exec vitest run src/features/workspace-persistence/*.test.ts src/features/workspace-view/WorkspaceShell.test.tsx src/app/App.test.tsx
pnpm exec vitest run src/features/localization/localization.test.tsx src/app/App.character.test.tsx
pnpm exec vitest run src/lib/contracts/workspace-context.test.ts src/features/workspace-view/useEditableSettingsContext.test.tsx
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Rust testはmigration rollback、破損backup、concurrent sequence、redaction、context上限、起動復元、linked worktreeに加え、editable contextの再起動復元、Project ID共有、pack間のCharacter分離、選択packのturn snapshot、旧Character値の移行、factory defaultからHiyori presetへの置換、expected-version競合、shared policy corpus、参照の消失・置換、symlink retarget、root交換、旧workspace recordの決定的集約を検証する。TypeScript testはexact contract、raw list draft、blur / save正規化、field error focus、project追加、session作成、project detail、pack別Character draft、context、削除、fresh adapterでの再hydration、次turnの信頼境界付きenvelope、競合時のdraft保持を検証する。`WorkspaceShell.test.tsx`はworkspace headerがChat / Commitだけを表示し、sidebar gearがS-005だけを、project rowとcharacter rowがそれぞれ同sectionのdetailを開き、bundled Hiyori presetを編集・保存でき、Back後に直前tabとfocusを復元することも検証する。Demo transportのhash testはRustと同じcanonical JSONの既知SHA-256を比較し、表示用の疑似hashへ戻らないことを保証する。UIを変更した場合はWebdriverIOで実Tauri windowを操作し、Chat / Commitの2 tab、Projects / Character一覧からdetailへの遷移、project / packごとのdraft、同Project ID workspaceでの共有、Back後のfocus復元、入力中とblur後のlist値、保存後の反映、ja / en、validation・競合時focus、1470×836 / 1280×800 / 960×640を確認する。screenshotは`/tmp`またはignore済み`tmp/desktop-qa/`へ保存する。

## 変更時チェックリスト

- command fieldを変更するときはRust DTO、TypeScript contract、共有fixture、transport testを同時に更新する。
- schemaを変更するときは新しいmigration versionを追加し、失敗時rollbackとN-1 backupのtestを追加する。
- 新しいevent producer/kindはallowlist、payload schema、redaction、oversize、duplicateのtestを先に追加する。
- public DTOへpathらしいfieldを追加しない。必要なfilesystem操作はopaque workspace IDをRustでtrusted rootへ解決する。
- context sourceを追加するときは利用者入力の本文を保存せず、native producer、サイズ上限、secret fixture、失敗時の構造化errorを用意する。
- draft保存失敗やworkspace切替失敗で別workspaceのdraft、timeline、selectionを上書きしない。
- editable context commandを変えるときはProject / pack別Characterの別version、exact expected-version transaction、workspace-bound Projectとnativeで解決した選択packのCharacterを合成するturn snapshotを同じ変更で検証する。
- list fieldを変えるときはraw draftを配列へ即時変換せず、blur / save境界でだけ正規化する。validation codeを増やす場合はfield / reason mapping、ja / en copy、`aria-describedby`、focus testを同時に更新する。
- Character policy検出を変えるときはTypeScriptとRustの実装を別々に推測で直さず、先に共有corpusへaccepted / rejectedケースを追加して両方を実行する。presentation例を誤拒否しない回帰caseも残す。
- 技術参照またはtrusted rootのidentity規則を変えるときはmigrationを追記し、save時captureとsnapshot時revalidationを同時に更新する。public DTO、content hash、snapshot hashへprivate device / inodeを含めない。
- private turn envelopeをtimeline、objective、draft、support evidenceへ保存しない。80,000 scalar上限を変える場合はfrontend composerとnative Codex supervisorの境界testを同時に更新する。
- recovery modeでwrite commandを成功扱いせず、backupの絶対pathをWebViewへ返さない。
- Demo transportへnative filesystem、Codex成功、永続化成功を示す挙動を追加しない。
