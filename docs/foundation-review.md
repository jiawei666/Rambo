# 初批基础实现只读审查

审查范围：`runtime.ts`、`host.ts`、`store.ts`、`index.ts`、preload/contracts 和 `prepare-runtime.mjs`；对照产品决策及本机 Codex 0.163.0 协议 schema/源码。未读取用户认证、聊天或配置内容；未改源码、未运行测试。

## 发现

1. **高：默认 Bot 会继承 CODEX_HOME 中已启用的 MCP 和 Skills。** [runtime.ts](../src/main/runtime.ts#L30) 继承完整 `process.env`，没有改变 `CODEX_HOME`，这符合 A03 的认证/配置复用；但 [host.ts](../src/main/host.ts#L51) 对新线程和恢复线程都没有传配置覆盖，创建线程只给 `selectedCapabilityRoots: []`。本机 schema `v2/ThreadStartParams.json`、`v2/ThreadResumeParams.json` 都有 `config` map；上游 `request_processors/thread_processor.rs` 将该 map 交给 `load_with_overrides`。`core/config.schema.json` 中 MCP 的 `RawMcpServerConfig.enabled` 和 Skills 的 `bundled.enabled`、`skills.config` 名称/路径规则均可用于覆盖。该实现因此不满足 T02“新 Bot 默认不自动获得额外 MCP、Skills”。`selectedCapabilityRoots` 只控制宿主提供的 capability roots，不能替代 Codex 配置过滤。修复：保留共享 `CODEX_HOME`，按 Bot 保存明确 allowlist；每次 `thread/start` 和 `thread/resume` 都通过 `config` 覆盖禁用未选项：对普通 MCP 用 `mcp_servers.<name>.enabled=false`，对插件 MCP 用 `plugins.<plugin-id>.mcp_servers.<name>.enabled=false`，对 Skills 用 `skills.config` 的 `name`/`path` 规则，默认关闭 bundled skills；仅用户选中的项显式启用。可从协议的 MCP 状态列表和 `skills/list` 取得名称/路径，不必读取原始配置文件。

2. **高：停止 App Server 未等待子进程退出，退出应用或重启时可能留下旧进程。** [runtime.ts](../src/main/runtime.ts#L89) 在发送 SIGTERM、安排 3 秒 SIGKILL 后立即返回；强制退出计时器还调用了 `unref()`。因此 [index.ts](../src/main/index.ts#L129) 的 `before-quit` 会在未确认子进程退出前关闭 Store 并调用 `app.quit()`；`restartRuntime` 也会马上启动第二个进程。SIGTERM 若需要清理时间或未终止，旧 App Server 会在新进程启动后继续运行；父进程退出时 unref 计时器也不能保证补发 SIGKILL。修复：`stop()` 等待 `exit`，限时后发送 SIGKILL 并继续等待退出；只有退出确认后才标记 stopped、关闭 Store 或启动新进程。

3. **中：RPC 超时只放弃本地等待，未取消或追踪服务端仍在处理的请求。** [runtime.ts](../src/main/runtime.ts#L80) 的定时器只删除 pending ID 并 reject；stdio 子进程保持 ready，晚到的响应会被忽略。[host.ts](../src/main/host.ts#L52) 在 `thread/start` 响应成功前不会保存 thread ID，也要到线程创建/恢复后才写入用户消息（第 61 行）。若 `thread/start` 超过 60 秒后仍在服务端完成，Rambo 会丢失其 thread ID，后续重发会创建另一线程；`turn/start` 超时也可能在 UI 报“发送未确认”后继续执行。修复：将超时表示为“结果未知”，保留 late-response/notification 的关联信息并做状态核对；在确认或恢复 thread/turn 状态前，禁止同一聊天自动重试。若协议不支持通用取消，不要把本地 timeout 当作服务端取消。

4. **低：单条消息及聊天元数据不是一个 SQLite 事务。** [store.ts](../src/main/store.ts#L85) 先独立插入消息，再分别更新 `chats.updatedAt` 和首次标题。若后续 SQL 因 SQLite I/O/空间错误失败，消息行已提交，但调用方会收到异常，聊天排序/标题未更新；`Host.send` 也尚未发布这条消息或启动回合，重试可能再次插入。修复：将这几条写入包进同一个事务，并在失败时回滚。相较之下，`createBot` 已正确将 Bot 和初始 Chat 放在同一事务中。

## 核对结果

- `prepare-runtime.mjs` 的目标目录 `runtime/codex/0.163.0`、`bin/codex-app-server`、`codex-path` 与本机固定 release archive 布局相符；`electron-builder.extraResources` 和运行时资源根路径也相符。
- `--session-source app-server` 与上游 0.163.0 支持的 App Server 启动参数一致，符合 A04 的普通历史列表隔离目标。共享 `CODEX_HOME` 仍表示文件层不隔离，和产品决策记录一致。
- Store 的外键、WAL、消息字段及 `user_version=1` 与当前首版表定义一致；IPC 主进程检查 sender/frame，输入校验和更新字段白名单基本齐全。本轮未发现更具体的可复现 IPC 越权或当前 schema 错列问题。

## 后续修复记录（2026-10-20）

- 在 `src/main/host.ts` 移除了 `mcpServerStatus/list` 分页发现及跨 workspace 的 MCP 配置缓存。每次新建/恢复线程时，改为调用 `config/read`，参数为 `{ cwd: Bot workspace, includeLayers: false }`；仅从 `response.config.mcp_servers` 取键名，并生成逐服务 `{ enabled: false }` 覆盖，同时禁用 `features.apps` 与 `features.plugins`。`skills/list` 的 workspace 路径规则和错误处理保留，已知 skills 仍逐项禁用。
- 字段依据：0.163 的 `ConfigReadResponse.config` schema 声明 `additionalProperties: true`；上游 Rust `Config` 将附加配置 flatten 到响应对象顶层，因此 `mcp_servers` 位于 `config.mcp_servers`。协议源码确认 `config/read.cwd` 解析适用项目配置层，`includeLayers: false` 不返回分层明细。源配置响应只在方法内短暂使用，不记录、不持久化、不传给 renderer；传入线程的仅是禁用覆盖和已有 skills 路径规则。
- 未读取本机 App Server 返回的用户配置内容；本次未运行测试或构建。
