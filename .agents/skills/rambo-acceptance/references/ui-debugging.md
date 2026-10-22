# Rambo UI 调试手册

## MCP 配置

Codex 的全局 MCP 配置应包含：

```sh
codex mcp add playwright -- npx -y @playwright/mcp@0.0.83 --cdp-endpoint http://127.0.0.1:19222
```

Rambo 专用端口为 `19222`，与 Chrome 常用的 `9222` 分开。

这条配置已经安装到当前用户的 Codex 配置，当前固定版本为 `0.0.83`。Codex 可能需要重启后才会加载新增的 MCP 工具。Playwright MCP 使用 Electron 的 Chromium DevTools Protocol 页面，不会另开一个普通浏览器来代替应用。

## 连接本轮实例

1. 通过 `scripts/launch.mjs` 启动已登记的验收 run。启动器会确认 `127.0.0.1:19222` 可用，并在 Electron 验收进程中启用仅绑定回环地址的 CDP。
2. 打开本轮 `acceptance-runs/<run-id>/launch.json`，核对 `runId`、`pid`、`profile`、`buildHash`、`cdpEndpoint` 和 `cdpTarget`。这些字段必须指向当前要测的独立实例。
3. 使用 Playwright MCP 获取页面快照或截图。确认页面是 Rambo 主窗口、页面已加载且 target 与 `launch.json` 一致后，才操作或创建测试数据。
4. 首次使用时记录 Playwright MCP 版本；将关键状态、页面截图和断言保存到本轮 `evidence/`，在台账中逐案例登记。外部副作用结果未知时先检查当前状态，不自动重复动作。

若页面报告 `document.visibilityState === 'hidden'`、`document.hasFocus() === false`，或 Playwright 点击因窗口在后台而超时，先通过 Computer Use 激活 `launch.json` 指向的 Rambo Electron 窗口，再用 Playwright 复查页面可见、有焦点且仍是本轮 target。Computer Use 在此仅切换应用前台，不代替 Playwright 操作产品 UI。不要让用户手动切前台；仅当系统权限或窗口管理状态阻止自动激活时，才说明具体阻碍并请求用户接管。

启动器的 `cdpTarget` 是启动时读取的 target 快照。页面重载后 target 可能重新生成；操作前以 Playwright MCP 当前列出的页面为准，并确认仍连接本轮应用。不要仅凭端口响应、PID 存在、标题或编译成功判断页面可测。

## 工具边界

- Playwright MCP：Rambo 窗口内的页面结构、可见 UI、交互、截图、控制台和页面调试。
- Computer Use：Rambo 验收窗口的前台/焦点恢复、macOS 原生权限/文件/菜单对话框、跨应用操作、真实设备，以及 Rambo 产品 Bot 自己执行的电脑操作。前台恢复后切回 Playwright 操作 Electron 页面。
- Node/生产模块测试：可用于纯逻辑和受控边界，不证明 UI 流程或真实外部集成通过。
- 直接调用 `window.rambo`、IPC、数据库：只用于夹具准备或故障定位，不能记作真实 UI 步骤通过。
- 不要用 `browser_close` 关闭页面，也不要导航离开 Rambo；该 MCP 连接的页面就是验收 Electron 窗口。结束验收时通过启动器/终端正常停止应用。

一个验收 run 同时只允许一个 UI 操作者。交接时先停止前一操作者对当前 Electron 实例的动作，再开始下一工具的操作。

## 故障处理

- `19222` 已占用：不要连接占用者或更换为日常浏览器；确认无其他验收进程使用后再重启启动器。
- MCP 工具不存在：Codex 尚未加载新增配置时重启 Codex，然后确认 Playwright MCP 工具已出现。
- CDP 连接失败或 target 不符：保留启动错误、`launch.json` 和本轮日志，记为工具/环境受阻；继续不依赖 UI 的案例。
- 页面没有预期控件或结果：保存当前结构、截图和控制台状态，按产品结果判失败或受阻；不要用坐标盲点或重复可能已产生副作用的操作。
