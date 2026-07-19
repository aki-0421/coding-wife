---
title: "macOS local narration runtime 実測"
description: "外部TTS providerを使わず、macOS同梱の/usr/bin/sayを安全なoptional narration adapterとして使うための実測と境界を記録する。"
updated: 2026-07-18
last_verified: 2026-07-18
read_when:
  - "native narration process、voice allowlist、cancel、privacyを実装するとき。"
  - "macOSまたは/usr/bin/sayの更新後にspeech runtimeを再検証するとき。"
---

# macOS local narration runtime 実測

## 結論

Coding Wifeのoptional TTSは外部provider/API keyへ依存せず、macOS同梱のexact `/usr/bin/say`だけをnative adapterから起動する。captionを正本とし、TTSはfresh profileとreset後にoff、network/microphone/audio fileは常に0件にする。

`say`は任意の出力file、network send、audio device、input fileも指定できるため、binaryを固定するだけでは境界が足りない。アプリはshellを使わず、voice列挙を除く発話引数を`-v <exact installed voice> -r <validated words-per-minute>`へ固定し、redacted textをstdinだけへ渡す。`-f`、`-o`、`-n`、`-a`とcommand-line textは公開しない。

## 実測環境

最終確認日は2026-07-18である。

| 項目 | 実測値 |
|---|---|
| OS | macOS 26.2（Build 25C56） |
| architecture | arm64 |
| binary | `/usr/bin/say` |
| owner / group / mode | `root:wheel` / `-rwxr-xr-x`。UID 0、GID 0、group/other writeなし |
| filesystem flags | `restricted,compressed` |
| binary architecture | Mach-O universal `x86_64` / `arm64e` |
| signature | identifier `com.apple.say`、Apple signing chain、platform identifier |

実測commandは`stat`、`file`、`codesign -dv`、`man say`、`/usr/bin/say -v '?'`である。`say -h`はこの版ではinvalid optionとなり、短いusageだけを返したため、option契約はlocal man pageで確認した。

## CLI契約の確認

local man pageは次を示す。

| option / input | 確認内容 | 製品判断 |
|---|---|---|
| 引数なし / `-f -` | stdinからtextを読む | 発話本文はstdinだけを使う |
| `-v voice` | installed voiceを指定し、`?`でlistを得る | list出力からlocaleを検証し、voice名をexact allowlist化する |
| `-r rate` | words per minute | UI倍率0.75〜1.25を基準180の135〜225へ変換する |
| `-o` | audio fileへ保存 | 使用禁止。audio byte/fileを生成・保存しない |
| `-n` | network send | 使用禁止。narration network capabilityを持たない |
| `-a` | device名/IDを指定 | 使用禁止。任意device入力をWebViewへ公開しない |
| `-f file` | file本文を読む | `-f -`も使わず引数なしstdinに固定し、任意pathを受けない |

## installed voice実測

このhostの`/usr/bin/say -v '?'`は`ja_JP` 9件、`en_US` 28件、`en_GB` 9件、`en_IN` 3件、`en_AU` / `en_IE` / `en_ZA`各1件を返した。`ja_JP`には`Kyoko`のほか、locale表記を含む空白・Unicode付きvoice名がある。したがって、英数字patternへ狭めるのではなく、bounded list出力をlocale column基準でparseし、返されたvoice名との完全一致だけを許可する。

installed voiceはOS、language asset、利用者環境で変わる。固定voiceが必ず存在すると仮定せず、voice列挙・test・各発話の直前にbinary metadataとexact allowlistを再検証する。active localeに対応するvoiceが0件ならTTSをdisabledにし、captionを維持する。

## 採用するnative境界

1. voice列挙、test、各発話の直前に`/usr/bin/say`を`symlink_metadata`相当で確認し、regular file、UID 0、group/other write bit 0を要求する。
2. `Command::new("/usr/bin/say")`相当を直接使い、shell、PATH lookup、利用者指定executableを使わない。
3. voiceは同じ検証済みbinaryから直前に得たbounded exact allowlistと照合する。
4. rateは0.75〜1.25かつ0.05 stepだけを受け、135〜225のinteger words per minuteへ変換する。
5. transcriptはNULなし、1〜240 Unicode scalar、redaction済みだけを受け、stdinへ書いて閉じる。本文をargv、environment、file、logへ置かない。
6. inherited environmentをclearし、stdout/stderrはboundedにdrainしてraw内容を永続化・diagnostic表示しない。
7. childは新しいprocess groupにし、mute、workspace switch、turn stop、Cancel、app closeでgroupへTERMを送り、bounded grace後にKILLして100ms以内に収束させる。
8. active 1件、waiting/queued合計3件以下、同一sequence/dedupe/rate limitをnative policyで検証する。
9. audioはsystem outputへ直接流し、`-o`やtemporary fileを使わない。network/microphone capabilityも追加しない。
10. settingsはapp-private owner-only directoryと`0600` fileへschema付きで保存し、temporary fileのfsyncとatomic renameで置換する。missing/invalidはdefault offへfail closedする。

## 再検証条件

macOS major version、`/usr/bin/say` metadata/signature、local man page、voice list format、process cancellation方式のいずれかが変わった場合に再実測する。公開Web情報は本判断に使用していない。将来外部providerを追加する場合は本境界の拡張ではなく、別のprivacy/security reviewと明示opt-in要件を先に作る。
