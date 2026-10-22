# Computer Use 本机组件与独立接入核对

日期：2026-10-20。状态：本机文件、启动脚本、包元数据及限定 REA 静态分析；未启动被分析程序、连接服务、截图、操作桌面或运行产品测试。

## 1. 结论

**Codex App Server 与 Computer Use 不是同一个可执行文件。** 本机有两套插件入口和独立的 Computer Use 服务；当前统一入口还依赖 ChatGPT.app 内的专用 Node/REPL 与 JS 模块。只复制 Codex 主程序不能证明 C01 的桌面操作可用。[S1–S5]

已有独立服务和旧式 MCP 客户端入口，提供了优先调查的接入候选；但本轮没有连接它们，因此不能断言“必须运行 ChatGPT GUI”，也不能断言“Rambo 已能完全脱离 ChatGPT 安装运行”。分发条件、客户端校验和实际权限仍未查清。

官方说明描述桌面插件与 macOS 屏幕录制/辅助功能权限，未在本轮找到第三方独立应用的完整组件分发契约。[官方 Computer Use](https://learn.chatgpt.com/docs/computer-use)

## 2. 当前机器的两套入口

### 2.1 `computer-use` 插件 1.0.1000926

根目录：`/Users/yuanjiawei/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000926/`。

`.mcp.json` 声明 `computer-use` MCP 服务：运行相对路径 `./bin/computer-use-client-launcher`，参数为 `mcp`，传入 `CODEX_HOME`。[S1]

启动器只有 13 行：第 5–6 行从 CODEX_HOME 拼接以下路径，第 8–10 行检查客户端是否可执行，第 13 行直接 exec 并传递参数。[S2]

```text
<CODEX_HOME>/computer-use/Codex Computer Use.app/
  Contents/SharedSupport/SkyComputerUseClient.app/
  Contents/MacOS/SkyComputerUseClient
```

这证明该 MCP 入口不是 Codex 主程序内置的一组鼠标键盘方法；它还需要此原生客户端及服务。本轮没有执行启动器，不能从其短脚本推断服务自动启动、授权或所有运行依赖。

插件 manifest 的 `license` 字段为 `Proprietary`。这只是本机元数据事实，不能据此宣称已获得随第三方应用复制分发的许可，也不能据此断言所有个人使用方式均被禁止。[S3]

### 2.2 `unified-computer-use` 插件 26.901.41600

根目录：`/Users/yuanjiawei/.codex/plugins/cache/openai-bundled/unified-computer-use/26.901.41600/`。

本机 `.mcp.json` 为 `cua_repl` 指定以下依赖：[S4]

| 配置 | 本机值/作用 |
| --- | --- |
| MCP 入口命令 | `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node` |
| 启动脚本 | 当前插件 `scripts/launch.mjs` |
| `CUA_REPL_NODE_REPL_PATH` | ChatGPT.app 内 `cua_node/bin/node_repl` |
| `NODE_REPL_NODE_MODULE_DIRS` | ChatGPT.app 内 `cua_node/lib/node_modules` |
| `SKY_CUA_SERVICE_PATH` | 本机 `.codex/computer-use/Codex Computer Use.app` |
| `CODEX_CLI_PATH` | `/Applications/ChatGPT.app/Contents/Resources/codex` |
| 已启用界面范围 | browser、computer |

本机配置确实写有上述路径。某项环境变量是否每次调用都会用到，仍要沿模块代码或运行行为证明，不能把“出现了路径”一律解释为强制调用。

`launch.mjs:7-9` 要求绝对路径的 REPL 可执行文件；`52-58` 启动该进程，并把 `@oai/sky/service`、可选浏览器服务注册为 trusted services；`80-92` 转发退出信号、处理子进程结束。[S5]

REA 只分析该启动脚本，未执行任何 bootstrap。其结果是静态语法和关系候选，其他 5 个 inventoried 源文件未分析，不是完整依赖树。

## 3. JS 桥接层怎样接触原生服务

本机 ChatGPT 包含 `@oai/sky` 0.6.26，导出 `./service` 到：

```text
dist/project/cua/sky_js/src/service.js
```

该入口创建平台客户端，再将调用转交其方法。macOS 的 `native-pipe.js` 形成更明确的依赖边界：[S6]

1. `globalThis.nodeRepl` 必须存在，否则抛出需要 trusted nodeRepl runtime 的错误。
2. 使用 `nodeRepl.nativePipe.createConnection`；不能把它当普通 Node `net` 模块已自动具备的能力。
3. 默认原生 socket 位置为用户 Library 下 OpenAI app-group 容器中的 `IPC/computeruse.sock`，另支持配置指定路径。
4. 初次连接失败时，若宿主服务管道存在，发送 `ensureService` 请求；否则通过 `nodeRepl.launchServices.openApplication` 请求启动服务。
5. 启动目标优先显式服务应用路径，然后 CODEX_HOME 中的安装位置，最后按服务 bundle identifier 选择。

第 4–5 项证明代码里存在“连接本机服务并请求启动独立服务”的路径，**不证明第三方任意 Node 进程有权限调用该管道**。对端是否验证签名、bundle 身份或连接者权限，本轮未逆向原生服务实现，保持未知。

因此，将配置中的 Node 路径随意替换成系统 Node，并不能视为兼容实现。需要一并核对专用宿主能力、模块装载、服务启动以及协议版本。

## 4. 本机原生应用身份

路径：`/Users/yuanjiawei/.codex/computer-use/Codex Computer Use.app`。[S7]

| 项目 | 本机只读核对结果 |
| --- | --- |
| Bundle identifier | `com.openai.sky.CUAService` |
| 版本 | 26.831.1000926，build 1000926 |
| 主程序 | `Contents/MacOS/SkyComputerUseService`，约 21.9 MiB |
| 嵌套客户端 | `SkyComputerUseClient.app`，主程序约 13.4 MiB |
| 其他配套 | 安装器与锁屏 Guardian；本产品不因存在这些文件而新增锁屏控制需求 |
| 签名元数据 | Developer ID Application: OpenAI OpCo, LLC，TeamIdentifier `2DC432GLL2` |

签名 entitlements 显示 OpenAI application group 与 keychain access group。只读取了签名元数据，未修改签名、权限或应用内容；也未做完整签名验证。不能假定把应用改名、重签到 Rambo 就能保留它的容器和 IPC 权限。

`otool -L` 的客户端依赖列表中观察到 macOS 系统框架与 Swift 动态库，未看到 ChatGPT.app 内动态库路径。此项只覆盖 Mach-O 显式链接，不证明没有运行时、服务或身份依赖。

## 5. 对 Rambo 的实现建议

### 第一候选：复用本机已安装的官方服务

先调查已安装原生客户端的 MCP 连接契约，或统一 REPL 的完整宿主运行时契约。Rambo 管理自己的 App Server，Computer Use 则接本机已有组件；不需要因此把原生 Codex 的聊天界面当作本产品界面。

这条是技术候选，不是已验证可运行方案，也没有替用户确认首次安装依赖。应先证明服务在 ChatGPT GUI 不运行时是否可接入，再谈是否可以移除 ChatGPT 安装。

### 独立分发：单独的阻塞项

要实现未装过 Codex/ChatGPT 的机器也可用，必须明确原生服务、客户端、专用 REPL/模块及其更新和安装来源；不能仅随包放 Codex 主程序后略过。当前只有本机安装物和元数据，不足以完成这一承诺。

### 电脑互斥必须在执行前生效

桌面控制通过 MCP 或统一 REPL 执行。只在消息界面维护“电脑占用”状态，无法阻止底层工具同时调用。须找出能在调用前取得 C02 租约的边界；若暂时只能粗粒度串行全部可能使用电脑的任务，需明确其影响并验证。不得为规避依赖改用已排除的 VM、云电脑或另一个桌面执行引擎。

## 6. 未执行的最小验证

| 验证问题 | 最小证据 | 本轮状态 |
| --- | --- | --- |
| 独立连接是否成功 | Rambo 所有的测试宿主能握手列出工具，实际来源可追踪 | 未执行 |
| 是否需要 GUI 前台/进程 | 正常退出相关 GUI 后仍能连接独立服务，不通过杀进程影响其他工作 | 未执行 |
| 无 ChatGPT 安装是否可用 | 在明确依赖清单的干净环境安装、启动与授权 | 未执行 |
| 实际权限和电脑操作 | 屏幕/辅助功能权限有效且能执行用户授权的可逆操作 | 未执行 |
| 互斥与停止 | 两任务不会同时操作；停止后旧调用不会继续碰电脑 | 未执行 |
| 配套分发是否成立 | 可使用的正式获取/分发依据与完整运行时清单 | 未解决 |

当前不运行上述步骤；本轮仅使设计阻塞更具体，不把它们记为产品通过。

## 7. 证据与限制

### 本机来源

- S1：旧插件 `.mcp.json`，SHA-256 `3516e1755f57daa9cc705c4dc048a149d5561f6d3b18059dc72fff721d7e9a73`。
- S2：旧插件 `bin/computer-use-client-launcher:5-13`，SHA-256 `096edf245e994f4a9a00177da90969acd2abe7d8acd73dad23844a40aea007f2`。
- S3：旧插件 `.codex-plugin/plugin.json`，SHA-256 `a9b0354b2bbf755e8f8863b8e7de8a30f14a53dcd921802287c686b0a40c862a`。
- S4：统一插件 `.mcp.json`，SHA-256 `c53e7fd29da2172a332c01aae6d6d609f455f65370bb4782f65b29c54c49464c`。
- S5：统一插件 `scripts/launch.mjs`，SHA-256 `a50b66879f7b72e45ab6fbaad77eff14a87680a946135f410c121b9b166a2597`。
- S6：ChatGPT.app 内 `@oai/sky` 的包清单、`service.js` 与 `targets/mac/native-pipe.js`；未装载或执行这些模块。
- S7：上述独立原生应用的 Info.plist、`codesign -d`、`otool -L` 只读结果。服务主程序 SHA-256 `25e9141499b94c396f39afbdb7b19ed8f49e45dc8c61be61028ceab8f3807ce6`；客户端 `5e0d0824d0e1486d531326ee4ca07315089e6648be866f2fef22873cdb7711fe`。

### REA

- 启动器父 Evidence：`ev_ded30773acc042d79ed0f957c46cafbf06f97ca3ce4462015983d9da9754d395`，仅分析 `scripts/launch.mjs`。摘要已收录：[JSON](evidence/cua-launcher-rea-summary.json)。
- 原生管道 JS 父 Evidence：`ev_2ed1dc1cbdad44be4b25634f7dc78df54097d4bc80c7c0ff3b12041b55348fcd`，仅分析 `service.js`、`targets/mac/native-pipe.js`，180 个其他 inventoried 文件未分析。摘要已收录：[JSON](evidence/sky-native-pipe-rea-summary.json)。
- REA 的图覆盖为 partial，既不代表完整调用图，也不证明实际执行；路径和语法观察由主 Agent 直接复读对应文件补充核对。

插件管理元数据查询未将 `computer-use@openai-bundled` 识别为公开目录条目，因此该工具未提供可用依赖清单；没有据此推断本机插件不存在，也没有安装、卸载或修改任何插件。
