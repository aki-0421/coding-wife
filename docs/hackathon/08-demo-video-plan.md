---
title: Demo Video Plan
description: "3分未満の公開YouTubeデモを構成するための時間配分、台本、撮影チェック項目。"
updated: 2026-07-15
read_when:
  - "ハッカソンのデモ動画を企画、収録、編集するとき。"
  - "CodexとGPT-5.6の利用を動画で説明するとき。"
last_verified: 2026-07-15 JST
---

# 3分未満のデモ動画プラン

## 1. 推奨尺

**目標: 2分45秒、上限: 2分55秒**

Official Rules の “less than three minutes” に合わせ、3:00 ちょうどは避けます。

## 2. 165秒の構成

| 時間 | 内容 | 審査基準 |
|---:|---|---|
| 0:00–0:12 | project name、specific audience、problem | Impact / Idea |
| 0:12–0:25 | solution と track を1文で説明 | Idea / Fit |
| 0:25–1:35 | working product の end-to-end live demo | Design / Technical |
| 1:35–1:58 | GPT-5.6 が何をしているか、入力→処理→結果 | Technical |
| 1:58–2:23 | Codex workflow、加速した箇所、人間の重要判断 | Technical / Idea |
| 2:23–2:38 | real impact / before-after / metric | Impact |
| 2:38–2:45 | closing、demo / repo availability | Overall |

## 3. 必須チェック

- [ ] 3分未満
- [ ] public YouTube
- [ ] working project を見せる
- [ ] audio / voiceover がある
- [ ] 何を作ったか説明する
- [ ] Codex をどう使ったか説明する
- [ ] GPT-5.6 をどう使ったか説明する
- [ ] 英語、または英語訳付き
- [ ] 無許可の著作権音楽・素材・第三者商標を含めない

## 4. 画面構成

### 必ず見せる

- product の主画面
- representative input
- GPT-5.6 により価値が生まれる processing / result
- user が結果を確認・修正・利用する場面
- success state

### 可能なら見せる

- Codex の primary thread または diff を2〜5秒
- test / validation が通る場面
- architecture の簡単な図
- error handling や human control

### 避ける

- 長いタイトル animation
- 30秒以上の pitch deck
- terminal の小さな文字を延々見せる
- generic AI chat だけの画面
- 説明と無関係な機能巡回
- API key、email、個人情報、private repo URL の露出

## 5. 英語ナレーション雛形

```text
[0:00]
[Project Name] helps [specific audience] solve [specific problem].
Today, they usually [current painful workflow], which causes [cost or consequence].

[0:12]
We built a [track] project that turns [input] into [outcome].
Here is the complete workflow.

[0:25]
First, the user [action].
The app validates [important constraint] and sends [relevant context] to GPT-5.6.
GPT-5.6 then [essential reasoning / generation / tool-use task].
The result is checked by [schema / rules / user review] before it is shown.

[1:10]
The user can now [take meaningful action], reducing [time / steps / risk].
This is a live result from the working application.

[1:35]
GPT-5.6 is essential because [specific capability].
It is integrated in [component or code path], using model [exact model ID].
We also handle [validation, retries, safety, or failure case].

[1:58]
We used Codex for [architecture], [core implementation], and [testing or debugging].
For example, Codex helped us [specific contribution].
We made the key decision to [human decision] because [reason and trade-off].

[2:23]
For [audience], this changes [before] into [after].
Our next validation target is [credible metric or user test].

[2:38]
The live demo, repository, setup instructions, and testing path are included in our submission.
```

## 6. Codex 説明の良い例

弱い:

> We used Codex to generate the backend.

強い:

> We used Codex to scaffold the event pipeline, diagnose a race condition in tool execution, and generate integration tests. We rejected its first persistence design and chose an append-only event log so judges can replay every model decision.

重要なのは、**Codex の作業内容、成果、修正した判断**が具体的であることです。

## 7. GPT-5.6 説明の良い例

弱い:

> Our app uses GPT-5.6 for AI.

強い:

> GPT-5.6 converts an ambiguous support request into a validated action plan, selects tools under explicit constraints, and returns structured evidence. A schema validator and human approval gate prevent unreviewed actions.

## 8. 収録手順

1. demo data を固定する。
2. notification、private messages、password manager を閉じる。
3. browser zoom と font size を上げる。
4. product demo を無音で一度通す。
5. 画面収録と narration を別撮りしてもよい。
6. 英語 voiceover は AI-assisted が許可される。
7. 2:55 未満に編集する。
8. 1080p 以上で export する。
9. YouTube を public にする。
10. ログアウト状態・別端末で再生し、audio、字幕、URL を確認する。

## 9. 動画と提出資料の整合性

- model ID、機能名、track を README と一致させる。
- 動画で見せた demo URL が審査中も動くようにする。
- 動画収録後に UI を変えた場合、操作や結果が食い違っていないか確認する。
- mock / prerecorded output を使う場合は明示する。working project と誤認させない。

## Sources

- https://openai.devpost.com/rules
- https://openai.devpost.com/details/faqs
- https://openai.devpost.com/updates
