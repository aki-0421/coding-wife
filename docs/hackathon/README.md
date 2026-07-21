---
title: OpenAI Build Week 2026 — Hackathon Guide
description: "OpenAI Build Week 2026の要件、期限、提出準備資料への入口をまとめるハッカソンガイド。"
updated: 2026-07-22
read_when:
  - "OpenAI Build Weekの要件や提出準備の全体像を確認するとき。"
  - "ハッカソン関連文書の参照先を選ぶとき。"
  - "Web検索またはHTTP取得で公式情報を再確認するとき。"
last_verified: 2026-07-22 JST
source_of_truth: https://openai.devpost.com/rules
---

# OpenAI Build Week 2026 — 実装・提出ガイド

このディレクトリは、OpenAI Build Week の公開情報を、実装・審査・提出で使える形に整理したものです。

## 管理ルール

- 文書の探索・読取・lint は `agent-docs` を使います。
- 公式Web情報の再確認は利用可能なWeb検索またはHTTP取得手段を使い、Official Rulesを最優先します。
- Web情報を更新した場合は、front matterの `updated` と `last_verified` を更新します。
- 実アプリの検証にはWebdriverIOのQA専用Tauri経路を使い、logとスクリーンショットは`/tmp`またはignore済みの`tmp/desktop-qa/`に置いてコミットしません。

> [!IMPORTANT]
> **Official Rules が最優先です。** Devpost の概要・FAQ・日程ページ、OpenAI のイベントページ、Devpost Hackathons Plugin と矛盾する場合は、Official Rules を採用してください。規約は変更される可能性があるため、提出直前に再確認してください。

## 最重要事項

- **提出期限:** 2026-07-21 17:00 PDT = **2026-07-22 09:00 JST**
- **Codex credits:** 申請は終了し、2026-07-22の再確認でも全credits配布済み。配布済みcreditsの使用期限は **2026-07-22 09:00 JST**
- **必須技術:** Codex と GPT-5.6 を、どちらも実質的に使う
- **API:** OpenAI API の利用と API credits は必須ではない。製品 runtime で API を使う場合だけ、自分の API key と billing が必要
- **提出物:** 動くプロジェクト、1つのトラック、説明文、公開 YouTube デモ、コードリポジトリ、主要 Codex スレッドの `/feedback` Session ID
- **動画:** Official Rules に合わせて **3分未満**。音声で「何を作ったか」「Codex をどう使ったか」「GPT-5.6 をどう使ったか」を説明する
- **動画公開範囲:** Update 45402 は Unlisted 可としているが、Rules / Overview / FAQ を優先して安全側の **Public** にする
- **リポジトリ:** 公開なら適切なライセンスを付ける。非公開なら `testing@devpost.com` と `build-week-event@openai.com` に共有する
- **README:** セットアップ、必要なサンプルデータ、実行・テスト方法、Codex が加速した箇所、人間が行った重要判断、GPT-5.6 の統合箇所を明記する
- **Session ID:** 主要 build thread で `/feedback` を先に実行し、IDが表示されない場合や照合時だけ同じ thread で `/status` を使う
- **Developer Tools:** installation、supported platforms、審査員が rebuild せず試せる testing path が追加で必要
- **審査:** 4基準が等配点。技術実装、デザイン、潜在的インパクト、アイデアの質

## Coding Wife の現在地

Developer Tools track、public repository、MIT license、third-party notices は準備済みです。現行productは`gpt-5.6-sol`のmain coding session、`gpt-5.6-luna`のpresence director、`gpt-5.6-terra`のcommit explainerを分離しています。Product source は commit [`44d9aab779b9a66ed3f02d0016af061a71ba79c3`](https://github.com/aki-0421/coding-wife/tree/44d9aab779b9a66ed3f02d0016af061a71ba79c3) に固定し、同commitを指す[macOS judge prerelease](https://github.com/aki-0421/coding-wife/releases/tag/build-week-submission-2026-07-22)を公開・匿名検証済みです。主要build threadの`/feedback` uploadも成功し、Session IDはprivate evidenceへ保存済みです。

Repository defaultの`develop`と通常release `v0.1.5`は古いpreviewです。現行3モデル連携や最新UIの審査には、上記immutable sourceとjudge prereleaseだけを使います。受理済み2:45 masterはlocalで完成していますが、Public YouTube公開とDevpost formのsubmitは提出者によるmanual handoffとして未完了です。

締切までの critical path は次の順です。

1. 提出者が受理済みの3分未満・音声付きmasterをYouTubeへmanual uploadし、visibilityを**Public**にする。
2. 処理済みvideoをlogged-out状態で再生し、映像・音声・字幕・URLを確認する。
3. 提出者がDevpost formへimmutable source、judge prerelease、Public YouTube URL、private evidenceのSession IDを手動入力する。
4. 提出者がDevpost formを手動submitし、My Projectsで緑の**Submitted**表示を確認する。
5. video、repository、release、submission URLをlogged-out / fresh environmentで最終確認する。

hosted demo、judge account、screenshots は一律必須ではありません。選んだ testing path または logged-in form が要求する場合だけ用意します。

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
| [13-final-video-production-runbook.md](./13-final-video-production-runbook.md) | 受理済み2:45 master、字幕、スクリーンショット、media/privacy検査、公開handoffの記録 |

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
- Deadline update: https://openai.devpost.com/updates/45402-deadline-tomorrow-last-minute-tips
- OpenAI Build Week: https://openai.com/build-week/
