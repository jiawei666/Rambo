# 历史隔离方案：本机二进制与独立会话目录

当前方案：2026-10-26 用户已接受 [Q147](decision-followups.md#q147)，使用本机同一二进制、独立 CODEX_HOME 与共享认证文件；第 1–7 节为历史调查，第 8 节为当时的候选探测。运行证据与现状见第 9 节。

日期：2026-10-20。状态：第二轮只读调查形成的技术推荐；已下载并只读核对独立发行物归档，未启动其中程序、未构建代码、未运行功能测试；不是 A04 已验收。

2026-10-26 补充：[Q145](decision-followups.md#q145) 确认“Rambo 自己启动进程”不要求使用另一份二进制，本机 `bin/codex` 也可作为候选入口。但本机 0.164.0 的 `codex app-server` 不提供来源参数且固定传入 `SessionSource::VSCode`；因此沿用本方案的独立入口，是为了满足 A04，不是独立进程的必然要求。若未来本机 CLI 可设置专属来源，可直接由 Rambo 拉起它自己的子进程。

## 1. 本轮找到的直接路径

上游存在两个入口，不能混为一谈：

| 入口 | 0.163.0 源码行为 | 对 Rambo 的意义 |
| --- | --- | --- |
| `codex app-server` | 主 CLI 分支固定传 `SessionSource::VSCode` | 不能仅改 threadSource/clientInfo 就保证原生默认列表不混入 |
| 独立 `codex-app-server` | 自己的 main 支持 `--session-source SOURCE`，随后传给相同 App Server 库 | 可研究直接选择上游已有的 AppServer 来源，不必先自行修改核心 |

独立入口的参数定义见 [main.rs:48–55](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/main.rs#L48)，调用时传入参数见 [main.rs:125–139](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/main.rs#L125)；Cargo 明确有名为 `codex-app-server` 的独立 bin。[Cargo.toml](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/Cargo.toml)

不能把 npm 内的 `codex` 文件改名为 `codex-app-server` 就期待另一套参数出现：两个入口是不同的构建目标。

## 2. 推荐的启动形态

以下仅为文档中的目标启动命令，本轮没有执行：

```text
<Rambo 包内>/codex-app-server --listen stdio:// --session-source app-server
```

继续使用原本的 CODEX_HOME，沿 A03 复用认证、配置及资源；独立进程归 Rambo 管理。客户端 name 使用真实 Rambo 标识，绝不伪装第一方客户端。

参数值 `app-server` 会由 `SessionSource::from_startup_arg` 映射到内部枚举 `SessionSource::Mcp`。[protocol.rs:3063–3077](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/protocol/src/protocol.rs#L3063)

这里的 Mcp 是历史沿用的**来源枚举名**，在列表 API 中映射为 `appServer`，不是将 Rambo 改为通过 MCP 协议调用 Codex，也不是恢复已移除的 `codex mcp-server`。控制协议仍为 App Server JSON-RPC。[filters.rs:53–58](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/filters.rs#L53)

### 为什么不直接填自定义 Rambo 来源

`--session-source rambo` 虽然会解析为 `Custom("rambo")`，却还会参与 product restriction。任意自定义名字不自动映射为 Product::Codex；ThreadManager 会将该 product 用于 Skills 和插件服务的发现条件，可能改变本来可以使用的资源。[protocol.rs:3118–3134](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/protocol/src/protocol.rs#L3118)、[thread_manager.rs:555–567](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/thread_manager.rs#L555)

上游的 `app-server` 来源则仍映射 Product::Codex。因此优先采用它，将 Rambo 专属归属放在自己的 thread ID 映射和真实客户端标识上。源类别可隐藏默认交互列表，但不是本应用独占的全局命名空间。

## 3. 为什么此路径可能满足“默认不混入”

### 全局原生 CLI：0.163.0

已核对其默认恢复列表明确请求 Cli 与 VsCode；额外显示非交互任务才加入 Exec/AppServer。AppServer 不在默认集合中。[tui/lib.rs:778–787](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/lib.rs#L778)

### 当前桌面应用：26.901.41600 / 自带后台 0.153.4

本机应用实际路径为 `/Applications/ChatGPT.app`，bundle ID 为 `com.openai.codex`；没有发现独立 `/Applications/Codex.app`。只读执行其后台 `--version` 得到 `codex-cli 0.153.4`，与全局 CLI 0.163.0 不同，不能套用一个版本的全部行为。

从当前包内代码复读到：

- recent threads 的 `thread/list` 使用 `sourceKinds: BLt`，其初始化值为 `[]`。
- 普通全列表函数同样默认使用这份空集合，搜索请求也传它。
- 主进程 thread catalog 传入 `n.Ni`；其模块内对应值也是 `[]`。
- 近期列表的额外 UI 过滤排除 ephemeral 和 `ambient_suggestions`，不能把它误认成 Rambo 标签过滤。

匹配桌面后台的 **rust-v0.153.4** 源码对 `sourceKinds: []` 使用 `INTERACTIVE_SESSION_SOURCES`；集合包括 Cli、VSCode、Custom(atlas)、Custom(chatgpt)，不包括 Mcp/AppServer。[filters.rs:6–18](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/filters.rs#L6)、[rollout/lib.rs](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/rollout/src/lib.rs)

因此，在已核对的默认列表静态路径中，AppServer 来源不属于默认交互集合。这是比此前仅猜测桌面端行为更直接的证据，仍不能代替真实启动、数据库兼容与重连检查。

## 4. 独立发行物确实有公开条目

上游 rust-v0.163.0 公开 release 的资产列表存在：

- `codex-app-server-aarch64-apple-darwin.tar.gz`
- `codex-app-server-package-aarch64-apple-darwin.tar.gz`

来源：[公开资产列表](https://github.com/openai/codex/releases/expanded_assets/rust-v0.163.0)，本地摘录：[JSON](evidence/codex-0.163.0-standalone-release-assets.json)。GitHub API 元数据请求遇到限流，改读公开网页列表。随后完整下载上面第二个 package 并只读遍历 tar 成员；首次下载超时后续传完成，没有执行归档内程序。

该 package 的 manifest 指定 `variant: codex-app-server`、`entrypoint: bin/codex-app-server`，版本 0.163.0，目标为 aarch64-apple-darwin。实际有 4 个普通文件：独立 App Server、Code Mode Host、rg 及 manifest；压缩包约 **97.26 MiB**，逻辑文件大小合计约 **249.15 MiB**。观察到的归档 SHA-256 为 `c64323d8d51933c3fe50489e841f3a9ebbce971d9e06dc3d734ac2f3c7ddb2cf`。[完整清单](evidence/codex-app-server-0.163.0-darwin-arm64-inventory.json)

此独立 package **没有 Voice Host 配套**；manifest 虽命名 resourcesDir，也不能把该名称当作语音资源实际存在。此前 CLI 平台包的 325 MiB 包含 Voice 配套，两个包必须区分。Voice 的 WebRTC 路径由 Rambo 客户端处理媒体，没有在已查调用链看到启动 Voice Host，因此缺少它不直接证明 Voice 不可用；是否还需补其他运行资源依然要验证。Computer Use 服务不在这 4 个文件中。

以上只核对了完整归档成员与观察摘要，没有做上游签名证明或执行兼容测试，不能据此直接宣布最终安装包可用。

## 5. Rambo 仍必须自己管理归属

`appServer` 来源不专属于 Rambo，其他应用也可能使用它。因此：

- 只从自己保存的 bot/chat/run → thread ID 映射构建主列表。
- 不把 `sourceKinds:["appServer"]` 返回的所有线程据为己有。
- 路由、Routine、委派子任务分别登记所有权及父子关系。
- 恢复原生旧线程会保留其原来源，不能偷偷拿用户的原生会话当 Bot 新会话。
- 备份、归档和删除仅处理自身映射拥有的对象；完整会话备份仍按原调查继续解决。

该方案实现的是默认历史展示分离，不是认证、目录或文件保密隔离。原生客户端未来更新默认来源过滤后可能改变行为，须按兼容版本验证。

## 6. 下一阶段必须证明什么

1. 已完成 package 归档布局核对；下一步仍须验证实际程序的来源参数、全部运行依赖及签名/分发条件，不覆盖本机 CLI。
2. 在受控环境核对新 thread 实际返回和持久化的来源是预期的 appServer，而不是只看启动参数。
3. 同时核对原生 CLI 0.163.0 与桌面后台 0.153.4 的默认列表、重启和历史索引行为；显式显示非交互记录不作为失败。
4. 验证共享配置/认证、模型与 MCP/Skills 发现，避免来源调整使资源消失。
5. 验证归档/恢复、Routine、群聊与子任务不会重新产生 VSCode 根线程；不同版本共享数据的兼容性需要单独证明。
6. 在此运行时上完成 Voice 的 WebRTC/挂断验证及 Computer Use 连接，不用来源筛选成功代替其他能力验收。

本轮没有运行这些验证。推荐方向已从“先定制源码或换数据目录”收敛为“先使用上游独立入口及现成参数”；A03/A04 产品目标不变，实际通过状态仍未执行。

## 7. 桌面产物证据与限制

ASAR：`/Applications/ChatGPT.app/Contents/Resources/app.asar`，SHA-256 `077cc65356aeae34c5d8b4de0b4cc383f6fb137ed1d69a9b3dfe69ffafa058ab`。

具体文件、偏移、摘要与小段原文已保存在 [桌面历史摘录](evidence/desktop-history-excerpts.json)，未复制任何用户会话。三个读取的 JS 文件 hash 与各自 ASAR 完整性声明一致。

REA 对两份选定源的分析受到 heap/time 限制，未形成完整语义图；保留的部分 Evidence 为 `ev_1fc636a5bb2973ba4510dfff677694fc740b62311c4618a26f437cce91e644c0`，摘要见 [JSON](evidence/desktop-history-rea-partial.json)。另有 7 个原生成员完整性不一致，按 observed-untrusted 保留，不用于本文 JS 默认列表结论。主 Agent 直接按 ASAR 偏移复读了上述代码并单独核对哈希；未运行 bundle，也未记录真实 UI 网络请求。

## 8. 2026-10-26 本机同一二进制的新候选：独立数据目录、共享认证文件

状态：针对 [Q146](decision-followups.md#q146) 的技术建议，尚未由用户确认替换 A03/A04 的实现机制，未接入 Rambo 正常启动逻辑。

- 直接启动本机 daemon package 的 `bin/codex app-server --listen stdio://`，由 Rambo 管理独立进程；不下载另一份服务端。
- 为 Rambo 使用独立 `CODEX_HOME`，会话 JSONL、索引和状态数据库均留在该目录；不只设置 `sqlite_home`，避免共享 sessions 目录仍被原生客户端扫描。
- 当前机器存在本机 `auth.json`。候选是在独立 home 中以符号链接引用同一文件，并仅对子进程覆盖 `cli_auth_credentials_store="file"`；不复制认证内容。不能将该办法宣称为 Keychain 通用方案，未来本机认证模式变化必须重新检查。
- 配置、Skills、MCP、Plugins 等需要按资源复用规则分别接入；本轮只探测了配置文件链接和账号读取，没有证明全部资源发现及配置写入行为。
- 本轮已实际用本机 `~/.codex/packages/app-server-daemon/releases/0.164.0-aarch64-apple-darwin/bin/codex` 在临时 home 中启动独立 stdio 子进程，`initialize` 成功，`account/read`（`refreshToken:false`）返回现有 `chatgpt` 账号。没有输出凭据，没有创建 thread、调用模型、刷新令牌或修改日常登录；随后停止探测子进程并清理临时目录。
- 后续需要证明：双客户端会话列表互不混入、重启恢复、令牌刷新与登录变化下仍共用认证、配置与资源可用，以及既有 Rambo thread 的归属迁移。迁移只处理 Rambo 已记录拥有的 thread，先备份并验证恢复，不迁移全部原生历史。
- 此候选需要将 A03 的“同一 CODEX_HOME”改为“共享认证与所需配置资源、会话独立目录”，将 A04 的“专属来源”改为“独立会话存储”。产品目标保持同一二进制、独立进程、共用登录态、常规历史隔离；当前探测只证明启动与账号读取，不能报完整方案已验收。

依据：[0.164.0 文件认证读写](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/login/src/auth/storage.rs)、[SQLite 目录配置](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/config/src/config_toml.rs)、[会话目录与默认来源](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/rollout/src/lib.rs)。

## 9. Q147 实现与定向证据

2026-10-26 用户已接受独立目录方案。当前实现优先启动本机 daemon package 的同一份 `bin/codex app-server`，每次重启重新解析安装版本；不再因普通入口缺少来源参数而跳过它。缺少本机入口时保留原有缓存与校验下载回退。

`runtime-home.ts` 准备独立会话目录和共享资源链接；启动参数覆盖 SQLite home，避免本机配置把状态库写回共享目录。旧 thread 的归属清单包含 Store 中归档聊天；复制保留源文件，不覆盖更新历史。按 thread ID 记录迁移结果，避免原文件后来压缩或移到归档目录时，重新导入已删除的副本。

定向证据及边界：

- `tests/backend/runtime.test.mjs` 与 `runtime-home.test.mjs`：12 项通过，覆盖本机普通入口优先、独立 home/SQLite 参数、共享文件双向可见、路径冲突和 Keychain 拒绝、所有权迁移、不覆盖、不复活、重启选择本机新版本。
- `tests/backend/store.test.mjs`：40 项通过，包含归档聊天仍进入归属清单。
- `node tests/manual/native-runtime.mjs` 使用真实本机 0.164.0 二进制和临时 API 认证夹具，不调用模型：已验证旧 thread 复制后恢复、新隔离 thread 在原生目录不可读、独立目录可读，以及进程重启后恢复。证据位于 `acceptance-runs/native-runtime-check/evidence/live-runtime.json`。空 thread 的默认列表会省略它，因此本次以跨目录 `thread/read` 拒绝证明存储隔离，不冒充已完成带模型消息的双端历史 UI 验收。
- `tests/e2e/runtime-startup.spec.mjs` 在独立产品 profile 上使用真实本机二进制及日常共享认证，真实 Electron 设置页已显示已连接与 ChatGPT 登录方式，运行时按钮重启后仍连接；检查了子进程实际路径与 PID 更换。最终复跑 1 项通过，没有创建 Bot 或调用模型。
- 账号对比探测在原生 home 和独立 home 均读到现有 ChatGPT 账号。较早探测曾出现 workspace routing 超时，后续对比及专项 Electron 成功；不能宣称已验证所有网络失败恢复。
- 扩大 Electron 回归结果为 14 通过、3 失败、15 未运行。失败分别指向头像 idle 状态、群聊测试仍调用已移除的 updateChat、定时任务预期文案；未修改这些测试标准，也未将该轮记为完整回归通过。

类型检查、构建、目录校验和验收结构测试已执行。当前为定向实现与局部证据，不代表 Live、Computer Use、资源授权、未登录真实 OAuth、令牌自动刷新、双端带模型消息列表或打包发布全量验收通过。日常旧实例检测到执行中 turn/Routine，未强制退出切换；正常退出重开后才使用新启动逻辑。
