---
title: Evidence Log Template
description: "Codex、GPT-5.6、コミット、人間の判断、検証結果を追跡する証跡ログのテンプレート。"
updated: 2026-07-15
read_when:
  - "Build Week中の実装証跡を記録するとき。"
  - "CodexとGPT-5.6の貢献を提出資料へまとめるとき。"
last_verified: 2026-07-15 JST
---

# Codex / GPT-5.6 / Build Week 証跡ログ

このファイルを `evidence/build-log.md` へコピーして使います。公開できない prompt・データ・credential は記録しないでください。

## 1. Project identity

| Field | Value |
|---|---|
| Project | |
| Track | |
| Team / representative | |
| Repository | |
| Baseline commit / tag | |
| Submission-period first commit | |
| Primary Codex surface | ChatGPT app / CLI / IDE / SDK |
| Primary GPT-5.6 model | |
| Primary Codex Session ID | 最終提出時に記入 |

## 2. Pre-existing vs new work

### Before Submission Period

| Component | Existing state | Evidence |
|---|---|---|
| | | commit / release / screenshot |

### Built or meaningfully extended during Submission Period

| Component | New work | Codex / GPT-5.6 role | Commit / PR |
|---|---|---|---|
| | | | |

## 3. Daily log

### YYYY-MM-DD JST

#### Goal

-

#### Codex work

| Time JST | Thread / task | Model | Codex contribution | Files / commands | Result |
|---|---|---|---|---|---|
| | primary / secondary | | | | |

#### Human decisions

| Decision | Alternatives | Why this choice | Trade-off | Evidence |
|---|---|---|---|---|
| | | | | issue / commit / doc |

#### GPT-5.6 product integration

| User flow | Model ID | Input | Output | Validation / guardrail | Test |
|---|---|---|---|---|---|
| | | | | | |

#### Verification

- [ ] lint
- [ ] typecheck
- [ ] unit tests
- [ ] integration tests
- [ ] end-to-end demo
- [ ] hosted smoke test
- [ ] README updated
- [ ] no secrets added

Commands / results:

```text
[paste concise, non-sensitive result]
```

#### Demo assets captured

- Screenshot / clip:
- What it proves:
- Safe for public use: yes / no

#### Risks / next step

-

## 4. Codex contribution summary

提出時に README と video script へ転記します。

| Area | What Codex did | What the team changed or decided | Final evidence |
|---|---|---|---|
| Architecture | | | |
| Core implementation | | | |
| Debugging | | | |
| Tests / evals | | | |
| UX / design | | | |
| Security / privacy | | | |
| Documentation | | | |

## 5. GPT-5.6 evidence map

| Requirement | Evidence in code | Evidence in demo | Evidence in README |
|---|---|---|---|
| Exact model is identified | | | |
| Use is meaningful, not decorative | | | |
| Core workflow calls GPT-5.6 | | | |
| Output is validated / controlled | | | |
| Failure path is handled | | | |
| Cost / latency is considered | | | |

## 6. Judging criteria evidence

| Criterion | Strongest proof | Remaining weakness | Action before freeze |
|---|---|---|---|
| Technological Implementation | | | |
| Design | | | |
| Potential Impact | | | |
| Quality of the Idea | | | |

## 7. `/feedback` record

| Field | Value |
|---|---|
| Date/time JST | |
| Codex thread purpose | |
| Majority of core functionality built here? | yes / no |
| Session ID | |
| Related commit range | |
| Saved in Devpost draft? | yes / no |

## 8. Final provenance

### Third-party code / libraries

| Item | Version | License | Use | Modified? |
|---|---|---|---|---|
| | | | | |

### Third-party APIs / data / assets

| Item | Terms / license | Authorization | Used in video? | Notes |
|---|---|---|---|---|
| | | | | |

### AI-generated assets

| Asset | Tool / model | Human edits | Rights checked | Location |
|---|---|---|---|---|
| | | | | |

## 9. Final integrity statement

- [ ] Description matches the current build.
- [ ] Video shows the current build.
- [ ] Existing and new work are accurately separated.
- [ ] Codex contribution is described accurately.
- [ ] GPT-5.6 role and model ID are accurate.
- [ ] Third-party rights and licenses are documented.
- [ ] No secret, personal data, or confidential information is exposed.
