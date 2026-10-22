# App Server 本机协议核对

日期：2026-10-20。状态：只读 CLI/协议调查；未启动对话、登录、推理、录音或电脑操作，未执行产品测试。

## 1. 核对对象

- 本机命令入口：`/Users/yuanjiawei/.nvm/versions/node/v24.14.0/bin/codex`。
- 实际 JS 启动器：`/Users/yuanjiawei/.nvm/versions/node/v24.14.0/lib/node_modules/@openai/codex/bin/codex.js`。
- `codex --version` 输出：`codex-cli 0.163.0`。
- npm 包版本同为 `@openai/codex 0.163.0`；启动器按平台选择原生发行物，不能只复制 JS 文件就视为独立分发完成。
- 本轮只读过启动器和包元数据，尚未确定最终打包的全部原生文件、体积或分发条件。

## 2. 本轮执行的调查命令

```text
codex --version
codex app-server --help
codex app-server generate-json-schema --help
codex app-server generate-json-schema --experimental --out /tmp/rambo-design-codex-0163-schema
```

生成文件位于临时目录，以下摘要及 SHA-256 用于项目内留档。生成 schema 只证明该二进制暴露的协议形状，不证明账号权限、服务端支持或端到端调用成功。

## 3. 方法摘要

本轮 ClientRequest schema 共解析出 172 个方法；这不是 172 项已验证产品功能。

| 类别 | 本轮 schema 存在的方法 |
| --- | --- |
| 普通会话、账号及资源 | `initialize`、`thread/start`、`thread/resume`、`thread/list`、`thread/read`、`thread/turns/list`、`thread/items/list`、`thread/archive`、`thread/delete`、`thread/unarchive`、`turn/start`、`turn/steer`、`turn/interrupt`、`account/read`、`account/login/start`、`account/login/cancel`、`account/logout`、`model/list`、`skills/list`、`skills/config/write`、`mcpServerStatus/list`、`mcpServer/oauth/login`、`config/mcpServer/reload` |
| 实时语音请求 | `thread/realtime/start`、`thread/realtime/appendAudio`、`thread/realtime/appendText`、`thread/realtime/appendSpeech`、`thread/realtime/stop`、`thread/realtime/listVoices` |
| 实时语音通知 | `thread/realtime/started`、`thread/realtime/itemAdded`、`thread/realtime/item/started`、`thread/realtime/item/transcript/delta`、`thread/realtime/item/completed`、`thread/realtime/transcript/delta`、`thread/realtime/transcript/done`、`thread/realtime/outputAudio/delta`、`thread/realtime/sdp`、`thread/realtime/error`、`thread/realtime/closed` |
| 宿主动态工具 | `item/tool/call` |

## 4. 决定架构边界的字段

| 参数 | 核对结果 | 实现含义 |
| --- | --- | --- |
| `ThreadStartParams` | 包含 `threadSource`、`serviceName`、`config`、`dynamicTools`、`selectedCapabilityRoots` | 有来源/配置/工具入口；不证明原生客户端如何展示该来源，亦不证明逐 Bot 资源筛选已经生效 |
| `ThreadListParams.originators` | 描述明确限定 hosted backend，本地传非空会被拒绝 | 不能用它实现本机 Rambo 来源过滤 |
| `ThreadListParams.sourceKinds` | 可按来源种类筛选，默认交互来源 | 列表过滤不是目录或账号隔离 |
| `ThreadRealtimeStartParams` | 必填 `threadId`、`outputModality`，另有 `transport`、`version`、交接及上下文字段 | Voice 与线程绑定；需要确认实际媒体协商及交接行为 |
| `ThreadRealtimeStopParams` | 必填 `threadId` | 有停止入口，不证明模型已经能主动调用宿主挂断 |
| `SkillsConfigWriteParams` | `enabled` 必填，可用 `name` / `path` | 这是配置写入，不应直接当作每 Bot 独立开关 |
| `TurnSteerParams` | 必填 `threadId`、`expectedTurnId`、`input` | 可识别要引导的当前轮次；繁忙与过期轮次错误处理需实现 |

## 5. 快照摘要

| 文件（临时 schema 目录内） | SHA-256 |
| --- | --- |
| `ClientRequest.json` | `92d920b10b9ce7871e21f49573275bb931a58ad7fd367ab71b3716edbb6a0352` |
| `ServerNotification.json` | `c626079776d401d358a8791b74cfe6c978d18aabbb78477ce7bd710a79779bc1` |
| `v2/ThreadStartParams.json` | `80a40a7fac15b4bf70efb7f893fb353acc0a0d30c68f54aee4f01923deca85de` |
| `v2/ThreadListParams.json` | `158dc75c077662b181191dd258d2670d505505e84c40c62214bf20d3364a5520` |
| `v2/ThreadRealtimeStartParams.json` | `b457a9de5f14d590c6ed42d46c78d2524d54f4fc7723d2e221657432fc8f749f` |
| `v2/ThreadRealtimeStopParams.json` | `da0e765e71d37c3c0b331e7666ad5c32483e2b0775e8439b642ec63602c974cb` |

## 6. 仍未证明的能力

- 同一个 CODEX_HOME 下，Rambo 线程在原生 CLI/桌面默认历史中的实际可见性，以及仅本应用线程的备份恢复。
- 当前账号能否通过这些实验协议完成真实音频通话、自然语言挂断、记忆确认和定时任务工具交接。
- Computer Use 的独立运行条件、工具拦截/互斥和配套组件分发。
- 每 Bot 启用的 MCP/Skills 能否在共享进程中真正区分，且不改写其他客户端配置。
- 独立运行时能否复用既有连接器及生图能力。

上述状态仍为待验证，不能把文档里存在字段作为验收通过。技术安排见 [技术设计](technical-design.md)，功能通过条件见 [验收矩阵](acceptance-matrix.md)。

官方对照：[App Server](https://learn.chatgpt.com/docs/app-server)。本页以本轮本机生成结果为主，不能由更新后的线上文档反推旧二进制必定实现所有新能力。

## 7. 后续只读核对：实际原生发行物

同日继续调查后已定位本机全局 npm 平台包，位于主 npm 包的 `node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/`。`codex-package.json` 指定版本 0.163.0、入口 `bin/codex`、资源目录 `codex-resources` 和 PATH 资源目录 `codex-path`。

| 内容 | 本机逻辑大小（约） |
| --- | --- |
| `bin/codex` | 238.4 MiB |
| `bin/codex-code-mode-host` | 62.6 MiB |
| `codex-resources/voice/bin/codex-voice-host` | 9.1 MiB |
| 整个平台目录，41 个文件 | 325.0 MiB |

这是此版本此架构的未压缩逻辑文件大小，不是 Rambo 的最终包体积、压缩下载量或运行内存，也未包含单独的 Computer Use 组件。未证明可以省略任何配套文件。完整路径、文件大小和 SHA-256 已记录为 [发行物清单](evidence/codex-0.163.0-darwin-arm64-inventory.json)。

进一步的认证/媒体分支、历史来源和 Computer Use 依赖调查分别见后续专题文档；新增静态发现不改变实际调用仍未验证的状态。

## 8. 上游独立 App Server 发行包

第二轮从上游 rust-v0.163.0 release 下载并只读检查 `codex-app-server-package-aarch64-apple-darwin.tar.gz`，归档约 97.26 MiB，4 个文件逻辑大小合计约 249.15 MiB。manifest 的 variant 为 codex-app-server，入口为 bin/codex-app-server；包内还有 Code Mode Host、rg 和 manifest，没有 Voice Host 或 Computer Use 服务。

这和 §7 的完整 CLI 平台包不是同一个发行物。清单与观察到的 SHA-256 见 [独立包证据](evidence/codex-app-server-0.163.0-darwin-arm64-inventory.json)，来源参数方案见 [历史隔离方案](history-isolation-plan.md)。仅检查 tar 成员，没有提取并执行其二进制或进行功能验证。
