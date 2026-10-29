---
name: rambo-clean-login-test
description: 在隔离的临时 HOME、CODEX_HOME 和 userData 中启动 Rambo 候选 .app，复现全新用户的 ChatGPT 登录场景并安全清理环境；用于验证首次登录入口、authUrl、等待授权和登录后刷新，不用于日常开发或普通 UI 验收。
---

# Rambo 干净环境登录测试

目标是验证一个从未使用过 Codex/Rambo 的用户，能够在候选 `.app` 中完成以下旅程：

1. 首次启动直接使用包内 App Server，不触发下载。
2. 页面显示“登录 ChatGPT / 配置 API”，点击登录后得到真实非空 HTTPS 授权地址。
3. 系统浏览器被调用；即使调用失败，页面仍显示“重新打开登录页面”。
4. 页面进入“等待授权…”，授权完成后自动刷新账号和侧栏，不要求重新打开应用。

先读取仓库 `AGENTS.md`、`docs/product-decisions.md` 的 A02/A03/A08/A09，以及 `.agents/skills/rambo-acceptance/SKILL.md`。本 Skill 不改变这些产品规则。

## 选择验证方式

**确定性回归优先**：候选包已经生成时，先运行现有打包版登录测试：

```sh
RAMBO_APP_PATH=dist/mac-arm64/Rambo.app \
  npx playwright test tests/e2e/packaged-app.spec.mjs \
  --grep "候选应用点击 ChatGPT 登录后提供可重开地址"
```

该测试会创建自己的 `acceptance-runs` 数据，检查 `auth.openai.com` 地址、可重开链接和“等待授权…”。若候选包不存在，先按 `rambo-release` Skill 运行 `npm run package:mac`，不要拿旧包冒充当前代码。

需要用户实际点击并观察系统浏览器时，使用隔离启动器：

```sh
node .agents/skills/rambo-clean-login-test/scripts/clean-login.mjs start \
  --app dist/mac-arm64/Rambo.app
```

启动器不会复制或修改 `.app`。它只创建类似 `/private/tmp/rambo-clean-login-XXXXXX/` 的临时根目录，把 `HOME`、未初始化的 `CODEX_HOME`、`TMPDIR`、Chromium `user-data-dir` 和日志全部放进去，然后通过 `open -n -F <绝对应用路径>` 启动并把窗口置顶。

用户点击登录后，确认：

- 系统浏览器打开的是 `https://auth.openai.com/...`，不能只有“登录流程已启动”而没有地址。
- Rambo 页面保留“重新打开登录页面”，登录按钮显示“等待授权…”且不可重复点击。
- 完成授权后账号卡和侧栏自动刷新。
- 失败时显示可操作错误，不得把空白 `authUrl`、空对象或仅启动浏览器当成成功。

不要自动填写账号、密码、验证码或 Face ID；不要清理或登出系统浏览器的日常登录态。

## 确认运行状态

```sh
node .agents/skills/rambo-clean-login-test/scripts/clean-login.mjs status \
  --session /private/tmp/rambo-clean-login-XXXXXX
```

必须同时核对：

- 主进程 PID 仍存活，命令行指向本次候选应用和本次 `user-data-dir`。
- `codex-app-server` 是主进程子进程，路径来自应用包或该隔离 profile，参数含 `--session-source app-server`。
- 候选应用版本、Bundle ID、内置运行时版本与进程实际路径一致。
- 日志没有启动致命错误；macOS 偶发 `sandbox_extension_issue_file_to_process` 只有在应用仍存活且窗口可用时才作为已知非致命日志记录。

## 清理

当前会话结束后立即执行：

```sh
node .agents/skills/rambo-clean-login-test/scripts/clean-login.mjs cleanup \
  --session /private/tmp/rambo-clean-login-XXXXXX
```

批量清理本 Skill 产生的遗留环境：

```sh
node .agents/skills/rambo-clean-login-test/scripts/clean-login.mjs cleanup-all
```

清理脚本只接受 `/private/tmp/rambo-clean-login-*` 且含有效 `session.json` 的目录。它先优雅停止清单中的测试 PID，确认 PID 未被其他程序复用时才删除目录。绝不删除 `/Applications/Rambo.app`、`~/Library/Application Support/Rambo`、日常 Codex Home、系统浏览器 Profile、项目候选构建或其他临时应用。

## 证据边界

- 自动化测试证明候选包登录入口返回真实格式的 `auth.openai.com` 地址，不证明用户已完成外部 OAuth。
- 只有实际完成系统浏览器授权并看到账号刷新，才能报告“真实 ChatGPT 登录回调通过”。
- 只有完成一个真实模型回合，才能报告登录后的模型调用通过。
- 任何测试环境中的 token、Cookie、授权码和账号敏感信息都不得写入报告或截图。
