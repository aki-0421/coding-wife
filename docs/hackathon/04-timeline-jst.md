---
title: Timeline in PDT and JST
description: "OpenAI Build Week 2026の日程をPDTとJSTで整理し、公開ページ間の差異を記録する。"
updated: 2026-07-22
read_when:
  - "開発、提出、審査の日程をJSTで計画するとき。"
  - "締切や公開日程の不一致を確認するとき。"
last_verified: 2026-07-22 JST
---

# 日程 — PDT / JST

2026年7月の Pacific Time は PDT（UTC-7）、日本時間は JST（UTC+9）です。JST は PDT より16時間進んでいます。

> [!IMPORTANT]
> 提出期限は **2026-07-22 09:00 JST** です。公開ページ間の不一致は Official Rules を優先します。

## 1. Official Rules の日程

| 項目 | Pacific Time | Japan Time |
|---|---|---|
| Registration opens | 2026-07-09 10:00 PDT | 2026-07-10 02:00 JST |
| Submission opens | 2026-07-13 09:00 PDT | 2026-07-14 01:00 JST |
| Codex credits request deadline | 2026-07-17 12:00 PDT | **2026-07-18 04:00 JST** |
| Codex credits use deadline | **2026-07-21 17:00 PDT** | **2026-07-22 09:00 JST** |
| Registration / submission deadline | **2026-07-21 17:00 PDT** | **2026-07-22 09:00 JST** |
| Judging starts — Official Rules | 2026-07-22 10:00 PDT | 2026-07-23 02:00 JST |
| Judging ends — Official Rules | 2026-08-05 17:00 PDT | 2026-08-06 09:00 JST |
| Winners announced, around | 2026-08-12 14:00 PDT | 2026-08-13 06:00 JST |
| DevDay | 2026-09-29, time unspecified | 2026-09-29/30 JST, exact time TBD |

現行 Official Rules は、配布済み Codex credits の使用期限を Submission Period と同じ **2026-07-21 17:00 PDT / 2026-07-22 09:00 JST** としています。2026-07-22の再確認でもrequest formは終了し、Resourcesと最新Updateは全credits配布済みと案内しています。

## 2. 公式ページ間の不一致

### Judging Period

| 情報源 | 記載 |
|---|---|
| Official Rules | Jul 22 10:00 PT — Aug 5 17:00 PT |
| Devpost Schedule page | Jul 22 09:00 PDT — Aug 9 17:00 PDT |
| OpenAI Build Week page | Jul 22 — Aug 7 |

**判断:** Official Rules が他の資料に優先すると規約に明記されているため、ルール上は Aug 5 を採用します。ただし、demo / test account / hosting は安全側で **winner announcement まで維持**してください。

### Deadline の曜日

- 公式 Overview は「Tuesday, July 21」と記載。
- Update post の一部は「Monday, July 21」と記載。
- **2026-07-21 は火曜日**です。
- 日付・時刻 `2026-07-21 17:00 PDT` を基準にし、曜日表記の誤りは無視します。

### 動画時間

- Official Rules: less than 3 minutes
- FAQ: 3 minutes or under

**判断:** より厳しい Official Rules に合わせ、3:00 ちょうどを避けて 2:40〜2:50 にします。

## 3. 公式セッション — JST 換算

OpenAI Build Week page は **2026-07-22 JST に取得可能**で、以下の日程を再確認しました。すべて提出期限前の開催履歴です。

| セッション | Pacific Time | Japan Time |
|---|---|---|
| Discord office hours | Jul 15 10:00 PDT | Jul 16 02:00 JST |
| OpenAI Academy: Codex Sites | Jul 16 12:00 PDT | Jul 17 04:00 JST |
| Discord office hours | Jul 17 20:30 PDT | Jul 18 12:30 JST |
| Discord office hours | Jul 20 10:00 PDT | Jul 21 02:00 JST |
| Livestream with Corey Ching | Jul 20 11:00 PDT | Jul 21 03:00 JST |
| OpenAI Academy: Codex for Creative Building | Jul 21 08:30 PDT | Jul 22 00:30 JST |

Support / announcements:

- OpenAI Discord の `#build-week-chat`
- `#hackathon-announcements`
- `#office-hours`
- Devpost Discussion Board

## 4. 提出当日の critical path

提出直前の公式 Update 45402 は、deadline の約3時間前までの submit、動画の早期 upload、fresh testing、Devpost の **Submitted** 表示確認を推奨しています。残り時間が3時間未満なら、順番を保ったまま即時に進めます。

| Deadline まで | 完了状態 |
|---|---|
| T-3h 以前 | source freeze、現行 no-rebuild release 公開、動画 upload、Devpost form 入力 |
| T-2h | fresh environment で project / release を確認し、logged-out 状態で public links を確認 |
| T-1h | 新機能を止め、Session ID・commit・動画・repo・release の対応を最終照合 |
| T-30m | Devpost を submit。My Projects で緑の **Submitted** 表示を確認し、記録を保存 |
| **2026-07-22 09:00 JST** | 公式締切。draft、team invitation pending、未共有 private repo を残さない |

## 5. 最終24時間の禁止事項

- 大規模な dependency upgrade
- architecture の全面変更
- primary model / API provider の差し替え
- auth / database migration の無検証変更
- 動画と実装が食い違う変更
- 証跡を残さない squash / history rewrite

## Sources

- https://openai.devpost.com/rules
- https://openai.devpost.com/details/dates
- https://openai.devpost.com/updates/45402-deadline-tomorrow-last-minute-tips
- https://openai.com/build-week/
