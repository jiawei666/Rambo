# 实施进度

## 2026-10-27 · Electron 用例窗口隔离

- 用户截图中的三个输入框和重复侧栏不是单页面 DOM 错排，而是多个 Electron 验收窗口以小幅偏移叠在同一位置；截图尺寸正好是单个 `1100×760` 窗口的 2x 捕获。生产页面仍只有一个聊天输入框，选中的 Bot 为 Routine Smoke。
- Playwright 配置现在在测试命令启动时获取跨进程验收锁，第二个并发命令会在创建窗口前明确失败；同一命令内的配置加载和 worker 不重复抢占。夹具同时记录 PID，可回收已退出进程留下的陈旧锁，并在每次 Electron 启动时断言只有一个 `BrowserWindow`。
- 验证通过：验收锁单测 **3/3**、类型检查、目录结构、以及 `private-chat` 确定性串联回归 **7/7**。已用两个并发 Playwright 命令复现第二个命令被锁拒绝且未开窗。
- 证据边界：目录漂移已由 F05/F06/F07 的案例迁移和新增补齐，`npm run test:catalog` 为 **146 条规则、231 个案例、114 个可执行案例**，`npm run test:acceptance` 为 **19/19**。真实模型 Routine 用例本次仍因回合未结束跳过，不能据此判定该规则通过。

## 2026-10-27 · F07 本机附件拖入或选择只插入路径

- 聊天输入框接收 Finder 文件拖入，或通过回形针入口打开本机文件选择器多选文件后，只在当前草稿的光标或选区插入原文件绝对路径；多文件逐行、重复路径去重，不自动发送。
- 该入口不上传、不复制、不读取文件内容，也不创建附件记录；附件、长期资料和副本仍按 F01/F02 的独立上载流程处理。
- 隔离 Electron 已用真实拖放事件和替换的系统文件选择器验证双文件路径、拖入高亮、光标插入、空草稿、去重、取消/失败不改草稿、群聊、禁用态和原文件字节不变；真实 Finder 拖放/文件面板、重启回读与附件目录全量差异仍待完整验收。
- 准备将本批改动构建为 `v0.1.5` 并替换本机 `/Applications/Rambo.app`；未创建 Git 提交、tag 或 GitHub Release。

## 2026-10-26：Gmail IMAP 本地化文件夹兼容修复

- 真实 Gmail 账号登录和 SMTP 验证成功，但 `mail_search` 报 `Command failed`。只读诊断确认账号把系统文件夹显示为 `[Gmail]/所有邮件` 与 `[Gmail]/草稿`，而 Adapter 写死英文 `[Gmail]/All Mail` / `[Gmail]/Drafts`，实际服务器返回 `[NONEXISTENT] Unknown Mailbox`。
- Gmail Adapter 现通过 IMAP `LIST` 的 `\All` / `\Drafts` 特殊用途解析邮箱路径，并仅在服务器未声明特殊用途时回退到英文默认路径；搜索、正文读取、附件下载和草稿保存共用该解析逻辑。
- 验证通过：`npm run typecheck`；Gmail/QQ Adapter、邮件工具和运行时定向后端测试 **12/12**；真实 Electron Gmail 应用专用密码表单与取消流程 **1/1**；`git diff --check`。
- 真实账号只读验证：已用现有加密凭证连接 `imap.gmail.com:993`，自动解析到 `[Gmail]/所有邮件`，成功读取 6,828 封邮件的计数与最近 5 封摘要；未发送邮件、未保存草稿、未修改服务器状态。未提交秘密，也未把邮箱正文写入证据。
- 证据边界：自动用例覆盖文件夹特殊用途选择与英文回退，不连接真实 Google；真实账号联调只证明当前账号的列表与读取路径，尚未逐项验证附件、草稿、回复、发送及撤销应用专用密码后的恢复行为。

## 2026-10-26：微信密钥分轮补抓和品牌图标

- 微信连接向导在一条本机捕获控制通道中管理多轮操作。用户结束一轮后，系统逐库校验 SQLCipher key；若有聊天数据库缺项，UI 显示匹配覆盖与缺项，并给出“继续补抓密钥”。继续时复用同一微信副本、Frida 附加和管理员授权进程；完整覆盖后才结束进程并验证会话/聊天读取。取消仍走显式清理。
- 新增合成协议集成用例：首轮覆盖 contact/session，下一轮覆盖 message/media，校验最终 4 个聊天数据库均有匹配，并断言管理员捕获命令只启动一次。微信图标已替换为 Simple Icons 的 WeChat 矢量标记，使用微信品牌绿底；本地渲染预览确认方形比例和标记居中。
- 验证通过：`npm run typecheck`；`node --test tests/backend/wechat-connector-wizard.test.mjs` **9/9**；`npm run test:acceptance` **16/16**；`npm run test:catalog` 覆盖 **142** 条规则与 **224** 个测试案例；`npm run build`。
- 证据边界：分轮测试使用本机临时 SQLCipher fixture 和模拟 TCP 捕获进程，不执行真实 Frida 注入或系统管理员授权；尚未用真实微信数据库、Electron 连接 UI 完成本机端到端复验。全局变更树中的非微信后端、全套 Electron E2E 和发布验收未在本轮重跑。

## 2026-10-26：Bot 管理全局与本 Bot 资源、凭证并写系统提醒

- 当前 Bot 在唯一私聊可通过 `rambo_resources` 管理全局可选目录、新建 Bot 默认开关和自己的资源开关；本地 Skill 文件夹导入会复制到 Rambo 管理的共享技能库，直连 MCP 支持显式 stdio/http 定义和秘密字段加密存储。两者加入全局目录时已有 Bot 默认关闭，不替其他 Bot 打开。
- `rambo_credentials` 支持 QQ 邮箱授权码与 Gmail 应用专用密码的连接新建、更新和验证；凭证正文使用应用本地 AES-256-GCM 加密写入独立 SQLite，不进入产品主 Store、聊天、系统提醒、快照或工具结果。每次成功资源或凭证写入都会在当前 Bot 唯一私聊追加一条真实持久化的 `role=system` 提醒。
- Skill 导入后会立即失效资源发现缓存并解析 `SKILL.md` frontmatter 的 `name`/`description`；Host 启动 thread 前统一注册 `<profile>/skill-library` 为 Codex extra root，再按全局目录和当前 Bot 开关生成 `skills.config`。
- 定向验证通过：`npm run typecheck`；Host 与资源发现 **98/98**；资源工具、凭证工具、Skill 库、直连 MCP、加密凭证 **17/17**；合并资源域后端回归 **115/115**；验收结构 **16/16**；`npm run build`；真实 Electron 验证系统设置导入后列表立即出现、直连 MCP 表单、秘密不回显、明暗主题和 760px 窄窗口 **1/1**，以及 Bot 私聊 Tool 导入并开启当前 Bot、两条持久化系统提醒和其他 Bot 未启用 **1/1**。
- 证据边界：未让真实 Codex 自主选择并执行导入 Skill 的脚本，未启动真实 MCP Server 完成握手/调用，未用真实 QQ/Gmail 账号验证，也未完成日志/导出全量扫描。主动建议全局变更前的用户同意目前由模型指令约束，尚无宿主确认状态机证据。

## 2026-10-26：Bot 新回复系统通知

- Bot 设置新增“新回复提醒”，默认开启并自动保存。普通私聊仅在 Bot 的 `complete`、`failed`、`interrupted` 终态回复时准备通知，`commentary` 阶段、空内容、群聊、Routine 隐藏执行聊天、归档 Bot/聊天和通知关闭的 Bot 不提醒。
- 当前窗口有焦点且正在查看同一私聊时抑制系统弹窗，查看其他 Bot、设置、任务页或窗口在后台时仍提醒；主进程同时读取 Electron 窗口的真实可见性与焦点，不只依赖渲染层缓存。点击通知会显示窗口并切到对应 Bot。
- 普通提醒等到 turn 终态再判定，避免 `item/completed` 先到、随后 turn 失败时误报完成。失败即使没有最终助手文本也会按同一焦点与逐 Bot 开关提醒；同一 turn 以通知键去重，完成或中断的普通通知要求最后一条非 `commentary` 回复有内容。Routine 隐藏结果回交期间抑制普通回复和失败通知，回交结束后统一按 R09 发出一次 Routine 通知。
- Routine 成功默认只保留应用内结果与历史；仅单条 Routine 开启成功通知后提醒。失败、中断和 `needs_user` 提醒，按 run ID 去重。
- 验证：`node --test tests/backend/recent-message-preview.test.mjs tests/backend/routine-scheduler.test.mjs tests/backend/host.test.mjs` **111/111**，`node --test tests/backend/store.test.mjs tests/backend/store-recent-messages.test.mjs` **42/42**，`npm run build` 通过，目标文件 `git diff --check` 通过。
- 证据边界：以上为规则、Host 生命周期、SQLite 持久化和构建证据。尚未在真实 macOS 上观察系统通知投递、通知点击切 Bot、通知中心分组，以及前台同私聊/其他 Bot/后台三类焦点场景；未完成打包应用验收。群聊目前没有未读模型，本轮系统提醒仅覆盖 Bot 私聊，不能宣称群聊红点与提醒一致。

## 2026-10-26：微信连接手动结束捕获与验证 loading

- 微信密钥捕获钩子就绪后，连接弹窗提供“我已完成操作，开始验证”；点击后通过专用 IPC 请求停止捕获，随后继续 SQLCipher 密钥校验、会话/聊天读取和连接保存。
- 捕获结束、密钥验证与聊天读取期间，原弹窗持续展示阶段和 loading；捕获未就绪时不可提前结束，运行中点弹窗外或按 Escape 不会关闭，显式“取消连接”仍可取消。
- 本轮 `npm run typecheck` 与 `npm run build` 均通过；未运行测试，也未复做真机连接。新按钮、验证进度和误关拦截仍需 Electron/真实微信操作验收。

## 2026-10-26：确认本机 Codex 二进制与独立进程边界

- 用户澄清 A01/Q79 选择的是 Rambo 管理自己的 App Server 子进程，并未禁止复用本机同一 Codex 二进制。已把 A02/A05 和运行时验收定义修正为：普通 `bin/codex` 不是被产品规则禁止的入口，能否使用取决于是否满足 A04 会话来源隔离。
- 本机 app-server-daemon 0.164.0 清单为 `variant: codex`、`entrypoint: bin/codex`；`codex app-server --listen stdio://` 支持独立 stdio 启动，但不接受 `--session-source app-server`。用该二进制、空临时 `CODEX_HOME` 和 Rambo 当前 `initialize` 参数做了真实子进程协议握手，返回 `initialize` 成功并正常停止；没有创建 thread、调用模型或触及日常凭据。对应 `rust-v0.164.0` 源码调用时固定传入 `SessionSource::VSCode`，而 VSCode 属于默认交互来源。因此用这个入口启动自己的进程是可行的，但在当前 A04 下会让 Rambo 线程可能出现在普通 Codex 历史列表。
- 已记录独立 `CODEX_HOME` 作为待研究方向，但它会改变 A03；认证可能使用与 home 路径相关的 Keychain 身份，不能假定只 symlink 配置和认证文件即可安全共享。本轮没有改运行时启动代码，也没有把本机 0.164 二进制复制进 Rambo 缓存。
- 决策依据和边界写入 Q145、A02/A05、技术设计与验收计划。验收 catalog 同步后，`npm run test:catalog` 为 141/141 规则映射，`npm run test:acceptance` 为 16/16，`node --test tests/backend/runtime.test.mjs` 为 7/7，`git diff --check` 通过。尚未将该入口接入真实 Rambo 启动器，也未并行验证 Rambo 与原生 Codex 的历史列表；本轮没有修改 TypeScript 源码，因此未执行构建/类型检查。

## 2026-10-25：微信 Connector、全局资源配置与 Bot 初值复制实现

- 微信 Connector 已接入统一 Connection/Grant：Bot 可按时间范围查询本机聊天消息、搜索内容和列出会话；工具结果保留稳定身份、边界和覆盖诊断。仅向获授权的 Bot 暴露只读聊天查询。
- 2026-10-26 范围调整与代码同步：微信首版只保留会话、聊天消息、搜索及聊天内媒体；朋友圈查询、Worker 接口、Agent Tool、Connector 能力和连接必需数据库校验均已移除。最近一次真实诊断确认会话数据库解密并返回 100 条，但旧流程在 `sns_query_failed` 后中止；底层 SQLite 原因没有保留，本轮不再排查朋友圈。当前代码尚未用真实微信复跑，聊天消息与媒体的本机验证按 [独立微信链路用例](../tests/manual/wechat-live/CASE.md) 执行；本轮类型检查和 Electron 构建通过。
- 微信正文解析覆盖文字、引用、链接、卡片、表情和系统提示等结构。媒体从微信本机缓存读取，在内存解密或转换，通过短期资源句柄交付；不联网补取，也不写入 Rambo 持久媒体缓存。微信密钥向导实现了 4.1.x 环境检查、受管副本重签、Frida 捕获和 SQLCipher 数据库密钥验证，并在成功后使用应用本地 AES-256-GCM 加密保存。
- 系统设置增加 Skills、MCP、Apps、Plugins 全局目录 Tab：可选目录默认展示，发现目录可搜索且默认收起；目录成员变化同步到所有 Bot 的可见范围。创建 Bot 时复制资源开关、模型和权限初值，之后各 Bot 的开关、模型与权限独立保存。Playwright 使用受管的 Chrome Extension MCP 配置；用户点击验证后，Rambo 等待用户选择 Chrome 标签，只做一次只读快照，持久化的只有检查时间。
- 定向验证通过：`npm run typecheck`、`npm run build`；Host、Runtime、Store、资源目录、连接凭证、邮件 Adapter、Playwright 验证器及微信相关后端 **224/224**；`npm run test:catalog`（146 条规则、224 个局部案例映射完整）、`npm run test:acceptance` **16/16**；真实 Electron 全局初值、资源目录、应用市场和重启回读流程 **5/5**。模型 readiness 回归确认全局初值错误不阻止已有 Bot，但 Bot 自身模型/权限无效时会阻止该 Bot 开始新轮次；授权 Bot 新创建的私聊、群聊成员和 Routine 执行线程都会注册微信工具，未授权 Bot 不注册。
- 证据边界：后端微信数据库使用合成 SQLCipher/WAL；没有对本机微信 4.1.15 执行密钥捕获或读取真实数据库，也没有完成动态 Agent Tool 真机调用。当前 Codex App Server 的 `ThreadResumeParams` 没有 `dynamicTools` 字段，因此已有 thread 不能通过 resume 更新工具目录；Host 每次调用仍校验实时 Grant，但授予或撤销后，旧 thread 的模型可见工具表不会自动更新。Chrome 扩展已在本机检查为已安装并启用，但没有通过真实 MCP 进程执行标签授权和快照；验证器以假 MCP 协议、Electron 业务界面用例通过。完整发布验收尚未执行。

## 2026-10-25：R17 多时刻计划与 O04 重启恢复闭环

- R17：一条每日 Routine 持久化多个有序、去重的 `HH:mm`，创建、更新、调度和列表展示保持同一份计划；每个计划时刻单独抢占 occurrence 并生成运行记录，旧 interval/未知周期 fail-closed。已确认“每 30 分钟”由离散时刻表达或拒绝，不创建多条任务。
- O04：普通 turn 重启后核对并中断，已排队消息持久化后继续派发，派发结果不明的消息停放；Routine 仅在可确认安全时自动恢复一次。不确定的 Routine 运行进入 `needs_user` 并暂停计划。任务页“已检查，恢复计划”会将旧记录保留为 `interrupted`、保存不确定原因，再恢复后续计划；Bot 不能绕过用户处理。
- 定向验证通过：`npm run typecheck`；Host、Scheduler、Store 三个后端测试文件 **141/141**；`npm run test:catalog`（146 条规则、223 个案例、映射完整）；`npm run test:acceptance` **16/16**；`npm run build`；R17 真实 Electron 关窗多时刻用例 **1/1**；`git diff --check`。
- O04 后端恢复证据使用 Host/SQLite 重建和 FakeRuntime；尚未在真实 App Server/macOS 上强制终止进程，也未核对连接器外部副作用回执。新“已检查，恢复计划”按钮尚无独立 Electron 点击验收；R17 的真实 macOS 睡眠/唤醒对账仍未覆盖。完整发布验收未执行。
- 同步了 R17/O04 的验收矩阵、计划、目录和研究结论；修正了因当前测试重命名而失配的 B06/S02/T19 目录映射，并单列 R17 系统唤醒缺口。未提交 Git。

## 2026-10-25：文档与验收定义同步最新 Bot 配置、资源目录和微信边界

- 以 Q113/Q114/Q118 为现行规则，统一说明：模型、权限以及 Skills/MCP/Apps/Plugins 开关在新 Bot 创建时从全局初值复制，之后完全独立；唯一私聊、该 Bot 的群聊成员执行和 Routine 都使用 Bot 自身值。四类本机资源的全局可选目录成员继续实时同步为各 Bot 的可见范围；账号型 Connector 仍由独立 Connection/Grant 控制。
- 以 Q112/Q119/Q140 为现行规则，统一说明：微信只由已授权 Bot 按需查询本机既有记录，Rambo 不维护读取游标；Routine 首版只有定时触发，没有 Webhook、被动事件、Trigger Source、事件补收或自动唤醒。T04/R10 保留稳定编号，但旧 Webhook 首版范围已由 Q140 覆盖。
- 本轮只同步产品决策、技术设计、验收矩阵、规则计划、catalog 与可读测试计划；未修改业务代码、测试实现或真实验收结果。catalog 中所有规则仍按未验收或既有局部证据如实记录，不能据此声称微信、Electron 或完整发布已通过。
- 下方旧进度条目保留当时实施事实；其中“会话覆盖、空值继承、群聊/Routine 使用全局值”和 Webhook 相关内容均属于 Q114/Q140 之前的历史状态，不代表当前产品规则。

## 2026-10-25：Live 结束委派提示与 V3 工具边界

- 用户确认采用加强 Live 委派提示、继续保留 Host 语义兜底的方案。`realtimeStartInstructions` 与 `prompt` 现在要求结束请求必须委派给当前 thread 的普通 Codex，并在委派文本中明确写出调用 `rambo_voice.end_current_voice_session`、参数为空对象，避免只传递“结束语音”的模糊文本。
- 核对本机 `codex-cli 0.164.0` 实验 schema：V3 `ThreadRealtimeStartParams` 没有 `tools`/`dynamicTools`；V3 `delegation.created` 只有文本；`HandoffRequested` 会在同一 thread 启动普通 turn。真实会话 `5340e353-5aee-4c65-8365-92e04c741652` 已证明提醒和第二次结束请求分别由同 thread 的普通 Codex 调用 `rambo_routines.create_routine`、`rambo_voice.end_current_voice_session`，thread ID 全程不变。Delegation 与 handoff 不是两种并行机制或两次 thread 创建。
- Host 继续在用户 Realtime 转写完成和收到 `handoff_request` 时运行隔离、只读、无工具的语义判定；同一用户转写 item 去重，只有明确高置信度结束才停止 Live。这样加强主路径的同时，保留 Live 未委派时的安全兜底。
- 定向验证：`node --test tests/backend/host.test.mjs` **74/74** 通过，`npm run typecheck` 通过；新增断言确认 `realtimeStartInstructions` 与 `prompt` 都包含完整工具名、`version` 为 `v3`，且请求未发送 `tools`/`dynamicTools`。`node --test tests/acceptance/catalog-integrity.test.mjs` 为 **10/11**；先报出的既有 catalog 漂移是 `B13-HOST-01` 仍引用已改名的旧 Host 测试，继续扫描还发现 `T02-STORE-01` 和 `B13-HOST-04` 的旧测试名。本轮未修改这些非语音路径，不能报告验收目录完整通过。
- 尚未做加强提示后的真实 Live 音频复验；因此只能说提示和 Host 兜底已经接通并有定向测试，不能声称第一次结束请求的漏委派已经解决，也不能据此通过 V07。

## 2026-10-25：收敛 Bot 设置、系统设置与 Routine 自主规划（历史实现状态）

- 当时模型与权限实现为应用全局和 Bot 唯一私聊会话覆盖两级；该语义已由 Q114 修订为新建 Bot 复制初值后完全独立，现状与剩余改造见本条之后的文档同步记录，不能作为当前规则。
- 系统设置集中展示全局模型、权限和全部 Routine；连接应用保留侧栏独立入口。侧栏底部改为左侧应用头像、右侧连接应用，并移除 Codex 运行时状态标识。Bot 设置保留当前 Bot 的只读“定时任务”Tab。
- Bot 和系统设置移除了页尾保存按钮；自动保存仍在等待、进行中、失败时给出状态，成功反馈短暂显示后收起。全局模型下拉箭头向内收并增加右侧留白，避免贴边和视觉错位。
- Routine 支持 `chat`、`script`、`hybrid`，列表显示“对话执行”“脚本执行”“判断 + 脚本”。Host 每轮向模型注入 `rambo.current-time`（绝对时间、用户本地时间、日期和时区，同一 thread 后续轮次刷新，Live 启动也注入）；提示词要求 Bot 据此解释相对时间、直接填写可从上下文推断的参数、按任务性质自主选择执行方式，并在创建回合只报告计划，不提前计算未来结果。Host 创建 Routine 时使用系统时区，不再走固定默认。
- 一次性 Routine 在成功、失败或中断后，于结果交回来源 Bot 私聊后自动清理活动定义；错过任务保留到用户手动立即运行，执行后再清理。运行历史、聊天结果与产物保留，不需要新增平行的删除 Tool，也不追加系统清理回执。
- 定向验证通过：`npm run typecheck`、`npm run build`；Host、Scheduler、Runtime、Store 后端 **122/122**，验收结构 **16/16**，Connector、邮件与 Voice 相关后端 **32/32**；真实 Electron 全局/会话配置与 Routine 管理流程 **2/2**；`git diff --check`。真实 Electron 已覆盖自动保存反馈及收起、模型下拉箭头几何、系统设置 Routine 分组、Bot 只读清单、执行方式标签和重启回读。
- 新增真实模型 smoke 已接入隔离 profile：要求模型把“2 分钟后”换算为一次性计划，选择脚本执行，并避免在创建回合算出 `5×6`。本轮三次运行均确认 thread 创建、`turn/start` 成功、runtime `ready`，但模型 turn 在 60 秒内持续 `running`，没有 assistant 消息或 Routine；用例按受阻/skipped 记录，不谎报通过或失败。该 smoke 在端点恢复后会继续严格执行任务类型、脚本模板和不提前报结果断言。

## 2026-10-24：Q104 Bot 设置查看自己的定时任务

- Bot 设置恢复“定时任务”Tab，只读展示当前 Bot 的任务名称、计划、执行内容、状态、下次执行时间和最近运行结果；任务按 Bot 过滤，不显示运行控制按钮。系统设置继续展示全部任务并提供暂停、恢复、立即运行和停止。
- 未增加任务信息到聊天上下文；该入口直接读取当前应用快照，与系统设置共享同一份 Store 数据。
- 定向验证通过：`npm run typecheck`、目录同步/计划/目录（126 条规则、126 个完整场景、197 个局部案例）、验收结构 **16/16**、相关后端 **143/143**、Electron 构建，以及完整 `tests/e2e/private-chat.spec.mjs` 串行流程 **22/22**。真实 Electron 已核对新建 Bot 的任务空状态、A/B 两个 Bot 在各自设置中仅看到自己的任务且没有控制按钮，并在同一 profile 集中重启后回读系统设置分组与 Bot 设置隔离。

## 2026-10-24：Q100 固定 Gmail OAuth 配置并精简授权入口

- Gmail OAuth Client ID 固定从应用内常量读取，不再读取环境变量或用户保存配置；移除 OAuth Client ID/Secret 保存 IPC 与 UI 修改入口。旧 profile 中如有客户端配置文件也不会覆盖内置 Client ID。
- Gmail 连接弹窗收敛为一句授权提示和“前往 Google 授权”按钮；等待时提供取消操作。桌面 OAuth 仍使用系统浏览器、本机 loopback 回调与 PKCE，固定 Client Secret 仅用于 Google token endpoint 的授权码交换与刷新，不进入授权 URL。
- 日历图标换为 macOS「日历」App 的原生 AppIcon，导出为保留透明通道的 256×256 PNG；40×40 卡片与弹窗展示规则不变。
- 本轮 Gmail OAuth 用例验证固定 Client ID、无配置修改 API、精简授权弹窗、PKCE 与取消不留连接；没有打开 Google 登录页或访问真实邮箱。
- 定向检查通过：`npm run typecheck`；目录 126 条规则/197 个案例；验收结构 **16/16**；Host、凭证、Gmail OAuth/Adapter 后端 **73/73**；Electron 构建与市场/Gmail 用例 **2/2**；`git diff --check`。

## 2026-10-26：Q153 Gmail OAuth 凭据改为表单填写

- 删除源码内真实 Google OAuth Client ID/Secret 常量；Gmail 连接不再依赖 ENV、构建注入、全局配置或旧配置覆盖。
- Gmail 连接弹窗新增 OAuth Client ID、OAuth Client Secret、连接名称和可展开获取引导；未填完整时不能发起授权，Client Secret 使用密码框且不回显。
- OAuth 配置随每个 Gmail Connection 和用户 token 一起使用应用本地 AES-256-GCM 加密写入独立 SQLite；产品主 Store 只保存 `db:` 不透明引用，Adapter 刷新令牌时使用该连接自己的 Client ID/Secret。该方案不读取 `safeStorage` 或 Keychain，也不需要开发者证书签名。
- 定向验证通过：`npm run typecheck`；连接器/资源/Host/Store 后端 **174/174**；验收结构 **16/16**；台账 **18/18**；目录同步 **142 条规则、142 个完整场景、224 个局部案例**。真实 Electron 的 Gmail 表单、连接市场、通知准入、设置保存、确定性 Routine 清理/多时刻/停止及在完整流程中的集中重启区块通过；完整文件的真实模型 Routine 用例没有创建 Routine，停在外部模型行为结果，随后 Playwright 跳过了部分本地用例；关窗后台退出用例在独立运行时没有发现 App Server，未计入本轮通过。
- 本轮没有使用真实 Google OAuth 客户端登录、授权或访问邮箱，真实 Gmail 端到端仍待验证；打包后的凭证目录权限、普通数据库重启回读与通知中心展示仍未做真实用户验收。
- `npm run package:mac` 的 electron-builder 阶段不主动使用开发者证书、不公证、不启用 hardened runtime，但它复制的本机 Electron 仍可能带 Apple Development 预签名；因此构建后必须先由发版脚本执行 ad-hoc 重封，再作为本机或下载包使用。实际重建后 `codesign --verify --deep --strict` 通过，输出为 `Signature=adhoc`、`TeamIdentifier=not set`、无 Authority；这不是 Developer ID 或开发证书签名，也不会让 Gatekeeper 信任应用。通知不依赖该签名步骤。
- 重封后的真实 `.app` 已在隔离 acceptance profile 启动，默认页面可用，登录启动偏好可保存、刷新并关闭；启动与这条界面流程没有触发 Keychain。Gmail 成功授权后的凭证落库仍需用户自己的 OAuth 客户端与 Google 授权，本机没有虚构该外部结果。

## 2026-10-24：Q98 调整侧栏底部入口

- 左侧栏底部改为左侧应用头像（打开系统设置）、右侧连接应用；移除 Codex 运行状态标识，主菜单栏状态保持。
- 定向验证通过：`npm run typecheck`、`npm run build`、目录同步/计划/目录/验收结构（125 条规则、196 个案例、16/16）、侧栏与全局/会话配置 Electron 用例 **1/1**、`node --check` 和 `git diff --check`。真实 Electron 用例核对头像在左、连接应用在右、紧凑模式仍横向排列，且底部没有 Codex 状态标识。

## 2026-10-24：Q97 收敛模型与权限为全局级和会话级

- 系统设置提供唯一的应用全局模型和权限；Bot 设置“会话配置”只提供该 Bot 唯一私聊的模型/权限覆盖，空值继承全局。群聊与 Routine 使用全局配置，旧 Bot 默认字段和群聊会话覆盖不再影响有效配置；移除 Bot 默认配置及“应用到全部聊天”层级。
- 普通变更自动保存并从后续轮次生效，正在执行的轮次保持启动快照。Bot 自管理工具只能修改当前 Bot 私聊覆盖，不能修改全局配置或其他 Bot。
- 定向验证通过：`npm run typecheck`、`npm run build`、目录同步/计划/目录/验收结构（125 条规则、196 个案例、16/16）、Host/Store 后端 **89/89**、私聊 Electron **3/3**、群聊 Electron **3/3** 及 `git diff --check`。群聊和 Routine 采用全局配置、私聊覆盖自动保存/重启回读均有定向代码与 Electron 证据；真实 App Server 的实际模型路由仍待单独验收。


## 2026-10-24：Q96 首轮连接市场与 Gmail OAuth 配置入口（OAuth 已由 Q99/Q100 修订）

- 目录只保留 Gmail、QQ 邮箱、日历和 GitHub；仅前两项可连接，日历与 GitHub显示“即将推出”。四项均使用官方 Logo 直接以 40×40 尺寸显示，容器背景透明且没有边框、圆角底或阴影；连接按钮适配明暗主题且不带加号。
- 首轮实现因应用内没有 Client ID 而显示一次性配置入口；Client ID 是 Rambo OAuth 应用标识，不能由本机回调替代。Q99 已将用户提供的 Desktop Client ID 预置到应用，Q100 再固定配置并精简授权弹窗；Q105 根据真实 token endpoint 结果补齐固定 Client Secret，仅用于 token 交换与刷新。
- 首轮定向用例只启动并取消本机回调挑战，没有打开 Google 登录页或执行真实邮箱授权。
- 定向验证：`npm run typecheck`、连接器/Host/Store 后端测试 **110/110**、`npm run test:catalog`、`npm run test:acceptance` **16/16**、市场与 Gmail OAuth Electron 用例 **2/2**、`git diff --check` 通过。Electron 用例使用隔离 profile 和假 OAuth ID，只启动并取消本机回调挑战；未登录 Google、未接入真实邮箱。

## 2026-10-24：Q95 Bot 头像眼睛改为透明镂空

- Bot 头像均通过共享的 `AgentRobotAvatar` SVG 源头绘制；在脸部 SVG 上增加亮度遮罩，用动态眼型轮廓从脸部挖空，容器背景透出作为眼睛颜色。眼型、输入态、眨眼、表情、眼睛跟随和头部运动共用同一套变形参数，眼洞随动画同步。
- 该源头统一覆盖侧栏、聊天与群聊消息、群组合头像、运行行、提及候选、Routine 列表、新建/设置预览和眼型选择器。菜单栏图标使用独立资源，原本已将眼睛做成透明镂空。
- `UPSTREAM.md` 标注了需在同步上游时保留的本地 SVG 遮罩改动；B14 与 Q95 的规则级验收已加入所有头像位置、背景透出及动态镂空对齐要求。
- `node --check`、生产构建、头像 Electron 用例 **2/2**、目录验证（124 条规则、194 个案例全部映射）、验收结构 **16/16**、`git diff --check` 通过。Electron 用例使用自动创建并清理的隔离 profile，覆盖创建/设置头像、当前眼型、鼠标跟随与暗色黑色头像；没有做全头像位置的像素级视觉对照，B14 仍待完整验收。
- `npm run typecheck` 报 3 个现有 `App.tsx` 错误，均为 Gmail OAuth Client Secret 状态变量未定义；本轮未改该文件。

## 2026-10-24：Q93 Live 状态并入运行行并修复挂断残留

- 只读核对会话 `0a998957-8ed6-484b-ad52-01ef1c3529a9`：语音转写已写入聊天记录，取快递一次性任务已创建并在北京时间 11:04 执行。
- 根因是 Bot 主动挂断时 Host 先移除活动语音会话，随后等待 `thread/realtime/stop`；`thread/realtime/closed` 因会话查找失败被忽略，而 Renderer 只收到 `stopping`。另一个缺陷是 stop RPC 报错时工具仍返回成功。
- 删除独立语音面板，将连接中、聆听中、结束中和错误态放入既有 Agent 运行行。Host 现在发出挂断终态；停止失败向 Bot 返回失败、保留可重试会话并让 UI 显示错误，不会永久停在结束中。
- 回归证据：Host 全套 52/52；新 Electron 状态行用例 1/1；Electron 构建成功；验收结构 16/16；目录验证 124 条规则、194 个案例全部映射；`git diff --check` 通过。
- `npm run typecheck` 仍报告工作区系统设置区域的类型问题（`App.tsx` 系统设置 props、保存状态组件及回调类型），与本轮语音代码区域无关；本轮语音改动没有新增类型诊断。真实麦克风 Live、语义挂断和监听恢复仍按 V07 待实机验收。

## 2026-10-24：Gmail OAuth 本机配置与运行时接入

- 历史实现曾支持保存/修改 OAuth Client ID、Client Secret 和环境变量覆盖；这些入口已按 Q100 移除。当前固定使用应用内 Desktop Client ID 与 Client Secret，忽略旧配置与环境变量；Secret 只出现在发往 Google token endpoint 的表单中，不进入授权 URL、渲染层或日志。
- Gmail 运行时启动时创建桌面 OAuth 服务，将 Gmail API Adapter 注册到统一 MailRuntime；令牌刷新后沿原凭证引用加密回写。用户不能修改 OAuth 客户端配置。
- 定向证据：类型检查通过；连接凭证后端测试 6/6；真实 Electron 私聊与连接市场流程 19/19。E2E 使用隔离 profile 和假 OAuth 值，只启动并取消 loopback 授权挑战，没有打开 Google 登录页或建立 Gmail 连接。
- 仍未执行真实 Google/QQ 账号联调，也未读取或发送真实邮件；T10/T11 不能据此标记通过。T17 的 thread 工具 schema 暴露差距继续按原记录保留。

## 2026-10-24：连接应用市场按 Grok Bot 0.75.0 静态结构对齐

- 依据 [UI 基准中的市场静态分析](ui-baseline.md#2026-10-24-连接应用市场)，将首页改为“推荐”和“所有应用”分组；Gmail、QQ 邮箱列入推荐，其余 Provider 保留在目录。搜索与 Provider 分类筛选继续可用，前五个分类直接显示，其余放入“更多”，已连接状态可单独筛选。
- 应用条目改为两列紧凑列表，使用 40px 图标、无重边框的 16px 圆角底、轻悬停底色和右侧连接/管理操作。Bot Grant 摘要保留在条目中，具体授权、断开与重连从“管理”弹窗操作；不可用 Provider 显示“即将推出”。
- `node scripts/change-checks.mjs` 命中类型检查、验收结构、相关后端和 Electron 流程。按本轮 renderer 与 UI 文档实际改动执行：`npm run typecheck` 通过，`npm run test:catalog` 通过（122 条规则均映射），`tests/e2e/private-chat.spec.mjs` 19/19 通过，`git diff --check` 通过；未运行不相关的群聊/头像 Electron 文件及全部套件。
- Electron 流程仅使用隔离 profile 与假 OAuth 值；Gmail 流程只检查加密保存并启动、取消本机回调挑战，没有打开 Google 登录页、连接邮箱或访问真实邮件。静态参考不是 0.75.0 运行时截图，P02 的同窗口像素对照仍待完成。

## 2026-10-23：Connector Core 邮件接入

- 已接入统一 `rambo_mail` 宿主动态工具，提供 `mail_search`、`mail_read`、`mail_get_attachment`、`mail_create_draft`、`mail_reply` 和 `mail_send`；每次调用必须携带 `connection_id`，结果回传实际 Provider 与账号。QQ 与 Gmail 的协议差异只在 Adapter，Host 统一校验连接状态和逐 Bot Grant，不按 Provider 写业务分支。
- Gmail 已实现桌面 OAuth + 本机 loopback 回调 + PKCE/state、应用本地 AES-256-GCM 凭证加密、同一凭证引用刷新令牌、Gmail REST API 映射与 401 单次刷新重试。QQ 已实现 IMAP/SMTP 授权码验证、搜索/读取/附件/草稿/回复/发送。两家均未执行真实账号联调，不能声称 T10/T11 已通过。
- 修复了 Gmail 回复发送未携带 `threadId` 的问题；Gmail 回复保留 `In-Reply-To`、`References` 与线程 ID。QQ 回复保留原邮件 Message-ID/References。
- 修复 Host 在 `thread/resume` 非法提交 `dynamicTools` 的真实协议错误。按 schema，动态工具只能在新建 thread 时注册；当前私聊首轮固定包含 `rambo_mail`，Grant 变化只改变目录与调用时校验且不重建 thread。
- T17 仍有规格落差：未 Grant 时目录为空且调用被拒绝，但 `rambo_mail` schema 可能仍在首轮已注册的 thread 中；这不满足“撤销后连只读工具也不暴露”的字面要求，需后续重建/隔离执行上下文处理或由用户确认修订，不能以模拟调用通过代替验收。
- 定向验证：`npm run typecheck` 通过；Connector、Gmail、QQ、Host、Store 相关后端测试 99/99；验收目录与规则测试 16/16；真实 Electron `tests/e2e/private-chat.spec.mjs` 17/17。以上邮箱结果仍为进程内或模拟协议证据，未打开 Google 登录、未使用 QQ 授权码、未发送真实邮件。
- 上述进度记录的是 2026-10-23 当时状态；Gmail OAuth 固定 Client ID 与精简授权窗口按 Q99/Q100 执行。

## 2026-10-23：Q89 用户与 Bot 新气泡统一入场

- 把原仅用于用户发送气泡的约 220ms 淡入、轻微上移和缩放恢复提升为私聊、群聊共用的新消息入场：用户消息和 Bot 新气泡都会播放，历史加载、重新打开、流式 token、状态更新不会重播。
- Bot 同轮阶段内容替换继续使用独立约 160ms 的动画，不与气泡首次入场叠加；系统提示、运行行和错误提示不套用气泡动画。减少动态效果设置下统一禁用。
- 定向验证通过：`npm run typecheck`、`npm run build`；真实 Electron 私聊“用户和 Bot 气泡统一平滑入场”1/1、群聊“用户和 Bot 气泡统一平滑入场”断言 1/1。阶段替换与历史重开不重播仍按 S01 缺口保留。

## 2026-10-23：Q88 在 Loading 中展示真实 Turn 启动阶段

- 用户消息已持久化并发布后，Host 在发起真实 `turn/start` 前设置本轮准备状态，运行行显示“正在读消息”；收到 `turn/start` 成功响应或 `turn/started` 后清除并切换到“正在思考”或后续真实活动。失败、中断、完成、运行时断开均收口，旧轮次清理不会误清后续状态。
- 群聊成员运行态新增 `starting` 阶段：成员先表示正在接收本轮消息，拿到启动响应后才按任务模式进入“正在判断”或“正在工作”，不再从点击发送起就谎称已经开始判断。
- 该状态完全独立于发送握手：输入框仍在用户消息提交后立即清空，`Host.send()` 也不等待 `turn/start`。Loading 只补充真实生命周期反馈，不用来确认消息是否发送成功。
- 文档已新增 Q88，并同步 B11、S01、验收矩阵、可读测试计划、规则计划与 UI 基准。
- 定向验证：`npm run typecheck`、`npm run build`、`node --test tests/backend/host.test.mjs`（41/41）、其余相关后端（59/59）、目录同步/计划/目录/验收结构（16/16）通过；真实 Electron 群聊 3/3，私聊“阶段回复/运行行”和“发送即清空”2/2 通过。完整私聊文件串行执行到第 18 项时，该重启回读用例自身因依赖前序用例累积的数据而未命中 `E2E Pilot`；这不属于本轮改动路径，本轮未把它登记为通过。仍不声明 B11/S01 整体通过。

## 2026-10-23：Q81/Q82 模型入口收起、运行头像动效与发送交互

- 私聊和群聊输入框移除模型下拉及相关浮层；模型与权限统一在 Bot 设置“模型与权限”页管理。保存当前私聊覆盖后继续停留在当前 Tab，不再跳回“基础资料”。已有群聊成员模型/权限覆盖数据保留，仍参与后续轮次的配置解析。
- Loading 运行行中的 Bot 头像改为自动播放动效，`followOnHover={false}` 保证鼠标经过时不改变姿态；左侧会话栏运行头像继续保留悬停跟随。私聊和群聊入口共用这一参数。
- 输入框优化了边框层次、圆角、内边距、阴影、聚焦光圈、文字排版和发送/语音/停止按钮的悬停、按下和禁用反馈。私聊 Placeholder 动态为 `发消息给 <当前 Bot 名称>`，群聊保持 `发送群聊消息…`。
- 按 Q82 删除 Portal 飞行克隆、发送前全量消息扫描和 16ms 气泡定位轮询。输入框在提交时立即清空；真实用户消息到达后仅在消息区添加约 220ms 的淡入与轻微上浮标记，动画结束即移除标记。减少动态效果设置下禁用该动画。
- 单聊 `Host.send()` 不再等待 `turn/start` 回包：真实用户消息持久化并发布后即返回；提交前错误仍拒绝发送并恢复原文，提交后启动失败通过 `error` 事件显示。群聊在用户消息发布后立即返回，成员回复在后台启动，群聊忙碌状态持续到本轮成员处理完成。
- 用户消息保留稳定 `data-message-id`；`@` 成员补全插入时同步更新 `draftRef`，确保选择成员后立即按 Enter 发送时读取新草稿。
- 定向验证通过：`npm run typecheck`、`npm run build`、`git diff --check`；`tests/backend/host.test.mjs` **41/41**，其中新增用例直接证明单聊和群聊均在 `turn/start` 回包前返回且用户消息已落库；真实 Electron `private-chat`、`group-chat` 两个文件 **19/19**；`test:catalog:sync`、`test:plan`、`test:catalog`、`test:acceptance` 通过（117 条规则、177 个案例，16 项验收结构测试）。这证明 Q82 的定向交互与发送时序，不证明整体规则通过。提交前失败恢复原文、提交后启动失败提示仍缺真实 Electron 失败注入；当前运行行仍在 `.transcript-scroll` 外的悬浮 dock，尚未满足内容流位置，也未执行完整 Electron 套件、真实 App Server 长任务接管、真实 macOS 菜单栏/Dock 目测或发布验收，因此不声明 B06、B11、S01 整体通过。

## 2026-10-23：Q77 暗色模式黑色头像色块

- 系统暗色主题下，`black` 头像沿用既有反色显示为白色；颜色选择器中的黑色色块同步为白色，切回浅色主题仍显示黑色。
- 持久化颜色标识保持 `black`，没有迁移已有 Bot 数据；头像墨色与色块展示变量分开，避免头像被二次反转为黑色实心圆。
- 已增加真实 Electron 暗色主题断言，覆盖新建与设置页的色块、头像墨色、反色滤镜和颜色标识；实际截图复核头像及眼睛候选均正常显示为白色圆脸。

## 2026-10-23：Q76 群聊 @ 成员补全

- 群聊输入框键入 `@` 后，按光标前的未完成查询过滤当前未归档成员，并加入 `@everyone`；候选以靠近输入框左侧的紧凑浮层展示头像、名称和短职责。
- 支持方向键循环选择、`Enter`/`Tab` 插入、`Escape` 关闭和鼠标点选；选中只替换当前查询，保留其他文字与光标后内容，并在候选打开时阻止 Enter 误发送。
- 补全文本使用后端现有 `@成员名` 路由格式，含空格名称按最长成员名匹配；纯函数单测及实际 Electron 键盘、Escape、鼠标点选和成员路由场景已补充。
- 用户明确暂缓创建 Bot／群聊后的首条主动消息，本轮没有修改 B04/G01 或相关创建路径。

## 2026-10-23：Q75 聊天框空白可滚动与滚动条淡入淡出

- 聊天 transcript 改为覆盖整个聊天框视觉区域，输入框继续作为悬浮层；输入框与最后一条消息之间的空白不再属于不滚动的占位层，鼠标放在该空白处滚轮可滚动消息。
- 用户复验指出原生滚动条即使加延迟和背景过渡，实际仍是延迟后瞬间显隐。聊天区域因此改为自绘滚动条：隐藏原生聊天滚动条，thumb 位置与高度跟随 transcript，透明度通过普通 DOM 的 CSS transition 连续变化，私聊和群聊共用。
- 隐藏的运行行保留固定占位并取消鼠标命中，使空白区滚轮落到 transcript，同时保持运行行出现和退出时底部锚点不跳动。
- 新增真实 Electron 回归：构造长消息，将鼠标放在输入框上方空白，发送真实滚轮事件并要求 transcript 向上移动；进入和离开聊天区域时逐帧采样自绘滚动条透明度，要求出现 `0 < opacity < 1` 的中间状态，再分别稳定到 1 和 0。
- 定向验证通过：`消息流显示阶段回复`、`输入框上方空白可将滚轮交给聊天消息区`、`npm run typecheck`、目录同步与 16 项验收结构测试。未构建、未执行完整 Electron 或发布验收。

## 2026-10-23：Q74 移除 Dock 运行气泡

- 删除系统指示器对 Dock badge 的更新：Bot 运行期间菜单栏 Tray 继续播放 working 帧，Dock 图标不再出现红色“·”气泡；侧栏未读数字徽标、应用内通知记录和系统通知规则不变。
- 相关产品决策、验收矩阵、规则计划和 UI 基准已同步；状态机测试改为断言运行/停止时只切换菜单栏动画，不再注入或期待 Dock 角标。
- 本轮待执行 `node scripts/change-checks.mjs` 后选出的相关检查；未做真实 macOS Dock 目测，因此不能据此声明 B11 整体通过。

## 2026-10-23：Q72 阶段性回复替换

- 私聊和群聊的助手文本按轮次 `turnId` 更新同一条持久化消息；后续 commentary/partial_answer 阶段及 final_answer 替换当前内容。旧阶段不再留下独立历史/搜索行；群聊实时同步阶段更新。群聊判断最终返回内部不回复标记时，会移除该临时气泡。
- 阶段/item 切换时内容约 160ms 淡入并轻微上移；同一 item 的流式增量不触发重播，尊重系统减少动态效果。停止、失败或运行时中断时，将保留气泡的状态更新为“已停止”或“未完成”。SQLite schema 更新至 21，为群聊消息保存轮次和阶段。
- 本轮 `npm run typecheck`、`npm run build` 与 `git diff --check` 通过；未运行后端/Electron 测试或真实聊天 UI，因此动画实际观感和 App Server 多阶段事件仍待运行验收，B11/P02 不据此标为通过。

## 2026-10-23：Q71 聊天正文与结构化展示

- 私聊和群聊共用 `MessageContentView`。普通消息支持 Markdown 标题、段落、列表、引用、链接、图片、表格、脚注、任务清单、数学公式；代码块提供高亮、行号和复制；Mermaid 支持流程、时序、ER、甘特、饼图、时间线、桑基、C4 等语法。
- 增加 `rambo_chat_ui.ask_question` 与 `rambo_chat_ui.show_content` 动态工具。结构化展示支持选项/多选/自定义回答、天气/购物/表单/审批/连接器/邮件/日历卡片、图像/文件/音视频预览、语音行、MCP iframe 和柱状/折线/饼图/数据表。
- 卡片数据通过 SQLite `contentJson` 持久化，数据库 schema 当前为 21。未回答卡片在重启后恢复；多张卡可并存并分别操作；自由文字输入关联最新待答卡，回答一张只关闭该卡。交互 Tool 只开放于用户面对的 Bot 对话，Routine 执行会话仍由原 Bot 决定是否展示。
- 验证状态：本轮完成后 `npm run typecheck` 与 `npm run build` 均通过，`git diff --check` 通过；未执行后端或 Electron 测试，也未做 Grok 截图级运行对照，因此真实 App Server 工具调用和聊天内视觉效果仍待运行验收。

## 2026-10-23：Q70 全局定时任务按 Bot 分组

- 全局“全部定时任务”页已按 Bot 分组并默认展开；组头展示头像、名称和任务数，组内任务卡不再重复显示 Bot 名称，任务计划、执行内容、状态和运行记录继续显示。Bot 详情页保持按当前 Bot 过滤。
- B12 的规则场景、可读验收计划、目录和 Electron 断言已同步。对应的 `Bot 设置显示自己的任务且左侧总览在重启后保留全部归属` Electron 场景通过（1/1）；它提供分组与回读的局部证据，不代表 B12 整体通过。

## 2026-10-23：单聊/群聊统一动态运行行与群消息身份

- 按 B11/G12/Q68 将单聊与群聊运行态统一为同一组件：左侧显示 Bot 头像组、右侧显示最新活动驱动的统一文字，不再显示三点。单聊一个头像；群聊显示本轮仍参与判断、思考或执行的成员，最多展示最近 3 个并在左侧头像组右侧显示 `+N`，悬停可查看其余成员名称。普通消息判断阶段显示全部参与者“正在判断”，活动更新后显示思考、搜索、处理文件、运行命令等统一状态；成员逐个完成退场，全部结束整条隐藏。
- Host 新增进程内 `groupRuntimes` 状态并通过 snapshot/事件同步渲染层。普通消息和 `@everyone` 记录全部活跃参与者，`@成员` 只记录指定成员；成员活动按各自群会话归属，避免状态串到其他 Bot。运行时断开时清理并通知全部群运行态。
- 群聊 Bot 气泡左侧显示实际发言者头像，右侧保留名称与内容；头像与名称读取 Bot 当前资料，Bot 删除后旧消息固定显示占位头像和“已删除的 Bot”，不再回退历史 `senderName`。
- 当前代码仍把 `AgentRunningRow` 放在 `.chat-bottom-dock`，该 dock 位于 `.transcript-scroll` 外，固定在输入区上方。因此“运行态出现和退出时底部锚点不移动”虽已有真实 Electron 断言，但只证明当前 dock 的行为，不满足 B11 要求的“运行行留在聊天 transcript 内”，仍是明确实现缺口。
- 本轮文档修改前最近一次代码基线曾记录：类型检查通过，后端 **101/101**，验收目录与脚本 **16/16**，Electron **17/17（约 37.1 秒、约 4 次启动）**。Routine 最终结果通过真实 `item/completed` 写入 SQLite 并驱动原私聊预览；手动运行一次性任务会清空原计划，避免随后又被标为错过。该结果早于本轮决策与验收文档同步，不能视为当前文档版本的重新验证。Host/Electron 已覆盖参与者、最新活动、逐个退场、全员结束、群消息头像与作者名；运行行 transcript 内位置、四成员以上并行视觉、`+N`、改名换头像、删除态和资料变更前后证据仍保留为 B11/G12 缺口，不能据此通过 B11/G12 或发布验收。
- `R16` 已于 2026-10-25 实现后端终态清理：一次性 Routine 的成功、失败或中断结果交回 Bot 私聊后删除活动定义，错过任务保留到用户立即运行并完成后再清理；`routineRuns`、来源聊天消息与成果不随定义删除。Host/Store/Scheduler 已覆盖成功、失败、错过后手跑和跨 Bot 隔离；定向 Electron 已回归成功、失败交接后 UI 清理，错过项保留、手动完成后清理，以及成功/失败 run 仍保留。中断的独立 UI 注入、完整历史页和成果文件入口仍未覆盖，不能据此声明 R16 整体通过。

## 2026-10-25：Routine 自主规划、执行方式与一次性清理

- `RoutineDefinition.execution` 新增 `chat | script | hybrid` 与可选脚本模板；旧数据默认 `chat`，`script/hybrid` 必须带模板。Store 已验证创建、更新、重开持久化和旧数据兼容。
- Host 的 Routine 工具和系统提示已开放执行方式，要求 Bot 优先从对话和已有上下文推断标题、内容、计划、时间与执行类型；只有安全或不可逆操作存在实质歧义时才追问。Bot 独立提出的新自动化建议仍按 R12 先征求同意。
- 2026-10-25 本机真实会话 `53f6756c-4b16-4c58-9e85-2a12d72985e8` 已证明模型能自主创建一次性 Routine，但首轮把“2 分钟后”原样作为 `HH:mm` 提交而失败，相同任务也选择了 `chat`。据此补充提示：相对时间先按当前时间和用户时区换算，创建回合只登记任务且不提前执行未来结果；执行方式仍由模型根据任务性质自主判断，没有把特定计算写成硬规则。Tool 返回的触发时间改为用户时区可读文本，避免把 UTC ISO 字符串原样带给模型和界面。
- `script/hybrid` 仍进入独立 Codex 回合，并由现有权限、审批和审计约束；执行上下文携带模板与模式说明，不新增任意 shell 旁路。
- 一次性任务定义只在结果交接成功后的 dispatcher 阶段清理，交接失败时保留以便重试；清理发布状态变更，不追加并行系统回执，周期任务和其他 Bot 的定义不受影响。
- 系统设置与 Bot 设置的任务卡均显示执行方式标签。真实 Electron 定向流程已验证 `script` 任务在两处都显示“脚本执行”，默认 `chat` 显示“对话执行”，并覆盖全局模型/权限保存、按 Bot 分组任务、重开保留归属、一次性成功/失败/错过后手跑清理。
- 系统设置全局模型下拉框增加右侧留白并内收箭头；模型与权限页的自动保存成功提示改为短暂显示后收起，长期页面不再常驻“更改会自动保存”。Host 新增断言证明 Routine 执行回合使用应用全局模型与权限，忽略 Bot 旧默认值和私聊覆盖；一次性 Routine 的成功、失败、中断都在结果交回后清理，错过任务保留到手动完成。
- 本轮最终定向验证通过：`npm run typecheck`、`npm run build`、Host/Scheduler/Runtime/Store **122/122**；真实 Electron 的全局模型/权限自动保存、Bot 会话覆盖、保存反馈、下拉箭头留白与 Routine 系统/Bot 双入口分组流程 **2/2**。后续补齐当前时间上下文后，Host **71/71**、验收目录 **128 条规则/199 个案例**及验收结构 **16/16** 通过。这些结果证明提示词、真实时间/时区数据、Tool 输出、UI 和持久化边界已经接通；真实模型在新提示下是否稳定完成相对时间换算、选择 `script` 并避免提前执行未来结果仍需新的真实对话 smoke。

## 2026-10-22：Grok 式动态运行态、侧栏最后一句话与移除 COT

- 按 Q66/P02/B11 已实现聊天内 Grok 式动态运行行：当时为三个青色动态圆点和左到右扫光活动文字，按最新活动切换中文状态；聊天运行行不显示头像、Bot 名称或秒数。该运行行已由 2026-10-23 的 B11/G12/Q68 头像组实现取代。运行 Bot 的左侧会话栏头像使用呼吸/轻微形变动效。Grok Bot 0.72.0 的三点与扫光 CSS 参数已提取，当前 0.75.0 的 `GrokBotMark` 为 30/60fps 动态渲染；逐帧头像复刻与逐像素运行态对照尚未完成。
- 按用户最新决定彻底删除聊天内 COT/过程详情入口：不再显示“思考与操作”“查看过程”等按钮，也不再保留相关展开样式。底层 `turn_activities` 与 `turns` 继续保留，用于动态运行状态、模型审计、Routine 关联和内部证据，不作为普通聊天页面入口。Agent 的 `commentary`、`partial_answer` 与缺失 phase 的兼容文本继续进入普通消息流；单聊 Bot 气泡不显示作者名，群聊显示实际发言 Bot 名称。
- 左侧 Bot 会话栏名称下方的副标题改为该私聊最后一条用户或 Bot 消息；没有消息时才回退到 Bot 职责或“开始聊天”。该预览由 snapshot 的 `recentMessages` 随附字段提供，切换 Bot 与重启后保持一致；新增 Store 定向单测覆盖“最后一条可见私聊消息、忽略 system 行”。
- 聊天区已改为仅在接近底部时跟随新消息；用户上翻后，运行状态和活动更新不会自动跳回底部，也不显示“回到最新”按钮。菜单栏已加入原生 Tray 多帧动画和运行态 working 图标；按后续 Q74，Dock 运行 badge 已移除，静态资源、状态机单测和构建通过，真机菜单栏外观仍待复验。
- Store 升级到 schema 16，新增消息 `turnId/phase` 和 `turn_activities` 持久化。Host 已处理 Codex 的 item started/completed、reasoning delta、command/file output delta、MCP progress 与 plan delta；类型检查和后端 **81/81** 通过，新增 Host 集成测试覆盖阶段消息可见、活动归属、事件发布及重启回读。
- 相关真实 Electron 案例已更新为：检查执行中动态行无头像、左侧运行 Bot 头像带动效（比较真实像素帧）、活动状态切换、阶段消息单独显示、单聊免作者名、群聊显示实际发言 Bot 名、侧栏最后一句预览，以及最终回复不存在 COT/过程入口和“运行详情”。最新定向验证：类型检查通过、构建通过、相关私有聊天与群聊 Electron 案例 **2/2 通过**；Store 最后消息预览、预览乱序保护、菜单栏状态单测 **3/3 通过**；Host/Store 相关集成测试 **61/61 通过**；验收目录校验与脚本测试 **16/16 通过**。本次未跑全量套件，仍不能据此通过 P02/B11 或发布验收。
- 侧栏未读提醒已接入 SQLite 已读水位：只统计唯一私聊中上一次已读之后由 Bot 发出的可见回复，用户消息和内部系统记录不增加未读；进入私聊、窗口重新获得焦点时清零并持久化。当前前台会话收到已完成的 Bot 回复或结束回合时也会推进已读水位，快照刷新同步抑制该会话的瞬时未读回显。重复点击当前私聊不再重新加载消息区。最新定向验证：类型检查通过、相关后端测试 **78/78**、验收脚本 **16/16**，真实 Electron“侧栏未读徽标”案例通过。
- 按 Q67 在 Bot 唯一私聊注册 `rambo_groups.create_group`：当前 Bot 自动成为成员，只接受已存在且未归档的成员，至少两个不同 Bot，任意重复成员都会被拒绝；成功后持久化群聊与成员，不自动发送首条群消息，并发送 `groupCreated` 事件让当前界面直接打开新群聊和统一侧栏入口。聊天输入框下方快捷键提示已移除，`Enter` 发送与 `Shift+Enter` 换行保持不变；单聊和群聊输入区不再显示权限控件，权限仍由 Bot 设置页管理。

## 2026-10-22：当前 dev 局部案例与候选包复验

- 当前开发模式验收 run 为 `acceptance-runs/20261022-acceptance-final-01`，冻结产品决策、验收矩阵和测试目录基线；dev epoch 1 源码指纹为 `1913207f0c5fb826486956c8812509cc06056e46d46bcd0eac60d001196a0ae8`。
- `npm run verify:fast` 在目录描述修正后通过：类型检查通过、后端 **79/79**、验收脚本 **16/16**、目录边界 **173/84/89**、台账 **18/18**。该数字是当时快照；R16 新规则把两个旧行为案例改为缺口后，当前目录为 175 个案例、82 implemented、93 not implemented。完整功能门禁当时执行 **80** 个局部案例并通过，原始结果与输出分别位于 `acceptance-runs/20261022-acceptance-final-01/evidence/feature-all-80/result.json` 和 `output.log`。
- 局部案例通过不等于规则通过。当时规则仍为 **0/113**，113 个完整规则场景尚未逐条完成；J1–J4 和当时的六个发布套件也未通过。89 个 not implemented 案例继续作为发布阻塞。该数量是当日历史快照，当前以 117 条规则目录为准。
- 从当前源码重建 `dist/mac-arm64/Rambo.app`，`app.asar` SHA-256 为 `ac1035326baefcddcc7ba61f7943b4e16477ca79bcbe851552dd11bc816e46b6`，应用签名严格验证通过但未公证。独立 app run `acceptance-runs/20261022-package-final-01` 已机器验证 A02-PACKAGE-01/02 与 A05-PACKAGE-01/02 四个局部包案例；A02/A05 的隔离安装、真实授权与模型任务、Computer Use 分发和升级隔离仍未验证。
- `npm run verify:release -- --sections J1,J2,J3,J4,connections,files,recovery,scheduling,interface,workflow` 退出码为 **1**，在测试前因 76 条规则无已实现测试及 89 个未实现案例被拦截；日志见 `acceptance-runs/20261022-acceptance-final-01/evidence/release-gate.log`。这不是发布验收通过。

## 2026-10-22：B06/B13 闭环增强与 G01 群历史工具

- `B06` 的真实 Electron 案例现在从当前 App Server 模型目录选择一个实际存在的模型，验证 Bot 默认模型、默认权限、唯一私聊模型与权限覆盖、A/B 范围隔离以及同 profile 重启持久化。尚未启动真实推理轮次，因此执行中快照、全局默认解析和实际 thread 模型仍未证明。
- `B13` 的真实 Electron 案例扩展为资料和配置写入、私有记忆新增与删除、Routine 创建/修改/暂停/恢复/删除、详情和全 Bot 总览回读、重启后回读。所有写入经验收专用事件进入真实 Host 处理器，未直接写数据库；仍未证明真实 Codex 自主选择工具、下一轮真实模型行为、群聊身份同步和 R14 删除历史。
- `G01` 的 Host 案例证明群成员会话仅获得 `rambo_group_history.read_history`，近期上下文默认有界，更早的当前群消息可按需查询，Bot 私聊和其他群不可读，跨群游标被拒绝。产品内添加既有群新成员的界面流程、真实模型自主调用历史工具和真实群聊旧事实旅程仍保留为缺口。
- 既有群添加成员已补齐：群聊标题新增“成员”入口，通过真实 Store/IPC/renderer 路径追加 Bot，保持成员顺序和已有消息；真实 Electron 验证组合头像及重启持久化。新成员的 Host 案例进一步证明其使用独立群成员会话，不读取自己的私聊，并能从当前群历史工具按需查到加入前事实。
- 当前目录为 **168** 个局部案例（**71** 个有实现证据、**97** 个明确缺口），有局部证据的规则 30 条，规则级通过仍为 **0/113**。最新完整校验结果：类型检查通过，后端 **67/67**，目录与门禁 **16/16**，台账 **18/18**，真实 Electron **12/12（55.8 秒）**，定向门禁 19 个局部案例通过。这些是当时源码构建的局部测试结果，不是发布验收通过，也不是当前 117 条规则基线。

## 2026-10-22：J1 快速验收基础与候选包证据

- 验收执行器修复了 Playwright 规则筛选：中文测试标题改用稳定子串匹配，`--grep` 位于文件参数之前。`npm run verify:feature -- --rules P03,B01,B02,B04` 现实际执行 7 个局部案例，其中 2 个为真实 Electron 路径，整套约 8 秒；不再出现“测试存在却 No tests found”。
- Runtime 新增受控子进程测试，证明 Rambo 启动自己的 `codex-app-server`，参数含 `--session-source app-server`，停止后仅该 PID 消失。Host 新增同一 Bot 跨两轮及 Host 重建继续同一私聊 thread、群聊成员会话使用独立 thread 的测试。以上分别只形成 A01/B02/A05 的局部证据。
- 真实 Electron 创建流程补齐空名称拒绝、云朵/蓝色头像选择与持久化、创建后空白聊天、重启后唯一私聊连续性；设置页确认复用本机 Codex 登录且无 Rambo 注册或跨设备同步入口。Playwright 仍操作真实 Electron，不依赖 Computer Use。
- 新增候选包资源测试与打包版 Playwright 启动测试。重新构建的 `dist/mac-arm64/Rambo.app` 通过 `codesign --verify --deep --strict`；包内 0.163.0 运行时、Code Mode Host、ripgrep 和两份清单齐全，三个二进制为 arm64 且签名有效。打包版以 `app.isPackaged=true` 从自己的 `Contents/Resources` 启动，并直接拉起包内 `codex-app-server --session-source app-server`。构建跳过公证，因为当前未生成 `notarize` 选项。
- 当时目录为 113 条规则、113 个完整场景、4 条旅程、6 个发布套件、154 个局部案例；其中 58 个已有实现证据、96 个明确缺口。该统计已由上面的最新记录替代。
- 当时已验证：`npm run verify:fast`；`npm run test:e2e` 5/5；候选资源 3/3；打包启动 1/1；`npm run verify:feature -- --rules P03,B01,B02,B04`。仍需真实原生 Codex 并行与任务隔离（A01/A04）、无外部 Codex 的隔离安装与真实登录任务及 Computer Use 分发（A02/P01/P03）、两次真实升级隔离（A05）、未登录 App Server 授权（A03）、登录项系统行为（O01）等条件。

## 2026-10-21：R11 部分实现与 epoch 7 验收续跑

- 按产品决策 R11/R12，epoch7 已接入新建单 Bot 文字线程中的例程定义保存和查询：任务列表显示指令/周期表达，并标明当前不会自动触发或执行。重复工具调用使用 callId 去重；已有线程和群聊不开放该创建工具。实现未包含 Live、调度器、触发执行或完整任务管理。
- 实现检查：`node --test tests/backend/*.test.mjs` 28 项通过；`npx tsc --noEmit` 通过；`npm run build` 成功。修复记录为 `ISSUE-0012`，源码指纹为 epoch7 `99283f2bbb33a7cb7fed3830d549e001069308b88a7b742fd0538aa6e0f5e5fe`。这些结果不等同产品 UI/运行时验收；`R11-TEXT-CREATE-01` 与 R11 均待有效运行时复验。
- 验收 run `acceptance-runs/20261021-resume-02` 最新报告（2026-10-21 11:59:18 UTC）为 coordinator 当前构建复验通过 8/62 子案例、0/111 规则、0/10 跨功能流程，全量仍未通过。`P03-DB-PERSISTENCE-RESTART-E7-02` 由 tester 与 coordinator 独立复验通过，范围仅为指定 Bot/chat 本机数据库记录在同 profile 受控重启前后持久；E7-01 因登记 UUID 笔误由 coordinator 复验受阻，另案已按完整 UUID 重跑，不覆盖原始记录。
- `A01-OWNED-SERVER-LIFECYCLE-E7-01` 由 tester 与 coordinator 独立复验通过：精确停止本 run Electron 后，其项目 App Server 退出；同一 profile/hash 重启后建立新进程，记录的外部 Codex PID 保持。该项不覆盖 A01 要求的原生 Codex 任务隔离。
- `P08-GATE-E7-01` 由 tester 与 coordinator 复验通过，确认 Q31/P08 的全量交付门槛与当前报告一致；本案例不替代 111 条规则、10 条跨功能流程的逐项验收，P08 总规则仍未完成。
- P05 当前 checkout 身份/源码组织窄案例与 P06 实施授权文档窄案例，均由 tester 和 coordinator 在 epoch7 独立复验通过；P05 历史目录去向及最终界面仍未覆盖，P06 授权不代表功能验收。W01/W03/W04 文档抽查由 tester 和 coordinator 复验通过，W02 因缺少原始子 Agent 调用/返回 artifact 和 F01 运行证据受阻。
- UI 验收仍受 CUA 无可操作窗口/AX 状态限制：2026-10-21 11:54–11:57 UTC 对新 epoch7 实例再取新鲜状态仍无窗口/AX/tab，`getApp("Electron")` 超时 120 秒，已停止 UI 操作链；见 [CUA 状态证据](../acceptance-runs/20261021-resume-02/evidence/CUA-EPOCH7-INSTANCE-60021-ATTACH-TIMEOUT.md)。最新验收结果及未关闭缺口见[当前验收任务](active-acceptance-run.md)与[当前报告](../acceptance-runs/20261021-resume-02/REPORT.md)。

2026-10-20 用户授权开始。全量范围沿产品决策与验收矩阵，以下批次仅是实施顺序。

## 第一批：工程、原版依据、真实文字聊天基础

- [已写入并完成构建] Electron / React / TypeScript 工程、隔离的 preload 接口、本机 SQLite。
- [首批依据已提取] Luna / max 提取 Grok 0.72.0 主界面、主题、头像和创建弹窗依据；完整像素和交互对照尚未完成，见 UI 基准。
- [代码已接入／启动已观察] 独立 App Server 包准备、stdio 初始化、账号/模型查询接口；设置页实际显示 0.163.0 已连接，并识别既有 ChatGPT 登录状态。
- [代码已接入／推理未验证] Bot / 聊天本机持久化、消息流、停止、引导、结果未知防重与本机消息搜索。未发送真实推理任务，不声称文字聊天验收通过。
- [首屏已显示／流程待验收] Bot 侧栏、创建入口与头像形状/颜色选择器（原版当前创建入口为 13 形状、11 色；26 几何模板仅供旧值解析；默认值按 UUID 派生）、普通聊天、Bot 资料/权限和账号设置。
- [已做源码审查并修补] 默认资源禁用覆盖、子进程退出等待、消息事务、迟到响应和消息加载竞态。修补未替代运行验收，见 foundation-review.md。

## 本轮实际执行

- `npm install`；固定 Electron **42.11.15**（使用本机缓存且校验匹配包内官方 SHA-256 清单），React **19.3.1**、electron-vite **6.0.0**，精确解析版本见 package-lock.json。
- `npm run runtime:prepare`：按需准备下载回退使用的独立 App Server **0.164.0**，归档 SHA-256 匹配后解包到开发缓存；未复制用户认证文件。常规启动先使用本机独立运行时或已有缓存，不再要求先执行此命令。
- `codex-app-server --help`：实际确认 `--session-source` 参数。
- `npm run build` 和 `npm run package:mac`：成功生成未签名 `dist/mac-arm64/Rambo.app`；运行时二进制存在于包内。`du -sh` 观察约 **569M**，不是压缩下载大小。
- `npx tsc --noEmit`：最终通过；收敛头像选项到 13 项后发现的类型索引错误已修复。
- `npm run dev`：开发窗口实际打开；CUA 观察到设置页的 Codex 连接和既有账号状态，未将邮箱地址或凭据写入本记录。终端环境不兼容的 NODE_OPTIONS 仅在桌面启动脚本的子进程环境中清除，不改全局配置。
- 指定品牌原图经等比尺寸转换生成 app.icns，没有重绘或裁剪。原图继续保留。
- 以 CUA 只读对照 Grok 主窗口并打开/退出创建弹窗，没有创建原版 Bot、发送消息、修改连接或复制用户聊天。截图未持久化，因为包含用户已有内容。

未执行自动化测试套件、真实文字推理、Voice、麦克风、Computer Use、邮件发送或打包 App 的独立运行验收。开发窗口启动不等于打包版本已通过验收。

## 后续完整范围

群聊/协作、计划/Webhook/恢复、MCP/Skills/邮箱、文件/图像、Voice/唤醒/设备、Computer Use 争用协调、备份与升级均继续按矩阵推进。未接通能力不使用模拟回复充当完成。

当前未执行产品验收；构建与运行状态另按实际操作更新。

## 2026-10-21：验收 Skill 与首次执行

- 用户要求写完 Skill 后直接启动测试、独立修复和主 Agent 复验，已作为持续目标执行，不等待用户休息后的回复。
- 项目 Skill：`.agents/skills/rambo-acceptance/SKILL.md`，附运行手册、案例/证据约定、独立启动器、台账及单元测试。Skill 结构校验通过；台账 12 项单测通过。独立前向演练发现证据删除/改写仍误报通过的问题，由另一 Agent 修复后，原测试者独立复测通过。
- 正式 run：`acceptance-runs/20261021-full-01`；冻结 111 条规则、10 条 E 流程与 epoch0 构建。12 个首批 UI/集成子案例经主 Agent 审查登记；测试者分别记录受阻，未把包存在/进程存在当作功能通过。
- ISSUE-0001：打包版运行时重载 ICNS 导致启动初始化异常，进程存在但 Store/renderer 未建立。由 foundation_review（Luna/max）修复；正在重新打包，需主 Agent 登记新 epoch、由 rambo_acceptance_tester 复测，再由主 Agent复验。当前不能报此问题已验收关闭。
- Computer Use 操作权在测试 Agent；修复 Agent 只处理本轮测试进程和已分配源码。全量案例提案另由 acceptance_forward_check 编写，尚未作为已执行结果。

最新状态以 run 的 `REPORT.md`、`cases.json`、`issues.json` 和审计记录为准。规划、脚本测试和部分功能修复不代表产品全量验收通过。

### 2026-10-21：续验 epoch 2

- `acceptance-runs/20261021-resume-02` 的 epoch 2 打包并启动成功，使用独立 profile；`app.asar` SHA-256 为 `c2fed8597cbbe8d8a329fc0fc85352c2d7dfb107e5727c0c53753306b2ede44c`。
- 头像 SVG 颜色引用修复已进入包；当前运行窗口中 Bot A/B 图标显示蓝色/紫色。创建表单预览因 ISSUE-0001 的 AX 与像素不一致尚未复验。
- 主 Agent 在 epoch 2 复验 `P02-02` 导航子项和 `P06-DOC-01` 文档子项通过。全量报告仍为否；仅 2/18 个子案例由主 Agent 复验通过，规则拆解和其余功能继续保留。
- T06 的 epoch 1 权限差异尚未定位为“应用全部”实现缺陷；独立 profile 数据显示其中一条聊天晚于另一条更新，正在按明确聊天 ID 重跑权限覆盖与应用全部。


### 2026-10-21 续验更新（覆盖上文早期状态）

- epoch1 已实际启动并完成首批真实文字请求，指定头像可见；已有 13 个登记案例，tester 的 10 个 pass 尚不等于主 Agent 验收通过。
- 主 Agent 本次用 Computer Use 独立确认 T06-01 仍失败并写入台账；没有聊天权限显示/切换控件。导航按钮位置仍与原版不同。
- 三个 Luna/max 子 Agent 均因额度限制中断。后端修改只部分落盘，类型检查有两处错误，接口/界面接线未完成；没有把半成品打包覆盖现有可运行 epoch1。
- Skill 台账 12 项单测本次再次通过。全量功能未通过，持续目标当前为 usageLimited；具体续作入口见 [当前验收任务](active-acceptance-run.md)。


### 2026-10-21：epoch 2 续验与缺口确认

- `acceptance-runs/20261021-resume-02` 已登记 coordinator 对 G01 群聊入口、R11 任务入口、V06 唤醒/监听入口、F03 Bot 文件入口的独立复验：四项在 epoch2 UI 均不可见。各自仅能判定入口子案例失败，完整决策范围仍未覆盖。
- 创建 Bot 表单的 epoch2 AX/像素不一致经主 Agent直接点击及 `Rambo → 显示 Rambo` 再观察未重现；选云朵/蓝色后预览可见蓝色。因 Bot A/B 已占用本轮规定样本，未新建 Bot C，完整创建与颜色持久化路径仍待另一干净 profile 复验。
- T06 本轮单聊天覆盖与应用全部后的 UI/数据库状态一致；旧差异未重现。文件系统实际允许/拒绝行为未测，不能据此通过权限全案。
- B06 当前 Bot 默认与聊天继承标签一致显示 GPT-5.6-Luna；服务端实际模型及线程/轮次归属未取证，仍受阻。
- 群聊缺口已按已确认的 G01/Q39 用户范围交 fixer 实现首个可用 vertical slice；构建和独立复测待后续。全量验收范围保持 111 条规则与 10 条 E 流程。


- 更新：`B04-AVATAR-01` 在 epoch2 经独立 tester 和主 Agent 分别通过。两组形状/颜色预览与 AX 一致，现有 Bot A/B 图标按蓝/紫保存值呈现；取消后只读数据库确认无额外 Bot。该结果不验证新创建 Bot 的颜色持久化，`ISSUE-0002` 不关闭。完整 `B04-01` 仍受阻，创建表单错位问题 `ISSUE-0001` 的原生 Show Rambo 复现此次未复现。

### 2026-10-21：epoch 6 续验

- 当前 run `acceptance-runs/20261021-resume-02` 使用 dev epoch 6，源码 hash `031afab9270f6142cfbed8a2cf75169598c23197ecc3399f7ecac5ed63302255`。产品决策与验收矩阵基线未变；本轮没有修改产品代码或登记新构建。
- 当前报告为 9/52 个子案例经 coordinator 复验通过，规则 4/111、跨功能流程 0/10；全量验收未通过。W01/W03/W04 文档抽查通过；W02 因缺少原始子 Agent 回传 artifact 和 F01 运行证据受阻。详见 [当前验收报告](../acceptance-runs/20261021-resume-02/REPORT.md)。
- A01 两条进程生命周期子案例由 tester 和 coordinator 独立通过：Rambo 关闭/重启时只结束本 run 的 Electron 和其项目 App Server；9 个外部 Codex daemon/App Server/CLI PID 在停止及重启后保持。没有运行或比较原生 Codex 任务，故 A01 仍未完成。
- G01 消息入口复测受 CUA 工具阻塞：10:50–10:52 UTC 在新实例 Electron `8841` 上取得新鲜 state 后，`getApp("Electron")` 再次等待 120 秒超时，未取得 AX/截图。按验收流程停止该 UI 链；没有创建群聊、消息或 turn，也没有改动产品数据。后续仍有不依赖桌面的验收工作。

### 2026-10-24：F05 聊天文件展示与本机打开

- 补齐消息附件的授权流式读取、PDF/文本/Markdown/CSV 预览、音视频播放器、文件保存、本机默认应用打开与 Finder 定位；大文件媒体支持 Range 请求，拒绝工作区外的任意路径。
- `tests/backend/host.test.mjs` 54 项通过；隔离 Electron 用例 `F05-ELECTRON-01` 实测 PNG、PDF、TXT、Markdown、CSV、超过 2 MiB 文本的预览边界、9 MiB PCM WAV 的 Range 读取与实际播放、H.264 MP4 实际播放、无效视频解码提示、保存副本字节一致、RTF → TextEdit 与 Finder 定位。新增 `F05-HOST-01` 验证完成态生图通知只把图片挂到同一轮助手回复，并通过 Host 读取授权。
- 当前设备未安装 Word、Excel、PowerPoint；Office 文件卡片和路径授权已验，Office 应用本身的关联打开需在安装对应应用的设备复验。扩展名、文本 2 MiB 预览限制与编解码边界见 [文件预览兼容范围](file-preview-compatibility.md)。
- `npm run verify:feature -- --rules F05`、`npm run test:catalog` 与 `npm run test:acceptance` 通过；F05 门禁运行 `F05-HOST-01` 和 `F05-ELECTRON-01`，目录覆盖 125 条规则。当前全项目 `npm run typecheck` 被 `src/renderer/App.tsx` 两处对 `RamboAPI.applyBotPermissionToChats`、`RamboAPI.updateChat` 的引用阻塞；这两项声明/桥接不属于 F05。当前机器未安装 Office 应用，故其真实关联打开仍受环境限制。
- P03 的只读数据库持久性窄案例由 tester 与 coordinator 独立通过：本 run 中预登记 Bot 和空白 chat 在同 epoch6 profile 重启前后保持相同 ID、归属、标题、状态、消息数及 Bot/Chat 总数。此项不证明 UI、任务、设置、记忆或登录条件。

### 2026-10-24：系统设置与 Bot 设置调整

- 按 Q92/Q94 将应用全局模型和全部定时任务集中到系统设置；连接应用保留为侧栏独立入口。Bot 设置取消各 Tab 的手动保存按钮，普通设置改动自动保存，并保留 Bot 默认模型、私聊覆盖和权限的职责范围。
- 调整 Bot 设置的布局、Tab、权限卡片、长期记忆和任务/列表样式；补齐自动保存状态及窄屏布局。决策记录、验收矩阵、规则计划和测试目录已同步，S02 全量验收仍待完成。
- `node scripts/change-checks.mjs` 映射了类型检查、验收目录/结构、Host 与其他后端目标、Electron 构建，以及 avatar-picker、private-chat、group-chat E2E。按本轮范围运行验收/Host 检查、系统设置相关 private-chat 用例和群聊导航回归；avatar-picker、与页面无关的后端目标及打包运行时检查未命中本轮功能，未执行。
- 验证通过：`npm run test:catalog:sync`、`npm run test:plan`（124 条规则/完整场景）、`npm run test:catalog`（194 个案例，92 个已实现）、`npm run test:acceptance`（16/16）、`npm run typecheck`、`node --test tests/backend/host.test.mjs`（53/53）、`npm run build`、`npx playwright test tests/e2e/private-chat.spec.mjs --grep '系统设置|连接应用市场|一次性 Routine|停止本次并暂停|模型与默认权限|自管理写入'`（7/7）、`npx playwright test tests/e2e/group-chat.spec.mjs`（3/3）及 `git diff --check`。
- 定向 Electron 用例覆盖独立连接入口、全局模型和 Bot 设置自动保存、Bot 设置无任务 Tab、系统设置任务分组与现有连接授权页入口；浅色/暗色、键盘焦点、窄屏完整视觉检查、真实授权及运行时模型路由仍未由本轮用例证明。

### 2026-10-25：Q109 顶部语音胶囊与转写气泡增长

- 语音状态已从聊天底部运行行迁移到聊天顶部的当前 Bot 头像与名称胶囊，底部 `AgentRunningRow` 只表达普通文字任务。拨号时名称退出布局、胶囊收为水平居中的 44px 圆球并显示头像主色双层环形加载与轨道圆点；接通后头像位于展开胶囊左侧，右侧显示 13 根等宽、细高、宽幅排列的实时音柱，优先跟随真实输入频率。未说话时音柱完全等高、短而静止，不呼吸；说话后以中间为锚点向两侧交错读取语音频段，低频能量先抬高中心，再保留左右自然错落，动态快起慢落且不叠加 CSS 过渡，停顿约 `100ms` 后明显回落。结束中音柱变灰静止，成功后收回名称胶囊，失败保留可见错误。
- 音柱映射最初按原始低频到高频从左到右铺开，正常语音的低频能量导致左侧整排先升高；单纯翻转方向只会变成右侧先升高。当前改为 `[11, 9, 7, 5, 3, 1, 0, 2, 4, 6, 8, 10, 12]` 的中心锚点频段顺序，并将低频峰值向中心塑形；左右仍读取各自频段，不恢复镜像同步。纯状态测试新增低频人声先抬高中心、静音完全等高、左右非对称和快速回落场景。
- 静音误判修复：麦克风分析链路加入 75Hz 高通，频谱映射扣除全频段噪声底，状态模型按整段频谱平均能量而不是单个低频峰值判断说话，避免底噪集中在左侧时显示一串高音柱。纯状态测试新增左侧低频底噪场景。
- 修复回收路径的尺寸抖动：语音态中名称不再参与宽度计算，胶囊按钮自身保留尺寸过渡；真实采样从 `164px` 连续增长到名称态宽度，不再出现先缩窄再回弹。音柱改为 `space-between`，13 根等宽柱在实际胶囊宽度内横向铺开；柱体使用无渐变、无阴影、无模糊滤镜的实色圆角矩形，避免光晕感；删除单独加粗的第 7 根。
- Live 转写气泡在正文末尾使用 `1.5px × 1em` 的清晰普通光标，按 `em` 跟随实际字号，不再固定为 22px 行高；通过基线偏移让光标上下边界落在当前正文行内并与该行文字垂直居中，同时移除渐变、柔光、阴影和毛玻璃边缘。新增片段保留到该条转写完成，侧栏最新一句同步更新。
- 转写气泡宽度改为 `fit-content`：空态是贴近光标的窄气泡，随正文固有宽度增长，达到 `min(82%, 670px)` 后才换行增高。取消上一版为防回缩而锁定的固定长条宽度，也仍不做宽度过渡，避免每次增量触发横向缓动；新增片段只淡入、不改变排版宽度，换行后正文与气泡高度完整同步。
- Live 接通后，挂断叉放在胶囊右侧的独立圆球中，与胶囊间距 `8px`，尺寸对齐接通态胶囊内头像 `38px`，不再叠加在胶囊内部。
- 真实 Electron 定向用例覆盖连接圆球、居中位置、展开尺寸插值、13 根音柱横向跨度与左右镜像、头像主色、结束灰态、成功单调收回、挂断圆球与头像同尺寸、`1em` 普通光标的高度与上下边界、光标和正文中心线偏差不超过 1px、空态窄气泡、正文增量增宽、换行不裁字、片段动画、侧栏同步和 reduced-motion；浅色连接/接通/结束/回收截图已人工复核。本轮 `npm run build`、两条定向 private-chat 用例及状态模型测试通过。
- 边界：普通文字任务运行行仍位于 `.transcript-scroll` 外的悬浮 dock；本轮语音视觉使用验收事件和真实 renderer 渲染，不等同真实麦克风频率、真实 Live 音频闭环、真实语义挂断或完整 B11/V07 验收。外部窗口清理现为 best-effort，避免 macOS System Events 异常掩盖产品测试结果。
- 2026-10-25 继续修复真实麦克风音柱观感：放弃继续仿写 Hark 阈值，改为实际接入 `hark@1.2.3`（MIT）的 VAD 状态机，并使用 LiveKit `useMultibandTrackVolume` 的 Apache-2.0 dB 分析思路（`getFloatFrequencyData`、`[-100,-10]dB` 截断、`sqrt` 归一化、等宽频段平均）。Hark 使用 `fftSize=512`、`smoothingTimeConstant=0.1`、跳过最低 4 个频点、`-50dB` 阈值和 4 帧历史；它只负责起说/停说，视觉层不再自行判定或保留静音状态。视觉 analyser 继续以 `fftSize=2048` 分析约 `90–4000Hz`，Hark 未报告说话时所有柱强制回到等高短基线，报告说话后才显示真实频段。`voice-waveform-model` 的 8 个纯状态测试覆盖 dB 归一化、频段聚合、采样率/FFT 频段范围、中心锚定、底噪静默、左右独立落差和 Hark 释放后的回落；真实浏览器 Web Audio 用例新增上游 Hark 包的 50Hz 低频轰鸣、880Hz 起说与停说测试，3 次重复 6/6 通过。当前只证明合成振荡器与 Hark 浏览器链路，真实耳机麦克风、Live 音频闭环和听感仍未验收。
- 真实麦克风音柱第二轮修正：用户反馈说话时仍从左侧整排升高、静音回落不够丝滑、中柱偏粗。视觉频段改为 1.3 次幂的非等宽划分，给语音基频更多分辨率；`centerVoiceFrequencyBands` 先以中心频段作为能量锚点，再把左右各自独立频段作为纹理叠加径向权重，彻底去掉低频向右铺开的扫光效果。显示层继续使用双层非对称惯性（包络快起慢落、柱体再慢一档），新输入不会瞬时跳变，Hark 静音后连续、单调回落到等高短基线；中柱与其他柱共用同一 `2px` 宽度。
- 最新验证：`voice-waveform-model` 纯状态测试 11/11；真实 Web Audio 用例把停说观察窗与 `500ms` 回落判定拆开，连续 5 轮共 10/10 通过；真实 Electron 顶部语音胶囊定向用例通过；`npm run typecheck` 与 `npm run build` 通过。上述证据覆盖合成频谱与渲染状态，真实耳机麦克风的响度、底噪和主观平滑度仍须用户实机复验，不能写成 V07 或完整 B11 已通过。
- 语义挂断兜底：保留 Live 将 handoff 交给普通 Codex 的主路径，同时由 Host 对 `thread/realtime/itemAdded` 的 `handoff_request` 做独立语义控制判定。判定使用临时、`read-only`、`approvalPolicy=never`、无 dynamic tools、关闭 MCP/Skills/Apps/Plugins 的低推理回合，只返回 `end_current_voice | continue_voice` 与置信度；只有明确结束且高置信度才调用幂等的 `thread/realtime/stop`，不按固定关键词匹配。判定期间新 handoff 以最新话语覆盖待判内容；判定失败或超时只放弃兜底，不把可见 Live 置为结束中；内部判定回合的通知不写入聊天。手动挂断与判定结果竞态只产生一次 stop 和一次终态事件。Host 全套 70/70 通过，新增覆盖明确结束、讨论如何结束、低置信度、最新 handoff 覆盖、分类失败后恢复、内部通知隔离及手动/分类竞态。
- 真实 0.163 App Server 协议探测通过：`ephemeral + read-only + approvalPolicy=never + 关闭能力 config` 的 `thread/start` 返回临时 thread，未因字段组合被拒；ephemeral thread 不能被持久化 `thread/delete`，生产清理因此保持 best-effort。本次真实 Live 仍待复验：说“结束、挂断”应快速关闭；说“这个语音功能怎么结束？”不应关闭；助手问“现在挂断吗”后答“是”应关闭；说“结束这个提醒任务”不应关闭 Live。另已确认历史卡住样本 `14e755f1-ca3a-4ec0-98da-0f62796cccc6` 的普通 Codex 首 token 延迟约 644 秒，用户手动关闭后工具才执行；这解释了旧链路长时间“正在思考/正在结束”，但不替代新兜底的实机验收。
- 真实会话 `5340e353-5aee-4c65-8365-92e04c741652` 暴露了语义兜底的触发缺口：14:41:22 已完整识别“好，你可以结束了”，14:41:25 Live 口头回复“好的，这就结束语音”，但没有产生 handoff、普通 Codex 回合或结束工具调用；第二句 14:41:36 才 handoff，14:41:50 实际挂断。根因是兜底原来只监听 `handoff_request`，Live 模型忘记委派时完全没有独立判定机会。现改为用户 Realtime transcript item 完成时也触发隔离语义判定，同时保留 handoff 入口；同一转写 item 或相同最新话语按 `checkedIntentHandoffs` 去重，避免实时转写和 handoff 双触发。Host 新增“无 handoff 直接挂断”“转写/handoff 同句只判定一次”“旧转写不压制新 handoff”回归，并在测试目录登记 `V07-HOST-05`。最终 Host 74/74、`npm run typecheck`、`git diff --check` 和顶部语音胶囊定向 Electron 1/1 通过。真实 Live 音频、麦克风关闭和监听恢复仍需按 V07 实机复验。
- 语音 delegation 与错误态收尾：核对 `5340e353-5aee-4c65-8365-92e04c741652` 的真实记录，提醒和结束语音都只有 `<realtime_delegation><input>…</input><transcript_delta>…</transcript_delta></realtime_delegation>`，没有结构化工具名或参数；普通 Codex 在同一 thread 的后继 turn 中调用 `rambo_routines.create_routine` 和 `rambo_voice.end_current_voice_session`。V3 Realtime 启动参数没有 `tools`/`dynamicTools`，因此当前不能由 Live 直接调用动态工具；已加强 `VOICE_START_INSTRUCTIONS`/`VOICE_PROMPT`，要求结束委派明确点名 `rambo_voice.end_current_voice_session` 并传入空对象，Host 的转写完成和 handoff 语义兜底继续保留。
- 按用户截图优化语音错误胶囊：连接异常与结束失败都显示完整标题、短原因及胶囊外独立 `34px` 圆形“重新拨号”按钮；错误胶囊不再被外层 `320px` 上限和 `overflow:hidden` 裁成半句。Realtime/媒体协商失败现在也会进入该错误胶囊，而不是只显示通用错误通知；成功结束仍清理错误态。定向 Electron 用例同时覆盖“语音结束失败：服务暂不可用”和“语音连接异常：语音连接已关闭：transport_closed”，检查标题/原因不裁切、重试按钮尺寸、位置和视口内可见；头像颜色断言改为直接比较实际解析值，消除随机头像色造成的用例抖动。本轮 `npm run build` 通过，包含错误胶囊检查的宽幅实时频谱定向用例 5/5 通过；Host 全套 74/74 通过；验收目录同步后 `test:catalog` 与 `test:acceptance` 通过。真实 Live 音频首次结束语音是否不再漏 delegation、真实麦克风与监听恢复仍未复验，不能据此宣称 V07 或完整发布已通过。
- Q143 用户实测发现自然说“结束”时 Live 仍只口头回应，而明确说“调用工具结束”才触发流程。本轮扩展 `VOICE_START_INSTRUCTIONS` 与 `VOICE_PROMPT`：示例包含“结束通话”“你可以结束了”“退下吧”，要求不等用户提到工具、先委派当前 thread 并点名 `rambo_voice.end_current_voice_session` 与 `{}`；隔离 Host 意图判定提示同步扩展口语、委婉说法且继续按语义而非关键词判断。更新 V07 决策、验收矩阵和规则计划。Host 87/87、`npm run typecheck`、`npm run build`、`npm run test:catalog`（224 案例）、`npm run test:acceptance`（16/16）和 `git diff --check` 通过。回归仅证明启动参数注入和模拟 Host 判定；新提示只对下一次启动的 Live 生效，真实 Live 音频是否首次可靠挂断仍需复验。
- Q143 真实 Live 复验：会话 `a822d180-ddf8-4bbd-be5c-c942a26e0c1b` 已在启动时加载更新后的结束提示。同一 thread 更早的一次 `rambo_voice.end_current_voice_session({})` 正常回复；之后用户分别说“呃。退出语音吧”“好，OK。那你退下吧”，两回都成功调用结束工具、Realtime 进入 `ended`，但同一 turn 的后续回复均收到 `unsupported_persisted_item_context` / `previous_response_id` / HTTP 400，原始错误 JSON 被 Host 发给 UI。两次失败 rollout 均为 `cli_version=0.163.0`。当前源码默认目标是 `0.164.0`，但本地运行目录当时只有 `0.163.0`，所以新提示生效并不代表新 App Server 已运行。准确原因仍无法从报错区分 hosted-tool、compaction 或隐藏 reasoning 状态；0.164 发布说明也没有列出这条明确修复。需让应用实际运行 0.164 后再做真实 Live 复验；若仍失败，需要 App Server/Responses 续接层修复。V07 仍是部分证据。

## 2026-10-26：Q155 Gmail 新连接改用应用专用密码

- Gmail 新连接改为填写邮箱地址和 Google App Password，经 `imap.gmail.com:993` 与 `smtp.gmail.com:465` 验证；不再展示 OAuth Client ID/Secret，也不启动 Google OAuth。App Password 经 IMAP/SMTP 适配器提供搜索、读取、附件、草稿、回复和发送映射。QQ 与 Gmail 共用协议适配核心，分别保留各自服务器、邮箱和 ID 前缀。已有 OAuth-token Gmail 连接仍由旧 Adapter 兼容读取。
- 连接说明写明两步验证要求、账号限制、密码可重复使用至撤销、不是一次性验证码，以及 Google 对这种较不安全兼容方式的提示。Bot 凭证工具接受 Gmail App Password；成功保存会在当前 Bot 唯一私聊产生不含凭证的系统提醒。
- 决策、研究、验收矩阵、规则计划和目录已同步 Q155/T20 与 M09；Catalog 最新校验为 **144 条规则、229 个案例、112 个已实现局部案例、117 个缺口案例、50 条已有局部证据的规则**。`node scripts/change-checks.mjs` 命中构建、连接器、Host/Store/Runtime、跨进程契约、renderer 和验收模块；`.env.example` 与临时目录未匹配并保持原样。
- 检查通过：`npm run typecheck`；完整后端串行 **305/305**；`npm run test:catalog`；`npm run test:acceptance` **16/16**；`npm run build`；`git diff --check`。相关 Electron 联合回归 **31 通过、1 跳过**，覆盖 Gmail App Password 表单、群聊、多时刻/集中重启、后台运行和 Codex 运行时重启。完整后端默认并发运行时曾出现 Host 文件测试结束后的 SQLite 异步活动，单文件和串行完整回归均通过，测试收尾隔离风险仍保留。
- 证据边界：本地 Adapter 与 Electron 用例没有连接真实 Google 账号；真实 App Password 生成、Gmail 账号策略、完整邮件操作和撤销恢复仍待真实账号验收。相关 Electron 联合回归通过不等于全部 E2E、真实模型或 P08 全量验收通过。

## 2026-10-26：系统设置显示 Rambo 应用版本

- 系统设置标题栏新增当前安装包版本标签，通过 Electron `app.getVersion()` 读取；与“Codex 运行时”卡片中的运行时版本明确分开。
- 用户明确要求本轮按简单改动发布、不运行测试。仅完成构建、本机安装、签名与发布核验；该小改动不改变 P08 全量验收边界。
