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
- 上传格式：`Rambo-v<version>-macOS-arm64.zip`。
- 校验文件：`Rambo-v<version>-macOS-arm64.zip.sha256`。
- 不把 `dist/`、`acceptance-runs/` 或运行中的开发 profile 提交到 Git。

## 产品边界

仓库当前记录 122 条规则，其中 101 个案例明确未实现，尚未完成全量验收。GitHub Release 是分发和版本归档，不等于 P08 完整交付。发布说明必须如实列出已知验收边界，但不得把局部测试结果当作全规则通过。

## 签名与运行时

- 所有版本都以不使用 Developer ID、不公证为前提，生成仅含本地 ad-hoc 签名的 `.app`；Release 说明必须给出 Gatekeeper 首次启动步骤。
- electron-builder 必须显式设为 `identity: null`、`hardenedRuntime: false`、`notarize: false`，不能自动发现本机证书。
- 构建后用 `codesign --force --deep --sign -` 重封应用；`codesign --verify` 必须通过，`codesign -dv` 必须为 `Signature=adhoc` 且无 Authority/TeamIdentifier，`spctl` 必须仍拒绝。
- 不在发布说明中暗示安装时可无警告打开。
- Codex App Server 不随包分发；应用优先本机独立运行时、其次缓存、最后下载校验后的独立 package。Release 说明写明需要本机 Codex 认证或首次登录。
