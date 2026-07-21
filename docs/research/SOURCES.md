---
title: "出典台帳"
description: "調査資料で参照するOpenAI、Tauri、Live2D、Git、セキュリティ、Human-AI Interactionの出典と確認論点を管理する。"
updated: 2026-07-21
last_verified: 2026-07-21
read_when:
  - "調査結論の根拠を確認する、または公開情報を再検証して出典を更新するとき。"
---

# 出典台帳

- 最終確認日: 2026-07-21（JST）
- 方針: 公式ドキュメント、仕様、標準、一次研究、公式ソースコードを優先した。
- 注意: 製品・モデル・SDKの仕様は更新される。要件確定時、実装開始時、リリース候補作成時に再確認すること。

本文中の出典IDは、このファイルの見出しへリンクする。複数ページを一つのIDに束ねている場合は、それらを合わせて一つの設計論点を裏付ける。

## OpenAI / Codex

## OAI-01

**Codex App Server — 公式プロトコル資料および公式ソースコード**

- Codex App Server: <https://developers.openai.com/codex/app-server>
- Codex App Server README: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- Codex App Server client: <https://github.com/openai/codex/tree/main/codex-rs/app-server-client>
- App Server protocol `ThreadStartParams`: <https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs>
- Codex CLIからApp Serverへ開始パラメータを渡す公式実装: <https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs>

確認に用いた論点:

- `stdio`上のJSONLによる双方向通信と初期化手順。
- スレッド、ターン、項目、ストリーミングイベント、承認、差分、計画、レビュー。
- `model/list`と実験機能の列挙。
- `tool/requestUserInput`、動的ツール、MCP elicitation。
- `review/start`のコミット、未コミット差分、ベースブランチ、分離レビュー。
- `ephemeral`開始パラメータとスレッド属性。

`ephemeral`は重要なプライバシー前提だが、CLI/App Serverのバージョン差や回帰不具合の影響を受け得る。本文で「自動監査」と「対応バージョン固定」を公開ゲートにしているのは、そのためである。

## OAI-02

**Codex Authentication — 公式認証資料**

- <https://developers.openai.com/codex/auth>

確認に用いた論点:

- ChatGPTサインインによるサブスクリプション利用と、APIキーによる従量課金利用の区別。
- CLI、IDE、ローカルデスクトップ環境のログインフロー。
- 認証キャッシュと資格情報ストアの扱い。

## OAI-03

**OpenAI Models — GPT-5.6ファミリーの公式モデル一覧**

- <https://developers.openai.com/api/docs/models>

確認に用いた論点:

- `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`の位置づけ。
- モデルID、対応する推論強度、コンテキスト等の現行情報。

価格、上限、モデル可用性は変動し得るため、本文では固定値を製品要件にせず、実行時の`model/list`をCodexセッション側の正本にする。

## OAI-04

**Reasoning models / App Server model discovery — 公式推論設定資料**

- Reasoning models: <https://developers.openai.com/api/docs/guides/reasoning>
- Codex App Serverの`model/list`: <https://developers.openai.com/codex/app-server#list-models-modellist>

確認に用いた論点:

- 推論強度はモデルとは別の実行設定であること。
- クライアントが、利用可能なモデルと対応する推論強度を実行時に列挙できること。
- 本アプリではモデル選択を隠し、固定モデルに対して利用可能な推論強度だけを出すという設計。

## OAI-06

**Model Context Protocol in Codex — 公式MCP資料**

- <https://developers.openai.com/codex/mcp>

確認に用いた論点:

- CodexからMCPサーバーへ接続する構成。
- ツール公開、設定、認証、承認境界。
- Live2D制御やアプリ固有操作を、無制限の汎用ツールではなく狭い意味APIとして公開する根拠。

MCP自体の脅威と防御については[SEC-04](#sec-04)も参照する。

## OAI-07

**Text to speech — 公式音声合成資料**

- <https://developers.openai.com/api/docs/guides/text-to-speech>

確認に用いた論点:

- 音声合成API、ストリーミング、対応形式。
- AI生成音声であることを明示する必要性。
- 音声モデル・音声種別の可用性が変化するため、製品で固定値を埋め込まず設定・能力検出を行うべきこと。

読み上げ機能はCodexサブスクリプションとは別のAPI利用になり得るため、本文では既定オフ、明示設定、別資格情報としている。

## OAI-08

**Codex permission profiles と 0.144.5 support-runtime isolation — 公式資料・公式ソース**

- Permission profiles: <https://learn.chatgpt.com/docs/permissions>
- Codex release `rust-v0.144.5`: <https://github.com/openai/codex/releases/tag/rust-v0.144.5>
- `shell_tool=false` の shell tool 無効化: <https://github.com/openai/codex/blob/87db9bc18ba5bc82c1cb4e4381b44f693ee35623/codex-rs/tools/src/tool_config.rs#L81-L115>
- environment、core utility、MCP、dynamic tool の登録条件: <https://github.com/openai/codex/blob/87db9bc18ba5bc82c1cb4e4381b44f693ee35623/codex-rs/core/src/tools/spec_plan.rs#L606-L759>
- `thread/start` の environment、runtime root、permission profile と response provenance: <https://github.com/openai/codex/blob/87db9bc18ba5bc82c1cb4e4381b44f693ee35623/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L56-L195>
- request user input / orchestrator capability の既定解決: <https://github.com/openai/codex/blob/87db9bc18ba5bc82c1cb4e4381b44f693ee35623/codex-rs/core/src/config/mod.rs#L2473-L2485>

確認に用いた論点:

- Permission profile が local sandboxed command の filesystem / network を制約し、macOS では Seatbelt で強制されること。
- 強制できない policy を unsandboxed で続行せず、command を拒否すること。
- 0.144.5 では shell tool と environment-dependent tool を明示的に除去できること。
- `update_plan`のinternal handlerは通常threadに残る一方、production modelの実Responses wireでは`tools` field不在になり得ること。したがってsource上のhandler登録とwire-advertised tool 0を分離し、internal plan eventもapp policyで拒否する必要があること。
- environment、MCP、dynamic tool、orchestrator skill、request user input の未指定既定に依存せず、clean config と実 wire capture で確認する必要があること。

公式 source は moving `main` ではなく `rust-v0.144.5` の peeled commit `87db9bc18ba5bc82c1cb4e4381b44f693ee35623` に固定した。Codex 更新時は同じ source path だけでなく、generated schema と mock Responses wire probe も再実行する。

## Tauri

## TAU-01

**Tauri 2 — 公式概要・アーキテクチャ**

- Tauri 2: <https://v2.tauri.app/>
- Architecture: <https://v2.tauri.app/concept/architecture/>

確認に用いた論点:

- RustバックエンドとOSネイティブWebViewを組み合わせる構成。
- WebViewとRust間をメッセージパッシングで接続する責務分離。
- 単一コードベースによる複数OS対応。

## TAU-02

**Tauri Prerequisites — OS別依存関係**

- <https://v2.tauri.app/start/prerequisites/>

確認に用いた論点:

- LinuxのWebKitGTK、macOSのXcode系ツール、WindowsのC++ Build ToolsとWebView2。
- OSごとにビルド環境とレンダリング基盤が異なること。

## TAU-04

**Tauri Shell plugin — 子プロセス実行と権限**

- <https://v2.tauri.app/plugin/shell/>

確認に用いた論点:

- 子プロセス起動機能。
- 実行許可を明示する権限モデル。
- フロントエンドへ汎用シェル権限を渡さず、Rust側の限定コマンドへ閉じ込める必要性。

## TAU-05

**Embedding External Binaries / Sidecar — 公式サイドカー資料**

- <https://v2.tauri.app/develop/sidecar/>

確認に用いた論点:

- 外部バイナリの同梱、起動、引数、プラットフォーム別命名。
- `spawn` / `execute`に対する明示的な権限。

本案ではCodexを必ず同梱するとは限らず、既存CLI検出を第一候補、互換性を固定した同梱方式を代替案として比較する。

## TAU-06

**Tauri Capabilities — 公式権限境界**

- <https://v2.tauri.app/security/capabilities/>

確認に用いた論点:

- ウィンドウ/WebView単位で許可・拒否を制約する能力モデル。
- 複数Capabilityに属すると権限が合成されるため、境界設計に注意が必要なこと。

## TAU-07

**Content Security Policy — Tauri公式セキュリティ資料**

- <https://v2.tauri.app/security/csp/>

確認に用いた論点:

- ローカルアプリでもCSPを適用し、スクリプト・画像・接続先を制限すること。
- リモートコンテンツや不必要な`unsafe-*`を避けること。

## TAU-08

**Tauri File System plugin — 公式ファイルアクセス資料**

- <https://v2.tauri.app/plugin/file-system/>

確認に用いた論点:

- BaseDirectoryと許可スコープ。
- パストラバーサル防止。
- キャラクターモデルのインポートを、任意パスへの恒久的な権限ではなく、選択されたファイルと管理領域へ限定する設計。

## TAU-09

**Tauri Stronghold — 公式秘密保管資料**

- <https://v2.tauri.app/plugin/stronghold/>

確認に用いた論点:

- デスクトップで資格情報を暗号化保管する選択肢。
- 音声APIキー等をReact状態、設定JSON、ログ、プロンプトへ置かない設計。

OS資格情報ストアとの比較は実装時に行い、Strongholdだけを唯一の選択肢とはしない。

## TAU-10

**GitHub Actions pipeline for Tauri — 公式配布パイプライン資料**

- <https://v2.tauri.app/distribute/pipelines/github/>

確認に用いた論点:

- `tauri-action`によるOS別ビルドとリリース生成。
- Windows/macOS署名工程への接続。
- 本文でいう「同一コードベース＋ネイティブCIマトリクス」の根拠。

## TAU-11

**Tauri code signing / cross-compilation caveats — 公式配布資料**

- macOS Code Signing: <https://v2.tauri.app/distribute/sign/macos/>
- Windows Code Signing: <https://v2.tauri.app/distribute/sign/windows/>
- Windows Installer — 他OSからのクロスコンパイル上の注意: <https://v2.tauri.app/distribute/windows-installer/#build-windows-apps-on-linux-and-macos>

確認に用いた論点:

- macOS署名・公証とApple環境の要件。
- Windows署名と証明書管理。
- Windows向けクロスコンパイルは可能でも制約があり、ネイティブCIが優先されること。

## Live2D Cubism

## L2D-01

**Expandable Applications — 公式ライセンス説明**

- <https://www.live2d.com/en/sdk/license/expandable/>

確認に用いた論点:

- ユーザーが任意にモデルを追加できるアプリがExpandable Applicationに該当し得ること。
- 規模を問わず、公開前審査と特別な契約が求められること。
- 審査結果によって公開できない可能性があること。

本文の整理は法的助言ではない。機能実装・公開前に権利者へ書面確認する。

## L2D-02

**SDK Release License (Publication License Agreement) — 公式公開許諾資料**

- <https://www.live2d.com/en/sdk/license/>

確認に用いた論点:

- Cubism SDKを使った製品公開に関するライセンス区分。
- AI、チャットボット、トラッキング、拡張可能アプリ等の個別条件。
- SDK公開許諾と、同梱キャラクターの著作権・契約が別であること。

## L2D-03

**Build Web Samples — 公式Web SDKビルド手順**

- <https://docs.live2d.com/en/cubism-sdk-tutorials/sample-build-web/>

確認に用いた論点:

- Cubism SDK for WebのTypeScript/Vite系ビルド構成。
- Webフロントエンドへ統合する技術的成立性。

## L2D-04

**CubismWebSamples — 公式サンプルコード**

- <https://github.com/Live2D/CubismWebSamples>

確認に用いた論点:

- モデルロード、レンダリング、モーション、表情等のWeb実装例。
- 実装時にSDKバージョンとサンプルの対応を固定して検証する必要性。

## L2D-05

**Cubism SDK Manual — モデル、表情、モーション、リップシンク**

- SDK Manual: <https://docs.live2d.com/en/cubism-sdk-manual/top/>
- How to Use CubismWebFramework Directly: <https://docs.live2d.com/en/cubism-sdk-manual/use-framework-web/>
- Lip-sync: <https://docs.live2d.com/en/cubism-sdk-manual/lipsync/>

確認に用いた論点:

- `.model3.json`からモデル本体、表情、モーション、物理、視線、リップシンク等を参照する構造。
- インポーターでファイル参照、サイズ、個数、整合性を検証する必要性。
- 音声と口形同期を行う場合のパラメーター制御。

## Git

## GIT-01

**git-worktree — Git公式マニュアル**

- <https://git-scm.com/docs/git-worktree>

確認に用いた論点:

- 一つのリポジトリに複数の作業ツリーを関連付ける仕組み。
- 並行作業・ブランチ分離へ利用できること。

worktreeは開発上の分離であり、同じユーザー権限・ファイルシステム上のセキュリティ境界ではない。

## GIT-02

**git-notes — Git公式マニュアル**

- <https://git-scm.com/docs/git-notes>

確認に用いた論点:

- コミットオブジェクトを書き換えずに注釈を関連付けられること。
- レビュー資料の任意エクスポート先として利用できること。

共有、fetch、pushの運用が通常のブランチと異なるため、本アプリの履歴正本にはしない。

## GIT-03

**git-reflog — Git公式マニュアル**

- <https://git-scm.com/docs/git-reflog>

確認に用いた論点:

- ローカル参照の更新履歴であること。
- 有効期限・削除があり、永続監査ログには適さないこと。

## セキュリティ・供給網

## SEC-01

**NIST Secure Software Development Framework (SSDF)**

- <https://csrc.nist.gov/projects/ssdf>

確認に用いた論点:

- 安全なソフトウェア開発を組織・実装・検証・脆弱性対応へ分解する基礎枠組み。
- セキュリティを最終検査ではなく開発ライフサイクルへ組み込むこと。

## SEC-02

**OWASP LLM01:2025 Prompt Injection**

- <https://genai.owasp.org/llmrisk/llm01-prompt-injection/>

確認に用いた論点:

- リポジトリ、ドキュメント、ツール出力等に含まれる命令を信頼しないこと。
- モデルへの入力分離、権限制限、人間による確認、出力検証。

## SEC-03

**OWASP LLM06:2025 Excessive Agency**

- <https://genai.owasp.org/llmrisk/llm062025-excessive-agency/>

確認に用いた論点:

- 不要に広い機能・権限・自律性が被害範囲を拡大すること。
- 最小権限、操作別承認、影響範囲制限、監査可能性。

## SEC-04

**Model Context Protocol — Security Best Practices**

- <https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices>

確認に用いた論点:

- Confused deputy、トークン取り扱い、セッション、リダイレクト、ローカルサーバー、権限境界。
- MCPツールを意味の狭い許可リストとして設計する必要性。

## SEC-05

**SLSA — Supply-chain Levels for Software Artifacts**

- <https://slsa.dev/>

確認に用いた論点:

- ビルド由来、改ざん耐性、再現可能なリリース工程を段階的に高める枠組み。
- OS別署名済み成果物、依存関係固定、SBOM、ビルド証跡を評価対象にする根拠。

## Human-AI Interaction / アクセシビリティ / コードレビュー研究

## HCI-01

**Guidelines for Human-AI Interaction — Microsoft Research**

- <https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/>

確認に用いた論点:

- 初期利用、通常利用、誤り発生、時間経過の各段階でAI挙動を設計する18ガイドライン。
- 期待値設定、根拠提示、訂正、制御、フィードバックの重要性。

## HCI-02

**Human-AI Synergy in Agentic Code Review**

- <https://arxiv.org/abs/2603.15911>

確認に用いた論点:

- エージェント型コードレビューで、人間の文脈・検証・監督とAIの補完関係を扱う研究。
- レビュー品質をAIだけの指摘件数で測らず、人間が理解・判断・検証できることを評価する根拠。

2026年公開のプレプリントであり、査読状況と版更新を要件確定時に確認する。

## HCI-03

**Human and Machine: How Software Engineers Perceive and Engage with AI-Assisted Code Reviews Compared to Their Peers**

- <https://arxiv.org/abs/2501.02092>

確認に用いた論点:

- AI支援レビューに対する信頼、文脈不足、説明、認知負荷、人間レビューとの差異。
- AI出力を増やすだけではレビュー負担が減らないという問題設定。

## HCI-04

**Rapid Trust Calibration through Interpretable and Uncertainty-Aware AI for Patterns — IBM Research**

- <https://research.ibm.com/publications/rapid-trust-calibration-through-interpretable-and-uncertainty-aware-ai>

確認に用いた論点:

- 解釈可能性と不確実性表示を用いた、ユーザーの信頼較正。
- キャラクターの印象ではなく、根拠・不確実性・検証結果を併記する設計。

## HCI-05

**WCAG 2.2 — W3C Recommendationおよび関連解説**

- WCAG 2.2: <https://www.w3.org/TR/WCAG22/>
- Understanding 2.2.2 Pause, Stop, Hide: <https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html>
- Understanding 2.3.3 Animation from Interactions: <https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html>
- Understanding 2.3.1 Three Flashes or Below Threshold: <https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html>

確認に用いた論点:

- 動くコンテンツの停止・非表示。
- 操作起因アニメーションの抑制。
- 点滅、キーボードフォーカス、非視覚代替。
- Live2Dを無効化しても全機能を利用できる設計。

## HCI-06

**Trusting AI: does uncertainty visualization affect decision-making? — Frontiers in Computer Science**

- <https://www.frontiersin.org/journals/computer-science/articles/10.3389/fcomp.2025.1464348/full>

確認に用いた論点:

- 不確実性の可視化が意思決定・信頼へ与える影響は、表示方法、文脈、ユーザーによって変わること。
- 単純な信頼度パーセンテージだけを万能視せず、理由・不足証拠・次の検証を示す設計。

## HCI-07

**Humanlike AI Design Increases Anthropomorphism but Yields Divergent Outcomes on Engagement and Trust Globally**

- <https://arxiv.org/html/2512.17898v1>

確認に用いた論点:

- 人間らしいAIデザインが擬人化を強め得ること。
- エンゲージメントと信頼への効果が一様ではなく、誤った能力帰属にも注意が必要なこと。

プレプリントの初期版であり、キャラクター表現のリスク仮説を補助する資料としてのみ扱う。

## HCI-08

**shadcn/ui DialogおよびRadix Dialog — 公式ドキュメント**

- shadcn/ui Dialog: <https://ui.shadcn.com/docs/components/radix/dialog>
- Radix Dialog: <https://www.radix-ui.com/primitives/docs/components/dialog>

確認に用いた論点:

- モーダル表示中は背面を操作不能にし、タイトルと説明を支援技術へ関連付ける。
- `Tab`と`Shift+Tab`でダイアログ内のフォーカスを移動し、`Escape`で閉じる。
- 閉じた時はトリガーへフォーカスを戻す。
- 非同期操作後に閉じる場合は、controlled open stateで完了境界を管理する。

2026-07-18（JST）に公式ページを再確認した。実装ではリポジトリ同梱のshadcn Dialogプリミティブを使用する。

## 抽象化したUI/UX観察

## UX-OBS-01

**依頼者指定の参考製品に関する公開UI・公式公開資料・更新履歴の観察**

依頼条件に従い、製品名、URL、固有名称、画面資産、コピーは本成果物へ掲載していない。次の観察だけを一般化して利用した。

- 作業空間を、会話履歴ではなくGitに裏付けられた委任・レビュー単位として扱う。
- チャットと差分・変更ファイル・検証状態を同時に見られる情報階層。
- 目標、状態、利用量、待機、要確認、未読を常時把握できること。
- 低重要度のエージェント活動をまとめ、質問、失敗、承認、完了を強調すること。
- 差分上のコメントを、そのまま次のエージェント入力へ返すこと。
- ターンまたはチェックポイント単位で変更を追跡・復元すること。

これらは一般的な情報設計・ワークフロー原則として再構成しており、外観や固有インタラクションの複製を意図しない。

## 出典の読み方と限界

- **公式仕様**でも、実験的機能やクラウド側のモデル一覧は予告なく変わり得る。
- **公式ソースコード**は`main`ブランチを参照している箇所がある。採用時は特定リリースタグへ固定する。
- **学術資料**にはプレプリントが含まれる。最終要件の根拠にする際は、最新版・査読状況・研究条件を再確認する。
- **ライセンス資料**の解釈は技術調査であり、法的助言ではない。公開判断は権利者・法務確認を優先する。
- **UI/UX観察**は識別情報を意図的に省略しているため、第三者による原資料の追跡性よりも依頼条件を優先している。
