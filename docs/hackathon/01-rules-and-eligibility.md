---
title: Rules and Eligibility
description: "OpenAI Build Week 2026の参加資格、必須技術、プロジェクト要件、失格リスクを整理する。"
updated: 2026-07-22
read_when:
  - "参加資格やプロジェクト要件を判断するとき。"
  - "Codex、GPT-5.6、第三者素材の利用条件を確認するとき。"
last_verified: 2026-07-22 JST
---

# ルール・参加資格・プロジェクト要件

## 1. 参加資格

### 必須

- 個人 Entrant は、原則として居住地の法定成人年齢以上であること。
- 例外として Official Rules は、18歳未満または居住地の成人年齢未満の学生の Parent / Guardian も eligible entrant として明記している。未成年本人の役割、知財帰属、Representative、賞金受領の扱いは曖昧さが残るため、該当時は提出前に書面で確認する。
- OpenAI API services のサポート対象国・地域に居住していること。日本は対象に含まれる。
- 米国法または現地法により参加・賞金受領が禁止されていないこと。
- 個人、チーム、法人・非営利組織などの組織として参加できる。
- チームまたは組織は、提出を代表する1名の Representative を任命する。
- FAQ 上、各チームメンバーがそれぞれの居住国における参加資格を満たす必要がある。未成年学生を含むチームは、上記の Parent / Guardian 条項との関係を公式窓口へ確認する。

### チーム

- FAQ 上、チーム人数の上限はない。
- 1人が複数チームに参加したり、チーム参加と個人参加を併用したりできる。
- 賞品には実質的な人数制限がある。特に1位の DevDay/Exchange pass は最大2名分。
- 賞金はチーム代表者に支払われ、代表者がメンバー間の配分を行う。

### 参加不可の主な例

- Sponsor、Administrator、審査員、その関係者・家族・同居人など、利益相反がある者。
- ハッカソンの設計、制作、運営、有償プロモーション、配布に関与した者・組織。
- 現地法・米国制裁等により参加または賞金受領が禁止される地域の居住者・組織。

## 2. 作るもの

### 必須

- **Codex と GPT-5.6 を使った、動作するプロジェクト**を作る。
- アプリ、エージェント、Webサイト、ゲーム、ワークフロー、バックエンド、plugin、skill、MCP、developer tool など形式は問われない。
- 次の4トラックのうち、最も適合する1つを選ぶ。

| トラック | 主対象・例 |
|---|---|
| Apps for Your Life | 個人の日常。生産性、創作、家庭、家族、旅行、健康、個人金融など |
| Work and Productivity | チームや業務。自動化、サポート、分析、営業、バックオフィスなど |
| Developer Tools | 開発者向け。テスト、DevOps、agentic workflow、security など |
| Education | 学習者、教師、教育機関のために AI for education を前進させるもの |

### トラック選択の判断軸

- 技術方式ではなく、**主な利用者と主要ユースケース**で選ぶ。
- 複数トラックにまたがっても、1プロジェクトは1トラックのみ。
- Education は単に説明機能があるだけでなく、教育を主目的とするプロジェクトに向く。
- Developer Tools は開発者が直接利用するプロダクトに向く。

## 3. Codex と GPT-5.6 の利用

### 必須

- Codex の利用は必須。ChatGPT app、Codex CLI、IDE extension、SDK のいずれでもよい。
- GPT-5.6 の利用も必須。
- 他モデル、他社サービス、標準ライブラリ、SDK を併用できるが、Codex と GPT-5.6 が付随的・装飾的であってはならない。
- 現行 FAQ は、他モデルを併用しながら project の一部で GPT-5.6 を使うことを認め、Free plan の Codex では GPT-5.6 Terra を利用できると明記している。OpenAI の現行 model catalog は Sol、Terra、Luna をいずれも GPT-5.6 family として掲載している。
- 現行 FAQ は、要件を満たすために OpenAI API または API credits 自体は必須ではないと明記している。ただし、Codex と GPT-5.6 の実質的な利用を README、コード、動画で証明する要件は変わらない。
- README、説明文、デモ動画、コードから、両者をどのように使ったか確認できるようにする。
- 中核機能の大部分を作った主要 Codex スレッドで `/feedback` を実行し、Session ID を提出する。

### 安全側の解釈

FAQ は「GPT-5.6 がコードリポジトリとデモから確認できること」を求めているため、**Codex の内部モデルとして GPT-5.6 を選んだだけで済ませず、製品の主要フローでも GPT-5.6 を明示的・実質的に使う**のが安全です。

複数の GPT-5.6 family model を使う場合は、model名を列挙するだけでなく、それぞれの入力、出力、権限、主要価値への寄与を README と動画で説明します。

例:

- GPT-5.6 がユーザー入力を処理し、プロダクト固有の判断・生成・分析を行う。
- GPT-5.6 の出力を検証・構造化し、プロダクト機能として利用する。
- GPT-5.6 を外した場合に、主要価値が成立しない設計にする。

## 4. 新規プロジェクトと既存プロジェクト

### 新規

- Submission Period 中に新しく作成したものが対象。

### 既存

既存プロジェクトも参加できるが、次を満たす必要がある。

- Submission Period 開始後に、Codex または GPT-5.6 を使って意味のある拡張を行う。
- 評価対象は Submission Period 中に追加した作業のみ。
- 既存部分と新規部分を明確に区別する。
- タイムスタンプ付き Codex session log、日付付き commit history などの証拠を用意する。

### 安全側の推奨

- 既存リポジトリには baseline tag を付ける。
- `HACKATHON_CHANGES.md` または [09-evidence-log-template.md](./09-evidence-log-template.md) を使う。
- README に「Before Build Week」「Built during Build Week」を明示する。
- 既存機能の単なる UI 変更ではなく、審査対象として説明できる中核機能を追加する。

## 5. 動作要件

### 必須

- 対象プラットフォーム上で正常にインストール・起動できる。
- 動画および説明文で示した通りに動く。
- 審査員が確認できる working project へのアクセスを提供する。
- 審査用アクセスは無料で、Judging Period 終了まで制限なく利用できるようにする。
- private site の場合は testing instructions にログイン情報を含める。

### 審査員のテストについて

- 審査員は実際にテストする場合があるが、必須ではない。
- テキスト、画像、動画だけで評価することもある。
- 審査員はゼロからビルドする義務がない。

したがって、**動画だけでも価値が分かり、触る場合は即座に試せる**状態にする必要があります。

## 6. OSS、第三者サービス、データ

### 許可されるもの

- 標準ライブラリ、framework、open-source software/hardware。
- 第三者 SDK、API、データ。
- 第三者による技術支援。

### 条件

- 適用されるライセンス・利用規約を遵守する。
- API やデータを使う権限を持つ。
- 既存コードや第三者作業を開示する。
- OSS を使う場合は、その上に機能・価値を加える。
- 提出物全体が自分・チーム・組織のオリジナル作品であり、権利を保有する。
- 著作権、商標、特許、契約、プライバシー等の権利を侵害しない。

### 安全側の推奨

- `THIRD_PARTY_NOTICES.md` または README に依存関係・データ源・ライセンスを記載する。
- 生成物・学習素材・画像・音源の出所も記録する。
- API の Terms of Service が、デモ公開や審査アクセスを許容するか確認する。
- 秘密情報、顧客データ、契約上非公開のデータを投入しない。

## 7. 複数提出

- 1人・1チームが複数プロジェクトを提出できる。
- 各提出は unique かつ substantially different でなければならない。
- 各プロジェクトが受賞できる賞は1つ。

期間が短いため、評価基準を満たす完成度を優先し、通常は1件に集中する方が安全です。

## 8. Sponsor / Administrator からの支援に関する制限

Sponsor または Administrator から、ハッカソン終了前に資金・投資・契約開発・商用ライセンスなどの financial or preferential support を受けて開発されたプロジェクトは、失格となる可能性があります。該当可能性がある場合は、提出前に公式窓口へ確認してください。

## 9. Devpost Hackathons Plugin

- 利用は任意。使わなくても登録・参加・提出・受賞に不利益はない。
- Plugin は公式情報の source of truth ではない。
- Plugin の出力は不正確・古い可能性がある。
- Plugin と Official Rules が矛盾する場合、Official Rules が優先される。
- Plugin を使っただけでは十分な Codex 利用とはみなされない。実際のプロジェクト構築が必要。

## 10. 失格リスクを高めるもの

- Codex または GPT-5.6 の利用が確認できない、あるいは付随的。
- 動画・説明と実際の動作が一致しない。
- 既存プロジェクトで新規作業範囲を示せない。
- 第三者の権利・ライセンス・利用規約に違反する。
- 審査用アクセスが有料、期限切れ、壊れている、認証できない。
- submission deadline 後に提出内容を変更しようとする。
- 悪意あるコード、virus、spyware 等を含む。
- 規約違反、妨害、不正、利益相反。

## Sources

- https://openai.devpost.com/rules
- https://openai.devpost.com/details/faqs
- https://openai.devpost.com/
- https://openai.devpost.com/updates/45371-tuesday-last-minute-tips
