---
title: Sources, Conflicts, and Open Questions
description: "公式情報源の優先順位、確認済みの矛盾、未確認事項、再検証項目を管理する。"
updated: 2026-07-15
read_when:
  - "ハッカソン情報の根拠や矛盾を確認するとき。"
  - "agent-browserで公式情報を再検証するとき。"
  - "未確認事項を公式窓口へ問い合わせるか判断するとき。"
last_verified: 2026-07-15 JST
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

## 4. Important clarifications already available

### Credits

- $100 は Codex credits。
- OpenAI API credits / tokens は別途配布されない。
- product runtime で OpenAI API を使う場合は、自分の API billing が必要。
- credit request は registered participant が対象、在庫・承認条件付き。
- deadline は 2026-07-18 04:00 JST。
- one code per Entrant。

### Codex usage proof

- primary build thread で `/feedback` を実行する。
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
- ただし working project への access が必要。
- judge は rebuild する義務がない。
- plugin / developer tool は、rebuild 不要で試せる demo / sandbox / test account が必要。

## 5. Open questions

### 5.1 GPT-5.6 tier

規約は “GPT-5.6” とだけ記載し、Sol / Terra / Luna のどれが対象かを明示していません。OpenAI 公式 model docs では3つとも GPT-5.6 family です。

**安全側:** `gpt-5.6` alias / `gpt-5.6-sol` は要件名との対応が明確なので、exact model ID を記録しやすい。ただし唯一の許容 tier と断定はしない。Terra / Luna を eligibility 上の主要 path に使う場合は、Discord または Devpost で公式確認を取る。

### 5.2 GPT-5.6 は runtime 必須か

FAQ は「project must use GPT-5.6」「code repository と demo video で evidence を見る」「Codex と GPT-5.6 は incidental / decorative ではいけない」と記載しています。

**安全側:** Codex の内部モデルとして使っただけではなく、製品 runtime / core workflow に GPT-5.6 を統合する。

### 5.3 Submission form の正確なフィールド

ログイン前の公開ページからは、submission form の全フィールドと文字数制限を確認できません。

**対応:** 早めに Devpost draft を作り、必須欄と制限を確認する。

### 5.4 Pro Account prize の人数

Official Rules の表は Pro Account for 1 year と記載しますが、team の何名に付与されるか公開要約では明確ではありません。

**対応:** 受賞時の案内に従う。提案・予算には人数を仮定しない。

### 5.5 Judging access の保持期限

Official Rules の Judging Period と他ページの日程が不一致です。

**安全側:** demo、test account、private repo access を少なくとも 2026-08-13 JST の winner announcement まで維持する。

## 6. Questions to ask support only if relevant

- Terra / Luna を core product path で使っても GPT-5.6 要件を満たすか。
- private repository の具体的な共有方式・アカウント名。
- 日本語 narration + 英語 subtitle / transcript で translation requirement を満たすか。
- Sponsor / Administrator から過去に支援を受けた project の eligibility。
- 特殊 hardware が必要な project の testing 方法。
- under-age student と guardian entry の具体的な代表・賞金手続き。

Support:

- Devpost support: `support@devpost.com`
- OpenAI Build Week Discord: OpenAI Build Week page または Devpost Resources から参加
- Devpost Discussion Board: https://openai.devpost.com/forum_topics

## 7. Re-verification before submission

提出前日に次を再確認します。

- [ ] Official Rules の更新日時・内容
- [ ] Updates の新規告知
- [ ] FAQ の追加・修正
- [ ] deadline 表示
- [ ] repository sharing addresses
- [ ] video requirement
- [ ] `/feedback` Session ID field
- [ ] judging dates / test access requirement
- [ ] prize details
