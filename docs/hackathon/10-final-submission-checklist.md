---
title: Final Submission Checklist
description: "参加資格からDevpost送信、デモ、リポジトリ、締切までを確認する最終チェックリスト。"
updated: 2026-07-15
read_when:
  - "提出前の最終確認を行うとき。"
  - "Devpost、動画、リポジトリ、審査アクセスをスモークテストするとき。"
last_verified: 2026-07-15 JST
---

# 最終提出チェックリスト

## A. Eligibility / rules

- [ ] 各チームメンバーが居住国・年齢の eligibility を満たす
- [ ] team / organization の Representative が決まっている
- [ ] Sponsor、Administrator、judge との conflict of interest がない
- [ ] track を1つだけ選んだ
- [ ] project が track と theme に明確に合う
- [ ] Codex を実質的に使用した
- [ ] GPT-5.6 を実質的に使用した
- [ ] 既存プロジェクトの場合、prior work と new work を分離した
- [ ] third-party tools、data、assets の権利・terms を確認した
- [ ] public repo の license を確認した

## B. Working product

- [ ] 動画で示す全機能が実際に動く
- [ ] fresh environment または clean browser で動作確認した
- [ ] setup command が成功する
- [ ] sample data / seed が機能する
- [ ] primary happy path が3分以内で試せる
- [ ] major error state を処理する
- [ ] API timeout / quota / auth failure を処理する
- [ ] hosted demo の cold start を確認した
- [ ] judge test account が有効
- [ ] judge access は無料
- [ ] demo / account / hosting を winner announcement まで維持できる

## C. GPT-5.6 evidence

- [ ] exact model ID が README にある
- [ ] model call の code path が分かる
- [ ] GPT-5.6 が core workflow に必要
- [ ] input / output / validation が説明されている
- [ ] demo で GPT-5.6 の結果を見せる
- [ ] other model を併用する場合、役割を明確にした
- [ ] API key は server-side のみ
- [ ] key、token、PII が repo / logs / video にない

## D. Codex evidence

- [ ] primary build thread を特定した
- [ ] その thread で core functionality の大部分を作った
- [ ] `/feedback` を実行した
- [ ] Session ID を保存した
- [ ] Session ID を Devpost draft に入力した
- [ ] README に Codex の具体的な貢献がある
- [ ] human decisions と trade-offs がある
- [ ] evidence log と commit history が整合する

## E. Repository

- [ ] repository URL が正しい
- [ ] public repo の場合 `LICENSE` がある
- [ ] private repo の場合、次の両方へ共有済み
  - [ ] `testing@devpost.com`
  - [ ] `build-week-event@openai.com`
- [ ] private invite が pending / expired でない
- [ ] README 冒頭に problem、solution、track、demo がある
- [ ] setup instructions がある
- [ ] supported platforms がある
- [ ] sample data instructions がある
- [ ] testing instructions がある
- [ ] fastest judging path がある
- [ ] architecture と GPT-5.6 integration がある
- [ ] Codex collaboration がある
- [ ] prior / new work の境界がある
- [ ] third-party notices がある
- [ ] `.env.example` がある
- [ ] `.env`、secret、credential、private data が Git history にない
- [ ] lint / typecheck / tests / build が通る

## F. Demo video

- [ ] 長さが3分未満
- [ ] public YouTube
- [ ] ログアウト状態で再生できる
- [ ] voiceover が聞き取れる
- [ ] 何を作ったか説明する
- [ ] Codex をどう使ったか説明する
- [ ] GPT-5.6 をどう使ったか説明する
- [ ] working end-to-end demo がある
- [ ] 英語、または完全な英語訳がある
- [ ] 無許可の音楽・素材・商標がない
- [ ] key、email、notification、private URL が映っていない
- [ ] README / current build と一致する

## G. Devpost form

- [ ] project title と tagline
- [ ] correct track
- [ ] English description
- [ ] public YouTube URL
- [ ] repository URL
- [ ] live demo URL
- [ ] `/feedback` Session ID
- [ ] team members
- [ ] testing instructions / credentials
- [ ] technology tags（フォームに表示された場合）
- [ ] screenshots / images（フォームに表示された場合）
- [ ] all required fields
- [ ] draft を一度保存した
- [ ] preview で layout と links を確認した

## H. Submission smoke test

別ブラウザまたは別メンバーで確認します。

- [ ] Devpost submission page が開く
- [ ] video が再生できる
- [ ] repo にアクセスできる
- [ ] demo が起動する
- [ ] judge account で login できる
- [ ] sample scenario が完了する
- [ ] expected result が出る
- [ ] instructions は英語だけで理解できる

## I. 締切管理

- [ ] 内部締切: 2026-07-21 23:00 JST までに submit
- [ ] 公式締切: **2026-07-22 09:00 JST**
- [ ] 締切後に submission を変更できないことを理解した
- [ ] confirmation / submission URL を保存した
- [ ] 最終 submission のスクリーンショットを保存した

## J. 最終判断

次の質問にすべて1文で答えられること。

- [ ] 誰の、どんな問題を解くのか
- [ ] 何が動くのか
- [ ] なぜ GPT-5.6 が必要なのか
- [ ] Codex が何を加速したのか
- [ ] 人間が行った重要判断は何か
- [ ] 既存解決策と何が違うのか
- [ ] 審査員はどう試すのか
