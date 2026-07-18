---
title: OpenAI Build Week 2026 — Hackathon Guide
description: "OpenAI Build Week 2026の要件、期限、提出準備資料への入口をまとめるハッカソンガイド。"
updated: 2026-07-18
read_when:
  - "OpenAI Build Weekの要件や提出準備の全体像を確認するとき。"
  - "ハッカソン関連文書の参照先を選ぶとき。"
  - "agent-browserで公式情報を再確認するとき。"
last_verified: 2026-07-15 JST
source_of_truth: https://openai.devpost.com/rules
---

# OpenAI Build Week 2026 — 実装・提出ガイド

このディレクトリは、OpenAI Build Week の公開情報を、実装・審査・提出で使える形に整理したものです。

## 管理ルール

- 文書の探索・読取・lint は `agent-docs` を使います。
- 公式Web情報の再確認は `agent-browser` を使い、Official Rulesを最優先します。
- Web情報を更新した場合は、front matterの `updated` と `last_verified` を更新します。
- `agent-browser` の検証スクリーンショットは `/tmp` またはignore済みの `tmp/` に置き、コミットしません。

> [!IMPORTANT]
> **Official Rules が最優先です。** Devpost の概要・FAQ・日程ページ、OpenAI のイベントページ、Devpost Hackathons Plugin と矛盾する場合は、Official Rules を採用してください。規約は変更される可能性があるため、提出直前に再確認してください。

## 最重要事項

- **提出期限:** 2026-07-21 17:00 PDT = **2026-07-22 09:00 JST**
- **Codex credits 申請期限:** 2026-07-17 12:00 PDT = **2026-07-18 04:00 JST**
- **必須技術:** Codex と GPT-5.6 を、どちらも実質的に使う
- **提出物:** 動くプロジェクト、1つのトラック、説明文、公開 YouTube デモ、コードリポジトリ、主要 Codex スレッドの `/feedback` Session ID
- **動画:** Official Rules に合わせて **3分未満**。音声で「何を作ったか」「Codex をどう使ったか」「GPT-5.6 をどう使ったか」を説明する
- **リポジトリ:** 公開なら適切なライセンスを付ける。非公開なら `testing@devpost.com` と `build-week-event@openai.com` に共有する
- **README:** セットアップ、必要なサンプルデータ、実行・テスト方法、Codex が加速した箇所、人間が行った重要判断、GPT-5.6 の統合箇所を明記する
- **審査:** 4基準が等配点。技術実装、デザイン、潜在的インパクト、アイデアの質
- **注意:** $100 の付与枠は Codex credits で、OpenAI API credits ではない。製品内で GPT-5.6 API を呼ぶ場合は、別途 API 課金・キー管理が必要

## 今すぐ行うこと

1. Codex credits をまだ申請していなければ、Devpost の Resources から申請する。
2. トラックを1つ決め、対象ユーザーと解決する問題を1文で固定する。
3. Codex の主要開発スレッドを1本作り、そのスレッドで中核機能を継続して実装する。
4. GPT-5.6 が製品の中核価値に必要になる設計にする。単なる飾りや付随機能にしない。
5. Git の開始点を固定し、既存プロジェクトならハッカソン前の部分と新規部分を明確に分ける。
6. 最初の1日で、審査員が触れる縦切りの動作デモを作る。
7. デモ動画素材と Codex 利用証跡を、実装と並行して保存する。

## ファイル一覧

| ファイル | 用途 |
|---|---|
| [01-rules-and-eligibility.md](./01-rules-and-eligibility.md) | 参加条件、プロジェクト要件、OSS・第三者素材、既存プロジェクト |
| [02-judging-and-winning-strategy.md](./02-judging-and-winning-strategy.md) | 審査基準を実装・デモ・README に落とす |
| [03-submission-requirements.md](./03-submission-requirements.md) | 提出物、動画、リポジトリ、テストアクセス |
| [04-timeline-jst.md](./04-timeline-jst.md) | PDT と JST の締切、公式ページ間の不一致 |
| [05-codebase-setup.md](./05-codebase-setup.md) | Codex、Git、証跡、再現可能性、API キー管理 |
| [06-prizes-ip-and-legal.md](./06-prizes-ip-and-legal.md) | 賞金、知財、広報利用、税・渡航費、法的条件 |
| [07-root-readme-template.md](./07-root-readme-template.md) | 提出用ルート README のテンプレート |
| [08-demo-video-plan.md](./08-demo-video-plan.md) | 2分45秒前後のデモ構成と英語ナレーション雛形 |
| [09-evidence-log-template.md](./09-evidence-log-template.md) | Codex、GPT-5.6、コミット、人間の判断の記録 |
| [10-final-submission-checklist.md](./10-final-submission-checklist.md) | 提出前の最終チェックリスト |
| [11-sources-and-open-questions.md](./11-sources-and-open-questions.md) | 情報源、矛盾、未確認事項、保守的な判断 |
| [12-final-submission-materials.md](./12-final-submission-materials.md) | Devpost入力、審査手順、動画台本、証跡台帳、匿名スモークの最終提出パッケージ |

## 情報の扱い

この資料では次のラベルを使います。

- **必須:** Official Rules または公式 FAQ に明記された要件
- **安全側の推奨:** 明文化された必須条件ではないが、失格や評価漏れを避けるための実務判断
- **要確認:** 公開情報に矛盾・曖昧さがあり、公式回答を得るのが望ましい項目

## 主要情報源

- Official Rules: https://openai.devpost.com/rules
- Overview: https://openai.devpost.com/
- FAQ: https://openai.devpost.com/details/faqs
- Resources: https://openai.devpost.com/resources
- Schedule: https://openai.devpost.com/details/dates
- OpenAI Build Week: https://openai.com/build-week/
