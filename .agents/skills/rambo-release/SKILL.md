---
name: rambo-release
description: 通过 GitHub Actions 的 macOS ARM64 与 Windows x64 原生 runner 构建 Rambo，两个工作流分别把正式产物直接上传到 Draft Release；本机不执行发布构建、不下载 Windows 产物，只创建 draft、核对资产清单与 API digest、临时下载 macOS 产物更新 /Applications/Rambo.app，最后发布 draft，并在全部发布验证成功后清理本机旧版本与构建产物。用于用户明确要求打包、双平台构建、发布或创建 GitHub Release；不用于普通开发构建或仅本地预览。
---

# 打包并发布 Rambo

只在用户明确要求发布时执行。发布是外部副作用，会提交当前工作区、推送 `main`、创建并推送 annotated tag、创建 Draft Release，并可能在最后公开 Release。开始前核对仓库、版本、目标 commit、两条原生工作流和全部正式资产。

## 发布前核对

1. 从仓库根目录读取 `AGENTS.md`、`package.json`、`README.md`、`docs/product-decisions.md` 的 P09/P10、本 Skill 的[发布约定](references/release-contract.md)以及 `config/runtime-targets.json`。
2. 确认 `origin`、当前分支、远端最新提交、`gh auth status`、已有 tag 和 Release。不得向错误 fork、私有/公开状态或默认分支发布。
3. 版本优先采用用户明确给出的版本；没有时使用 `package.json`。已存在同名公开 Release 时停止；只有同名 Draft Release 时可在确认 tag 指向同一目标 commit 后继续。不得覆盖、删除或移动已发布 tag。
4. 正式 Release 默认必须同时包含 `macOS-arm64`、`Windows-x64` NSIS 安装包和 `Windows-x64` 免安装 ZIP。只有用户明确要求时，才增加 `macOS-x64` 或 `Windows-arm64`；每种目标都必须由匹配架构的 GitHub Actions 原生 runner 构建。
5. 审核工作区全部改动和未跟踪文件。发布提交必须包含本次要发布的代码、文档、Skill 和资源；不得回退用户改动，也不得提交 `dist/`、`acceptance-runs/`、临时目录或用户明确要求保留的未跟踪文件。
6. 所有平台当前均无商业签名或公证：macOS 使用 ad-hoc 重封，Windows NSIS 和免安装 ZIP 均未签名。Release notes 必须写明 Gatekeeper 与 SmartScreen 首次打开步骤，不能声称无警告安装或无警告首次运行。

## 构建边界

正式发布构建只在 GitHub Actions 执行，不在开发 Mac 执行：

- `.github/workflows/macos-build.yml` 使用 `macos-15` runner，校验 `arm64`，运行类型检查、发布工具测试和 `npm run release:package -- darwin-arm64`，上传 Actions artifact，并在 `v*` tag 触发时把 macOS ZIP 与 `.sha256` 直接上传到 Draft Release。
- `.github/workflows/windows-build.yml` 使用 Windows x64 runner，运行类型检查、平台测试和 `npm run release:package -- win32-x64`，上传 Actions artifact，并在 `v*` tag 触发时把 Windows EXE、portable ZIP 与两个 `.sha256` 直接上传到 Draft Release。
- 两个工作流都必须对应目标 tag commit 且成功。Actions artifact 只用于 GitHub Actions 自身留存，不下载到开发 Mac；Windows 产物尤其不得下载、展开、检查、重算、运行或做任何平台产物校验。
- `scripts/package-desktop.mjs` 禁止交叉打包。每个应用包只能内置 `config/runtime-targets.json` 中对应目标的 `codex-app-server`，不得把 macOS Mach-O 放入 Windows 包，也不得把 Windows PE 放入 macOS 包。
- `npm run release:verify -- darwin-arm64,win32-x64` 只保留给脚本测试或人工诊断，不是发版门禁。正式发布不运行它，也不在 macOS 侧补做 Windows 校验。

## 发版流程

### 1. 提交与推送

1. 运行与改动相关的本地检查，至少执行：

```sh
node scripts/change-checks.mjs
npm run typecheck
node --test tests/backend/release-package.test.mjs
npm run test:catalog
npm run test:acceptance
git diff --check
```

2. 审核 `git diff` 和 `git status`，只暂存本次发布范围。提交信息使用 `Release v<version>`；不要 amend，不回退用户改动。若用户还有明确要求纳入的其他提交，先确认它们已进入目标 commit。
3. 推送当前分支：

```sh
git push origin main
```

4. 创建并推送 annotated tag：

```sh
git tag -a v<version> -m "Rambo v<version>"
git push origin v<version>
```

### 2. 创建 Draft Release 并等待双平台构建

tag 推送后立即创建不含资产的 Draft Release，供两个工作流并行上传：

```sh
gh release create v<version> \
  --draft \
  --title "Rambo v<version>" \
  --notes-file <release-notes-file>
```

两个工作流最多等待 Draft Release 10 分钟。若 10 分钟内没有找到 draft，它们会失败；此时检查发布是否创建在同一仓库和同一 tag 上，不要下载 Actions artifact 作为替代。

分别等待对应 commit 的 macOS 与 Windows workflow 成功：

```sh
gh run list --workflow macos-build.yml --commit "$(git rev-parse HEAD)"
gh run watch <macos-run-id> --exit-status
gh run list --workflow windows-build.yml --commit "$(git rev-parse HEAD)"
gh run watch <windows-run-id> --exit-status
```

任一 workflow 失败、未对应目标 commit、没有向 Draft Release 上传资产，或 draft 不存在时，停止后续安装和公开发布。

### 3. 核对 Draft Release

只核对资产清单、上传状态和 GitHub API 返回的 digest/size，不下载 Windows 资产，也不把它们当作待验证文件：

```sh
gh release view v<version> \
  --json tagName,isDraft,url,assets
gh api repos/{owner}/{repo}/releases \
  --paginate \
  --jq '.[] | select(.tag_name == "v<version>") | {
    tag_name, draft, assets: [.assets[] | {name, size, digest}]
  }'
```

确认 Draft Release 恰好包含以下六个正式资产：

```text
Rambo-v<version>-macOS-arm64.zip
Rambo-v<version>-macOS-arm64.zip.sha256
Rambo-v<version>-Windows-x64.exe
Rambo-v<version>-Windows-x64.exe.sha256
Rambo-v<version>-Windows-x64-portable.zip
Rambo-v<version>-Windows-x64-portable.zip.sha256
```

资产名、非空大小或 API digest 只证明上传结果，不等于 Windows 真机或产物验收。

### 4. 更新活动 Mac

macOS Release 资产允许临时下载，仅用于安装本机 `/Applications/Rambo.app`。使用临时目录并在结束后清理：

```sh
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
gh release download v<version> \
  --pattern 'Rambo-v<version>-macOS-arm64.zip*' \
  --dir "$temp_dir"
cd "$temp_dir"
shasum -a 256 -c 'Rambo-v<version>-macOS-arm64.zip.sha256'
ditto -x -k 'Rambo-v<version>-macOS-arm64.zip' "$temp_dir/unpacked"
cd -
RAMBO_APP_SOURCE="$temp_dir/unpacked/Rambo.app" \
  node .agents/skills/rambo-release/scripts/install-local.mjs
```

若 ZIP 解压后应用不在该路径，先找到唯一 `Rambo.app` 再设置 `RAMBO_APP_SOURCE`。安装脚本会正常退出正在运行的 Rambo，验证待安装应用版本和 Bundle ID，使用 `ditto` 替换 `/Applications/Rambo.app`，不清理或覆盖 `~/Library/Application Support/Rambo`。无法退出、版本/Bundle ID/签名不一致或替换失败时停止发布。

安装后检查：

```sh
plutil -extract CFBundleShortVersionString raw /Applications/Rambo.app/Contents/Info.plist
codesign --verify --deep --strict /Applications/Rambo.app
codesign -dv --verbose=4 /Applications/Rambo.app 2>&1
spctl -a -vv /Applications/Rambo.app 2>&1 || true
```

本地只保留活动的 `/Applications/Rambo.app`，不创建 `.app` 备份、`backup`/`replaced` 副本或 `install-backups`。Git 与 GitHub Releases 是版本归档来源。

### 5. 发布 Draft Release

只有双平台 workflow 成功、六个资产齐全且 macOS 已安装验证后，才公开 draft：

```sh
gh release edit v<version> --draft=false
```

最终回查：

```sh
gh release view v<version> --json tagName,name,isPrerelease,isDraft,url,assets
git ls-remote --tags origin v<version>
plutil -extract CFBundleShortVersionString raw /Applications/Rambo.app/Contents/Info.plist
codesign --verify --deep --strict /Applications/Rambo.app
```

确认 tag 指向本次发布 commit、Release 非 draft、六个资产均存在，并且本机安装版本匹配。最终回复给出 Release URL、tag、commit、三个分发文件名、三个 SHA-256 和本机安装路径；Windows 只报告原生 CI 构建结果和上传结果，不宣称真机验收通过。

### 6. 发布成功后的本机清理

只有在以下条件全部满足后才能执行销毁性清理：

- macOS 与 Windows workflow 均成功，且都对应本次目标 commit。
- Draft Release 六个正式资产齐全，名称、大小与 GitHub API digest/size 已核对。
- macOS Release ZIP 已临时下载并校验 SHA-256，`/Applications/Rambo.app` 已安装，版本、Bundle ID 和签名验证通过。
- `gh release edit v<version> --draft=false` 已完成，最终 Release、tag、六个资产和本机安装版本均已回查。
- 最终回复所需的 Release URL、commit、资产名和 SHA-256 已先记录下来。

确认成功后，使用受控脚本清理仓库 `dist/` 下已知的本机发版构建产物；不要直接使用 `rm -rf`：

```sh
node .agents/skills/rambo-release/scripts/cleanup-release.mjs \
  --release v<version> \
  --dry-run
node .agents/skills/rambo-release/scripts/cleanup-release.mjs \
  --release v<version>
```

脚本只删除仓库 `dist/` 的固定 allowlist：

- `dist/release/` 中当前版本和全部旧版本目录。
- `dist/mac`、`dist/mac-arm64`、`dist/mac-x64`、`dist/mac-universal`、`dist/win-unpacked`、`dist/win-arm64-unpacked`。
- `dist/` 根目录下匹配正式命名规则的 Rambo Windows 安装包、portable ZIP、macOS ZIP、SHA-256 和 blockmap。
- `dist/` 根目录的 `.DS_Store`、`builder-debug.yml`、`builder-effective-config.yaml`、`latest*.yml`。

未知文件保留并在脚本输出中列出。清理后不得保留当前版本或旧版本的 `.app`、安装包、ZIP、解压目录或临时副本，也不创建任何备份。

以下内容不属于清理范围，任何情况下都不能删除或覆盖：

- 活动的 `/Applications/Rambo.app`。
- `~/Library/Application Support/Rambo`、用户数据、日志、记忆、附件和 Bot/Routine 数据。
- `acceptance-runs/`、验收证据、Git commit/tag 和 GitHub Releases。
- 仓库 `dist/` 之外的用户文件。

发布失败、安装失败、最终回查失败或任一 workflow/资产不完整时，不执行上述清理；保留失败现场供诊断。临时下载目录仍按前面的 `trap` 规则清理。清理完成后检查 `/Applications/Rambo.app` 仍存在且版本与已发布版本一致，再报告清理结果。

## 发布说明

Release notes 至少包含：

- 目标 commit、tag 和版本。
- macOS ARM64、Windows x64 均由 GitHub Actions 对应原生 runner 构建并直接上传。
- 两个平台各自内置的 App Server 版本和 target。
- macOS 未签名/未公证状态与 Gatekeeper 步骤。
- Windows 未签名 NSIS/免安装 ZIP 与 SmartScreen 步骤。
- 三个分发文件的 SHA-256。
- Windows 未在开发 Mac 下载或校验，且原生 CI 成功不等于 Windows 真机产品验收。
- 当前已知产品验收边界和下载文件说明。

不要添加 `--prerelease`，除非用户明确要求预发布。

## 失败处理

- 本地检查失败：修复后重新提交或创建新 commit；不要为了发版跳过门禁，除非用户明确接受预发布风险。
- macOS 或 Windows workflow 失败：保留 Draft Release，修复后对新 commit 重新执行完整流程；不得把 Actions artifact 下载到 Mac 后手工上传。
- Draft Release 缺失或资产不足：不要公开。检查 workflow、tag 和仓库后重跑；不得声称双平台发布成功。
- macOS 安装失败：停止公开 Draft Release，报告构建、安装和 draft 的实际状态。
- 推送或上传失败：保留本地提交和远端真实状态；不要重复创建公开 Release，不要移动已发布 tag。
- 已公开后才发现单平台缺失：明确报告发布不完整并等待用户决定，不得补写成完整成功。
- 发布成功后的清理失败：报告实际未删除或已删除的路径，不创建应用备份；修复路径或权限问题后可重新运行同一受控脚本，不得改用宽泛删除命令。
