---
name: rambo-release
description: 校验并打包 Rambo 的 macOS 与 Windows 应用，分别内置对应平台的 Codex App Server，生成双平台可上传产物与校验和，更新活动 Mac 的 /Applications/Rambo.app，提交版本并发布到 GitHub Releases。用于用户明确要求打包、双平台构建、发布或创建 GitHub Release；不用于普通开发构建或仅本地预览。
---

# 打包并发布 Rambo

只在用户明确要求发布时执行。发布是外部副作用：会替换活动 Mac 的 `/Applications/Rambo.app`、提交当前工作区、推送 `main`、创建 tag 和公开 Release。开始前核对仓库、版本、目标 commit、双平台构建产物和将要上传的全部文件。

## 发布前核对

1. 从仓库根目录读取 `AGENTS.md`、`package.json`、`README.md`、`docs/product-decisions.md` 的 P09/P10、本 Skill 的[发布约定](references/release-contract.md)以及 `config/runtime-targets.json`。
2. 确认 `origin`、当前分支、远端最新提交、`gh auth status`、已有 tag 和 Release。不得向错误 fork、私有/公开状态或默认分支发布。
3. 版本优先采用用户明确给出的版本；没有时使用 `package.json`。同名 tag 或 Release 已存在时停止，不覆盖。
4. 正式 Release 默认必须同时包含 `macOS-arm64` 与 `Windows-x64`。只有用户明确要求时，才增加 `macOS-x64` 或 `Windows-arm64`；每种目标都必须在匹配架构的原生构建机上生成。
5. 检查工作区全部改动和未跟踪文件。发布提交必须包含本次要发布的代码、文档、Skill 和资源；不得回退用户改动，也不得遗漏被 Git 忽略但运行时需要的生成物。
6. 所有平台当前均不进行商业代码签名或公证：macOS 使用本地 ad-hoc 重封，Windows NSIS 为未签名安装包。发布说明必须写明 Gatekeeper 与 SmartScreen 首次打开步骤，不能声称无警告安装。

## 双平台构建

`scripts/package-desktop.mjs` 禁止交叉打包；必须在对应原生机器上执行。每个应用包只能内置 `config/runtime-targets.json` 中对应目标的 `codex-app-server`，不得把 macOS Mach-O 放入 Windows 包，也不得把 Windows PE 放入 macOS 包。

### macOS ARM64

在 macOS ARM64 构建机执行：

```sh
npm run release:package -- darwin-arm64
```

脚本会运行 `npm run package:mac:arm64`，生成 `dist/mac-arm64/Rambo.app`，完成 ad-hoc 重封与严格签名校验，验证包内 `runtime/codex/0.165.0` 的 manifest、入口、SHA-256 和 Mach-O arm64 架构，再生成：

```text
dist/release/v<version>/Rambo-v<version>-macOS-arm64.zip
dist/release/v<version>/Rambo-v<version>-macOS-arm64.zip.sha256
dist/release/v<version>/Rambo-v<version>-darwin-arm64.release.json
```

### Windows x64

在 Windows x64 构建机执行：

```sh
npm run release:package -- win32-x64
```

脚本会运行 `npm run package:win`，生成 NSIS 安装包和 `dist/win-unpacked`，验证包内 `resources/runtime/codex/0.165.0` 的 manifest、入口、SHA-256 和 PE x64 架构，再生成：

```text
dist/release/v<version>/Rambo-v<version>-Windows-x64.exe
dist/release/v<version>/Rambo-v<version>-Windows-x64.exe.sha256
dist/release/v<version>/Rambo-v<version>-win32-x64.release.json
```

Windows x64 产物必须来自 Windows 真机构建；GitHub Actions 的 Windows unpacked/NSIS 产物只能作为候选构建证据，不能替代安装、启动和产品验收。

### 合并与校验

把两个原生构建机生成的同一版本文件合并到同一个 `dist/release/v<version>/`。然后在 macOS 构建机执行：

```sh
npm run release:verify -- darwin-arm64,win32-x64
```

该命令必须同时找到两个平台的安装包、SHA-256 和 release metadata，并逐项核对：

- 产物版本与 `package.json` 一致。
- 两个安装包都只包含固定版本的 Codex App Server。
- macOS 包的 App Server 目标是 `aarch64-apple-darwin`，Windows 包是 `x86_64-pc-windows-msvc`。
- 包内入口、平台 manifest、官方归档 SHA-256 与 `config/runtime-targets.json` 一致。
- 安装包实际 SHA-256 与 sidecar 和 `*.sha256` 一致。

缺少任一平台、任一校验文件或任一运行时元数据时停止发布，不得把单平台产物伪装成正式双平台 Release。

## 更新活动 Mac

macOS 构建完成后、提交和上传前，使用本次 macOS 产物更新活动开发机：

```sh
node .agents/skills/rambo-release/scripts/install-local.mjs
```

脚本会正常退出正在运行的 Rambo，严格验证待安装应用，使用 `ditto` 复制到 `/Applications/Rambo.app`，不清理或覆盖 `~/Library/Application Support/Rambo`。无法退出、替换失败或版本/Bundle ID/签名不一致时停止后续发布。

本地只保留活动的 `/Applications/Rambo.app`，不创建 `.app` 备份、`backup`/`replaced` 副本或 `install-backups`。Git 与 GitHub Releases 是版本归档来源。

安装后检查：

```sh
plutil -extract CFBundleShortVersionString raw /Applications/Rambo.app/Contents/Info.plist
codesign --verify --deep --strict /Applications/Rambo.app
codesign -dv --verbose=4 /Applications/Rambo.app 2>&1
spctl -a -vv /Applications/Rambo.app 2>&1 || true
```

## 提交与发布

1. 运行本次发布需要的测试，至少确认双平台打包脚本、`npm run release:verify`、`npm run test:catalog` 和当前目标测试通过。用户只要求打包时，不得伪称 P08 全量验收通过。
2. 检查两个平台的包大小、App Server 元数据、`app.asar` 不重复携带前端依赖，以及 Windows NSIS 和 macOS zip 均非空。
3. 审核 `git diff` 和 `git status`，只暂存本次发布范围。提交信息使用 `Release v<version>`；不要 amend、不重置用户改动。
4. 推送当前分支并创建 annotated tag：

```sh
git push origin main
git tag -a v<version> -m "Rambo v<version>"
git push origin v<version>
```

5. 使用清除代理变量的直连方式创建标准 Release，同时上传 macOS、Windows 及两个校验文件：

```sh
env -u http_proxy -u https_proxy \
  -u HTTP_PROXY -u HTTPS_PROXY \
  -u ALL_PROXY -u all_proxy \
  -u no_proxy -u NO_PROXY \
  gh release create v<version> \
  dist/release/v<version>/Rambo-v<version>-macOS-arm64.zip \
  dist/release/v<version>/Rambo-v<version>-macOS-arm64.zip.sha256 \
  dist/release/v<version>/Rambo-v<version>-Windows-x64.exe \
  dist/release/v<version>/Rambo-v<version>-Windows-x64.exe.sha256 \
  --title "Rambo v<version>" \
  --notes-file <release-notes-file>
```

不要添加 `--prerelease`。Release notes 至少包含目标 commit、两个构建平台与架构、各自内置的 App Server 版本和目标、macOS 未签名/未公证状态与 Gatekeeper 步骤、Windows 未签名 NSIS 与 SmartScreen 步骤、两个 SHA-256、已知验收边界和下载文件说明。

6. 发布后回查真实远端与本机结果：

```sh
gh release view v<version> --json tagName,name,isPrerelease,isDraft,url,assets
git ls-remote --tags origin v<version>
npm run release:verify -- darwin-arm64,win32-x64
plutil -extract CFBundleShortVersionString raw /Applications/Rambo.app/Contents/Info.plist
codesign --verify --deep --strict /Applications/Rambo.app
```

确认 tag 指向本次发布 commit、Release 非 draft、四个资产均存在且大小正确、远端可下载，并且本机安装版本匹配。最终回复给出 Release URL、tag、commit、两个安装包名、两个 SHA-256 和本机安装路径。

## 失败处理

- 任一平台缺失、构建失败、架构不匹配或 App Server manifest 不一致：停止正式发布。
- 测试失败：报告规则和失败原因；除非用户明确接受预发布风险，不继续外部发布。
- 远端已有同名 tag/Release：停止，不覆盖、不移动已发布 tag。
- 推送或上传失败：保留本地提交和产物，报告远端实际状态；不要重复创建 Release。
- 本机 Mac 安装失败：停止提交和外部发布，保留构建产物和应用数据。
- 已发布后才发现单平台缺失：明确报告发布不完整；不得声称双平台发布成功。
