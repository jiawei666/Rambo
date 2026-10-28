---
name: rambo-release
description: 校验并打包 Rambo 的 macOS 应用，同步更新本机 /Applications/Rambo.app，生成可上传的 zip 与校验和，提交当前工作区、创建版本 tag，并把产物发布到 GitHub Releases。用于用户明确要求打包、构建、发布或为 Rambo 创建 GitHub Release 时；不用于普通开发构建或仅本地预览。
---

# 打包并发布 Rambo

只在用户明确要求发布时执行。发布是外部副作用：会替换本机 `/Applications/Rambo.app`、提交当前工作区、推送 `main`、创建 tag 和公开 Release。开始前核对仓库、版本、目标 commit、签名状态和将要上传的文件；用户已经明确要求“写完后执行”时不要停在只写 Skill。

## 发布前核对

1. 从仓库根目录读取 `AGENTS.md`、`package.json`、`README.md`、`docs/product-decisions.md` 的 P09/Q78，以及本 Skill 的 [发布约定](references/release-contract.md)。
2. 确认 `origin`、当前分支、远端最新提交、`gh auth status`、已有 tag 和 Release。不要对错误的 fork、私有/公开状态或默认分支发布。
3. 版本优先采用用户明确给出的版本；没有时使用 `package.json` 的 `version`。如果该版本已有 tag 或 Release，停止并要求选择下一版本，不覆盖已有发布。
4. 检查工作区全部改动，包括未跟踪文件。发布提交必须包含本次要发布的代码、文档、Skill 和资源，不能遗漏；也不能擅自回退或删除用户已有改动。报告中明确列出被纳入发布的路径。
5. 按用户已确认的长期发布规则创建普通标准 Release，不添加 `--prerelease`，也不在版本标题中附加 `pre-release`、`development` 或 `preview` 标签。发布说明仍须如实记录已知验收边界，不能把局部测试结果写成 P08 全量验收通过。
6. 所有版本都以不签名、不公证为前提；按现有配置构建未签名 `.app`，不以签名或公证为发布门禁。Release 说明必须写明未签名状态和 Gatekeeper 首次启动步骤，不能声称可无警告安装。

## 构建

使用仓库现有入口，不另造一套打包流程：

```sh
npm run package:mac
```

该命令会准备图标、执行 Electron 构建并生成 `dist/mac-arm64/Rambo.app`。`package.json` 固定 `identity: null`、`hardenedRuntime: false` 与 `notarize: false`，构建日志不得出现 `signing`。然后把 `.app` 压成 GitHub Release 可下载的 zip，并生成 SHA-256 校验和。优先使用本 Skill 的打包脚本：

```sh
node .agents/skills/rambo-release/scripts/package-release.mjs
```

脚本必须在 macOS 上运行，输出到 `dist/release/<version>/`，输出文件名为 `Rambo-v<version>-macOS-arm64.zip` 和对应的 `.sha256`。不要手工修改压缩包内容；如需上架额外格式，另行确认。

构建并重封 ad-hoc 签名后，将本次同一个构建同步安装到本机 `/Applications/Rambo.app`。安装会使用 `ditto` 复制完整应用目录，不清理或覆盖 `~/Library/Application Support/Rambo`，因此现有 Bot、会话、连接和本地 AES 凭证保持不变。调用方可用 `RAMBO_INSTALL_DIR` 覆盖目标目录；默认值固定为 `/Applications`。执行：

```sh
node .agents/skills/rambo-release/scripts/install-local.mjs
```

脚本若发现 Rambo 正在运行，必须请求应用正常退出，等待进程结束后再替换应用。无法退出或替换后版本、Bundle ID、签名不一致时停止发布，不能直接清空应用数据。首次没有旧应用时也应继续安装。安装完成后检查：

本地只保留活动的 `/Applications/Rambo.app`。安装流程不得创建或保留 `.app` 备份、`backup`/`replaced` 副本或 `install-backups`；Git 与 GitHub Releases 是版本归档来源，替换失败即停止，不以预存旧应用作为回滚手段。

```sh
plutil -extract CFBundleShortVersionString raw /Applications/Rambo.app/Contents/Info.plist
codesign --verify --deep --strict /Applications/Rambo.app
```

安装后还应检查：

```sh
codesign --verify --deep --strict dist/mac-arm64/Rambo.app
codesign -dv --verbose=4 dist/mac-arm64/Rambo.app 2>&1
spctl -a -vv dist/mac-arm64/Rambo.app 2>&1 || true
```

构建日志不得出现 Developer ID 证书签名。打包脚本随后用 `codesign --force --deep --sign -` 重封本地 ad-hoc 签名：没有证书和团队 ID，但能让改名后的 `.app` 结构有效。必须用 `codesign --verify` 和 `codesign -dv` 核验 `Signature=adhoc`、无 Authority/TeamIdentifier，且 `spctl` 仍拒绝；资源缺失、包内包含意外运行时或 zip 校验和不一致时停止发布。

## 提交与发布

1. 先运行本次发布需要的测试。完整产品验收门槛与开发发布门槛不同；至少确认构建成功、目标测试和 `npm run test:catalog` 通过。用户只要求打包发布、不要求完整验收时，不得伪称 P08 已通过。
2. 检查 `app.asar` 不得重复携带已由 Vite 打进 `out/renderer` 的前端依赖。记录 `.app` 与 zip 大小；异常增长时先检查 asar 内的 `node_modules`。
3. 审核 `git diff` 和 `git status`，只暂存本次发布范围。提交信息使用 `Release v<version>`；不要 amend 既有提交，不要 `git reset --hard`。本机安装发生在提交前，确保安装的应用来自待发布的构建；安装失败时不得继续提交和外部发布。
4. 推送当前分支到 `origin`：

```sh
git push origin main
```

5. 创建 annotated tag，并推送：

```sh
git tag -a v<version> -m "Rambo v<version>"
git push origin v<version>
```

6. 用 `gh` 创建标准 Release，上传 zip 和 `.sha256`。上传 GitHub Release 资产时必须绕过 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及其小写形式，直接连接 GitHub；用户明确指定代理时除外。当前环境中的代理曾将上传降至约 28 KB/s 并触发 `408`，直连则可稳定完成。使用下面的方式执行创建、查看或上传命令：

```sh
env -u http_proxy -u https_proxy \
  -u HTTP_PROXY -u HTTPS_PROXY \
  -u ALL_PROXY -u all_proxy \
  -u no_proxy -u NO_PROXY \
  gh release create v<version> \
  dist/release/v<version>/Rambo-v<version>-macOS-arm64.zip \
  dist/release/v<version>/Rambo-v<version>-macOS-arm64.zip.sha256 \
  --title "Rambo v<version>" \
  --notes-file <release-notes-file>
```

如果 Release 已创建但资产上传中断，使用同一组 `env -u ...` 清理代理变量后分别执行 `gh release upload v<version> <asset> --clobber`，并在重试后核对远端资产大小与状态。不要添加 `--prerelease`；已确认的首版按最新正式 Release 发布。Release notes 至少包含：目标 commit、构建平台、应用架构、运行时获取方式、未签名/未公证状态与首次启动步骤、SHA-256、已知验收边界和下载文件说明。

7. 发布后回查真实远端结果与本机安装结果：

```sh
gh release view v<version> --json tagName,name,isPrerelease,isDraft,url,assets
git ls-remote --tags origin v<version>
plutil -extract CFBundleShortVersionString raw /Applications/Rambo.app/Contents/Info.plist
codesign --verify --deep --strict /Applications/Rambo.app
```

确认 tag 指向本次发布 commit、Release 非 draft、两个资产已上传、URL 可访问，且本机 `/Applications/Rambo.app` 的版本与签名均匹配。最终回复中给出 Release URL、tag、commit、资产名、SHA-256 和本机安装路径。不能仅凭本地命令成功就说远端发布完成。

## 失败处理

- 构建失败：停止，保留日志，不创建 tag/Release。
- 测试失败：报告规则和失败原因；除非用户明确接受预发布风险，不继续外部发布。
- 远端已有同名 tag/Release：停止，不覆盖、不移动已发布 tag。
- 推送或上传失败：保留本地提交和产物，报告远端实际状态；不要重复创建 Release。Release 资产上传失败时，先确认 Release 是否已存在，再用清除代理变量的直连命令继续未完成的资产上传。
- 本机安装失败：停止提交和外部发布，保留构建产物与现有应用数据；不要删除 `~/Library/Application Support/Rambo`。修复运行中退出、权限、版本或签名问题后重新执行安装。
- 本机安装与远端发布并非原子操作：如果远端已经发布而本机安装复核失败，必须明确报告这一不一致，并按实际安装路径和版本排查。
- 未签名/未公证：这是所有版本的长期发布前提，不是失败或降级条件；必须写入 Release 说明，最终报告不能省略。
