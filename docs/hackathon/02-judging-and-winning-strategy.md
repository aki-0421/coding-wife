---
title: Judging and Winning Strategy
description: "審査基準を実装、デモ、READMEへ反映するための優先順位と証拠戦略を整理する。"
updated: 2026-07-15
read_when:
  - "実装やデモの優先順位を審査基準から決めるとき。"
  - "審査資料の証拠不足を点検するとき。"
last_verified: 2026-07-15 JST
---

# 審査基準と勝つための実装戦略

## 1. 審査プロセス

### Stage 1: pass / fail

最初に、次の baseline viability を満たすか判定されます。

- ハッカソンのテーマに合理的に合っている。
- 必須の API / SDK / 技術を合理的に使っている。
- このハッカソンでは、Codex と GPT-5.6 の実質的な利用が確認できる。

ここで落ちると、完成度やアイデア以前に Stage 2 へ進めません。

### Stage 2: 4基準を等しく評価

4基準は **equally weighted** です。公開されている具体的な点数スケールはありません。

1. Technological Implementation
2. Design
3. Potential Impact
4. Quality of the Idea

審査は複数ラウンド、複数パネルになる可能性があります。expert panel、peer review、automated AI-driven analysis、またはその組み合わせを使う可能性も規約に明記されています。

## 2. 同点時の優先順位

同点の場合、規約に記載された順に比較されます。

1. Technological Implementation
2. Design
3. Potential Impact
4. Quality of the Idea

つまり、4項目を均等に満たした上で、**技術実装が最初の tie-breaker** です。

## 3. 各基準を成果物に落とす

### 3.1 Technological Implementation

公式の問い:

- Codex をどれだけ徹底的・熟練して使ったか。
- genuine effort がコードに現れているか。
- working かつ non-trivial な実装か。

#### 強い証拠

- GPT-5.6 が主要ユーザーフローに組み込まれている。
- 単発プロンプトの wrapper ではなく、入力検証、tool use、状態管理、エラー処理、評価、再試行などがある。
- README に architecture と model call の位置が書かれている。
- テスト、lint、type check、CI の結果が確認できる。
- Codex が作業を加速した具体例と、人間が行った設計判断が書かれている。
- 主要 Codex thread の `/feedback` Session ID と commit history が整合する。
- 審査員がすぐに起動・操作できる。

#### 弱く見える例

- GPT-5.6 を「説明文生成」など端の機能にだけ使う。
- Codex の利用説明が「コードを書かせた」の一文だけ。
- 実装が動かず、動画だけが理想動作を示す。
- API key、環境、sample data、テスト手順が欠ける。

### 3.2 Design

公式の問い:

- working / runnable か。
- complete、coherent な product experience か。
- 単なる technical proof of concept で終わっていないか。

#### 強い証拠

- 初回利用から価値到達までの1本の導線が完成している。
- loading、empty、error、permission、retry の状態が整っている。
- デモで迷わず使える。
- 入力と出力に一貫性があり、ユーザーが次の行動を理解できる。
- 安全性・失敗時の説明・human control がプロダクト体験に含まれる。
- 見た目だけでなく、操作、フィードバック、速度、アクセシビリティを含めて coherent。

#### 期間内の優先順位

1. happy path を完成させる。
2. 致命的な failure path を処理する。
3. onboarding と demo data を整える。
4. 視覚的な polish を行う。

### 3.3 Potential Impact

公式の問い:

- real audience の real problem を、具体的かつ credible に解決しているか。
- デモされた内容が、その問題に実際に対処しているか。

#### 強い証拠

- 対象ユーザーを「誰でも」ではなく、具体的に定義する。
- 現状の作業、痛み、頻度、コストを示す。
- 1つの代表シナリオで before / after を示す。
- 時間短縮、精度向上、作業削減などの測定可能な仮説を置く。
- デモが説明した問題と直接つながっている。
- 制約や未解決点を正直に示し、現実的な導入経路を説明する。

#### 推奨の1文

> For [specific audience], [project] turns [painful current workflow] into [measurable outcome] by using GPT-5.6 to [essential capability].

### 3.4 Quality of the Idea

公式の問い:

- creative / novel か。
- 既存の concept とどう違うか。
- 問題領域を本当に理解しているか。

#### 強い証拠

- 既存解決策を2〜3個挙げ、違いを明確にする。
- 「AIを付けた」ではなく、GPT-5.6 だから可能になった interaction / workflow を示す。
- domain-specific constraints を扱う。
- trade-off と捨てた案を説明できる。
- 新規性を、機能数ではなく workflow の変化で示す。

## 4. 審査資料への evidence map

| 評価対象 | プロダクト | 動画 | README / repo | Devpost 説明 |
|---|---|---|---|---|
| Codex 利用 | 実装品質 | 具体的な作業例 | Codex collaboration、Session ID の説明 | 1〜2文で要約 |
| GPT-5.6 利用 | 中核フロー | 入力→処理→結果を見せる | model ID、architecture、役割 | なぜ必要かを説明 |
| Working | live demo | end-to-end を見せる | setup、test、sample data | demo URL |
| Design | 完成した導線 | onboarding→結果 | screenshots、UX decisions | 主な体験を簡潔に |
| Impact | 実際のユースケース | before / after | user、metric、limitations | problem / audience |
| Idea | 独自 workflow | 一目で分かる差別化 | alternatives、trade-offs | novelty の一文 |

## 5. 期間内の実装方針

### 5.1 problem-first

公式 Resources も「モデルからではなく問題から始める」と案内しています。

- まず real audience と painful task を固定する。
- GPT-5.6 の能力を、その問題に必要な理由へ結びつける。
- すべての追加機能が、4審査基準のどれを強化するか説明できなければ後回しにする。

### 5.2 narrow but complete

広い未完成プロダクトより、狭くても完結した体験を優先します。

- 代表ユーザー1種
- 代表 workflow 1本
- 代表入力 1〜3個
- 明確な成功状態
- 主要 failure への対応

### 5.3 judge-first testability

審査員はビルドしない可能性があります。

- hosted demo、sandbox、test account を用意する。
- 1クリックで sample scenario を開始できるようにする。
- README の最初に最短手順を書く。
- 動画だけでも価値と技術が分かるようにする。

### 5.4 Codex の使い方を「証拠化」する

Codex の使用量ではなく、成果への寄与を示します。

- scaffold、architecture、debug、test、refactor、security review などの役割を記録する。
- Codex 提案をそのまま採用せず、人間が変更した判断も残す。
- 主要スレッドを分散させ過ぎない。
- 最終日に `/feedback` が取れない事態を避け、早めにコマンドを確認する。

## 6. 提出前のセルフスコア

各項目を 0〜3 で採点します。

- 0: 証拠なし
- 1: 説明のみ
- 2: 動作・資料で確認可能
- 3: 動作、資料、テスト、デモが相互に整合

| 基準 | 0〜3 | 最低限の改善 |
|---|---:|---|
| Stage 1: Codex |  | Session ID、README、動画の具体例 |
| Stage 1: GPT-5.6 |  | 中核フロー・model ID・code path |
| Technological Implementation |  | working、non-trivial、tests |
| Design |  | end-to-end、error states、onboarding |
| Potential Impact |  | specific user、real problem、before/after |
| Quality of Idea |  | alternatives、novel workflow、domain insight |

**いずれかが1以下なら、機能追加より先に証拠と完成度を補強します。**

## Sources

- https://openai.devpost.com/rules
- https://openai.devpost.com/
- https://openai.devpost.com/resources
- https://openai.com/build-week/
