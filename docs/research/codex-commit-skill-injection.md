---
title: "Codex commit skill の turn 単位注入調査"
description: "アプリ同梱の commit SKILL.md をリポジトリへ保存せず、Codex App Server の各 turn へ明示注入する契約を整理する。"
updated: 2026-07-21
last_verified: 2026-07-21
read_when:
  - "commit skill の同梱、版管理、turn/start 注入、診断表示を実装するとき。"
  - "Codex CLI 更新後に skill input の互換性を再検証するとき。"
---

# Codex commit skill の turn 単位注入調査

## 結論

Coding Wife は commit の作成を native Git service へ委譲せず、main Codex session 自身へ任せる。commit 方針はアプリ resource として版管理した `coding-wife-commit-work/SKILL.md` を正本にし、repository 内へ skill file を作成しない。commit説明には別の `coding-wife-explain-commit/SKILL.md` を使い、main skillと権限・入力を混在させない。

2026-07-18 時点の Codex CLI 0.144.5 が生成する App Server schema では、`turn/start.input` の `UserInput` union に `{ "type": "skill", "name": string, "path": string }` がある。したがって、アプリは各 turn で同梱 resource の絶対 path を skill input として明示できる。`TurnStartParams` 自体に別の `skill` field はなく、`developerInstructions` は `thread/start` / `thread/resume` にある。MVP は skill input を優先し、互換性 probe でこの union variant を確認できない runtime では、同じ版の内容を thread の developer instructions として注入する。

skill の存在だけでは実行を保証しない。両skillの `agents/openai.yaml` は `policy.allow_implicit_invocation: false` とし、App Server の request を送る前にアプリが明示skill inputを構成する。アプリは resource の version、content digest、注入方式、対象 work unit / turn を記録し、main skillは各main turnにちょうど1回、説明skillは「詳しく教えて」のisolated support turnにだけ1回含める。注入を証明できないturnは開始しない。

## 調査方法

最終確認日は 2026-07-21 である。

| 資料・証拠 | 確認内容 | 採用理由 |
|---|---|---|
| OpenAI [Build skills](https://learn.chatgpt.com/docs/build-skills) | skill は `SKILL.md` と任意 resource からなり、明示・暗黙の 2 経路で起動される。Codex は選択した skill の本文を読む | skill の公式 authoring / activation 契約であるため |
| OpenAI [Codex App Server](https://learn.chatgpt.com/docs/app-server) | `turn/start` は user input を受け、実行 CLI と一致する TypeScript / JSON schema を生成できる | rich client 統合と version-specific schema 検査の公式根拠であるため |
| `codex-cli 0.144.5` の `codex app-server generate-ts` 出力 | `TurnStartParams.input: Array<UserInput>`、`UserInput` に `type: "skill"`、`name`、`path` が存在。`ThreadStartParams` / `ThreadResumeParams` に `developerInstructions` が存在 | 実際に同梱対象となる runtime version の wire contract を確認できるため |
| `codex-cli 0.144.5` の `McpToolCallThreadItem` / `McpToolCallResult` 生成型と実`node_repl/js` read-only probe | itemは`server`、`tool`、`status`、`result`、`error`を持ち、resultは`content`、`structuredContent`、`_meta`を持つ。`nodeRepl.setResponseMeta`でversioned objectを`_meta`へ返せる | raw JavaScriptや表示用content textを解釈せず、commit intentをtyped resultへ明示する経路を確認できるため |

生成 schema は `/tmp` にだけ出力し、repository へコピーしていない。CLI 更新時は同じコマンドで再生成し、型名だけでなく union variant と required field を再確認する。

## 採用する接続契約

### 正常経路

1. アプリ bundle 内の versioned `SKILL.md` を `app_bundle` authority の owner-controlled resource path から読む。
2. front matter と app manifest の skill ID / version が一致することを確認する。
3. UTF-8 bytes の SHA-256 digest を計算する。
4. main turnの `turn/start.input` に利用者のtext inputと、`name=coding-wife-commit-work` の `type: "skill"` inputを1件含める。
5. `skillId`、`skillVersion`、`contentDigest`、`pathAuthority=app_bundle`、`injectionMode=skill_input`、workspace generation、work unit ID、client request IDを監査eventに残す。

skill path は repository path ではなく app bundle resource を指す。アプリは `.agents/skills`、`AGENTS.md`、`.git`、user の Codex home を書き換えない。

### 互換 fallback

起動時に同じ Codex binary が生成した schema または同等の capability probe で `UserInput.type=skill` を確認できない場合、アプリは同じ `SKILL.md` 本文を `thread/start` / `thread/resume` の `developerInstructions` へ含める。fallback でも version と digest は同一で、監査 event の `injectionMode` だけを `developer_instructions` にする。

fallback は turn ごとの保証が弱いため、thread generation が変わるたびに再注入する。既存 thread を resume して注入状態を証明できない場合は、そのまま user turn を送らず再 resume または新規 thread を行う。skill input と developer instructions の二重注入はしない。

### fail-closed 条件

次の場合は main turn を開始せず、draft を保持して診断理由を表示する。

- bundled resource が無い、読めない、UTF-8 でない。
- skill ID / version / digest が manifest と一致しない。
- skill input と developer instructions のどちらも runtime contract で利用できない。
- 同じ turn request に異なる version の注入記録が存在する。
- request retry で同じ client request ID に異なる skill digest が指定された。

## commit skill が規定する内容

skill は main Codex に次を要求する。

- 作業のまとまりごとに、レビュー可能な適切な粒度で commit する。
- summary は英語の Conventional Commits 形式にする。
- body は変更内容と意図を英語 bullet で記録する。
- subject、body、各bulletは物理改行で分離し、2文字のliteral `\n`をcommit messageへ保存しない。message fileまたは複数の`-m`引数でmessageを構築し、commit前後に実bytesを検査する。
- commit後は`git log -1 --format=%B`でmessageを読み戻し、subject、空行、body bulletが別lineであること、およびliteral `\n`が存在しないことを確認できた時だけ成功として報告する。
- `node_repl/js`内でcommitする場合は、commit直前のfull HEAD（初回commitなら`unborn`）を保持し、message検査後のfull commit SHAとともに`nodeRepl.setResponseMeta({codingWifeGitCommitProof:{schemaVersion:1,operation:"git_commit",beforeHead,commitSha}})`でexact markerを返す。markerを確定できなければcommit成功として報告しない。
- session 開始前から存在する利用者変更を保護し、無関係な変更を stage / commit しない。
- 実行した verification と結果を報告する。
- 安全に commit できない場合は理由を報告し、force、履歴書き換え、native service への代行要求を行わない。

native Git backend はこの方針の実行者ではない。HEAD、status、commit metadata、diff、work-unit evidence の read-only observer に限定する。interceptorは`node_repl/js`のraw JavaScript、arguments、content textからGit intentやSHAを推測せず、exact markerもworkspace generation・thread・turn・item・repository identity・native before/current HEAD・reachabilityを満たす時だけopaque proofへ昇格する。

## commit説明skillの境界

`coding-wife-explain-commit` はCommit画面の「詳しく教えて」を利用者が押した時だけ、mainとは別のisolated support turnへ明示注入する。入力はpathを除去しsecret scanを通過した構造化 `CommitEvidenceV1` だけとし、repository root、absolute/relative file path、raw diff全文、secret、raw reasoningを含めない。support runtimeへfilesystem、shell、Git、MCPその他tool authorityを与えない。

出力はUI localeに一致する日本語または英語のversioned schemaとし、要約、変更点、理由、検証、影響、注意、次の見方、および同じ内容を短く分割したnarration chunksを持つ。`summary`は1〜4,096 Unicode scalar、6つの説明arrayは各1〜16件かつ各item 1〜2,048 scalar、`narrationChunks`は1〜32件かつ各text 1〜240 scalar、連番、section非逆行、serialized JSON全体64 KiB以下を要求する。schema invalid、stale generation、cancel、redaction failureではchunkを表示・読み上げせず、決定的なunavailable captionへfail closedする。

## 実装への影響

| 領域 | 判断 |
|---|---|
| Codex adapter | 各 `turn/start` で skill input を合成し、retry は同一 digest の exact replay にする |
| Git backend | commit / ref / index / worktree mutation command を公開しない |
| History | skill 注入 audit と、turn 終了後に観測した新規 commit / gate evidence を追記する |
| Commit UI | skill version / digest、commit list、metadata、diff、verification evidence を read-only 表示する |
| Diagnostics | active injection mode、version、digest prefix、last verified turn、failure reason を表示する |

## 再検証条件

Codex CLI binary、generated schema fingerprint、App Server API、skill format のいずれかが変わった場合に再検証する。専用 `skill` field が将来 `TurnStartParams` へ追加されても、runtime schema で確認するまでは現在の `UserInput.type=skill` を正本とする。
