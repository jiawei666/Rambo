# Codex 历史归属与自有会话备份调查

日期：2026-10-20。范围：A03、A04、O03 的静态核对。未启动 App Server、会话、推理或测试，未读取用户真实聊天正文、认证内容，未改配置。本文是技术调查，不能替代产品决定或运行验收。

同日第二轮更新：已找到上游独立 `codex-app-server` 的 `--session-source` 参数及公开 release 条目，并核对本机桌面默认来源过滤。当前优先方案见 [历史隔离方案收敛](history-isolation-plan.md)；下文关于现成 `codex app-server` 子命令的反证仍成立，但“不存在任何来源选择入口”的泛化不能成立。

## 1. 结论

**“同一个 CODEX_HOME，给 threadSource 填 Rambo，就能让原生客户端默认看不到”目前不能成立。** 不仅缺运行证明，匹配版本的官方公开源码已显示相反的来源路径：普通 `codex app-server` 启动的新线程沿用 `SessionSource::VSCode`；原生 CLI 默认恢复列表包含 `cli` 与 `vscode`。线程还可能受工作目录、归档、provider 等条件过滤，不能据此说每条一定出现在每个页面，但不能保证 A04 要求的默认不混入。

Rambo 自己维护 thread ID 映射，可以保证自己的列表只展示自己的聊天；这无法改变原生 CLI/桌面端的列表。**A04 仍是实施阻塞，不能勾选通过。** 桌面端默认列表实际请求本轮未核实。

## 2. 证据版本与方法

- 本机协议：`/tmp/rambo-design-codex-0163-schema`，由本机 `codex-cli 0.163.0` 生成；摘要见 [App Server 协议核对](app-server-evidence.md)。本轮另外只执行 `codex app-server --help`，未拉起服务。
- 线上资料：[App Server 官方文档](https://learn.chatgpt.com/docs/app-server)，2026-10-20 抓取。线上会更新，不能直接反推旧二进制全部行为。
- 源码：OpenAI 官方仓库的明确版本 **`rust-v0.163.0`**，非 `main`。本轮以该标签的 raw 文件核对；没有把标签源码等同于本机发行物逐字节构建证明。本文结论仍须针对最终包内二进制验证。
- 临时资料：`/tmp/rambo-history-source/`，只有公开资料；未复制用户历史或凭据。

## 3. 四种容易混淆的身份

| 字段/概念 | 实际作用 | 能否单独隔离历史 |
| --- | --- | --- |
| `SessionSource` / 返回线程的 `source` | CLI、VSCode、Exec、Mcp 等运行来源；`sourceKinds` 按这层筛选 | 影响来源过滤；CLI 子命令固定来源，独立 App Server 入口可指定，见后续方案 |
| `threadSource` | 客户端提供的分析来源分类，另一套 `ThreadSource` 类型 | 不能替代 `SessionSource`；列表没有相应专属过滤参数 |
| `initialize.clientInfo.name` | 识别客户端，参与 originator、User-Agent、分析/合规归属 | 不是独立历史目录或访问控制 |
| `thread/start.serviceName` | 线程级 metrics service 标记 | 不是存储隔离；也不能当任意客户端来源过滤器 |

本机 `ThreadStartParams.json` 明确将 `threadSource` 描述为分析分类。官方类型中 `ThreadSource` 包括 User、Subagent、Feature 等；`SessionSource` 则是另一枚举，见 [protocol.rs:2948–3030](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/protocol/src/protocol.rs#L2948)。普通自定义字符串进入 `Feature`，不会把线程改成 `SessionSource::Custom`。

官方文档将 `clientInfo.name` 用于客户端识别，将 `serviceName` 用于线程指标；源码初始化将 `name` 设为 originator 并构造 User-Agent 后缀，没有修改 SessionSource，见 [initialize_processor.rs:93–195](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/request_processors/initialize_processor.rs#L93)。

还要注意一个有限例外：`serviceName` 若命中特定第一方名称白名单，会参与 originator 的优先选择；这不是任意服务名改变来源的接口，更不应伪装第一方名称。见 [thread_manager.rs:373–401](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/thread_manager.rs#L373)。

## 4. 默认来源的完整静态调用链

1. `codex app-server` 分支调用 `run_main_with_transport_options`，传入 `SessionSource::VSCode`，见 [CLI main.rs:1281–1291](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/cli/src/main.rs#L1281)。另一个库级 `run_main` 的默认值也相同，[app-server lib.rs:438–455](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/lib.rs#L438)。
2. MessageProcessor 用该值创建 ThreadManager，见 [message_processor.rs:337–343](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/message_processor.rs#L337)。
3. 普通 `thread/start` 以 `StartThreadOptions::new(config)` 开始，设置的是 `thread_source` 与 `metrics_service_name`，没有设置 `session_source`，见 [thread_processor.rs:1484–1529](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/request_processors/thread_processor.rs#L1484)。默认 options 的 `session_source` 为 None，[thread_manager.rs:309–322](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/thread_manager.rs#L309)。
4. 新线程无已存历史时从 ThreadManager 的来源取默认；`thread_source` 单独赋值，见 [thread_manager.rs:1172–1182](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/thread_manager.rs#L1172)。因此普通新线程沿用 VSCode，初始化客户端名不覆盖这条链。
5. 原生 CLI 的默认来源列表明确为 `Cli`、`VsCode`；额外选项才加入 Exec/AppServer，见 [tui lib.rs:778–787](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/lib.rs#L778)。恢复选择器把这份集合传给 `thread/list`，见 [resume_picker.rs:2106–2120](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/resume_picker.rs#L2106)。

`ThreadSourceKind::AppServer` 的命名尤其容易误解：源码实际把它匹配到 `SessionSource::Mcp`，不是“凡由 app-server 子命令创建”。见 [filters.rs:6–62](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/filters.rs#L6)。所以不能只给 Rambo 列表填 `sourceKinds:["appServer"]` 就期待筛到普通启动路径创建的全部线程。

## 5. 本地不能使用 originators 解决

本机 schema 对 `ThreadListParams.originators` 写明：只支持 hosted backend，本地非空列表被拒绝。匹配源码也直接返回参数错误，见 [thread_processor.rs:2652–2659](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/request_processors/thread_processor.rs#L2652)。

即使以后本地支持 originator 筛选，也只会改变主动使用该过滤器的客户端请求；不能自动修改原生客户端默认列表。Rambo 的 botId/chatId/threadId 映射仍是产品列表归属的可靠依据。

## 6. 共享存储及候选方案边界

### 6.1 同 CODEX_HOME 的边界

默认线程持久化是 rollout JSONL 加 SQLite 元数据，见 [config/mod.rs:610–619](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/config/mod.rs#L610)。新 rollout 路径直接以 `config.codex_home()` 加 sessions 和日期构建，见 [recorder.rs:1739–1759](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/rollout/src/recorder.rs#L1739)。因此独立进程、不同 UI、不同工作目录、不同分析标签均不等于独立历史存储。

`sqlite_home` 是可覆盖项，也可从相关环境值解析，见 [config/mod.rs:271–280](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/config/mod.rs#L271) 和 [4210–4223](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/config/mod.rs#L4210)。**只覆盖 sqlite_home 不够**：rollout 仍写共享 CODEX_HOME，列表还存在扫描并修复 JSONL 元数据的路径。不能把独立 SQLite 当完整的来源/存储隔离方案。

### 6.2 推荐验证顺序，而非新产品决定

1. 当前优先核对上游独立 `codex-app-server --session-source app-server`；该入口确实存在，和现成 CLI 子命令不同。公开 release 也有独立 package 条目，见 [后续方案](history-isolation-plan.md)。不需要先假设必须修改源码。
2. 保留同 CODEX_HOME 的认证/配置语义，验证独立来源在真实双客户端默认列表、恢复、资源发现和升级中的效果。运行未通过前，A04 不视为完成。
3. 只有独立入口仍不能满足目标时，再比较运行时适配或存储/认证分离；后者会修订 A03 的字面实现，不能悄悄替换，也不能复制一次 auth.json 了事。

### 6.3 独立 CODEX_HOME 不会天然继承凭据

官方文件认证路径固定为 home 下 auth.json，见 [auth/storage.rs:162–164](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/login/src/auth/storage.rs#L162)。直接 keyring 存储的 key 由 canonical CODEX_HOME 路径哈希生成，见 [245–257](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/login/src/auth/storage.rs#L245)；加密认证还使用本地 secrets 管理器，[366–377](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/login/src/auth/storage.rs#L366)。换 home 不能保证命中原凭据。

本轮未找到并证明可同时指定任意独立 auth 文件根、独立线程根、共享配置文件的完整公开接口组合。对 auth.json/config.toml 建软链接也不是已证方案：认证写入/刷新和 keyring 后端可能不沿同一行为，不能现在把软链接当产品承诺。没有创建任何链接。

本机 `LoginAccountParams.json` 中 `chatgptAuthTokens` 明确标为 OpenAI 内部专用且不稳定，不能把该字段当公开第三方凭据桥接方案。普通 Codex OAuth 登录仍是受支持的产品认证方向；是否可以在独立存储下完全免重新登录，尚未解决。

## 7. 只备份本应用线程：可用接口与缺口

| 接口/材料 | 已证实 | 不能推出的结论 |
| --- | --- | --- |
| `thread/read`、`thread/turns/list`、`thread/items/list` | 可读取模型协议转换后的线程历史，适合产品展示/索引 | 不证明这些响应就是可完整导入的执行状态 |
| `thread/resume(threadId)` | 从已有持久化线程继续 | 不是跨目录/丢盘后的导入接口 |
| `thread/resume.path` | 本机 schema 有指定 rollout 路径字段 | 明确不稳定；对运行中线程还须匹配原路径，不是稳定通用备份 API |
| `thread/resume.history` | 可传 ResponseItem 数组 | 本机明写 Codex Cloud 专用且不要使用；不得据此承诺普通产品导入 |
| `thread/fork` | 从现有历史复制为新 thread；path 也属不稳定字段 | 不是独立归档格式；不能恢复原有映射和全部宿主状态 |
| 自有 rollout 文件快照 | 源码明确有可定位的线程日志和读取路径 | 还须确认刷新完成、压缩文件、SQLite 中线程元数据/关系及版本兼容性；未验证还原后可继续模型会话 |

上述本机依据：临时 schema 的 `v2/ThreadResumeParams.json`、`v2/ThreadForkParams.json`、`v2/ThreadReadParams.json`。官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server) 也区分读取、恢复、分叉；没有在本轮找到面向本应用线程的稳定成对完整 export/import API。`project/import` 或其他外部代理迁移方法不能仅凭名称当作本地线程完整备份协议。

建议设计自有备份 manifest：仅列 Rambo 映射拥有的 thread 和必要关联资源，冻结空闲状态后收集经过核实的原始执行持久化材料，再加产品数据库与 blob 清单。源文件应从受信任返回路径取得，校验线程归属；不扫描、打包整个 CODEX_HOME。不要直接修改共享 SQLite 记录做恢复。

这是待验证的备份路径。需分别验证 legacy/paginated 历史、归档线程、动态工具恢复、附件引用、父子关系、同 ID 已存在时的冲突、版本升级，以及源文件删除后导入是否还能继续会话。未完成这些核对前，O03 完整会话恢复仍有缺口，UI 消息副本不能充当已通过的模型会话备份。

## 8. 后续运行验收清单

当前仅列验证设计，**均未执行**：

1. 在隔离临时测试环境、固定包内版本创建一条 Rambo 线程；核对返回及持久化的 source、threadSource、originator，不能靠标签名称推断。
2. 用同版本原生 CLI 默认 picker 和真实桌面端默认历史检查是否混入；记录完整过滤请求和 cwd/provider/归档条件。不得读取或展示现有私人聊天来做证明。
3. 验证自己的 ID 列表、恢复、归档、删除都不误操作其他客户端线程。
4. 对自有测试线程做完整备份，移走源材料后恢复并继续上下文，检查其他客户端历史不被导出/覆盖。
5. 若选择修改 SessionSource 或存储/认证分离，单独验证原生登录刷新/退出与 Rambo 的共享语义，再正式修订 A03/A04 技术方案。

本轮只新增本文，没有修改决策、验收状态或技术草案。
