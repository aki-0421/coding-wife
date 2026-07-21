---
title: Demo Video Plan
description: "Coding WifeのSol・Luna・Terra、Live2D、GitHub-style Commit changesを3分未満で実証する英語動画台本と収録手順。"
updated: 2026-07-22
read_when:
  - "Coding Wifeの最終デモ動画を収録・編集するとき。"
  - "Codexと3つのGPT-5.6 modelの役割を動画で説明するとき。"
last_verified: 2026-07-22 JST
---

# 3分未満のCoding Wifeデモ動画

## 1. Recording contract

- **Target:** 2:50
- **Hard limit:** 3:00未満。Official Rulesの “less than three minutes” を採用する
- **Audio:** 明瞭なEnglish voiceover必須
- **Build:** Frozen sourceから作ったmacOS 14+ Apple Silicon current native build
- **Data:** 個人情報を含まないdisposable Git repository
- **Story:** Sol main session → privacy checkを通るcompleted messageごとのLuna/Live2D → reachable commit verification後のsilent Terra background generation → GitHub-style Commit changes → explicit explanation presentation

2026-07-22の最新UpdateはYouTubeのUnlistedを許容しますが、Official Rulesはpublicly visible、FAQはpublicと記載します。矛盾を避ける安全側の設定は **Public** です。

## 2. 2:50 shot list and exact English voiceover

| Time | Screen action | Exact English voiceover |
|---:|---|---|
| 0:00–0:12 | English localeのclean workspaceとLive2Dを見せる。 | “Coding Wife is a Live2D coding partner for developers who want agent work to feel collaborative and stay easy to review.” |
| 0:12–0:28 | READMEのUsage追加・verify・commitをmain sessionへ送る。 | “I give the main session a real repository task: add a Usage section, verify it, and commit the result. GPT-5.6 Sol is the only role with coding tools and write authority.” |
| 0:28–0:58 | Solのplanと最初のcompleted progress messageを見せる。 | “As Sol works, the app converts its activity into a focused timeline. There are no speaker labels, timestamps, or success badges competing with the actual work.” |
| 0:58–1:22 | 2つのeligible completed progress messageと、それぞれのLuna caption・expression/motionを見せる。任意TTSは1回だけ聞かせる。 | “Each safe completed Sol message triggers a separate GPT-5.6 Luna turn. Luna sees only a bounded sanitized excerpt, has no tools, and returns a short reaction that drives the caption, Live2D expression, motion, and optional speech.” |
| 1:22–1:35 | Tool kindとcommand nameだけのrowを見せる。可能ならrehearsed failureの薄い赤背景を短く見せる。 | “Tool activity is reduced to its type and command. Successful execution stays quiet; a failure is the only state that receives a warning background.” |
| 1:35–2:00 | **Commit changes**を開き、commitとfileを選び、`+/-`とline-number付きunified diffを見せる。 | “After Sol commits, the Git tab uses the information density of GitHub’s commit changes view: commit summary, changed files, additions and deletions, and a unified diff with old and new line numbers.” |
| 2:00–2:18 | Reachable commit verificationでTerraが既にsilent background startしたことを示し、**Explain changes**でcached/running resultをpresentする。 | “When this commit became reachable and verified, the native controller started Terra silently in the background. Explain changes presents that cache, or waits for the same running job; it never starts the first handoff or grants write access.” |
| 2:18–2:36 | Sol/Luna/Terraの3-role図、または3つのexact model IDを含む読みやすいcodeを見せる。 | “Sol builds, Luna maintains presence, and Terra reduces review effort. Typed TypeScript and Rust contracts pin all three models, validate their inputs and outputs, redact unsafe text, and fail closed.” |
| 2:36–2:50 | Codex implementation/test/QAの短いmontageからplatform-accurate closing cardへ。 | “We used Codex to implement, debug, test, and QA this pipeline, while humans chose its trust boundaries. The full judge path targets macOS 14 on Apple Silicon; Windows and Linux packages are install-smoked previews.” |

## 3. Rehearsal setup

### Freeze the scenario

- Solへのtask文を固定する。
- 1〜2ファイルだけが変わる短いtaskにする。
- 事前に同じtaskを通し、tool failureやmodel latencyで3分を超えないことを確認する。
- Demo repositoryは毎takeで同じseed commitから作り直す。
- Final takeで生成されたcommitをそのままGit tabで見せる。別takeのdiffへ差し替えない。

### Prepare the app

- English localeを選ぶ。
- Full three-model demoはmacOS 14+ Apple Siliconで行う。Windows/Linux packageはinstall smoke済みpreviewであり、同等のproduction Luna/Terra動作をclaimしない。
- Live2Dが確実にrenderされることを確認する。
- Luna caption、expression、motionを確認する。
- macOS-only TTSを使う場合だけ録画前に設定し、key入力画面は閉じる。
- **Commit changes**でcommit selector、file selector/search、diffが読みやすいwindow sizeを選ぶ。
- Reachable commit verification後、native controllerがTerraをsilent background startすることを確認する。
- **Explain changes**がcached explanationをpresentするか、同じrunning jobへpresentation intentを結び付けることを確認する。最初のTerra handoffをこの操作から開始しない。

### Prepare the desktop

- Notifications、mail、calendar、password manager、private terminalsを閉じる。
- Personal path、private repo name、email、tokenがwindow titleやmenuに出ない状態にする。
- Cursorを見せたい操作へ置き、文字が潰れないresolutionで収録する。
- Third-party musicや権利未確認footageを使わない。Voiceover-onlyでよい。

## 4. Required evidence in the final render

- [ ] Working native productである
- [ ] Solがreal repository taskを実行する
- [ ] Lunaがprivacy checkを通る**completed message**ごとに反応し、token streamごとの雑音になっていない
- [ ] LunaのcaptionとLive2D expression/motionが対応する
- [ ] Optional macOS-only TTSを使う場合、captionと同じ安全な内容だけを読む
- [ ] Chatにspeaker name、timestamp、成功checkがない
- [ ] Toolはkind iconとcommand nameに絞られている
- [ ] **Commit changes**にcommit、file、`+/-`、line numbers、unified diffがある
- [ ] Reachable commit verification後にTerraがsilent background startしている
- [ ] **Explain changes**はcached resultをpresentするか同じrunning jobをreuseし、最初のTerra handoffを開始しない
- [ ] Sol/Luna/Terraのexact model IDを音声または画面で確認できる
- [ ] Codexが実装・debug・test・QAへどう寄与したか説明する
- [ ] Humanがauthority separationとreview UXを決めたと説明する
- [ ] Repository、current macOS Apple Silicon release、Windows/Linux preview scopeをclosing cardに載せる

## 5. Do not show or say

- Older `v0.1.5` previewをcurrent feature buildとして見せない
- Solがcommit explanationを行うとは言わない
- **Explain changes**が最初のTerra generationをtriggerするとは言わない
- Lunaがraw code、diff、path、secretを読むとは言わない
- Internal observer、gate、producer、persisted property、risk tableをGit UIの価値として説明しない
- Speaker name、timestamp、success badgeがある旧Chat UIを使わない
- Generic shell/filesystem/Git authorityをWebViewが持つように説明しない
- Fixtureやpre-recorded outputをlive model resultとして見せない
- API key、auth token、personal email、notification、private URL、personal filesystem pathを映さない

## 6. Edit and publication sequence

1. Product screenだけを無音で通し、2:35以内に操作が収まるか確認する。
2. Screen recordingを撮る。Typingとloadingの無音区間は後でcutする。
3. Exact English scriptを自然な速度で録音する。AI-assisted narrationも可。
4. Narrationに合わせてscreen cutsを調整し、重要なcaption/diffを読む時間を残す。
5. Final durationを2:50前後、必ず3:00未満にする。
6. 1080p以上でexportし、全画面で文字と音声を確認する。
7. Privacy scanを行い、1frameでも秘密情報があれば撮り直す。
8. YouTubeへ早めにuploadし、processing完了後にPublicへ設定する。
9. Logged-out browserで再生し、visibility、audio、duration、description linkを確認する。
10. URL、duration、visibility、master SHA-256を [12-final-submission-materials.md](./12-final-submission-materials.md) に記録する。

## 7. Acceptance record

| Check | Result |
|---|---|
| Duration is below 3:00 | Record after export |
| English narration is audible | Record after playback |
| Sol/Luna/Terra roles are accurate | Record after content review |
| Terra auto-generation and explicit presentation are distinct | Record after content review |
| Full-flow platform is macOS 14+ Apple Silicon | Record after release review |
| Windows/Linux are labeled packaging previews | Record after release review |
| Current macOS UI and full-flow release match | Record after freeze |
| No secret or private data appears | Record after frame review |
| YouTube plays while logged out | Record after publication |

## Sources reverified on 2026-07-22 JST

- https://openai.devpost.com/rules
- https://openai.devpost.com/details/faqs
- https://openai.devpost.com/updates/45402-deadline-tomorrow-last-minute-tips
