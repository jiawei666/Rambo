# Rambo 发布约定

## 渠道与版本

- 正式分发渠道：GitHub Releases，仓库 `jiawei666/Rambo`。
- 不使用 Mac App Store、Microsoft Store 或其他应用商店。
- `package.json` 是版本单一来源；tag 使用 `v<version>`。
- 正式 Release 默认必须同时提供 macOS ARM64 和 Windows x64；其他架构只有在用户明确要求并在对应原生构建机完成后才能加入。
- tag 必须指向已推送的发布 commit，不能覆盖已有远端 tag。

## 产物

- 默认正式发布集合：
  - `Rambo-v<version>-macOS-arm64.zip` 与 `.sha256`
  - `Rambo-v<version>-Windows-x64.exe` 与 `.sha256`
- 本机 release metadata：
  - `Rambo-v<version>-darwin-arm64.release.json`
  - `Rambo-v<version>-win32-x64.release.json`
- macOS 构建入口：`npm run release:package -- darwin-arm64`。
- Windows 构建入口：`npm run release:package -- win32-x64`。
- 双平台合并校验入口：`npm run release:verify -- darwin-arm64,win32-x64`。
- 不把 `dist/`、`acceptance-runs/` 或运行中的开发 profile 提交到 Git。
- GitHub Release 资产上传默认使用直连；执行 `gh release create` 或 `gh release upload` 时清除代理变量。

## 平台与运行时

- 平台打包必须在匹配的宿主上执行；禁止用 macOS 交叉生成 Windows 原生包，也禁止用 x64 结果冒充 ARM64。
- 每个安装包只能包含本平台、本架构的 `codex-app-server`：
  - `darwin-arm64` -> `aarch64-apple-darwin`
  - `darwin-x64` -> `x86_64-apple-darwin`
  - `win32-x64` -> `x86_64-pc-windows-msvc`
  - `win32-arm64` -> `aarch64-pc-windows-msvc`
- 固定版本、归档 SHA-256、入口和 manifest 以 `config/runtime-targets.json` 为准。
- 打包脚本必须从包内 `runtime/codex/<version>` 读取 `codex-package.json` 与 `rambo-runtime.json`，并实际检查入口二进制为 Mach-O 或 PE 的目标架构。
- 任一平台缺包、缺 sidecar、SHA-256 不一致、App Server 版本/目标不一致或二进制架构不符，均阻止正式发布。

## 签名与安装

- macOS 当前不使用 Developer ID、不公证；构建后只做本地 ad-hoc 重封。`codesign --verify` 必须通过，`codesign -dv` 必须为 `Signature=adhoc` 且无 Authority/TeamIdentifier，`spctl` 仍会拒绝。
- Windows 当前 NSIS 安装包未签名，Release notes 必须提示 SmartScreen 警告，不得声称无警告安装。
- 每次发布在提交和上传前使用 macOS 构建更新活动开发机的 `/Applications/Rambo.app`；覆盖前正常退出正在运行的 Rambo，安装后核对版本、Bundle ID 和签名。
- 本机更新不得清理或覆盖应用数据目录。本地只保留活动应用，不保留 `.app` 备份、`backup`/`replaced` 副本或 `install-backups`。
- Windows 构建机不执行 macOS 的 `/Applications` 安装步骤；Windows 产品验收与安装验收另行记录。

## 产品边界

仓库当前记录 156 条规则；验收目录含 272 个案例，其中 146 个可执行、126 个缺口。规则级通过仍为 0 条，尚未完成全量验收。GitHub Release 是分发和版本归档，不等于 P08 完整交付。

发布说明必须明确：

- macOS 与 Windows 各自内置的 App Server 版本和 target。
- 两个平台当前均无商业签名或公证。
- Windows 真机安装、登录、Bot/Routine、托盘、音频、微信扫描和 NSIS 卸载等验收是否已经完成；仅有 Windows CI 或交叉编译时不得写“Windows 完整可用”。

## 发布隔离

- Rambo 连接凭证只使用应用本地 AES-256-GCM，不读取 Electron `safeStorage`、macOS Keychain 或 `Chrome Safe Storage`。
- 发版期间的 Electron、打包、签名和通知检查不得读取或解密 Chrome Cookie/登录态。截图中若出现“security 想要使用 Chrome Safe Storage 中的机密信息”，应取消该工具动作并从发布检查中移除。
