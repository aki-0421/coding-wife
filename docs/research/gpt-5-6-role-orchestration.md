---
title: "GPT-5.6 役割別オーケストレーション実装契約"
description: "Sol・Terra・Lunaのexact model routingと、隔離support、presence direction、字幕・TTS・Live2D cueの安全な接続境界を定義する。"
updated: 2026-07-21
read_when:
  - "GPT-5.6 Sol・Terra・Lunaのmodel routing、support isolation、release proofを変更するとき。"
  - "意味あるmain eventをLunaの短いcaption、OpenAI TTS、Live2D semantic cueへ接続するとき。"
---

# GPT-5.6 役割別オーケストレーション実装契約

## 目的とMVP境界

Coding Wifeは三つのGPT-5.6 modelを一つのapp-owned orchestrationとして使う。利用者が直接会話し、repositoryへ変更権限を持つのはSolだけである。TerraとLunaはmain conversationから分離した短命support processで動き、repository、shell、file、Git、MCP、network、dynamic tool、main sessionへのwriteback権限を持たない。

MVPでは、Solは実装、Terraは検証済みcommitの説明、Lunaは意味あるmain eventの短いpresence directionだけを担当する。Lunaを常時実況、進捗要約、技術判断、承認、error recoveryの正本として使わない。modelが使えない場合もmain turn、決定card、error表示、deterministic Live2D stateは継続する。

## Exact model role

| role | exact model ID | authority | input | output |
| --- | --- | --- | --- | --- |
| `main_coder` | `gpt-5.6-sol` | main workspaceの既存Codex権限 | user instruction、検証済みcontext、attachment、commit skill | main event、判断、repository変更、reviewable commit |
| `commit_explainer` | `gpt-5.6-terra` | external authority 0、main writeback 0 | redacted `CommitEvidenceV1` | strict `CommitExplanationV1` |
| `presence_director` | `gpt-5.6-luna` | external authority 0、main writeback 0 | pathless `PresenceDirectorInputV1` | strict `PresenceDirectionV1` |

各roleはapp-owned constantで固定し、UI、workspace preference、provider設定から変更できない。`thread/start`、`turn/start`、thread response、captured Responses request、support auditでroleに対応するexact modelを照合し、`allowProviderModelFallback=false`を維持する。欠落、別model、reroute、unknown fieldではそのroleだけをunavailableへfail closedし、別modelへfallbackしない。

Solの既存`model/list`、reasoning effort、main reroute gateは変更しない。TerraとLunaは専用clean `CODEX_HOME`、owner-only空workspace、permission profile `coding-wife-support-zero`、runtime root 0件、wire-advertised/external-authority tool 0件、内部`update_plan` event即時拒否、capacity 1を使う。release proofはCLI identity、binary hash、schema fingerprint、skill version/digest、output schema hash、exact role/model、`tools` field不在、`tool_choice=auto`、`parallel_tool_calls=false`をroleごとに照合する。一つでも証明できなければ対象support taskを開始しない。

## Luna input contract

Lunaへ渡すmodel inputは次のexact objectだけである。correlation IDとworkspace scopeはnative scheduler内に保持し、model inputへ入れない。

```json
{
  "schemaVersion": 1,
  "locale": "ja",
  "trigger": "decision_wait",
  "semanticState": "asking",
  "retrying": false,
  "elapsedBucket": "none"
}
```

### `PresenceDirectorInputV1`

| field | contract |
| --- | --- |
| `schemaVersion` | literal `1` |
| `locale` | `ja` or `en` |
| `trigger` | `decision_wait`, `recoverable_failure`, `terminal_failure`, `long_milestone`, `commit_ready`, `turn_completed` |
| `semanticState` | `neutral`, `working`, `asking`, `success`, `warning`, `error` |
| `retrying` | boolean。error以外では`false` |
| `elapsedBucket` | `none`, `45s_plus`, `120s_plus`。`long_milestone`以外では`none` |

入力へuser/assistant text、tool名、command、tool output、diff、file/path alias、commit message、decision question/option、error message、raw protocol、raw reasoning、absolute/relative path、URL、secret、credential、workspace/repository名を含めない。triggerはnormalized `CodexEvent`またはnative verified-commit proofから決定論的に投影し、文字列をmodel向けsummaryへ変換しない。

triggerとsemantic stateの組合せは次だけを許可する。

| trigger | input state | Lunaが返せるcue |
| --- | --- | --- |
| `decision_wait` | `asking` | `asking`, `neutral` |
| `recoverable_failure` | `warning` | `warning`, `neutral` |
| `terminal_failure` | `error` | `error`, `warning`, `neutral` |
| `long_milestone` | `working` | `working`, `neutral` |
| `commit_ready` | `success` | `success`, `neutral` |
| `turn_completed` | `success` | `success`, `neutral` |

## Luna output contract

LunaはMarkdownや周辺proseを付けず、次のexact objectを返す。

```json
{
  "schemaVersion": 1,
  "locale": "ja",
  "utterance": "確認が必要なところで待っています。",
  "cue": "asking"
}
```

### `PresenceDirectionV1`

| field | contract |
| --- | --- |
| `schemaVersion` | literal `1` |
| `locale` | request localeとexact一致する`ja` or `en` |
| `utterance` | trim済み1〜160 Unicode scalar、1文を推奨 |
| `cue` | triggerごとのallowlist内にあるsemantic cue |

`utterance`は短い現在地だけを伝え、技術的成功、検証済み、承認済み、安全、commit作成済み等をinput以上に推測しない。利用者の選択を誘導する推奨、好意・罪悪感による誘導、大げさな称賛、人格的所有、raw identifier、path、URL、secretらしい文字列を含めない。schema、locale、scalar bound、control文字、privacy scan、cue allowlistのどれかに失敗したoutputは公開しない。

## Admission、coalescing、stale cancellation

Luna schedulerはApp lifetimeに1個、実行capacity 1、待機slot 1とする。routine tool start/completion、file change、diff update、assistant commentary、connection statusはtriggerにしない。

priorityは`decision_wait` > `terminal_failure` > `recoverable_failure` > `commit_ready` > `turn_completed` > `long_milestone`とする。同一workspace generationでは通常caption開始間隔を30秒以上にし、`decision_wait`と`terminal_failure`だけcooldownを迂回できる。同じtriggerの重複は1件へまとめる。active中の新候補は待機slotをlatest candidateへ置換し、低priority candidateが高priority candidateを置換してはならない。

`long_milestone`はturn開始45秒後に一度だけ候補化し、まだactiveなら120秒後に一度だけ再候補化する。新しいworkspace generation、workspace切替、turn stop/interruption、app closeでactiveとqueued requestをstale化する。Support runtimeのrelease verification、sandbox probe、isolation probe、runtime初期化を含む構築開始時点からcancel tokenとprocess ownershipを登録し、通常終了は5秒以内、force cleanupは500ms以内にprocess treeとprivate run directoryを収束させる。force cleanupではmain runtime、main work unit、Luna runtimeを同時に停止し、各componentの失敗を保ったまま全体deadlineへ合成する。security probeをskipまたは弱化してはならない。late responseをevent、caption、cue、TTSへ適用せず、decision解決後のlate `decision_wait`も同様に破棄する。

verified commitの`commit_ready`は、main work unit、repository identity、before/current HEAD、exact commit SHAをnativeが検証した後だけ候補化する。App Server text、raw JavaScript、tool output、HEAD差分単体をtriggerにしない。
`commit_ready`は正常完了したwork unitのterminal proof内で確定するため、その直後の同じ`turn_completed`通知だけではstale化しない。failed、stop、interruption、cancelで終わったwork unitからは`commit_ready`を候補化せず、既存候補も通常どおりstale化する。

## Public event and frontend gate

strict validation済みのLuna resultだけをTauri channel `coding-wife://presence-direction`へ次のeventとして出す。unknown fieldを許可しない。

Frontendはactive workspaceとlocaleが変わるたび、Tauri command `presence_set_scope`へ`{ request: { schemaVersion: 1, workspaceId, workspaceGeneration, locale } }`だけを送る。native schedulerはこのscopeと完全一致するnormalized eventだけを受理し、scope変更時はactive process、待機slot、milestone timerをstale化する。command失敗はmain session、deterministic character state、Terraのcommit説明を停止しない。

```ts
interface PresenceDirectionEventV1 {
  readonly schemaVersion: 1
  readonly requestId: string
  readonly workspaceId: string
  readonly workspaceGeneration: number
  readonly sourceEventId: string
  readonly trigger:
    | "decision_wait"
    | "recoverable_failure"
    | "terminal_failure"
    | "long_milestone"
    | "commit_ready"
    | "turn_completed"
  readonly locale: "ja" | "en"
  readonly utterance: string
  readonly cue:
    | "neutral"
    | "working"
    | "asking"
    | "success"
    | "warning"
    | "error"
  readonly priority: "low" | "normal" | "high"
  readonly modelRole: "presence_director"
  readonly model: "gpt-5.6-luna"
  readonly occurredAt: string
}
```

Frontendはactive workspace ID、実Codex generation、latest request ID、localeをevent受理直前と描画直前に照合する。mismatch、duplicate、unknown field、rollback generationは破棄する。Luna eventをmain Chat timeline、main conversation、commit evidence、workspace historyへ追加しない。

captionの優先順位は、明示的なcommit explanation presentation > Lunaの`decision_wait` / failure > Lunaの`commit_ready` / completion > Lunaのmilestoneとする。Luna captionは既存のLuna captionだけを置換し、active commit explanationを閉じたり上書きしたりしない。commit explanation開始時はLuna captionとLuna speechをstale化する。decision card、error banner、commit evidence、deterministic character stateをcaptionで置換しない。

Luna captionはcharacter pane内のvisible HTML textとして1文を表示し、`aria-live=polite`とする。blocking/error semanticsは既存のdecision card/error UIが所有するため、Luna caption自体を`alert`にしない。captionを先にlayoutし、windowと内側viewportで全文がvisible、frontmostであることをpaint後に確認する。eventごとのack deadlineは1秒で、ack後100ms以上表示してからだけ既存`narration_speak`を呼ぶ。hidden、clip、occlusion、timeoutではcaption-onlyへterminal化する。

TTSへ渡すtextは表示済み`utterance`とbyte-for-byte同じ値とし、再要約しない。semantic typeはtriggerから決定論的に`progress`、`waiting_for_user`、`error`、`commit_observed`へ変換する。priorityもpublic eventと一致させる。TTS off、API key未設定、mute、provider failureでもcaptionを維持する。workspace switch、turn stop、commit explanation開始、stale event、muteはLuna speechをcancelする。unmute後に過去eventを再生しない。

`cue`はLive2D motion/expression IDではない。Frontendは既存の`SemanticMappingV1`を使い、選択packのmanifest inventoryで検証済みのmotion/expressionだけへ解決する。invalid mappingはneutralへ戻す。`prefers-reduced-motion`では発話textとsemantic stateを残し、model cueによるmotionを開始しない。

## Failure、privacy、persistence

Luna unavailable、queue overflow、timeout、cancel、schema/privacy violation、support policy violationではcaption、speech、model cueを0件にし、既存の決定論的character stateを維持する。Luna failureはmain turnとTerraのcommit説明を停止しない。利用者向けにsupport failureを新しいChat errorとして表示しない。

`PresenceDirectorInputV1`、prompt、raw response、utterance、caption、audio、support thread IDは永続化しない。owner-only auditへ保存できるのはrole、exact model ID、attempt/success/failure/cancel/unavailable counter、latency、token count、safe error code、skill/schema digest prefixだけである。通常logにはworkspace/repository/path、prompt/response、caption text、credentialを出さない。

## 検証境界

最低限、次を独立したtestで固定する。

1. Sol/Terra/Lunaのconfig、thread、turn、response、wire、auditが各exact modelと一致し、cross-role modelとfallbackを拒否する。
2. Luna inputにtext/path/diff/secret fieldを追加できず、trigger/state/bucketの不正組合せを拒否する。
3. Luna outputのunknown field、wrong locale、overlong/control/private text、disallowed cueを拒否する。
4. capacity 1、latest coalesce、priority、30秒cooldown、45/120秒milestone、generation/decision/stop cancelを決定論的clockで検証する。
5. tool event、reasoning、routine progressではLunaを起動しない。verified commitだけが`commit_ready`になる。
6. active commit explanationがLuna caption/TTSより優先され、caption visible ack前、reduced motion、mute、stale workspaceではspeech/motionを開始しない。
7. Lunaのrelease verification、sandbox probe、isolation probe、runtime初期化の各構築段階でapp closeとforce cleanupを再現し、process tree、private run directory、scheduler active ownershipが期限内に0件へ収束する。
7. support release proofがrole別model、tool 0、permission、skill/schema hashを照合し、失敗時もmain turnが完走する。
