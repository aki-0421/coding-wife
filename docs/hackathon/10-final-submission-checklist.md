---
title: Final Submission Checklist
description: "Coding Wifeの確定済みリポジトリ要件と、締切前に残る外部提出アクションを分離した最終チェックリスト。"
updated: 2026-07-22
read_when:
  - "提出前の残作業を優先順に確認するとき。"
  - "release、動画、Session ID、Devpost、匿名スモークを完了するとき。"
last_verified: 2026-07-22 JST
---

# 最終提出チェックリスト

締切は **2026-07-22 09:00 JST** です。現在の完了・未完了を混ぜず、上から順に止めずに閉じます。外部値の記録先とpaste-ready本文は [12-final-submission-materials.md](./12-final-submission-materials.md) です。

## 1. リポジトリ内で完了済み

- [x] Track は **Developer Tools**
- [x] Public repository は https://github.com/aki-0421/coding-wife
- [x] Project-owned code に root MIT `LICENSE` がある
- [x] `.env`、API key、credentialを提出物へ含めない方針とignore設定がある
- [x] Lockfile由来のnpm/Cargo inventory・noticeと、Live2D/Hiyoriの利用条件・provenanceがある
- [x] 公開release `v0.1.5` が存在する
- [x] `v0.1.5` は現行3-model/UIの証拠ではなく、older previewとして区別する
- [x] `gpt-5.6-sol` がmain coding sessionを担う
- [x] `gpt-5.6-luna` がprivacy checkを通るlive completed main messageからcaption・Live2D expression/motion・任意TTSを作る
- [x] `gpt-5.6-terra` が**Explain changes**からread-only commit evidenceを説明する
- [x] Chat UIは名前・時刻・成功checkを省き、failureだけを控えめな赤背景で示す
- [x] Git UIはGitHub-style **Commit changes**としてcommit・file・`+/-`・unified diffへ情報を絞る
- [x] Hosted demoとjudge accountは必須の構成要素ではない

## 2. Source freezeとcurrent release — 最優先

- [ ] Root README、hackathon docs、実装、動画台本のmodel role・UI名・操作を一致させる
- [ ] `git status --short` で意図しない変更がないことを確認する
- [ ] 最終source commitをpushし、公開repositoryから取得できることを確認する
- [ ] Frozen source SHAを記録する
- [ ] Frozen sourceから**現行機能を含む新しいrelease**を作る
- [ ] Release artifactのSHA-256を計算し、download後のSHA-256と一致させる
- [ ] Release notesへsupported platformsと、署名・notarization・既知制約の正確な状態を書く
- [ ] Fresh installでSol → Luna → Commit changes → Terraの流れを確認する
- [ ] Current release URLとSHA-256を最終提出資料へ記録する

`v0.1.5`だけで提出を閉じないでください。Developer Toolsはjudgeがゼロからrebuildせず試せるpathを必要とするため、現行releaseがsource-only説明より優先です。

## 3. 3分未満のデモ動画

- [ ] [08-demo-video-plan.md](./08-demo-video-plan.md) の現行2:50 scriptで収録する
- [ ] 実native appとdisposable repositoryを使う
- [ ] Solがmain taskを実行する場面を見せる
- [ ] 少なくとも2回、eligible completed main messageごとのLuna captionとLive2D expression/motionを見せる
- [ ] TTSを見せる場合、設定済みにしてkey画面は録画しない
- [ ] GitHub-style **Commit changes**でcommit、file、`+/-`、diffを見せる
- [ ] **Explain changes**を押し、Terraの結果を見せる
- [ ] Codexをどう使って構築したかとhuman decisionsを音声で具体的に説明する
- [ ] English audioが明瞭で、最終尺が**3:00未満**である
- [ ] key、token、email、notification、personal path、private URLが映っていない
- [ ] YouTubeへ早めにuploadし、processing完了を待つ
- [ ] Visibilityは安全側で**Public**にする
- [ ] ログアウト状態で映像・音声・URLを確認する
- [ ] Video URLを最終提出資料へ記録する

最新UpdateはUnlisted可と案内しますが、Official Rulesはpublicly visible、FAQはpublicと記載します。矛盾を避ける最も安全な設定はPublicです。

## 4. Codex Session ID

- [ ] Majority of core functionalityを作ったprimary threadを特定する
- [ ] そのthreadでまず `/feedback` を実行する
- [ ] `/feedback` がIDを表示しない場合は、同じthreadで `/status` を実行してSession IDを確認する
- [ ] Session ID、取得日時、frozen sourceとの対応をprivate evidenceへ保存する
- [ ] DevpostのSession ID fieldへ正確に入力する

Official Rulesと最新Updateは`/feedback` Session IDを要求し、最新Updateは`/feedback`を実行するよう案内します。一方FAQの取得手順は`/status`と書かれています。上記の順序なら両方を安全に満たせます。

## 5. Devpost form

- [ ] Project title: **Coding Wife**
- [ ] Taglineを入力する
- [ ] Track: **Developer Tools**
- [ ] English descriptionを本人の声として読み直して入力する
- [ ] Repository URL: https://github.com/aki-0421/coding-wife
- [ ] Current release URLとtesting instructionsを入力する
- [ ] Public YouTube URLを入力する
- [ ] Primary Codex Session IDを入力する
- [ ] Entrant情報、または全team memberとRepresentativeを確定する
- [ ] Teamの場合、全invitationが締切前にacceptedであることを確認する
- [ ] Formに表示された全required fieldを埋める
- [ ] Hosted demo、judge account、screenshotsは、formが要求するか実際に提供する場合だけ入力する
- [ ] Previewで改行、リンク、model名、制約を確認する
- [ ] Draftではなく**Submitted**にする
- [ ] My ProjectsでSubmitted表示を確認する
- [ ] Devpost URLとconfirmation evidenceを保存する

## 6. 匿名スモーク

ログアウトした別browser profileで行います。

- [ ] Devpost projectが開き、Submitted状態と全リンクを確認できる
- [ ] Public repositoryが開き、frozen commit、README、MIT license、noticesが確認できる
- [ ] Current releaseを認証なしでdownloadできる
- [ ] Downloaded artifactのSHA-256が公開値と一致する
- [ ] Fresh installから主要flowを完了できる
- [ ] Videoをログアウト状態で再生でき、3分未満・English audio・privacyを確認できる
- [ ] Session IDがprimary threadの記録と一致する
- [ ] Description、video、README、releaseが同じmodel rolesとUIを説明している
- [ ] Anonymous smokeの実施者・時刻・結果を保存する

## 7. Conditional — 未該当ならblockerにしない

- [ ] **Hosted demo:** 実際に提供する場合だけURL、uptime、free accessを確認する
- [ ] **Judge account:** Loginが必要な構成の場合だけcredentialとfresh loginを確認する
- [ ] **Screenshots / gallery:** Formが要求するか、評価に使う場合だけcurrent buildから作る
- [ ] **Private repository sharing:** Repositoryをprivateへ変更した場合だけ `testing@devpost.com` と `build-week-event@openai.com` へ締切前に共有する
- [ ] **Team invitations:** 個人提出なら未該当。Team提出の場合だけ全員のaccepted状態を確認する

## 8. 最終Go条件

次がすべてYesなら提出完了です。

- [ ] Current frozen releaseをjudgeがrebuildせず試せる
- [ ] VideoでSol、Luna、Terraの役割とworking flowが分かる
- [ ] Root READMEだけでsetup、testing、model integration、Codex contribution、limitationsが分かる
- [ ] Session IDがformへ入っている
- [ ] DevpostがSubmittedになっている
- [ ] Logged-out smokeが通っている
- [ ] 公式締切 **2026-07-22 09:00 JST** より前である

## Sources reverified on 2026-07-22 JST

- https://openai.devpost.com/rules
- https://openai.devpost.com/details/faqs
- https://openai.devpost.com/
- https://openai.devpost.com/updates/45402-deadline-tomorrow-last-minute-tips
