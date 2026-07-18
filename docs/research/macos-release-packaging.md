---
title: "macOS release packagingとFinder非依存DMG調査"
description: "Tauriの.app生成、ad-hoc resource seal、正規化inventory、hdiutilのread-only DMG生成を分離し、Finder非依存配布の契約を整理する。"
updated: 2026-07-19
read_when:
  - "macOSの.app・DMG生成、Tauri bundle target、release commandを変更するとき。"
  - "Finder AppleScript timeout、Gatekeeper、ad-hoc署名・未公証artifactの検証手順を確認するとき。"
  - "Hiyori NOTICEを保持したdiff hygiene、Pull Requestの差分検査、safe failureを変更するとき。"
last_verified: 2026-07-18 JST
---

# macOS release packagingとFinder非依存DMG調査

## 結論

Build Week MVPのrelease pathは、Tauri CLIでproduction `.app`を生成し、repository-owned scriptがnested Mach-O codeからapp全体の順にtimestampなしad-hoc署名する。`codesign --verify --deep --strict`で全resource sealを確認したappだけをDMG入力にする。ad-hoc署名は改変検出用であり、Developer ID identityやApple公証を意味しない。

DMGは`.app`と`/Applications`へのsymlinkだけを持つ。repository-owned scriptがmacOS標準の`ditto`と`hdiutil`で一時出力をcompressed read-only imageへ変換し、`-readonly -nobrowse -noautoopen`でmountする。作成時とcanonical verify時の別々のmountでsource appと同じ正規化inventory、root 2entry、write rejectionを確認する。Finder、AppleScript、`osascript`は起動しない。

## 確認した一次情報

### Tauri v2

Tauri公式の[DMG配布ガイド](https://v2.tauri.app/distribute/dmg/)は、DMGをApp BundleとApplications folderを持つmacOSの一般的なインストーラとして説明している。ページが扱うwindow size、background、icon positionはFinderで見せるlayoutのcustomizationであり、artifactの完全性に必須ではない。

リポジトリに固定したTauri CLI 2.11.4の`tauri build --help`も`--bundles app` / `--bundles dmg`を別targetとして公開している。したがって`.app`だけをTauriでbundleし、DMG生成を明示手順へ分離できる。

### macOS `hdiutil`

macOS 14+のlocal `hdiutil(1)`は、`create -srcfolder`がsource directoryのcontentsを新しいfilesystem imageへcopyすること、`attach -readonly`がdeviceをread-onlyでattachすること、`-nobrowse`がFinder等からvolumeを隠すことを定義する。`-noautoopen`も利用し、release scriptの成否にGUI sessionを含めない。

### Gatekeeper

Apple公式の[Safely open apps on your Mac](https://support.apple.com/en-us/102445)（Published May 27, 2026）は、署名・公証されていないsoftwareがcomputerとpersonal informationを危険にさらす可能性を明記する。信頼でき改変されていないと判断したappだけを、一度openを試した後にSystem SettingsのPrivacy & SecurityからOpen Anywayで一時例外にできる。

### GitHub Actions

2026-07-18 JSTにGitHub公式repositoryの latest releaseを確認し、[actions/checkout v7.0.0](https://github.com/actions/checkout/releases/tag/v7.0.0)と[actions/setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0)をdiff hygiene workflowの現行majorとする。Pull Requestのbase commitからの差分を検査できるようcheckoutはfull historyを取得し、Nodeはrepositoryの最低要件に合わせて22.12.0を明示する。

## 実装契約

1. `tauri.conf.json` のdefault bundle targetは`app`だけにする。
2. `pnpm release:macos:app` はworkspace、Cargo home、Rustup homeをstable prefixへremapし、production Vite bundleと`.app`からdevelopment demo marker、absolute private path、credentialを除外する。
3. `seal-macos-app.sh`は各Mach-Oとnested bundleを先に、root appを最後に`--timestamp=none --sign -`で署名する。root署名に`--deep`を使わず、検証だけを`--deep --strict`にする。
4. `macos-release.mjs verify-app`はarm64、minimum macOS 14.0、bundle ID/version、Hiyori runtime 17file、legal notice、2 bundled skills、support runtime、DB migration、demo/source map/quarantine/private path/credential不在を検証する。`Signature=adhoc`、`TeamIdentifier=not set`、Authority不在、stapled ticket不在を別々に判定する。
5. inventoryはrelative path、type、4桁permission mode、symlink target、regular file size、SHA-256をbyte順にsortし、全entryのSHA-256 digestを持つ。DMGへcopyする前、staging後、作成時mount、canonical verify mountで同一inventoryを要求する。
6. `pnpm release:macos:dmg` は検証済み`.app`だけからDMGを作る。scriptは入力、出力、volume name、overwrite意図を引数で確定し、shell文字列連結を使わない。
7. candidateはread-only mount後にroot 2entry、Applications symlink target、inventory、write rejectionを検証する。`--overwrite`はcandidate検証後の置換だけを許可する。
8. `pnpm release:macos:verify`はsource appを再検証し、final DMGを独立してread-only mountして同じapp inventoryを要求した後、final DMGのbyte sizeとSHA-256を出力する。圧縮filesystem metadataを含むDMG byte同一性は要求しない。
9. raw command stderr、input/output/tempのabsolute pathはconsoleへ返さない。失敗はstep単位のsafe codeと非0 exitで表す。
10. trapはmountpointからexact `/dev/diskNsM`を解決し、device detach後に`hdiutil info`からmountpointが消えるまで有限回確認してから一時directoryを削除する。失敗、INT、TERMでもfinal artifactを公開せず、消滅しない場合はdeviceとsanitized mount labelを示してfail closedする。

## Diff hygieneの実装・変更手順

`scripts/release/check-diff-hygiene.mjs`が正本である。既定は`origin/develop...HEAD`のcommitted差分、staged、unstaged、ignoreされていないuntracked fileの4 scopeを検査する。base refを利用できないlocal作業は`--working-tree`、Pull Request CIは`--base <base-sha>`を使う。

tracked diffはexternal diffとtextconvを無効にした`git diff --check`、untracked fileはNUL区切りの`git ls-files --others --exclude-standard`とfileごとの`git diff --no-index --check`で検査する。Gitのraw stdout/stderrは利用者へ渡さず、failureはscopeとsafe codeだけを返す。

whitespace検査の除外は`src-tauri/resources/characters/builtin-hiyori/NOTICE.txt`のexact pathだけである。その除外と独立して、worktreeの正本がregular fileであることと`scripts/live2d/constants.mjs` の`HIYORI_NOTICE_SHA256`へ一致することを検査前後に確認する。このためNOTICEのworktree上の改変、削除、rename、symlink置換は`PROTECTED_NOTICE_INVALID`になり、同じbyteを他pathへ置いても通常のwhitespace検査対象になる。

さらに、`HEAD`または選択したbase commitにNOTICEが存在する場合は、indexにもexact pathのstage 0 entryが1件必要である。entryはmode `100644`かつregular blobで、blobのbyte列が固定SHA-256へ一致しなければならない。これによりworktreeをcanonicalなまま残す`git rm --cached`、index内だけの内容差分、mode変更、rename、symlinkを`PROTECTED_NOTICE_INDEX_INVALID`として拒否する。`HEAD`と選択baseのどちらにもNOTICEがない場合だけcanonical untracked addを許可し、staged addがあれば同じindex検証を適用する。`--working-tree`では`HEAD`だけをtracked baselineとして扱う。

変更時は`pnpm test:diff-hygiene`を実行する。`scripts/release/check-diff-hygiene.test.mjs`は隔離Git repositoryを作り、committed / staged / unstaged / untracked、base不在、canonical noticeの後日add、他path copy、worktreeのmodify / delete / rename / symlink、indexのcached delete / blob drift / mode / rename / symlink、base選択差、secret・absolute path非表示を検査する。fixtureは利用者のglobal `core.autocrlf`に左右されずbyte-exact blobを作る。`.github/workflows/diff-hygiene.yml`はPull Requestのbase SHAで同じ`pnpm check:diff`を実行する。

## 配布境界

ハッカソンMVPのDMGは、local buildを審査者が再現するためのad-hoc署名・未公証artifactである。ad-hoc resource sealとDMG mountは改変検出に使えるが、Developer ID署名、配布者identity、notarization、staplingを証明しない。

審査者には、source、commit、final DMG SHA-256を確認してlocal buildする経路を優先し、Developer ID未署名・未公証artifactを開くsecurity trade-offとApple公式のOpen Anyway手順を[testing instructions](../testing.md)に明記する。`xattr`によるquarantineの一括削除は案内しない。外部配布を開始する場合は、Developer ID署名・公証・staplingを独立したrelease gateとして追加する。

## 検証

- Synthetic Mach-O `.app`でnested-first ad-hoc sealとstrict検証を自動testする。
- Synthetic tiny `.app`でinventoryのpath/type/mode/link/size/hash、DMG生成、read-only attach、2 root entries、Applications symlink、write rejection、detach、cleanupを自動testする。
- missing/invalid app、invalid argument、existing output、explicit overwrite、redacted errorを自動testする。attach後のinjected failure、SIGINT、SIGTERMでmount、work、ready artifactが0件になることをhost-globalなdisk image testを直列実行して確認する。
- real `.app`ではremapped production build、ad-hoc署名分類、architecture/minOS/bundle/resource/forbidden contentを検証し、同じappからDMGを作って作成時mountとcanonical verify mountのinventory一致を確認する。
- Developer ID署名、公証、別MacのGatekeeper、初回起動はlocal release scriptの対象外とし、installed artifact acceptanceで別に確認する。
