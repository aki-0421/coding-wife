---
title: Codebase Setup for OpenAI Build Week
description: "Build Week向けのGit、Codex証跡、再現可能性、秘密情報管理の初期設定を定義する。"
updated: 2026-07-22
read_when:
  - "ハッカソン実装を始める前にコードベースを整備するとき。"
  - "Codex利用証跡、再現手順、APIキー管理を設計するとき。"
last_verified: 2026-07-22 JST
---

# コードベース初期設定

この章は stack 非依存です。既存のプロジェクト規約がある場合は、それを優先してください。

## 1. 推奨リポジトリ構成

```text
.
├── README.md                    # 提出・審査の入口
├── LICENSE                      # public repo の場合は必須級
├── AGENTS.md                    # Codex に与える repo-level instructions
├── .env.example                 # 値を含めない環境変数一覧
├── .gitignore
├── docs/
│   ├── hackathon/               # このガイド
│   ├── architecture.md          # system / data flow
│   ├── testing.md               # judge 向け確認方法
│   └── third-party-notices.md   # OSS、API、データ、素材
├── evidence/
│   ├── build-log.md             # Codex / GPT-5.6 / human decisions
│   ├── screenshots/             # 開発・デモ証跡。秘密は含めない
│   └── demo-script.md
├── scripts/
│   ├── setup.*                  # 一発セットアップ
│   ├── dev.*                    # 一発起動
│   └── test.*                   # 一発検証
└── src/ ...
```

`evidence/` を public にしたくない場合は private artifact として管理し、README には公開可能な要約だけを載せます。

## 2. Git の開始点を固定する

### 新規プロジェクト

```bash
git init
git add -A
git commit -m "chore: initialize OpenAI Build Week project"
```

### 既存プロジェクト

履歴を書き換えず、**実在する提出期間前の commit** を baseline として特定します。Submission Period は 2026-07-13 09:00 PDT に開始しています。

```bash
# 提出期間開始前の最後の commit 候補を確認する
git log --before="2026-07-13 09:00:00 -0700" -1 --format="%H %cI %s"

# 内容を確認したうえで、その実在する commit に tag を付ける
git tag hackathon-pre-submission <commit-sha>
```

この時点から参加作業を始める場合は、現在地も別名で固定できます。

```bash
git status
git add -A
git commit -m "chore: checkpoint at hackathon setup start"
git tag hackathon-setup-start-2026
```

注意:

- 現在の commit を、事実と異なる「pre-hackathon baseline」として扱わない。
- pre-submission commit が存在しない、または履歴が不十分な場合は、その事実と既存資産の範囲を README / evidence log に記載する。
- README と evidence log に、どこからが新規作業か正直に記載する。
- meaningful extension を示すため、機能単位の commit を残す。

## 3. Codex をセットアップする

公式 Quickstart は ChatGPT desktop app を推奨しています。Codex CLI、IDE extension、SDK も利用可能です。

### Codex CLI — macOS / Linux

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
cd /path/to/repository
codex
```

初回起動時に ChatGPT account などで sign in します。

### 最初に確認する Codex commands

Codex 内で実行します。

```text
/status       # model、directory、session 設定を確認
/model        # GPT-5.6 model と reasoning effort を選択
/init         # AGENTS.md を作る
/permissions  # 実行・編集権限を確認
/review       # 差分をレビュー
```

### primary build thread

- 中核機能を作るメインスレッドを1本決める。
- brainstorming、雑談、軽い調査だけのスレッドを primary にしない。
- core architecture、主要実装、debug、test、polish をできるだけ同じスレッドで継続する。
- 最終的にそのスレッドで `/feedback` を実行する。FAQの取得手順は`/status`と記載しているため、`/feedback`でIDを取得できない場合は同じprimary threadで`/status`も実行し、同一Session IDを記録する。

## 4. GPT-5.6 model の選択と記録

公式 model docs では次の model ID が公開されています。

| Tier | Model ID | 用途の目安 |
|---|---|---|
| Sol | `gpt-5.6-sol` / alias `gpt-5.6` | 最も複雑なcoding、reasoning、polish |
| Terra | `gpt-5.6-terra` | intelligenceとcostのバランス |
| Luna | `gpt-5.6-luna` | cost-sensitive、高頻度処理 |

Codex CLI では例として次が使えます。

```bash
codex --model gpt-5.6
codex exec -m gpt-5.6 "Review the current changes"
```

### 安全側の推奨

- primary build thread では GPT-5.6 を明示的に選び、`/status` の内容を記録する。
- `gpt-5.6` は公式 model catalog 上で `gpt-5.6-sol` の alias であり、要件名と一致するため証跡上は分かりやすい。ただし、これが唯一の許容 tier だと規約に明記されているわけではない。
- Terra / Luna を使う場合も、正確な model ID、役割、GPT-5.6 family である根拠を README に書く。現行 FAQ は Free plan の Codex で Terra を利用できると明記している。
- ハッカソン規約は GPT-5.6 tier を明示的に限定していない。実際に使った GPT-5.6 family の model ID と実質的な役割を提出資料に残す。
- Coding Wifeでは、`gpt-5.6-sol`をwrite-capable main session、`gpt-5.6-luna`をzero-tool presence director、`gpt-5.6-terra`をzero-tool commit explainerとして分離する。READMEと動画では、この入力・出力・authority境界まで説明する。

## 5. Codex credits と API credits を分ける

### Codex credits

- 登録済み参加者向けの $100 Codex credits 申請は終了し、2026-07-22の再確認でも全credits配布済みと案内されている。
- request deadline は **2026-07-18 04:00 JST** だった。
- FAQ では one code per Entrant。
- 現行 Official Rules 上、配布済み credits は **2026-07-22 09:00 JST** までに使用する。
- Settings → Usage で残量を確認する。
- FAQ 上、prepaid credits を使い切ると Codex は停止し、Auto top-up を有効にしていなければ自動課金されない。

### OpenAI API credits

- Build Week では別の API credits は配布されないと FAQ に明記されている。
- 2026-07-22 の最新 Update は、参加要件を満たすために OpenAI API または API credits 自体は必須ではないと明記している。
- 製品 runtime から GPT-5.6 API を呼ぶ場合、OpenAI Platform 側の billing が必要。
- Codex credits が API の `insufficient_quota` を解消するものではない。

## 6. Runtime API の安全な初期設定

### `.env.example`

実際に必要な変数だけを列挙します。Codexのauthenticated local sessionだけでmain pathが動くprojectに、存在しないAPI key要件を追加してはいけません。次はruntime APIを直接使うprojectの例です。

```dotenv
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6
APP_BASE_URL=http://localhost:3000
```

### 必須の安全策

- `.env`、API key、session token、test account password を Git に commit しない。
- browser / mobile client に OpenAI API key を埋め込まない。server-side から呼ぶ。
- logs、screenshots、動画に key や個人情報を映さない。
- API timeout、retry、rate limit、quota error を扱う。
- user-generated content を扱う場合、入力・出力の安全性と表示上の注意を設ける。
- 本番 demo では最小権限の key / project を使い、spend limit を設定する。

## 7. Judge が試せる一発起動

最低でも次のいずれかを用意します。

```bash
./scripts/setup.sh
./scripts/dev.sh
./scripts/test.sh
```

または stack に応じて:

```bash
make setup
make dev
make test
```

README 冒頭には、5分以内で確認できる最短手順を書きます。

Developer Toolでは、source build手順だけでなく、current frozen featureを含むrelease、demo、sandboxのいずれかを用意し、judgeがゼロからrebuildせず試せるようにします。古い公開releaseをcurrent機能の証拠として案内してはいけません。

### 推奨

- `.env.example`
- sample data / seed command
- deterministic demo case
- health check
- smoke test
- supported OS / runtime version
- exact dependency lockfile
- screenshots of expected result

READMEへ未確定の内部placeholderを公開しません。外部URLがまだ存在しない場合は、未解決markerを載せるのではなく、そのlink行を省き、limitationsに現在利用できないことを平文で説明します。

## 8. Hosted demo と fallback

審査員が local build を行わない可能性があるため、hosted demo が強く推奨されます。

- test account を用意する。
- demo 専用データを用意する。
- quota や費用を抑えるため、入力サイズと呼び出し回数を制限する。
- external API が落ちた場合の説明を表示する。
- mock だけを本番動作に見せない。mock mode は明記する。
- demo URL、credentials、制限事項を testing instructions に書く。

## 9. `AGENTS.md` に書く内容

```markdown
# Project instructions

## Goal
- [対象ユーザー] の [具体的な問題] を解決する。
- Track: [one track]

## Hackathon constraints
- Core product flow must meaningfully use GPT-5.6.
- Keep the primary Codex thread focused on core implementation.
- Preserve tests and evidence for every material feature.
- Never commit secrets or private data.
- Keep setup and demo runnable for judges.

## Quality gates
- Run: [lint command]
- Run: [typecheck command]
- Run: [test command]
- Run: [build command]

## Documentation
- Update README when setup or architecture changes.
- Append important Codex contributions and human decisions to evidence/build-log.md.
```

## 10. 最初の Codex task 例

```text
Read this repository and the hackathon docs under docs/hackathon/.
Do not implement yet.
Produce:
1. a concise architecture plan,
2. the smallest end-to-end vertical slice,
3. a list of risks against the four judging criteria,
4. commands for setup, test, and demo,
5. files that should be added for reproducibility and evidence.
Keep GPT-5.6 central to the product's primary user workflow.
```

次の task では、vertical slice を実装し、test と README を同時に更新させます。

## 11. Definition of Done

各機能は次を満たして初めて完了です。

- [ ] user-visible に動く
- [ ] GPT-5.6 の役割が説明できる
- [ ] test / validation がある
- [ ] error state がある
- [ ] README / architecture が更新された
- [ ] Codex contribution と human decision が記録された
- [ ] demo で30秒以内に見せられる

## Sources

- https://openai.devpost.com/rules
- https://learn.chatgpt.com/docs/quickstart
- https://learn.chatgpt.com/docs/codex/cli
- https://learn.chatgpt.com/docs/models?surface=app
- https://developers.openai.com/api/docs/models
- https://openai.devpost.com/details/faqs
- https://openai.devpost.com/resources
- https://openai.devpost.com/updates/45371-tuesday-last-minute-tips
