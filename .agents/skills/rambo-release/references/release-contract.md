# Rambo 发布约定

## 渠道与版本

- 正式分发渠道：GitHub Releases，仓库 `jiawei666/Rambo`。
- 不使用 Mac App Store、Microsoft Store 或其他应用商店。
- `package.json` 是版本单一来源；tag 使用 `v<version>`。
- 正式 Release 默认必须同时提供 macOS ARM64 和 Windows x64；其他架构只有在用户明确要求并由对应 GitHub Actions 原生 runner 构建后才能加入。
- tag 必须指向已推送的发布 commit，不能覆盖已有远端 tag。

## 原生构建与上传

- macOS：`.github/workflows/macos-build.yml` 使用 Apple Silicon 的 `macos-15` runner 运行 `npm run release:package -- darwin-arm64`。
- Windows：`.github/workflows/windows-build.yml` 使用 Windows x64 runner 运行 `npm run release:package -- win32-x64`。
- 两个工作流在 `v*` tag 触发时都等待同名 Draft Release，然后把各自正式资产直接上传到该 draft；Actions artifact 仅作工作流留存。
- 开发 Mac 不执行正式发布构建，不下载 Actions artifact，也不下载或处理 Windows 产物。
- `npm run release:verify -- darwin-arm64,win32-x64` 仍保留供脚本测试或人工诊断，但不是发版门禁；正式发布不运行它。

## 产物

- 默认正式发布集合：
  - `Rambo-v<version>-macOS-arm64.zip` 与 `.sha256`
  - `Rambo-v<version>-Windows-x64.exe` 与 `.sha256`
  - `Rambo-v<version>-Windows-x64-portable.zip` 与 `.sha256`
- macOS 构建入口：`npm run release:package -- darwin-arm64`，只在 GitHub Actions macOS runner 执行。
- Windows 构建入口：`npm run release:package -- win32-x64`，只在 GitHub Actions Windows runner 执行。
- 不把 `dist/`、`acceptance-runs/` 或运行中的开发 profile 提交到 Git。
- GitHub Release 上传默认使用直连；需要手工执行 `gh release` 上传或下载时应清除代理变量。
- Windows 免安装 ZIP 必须从同一次原生构建的 `dist/win-unpacked` 生成，不得另做一套不一致构建；免安装只表示无需安装，应用数据仍使用正常 Windows 用户目录。
- Windows 发布以对应目标 commit 的 GitHub Actions Windows 原生构建成功和 Draft Release 上传结果为准。macOS 侧不检查 PE、NSIS、portable ZIP 内容、文件大小、SHA-256、归档文件清单或内置运行时。

## 平台与运行时

- 正式发布构建必须在匹配的 GitHub Actions 原生 runner 上执行；禁止用 macOS 交叉生成 Windows 原生包，也禁止用 x64 结果冒充 ARM64。
- 每个安装包只能包含本平台、本架构的 `codex-app-server`：
  - `darwin-arm64` -> `aarch64-apple-darwin`
  - `darwin-x64` -> `x86_64-apple-darwin`
  - `win32-x64` -> `x86_64-pc-windows-msvc`
  - `win32-arm64` -> `aarch64-pc-windows-msvc`
- 固定版本、归档 SHA-256、入口和 manifest 以 `config/runtime-targets.json` 为准。
- 打包脚本必须从包内 `runtime/codex/<version>` 读取 `codex-package.json` 与 `rambo-runtime.json`，并实际检查入口二进制为 Mach-O 或 PE 的目标架构。
- macOS 缺包、缺 sidecar、SHA-256 不一致、App Server 版本/目标不一致或二进制架构不符时，由 macOS 原生工作流失败并阻止上传。
- Windows 缺包、缺 sidecar、App Server 版本/目标不一致或二进制架构不符时，由 Windows 原生工作流失败并阻止上传；开发 Mac 不下载产物补验。

## Draft Release 与安装

- 本机创建不含资产的 Draft Release，不直接用 `gh release create` 上传平台资产。
- 两个 tag workflow 成功并完成直传后，本机只核对 Release 资产清单、名称、大小和 GitHub API digest/size。这是上传结果核对，不是 Windows 产物验收。
- macOS Release ZIP 是唯一允许临时下载到开发 Mac 的平台产物，且只用于更新 `/Applications/Rambo.app`。临时目录必须使用 `mktemp -d` 并在结束时清理；不得把 ZIP 或解压目录留在仓库、桌面或长期资料目录。
- 安装前验证 macOS ZIP 的 SHA-256；安装后核对版本、Bundle ID、签名和 `/Applications/Rambo.app` 路径。
- 本机更新不得清理或覆盖应用数据目录。本地只保留活动应用，不保留 `.app` 备份、`backup`/`replaced` 副本或 `install-backups`。
- 只有双平台 workflow、六个资产和 macOS 安装均验证通过后，才把 draft 公开；Windows 构建机不执行 macOS 的 `/Applications` 安装步骤。

## 发布成功后的清理

- 必须等双平台 workflow 成功、六个资产齐全、macOS 安装验证通过、Draft Release 已公开，并完成 Release/tag/资产/本机版本最终回查后，才允许清理本机发版产物。
- 使用 `.agents/skills/rambo-release/scripts/cleanup-release.mjs --release v<version>`，先 `--dry-run` 核对，再执行；不得直接使用 `rm -rf`。
- 清理范围只限仓库 `dist/` 下脚本固定 allowlist 识别的当前及旧版本产物：`dist/release`、已知 macOS/Windows 构建目录、Rambo 正式分发包及其 `sha256`/`blockmap`、Electron Builder 配置与 `latest*.yml`。
- 清理目标是发布成功后的当前版本和全部旧版本本机产物；不保留 `.app`、安装包、ZIP、解压目录或临时副本，也不创建任何备份。
- 不删除或覆盖 `/Applications/Rambo.app`、`~/Library/Application Support/Rambo`、用户数据、日志、记忆、附件、Bot/Routine 数据、`acceptance-runs/`、验收证据、Git commit/tag 或 GitHub Releases。
- 发布失败、安装失败或最终回查失败时不做销毁性清理，保留失败现场；临时下载目录仍按 `trap` 清理。
- 清理后复核 `/Applications/Rambo.app` 仍可用且版本匹配，并在最终结果中报告清理路径和保留内容。

## 签名与安全提示

- macOS 当前不使用 Developer ID、不公证；构建后只做本地 ad-hoc 重封。`codesign --verify` 必须通过，`codesign -dv` 必须为 `Signature=adhoc` 且无 Authority/TeamIdentifier，`spctl` 仍会拒绝。
- Windows 当前 NSIS 安装包和免安装 ZIP 均未签名，Release notes 必须提示 SmartScreen 警告，不得声称无警告安装或首次运行。
- 发布说明必须明确 macOS 与 Windows 各自内置的 App Server 版本和 target，以及两个平台当前均无商业签名或公证。

## 产品边界

仓库当前记录 164 条规则；验收目录含 302 个案例，其中 170 个可执行、132 个缺口。规则级通过仍为 0 条，尚未完成全量验收。GitHub Release 是分发和版本归档，不等于 P08 完整交付。

发布说明必须明确 Windows 真机安装、登录、Bot/Routine、托盘、音频、微信扫描和 NSIS 卸载等验收是否已经完成；仅有 Windows CI 或交叉编译时不得写“Windows 完整可用”。

## 发布隔离

- Rambo 连接凭证只使用应用本地 AES-256-GCM，不读取 Electron `safeStorage`、macOS Keychain 或 `Chrome Safe Storage`。
- 发版期间的 Electron、打包、签名和通知检查不得读取或解密 Chrome Cookie/登录态。截图中若出现“security 想要使用 Chrome Safe Storage 中的机密信息”，应取消该工具动作并从发布检查中移除。
