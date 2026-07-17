---
title: "Live2Dランタイム実装・検証ガイド"
description: "同梱HiyoriのLive2D frontend rendererを再現、診断、更新するためのコマンド、実描画証跡、責務境界。"
updated: 2026-07-18
read_when:
  - "同梱HiyoriのLive2D描画、resize、motion policy、context recoveryを変更または検証するとき。"
  - "Live2Dの供給網検査や診断previewが失敗したとき。"
---

# Live2Dランタイム実装・検証ガイド

## 現在の完了範囲

2026-07-18 時点で、同梱 Hiyori を使う最初の実ランタイム完了ゲートまでを実装した。公式 Cubism SDK for Web 5-r.5 の Core、Framework、13 shaders と、`tmp/hiyori_pro` から固定した17 runtime filesだけを使う。rendererは透明な1 canvasを所有し、Idle[0]、semantic stateのHTML caption、animated/reduced/hidden、static/text fallback、resize、WebGL context recoveryを扱う。

`live2d-preview.html` はproduction Appのrouteへ依存しない診断用entry pointである。`pnpm dev` の後に `/live2d-preview.html` を開くと、semantic state、motion policy、WebGL context loss/restore、frame metricsを同じ画面で確認できる。診断画面はS-002の255 px sidebar、81 px header、Chat/Companionの連続面を再現する。検証スクリーンショットは `/tmp` へだけ保存し、commitしない。

## 通常の検証順序

1. `pnpm live2d:verify` で59 Framework sources、13 shaders、17 Hiyori runtime filesと固定hashを検査する。
2. `pnpm typecheck` で公式FrameworkをTypeScript 5.9.3で再生成し、アプリのstrict type checkを行う。
3. `pnpm test` でsupply-chain、manifest fail-closed、Core one-shot/version、state generation、motion policy、backing sizeを検査する。
4. `pnpm lint` でReact lifecycleとruntime error pathを含む静的検査を行う。
5. `pnpm build` でCore/shader、`pack.json`、Hiyori 17 files、通常Appと診断entry pointが配布物へ入ることを確認する。
6. `agent-browser` で診断画面を1470×836と960×640で開き、非透明pixel、motion signature、canvas backing size、visible caption、reduced/hidden、context restoreを確認する。

## 実描画の基準値

実装時の検証値は次のとおり。固定性能budgetではないが、空canvas、停止motion、resize不追従を切り分ける回帰基準として使える。

| viewport | canvas CSS | backing | 非透明sample | frame delta | 結果 |
| --- | --- | --- | ---: | ---: | --- |
| 1470×836 | 607.5×755 | 608×755 | 2,410 | 16.7 ms | `ready`、animated、signature change 48 |
| 960×640 | 373.33×559 | 373×559 | 2,574 | 16.7 ms | resize後も頭と足を欠かずbottom-contain |

reducedはneutral frame後の500 msでframe countとsignature changeが不変だった。hiddenはcanvasとRAFを停止し、HTML captionを維持した。人工的なcontext lossではtrusted first-frame PNGへ縮退し、restore後にshader、offscreen、texture resourceを再生成して `ready`、`error=null`、非透明sample 2,574へ復旧した。検証時のWebGL `getError()` は0だった。

## 障害の切り分け

| 症状 | 最初に確認する値 | 主な原因 |
| --- | --- | --- |
| model読込前にerror | `status.error.code`、Core request | Core version、manifest、MOC inventory、MIME |
| shader requestは成功するが空canvas | shader managerのloaded/link、WebGL error、非透明sample | model projection、shader compile、texture binding |
| resize後にぼやける | CSS sizeとbacking size | `ResizeObserver`、device pixel ratio上限 |
| reducedでもframeが増える | policy、frame count | neutral frame後のRAF停止漏れ |
| context restore後だけ空になる | shader/offscreen再生成 | contextに紐づいた失効済みGPU resourceの再利用 |

Hiyoriのmodel3にlayout指定はない。`CubismModelMatrix` は生成時にmodel heightを2へ正規化するため、追加の `centerX` / `bottom` 平行移動を重ねるとmodelがviewport外へ出る。配置は公式sampleと同じ既定model matrixにprojectionのaspect補正だけを掛ける。

## 後続実装との境界

現在の完了範囲は同梱packのfrontend rendererと検証可能なasset配信までである。任意モデルのpicker、Rust quarantine validator、source/copied bytesの二重hash、isolated preview、atomic publish、設定永続化は後続ゲートである。未検証directory、absolute path、remote URLをfrontend manifest URLへ直接渡して代替してはならない。

版、hash、配布条件、pack schema、任意モデルのtrust boundaryを変更する場合は、先に [Live2D実ランタイム統合調査](live2d-runtime-integration.md) を更新し、公開情報を再確認した場合は `updated` と `last_verified` も更新する。
