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
- [x] Newly verified main-session commitでは、reachable commit verification後にnative controllerが`gpt-5.6-terra`をbounded read-only evidenceでsilent background startする
- [x] **Explain changes**は、newly verified pathではcached explanationをpresentするか同じrunning Terra jobへjoinする。まだ生成されていないexisting commitではbounded `user_request`を開始でき、failure後はbounded `user_retry`を開始できる
- [x] Chat UIは名前・時刻・成功checkを省き、failureだけを控えめな赤背景で示す
- [x] Git UIはGitHub-style **Commit changes**としてcommit・file・`+/-`・unified diffへ情報を絞る
- [x] Primary current full three-model judge targetはmacOS 14+ Apple Silicon
- [x] Windows 11 x64とUbuntu 22.04 / Debian 12-compatible Linux x64はinstall-smoked packaging previewで、production Luna/Terra parityを保証しない
- [x] Optional OpenAI TTS playbackはmacOS-only
- [x] Hosted demoとjudge accountは必須の構成要素ではない

## 2. Source freezeとcurrent release — 最優先

- [x] Root README、hackathon docs、実装、動画台本のmodel role・UI名・操作を一致させる
- [x] Product source commitをpushし、公開repositoryからHTTP 200で取得できることを確認する
- [x] Frozen product source SHAを`44d9aab779b9a66ed3f02d0016af061a71ba79c3`として記録する
- [x] Frozen product sourceとexact matchする**macOS 14+ Apple Silicon judge prerelease**を公開する
- [x] `Coding-Wife.dmg`のSHA-256 `4f7e69832bf994d4a6935f95315532b52e6374b47fea9a48e23ac63a4322a27f`を公開し、匿名download後のsidecar・manifest・bytes・canonical verificationと一致させる
- [x] Release fault-injection / packaging suite 39/39を通す
- [x] Downloaded DMGのinstall copy、10秒production launch、graceful shutdown smokeを通す
- [x] Release notesへmacOS scope、Codex/model prerequisites、Terra fail-closed、ad-hoc signing、not notarized、bounded Gatekeeper手順、既知制約を書く
- [x] Current macOS Apple Silicon judge release URLとSHA-256を最終提出資料へ記録する

現行no-rebuild pathは[Build Week judge prerelease](https://github.com/aki-0421/coding-wife/releases/tag/build-week-submission-2026-07-22)です。Repository defaultの`develop`と通常release `v0.1.5`は古いpreviewであり、現行3モデル連携の証拠には使いません。Install/first-launch smokeはartifactの起動可能性を証明しますが、fresh installでの3モデルruntime成功までを主張しません。Terraはprovider対応時のvalidated explanationと、非対応時のtyped unavailable / zero-tool / zero-write fail-closedの両方を正しい結果として扱います。

## 3. 3分未満のデモ動画

YouTubeへのupload・visibility設定は提出者が完了しました。2026-07-22 08:11 JSTに https://youtu.be/t3oyxB0aa9M の匿名再生、`isUnlisted=false`、165秒を確認済みです。title、description、YouTubeへ手動追加したSRTの状態は未確認のため完了扱いにしません。

- [x] [13-final-video-production-runbook.md](./13-final-video-production-runbook.md) の受理済み2:45 scriptで収録する
- [x] 実native Tauri app、real WKWebView / IPC / Rust backend、authenticated Codex runtime、disposable repositoryを使う
- [x] Solがmain taskを実行し、real commitと3件のpassing testを作る場面を見せる
- [x] 2回、eligible completed main messageごとのLuna captionとLive2D expression/motionを見せる
- [x] GitHub-style **Commit changes**で同じreal commit、file、`+/-`、diffを見せる
- [x] **Explain changes**から同じverified commitへのbounded Terra `user_request`と1回の`user_retry`を見せ、provider rejectionをtyped unavailable / zero-tool / zero-writeとして正確に説明する
- [x] Codexをどう使って構築したかとhuman decisionsを英語音声で具体的に説明する
- [x] English audioは−16.05 LUFS / −4.30 dBTPで、最終尺は165.000秒
- [x] English字幕を焼き込み、matching SRTを生成する
- [x] 4枚の1920×1080 screenshotをaccepted masterから抽出する
- [x] 全4,950 frameのblack/privacy OCR、secret、metadata、full decode検査を通す
- [x] key、token、email、notification、personal path、private URLが映っていない
- [x] YouTubeへ早めにuploadし、processing完了を待つ
- [x] Visibilityは安全側で**Public**にする
- [x] ログアウト状態で匿名再生、`isUnlisted=false`、165秒を確認する
- [ ] ログアウト状態で映像・音声・URLを確認する
- [x] Video URLを最終提出資料へ記録する

最新UpdateはUnlisted可と案内しますが、Official Rulesはpublicly visible、FAQはpublicと記載します。矛盾を避ける最も安全な設定はPublicです。

## 4. Codex Session ID

- [x] Majority of core functionalityを作ったprimary threadを特定する
- [x] そのthreadを照合し、`/feedback` uploadを成功させる
- [x] Session ID、取得日時、frozen product sourceとの対応をprivate evidenceへ保存する
- [ ] DevpostのSession ID fieldへ正確に入力する

Official Rules、[Update 45282](https://openai.devpost.com/updates/45282-openai-build-week-submissions-are-open-plugin-launch)、[Update 45362](https://openai.devpost.com/updates/45362-openai-build-week-halfway-there-where-are-you)は`/feedback` Session IDを要求し、主要build threadから取得するよう案内します。今回のprimary threadはprivate evidenceで照合済みで、`/feedback` uploadも成功しました。ID値はpublic documentationへ書かず、Devpost formへprivate recordから転記します。

## 5. Devpost form

このsectionは提出者がlogged-in formで手動実施します。自動入力・自動submit予定として扱いません。

- [ ] Project title: **Coding Wife**
- [ ] Taglineを入力する
- [ ] Track: **Developer Tools**
- [ ] English descriptionを本人の声として読み直して入力する
- [ ] Repository URL: https://github.com/aki-0421/coding-wife
- [ ] Current macOS Apple Silicon judge release URL、immutable source、testing instructionsを入力する
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
- [x] Public repositoryが開き、frozen product source、README、MIT license、noticesが確認できる
- [x] Current macOS Apple Silicon judge releaseの3 assetsを認証なしでdownloadできる
- [x] Downloaded artifactのSHA-256、manifest、bytes、canonical verificationが公開値・accepted local artifactと一致する
- [x] macOS 14+ Apple Siliconでdownloaded DMGのinstall copy、10秒production launch、graceful shutdown smokeを通す
- [ ] Videoをログアウト状態で再生でき、3分未満・English audio・privacyを確認できる
- [x] Private evidenceのSession IDがprimary threadの記録と一致する
- [ ] Description、video、README、current macOS releaseが同じmodel rolesとUIを説明している
- [ ] Windows/Linux artifactはpackaging previewと表示され、production Luna/Terra parityの証拠に使われていない
- [x] Repository / release匿名smokeの実施者・時刻・結果を保存する

## 7. Conditional — 未該当ならblockerにしない

- [ ] **Hosted demo:** 実際に提供する場合だけURL、uptime、free accessを確認する
- [ ] **Judge account:** Loginが必要な構成の場合だけcredentialとfresh loginを確認する
- [ ] **Screenshots / gallery:** Formが要求するか、評価に使う場合だけcurrent buildから作る
- [ ] **Private repository sharing:** Repositoryをprivateへ変更した場合だけ `testing@devpost.com` と `build-week-event@openai.com` へ締切前に共有する
- [ ] **Team invitations:** 個人提出なら未該当。Team提出の場合だけ全員のaccepted状態を確認する

## 8. 最終Go条件

次がすべてYesなら提出完了です。

- [x] Current frozen macOS 14+ Apple Silicon releaseをjudgeがrebuildせずdownload・launchできる
- [x] Videoのcausal demoでSol、Luna、Commit changes、Terra fail-closed boundaryの役割とworking flowが分かる
- [x] Root READMEだけでsetup、testing、model integration、Codex contribution、limitationsが分かる
- [ ] Session IDがformへ入っている
- [ ] DevpostがSubmittedになっている
- [ ] Logged-out smokeが通っている
- [ ] 公式締切 **2026-07-22 09:00 JST** より前である

## Sources reverified on 2026-07-22 JST

- https://openai.devpost.com/rules
- https://openai.devpost.com/details/faqs
- https://openai.devpost.com/
- https://openai.devpost.com/updates/45371-tuesday-last-minute-tips
