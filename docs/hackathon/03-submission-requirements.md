---
title: Submission Requirements
description: "Devpost提出物、デモ動画、リポジトリ、審査アクセスの必須要件を整理する。"
updated: 2026-07-22
read_when:
  - "提出物やDevpost入力項目を準備するとき。"
  - "動画、リポジトリ、審査アクセスの条件を確認するとき。"
last_verified: 2026-07-22 JST
---

# 提出要件

> [!IMPORTANT]
> 公開ページ間で内容が食い違う場合は Official Rules を優先します。提出期限は **2026-07-22 09:00 JST** です。

## 1. 必須提出物

- [ ] Codex と GPT-5.6 で作った working project
- [ ] 4トラックから1つ選択
- [ ] Project description
- [ ] 公開 YouTube demo video
- [ ] Code repository URL
- [ ] 主要開発スレッドの `/feedback` Codex Session ID
- [ ] plugin / developer tool の場合、追加の installation・platform・testing 情報

OpenAI API の利用と API credits は必須ではありません。一方、Codex と GPT-5.6 の両方を project の構築に実質的に使い、incidental / decorative な利用にしないことは必須です。製品 runtime で OpenAI API を使う場合だけ、自分の API key と billing を用意します。

## 2. Project description

最低限、次を説明します。

1. 対象ユーザー
2. 解決する具体的な問題
3. プロジェクトが何をするか
4. 主要機能と workflow
5. GPT-5.6 がどこで何をしているか
6. Codex をどう使って構築したか
7. なぜ選んだトラックに合うか
8. 動作確認方法

説明は動画・README・実際の動作と一致させます。

## 3. Demo video

### Official Rules に基づく必須条件

- **3分未満**にする。
- YouTube に upload し、public にする。
- working project の clear demo を含める。
- audio / voiceover を含める。
- 音声で次の3点を説明する。
  - 何を作ったか
  - Codex をどう使ったか
  - GPT-5.6 をどう使ったか
- 第三者の商標、著作権で保護された音楽・素材を、許可なく含めない。
- 英語で作るか、英語訳を提出する。

### 安全側の推奨

- 長さは **2分40秒〜2分50秒**を目標にする。
- 日本語話者でも、AI-assisted の英語 voiceover が許可されているため、英語音声で作ると翻訳要件の曖昧さを減らせる。
- 提出直前の Update 45402 は Unlisted でもよいとしているが、Official Rules は publicly visible、Overview と FAQ は public としている。情報源の優先順位に従い、**YouTube の visibility は Public** にする。
- 音楽は使わないか、権利を明確に確認できるものだけにする。
- Codex 画面の表示は必須ではないが、短く見せると Technological Implementation の証拠になる。
- product demo を最優先し、スライド説明だけで終わらせない。
- YouTube の公開状態を別ブラウザ・ログアウト状態で確認する。

詳細は [08-demo-video-plan.md](./08-demo-video-plan.md) を使用してください。

## 4. Code repository

### 公開リポジトリ

- relevant licensing を付ける。
- `LICENSE` を配置し、依存ライセンスも確認する。
- secrets、API key、personal data を含めない。

### 非公開リポジトリ

次の両方に共有する。

- `testing@devpost.com`
- `build-week-event@openai.com`

締切前に共有を完了し、招待が pending のままになっていないか確認してください。

### README の最低要件

- セットアップ手順
- 必要な sample data
- 実行方法
- テスト方法
- Codex とどのように協働したか
- Codex が workflow を加速した具体的箇所
- 人間が行った product / engineering / design 上の重要判断
- GPT-5.6 の統合箇所と役割
- 既存プロジェクトの場合、prior work と Build Week 中の新規作業の境界

[07-root-readme-template.md](./07-root-readme-template.md) をコピーして使えます。

## 5. `/feedback` Codex Session ID

### 必須

- Official Rules、Overview、提出当日 Update が要求する提出項目名は `/feedback` Codex Session ID。
- 中核機能の大部分を作った Codex thread で、まず `/feedback` を実行する。
- 取得した Session ID を Devpost submission form に入力する。
- test thread や横道の会話ではなく、主な build thread を選ぶ。

FAQ の取得手順だけは `/status` で Session ID を表示すると案内しています。安全側では、**主要 thread で `/feedback` を先に実行し、IDが表示されない場合や照合が必要な場合だけ、同じ thread で `/status` を実行**します。別 thread のIDで代用しません。

### 複数スレッドを使った場合

- core functionality の大部分を作った、最も代表的な1本を提出する。
- README には、他スレッドを含む Codex の役割を説明する。

### 安全側の推奨

- 最初から主要スレッドを1本決める。
- `/feedback` と、必要時の `/status` が同じ Session ID を指すことを確認する。
- Session ID、取得日時、対応 commit を evidence log に保存する。

## 6. Testing access

### 全 project の必須条件

- intended platform で正常に install・起動でき、動画と説明どおりに動く状態にする。
- website、functioning demo、test buildのいずれかでworking projectへのaccessを提供する。
- 審査用に選んだ access path は、Official RulesのJudging Period終了まで無料かつ制限なく利用できる状態を保つ。
- Private siteを使う場合だけ、testing instructionsへjudge用login情報を記載する。

### Plugin / Developer Tool の追加要件

- installation instructions
- supported platforms
- 審査員がゼロから rebuild しなくても試せる方法
  - demo instance
  - sandbox
  - test account
  - prebuilt binary / package など

Coding Wife は Developer Tools track の desktop app なので、installation instructions、supported platforms に加え、**frozen source と一致する prebuilt release を no-rebuild testing path として用意**します。

### 条件付き項目と安全側の推奨

- hosted demo は一律必須ではありません。選んだ testing path が hosted service の場合だけ、judge account と利用手順を用意します。
- test account を使う場合は審査用に限定し、他のデータへアクセスできないようにします。
- screenshots は公開要件に明記されていません。Devpost の logged-in form が要求する場合だけ用意します。
- judge が private API key を用意しなくても、少なくとも提出動画と no-rebuild artifact から中核フローを評価できる状態にします。
- rate limit、quota、期限、sleep、cold start を提出前に確認する。
- 審査日程に不一致があるため、少なくとも winner announcement までは demo を維持する。

## 7. 英語要件

- 全 submission materials は英語、または英語訳付きで提出する。
- 対象は demo video、text description、testing instructions、その他提出資料。

安全側では、次を英語化します。

- Devpost description
- README の冒頭と setup / testing section
- video narration
- test account instructions
- screenshots 内の重要 UI text、または英語字幕

日本語併記は問題ありませんが、英語だけで審査可能な状態にしてください。

## 8. 提出後の変更

- 締切前は draft 保存や編集ができる。
- submit 後でも締切前なら FAQ 上は編集可能。
- Submission Period 終了後は、submission の内容を変更できない。
- Devpost portfolio 上の project は更新できても、審査対象 submission は固定される。
- 例外的に、権利侵害、個人情報、不適切素材の除去・置換を Sponsor / Devpost が許可する場合があるが、実質的内容は変えられない。

## 9. 提出フォームで要確認の項目

公開ページだけでは、ログイン後の submission form の全フィールドを確認できません。Devpost にログインして draft を作り、次を確認してください。

- title / tagline の文字数
- description の欄構成
- track の選択方法
- video URL
- repository URL
- demo URL
- `/feedback` Session ID 欄
- team member invitation
- team member invitation の受諾状態（全員が締切前に accept 済みか）
- built with / technology tags
- screenshots / image requirements
- private testing instructions の入力場所

## 10. Coding Wife の提出準備状況 — 2026-07-22 JST

| 項目 | 状態 | 提出判断 |
|---|---|---|
| Track | 完了 | Developer Tools |
| Public repository | 完了 | 公開 repository URL を提出する |
| License / notices | 完了 | MIT license と第三者 notice を維持する |
| Public release v0.1.5 | 参考用のみ | default `develop`と同様に古いpreviewのため、現行3モデル連携や最新UIの証拠には使わない |
| Frozen product source | 完了 | [`44d9aab779b9a66ed3f02d0016af061a71ba79c3`](https://github.com/aki-0421/coding-wife/tree/44d9aab779b9a66ed3f02d0016af061a71ba79c3)をimmutable judge sourceとして公開済み |
| No-rebuild release | 完了 | [macOS judge prerelease](https://github.com/aki-0421/coding-wife/releases/tag/build-week-submission-2026-07-22)を公開し、匿名download・SHA/manifest/byte一致・canonical verify・install/first-launch smokeを確認済み。release suiteは39/39 PASS |
| Public YouTube video | 未完了 | 3分未満、音声付き、Public で upload する |
| Primary Session ID | 入力待ち | 主要build threadを照合し、`/feedback` upload成功とSession IDをprivate evidenceへ保存済み。Devpost fieldへ入力する |
| Devpost submission | 未完了 | form 入力後、draft ではなく Submitted を確認する |
| Anonymous smoke test | 一部完了 | repository・immutable source・release・3 assetsはPASS。video・提出URLは公開後に確認する |

## 11. 提出当日の順序

提出直前の Update 45402 は、動画を早く upload し、project を fresh に test し、提出後に Devpost の My Projects で **Submitted** 表示を確認するよう案内しています。

1. 完成済み動画を早めにYouTubeへuploadし、処理完了後にPublic URLを取得する。
2. 動画をlogged-out状態で再生し、3分未満・音声・字幕・privacyを確認する。
3. Devpost formへimmutable source、judge prerelease、Public YouTube URL、private evidenceのSession IDを入力する。
4. Devpost formをsubmitし、My Projectsで緑の**Submitted**表示を確認する。
5. project、release、repository、動画をfresh / logged-out状態で確認する。
6. deadline前に、公開リンクとrepository permissionsをもう一度確認する。

## 12. 提出直後

- confirmation page と submission URL を保存する。
- ログアウト状態で video、public repo、demo URL を開く。
- private repo の共有先2件を再確認する。
- test account で fresh login を行う。
- submission のスクリーンショットまたは PDF を保存する。
- 締切前なら誤字・リンク切れを修正する。

## Sources

- https://openai.devpost.com/rules
- https://openai.devpost.com/details/faqs
- https://openai.devpost.com/
- https://openai.devpost.com/updates/45402-deadline-tomorrow-last-minute-tips
