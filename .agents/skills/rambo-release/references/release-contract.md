# Rambo 发布约定

## 渠道与版本

- 正式分发渠道：GitHub Releases，仓库 `jiawei666/Rambo`。
- 不使用 Mac App Store 或其他应用商店。
- `package.json` 是版本的单一来源；tag 使用 `v<version>`。
- 首个版本为 `v0.1.0`，作为普通标准 Release 发布，不标记 pre-release。
- 所有版本均不签名、不公证；这不是临时例外，也不降低发布类型。
- 版本 tag 必须指向已推送的发布 commit，且不能覆盖已有远端 tag。

## 产物

- 构建入口：`npm run package:mac`。
- 应用目录：`dist/mac-arm64/Rambo.app`。
- 活动开发机安装目录：`/Applications/Rambo.app`；默认使用同一份已重封的构建覆盖安装。
- 本机安装不覆盖 `~/Library/Application Support/Rambo`，不得以安装为由清除 Bot、会话、连接或本地 AES 凭证。
- 本地只保留活动应用 `/Applications/Rambo.app`；安装流程不得创建或保留 `.app` 备份、`backup`/`replaced` 副本或 `install-backups`。Git 与 GitHub Releases 是版本归档来源。安装前正常退出并核验待安装包，替换失败即停止，不以预存旧应用作为回滚手段。
- 上传格式：`Rambo-v<version>-macOS-arm64.zip`。
- 校验文件：`Rambo-v<version>-macOS-arm64.zip.sha256`。
- 不把 `dist/`、`acceptance-runs/` 或运行中的开发 profile 提交到 Git。
- GitHub Release 资产上传默认使用直连：执行 `gh release create` 或 `gh release upload` 时清除 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及其小写形式。用户明确指定代理时除外。

## 产品边界

仓库当前记录 155 条规则；验收目录含 267 个案例，其中 142 个可执行、125 个缺口案例，规则级通过仍为 0 条，尚未完成全量验收。GitHub Release 是分发和版本归档，不等于 P08 完整交付。发布说明必须如实列出已知验收边界，但不得把局部测试结果当作全规则通过。

## 签名与运行时

- 所有版本都以不使用 Developer ID、不公证为前提，生成仅含本地 ad-hoc 签名的 `.app`；Release 说明必须给出 Gatekeeper 首次启动步骤。
- electron-builder 必须显式设为 `identity: null`、`hardenedRuntime: false`、`notarize: false`，不能自动发现本机证书。
- 构建后用 `codesign --force --deep --sign -` 重封应用；`codesign --verify` 必须通过，`codesign -dv` 必须为 `Signature=adhoc` 且无 Authority/TeamIdentifier，`spctl` 必须仍拒绝。
- 每次发布在提交和上传前用 `node .agents/skills/rambo-release/scripts/install-local.mjs` 安装到 `/Applications/Rambo.app`；覆盖前正常退出正在运行的 Rambo，安装后核对版本、Bundle ID 和签名。
- 如果没有权限写入 `/Applications`，先提示用户处理本机安装权限；不得跳过本机更新并宣称完整发布。
- 不在发布说明中暗示安装时可无警告打开。
- 安装包内置经校验的 macOS arm64 Codex App Server `0.165.0` 基线；干净安装直接使用包内运行时，用户可另行主动更新，应用更新不得覆盖用户手动版本。Release 说明写明内置版本、独立更新边界以及需要 ChatGPT 登录、本机配置副本或兼容 API 才能使用。

## 发布隔离

- Rambo 连接凭证只使用应用本地 AES-256-GCM，不读取 Electron `safeStorage`、macOS Keychain 或 `Chrome Safe Storage`。
- 发版期间的 Electron、打包、签名和通知检查不得读取或解密 Chrome Cookie/登录态。截图中若出现“security 想要使用 Chrome Safe Storage 中的机密信息”，这是浏览器自动化辅助进程的越界系统授权请求，不是 Rambo 发布步骤；不得输入登录密码或点击“始终允许”，应取消该工具动作并从发布检查中移除。
