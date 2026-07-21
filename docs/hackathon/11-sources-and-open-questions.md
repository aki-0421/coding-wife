---
title: Sources, Conflicts, and Open Questions
description: "公式情報源の優先順位、確認済みの矛盾、未確認事項、再検証項目を管理する。"
updated: 2026-07-22
read_when:
  - "ハッカソン情報の根拠や矛盾を確認するとき。"
  - "Web検索またはHTTP取得で公式情報を再検証するとき。"
  - "未確認事項を公式窓口へ問い合わせるか判断するとき。"
last_verified: 2026-07-22 JST
---

# 情報源・矛盾・未確認事項

## 1. Source hierarchy

規約自身が、矛盾時に Official Rules が優先すると定めています。以下の2位以下は、公開情報を扱うための実務上の優先順位であり、規約に明文化された厳密な序列ではありません。

1. **Official Rules**
2. Hackathon Website の明示的な更新・通知
3. Devpost FAQ / Overview / Resources / Schedule
4. OpenAI Build Week page
5. Devpost Hackathons Plugin
6. Discussion Board の参加者コメント

Discussion Board のコメントは、公式運営者であることが明確でない限り、ルール解釈の根拠にしません。

## 2. Primary sources

### Hackathon

- Overview: https://openai.devpost.com/
- Official Rules: https://openai.devpost.com/rules
- Resources: https://openai.devpost.com/resources
- Schedule: https://openai.devpost.com/details/dates
- FAQ: https://openai.devpost.com/details/faqs
- Updates: https://openai.devpost.com/updates
- Latest deadline update (2026-07-22 verification): https://openai.devpost.com/updates/45371-tuesday-last-minute-tips
- Discussions: https://openai.devpost.com/forum_topics

### OpenAI

- Build Week: https://openai.com/build-week/
- GPT-5.6 announcement: https://openai.com/index/gpt-5-6/
- ChatGPT / Codex Quickstart: https://learn.chatgpt.com/docs/quickstart
- Codex CLI: https://learn.chatgpt.com/docs/codex/cli
- Model selection: https://learn.chatgpt.com/docs/models?surface=app
- API model catalog: https://developers.openai.com/api/docs/models

## 3. Confirmed conflicts

### 3.1 Judging dates

- Official Rules: Jul 22 10:00 PT — Aug 5 17:00 PT
- Devpost Schedule: Jul 22 09:00 PDT — Aug 9 17:00 PDT
- OpenAI Build Week: Jul 22 — Aug 7

**Working decision:** Official Rules をルールとして採用。test access は winner announcement まで保持。

### 3.2 Deadline weekday

- Update post は “Monday, July 21” と記載。
- 2026-07-21 は Tuesday。
- Overview と Official Rules の date/time は一致。

**Working decision:** 2026-07-21 17:00 PDT / 2026-07-22 09:00 JST を採用。

### 3.3 Demo duration

- Official Rules: less than 3 minutes
- FAQ: 3 minutes or under

**Working decision:** 2:40〜2:50。3:00 は不可として扱う。

### 3.4 Codex / GPT-5.6 の “and” と “and/or”

- 一般要件と FAQ は、Codex と GPT-5.6 の両方を必須としている。
- 既存プロジェクトの拡張条項には “Codex and/or GPT-5.6” という表現がある。

**Working decision:** project 全体では両方を実質的に使う。既存 project の新規作業でも、可能な限り両方の証拠を残す。

### 3.5 YouTube visibility

- Official Rules は publicly visible on YouTube、Overview と FAQ は public YouTube と記載。
- Update 45371 は “Unlisted OK” と記載。

**Working decision:** Official Rules を優先し、visibility は **Public** にする。Unlisted を唯一の提出動画にしない。

### 3.6 Session ID の取得コマンド

- Official Rules、Overview、[Update 45282](https://openai.devpost.com/updates/45282-openai-build-week-submissions-are-open-plugin-launch)、[Update 45362](https://openai.devpost.com/updates/45362-openai-build-week-halfway-there-where-are-you)は提出項目を`/feedback` Codex Session IDとし、主要build threadから取得するよう案内している。
- FAQ の取得手順は `/status` を実行して Session ID を表示すると案内している。

**Working decision:** 主要 build thread で `/feedback` を先に実行する。IDが表示されない場合や照合が必要な場合だけ、同じ thread で `/status` を実行し、別 thread のIDで代用しない。

## 4. Important clarifications already available

### Credits

- $100 は Codex credits。
- OpenAI API credits / tokens は別途配布されない。
- OpenAI API と API credits は project 要件ではない。ただし Codex と GPT-5.6 の両方を project 構築に実質的に使う必要がある。
- product runtime で OpenAI API を使う場合は、自分の API billing が必要。
- credit request は registered participant が対象、在庫・承認条件付きだった。
- request deadline は 2026-07-18 04:00 JST。2026-07-22の再確認でもResourcesと最新Updateは全credits配布済みと案内している。
- 現行 Official Rules 上、配布済み Codex credits の使用期限は **2026-07-22 09:00 JST**。
- one code per Entrant。

### GPT-5.6 family and scope

- OpenAI の現行 model catalog は `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` を GPT-5.6 family として掲載し、`gpt-5.6` alias は Sol を指す。
- 現行 FAQ と最新 Update は、Free plan の Codex で GPT-5.6 Terra を利用できること、他モデルを併用しつつ project の一部で GPT-5.6 を使えることを明記している。
- 同じ FAQ は Codex と GPT-5.6 を incidental / decorative にできないとも記載する。

**Coding Wife の現行 contract:** `gpt-5.6-sol` は main coder、`gpt-5.6-terra` は isolated commit explainer、`gpt-5.6-luna` は isolated presence director。submission では3モデルの exact ID、分離された役割、実質的な code path を、frozen source・動画・現行 release で一致させる。

Public release v0.1.5 は古い preview であり、現行3モデル連携や最新UIを含む証拠として扱えない。v0.1.5 の artifact を現行機能の testing path や demo evidence に流用しない。

### Codex usage proof

- primary build thread でまず `/feedback` を実行する。
- IDの表示・照合が必要な場合は、FAQ に従い同じ thread で `/status` を実行する。
- majority of core functionality を作った thread を選ぶ。
- 複数 thread を使った場合は最も代表的な1本。

### Video

- public YouTube
- voiceover 必須
- AI-assisted narration 可
- Codex UI の表示自体は必須ではない
- narration は Codex と GPT-5.6 の具体的な使い方を説明する

### Hosting

- hosting そのものを一律必須とはしていない。
- project は intended platform で install・起動でき、説明と動画どおりに動く必要がある。
- plugin / developer tool は、installation instructions、supported platforms、rebuild 不要の testing path が必要。
- hosted demo / sandbox / test account は選択肢であり一律必須ではない。Coding Wife は frozen source と一致する prebuilt release を testing path にする。

## 5. Open questions

### 5.1 GPT-5.6 の meaningful-use 境界

FAQ は OpenAI API の利用を必須としていません。一方、FAQ は「project must use GPT-5.6」「code repository と demo video で evidence を見る」「Codex と GPT-5.6 は incidental / decorative ではいけない」と記載しています。

**安全側:** Coding Wife の3モデル orchestration を core workflow として demo し、各モデルの役割が source と product behavior に反映されることを示す。API 自体を要件とは説明しない。

### 5.2 Submission form の正確なフィールド

ログイン前の公開ページからは、submission form の全フィールドと文字数制限を確認できません。

**対応:** Devpost にログインして直ちに draft を作り、必須欄と制限を確認する。

### 5.3 Pro Account prize の人数

Official Rules の表は Pro Account for 1 year と記載しますが、team の何名に付与されるか公開要約では明確ではありません。

**対応:** 受賞時の案内に従う。提案・予算には人数を仮定しない。

### 5.4 Judging access の保持期限

Official Rules の Judging Period と他ページの日程が不一致です。

**安全側:** demo、test account、private repo access を少なくとも 2026-08-13 JST の winner announcement まで維持する。

## 6. Questions to ask support only if relevant

- private repository の具体的な共有方式・アカウント名。
- 日本語 narration + 英語 subtitle / transcript で translation requirement を満たすか。
- Sponsor / Administrator から過去に支援を受けた project の eligibility。
- 特殊 hardware が必要な project の testing 方法。
- under-age student と guardian entry の具体的な代表・賞金手続き。

Support:

- Devpost support: `support@devpost.com`
- OpenAI Build Week Discord: OpenAI Build Week page または Devpost Resources から参加
- Devpost Discussion Board: https://openai.devpost.com/forum_topics

## 7. Coding Wife current readiness — 2026-07-22 JST

| 項目 | 状態 | 根拠・次のアクション |
|---|---|---|
| Developer Tools track | 完了 | submission の track として使用 |
| Public repository | 完了 | public URL を提出 |
| MIT license / third-party notices | 完了 | repository に含まれる |
| Public release v0.1.5 | 古い preview | repository default `develop`と同様に、現行3モデル連携・最新UIの証拠には使わない |
| Frozen product source | 完了 | [`44d9aab779b9a66ed3f02d0016af061a71ba79c3`](https://github.com/aki-0421/coding-wife/tree/44d9aab779b9a66ed3f02d0016af061a71ba79c3)をimmutable judge sourceとして公開済み |
| Current no-rebuild release | 完了 | [macOS judge prerelease](https://github.com/aki-0421/coding-wife/releases/tag/build-week-submission-2026-07-22)、SHA-256、匿名3 asset検証、39/39 release suite、install/first-launch smokeがPASS |
| Accepted local video master | 完了 | 165.000秒、H.264/AAC、英語音声・焼き込み字幕、全4,950 frame privacy検査、4 screenshotsを受理済み |
| Public YouTube video | 完了 | https://youtu.be/t3oyxB0aa9M — 2026-07-22 08:11 JSTに匿名再生、`isUnlisted=false`、165秒を確認済み。title、description、手動SRTは未確認 |
| Primary Codex Session ID | 入力待ち | primary thread照合・private evidence保存・`/feedback` upload成功。値はpublic docsへ書かずDevpostへ転記する |
| Devpost form / Submitted state | manual handoff未完了 | 提出者がlogged-in formを手動submitし、My Projectsで確認する |
| Anonymous smoke | 一部完了 | repository・immutable source・release・downloaded DMG・Public videoの再生/visibility/尺はPASS。Devpost提出URLは提出後に確認する |

hosted demo、judge account、screenshots は、選んだ testing path または logged-in submission form が要求する場合だけ用意します。絶対パス、API key、個人情報を提出資料へ記載しません。

## 8. Re-verification before submission

2026-07-22 JST の public re-verification と、提出者本人が行う logged-in / artifact 確認を分けます。

- [x] Official Rules の内容
- [x] Updates の最新告知
- [x] FAQ の内容
- [x] deadline 表示
- [x] repository sharing addresses
- [x] video requirement
- [x] judging dates / test access requirement
- [ ] logged-in submission form の正確な fields
- [x] 実際に提出するSession IDをprivate evidenceでprimary threadと照合し、`/feedback` upload成功を確認
- [x] frozen product sourceとcurrent no-rebuild releaseのtag target、assets、SHA-256対応
- [ ] Devpost の Submitted 表示

## 9. 2026-07-22 public re-verification record

- Official Rules、Overview、FAQ、Schedule、Resources、Updates、Update 45371 を公式 page で確認した。
- OpenAI Build Week page は 2026-07-22 JST に取得可能で、同 page の judging 表示 Jul 22–Aug 7 を再確認した。
- deadline、4 tracks、public / private repository、3分未満の public video、Codex / GPT-5.6、Session ID、submission freeze、Developer Tools の no-rebuild testing path を再確認した。
- Update 45371 は、free tierとCodex credits、repositoryとteam確認、Devpostへの早期着手、動画の早期upload・incognito確認・Unlisted許容を案内している。
- Product source `44d9aab779b9a66ed3f02d0016af061a71ba79c3`、public judge prerelease、DMG SHA-256 `4f7e69832bf994d4a6935f95315532b52e6374b47fea9a48e23ac63a4322a27f`を匿名環境で再検証した。downloaded artifactのsidecar・manifest・bytes・canonical verifierとinstall/first-launch smokeはPASS。
- Primary Session IDはprivate evidenceで照合し、`/feedback` upload成功を確認した。値はpublic documentへ記載しない。
- logged-in submission formのfields・文字数、実際のvideo URL、Devpost submission URLは未確認。Session IDのDevpost fieldへの転記も未完了。
