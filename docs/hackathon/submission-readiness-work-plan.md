---
title: "Coding Wife 提出準備完了までの作業計画"
description: "現行実装から全デモ機能、macOS配布物、審査導線、Devpost提出証跡までを依存順に完了させる実行計画。"
updated: 2026-07-20
read_when:
  - "残存するアプリ機能の実装順、コミット単位、完了条件を確認するとき。"
  - "OpenAI Build Week提出前のGo/No-Go判断、配布物、審査導線、外部依存を確認するとき。"
---

# Coding Wife 提出準備完了までの作業計画

## 目的と基準点

この計画は、全デモ機能が動き、審査員が配布物で主要導線を再現でき、提出証跡がそろうまでの実行順である。

- 作業開始HEAD: `5d1e7b6`
- 関連する承認済み仕様: `056000f`
- 計画日: 2026-07-18 JST
- 内部提出期限: 2026-07-21 23:00 JST
- 公式提出期限: **2026-07-22 09:00 JST**
- 対象: 残存アプリ機能、非機能要件、macOS release、英語審査導線、動画、Devpost、提出証跡
- 非対象: 既存Git履歴のrevert、undo、rewind、書き換え。基準点以降は前進する追加コミットだけで閉じる。

この文書でいう「完了」は、コードが存在することではない。実装者テスト、`agent-browser`によるUI QA、repository全体の品質ゲート、実配布物の起動確認、審査アクセスの証跡がすべて成立した状態を指す。現時点をproduction-readyまたはsubmission-readyとは扱わない。

独立レビューは締切までの工程から**一時的に除外**する。独立レビューを待たない一方で、実装者による自動テスト、race/error test、`agent-browser` UI QA、native smoke、lint/typecheck/test/buildなどの品質ゲートは省略しない。

## 現在の完了境界

`5d1e7b6`では次の基盤が成立している。ただし、以下は残存作業やfinal artifactの実証を含まないため、最終production readinessの宣言ではない。

| 領域 | 現在の完了境界 | 残る境界 |
| --- | --- | --- |
| 主画面 | demoのsidebar、header、Chat、Commit、Settings、Character、composerを含むmain layoutがある。Project / Character contextはApp Settingsへ集約し、workspace側には専用tabを置かない。desktop、compact/tablet、実効480pxでも主要領域へ到達できる。 | 全操作の実接続、bilingual/accessibility、installed-appでの最終QAが必要。 |
| Live2D | defaultのライセンス許諾済み`tmp/hiyori_pro`由来Hiyoriを同梱し、custom modelの検証、隔離、preview、publish、選択、削除の主要経路がある。 | semantic state mappingとapp-global selection、final artifactでの再起動確認が必要。 |
| Workspace/Codex/history | workspaceの追加・作成・選択、Codex接続、draft、SQLite timeline/historyの基盤がある。 | cancel/repair/unregister、active-turn切替、終了、summary/anchor、branch/missing recoveryが必要。 |
| Git evidence | Commit画面にread-onlyのコミット証跡を表示できる。アプリはコミット、revert、undoを提供せず、sourceやGit refを書き換えない。 | support presentation raceを閉じ、read-only契約を全error pathでも維持する必要がある。 |
| Commit Skill | main sessionの各turnへcommit Skillを注入する経路がある。 | turn/workspace切替後も正しいscopeだけが有効であることをrace testで固定する必要がある。 |
| Support runtime | App Server streamとtrusted Git commit terminal proofをinterceptする、アプリ所有の隔離support runtimeがある。main sessionのsubagentではなく、main session履歴へsupport本文を保存しない。 | scope single-writerとexplicit presentation intentを完成させる必要がある。 |
| Caption/TTS | 「詳しく教えて」からcharacter captionを表示し、設定時だけ同一文を任意TTSで読む経路がある。caption visible/frontmost acknowledgementがspeechより先に来る。 | 一度目の操作、cache、late event、Stop/Close、demo/production parityを固定する必要がある。 |
| Context | Project/Character Contextの編集sliceが画面にある。 | versioned native保存、conflict、technical-policy rejection、next-turn snapshot合成が必要。 |
| 配布 | release `.app`を生成する基盤とFinder非依存DMG scriptsがある。 | production demo分離、全resourceのad-hoc seal、正規化inventory検証、最終HEADからの`.dmg`生成、実mount/launch、fresh-profile smokeが必要。 |

## 利用者が固定したSupport挙動

この節は実装中に変更しないproduct contractである。

1. Commit画面はread-only evidence viewerである。コミット、revert、undo、checkout、reset、Git ref変更を置かない。
2. 「詳しく教えて」は、アプリ所有のbackground support generationを開始または既存jobへ合流させる。main sessionのsubagentは起動しない。
3. 明示操作後の結果はcharacter captionで提示する。TTSは任意かつ既定offで、captionと同一の文だけをcaption表示確認後に読む。
4. Stopは現在のpresentationだけをdismissする。support jobもgenerated cacheも**絶対にcancelまたは削除しない**。
5. selection、locale、workspace、Stop、Closeはpresentation intentだけを失効させる。失効後のlate eventはoverlay、live region、TTSを再開しない。
6. Closeでapp自体を終了するときのruntime cleanupは行うが、それをStopのsupport-cancelへ流用しない。

## 実行原則と依存順

### 要件から実装まで

すべての残存機能は、次の順序を守る。

```text
承認済み要件を確認・不足だけ追記
  → ja/en、状態、error、focusを含む画面設計を確定
    → typed contract / schema / migration
      → native implementation
        → frontend composition
          → tests / agent-browser / native smoke
```

- 実装中に仕様差分が見つかった場合は、先にrequirements、次にscreen designを更新してからコードへ進む。
- `056000f`を関連仕様の基準とし、既存contractをコード都合で弱めない。
- 最初にすべてのdemo-visible behaviorを完成させる。そのDone後に、release hardening、詳細な非機能改善、提出資料のfinalizationへ進む。
- 各実装コミットは、その変更のunit/integration/race/error testを同じコミットに含める。後工程へテスト負債を送らない。
- 1コミットは1つの記載済みunitだけを扱う。別unitの便乗修正、既存履歴のrevert/undo、生成物の無差別追加をしない。
- 各unit開始前にfree diskを確認し、build、DMG mount、screenshotはignore済み`tmp/`または`/tmp`を使う。成功証跡を保存した後は中間`.app`、展開コピー、mount、重複cacheを削除し、final artifactと必要なlogだけを残す。

### 並列化の境界

- requirements確定とscreen design確定は全実装の共通dependencyであり、並列実装より先に閉じる。
- 仕様確定後、Commit explanation、Context、Workspace actions、Settings persistenceは、共有contractを変更しない範囲で並列化できる。
- 同じGit review adapter/runtimeを触るscope writerとpresentation intentは競合しやすいため、順番に統合する。
- active-turn switchingはworkspace lifecycle primitivesへ依存し、safe quit/single-instanceはactive-turn terminalizationへ依存する。
- Diagnosticsはnative preference/readiness sourceへ依存する。session health recoveryはrepair primitivesへ依存する。
- Live2D project scopeはproject identityとmigration方針へ依存する。
- 英語READMEの骨子、動画台本、Devpost草案は内部で並列準備できるが、機能名・model ID・画面を確定するfinal edit/recordingはdemo-visible feature freeze後に行う。
- GitHub招待、YouTube公開、Devpost保存/送信などの外部writeは、最終段階で利用者の明示的な権限付与を得るまで実行しない。

## 残存機能の実装契約

### 1. Commit explanation composition

- Native scope writeはApp lifetimeで単一writerにする。連続するdesired scopeをcoalesceし、常にlatest desired workspace/generation/localeだけを適用する。
- 逆順completionが構造上発生しないよう直列化するか、発生してもlatest desired scopeの適用完了までevent gateを閉じる。
- A→Bのscope requestとB→A completionを模擬しても、frontend/nativeの最終scopeはB、stale A eventは0件にする。
- explicit presentation-intent epochを単一所有し、request、present、native event、activation、dismissの全経路で検査する。
- generated cache hitは「詳しく教えて」の一度目の操作で即時表示する。
- `user_request`と`user_retry`はpresent-on-complete intentを持つ。新規job、既存queued/runningへのdedupe合流、受理済みchunkのいずれでも一度目の操作を失わない。
- productionの`auto_verified_commit`はbackgroundでgenerate/cacheするだけで、presentation event、caption、live region、TTSを開始しない。
- selection、locale、workspace、Stop、Closeはjob/cacheを維持したままintent epochをrevokeする。
- revoke後のlate state/chunk/presentation eventは画面を再openせず、再度の明示操作だけが新しいintentを発行する。
- demo runtimeとproduction runtimeで、state、button、cache、present-on-complete、dismissの意味を一致させる。
- TTS off/on両方で、明示操作前のactivation/speechが0件、操作後だけcaptionと同一textを読むことを固定する。

### 2. Contextのversioned next-turn slice

- Project ID-scoped Project Contextとapp-global Character Contextを別schema、別versionとしてnative SQLiteへ保存する。
- typed IPC、migration、size limit、validation、expected-version transaction、conflict/reload UXを先に確定する。
- Project Contextはgoal、constraints、Definition of Done、technical references、user notesを扱う。
- Character Contextはdisplay name、tone、speech density、behavior、prohibited expressionsを扱う。
- technical policyやsystem policyを上書きしようとするkey/contentはfail closedで拒否し、安全なlocalized errorを返す。
- Context画面とSettings内のContextは同じnative source of truthを編集する。
- 保存済みversionとhashは次のmain turnのvalidated request snapshotへ含める。running turnへ途中注入しない。
- restart、workspace/project isolation、version conflict、invalid size、prohibited key、next-turn-onlyを統合testで固定する。

### 3. Workspace lifecycle、active turn、app lifecycle

- Workspace actionsへ状態に応じたCancel、repository再選択/repair、app登録解除を追加する。
- Cancelは必要ならactive turn停止を確認してからCanceled groupへ移す。source、working tree、Git ref、history本文を変更しない。
- unregisterはrunning turn中に実行せず、二段階確認後にapp metadataだけを削除する。
- missing、changed、unreadable、read-only、stale branchをtextとiconでrow/headerへ表示し、repair導線を置く。
- active/pending turnを持つworkspaceからの切替は、「停止して切替」と「戻る」の確認を必須にする。
- 「戻る」はselection、turn、draft、caption/TTSを不変にする。「停止して切替」はterminal interruptとcleanup完了後だけ次workspaceをactivateする。
- single-instanceを実装し、二重起動時は新規runtime/windowを増やさず既存windowをfocus/raiseする。
- idle closeは通常終了する。running closeは「停止して終了」と「終了しない」を提示し、後者はwindow/turnを保持する。
- 終了時はCodex process group、audio、support controller、pending DB writer/transactionを期限内に閉じる。crash後のunfinished turnはInterruptedとして復元し、自動再送しない。
- rapid switch、stale response、interrupt failure、double launch、close cancel、process cleanup、focus restorationをtestする。

### 4. Settings、Diagnostics、session continuity

- `AppPreferencesV2`はlocaleだけをtyped native schemaへ保存し、restart後に復元する。V1からはlocaleだけを移行し、旧reduced-motion overrideとcharacter visibilityは破棄する。
- reduced motionはOSの`prefers-reduced-motion`だけを尊重し、characterはChatとCommitで常時表示する。App settingsに両controlを置かない。
- preference reset commandとReset UI state操作をproductionへ含めない。
- corrupt/missing schemaはfail closedでdefaultへ回復し、sanitized codeとRetryを表示してja/enを即時反映する。
- DiagnosticsはOS、app/build/schema、Codex binary/auth/model/schema、Git、DB、Live2Dのreal native readiness sourceを表示する。
- 各diagnosticはstatus、checked time、安全なerror code、recovery actionを持つ。absolute path、token、raw stderrを表示・copyしない。
- RecheckとHistory badgeは同じnative sourceを再評価する。
- workspace-scopedのlast summary、timeline anchor ID/sequence/offsetを保存し、restartとpagination後に復元する。anchor消失時はnearest valid sequenceへ補正する。
- window focusとSend前にrepository identity/HEAD/healthを再検査し、external branch変更をstale warningとして示す。
- missing repositoryでもhistoryを保持し、repairまたはunregisterを選べる。他workspaceは継続利用できる。
- 20 workspace、restart、old event/audio/error isolation、branch change、missing/changed recoveryをtestする。

### 5. Live2D semantic stateとproject scope

- character selectionの正本をworkspaceではなくProject IDへ移し、既存selectionをdeterministicにmigrationする。
- 同じprojectの複数workspaceは同じcharacter selectionを共有する。
- pack inventory内のexpression/motion cueだけを候補にするversioned semantic mappingを追加する。
- neutral、thinking、working、asking、success、warning、errorなど承認済みsemantic stateをcueへ割り当て、未割当またはinvalid cueはneutralへfallbackする。
- mapping UIはja/en、keyboard、focus、preview、reduced-motion static previewに対応する。
- invalid cue、expressionが0件のpack、restart、同一project内複数workspace、selected modelのdelete protectionをtestする。
- 既存のquarantine、hash、trusted first-frame attestation、atomic publish、opaque asset IPCを弱めない。

## 横断受け入れマトリクス

すべてのdemo-visible implementation unitは、該当する行を同じコミットで検証する。最終統合時に全行をもう一度実行する。

| 観点 | 必須受け入れ条件 |
| --- | --- |
| ja/en | 新規label、dialog、notice、error、ARIA名を両言語で提供し、locale切替で即時反映する。restart後も選択を復元し、切替前のlate eventを表示しない。 |
| Keyboard/focus/ARIA | pointerなしで全主要導線を完了できる。dialog focus trap、cancel後のfocus restoration、visible focus、正しいrole/name/state、icon-only controlのaccessible nameを確認する。 |
| Caption/TTS | 明示intent後だけcaptionを表示し、optional TTSは既定off、同一text、caption acknowledgement後に開始する。Stop/selection/locale/workspace/Close後のlate speechは0件。 |
| Privacy/security | support本文をmain session/historyへ書かず、secret、token、absolute private path、raw stderr、PIIをUI/log/evidence/videoへ出さない。Commitとworkspace lifecycleはsource/Git refを変更しない。 |
| Offline/error | Codex auth/model failure、network offline、TTS unavailable、repository missing/read-only/changed、DB corruption、Live2D invalid pack、timeout/quotaを安全なlocalized errorとrecoveryへ落とす。主要historyは保持する。 |
| Performance | 200 workspaceでfilter/selectionの承認済みp95、Live2D first frame/FPS/input latency、caption latency、close cleanup deadlineをrelease artifactで測定し、長時間runでもlistener/process/cacheが増殖しない。 |
| Responsive UI | `agent-browser`でdesktop 1470×836、tablet/compact 960×640、幅480の画面を確認する。横欠け、到達不能control、caption overflow、dialog clippingを0件にする。 |
| Native-only | picker、SQLite restart、process cleanup、single-instance、TTS、`.app` launchなどbrowserでは代替できない項目を実Tauri appで確認する。 |

## フェーズ別チェックリストと正確なコミット単位

以下のsummaryを各コミットの1行目として使う。実装コミットには対応testを含め、本文には変更、意図、検証結果を英語のphysical lineごとのbulletで記録する。

### Phase 0 — Requirementsとscreen designを固定する

- [ ] **C01 `docs(requirements): lock remaining submission contracts`**
  - Depends on: `056000f`
  - Scope: support presentation intent、Context persistence、workspace/app lifecycle、preference/diagnostics、session recovery、Live2D project scope、release acceptanceの不足だけをrequirementsへ追記する。
  - Parallel: 不可。全実装の共通gate。
  - Done: state、trigger、scope、error、privacy、persistence、ja/en、performanceのnormative behaviorに曖昧語がなく、実装を先行していない。

- [ ] **C02 `docs(screen-design): align final demo-visible flows`**
  - Depends on: C01
  - Scope: Commitのbackground/explicit presentation、Context、Workspace actions/確認dialog、Settings/Diagnostics、repository health、Live2D mappingの画面状態とcopyを一致させる。
  - Parallel: 不可。C01後。
  - Done: happy/loading/empty/error/disabled/recovery、ja/en、keyboard order、focus return、ARIA/live regionが定義され、background generationだけでcaptionをstreamする古いcopyが残っていない。

### Phase 1 — Demo-visible behaviorを完成させる

- [ ] **C03 `fix(git-review): serialize commit explanation scope updates`**
  - Depends on: C02
  - Parallel: Context/Workspace/Settings系列とは可、C04とは不可。
  - Done: single-writer/coalescing/latest desired、rollback rejection、dispose中pending、A→B reverse-completion raceのtestがgreenで、stale eventが0件。

- [ ] **C04 `fix(git-review): require explicit presentation intent`**
  - Depends on: C03
  - Parallel: 他系列とは可。
  - Done: cache即時表示、`user_request`/`user_retry` present-on-complete、`auto_verified_commit` generate-only、全revoke event、late-event rejection、demo parity、TTS off/on testがgreen。

- [ ] **C05 `feat(context): persist versioned project and character context`**
  - Depends on: C02
  - Parallel: Commit/Workspace/Settings系列と可。
  - Done: schema/migration/typed IPC/validation/expected-version conflict/UI再読込/restart/isolationがgreenで、technical-policy overrideを拒否する。

- [ ] **C06 `feat(context): apply context snapshots to the next turn`**
  - Depends on: C05
  - Parallel: C07以降と可。
  - Done: version/hash付きvalidated snapshotが次turnだけへ合成され、running turnは不変で、main/supportの利用scopeを混同しない。

- [ ] **C07 `feat(workspaces): add cancel repair and unregister actions`**
  - Depends on: C02
  - Parallel: Commit/Settings系列と可。
  - Done: state-aware menu、二段階確認、health表示、repair、focus restorationが動き、source/Git ref/history本文を変更しないnative integration testがgreen。

- [ ] **C08 `feat(workspaces): confirm active-turn transitions`**
  - Depends on: C07
  - Parallel: C10/C11と可。
  - Done: switch保留、戻るの完全不変、interrupt terminalization後の切替、rapid/stale/failure race、caption/audio isolationがgreen。

- [ ] **C09 `feat(app): enforce single instance and safe quit`**
  - Depends on: C08
  - Parallel: C11/C13と可。
  - Done: second launchは既存windowをfocusし、running closeの2択、cancel保持、Stop & Quit cleanup、Interrupted recoveryを実Tauri appで再現できる。

- [ ] **C10 `feat(settings): persist native preferences`**
  - Depends on: C02
  - Parallel: Commit/Context/Workspace系列と可。
  - Done: locale-only V2の保存、V1 locale migration、restart、corrupt/missing recovery、ja/en即時反映、旧display controlとreset commandの不在がgreen。

- [ ] **C11 `feat(settings): report native readiness diagnostics`**
  - Depends on: C10
  - Parallel: C08/C09と可。
  - Done: real Codex/Git/DB/Live2D/app readiness、Recheck、safe code/recoveryが同じnative sourceを使い、secret/private path/raw stderrを出さない。

- [ ] **C12 `feat(sessions): restore summaries anchors and repository health`**
  - Depends on: C07, C08
  - Parallel: C13と可。
  - Done: last summary/anchor restart、nearest sequence補正、20 workspace、focus/Send branch revalidation、missing/changed recovery、old event isolationがgreen。

- [ ] **C13 `feat(live2d): scope character selection and map semantic states`**
  - Depends on: C05のProject ID方針
  - Parallel: C09/C11/C12と可。
  - Done: project migration、versioned mapping、neutral fallback、preview/reduced motion、restart/multi-workspace/delete protectionがgreenで、安全なimport pipelineを維持する。

### Phase 1 Done gate

- [ ] C03〜C13の全unitが統合され、demoに見える無反応button、local-only save、偽diagnostic、暗黙captionが0件。
- [ ] ja/enの主要happy pathとmajor error pathを、desktop、tablet、幅480の`agent-browser`で完走する。
- [ ] 実Tauri appでworkspace作成→main turn→trusted commit evidence→「詳しく教えて」→caption/TTS設定→Context保存→restart→repair/quitを完走する。
- [ ] このgateを通るまで、詳細改善や最終動画撮影へ進まない。

### Phase 2 — 詳細改善とrepository qualityを閉じる

- [ ] **C14 `test(app): cover final bilingual acceptance paths`**
  - Depends on: Phase 1 Done
  - Parallel: C15の調査と可、同じsource変更は分離する。
  - Done: ja/en、keyboard/focus/ARIA、TTS、privacy/security、offline/error、responsive、performance、listener/process leakの統合回帰testとevidence harnessがgreen。

- [ ] **C15 `fix(quality): close deterministic repository gates`**
  - Depends on: Phase 1 Done
  - Parallel: C14と可。
  - Done: format、Rust warnings、process-tree flake、repository-owned diff hygieneを修正し、byte-exact Live2D/Hiyori noticeを改変しない。pnpm production closureとApple Silicon用Cargo runtime closureのversion/source/integrity/license/attributionをoffline生成し、unknown・forbidden・missing・staleをfail closedにして全品質commandを連続再実行できる。

### Phase 3 — 実配布物を完成させる

- [ ] **C16 `fix(release): seal and verify macos distribution artifacts`**
  - Depends on: C14, C15
  - Parallel: 英語README/動画台本の草案と可。
  - Commit 1: `fix(app): exclude demo runtime from production bundles`。Vite development serverの明示`?demoAppServer=1`だけがdemo runtimeをloadし、queryless/native productionはnative adapterを維持する。production `dist`と`.app`で承認済みdemo markerを各0件にする。
  - Commit 2: `fix(release): seal and verify macos artifacts`。nested codeからapp順にtimestampなしad-hoc署名し、全resource sealのstrict検証後だけDMGへ進む。Developer ID署名・Apple公証済みとは分類しない。
  - Done: clean final HEADからsealed `.app`を生成し、それだけをDMG入力にする。別々の2回のread-only mountでroot 2entry、Applications link、sorted app inventoryがsourceと一致する。DMG byte同一性は要求せず、公開するfinal candidateのsizeとSHA-256だけを凍結する。失敗・INT・TERM後のmount、staging、一時directoryが0件で、`scripts/release/verify-macos-release.sh`が正本検証となる。

- [ ] **C17 `docs(hackathon): record installed artifact acceptance`**
  - Depends on: C16
  - Parallel: C18のREADME編集と可。
  - Done: real DMG mount→Applications copy→launch、fresh profileまたはother-Mac-equivalent、Hiyori、picker、Codex preflight、primary turn、caption、restart、quitを記録する。署名・notarizationを完了するか、unsignedならGatekeeper手順とsecurity trade-offを明記する。

### Phase 4 — 審査導線と提出packageを固定する

- [ ] **C18 `docs(readme): add the English judge path`**
  - Depends on: Phase 1 Done, C16
  - Parallel: C17と可。
  - Done: English README冒頭からproblem、solution、選択track、supported platform、fastest judge path、setup/sample/testing、exact GPT-5.6 model IDとcode path/input/output/validation/essentiality、Codex contribution、human decisions/trade-offs、Build Week boundary、third-party noticesへ到達できる。

- [ ] **C19 `docs(hackathon): prepare final submission materials`**
  - Depends on: C17, C18
  - Parallel: 動画編集とDevpost草案を内部で可。
  - Done: 英語description、1 track、repository URL、testing instructions、public `< 3:00` video用台本/shot list、代表`/feedback` Session ID欄、全Devpost field、evidence checklistがcurrent buildと一致する。

- [ ] **C20 `docs(hackathon): record final submission evidence`**
  - Depends on: 利用者の明示権限、外部操作完了、C19
  - Parallel: 不可。最終stateの記録。
  - Done: 招待acceptance、匿名/審査者相当repo access、public video playback、submission URL、Session ID、final commit/artifact checksum、submit confirmation、timestamp付きscreenshotを記録し、secret/private dataを含めない。

## Repository品質ゲート

C15以降の候補HEADでは、次の正本手順だけをclean worktreeから通す。`pnpm quality:check`はdirtyな開始・終了を拒否し、個別commandはpartial validationにだけ使う。1つでもfailまたはflakeしたらreleaseへ進まない。

```bash
git status --short
pnpm quality:check
git status --short
```

正本sequenceには、offline dependency-license gateとrepository-owned diff hygieneを含める。diff hygieneはtarget branchとの差分にtrailing whitespace、conflict marker、意図しないbinary/build outputがないことを確認する。byte-exactで保持すべきvendor noticeは明示的に除外し、ファイル自体を整形しない。

検証後は`git status --short`でcleanを確認し、final artifact、checksum、必要なevidence以外のbuild copy、DMG staging、screenshot、mountを片付ける。

## Release受け入れ

- [ ] final candidateのclean checkoutから、Hiyori、support skill/runtime、生成済みnpm/Cargo inventory/notice、Live2D/Hiyori termsを含み、development demo runtime、source map、quarantine、private dataを含まない`.app`を作る。
- [ ] nested codeからapp順にtimestampなしad-hoc署名し、全resourceをsealした`.app`で`codesign --verify --deep --strict`を通す。TeamIdentifierとDeveloper ID identityがなく、notarization済みでない状態を正確に記録する。
- [ ] 同じsealed `.app`から、stale mount、Finder UI state、既存buildへ依存しない`.dmg`を生成する。別々の2回のread-only mountで正規化inventory一致を確認し、DMG byte同一性を要求せずfinal candidateのsizeとSHA-256を記録する。
- [ ] DMGを実mountし、Applications相当へcopyしたappから起動する。build directory内binaryで代替しない。
- [ ] fresh macOS 14+ profile、別Mac、または同等の隔離環境でprimary path、single-instance、running close、5秒以内cleanup、Interrupted recoveryを確認する。
- [ ] Developer ID署名・notarizationを実施するか、ad-hoc integrity sealのみでDeveloper ID未署名・unnotarizedであること、Gatekeeper手順、security trade-offを英語testing guideへ明記する。
- [ ] build前後のfree diskを記録し、mountと中間artifactを削除してfinal app、DMG、checksum、最小限のlogだけを残す。

## 提出package

### RepositoryとREADME

- [ ] private repositoryのまま提出する場合、`testing@devpost.com`と`build-week-event@openai.com`の両方へaccess invitationを送る。
- [ ] invitationがpending/expiredではなく、審査者相当の別sessionからrepositoryを読めることを確認する。
- [ ] English READMEにproblem、solution、track、demo、supported platform、setup、sample、testing、fastest judging pathを置く。
- [ ] exact GPT-5.6 model ID、call code path、input/output/validation、core workflowへの必要性を記す。
- [ ] Codexが行った具体的貢献、人間が行った重要判断とtrade-off、prior/new work boundaryを記す。
- [ ] secret、credential、private path、PIIがworking tree、Git history、README、logにないことを確認する。

### Demo video

- [ ] public YouTube videoを**3分未満**にする。
- [ ] voiceoverまたは完全な英語説明で、何を作ったか、Codexをどう使ったか、GPT-5.6をどう使ったかを説明する。
- [ ] current final artifactで、workspace→main turn→trusted read-only commit evidence→「詳しく教えて」→caption/optional TTS→Context/Live2Dの価値をend-to-endで示す。
- [ ] logout状態で再生でき、無許可素材、secret、email、notification、private URLが映らない。
- [ ] README、model ID、UI copy、現在buildと動画内容を一致させる。

### DevpostとCodex evidence

- [ ] 1 trackを確定する。
- [ ] project title、tagline、English description、public video URL、repository URL、必要ならlive demo URLを入力する。
- [ ] testing instructions/credentials、team members、表示されるtechnology tag、screenshot/image、全required fieldを入力する。
- [ ] primary build threadで`/feedback`を実行し、代表Session IDを保存してDevpostへ入力する。
- [ ] evidenceにSession ID、final commit、artifact checksum、video URL、repository access、human decisions、Codex contributionの対応を残す。
- [ ] draft保存後、previewを別sessionで開き、link、layout、video、repo、英語だけで理解できるjudge pathを確認する。
- [ ] Official Rules、FAQ、Devpost formは提出直前に`agent-browser`で再確認し、新しい情報を使う場合は対象hackathon文書の`updated`と`last_verified`を更新する。
- [ ] submit confirmation、submission URL、最終screenshotを保存する。

GitHub invitation、YouTube upload/publication、`/feedback`実行、Devpost draft write/submit、trackやteamを確定する操作はexternal stateを変更する。これらは最終段階で利用者から対象と範囲について**明示的な権限**を得てから実施する。権限がない間は、草案、command、field map、checklistの準備までに留める。

## 最終Go/No-Go

### Go

次をすべて満たす場合だけsubmitする。

- [ ] C01〜C20が完了し、demo-visible controlに無反応、local-only、fake readiness、暗黙presentationがない。
- [ ] Commit read-only、support isolation、Stopのjob/cache維持、ja/en、accessibility、TTS、privacy/security、offline/error、performanceがgreenである。
- [ ] desktop/tablet/幅480の`agent-browser`、native QA、全品質gate、real app/DMGのmount/launch/fresh-profile smokeがgreenである。
- [ ] Developer ID signing/notarization済み、または検証済みad-hoc sealとDeveloper ID未署名・unnotarized guideがある。
- [ ] English README、public `< 3:00` video、Devpost、testing、Session ID、evidenceがfinal commitと一致する。
- [ ] private repoの2審査先accessとsubmission confirmationを第三者相当sessionで確認し、締切前かつ十分なdiskがある。

### No-Go

次のいずれかがあればsubmit-readyと宣言しない。

- [ ] 暗黙caption/TTS、revoke後の再表示、placeholder/揮発/無反応、無確認のturn喪失、二重起動、cleanup不明が残る。
- [ ] ja/en、accessibility、privacy/security、offline/error、performanceまたは品質gateが未検証、fail、flakeする。
- [ ] final DMGを生成、mount、copy、launchできない、または署名方針/unsigned guideがない。
- [ ] README、動画、Devpost、model ID、実装が不一致、または招待、video、Session ID、required field、confirmationを確認できない。
- [ ] secret/private data、第三者asset権利、外部操作権限に未解決事項がある。

## 外部依存とowner判断

| 依存 | 必要な判断・資源 | Blockする範囲 |
| --- | --- | --- |
| GitHub repository | owner権限、指定2アドレスへのprivate invitation、審査者相当access確認 | Repository gate、C20、final Go |
| Track/Devpost | 1 trackのowner決定、team情報、Devpost login、submit権限 | C19 final copy、C20、submission |
| Codex `/feedback` | primary build threadへのaccessと利用者による実行許可 | Session ID field、C20、final Go |
| YouTube | upload権限、public設定、英語voiceover、第三者素材権利 | Video URL、Devpost preview、final Go |
| macOS検証環境 | macOS 14+、fresh profileまたは別Mac相当環境、十分なdisk | C17、release Go |
| Signing | Developer ID/notarization credentialと採用判断。ない場合はunsigned guide承認 | Distribution guidance、release Go |
| Runtime prerequisites | Codex CLI/subscription、GPT-5.6 availability、optional TTS用設定、network/offline test環境 | Judge testing、error-path evidence |
| Official Rules | submit直前のnetwork accessと`agent-browser`での再確認 | final evidence、submission |
| Deadline | 2026-07-21 23:00 JST内部締切、2026-07-22 09:00 JST公式締切 | 全外部操作とfinal Go |

外部依存が未解決でも、権限不要の実装、テスト、草案、artifact作成は進める。外部writeが必要になった時点で対象、値、影響を提示して明示的な許可を求め、許可なしに招待・公開・送信しない。

## 根拠資料

- `.context/remaining-mvp-gap-audit-2026-07-18.md`
- `.context/commit-explanation-composition-independent-review.md`
- `docs/hackathon/10-final-submission-checklist.md`
- `docs/thinking/001.md`
