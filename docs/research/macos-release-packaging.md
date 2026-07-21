---
title: "macOS release packagingとFinder非依存DMG調査"
description: "Tauriの.app生成、ad-hoc resource seal、正規化inventory、hdiutilのread-only DMG生成を分離し、Finder非依存配布の契約を整理する。"
updated: 2026-07-21
read_when:
  - "macOSの.app・DMG生成、Tauri bundle target、release commandを変更するとき。"
  - "Finder AppleScript timeout、Gatekeeper、ad-hoc署名・未公証artifactの検証手順を確認するとき。"
  - "Hiyori NOTICEを保持したdiff hygiene、Pull Requestの差分検査、safe failureを変更するとき。"
last_verified: 2026-07-21 JST
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

2026-07-21 JSTに[GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)を再確認した。public/private repositoryの標準`macos-14`はM1のarm64 runnerであり、サポート対象のApple Siliconで正本品質ゲートとrelease packagingを実行できる。

同日に公式releaseを確認した現行pinは、[actions/checkout v6.0.2](https://github.com/actions/checkout/releases/tag/v6.0.2)、[actions/setup-node v6.4.0](https://github.com/actions/setup-node/releases/tag/v6.4.0)、[actions/setup-go v6.4.0](https://github.com/actions/setup-go/releases/tag/v6.4.0)、[actions/cache v5.0.3](https://github.com/actions/cache/releases/tag/v5.0.3)、[pnpm/action-setup v4.2.0](https://github.com/pnpm/action-setup/releases/tag/v4.2.0)である。`.github/workflows/ci.yml`と`.github/workflows/release.yml`は各releaseの実commitを完全SHAで固定する。[actions/checkout](https://github.com/actions/checkout)は`fetch-depth: 0`で全branchとtagのhistoryを取得するため、release tag commitが`origin/develop`上にあることをcredential永続化なしで検証できる。Nodeはrepositoryの最低要件に合わせて22.12.0を明示する。通常CIの正本は[継続的インテグレーション仕様](../rules/continuous-integration.md)、無料配布の正本は[GitHub Release macOS無料配布仕様](../rules/github-release-distribution.md)とする。

## 実装契約

1. `tauri.conf.json` のdefault bundle targetは`app`だけにする。
2. `scripts/release/build-macos-app.sh` はworkspace、Cargo home、Rustup homeをstable prefixへremapし、production Vite bundleと`.app`からdevelopment demo marker、absolute private path、credentialを除外する。
3. `scripts/release/build-macos-app.sh`は毎回`/private/tmp`のmode `0700` private targetとmode `0600` logからbuildする。raw stdout/stderrをconsoleへ返さず、dependency licenseの非stale判定、repositoryとpackaged legal treeのbyte一致、nested-first seal、full product verifyを通したcandidateだけを指定outputまたはstandalone canonical pathへpublishする。combined commandでは指定したprivate outputだけを作り、canonical pathへ直接書かない。
4. `seal-macos-app.sh`は各Mach-Oとnested bundleを先に、root appを最後に`--timestamp=none --sign -`で署名する。root署名に`--deep`を使わず、検証だけを`--deep --strict`にする。
5. `macos-release.mjs verify-app`はapp root mode `0755`、arm64、Mach-O build platform macOS、minimum macOS 14.0、bundle ID/version、Hiyori runtime 17file、root `LICENSE`とbyte一致するproject MIT Licenseを含むrepository legal tree、2 bundled skills、support runtime、DB migration、demo/source map/quarantine/private path/credential不在を検証する。`Signature=adhoc`、`TeamIdentifier=not set`、Authority不在、stapled ticket不在を別々に判定する。
6. inventoryはroot modeと、relative path、type、4桁permission mode、symlink target、regular file size、SHA-256をbyte順にsortし、全entryのSHA-256 digestを持つ。absolute、app外へescapeする、またはbrokenなsymlinkを拒否する。entry path、symlink target、regular file bytesにはdiff hygieneと共有するprivate-path規則を適用し、`/Users`、`/home`、`/private/var`、任意drive letterのWindows user path、文字列先頭またはPOSIX component境界の`/\\server\share`を含むUNC pathを拒否する。通常のbackslash列、identifier内の連続backslash、remote URLは誤検出しない。
7. `scripts/release/build-macos-dmg.sh` はfull product verify済み`.app`だけからDMGを作る。source、private staging app、2回の独立read-only candidate mountで、毎回metadata、architecture、platform、minimum OS、resource、marker、seal、公証分類を含むfull product verifyと同一inventoryを要求する。rootはappと`/Applications` symlinkの2entryだけで、write probeは失敗しなければならない。
8. app、DMG、sidecar manifestはUUID run identityを持つ。standalone buildは各artifact/manifestをtransactionとして扱う。combined `pnpm release:macos`は4成果物をprivate pathへbuildしてcanonical verifierを通した後、既存4pathの内容と不在状態を同一filesystemのmode `0700` backup/journalへ退避し、4pathを一つのtransactionとしてpublishする。途中または全path移動後のfailure・HUP・INT・TERMではexact旧状態を復元し、新規runならfinalを0件にする。
9. app build、DMG build、canonical verify、3工程をまとめた`pnpm release:macos`は、全てhost-globalな`/private/tmp/coding-wife-macos-release.lock`で直列化する。lock取得は有限時間で、owner PIDとrun identityだけをsafe diagnosticsとして返す。子工程は同じidentityでreentrantにlockを共有する。process crashでcombined transactionのbackup/journalが残った場合、次のlock ownerは新規build前にexact canonical path、UUID、state、original-presence recordが一意で整合したjournalだけを復旧する。複数・symlink・未知version・path不一致・欠損backupは有限時間でsafe errorにする。
10. `hdiutil attach -plist`の結果からexact `/dev/diskNsM`とmountpointの組を解決する。attach開始前からcleanup対象として登録し、detachは有限回retryした後に`hdiutil info -plist`でexact deviceとmountpointの両方が消えたことを確認する。shell pipelineへmount情報を流さず、`pipefail`のSIGPIPEをcleanup判定に混入させない。
11. `scripts/release/verify-macos-release.sh`はlock内でfinal DMGをprivate regular-file snapshotへcopyする。copy前後と検証終了時にfinal pathのdevice/inode/size/SHA-256が一致し、snapshot hashも一致することを要求する。`hdiutil verify`と独立read-only mountはsnapshotだけを入力にし、consoleへ報告するsize/SHA-256も検証済みsnapshot bytesだけから得る。path swap、in-place tamper、symlink置換は失敗する。
12. raw command stderr、input/output/tempのabsolute pathはconsoleへ返さない。失敗はstep単位のsafe codeと非0 exitで表す。trapはmountを先に確実にdetachし、今回runのprivate workを安全なprefix確認後に削除し、combined backup/journalを復元してからlockを解放する。publish commitはcanonical verifier成功後にjournal/backupを削除した時点だけとする。
13. `.github/workflows/release.yml`は`v<version>` tagだけで起動し、`scripts/release/validate-release-tag.mjs`でroot package、Tauri、Cargoのversion一致と`origin/develop` ancestryを検査する。version parserの境界は`validate-release-tag.test.mjs`を通常の`pnpm test`から実行する。
14. immutable tagの作成前に`pnpm test:release`をrelease candidate gateとして成功させる。tag jobはclean runnerでLive2D入力を検証・生成した後に`pnpm release:macos`を実行し、canonical DMGとmanifestがregular fileとして存在する場合だけtag付き安定名へbyte copyする。copy後のSHA-256 sidecarを同じdirectoryから自己検証する。実DMGのfault injection stressを製品buildと同じhostで直前に繰り返さない。
15. GitHub Release操作は最後のstepだけが持つjob-level `contents: write`で行う。新規releaseはdraftとし、同tagのdraftだけを`--clobber`できる。既存public releaseでは失敗し、公開済みbyte列を暗黙置換しない。
16. 無料配布workflowはApple certificateとnotarization credentialを持たない。release notesはad-hoc署名・未公証、macOS 14+ Apple Silicon、local Codex prerequisite、bounded Open Anywayを日本語・英語で示す。

## Diff hygieneの実装・変更手順

`scripts/release/check-diff-hygiene.mjs`が正本である。既定は`origin/develop...HEAD`のcommitted差分、staged、unstaged、ignoreされていないuntracked fileの4 scopeを検査する。base refを利用できないlocal作業は`--working-tree`、Pull Request CIは`--base <base-sha>`を使う。

tracked diffはexternal diffとtextconvを無効にした`git diff --check`、untracked fileはNUL区切りの`git ls-files --others --exclude-standard`とfileごとの`git diff --no-index --check`で検査する。Gitのraw stdout/stderrは利用者へ渡さず、failureはscopeとsafe codeだけを返す。

whitespace検査の除外は`src-tauri/resources/characters/builtin-hiyori/NOTICE.txt`のexact pathだけである。その除外と独立して、worktreeの正本がregular fileであることと`scripts/live2d/constants.mjs` の`HIYORI_NOTICE_SHA256`へ一致することを検査前後に確認する。このためNOTICEのworktree上の改変、削除、rename、symlink置換は`PROTECTED_NOTICE_INVALID`になり、同じbyteを他pathへ置いても通常のwhitespace検査対象になる。

さらに、`HEAD`または選択したbase commitにNOTICEが存在する場合は、indexにもexact pathのstage 0 entryが1件必要である。entryはmode `100644`かつregular blobで、blobのbyte列が固定SHA-256へ一致しなければならない。これによりworktreeをcanonicalなまま残す`git rm --cached`、index内だけの内容差分、mode変更、rename、symlinkを`PROTECTED_NOTICE_INDEX_INVALID`として拒否する。`HEAD`と選択baseのどちらにもNOTICEがない場合だけcanonical untracked addを許可し、staged addがあれば同じindex検証を適用する。`--working-tree`では`HEAD`だけをtracked baselineとして扱う。

変更時は`node --test scripts/release/check-diff-hygiene.test.mjs`を実行する。`scripts/release/check-diff-hygiene.test.mjs`は隔離Git repositoryを作り、committed / staged / unstaged / untracked、base不在、canonical noticeの後日add、他path copy、worktreeのmodify / delete / rename / symlink、indexのcached delete / blob drift / mode / rename / symlink、base選択差、secret・absolute path非表示を検査する。fixtureは利用者のglobal `core.autocrlf`に左右されずbyte-exact blobを作る。`.github/workflows/ci.yml`のfrontend jobは依存install前にPull Requestのbase SHAで同じ`pnpm check:diff`を実行し、成功後だけPR向けfrontend/repository検証を続行する。Apple Silicon jobはlicense inventoryとRust検証に限定し、完全release品質gateは`pnpm quality:check`へ分離する。

## 配布境界

ハッカソンMVPのDMGは、local buildとGitHub draft Releaseの両方で使うad-hoc署名・未公証artifactである。ad-hoc resource sealとDMG mountは改変検出に使えるが、Developer ID署名、配布者identity、notarization、staplingを証明しない。

審査者には、source、version tag、final DMG SHA-256を照合できるGitHub Release assetとlocal build経路を示し、Developer ID未署名・未公証artifactを開くsecurity trade-offとApple公式のOpen Anyway手順を[testing instructions](../testing.md)に明記する。`xattr`によるquarantineの一括削除は案内しない。無料配布ではこのGatekeeper操作を省略できるとは表示せず、将来省略する場合だけDeveloper ID署名・公証・staplingを独立release gateとして追加する。

## 検証

- Minimal arm64 Mach-O product fixtureでbundle metadata、macOS platform/minOS、root mode、required resource、runtime marker、nested-first ad-hoc seal、公証なし分類を含むreal `verifyReleaseApp`とCLIを自動testする。
- Inventoryはpath/type/root・entry mode/link/size/hashに加え、absolute・escape・broken symlink、entry/link/file bytesのPOSIX・Windows・UNC private pathをfixtureで拒否する。
- DMG生成はreal product fixtureからsource、stage、2独立read-only mountのfull verify、2 root entries、Applications symlink、write rejection、detach、atomic publish、run manifestを検査する。
- buildとcanonical verifyのfailure、INT、TERMを反復し、host-global lock、mount、work、ready、backup prefixが0件になることを確認する。final pathのin-place tamper、inode swap、symlink replacementではsnapshot検証とSHA報告を拒否する。
- missing/invalid app、invalid argument、existing output、explicit overwrite、redacted error、stale license、packaged legal driftを自動testする。
- Developer ID署名、公証、別MacのGatekeeper、初回起動はlocal release scriptの対象外とし、installed artifact acceptanceで別に確認する。
- Version tagのmanifest一致、`develop` ancestry、malformed version、manifest driftは`validate-release-tag.test.mjs`とrelease workflowのfail-closed checkで検査する。GitHub Release APIへの実upload、download後checksum、Gatekeeper、別Macの初回起動はtag実行後の手動acceptanceで確認する。
