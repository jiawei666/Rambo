# 独立运行可行性：本轮结论与下一步

日期：2026-10-20。范围：技术设计后的只读核对，已补充第二轮独立入口及桌面过滤调查。未编写应用代码、启动 App Server 会话/模型调用、录音或操作桌面，未执行功能测试。

## 1. 摘要

| 目标 | 静态调查结果 | 实施结论 | 产品状态 |
| --- | --- | --- | --- |
| 自带 App Server | CLI 平台包有 Voice 配套；上游独立 App Server package 已核对 4 个文件，含 Code Mode Host/rg，不含 Voice Host | 保留发行物相对布局，不能只复制 npm JS 启动器 | 可设计，未打包验收 |
| 复用 Codex 登录接 Voice | WebRTC 创建路径复用当前 ChatGPT 认证；直接 WebSocket 音频路径仍有独立 API Key 限制 | 优先显式 WebRTC + V3/audio，通过 App Server 管理认证与侧带 | 源码路径成立，账号及通话未验证 |
| 自然语言主动挂断 | Live 可委派普通 Codex 回合；普通回合可调用宿主动态工具；stop 不替客户端关媒体 | 用委派接挂断工具，Rambo 实际释放麦克风、播放与连接 | 需适配并运行验证，不回退关键词判断 |
| 电脑控制 | 存在独立 Computer Use 服务/原生客户端；统一 REPL 有专用宿主和安装路径依赖 | 先核可使用的连接契约和组件来源；仅 App Server 不等于已拥有完整 Computer Use | 独立连接/分发仍阻塞 |
| 原生默认历史不混入 | 0.164.0 普通 CLI 子命令固定 VSCode；独立 codex-app-server 支持来源参数；当前 CLI/桌面默认集合排除 AppServer 来源 | 可复用本机 CLI 二进制并启动独立子进程，但仅当该入口可设置专属来源；当前 0.164.0 不兼容，暂用独立入口 | 静态候选已收敛，实际执行仍未通过 |
| 自有会话完整备份 | 有读取/恢复，但未找到稳定通用的成对完整导出导入 API；部分 history/path 字段不宜当公开稳定接口 | 备份必须包含可继续模型上下文的材料，而非只有 UI 文本 | O03 完整恢复仍待设计及验证 |

第二轮收敛见 [历史隔离方案](history-isolation-plan.md)，已找到上游独立发行物条目，不再以“先修改源码或换数据目录”为首选。

证据详见 [Voice](voice-feasibility.md)、[历史与备份](history-isolation-research.md)、[Computer Use](computer-use-dependencies.md)、[本机协议与发行物](app-server-evidence.md)。

## 2. 现在可以具体化的 Voice 接入

1. Rambo 的本机控制链路仍为 stdio JSON-RPC。
2. Rambo 的媒体客户端创建 WebRTC SDP offer，明确向 `thread/realtime/start` 指定 webrtc、V3 和 audio。
3. App Server 创建上游 call，处理 Codex 当前认证及侧带连接；Rambo 取回 SDP answer 管理媒体。
4. 需要宿主功能时由 Live 委派普通 Codex 回合，该回合调用本应用工具。
5. 挂断工具绑定当前通话归属：Rambo 释放本机媒体，App Server 结束 realtime，按已保存开关回到唤醒。

这是经过源码收窄后的候选实现路径，不是实际请求日志。尤其还需验证服务端是否接受当前用户和客户端、SDP/侧带竞态、委派和动态工具衔接。不能据此声称所有已定 Voice 功能都已可用。

## 3. 历史隔离的技术修订候选

### 当前优先：上游独立入口的来源参数

上游独立 `codex-app-server` 已有 `--session-source app-server`，公开 release 也有 macOS arm64 独立 package，归档清单已核对，程序未执行。该参数映射为 AppServer 来源且保留 Product::Codex；当前本机桌面默认请求/后台版本也已补核。推荐先使用这个上游入口，不先定制核心或修改数据目录。具体来源与证据边界见 [后续方案](history-isolation-plan.md)。

下面保留初轮候选，现为备用研究分支，未实施。

### 备用候选 A：为随包运行时适配来源

上游库接收 `SessionSource` 参数，而现成 CLI 的 `app-server` 入口固定传 VSCode。因此可研究在自带运行时的入口层传入本产品适当的独立来源，仍用原认证与配置目录。

例如源码枚举已有 `SessionSource::Custom(String)`；这与 RPC 的 `threadSource` 完全不同。能否把它用于本产品，必须继续核对所有持久化、子任务来源、恢复、模型路由、原生桌面列表和升级路径。不能把修改一处默认值等同于完成 A04；这也不是本轮已经构建过的运行时。

优点是有机会保持 A03 的同目录认证/配置语义。代价是维护自带运行时适配，且对原生桌面列表是否有效尚无证明。不能伪装第一方客户端名或绕过认证证明。

### 候选 B：存储独立，认证与配置明确共享

研究独立线程持久化目录与正式的共享认证/配置路径。此路径能从存储层区分历史，但会修订 A03 的字面实现；当前没有已经证明的完整接口组合。

不能只换 `sqlite_home`：rollout 仍共用原 home；不能把换 CODEX_HOME 当成自动共享 keyring；也不能复制一次 auth.json 就忽略刷新/退出。软链接、内部 token 模式都不是已证的公开解决方案。

### 下一项应优先完成的只读工作

独立 package 布局已只读核对；接下来明确其真实启动、新建/恢复、资源发现及跨版本默认列表的运行验证步骤。若独立入口不能满足目标，再回到两条备用候选。保留“复用认证配置、原生默认历史不混入”的目标；只有需要改变用户体验或既定数据约定时才提新的产品问题。

## 4. 运行资源与包体积边界

本机 macOS arm64 0.163.0 平台目录有 41 个文件，逻辑大小合计约 325.0 MiB：主程序约 238.4 MiB，Code Mode Host 约 62.6 MiB，Voice 主程序约 9.1 MiB。Voice 整套配套约 20.18 MiB，已包含于平台目录，不应重复相加。

另已下载只读核对独立 App Server package：压缩归档 97.26 MiB、4 个文件合计 249.15 MiB，含 App Server、Code Mode Host、rg、manifest，没有 Voice Host。此为当前优先接入的发行物，与上述 CLI 包区分，见 [独立包证据](evidence/codex-app-server-0.163.0-darwin-arm64-inventory.json)。

最终应用还包括桌面壳、Rambo 自身文件及可能需要的外部组件；最终压缩安装包大小尚未知。Computer Use 独立服务和专用运行时不包含在上述 325.0 MiB 里，不能用这一数字承诺最终安装体积。

## 5. 状态纪律

- 本轮调查没有增加产品功能；已确认规则及验收编号仍为 111 条。
- 技术路径的反证要修订实现方案，不静默删除相应产品要求。
- 仍不引入额外语音 API Key 作为默认前提，不替换用户选择的 Codex Voice/Computer Use。
- 不做用户已拒绝的口头切 Bot、消息编辑/重生成/分支切换，不重问 Codex 本身负责的语音插话规则。
- 表内“路径成立”仅指静态实现证据，全部实际功能验收仍未执行。
