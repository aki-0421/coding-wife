# Product

## Register

product

## Platform

web

## Users

主対象は、Codex に数十分以上の実装や複数ファイルの変更を任せる個人開発者である。作業の開始時には目的を短く伝え、実行中は別の仕事も進め、判断が必要な時と検証済みの成果ができた時だけ確実に介入したい。実装速度そのものより、何が行われ、なぜその変更になり、どのコミットと検証証拠を信頼できるかを理解する負担がボトルネックになっている。

副対象は、小規模チームの技術リード、レビュー担当者、複数作業を並行する開発者である。監査可能な履歴と小さなレビュー単位を重視し、Live2D の視覚・音声表現は状況を周辺視野で把握する補助として利用する。

## Product Purpose

長時間の Codex 作業で生じる意思決定、状況把握、最終レビューの三つの負担を減らす。利用者は一つのデスクトップ画面から、目的と現在段階、試行と失敗、判断の理由、検証結果、main Codex が作成したコミット、読み取り専用の変更差分を確認できる。

成功とは、利用者が実行の途中でも作業の状態を説明でき、人間の判断を保留・変更でき、main Codex が既存変更を保護しながら適切な粒度で作ったコミットを、検証・判断・リスク証拠とともに作業単位ごとにレビューできることである。専門的なコミットは、App Server の成功した commit command と新しい SHA を app が検証した直後に、main conversation から独立した隔離 support が自動で説明する。この support は専用の clean runtime と release proof がexternal authority 0を証明できた時だけ動き、証明不能時は main を止めず決定的な unavailable へ縮退する。利用者は既存コミットの説明要求、失敗時の再試行、生成済み説明の表示・再読上げを app-owned controller 経由で行い、Live2D character の可視 caption が同じ内容を静かに補強する。

## Positioning

Codex の自律作業を、main Codex によるレビュー可能なコミットと読み取り専用の証拠へ変え、必要な説明を Live2D character の caption と同じ画面で確認できる開発ツール。

## Brand Personality

人格は「静穏・誠実・伴走的」。短く具体的に話し、不確実性や失敗を隠さず、利用者へ判断を迫る時は理由、影響、危険、可逆性を先に示す。温かさはローズ系の細いアクセント、Hiyori の存在、節度ある実況で表し、大げさな称賛、緊迫を煽る文言、擬似的な感情による誘導は使わない。

## Anti-references

- 汎用 AI chat の複製。会話だけを中心にして、状態、コミット、検証証拠、説明を隠してはならない。
- terminal clone。ユーザーに shell の生入出力を操作させず、構造化された tool event と証拠を示す。
- game HUD。常時点滅する状態表示、報酬演出、過剰なゲージ、キャラクターによる注意の奪取を避ける。
- neon purple AI dashboard。紫の gradient、発光する境界、full-saturation accent を装飾として使わない。
- glassmorphism と generic card grid。情報を半透明カードへ分割せず、連続した作業面と明確な階層を使う。
- chatty mascot。キャラクターの発話、表情、音声だけで承認、危険、失敗を伝えない。
- emotional coercion。キャラクターへの好意や罪悪感を利用して、推奨案や継続を選ばせない。

## Design Principles

1. **証拠を先にする。** 完了、成功、危険、推奨には、差分、検証、判断履歴、不確実性の観測可能な根拠を添える。
2. **介入点を小さくする。** 人間の判断は質問、選択肢、影響、可逆性を持つ一つの作業単位として扱い、巨大な最終レビューへ先送りしない。
3. **静かに現在地を示す。** 通常状態では作業を邪魔せず、入力待ち、失敗、高リスクだけを明確に優先する。
4. **楽しさを制御の上に重ねる。** Live2D と音声は理解を補助するが、文字、アイコン、履歴、操作を代替しない。
5. **コミット主体を一つにする。** main Codex だけが既存変更を保護しながら適切な粒度でコミットし、native Git と Commit 画面は状態、履歴、差分、検証証拠を読み取る observer に限定する。

## Accessibility & Inclusion

WCAG 2.2 AA を基準とする。通常文字は背景に対して 4.5:1 以上、大きな文字と非テキスト UI は 3:1 以上を維持し、200% text zoom と keyboard-only 操作で主要フローを完了できるようにする。すべての操作には visible focus と accessible name を与え、icon-only control には tooltip を付ける。

Live2D canvas は装飾として accessibility tree から除外し、処理中、入力待ち、失敗、完了、接続切れ、自動または明示fallbackで生成するコミット説明を HTML text と live region でも伝える。色、動き、音、表情を唯一の情報経路にしない。`prefers-reduced-motion` またはアプリ設定が有効な時は idle motion と装飾 transition を停止し、静止 pose と文字状態を残す。日本語と英語で同じ操作、エラー、判断、読み取り専用レビュー、caption を提供する。
