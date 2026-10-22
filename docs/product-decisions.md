# Rambo 产品决策记录

初次整理：2026-10-19。最近更新：2026-10-22。当前阶段：用户于 2026-10-20 明确“开始吧”，已进入应用实现；历史阶段说明保留原讨论语境，现阶段以 P06 最新记录为准。

本文从本次会话原始记录逐条整理，作为后续讨论、设计、实现和审查的依据。覆盖 2026-10-18 开始的整段讨论，以及后续补充和修正。编号规则与工作约定持续更新；尚未定案和技术验证另列。已确认代表产品选择得到用户接受，不代表功能已实现或技术链路已验证。

## 阅读和维护

- 决定按下文稳定编号记录；后续讨论引用编号，避免重新询问已决定的问题。
- 全部已确认规则的验收操作与通过条件见 [全量验收矩阵](acceptance-matrix.md)，当前仅建立标准，尚未执行产品验收。
- 历史依据链接到 [完整问答摘录](conversation-evidence.md)，M 编号对应原始记录的 ordinal；摘录同时保留源文件行号和时间。归档后的新问题和确认回复保存在 [决策补充问答](decision-followups.md)。
- 用户后来的明确选择优先于早先建议；只补充细节的回复不自动撤销原有条件。
- 助手的建议、参考产品的行为、静态包里找到的功能，不自动成为本产品需求。
- 新增或变更决定时，在当轮更新对应条目及问答依据。无法找到确认回复的内容，放入“尚未定案”，不替用户作追认。

## 1. 产品范围与项目状态

| 编号 | 已确认规则 | 问答依据 |
| --- | --- | --- |
| P01 | 先做给用户自己使用的独立 macOS 应用。 | [M42](conversation-evidence.md#m-42) |
| P02 | 界面必须完全复刻当前 Grok Bot：在既定功能范围内，以反编译得到的页面、组件、样式、资源及交互证据为依据，沿用已有功能的原版设计；Grok Bot 没有而本产品已确认需要的功能，按原有 UI 风格和组件规则扩展。布局、字体、颜色、间距、尺寸及交互状态均纳入逐项对照验收；最新正式应用及项目名称为“Rambo”，应用 Logo 使用用户最新提供的《霓虹落日下的战士凝视》黑发红头带战士侧脸图片，原图已收录为 [项目素材](../assets/branding/app-logo-source.png)。唤醒称呼也为 Rambo，按 V12；原 cobo 名称与 c 字母机器人图标提案已被新决定替换。群聊与单聊的统一样式及组合头像按 Q57/G01 执行。具体页面视觉与最终 macOS 图标呈现仍需验收。 | [Q57 群聊 UI](decision-followups.md#q57)、[M87](conversation-evidence.md#m-87)、[M1427](conversation-evidence.md#m-1427)、[Q37 用户图片及 Rambo 命名](decision-followups.md#q37-rambo)、[最新换图](decision-followups.md#q37-logo-v2)、[界面完全复刻要求](decision-followups.md#p02-ui-fidelity) |
| P03 | 会话、任务、设置和记忆保存在本机，首版不做跨设备同步；应用自身没有注册账号体系。外部服务采用各自授权。 | [M114](conversation-evidence.md#m-114) |
| P04 | Agent 和自动任务在本机执行，省略云电脑和多人团队工作区。之后确认保留的是本机多 Bot 群聊，群聊与团队空间不是同一功能。 | [M155](conversation-evidence.md#m-155)、[M2506](conversation-evidence.md#m-2506) → [M2513](conversation-evidence.md#m-2513)、[M2548](conversation-evidence.md#m-2548) → [M2555](conversation-evidence.md#m-2555)、[Q39](decision-followups.md#q39) |
| P05 | 旧的深色工作台原型不符合目标，用户要求删除旧实现、用干净的新项目重新设计。历史记录称旧目录已移入废纸篓、研究报告移出保存；此处记录工作经过，不将旧原型功能算作当前实现。 | [M1427](conversation-evidence.md#m-1427)、[M1444](conversation-evidence.md#m-1444)、[M1523](conversation-evidence.md#m-1523) |
| P06 | 先讨论后实现；用户于 2026-10-20 明确“开始吧”，授权开始应用开发。既定决策和全量验收范围继续有效，不把开始开发视为功能已通过验收。 | [M1613](conversation-evidence.md#m-1613)、[M1619](conversation-evidence.md#m-1619)、[实施授权](decision-followups.md#implementation-start) |
| P07 | 核心用途是生活、工作中的个人小助手，语音入口是核心体验；用户随后选择先做本机关键词唤醒。不能用助手提出的浏览器报告案例替代这个目标。手机远程呼叫暂不纳入本轮范围，不撤销已有应用内 Live 设计。 | [Q10 用户补充目标](decision-followups.md#q10)、[Q11 用户选择](decision-followups.md#q11) |
| P08 | 全部已确认功能都必须有可执行的验收标准并逐项验收通过，才算完整交付；单个语音/天气或其他局部流程通过不能替代全量功能验收。明确不做与暂缓项沿原决定，未验证的底层能力保持为验收阻塞，不默认缩减已确认范围。当前按 P06 进入分批实现，进度与验收分开记录。 | [Q31 用户全量验收要求](decision-followups.md#q31)、[全量验收矩阵](acceptance-matrix.md) |

## 2. Bot、聊天和资料

| 编号 | 已确认规则 | 问答依据 |
| --- | --- | --- |
| B01 | Bot 是长期存在的主对象；聊天、任务与运行记录归属 Bot。Codex thread 是底层执行状态，不能把全局 Codex 会话列表做成产品主体。 | [M607](conversation-evidence.md#m-607)、[M652](conversation-evidence.md#m-652) → [M686](conversation-evidence.md#m-686)、[M697](conversation-evidence.md#m-697) |
| B02 | 每个 Bot 只有一个持续的私聊及对应 thread，文字和 Live 一直沿用它，不提供新建私聊。定时和异步任务各自独立运行，并携带对应 Bot 的配置和已保存记忆；群聊上下文仍按 G01 独立。 | [Q58 单 Bot 单聊](decision-followups.md#q58)、[M652](conversation-evidence.md#m-652) → [M686](conversation-evidence.md#m-686)、[M697](conversation-evidence.md#m-697) |
| B03 | 每个 Bot 的长期记忆和技能配置用于其唯一私聊及独立任务上下文；不为同一 Bot 再开多条私聊，也不把历史遗留线程全文注入当前 thread。附件按 F01 归属。 | [Q58 单 Bot 单聊](decision-followups.md#q58)、[M1683](conversation-evidence.md#m-1683) → [M1709](conversation-evidence.md#m-1709)、[M2506](conversation-evidence.md#m-2506) → [M2513](conversation-evidence.md#m-2513)、[M5273](conversation-evidence.md#m-5273) → [M5281](conversation-evidence.md#m-5281) |
| B04 | 新建流程贴近 Grok：以名称、预置头像为核心；创建后直接进入空白聊天，不加欢迎卡、示例任务或设置向导。 | [M2332](conversation-evidence.md#m-2332)、[M2352](conversation-evidence.md#m-2352) → [M2359](conversation-evidence.md#m-2359)、[M2368](conversation-evidence.md#m-2368)、[M4904](conversation-evidence.md#m-4904) → [M4914](conversation-evidence.md#m-4914) |
| B05 | Bot 资料页可编辑短职责和长期指令；当前 Bot 也可在自身私聊中通过应用 Tools 自主新增、修改或删除自己的长期职责与指令，不另设用户逐次批准。职责/行为规则与记忆中的事实、偏好分开管理。 | [Q64 Bot 自管理](decision-followups.md#q64)、[M5141](conversation-evidence.md#m-5141) → [M5148](conversation-evidence.md#m-5148)；原“先批准再保存”为历史规则 |
| B06 | 每个 Bot 保存默认模型，未设置时继承本机 Codex/全局默认模型；当前聊天可临时覆盖。修改默认模型只影响后续轮次，正在执行的轮次使用原模型跑完。 | [M5030](conversation-evidence.md#m-5030) → [M5038](conversation-evidence.md#m-5038)、[M7629](conversation-evidence.md#m-7629) → [M7636](conversation-evidence.md#m-7636) |
| B07 | 侧栏中每个 Bot 本身就是唯一私聊的入口，不再显示“聊天”子项或聊天子分组；点击 Bot 直接打开这条私聊。聊天不单独改名，Bot 名称在 Bot 设置中修改；聊天内容仍可搜索。不提供私聊级新建、归档、恢复或删除。旧数据迁移时保留一个当前 thread，其他私聊记录留在本机但不在产品界面和搜索中出现。Bot 级归档/永久删除仍按 B08。 | [Q58 单 Bot 单聊及侧栏/改名补充](decision-followups.md#q58) 覆盖 [M6243](conversation-evidence.md#m-6243) → [M6256](conversation-evidence.md#m-6256) 的多线程管理决定 |
| B08 | 用户可将 Bot 归档：从主列表隐藏、保留会话与记忆，并暂停其自动例程；用户永久删除另行确认，只删除应用管理的 Bot 数据与专属工作区，不扫描清理它在其他 Mac 目录创建的文件。Bot Tools 不开放自我归档或永久删除自身/Bot，也不能通过其他自管理编辑间接完成这两项。 | [Q64 Bot 自管理边界](decision-followups.md#q64)、[M6155](conversation-evidence.md#m-6155) → [M6162](conversation-evidence.md#m-6162) |
| B09 | 同一线程运行中收到新消息时，默认按 Grok 方式转向当前任务；停止任务使用独立“停止”操作，不把普通新消息默认排到任务结束后。 | [M6369](conversation-evidence.md#m-6369) → [M6377](conversation-evidence.md#m-6377)、[M6403](conversation-evidence.md#m-6403) |
| B10 | 首版提供用户全局搜索，跨 Bot/群聊检索消息正文、任务结果摘要和附件/成果文件名；按 Bot、时间、类型筛选，点击结果定位来源聊天、任务或文件。此为用户查阅自己的记录，不自动扩展 Bot 上下文范围。文件正文全文索引、OCR 和语义检索未包含在本次确定范围。 | [Q06 及用户原话“ok”](decision-followups.md#q06) |
| B11 | 普通聊天任务默认显示简短进度，用户按需展开实际网页、命令和文件操作记录及结果；沿用既定接管/停止入口。所有 Bot 使用当前 Mac 的可见桌面，不额外设计独立机器人电脑画面。具体控件布局和日志留存仍待设计。 | [Q07 用户纠正及修订后原话“好”](decision-followups.md#q07) |
| B12 | Bot 详情页显示该 Bot 管理的定时任务及任务计划、执行内容和状态；左侧定时任务入口保留全 Bot 汇总。两处读取同一份任务数据，不据显示能力声称任务已按时执行。 | [Q60 Bot 详情任务列表](decision-followups.md#q60)、[Q61 全 Bot 任务总览](decision-followups.md#q61) |
| B13 | 当前 Bot 可通过应用提供的真实 Tools 自主管理自身：修改名称、头像、短职责、长期指令、默认模型、默认权限和自身唯一私聊的模型/权限覆盖；新增、编辑、删除 Bot 专属记忆；创建、修改、暂停、恢复、删除自己管理的 Routine。上述写入不另设用户逐次确认，但只限自身，不能操作其他 Bot、共享配置或应用级资源。禁止自我归档、永久删除自身/Bot 和清空聊天记录，也不得通过其他编辑操作间接完成。模型/权限变化只对后续轮次生效；Routine 删除按 R14 保留历史；每次写入须有真实工具结果和 UI/持久化回读。 | [Q64 Bot 自管理](decision-followups.md#q64) |

2026-10-22 用户通过 Q64 将 Bot 从“可由用户配置的对象”扩展为可通过应用 Tools 自主管理自身资料、私有记忆、运行配置和 Routine 的执行主体。应用 Tool 是能力边界：未开放的三项操作不能被自然语言或伪工具名绕过。只开放自身范围；共享“关于我”的既有自动保存继续按 Q56/M04，其他 Bot 和应用级资源不属于可写入对象。Full Access 仍不是文件系统隔离保证。

## 3. 记忆与共用个人资料

| 编号 | 已确认规则 | 问答依据 |
| --- | --- | --- |
| M01 | 每个 Bot 有跨其唯一私聊及独立任务上下文共享的长期记忆；由该 Bot 自行整理、新增和更新并自动保存，可用于后续上下文，无需用户逐项确认。 | [Q56 用户修改为自动整理保存](decision-followups.md#q56)、[Q58 单 Bot 单聊](decision-followups.md#q58)；原确认流程为历史规则 |
| M02 | Bot 自行决定哪些交流内容整理为长期记忆并直接保存；普通聊天记录与已保存长期记忆分开，不再设置用户批准候选的必经流程。 | [Q56 用户修改为自动整理保存](decision-followups.md#q56)；原确认流程为历史规则 |
| M03 | 加入本机全局“关于我”，所有 Bot 都可参考；每个 Bot 的专属记忆仍独立，不因此读取其他 Bot 的全部聊天记录。 | [M2520](conversation-evidence.md#m-2520) → [M2527](conversation-evidence.md#m-2527)、[M2534](conversation-evidence.md#m-2534) |
| M04 | 用户在设置中手动编辑“关于我”可直接保存；Bot 整理属于共享个人资料的内容时可自动新增、更新并保存，无需用户确认。仍按 M03 区分共享资料与 Bot 专属记忆。 | [Q56 用户修改为自动整理保存](decision-followups.md#q56)；原确认流程为历史规则 |
| M05 | 设置中提供记忆管理入口，查看、编辑、删除 Bot 专属记忆和共用“关于我”。当前 Bot 也可通过应用 Tools 新增、编辑、删除自己的专属记忆，按 Q64 不需要逐次确认；共享“关于我”的删除仍由用户管理。 | [Q64 Bot 自管理](decision-followups.md#q64)、[M8815](conversation-evidence.md#m-8815) → [M8823](conversation-evidence.md#m-8823)、[M8833](conversation-evidence.md#m-8833) |
| M06 | 日常交流告一段落后，由该 Bot 在后台自行整理并保存记忆，不每轮请求确认；用户当场明确要求记住某项时当场整理保存。具体后台触发参数及是否额外发起模型回合待设计，不另设固定的记忆管理 Bot。 | [Q56 用户修改为自动整理保存](decision-followups.md#q56)；原确认流程为历史规则 |
| M07 | Live 中的记忆整理与文字聊天使用相同自动保存规则，无需口头批准或点击确认；用户通过语音要求记住或修订记忆时由当前 Bot 处理并保存。真实语音与记忆工具衔接仍需验证。 | [Q56 用户修改为自动整理保存](decision-followups.md#q56)；原确认流程为历史规则 |
| M08 | 首版不做记忆变更历史、前后差异查看和撤销功能；记错时通过既定记忆管理直接修改或删除。此排除项不影响已确认的应用备份与恢复 O03。 | [Q20 用户原话“不需要这功能吧？”](decision-followups.md#q20) |

2026-10-21 用户在 Q56 明确取消记忆整理的确认环节，由各 Bot 自行整理、保存。此修改覆盖 Bot 专属记忆及共享“关于我”的写入规则；M03 的归属边界、M05 管理与 M08 不做历史/撤销继续适用。后台整理是否另开 Codex 回合、具体模型与触发参数仍待设计。Q56 当时保留的 B05 职责/长期指令审批已由 2026-10-22 的 Q64 后续修改。

## 4. 群聊、路由和 Bot 协作

| 编号 | 已确认规则 | 问答依据 |
| --- | --- | --- |
| G01 | 首版保留本机多 Bot 群聊，共享群聊上下文；新加入的 Bot 可读取加入前的该群历史，首次回复提供近期上下文，更早记录按需查找，不自动带入其他 Bot 的私聊。每个 Bot 仍有独立身份和执行会话，省略多人团队空间。群聊与单聊共用列表及界面样式，不另设群聊分组样式；群头像由多个成员机器人的头像组合呈现，具体拼合布局待实现对照。 | [Q57 群聊 UI](decision-followups.md#q57)、[M2506](conversation-evidence.md#m-2506) → [M2513](conversation-evidence.md#m-2513)、[M2548](conversation-evidence.md#m-2548) → [M2555](conversation-evidence.md#m-2555)、[Q39](decision-followups.md#q39) |
| G02 | 群聊没有固定主持或集中选人的隐藏 Codex 路由回合。未明确 @ 成员的普通消息，由各活跃 Bot 根据自己的职责和群聊上下文自行判断是否回复；允许同一消息有多个 Bot 回复，各自通过自己的会话发言。 | [Q55 最新群聊规则](decision-followups.md#q55)；替代 [M3072](conversation-evidence.md#m-3072) 的集中路由方案 |
| G03 | `@名字` 直接指定对应 Bot 处理；`@everyone` 明确让所有活跃 Bot 各自回复。普通消息按 G02 由各 Bot 自行判断，可多人回复。 | [Q55](decision-followups.md#q55)、[M2627](conversation-evidence.md#m-2627) → [M2634](conversation-evidence.md#m-2634)、[M3484](conversation-evidence.md#m-3484) → [M3491](conversation-evidence.md#m-3491) |
| G04 | 集中路由及固定默认 Bot 兜底均已取消。普通消息按 G02 由各活跃 Bot 自行判断；指定成员和 `@everyone` 按 G03。无论全员不回复、判断失败还是超时，都不得自动交给固定默认 Bot、第一个加入群的 Bot、群主 Bot或任意隐式选出的兜底 Bot。全员不发言时的提示、重试或手动指定方式仍待设计，但不能恢复默认 Bot 兜底。全局默认语音 Bot 仍按既定语音规则。 | [Q55](decision-followups.md#q55)、[Q63 用户明确取消兜底](decision-followups.md#q63)；原 [M3134](conversation-evidence.md#m-3134) 和 [Q38](decision-followups.md#q38) 为历史方案 |
| G05 | 同一应用内通过宿主协调层分派消息、任务及结果，不要求采用 A2A。以后和其他平台独立 Agent 互通时再考虑协议。 | [M2710](conversation-evidence.md#m-2710)、[M2929](conversation-evidence.md#m-2929)、[M3065](conversation-evidence.md#m-3065) → [M3072](conversation-evidence.md#m-3072) |
| G06 | 承担某项任务的 Bot 可作为该任务负责人，主动委派子任务给群内其他 Bot；结果回到发起者，由其继续处理并汇总该任务的最终回复。任务负责人按具体任务产生，不是固定群主持。 | [M3277](conversation-evidence.md#m-3277) → [M3284](conversation-evidence.md#m-3284)、[Q55](decision-followups.md#q55) |
| G07 | 群里显示简短委派进度，最终由负责人发综合回复；详细协作过程留在各 Bot 对应会话/任务记录中。 | [M3293](conversation-evidence.md#m-3293) → [M3300](conversation-evidence.md#m-3300) |
| G08 | 允许多跳委派，最多连续转派 4 次，即 A→B→C→D→E，根负责人加 4 级受派者；禁止回派委派链上的上级。超限不再向外转派，由现有 Bot 处理或说明无法完成。此为应用内 Bot 协作上限，不修改 Codex 原生子 Agent 限制。 | [M3382](conversation-evidence.md#m-3382) → [M3389](conversation-evidence.md#m-3389)、[M3394](conversation-evidence.md#m-3394)、[Q25 用户原话“好”](decision-followups.md#q25) |
| G09 | 互不依赖的子任务默认并行，负责人等待结果后汇总；有前后依赖的任务按阶段交接。 | [M3468](conversation-evidence.md#m-3468) → [M3475](conversation-evidence.md#m-3475) |
| G10 | 用户停止某个协作主任务时，停止该任务及其委派子任务：排队子任务取消/出队，执行中子任务收到停止请求，不再继续派发。其他独立任务不受影响，已完成动作不自动回滚，也不承诺所有执行瞬时终止。结束 Live 本身不视为停止任务。 | [Q26 用户原话“好”](decision-followups.md#q26) |
| G11 | 协作中的单个子任务失败不自动取消其他互不依赖的子任务；负责人 Bot 处理失败分支，并汇总完成与未完成部分。依赖失败结果的后续阶段先不启动；用户主动停止整项任务时仍按 G10。 | [Q27 用户原话“好”](decision-followups.md#q27) |

2026-10-21 用户通过 Q55 将群聊改为各 Bot 自行判断、允许多人回复，替代此前隐藏 Codex 回合集中选人；2026-10-22 又通过 Q63 明确取消任何固定默认 Bot 兜底，包括判断失败、超时和全员不回复场景。具体反馈方式尚未定案，但不得隐式选出一个 Bot。各 Bot 是否使用独立判断回合、是否在同一会话中判断并回复等实现细节尚未定案；不因“自行判断”就默认新增一套隐藏判断会话。OpenMausBot 的 1.5 秒、0.6 置信度、单次 1–4 个受派者仍只是历史参考数值；委派深度按 G08/Q25。

## 5. MCP、Skills、连接应用和权限

| 编号 | 已确认规则 | 问答依据 |
| --- | --- | --- |
| T01 | 将本机 Codex 可用的 MCP/Skills 列成共享资源目录，按 Bot 勾选可用项；资源不需要每个 Bot 重复登录、复制或另行安装。底层能否可靠按 Bot 限定需技术验证。 | [M5273](conversation-evidence.md#m-5273) → [M5281](conversation-evidence.md#m-5281) |
| T02 | 新 Bot 默认不自动获得额外 MCP、Skills 或外接应用权限，由用户按需启用。工具选择与执行权限档是两个设置。 | [M5366](conversation-evidence.md#m-5366) → [M5373](conversation-evidence.md#m-5373) |
| T03 | 外部应用授权连接一次，再逐个选择哪些 Bot 可以使用；不要求每个 Bot 单独再授权同一账号。 | [M4122](conversation-evidence.md#m-4122) → [M4129](conversation-evidence.md#m-4129) |
| T04 | 首发允许 Bot 在任务中调用已授权应用；手动任务、定时任务和通用本机/局域网 Webhook 先做。Slack/GitHub/邮件专属事件触发器后续再补，不默认引入云端托管事件队列。 | [M4107](conversation-evidence.md#m-4107) → [M4115](conversation-evidence.md#m-4115)、[M7232](conversation-evidence.md#m-7232) → [M7239](conversation-evidence.md#m-7239) |
| T05 | 新 Bot 默认 Full Access / YOLO：取消 Codex 沙箱和执行审批。保留按 Bot 切换权限档的能力，Bot 工作目录是组织方式，不承诺限制文件访问。Bot 通过应用 Tools 管理自身配置时不新增通用执行审批；用户对 Bot 的归档/永久删除仍按 B08。 | [Q64 Bot 自管理](decision-followups.md#q64)、[M134](conversation-evidence.md#m-134)、[M5831](conversation-evidence.md#m-5831) → [M5839](conversation-evidence.md#m-5839)、[M5848](conversation-evidence.md#m-5848) |
| T06 | 权限采用 Bot 默认值和聊天覆盖两层；聊天输入区显示当前模式，改动默认值和当前聊天覆盖只作用于对应范围，Bot 设置另提供应用到所有聊天的选项。当前 Bot 可按 B13 自主修改自己的默认权限与自身唯一私聊覆盖，不能修改其他 Bot；生效时机按后续轮次处理。 | [Q64 Bot 自管理](decision-followups.md#q64)、[M5976](conversation-evidence.md#m-5976) → [M5983](conversation-evidence.md#m-5983) |
| T07 | 首版复用已有 Codex 连接，并在应用内提供新增可直连 MCP 及其支持的浏览器授权/凭据配置；暂不引入 Composio 等额外托管连接平台，不承诺现成应用数量与 Grok 一致。已有逐 Bot 分配规则继续适用；新增连接不是自动安装任意服务器软件。 | [Q03 及用户原话“好”](decision-followups.md#q03) |
| T08 | 首版支持应用内选择包含 `SKILL.md` 的本地技能文件夹，连同配套脚本、参考资料等导入共享技能库；导入后默认不启用，再由用户给指定 Bot 开启。加载与存储实现需验证，不据此承诺完整在线市场、ZIP/GitHub 导入或内置技能编辑器。 | [Q08 及用户原话“好”](decision-followups.md#q08) |
| T09 | 首版支持在聊天中明确要求保存或更新可复用技能，由 Codex 整理并保存到共享技能库；明确请求本身作为授权，Bot 主动建议新增或修改时先征得用户同意。保存后按既定逐 Bot 分配选择启用，不自动给所有 Bot 开启，也不默认后台自动学习全部对话。 | [Q09 及用户原话“可以”](decision-followups.md#q09) |
| T10 | 邮件连接的实际服务确定为 QQ 邮箱和 Gmail，两者都纳入实现及全量验收范围。邮件操作范围按 T11；接入、授权和真实调用路径由技术调查核实，不因服务差异自行省略任一方，也不把当前会话工具等同于 Rambo 已接通。 | [Q33 用户原话“qq邮箱跟gmail”](decision-followups.md#q33) |
| T11 | QQ 邮箱和 Gmail 均支持查收、搜索、读信总结、附件处理、起草、回复和发送；每家每项均纳入实际验收。语音和文字共用底层 Codex 会话与邮件工具，不单独实现语音邮件业务；具体协议/API 兼容、授权及可用性待验证。 | [Q34 用户原话“ok”](decision-followups.md#q34) |
| T12 | Bot 可设置默认发件账号，未指定账号的新邮件按默认发送；回复沿原邮件所属账号；用户明确指定账号时按指定优先。账号配置与来源交给 Codex 上下文/工具，应用不另造自然语言邮件解析；具体协议/API 行为需验证。 | [Q35 用户原话“可以 继续”](decision-followups.md#q35) |
| T13 | 首版每种邮箱服务连接一个账号，即一个 QQ 邮箱账号加一个 Gmail 账号；暂不做同一服务多账号。两种服务及 T11 基础操作都保留验收，按 Bot 分配和发件默认规则继续适用。 | [Q36 用户原话“先做一个就好了。”](decision-followups.md#q36) |

记忆与 Bot 自身配置写入已按 Q56/Q64 改为由 Bot 自动整理、自主管理；B13 不再为名称、职责/长期指令、模型、权限、自身记忆和自身 Routine 设置逐次确认。用户从管理界面主动归档或永久删除 Bot 仍按 B08。反之，也不能把最初建议中的“发送/付款/删除前通用审批”重新写成默认规则：用户明确选了全部自动执行，之后又确认 Full Access。

Full Access 与 T02 也不是安全隔离保证：应用层工具清单不能证明 Codex 无法通过全局配置或 shell 访问其他资源。继承的用户级 MCP 是否可过滤属于技术验证项。

## 6. Computer Use、并发与接管

| 编号 | 已确认规则 | 问答依据 |
| --- | --- | --- |
| C01 | 电脑操作优先复用 Codex Computer Use，所有 Bot 操作用户眼前这台 Mac 的真实桌面；不采用虚拟桌面、Local VM 或云电脑，也不存在每个 Bot 自己的独立电脑画面。用户查看实际应用即可看到桌面操作，Q07 移除了另开机器人实时画面的提案。此处不否定 Computer Use 内部截图工具的用途。 | [M201](conversation-evidence.md#m-201)、[M6463](conversation-evidence.md#m-6463)、[M6504](conversation-evidence.md#m-6504) → [M6537](conversation-evidence.md#m-6537)、[M6545](conversation-evidence.md#m-6545)、[Q07 用户纠正](decision-followups.md#q07) |
| C02 | 同一时间只允许一个 Bot/任务操作本机电脑；其他需要电脑的任务等待，释放后继续。显示占用者和等待状态；不使用电脑的独立 Codex 任务仍可并行。 | [M6537](conversation-evidence.md#m-6537)、[M6545](conversation-evidence.md#m-6545)、[M6552](conversation-evidence.md#m-6552)、[M6561](conversation-evidence.md#m-6561) |
| C03 | 用户接管时挂起电脑操作，在当前电脑步骤等待；交还后继续同一任务。“停止任务”是另一操作，不把接管当作停止整个任务。 | [M6643](conversation-evidence.md#m-6643) → [M6651](conversation-evidence.md#m-6651) |
| C04 | 电脑资源 FIFO 排队，先申请先使用；显示等待位置，用户停止任务后立即出队。 | [M6742](conversation-evidence.md#m-6742) → [M6749](conversation-evidence.md#m-6749) |
| C05 | 等电脑 30 分钟后转为停放，保留任务和续跑信息；电脑空闲后自动恢复，手动停止才取消。停放不能被误当成任务完成或永久丢弃。 | [M6790](conversation-evidence.md#m-6790) → [M6797](conversation-evidence.md#m-6797) |
| C06 | 对明确指派修改同一项目文件夹的独立任务，首版默认依次执行，其余等待；只读分析和不同项目任务可并行。同一协作任务内部由负责人协调。此为已知任务目标的调度规则，不是 Full Access 下任意路径的文件写锁或沙箱。 | [Q04 及用户原话“可以的”](decision-followups.md#q04) |
| C07 | 本应用默认最多同时执行 3 个普通任务，其余排队，可在设置调整。电脑单任务互斥及已知同项目独立修改串行规则继续适用。此上限管理本应用任务，不控制外部 Codex 客户端；协作等待和语音控制等路径需避免被上限卡死，具体调度待验证。 | [Q24 用户原话“ok”](decision-followups.md#q24) |

这里确认的是产品行为；Codex 回合如何等待工具调用、如何与本机 Computer Use 服务配合实现挂起/交还，需要实现验证。不能把 `turn/interrupt` 当作已经实现的无损暂停接口。本应用普通任务总并发默认值见 C07；各类等待如何计入名额需技术设计，队列优先级与自定义抢占规则仍未选定。

## 7. Live 语音、图片和头像

| 编号 | 已确认规则 | 问答依据 |
| --- | --- | --- |
| V01 | 使用用户所指的 Codex `/voice` 能力，首版在单个 Bot 的当前聊天中提供实时语音，共用当前 Bot 会话上下文，将转写保存进聊天；群聊先保持文字。不做 Live 中通过口头指令切换 Bot，按 Q44 用户明确排除。 | [M465](conversation-evidence.md#m-465)、[M477](conversation-evidence.md#m-477)、[M1683](conversation-evidence.md#m-1683) → [M1690](conversation-evidence.md#m-1690)、[M4364](conversation-evidence.md#m-4364) → [M4371](conversation-evidence.md#m-4371) |
| V02 | 语音采用应用内 Live 模式，可持续聆听、打断、静音和结束。我们的程序负责麦克风、音频播放和界面；App Server 负责实时会话、上下文与 Agent 工作，不跳转到 Codex App。 | [M4378](conversation-evidence.md#m-4378)、[M4408](conversation-evidence.md#m-4408) → [M4413](conversation-evidence.md#m-4413)、[M4422](conversation-evidence.md#m-4422) |
| V03 | 用户明确选择先做本机关键词唤醒，接入既定 Live 语音对话；手机远程呼叫暂不做。此为用户自己的入口需求，不冒称 Grok 已有唤醒词。目标 Bot 按 V04，称呼与说法按 V12，启用及恢复按 V11；具体监听实现仍需验证，当前仍是功能设计阶段。 | [Q10 用户原话](decision-followups.md#q10)、[Q11 用户原话“先做唤醒吧”](decision-followups.md#q11) |
| V04 | 使用统一唤醒词，呼叫用户指定的默认语音 Bot；不随当前查看的聊天页面改变接听对象。具体称呼及说法已按 V12 确定，不将按各 Bot 名称分别唤醒默认为首版功能。 | [Q12 用户原话“可以的”](decision-followups.md#q12) |
| V05 | 用户要求合盖后仍可关键词唤醒并语音对话，并明确现有环境是外接显示器、使用外置耳机麦克风的合盖模式；以此具体环境作为验收目标。实现后需验证合盖监听、唤醒与双向语音，不能把该需求写成已经实测通过，也不扩展为系统睡眠时可用。 | [Q13 用户合盖要求与硬件说明](decision-followups.md#q13) |
| V06 | 唤醒/监听控制统一放在应用设置界面；拟设“语音与唤醒”分区。菜单栏是屏幕顶部状态区的快捷入口提议，非必须入口，未获用户确认。 | [Q13 用户设置入口要求](decision-followups.md#q13) |
| V07 | Bot 根据用户自然语言与上下文理解结束本次语音的意图，调用应用提供的专用结束语音工具，由应用真正关闭 Live 并恢复已启用的唤醒监听；不要求固定结束口令。用户已同意参考 Grok 的语义判断加专用工具方案；具体 Codex 接口与媒体收尾仍需验证；空闲结束规则见 V10。 | [Q14 用户纠正及方案确认](decision-followups.md#q14)、[设计方案](voice-end-proposal.md) |
| V08 | Live 结束后的任务结果默认沿用既定通知规则，不主动播放语音；用户可在每个 Bot 的设置中开启语音播报，开启后简短播报任务完成提示。播报不重开麦克风或 Live，Routine 仍沿用 R09 的提醒范围。语音输出路径待验证，不据此引入额外服务密钥。 | [Q15 用户原话“ok”](decision-followups.md#q15) |
| V09 | 后台唤醒时恢复默认语音 Bot 的唯一私聊 thread；语音与文字共用它。Routine/异步任务不改变这段对话，也不创建另一条私聊。 | [Q58 单 Bot 单聊](decision-followups.md#q58) 覆盖早先 [Q16](decision-followups.md#q16) 的新建线程例外 |
| V10 | 连续 5 分钟无人说话且 Bot 没有执行中任务时，自动结束 Live，恢复已启用的唤醒监听；空闲时长可在设置修改或关闭。任务执行期间不因该空闲条件挂断；此规则与用户主动表达结束意图的 V07 分开。 | [Q14 空闲规则后续确认“ok”](decision-followups.md#q14) |
| V11 | 首次由用户明确开启唤醒并授予麦克风权限后监听；之后记住唤醒开关，应用启动时恢复上次状态，上次关闭则保持关闭。沿用既定登录启动和合盖目标，不承诺系统睡眠时监听。 | [Q29 用户原话“可以”](decision-followups.md#q29) |
| V12 | 最新唤醒称呼为“Rambo”，用户明确指《第一滴血》主角的名字；沿用已确认的带问候语唤醒方式，对应“你好，Rambo”。此前“伟哥”和“cobo”不再作为当前默认唤醒词。实际语音读法及耳机麦克风下的识别效果仍需验证，不能据命名声称已能触发。 | [Q37 用户最新命名及唤醒词](decision-followups.md#q37-rambo) |
| V13 | 本应用在本机保留 Live 文字转写及任务结果，不长期保存完整通话录音；用户主动上传的音频文件仍按 F01/F02 作为附件处理。此项仅约定本应用本地存储，不声明 Codex 服务端的音频保留政策。 | [Q47 用户原话“可以”](decision-followups.md#q47) |
| V14 | 语音输入输出默认跟随 macOS 系统设置，也允许在语音设置中固定选择麦克风和扬声器；固定设备断开时提示不可用，不自动改用其他设备。真实设备切换、输出路由及合盖耳机适配需验证。 | [Q48 用户原话“可以”](decision-followups.md#q48) |
| I01 | 首版支持聊天中自然语言生成图片，生成结果作为回复附件，不加独立“新建绘画”页面。 | [M4648](conversation-evidence.md#m-4648) → [M4655](conversation-evidence.md#m-4655) |
| I02 | 支持在同一聊天中要求修改刚才的图片，应用将最近生成图作为参考输入，结果保存为新附件；不加独立图片编辑器。实际参考图链路待验证。 | [M4765](conversation-evidence.md#m-4765) → [M4772](conversation-evidence.md#m-4772) |
| I03 | 新建 Bot 时选择预置头像；创建后可选预置外观、上传图片或描述生成，先预览再设为头像。描述生成优先复用 Codex，避免另设图像服务密钥；能力和账号支持待验证。 | [M4904](conversation-evidence.md#m-4904) → [M4914](conversation-evidence.md#m-4914) |

用户没有同意另配语音 API Key，也没有同意改用 OpenMausBot 的 GPT-Live 作为默认语音后端。语音接口在会话中被核对为实验协议，“接口存在”不等于已完成实际通话、认证、播放与打断验证。

### 附件与 Bot 长期资料

| 编号 | 已确认规则 | 问答依据 |
| --- | --- | --- |
| F01 | 聊天上传的文件默认只自动提供给该 Bot 的唯一私聊；用户主动选择“保存为 Bot 长期资料”后，该 Bot 的独立定时任务可按需查阅。临时附件不自动成为长期资料。此为上下文组织方式，不是 Full Access 下的文件权限隔离。 | [Q01 及用户原话“可以”](decision-followups.md#q01)、[Q58 单 Bot 单聊](decision-followups.md#q58) |
| F02 | 用户明确上传/导入的附件保存本机副本，相同内容仅存一份，多个聊天、Bot 和长期资料共用引用；原文件移动、删除、修改不影响已保存版本，更新时替换或重新上传。普通本机项目/目录任务直接使用原文件，不复制整个目录。提供占用查看、大文件查找和无用附件清理，长期资料由用户主动删除；备份采用增量方式避免重复保存未变附件。 | [Q02 及用户原话“可以的”](decision-followups.md#q02) |
| F03 | Bot 详情提供“文件”入口，分别查看长期资料和 Bot 明确交付的生成成果；聊天中保留成果卡片。支持按格式预览、保存、Finder 定位，并返回来源聊天或任务记录。预览格式按 F05，具体页面视觉仍需设计。 | [Q05 及用户原话“ok”](decision-followups.md#q05) |
| F04 | 用户未指定位置时，生成报告、图片等成果默认保存到应用管理的该 Bot 独立工作文件夹，可从聊天及 Bot 文件入口打开、Finder 定位。明确指定桌面、项目或其他目录时按要求保存，普通项目不整体复制；工作目录用于组织，不限制 Full Access 文件访问。 | [Q21 用户原话“ok”](decision-followups.md#q21) |
| F05 | 首版应用内预览常见图片、PDF、文本/Markdown、CSV 表格和常见音视频；Word、Excel、PowerPoint 等其他格式提供本机应用打开和 Finder 定位。此范围是应用展示，不限制 Codex 按其实际能力处理文件；具体格式与编解码兼容性待验证。 | [Q22 用户原话“好”](decision-followups.md#q22) |

## 8. Routine 与触发器

| 编号 | 已确认规则 | 问答依据 |
| --- | --- | --- |
| R01 | Routine 在本机后台执行，支持周期任务与一次性任务；窗口关闭不停止，Mac 真正睡眠或关机时不能保证本机执行。 | [M3612](conversation-evidence.md#m-3612)、[M3683](conversation-evidence.md#m-3683)、[M3715](conversation-evidence.md#m-3715)、[M7000](conversation-evidence.md#m-7000) → [M7007](conversation-evidence.md#m-7007) |
| R02 | 错过的周期触发最多补跑一次，不逐次堆积；早前明确接受逾期 12 小时以内补跑一次，超过 12 小时标记错过。一次性任务错过则标记“错过”，由用户手动“立即运行”。后续简化描述没有明确撤销 12 小时门槛。 | [M3809](conversation-evidence.md#m-3809) → [M3816](conversation-evidence.md#m-3816)、[M7000](conversation-evidence.md#m-7000) → [M7007](conversation-evidence.md#m-7007) |
| R03 | 后续又确认唤醒/启动后补跑一次，并允许每条 Routine 单独关闭补跑。与 R02 合并：先看是否开启，再按错过窗口和最多一次规则执行。 | [M8627](conversation-evidence.md#m-8627) → [M8634](conversation-evidence.md#m-8634) |
| R04 | 每次 Routine 有独立执行记录，详情页保留状态、时间、错误及完整过程；简短结果回到创建该 Routine 的对话线程，不把完整执行过程刷进普通聊天。 | [M3899](conversation-evidence.md#m-3899) → [M3906](conversation-evidence.md#m-3906)、[M7061](conversation-evidence.md#m-7061) → [M7068](conversation-evidence.md#m-7068) |
| R05 | 每次默认使用新上下文；可打开“记住上次结果”，只传入上次简短报告，不默认带入旧任务完整对话。报告的具体字符上限未定。 | [M7122](conversation-evidence.md#m-7122) → [M7129](conversation-evidence.md#m-7129) |
| R06 | 同一 Routine 上轮未结束时跳过新一轮，覆盖等待电脑、等待用户/审批及停放状态；记录跳过原因，后续仍按原计划触发，不积压重复任务。 | [M7179](conversation-evidence.md#m-7179) → [M7186](conversation-evidence.md#m-7186) |
| R07 | 可恢复的短暂网络、服务或引擎错误延迟后最多自动重试一次，并检查第一次已完成的操作；登录、权限、额度、审批等需人工处理的问题停止并通知。外部副作用是否已完成无法确认时暂停，不盲目重跑。 | [M3913](conversation-evidence.md#m-3913) → [M3920](conversation-evidence.md#m-3920)、[M7293](conversation-evidence.md#m-7293) → [M7300](conversation-evidence.md#m-7300) |
| R08 | 连续失败不自动暂停 Routine；每次失败都记历史并显示次数。同因连续失败只通知一次，错误变化或成功后再次失败才重新通知。 | [M7334](conversation-evidence.md#m-7334) → [M7341](conversation-evidence.md#m-7341) |
| R09 | Routine 成功默认不弹 macOS 通知，结果和记录可在应用内查看；失败或需要用户处理时通知。允许单条 Routine 打开成功通知。 | [M3931](conversation-evidence.md#m-3931) → [M3938](conversation-evidence.md#m-3938)、[M8506](conversation-evidence.md#m-8506) → [M8513](conversation-evidence.md#m-8513) |
| R10 | 触发器首版范围是本机计划和本机/局域网 Webhook；外部服务专属事件和托管队列留待后续设计。 | [M4107](conversation-evidence.md#m-4107) → [M4115](conversation-evidence.md#m-4115)、[M7232](conversation-evidence.md#m-7232) → [M7239](conversation-evidence.md#m-7239) |
| R11 | 文字对话或 Live 中只要能从上下文明白判断用户希望周期性委托某项工作，Bot 可自动整理并创建 Routine，不要求用户使用固定措辞或切换任务页面；任务列表用于查看和手动管理。各入口共用一份任务配置。缺少关键周期/执行内容时先澄清；一次性请求和随口提到时间不创建。Live 工具路径需验证。 | [Q40 用户原话“ok”](decision-followups.md#q40)、[Q59 从对话生成 Routine](decision-followups.md#q59) |
| R12 | 用户表达的周期委托意图明确时直接创建，不重复确认；Bot 独立想到的自动化建议仍须用户同意后才创建。一次性请求不自动转为长期计划；此规则不改变 T05 的默认 Full Access。 | [Q41 用户原话“ok”](decision-followups.md#q41)、[Q59 从对话生成 Routine](decision-followups.md#q59) |
| R13 | 当前 Bot 或用户可暂停/恢复自己管理的定时计划。暂停会停止后续触发并取消尚未开始的排队执行；已经开始的本次任务继续。用户或 Bot 可单独停止本次执行，或明确要求暂停计划且这次也停止；停止协作执行沿用 G10，不自动回滚已完成动作。Bot 只能管理自己的 Routine。 | [Q64 Bot 自管理](decision-followups.md#q64)、[Q42 用户原话“ok”](decision-followups.md#q42) |
| R14 | 当前 Bot 或用户可删除自己管理的定时计划。删除不连带删除过去的运行记录、聊天简报和已生成成果，保留回查入口；需要清理时另行操作。删除整个 Bot 仍按 B08，文件清理仍按 F02；Bot 不能删除其他 Bot 的 Routine。 | [Q64 Bot 自管理](decision-followups.md#q64)、[Q43 用户原话“ok”](decision-followups.md#q43) |
| R15 | 修改定时计划的指令和计划参数仅对后续新触发的任务生效；已创建的排队执行和已开始的任务保留原任务指令，不自动中断或重跑。取消旧排队、停止本次仍按 R13；模型轮次切换仍按 B06。 | [Q45 用户原话“可以”](decision-followups.md#q45) |
| R16 | 一次性定时任务执行后保留在任务列表，显示实际成功或失败，可回查结果和手动立即运行；不再按原时间自动重复触发。错过执行仍按 R02 标记错过，不能仅因计划时间已过就显示执行成功。 | [Q46 用户原话“可以”](decision-followups.md#q46) |

运行中断恢复与错过触发补跑是两件事：前者见 O04，后者见 R02/R03。它们都需要防重复，不应分别重启同一任务两遍。Webhook 认证方式、重放防护、时区、夏令时和 Routine 编辑器的具体界面尚未定案。

## 9. macOS 后台、通知、备份与恢复

| 编号 | 已确认规则 | 问答依据 |
| --- | --- | --- |
| O01 | macOS 用户登录后默认启动后台 Agent；设置中可关闭登录启动。关闭最后一个窗口继续运行，显式退出/`⌘Q` 才停止本机服务。此项在较早阶段已经确认，后续重复问答不代表仍未定。 | [M7712](conversation-evidence.md#m-7712) → [M7719](conversation-evidence.md#m-7719)、[M8613](conversation-evidence.md#m-8613) → [M8620](conversation-evidence.md#m-8620) |
| O02 | 接电时，Bot/Routine 正在执行期间暂时防止系统闲置睡眠，显示器仍可熄灭；电池供电时不阻止睡眠，醒来按补跑规则处理。手动睡眠和所有合盖条件不能承诺继续执行。 | [M7741](conversation-evidence.md#m-7741) → [M7750](conversation-evidence.md#m-7750)、[M7765](conversation-evidence.md#m-7765) |
| O03 | 默认每天生成本机备份，保留最近 7 份；支持设置密码的完整导出/导入。恢复前自动保留回滚副本；导出不包含 Codex 登录凭证。后续确认本机备份采用增量方式，未变附件避免重复复制，见 F02。 | [M7428](conversation-evidence.md#m-7428) → [M7441](conversation-evidence.md#m-7441)、[Q02](decision-followups.md#q02) |
| O04 | 应用或 Mac 重启后，普通正在执行的聊天任务标记中断，排队消息保留并继续派发；Routine 最多自动恢复一次。若无法判断先前动作是否已完成则暂停等待用户，避免重复发送/修改。 | [M7558](conversation-evidence.md#m-7558) → [M7565](conversation-evidence.md#m-7565) |
| O05 | 保留应用内通知记录和未读标记；任务完成、需要回复/处理、失败时提醒，不对每个执行进度都提醒。通知按 Bot 独立开关，默认开启。仅窗口有焦点且正在看的同一会话抑制系统弹窗；看其他 Bot/任务时仍按规则提醒，应用内记录照常更新。Routine 成功默认例外，见 R09。 | [M6926](conversation-evidence.md#m-6926) → [M6933](conversation-evidence.md#m-6933)、[M8506](conversation-evidence.md#m-8506) → [M8513](conversation-evidence.md#m-8513)、[Q23 用户原话“可以的”](decision-followups.md#q23) |

前台抑制曾有“整个应用在前台”与“对应会话正在查看”两种表述。最小确定行为是对应会话可见时不弹；用户正在查看其他 Bot 时是否仍弹属于细节歧义，不凭摘要强行补齐。

## 10. Codex App Server、认证、会话隔离与更新

| 编号 | 已确认规则 | 问答依据 |
| --- | --- | --- |
| A01 | 应用有自己的界面和 App Server 子进程，单独启停；采用应用管理自身进程的方案。共享已运行 daemon 曾被讨论，但不是最终选择。 | [M1413](conversation-evidence.md#m-1413)、[M8353](conversation-evidence.md#m-8353)、[M8364](conversation-evidence.md#m-8364) → [M8371](conversation-evidence.md#m-8371)、[M8376](conversation-evidence.md#m-8376) |
| A02 | 随应用打包固定版本的独立 App Server 后台可执行程序及必要配套文件；不是打包 Codex Desktop 界面或模型文件。用户无需先打开 Codex App。Computer Use 执行组件的分发依赖仍需另外核实。 | [M8353](conversation-evidence.md#m-8353)、[M8364](conversation-evidence.md#m-8364) → [M8371](conversation-evidence.md#m-8371)、[M8376](conversation-evidence.md#m-8376) |
| A03 | 使用同一本机 `CODEX_HOME` 复用 Codex 认证和配置；已有登录时直接读账号状态，不加另一套应用账号。未登录时由 App Server 提供 ChatGPT/Codex 登录流程，凭据由 Codex/系统凭据存储管理。 | [M539](conversation-evidence.md#m-539)、[M570](conversation-evidence.md#m-570) → [M577](conversation-evidence.md#m-577)、[M8376](conversation-evidence.md#m-8376) |
| A04 | Bot 应用维护自己的会话列表和 thread ID 映射；使用专属会话来源，让 Bot 创建的会话不混入普通 Codex CLI/桌面端默认历史列表。用户接受的是常规列表隔离，不是共享数据目录下的文件级保密。 | [M8194](conversation-evidence.md#m-8194)、[M8299](conversation-evidence.md#m-8299) → [M8306](conversation-evidence.md#m-8306)、[M8364](conversation-evidence.md#m-8364) → [M8371](conversation-evidence.md#m-8371) |
| A05 | App Server 程序版本随本应用版本管理和更新；不覆盖用户另外安装的 Codex CLI。调用本机已安装程序、跟随其升级的方案曾被讨论，最后选择随包提供独立程序。 | [M8126](conversation-evidence.md#m-8126)、[M8346](conversation-evidence.md#m-8346) → [M8353](conversation-evidence.md#m-8353) |
| A06 | 后台下载更新，暂停派发新任务，等待当前轮次结束后重启并更新；排队任务和 Routine 保留。任务一直不结束时显示待安装更新，由用户选择是否立即重启并中断。 | [M8423](conversation-evidence.md#m-8423) → [M8430](conversation-evidence.md#m-8430) |

认证共享、进程独立、常规会话列表隔离是三个不同目标。文件级完全隔离会改变认证/配置复用方式，未被选为当前方案。独立程序的参数、构建和最终默认列表行为仍需按实际打包版本验证，历史源码判断不能代替最终验收。

## 11. 讨论和执行约定

| 编号 | 已确认要求 | 依据 |
| --- | --- | --- |
| W01 | 使用中文，问题直接发文字，一次只推进一个最高优先级未决问题，给出推荐后等待用户答复；用户确认后当轮记录，再直接提出下一个未决问题，不仅回复记录结果就结束。 | [M1680](conversation-evidence.md#m-1680)、会话中用户调用的 grill-me 指令 |
| W02 | 提出新产品设计问题前，用子 Agent 核对 Grok Bot 或 OpenMausBot 的实际实现，再给建议；先查原文，不让用户猜陌生产品功能。研究结论必须区分公开文档、静态线索和实际运行验证。 | [M2066](conversation-evidence.md#m-2066)、[M2569](conversation-evidence.md#m-2569) |
| W03 | 参考对象是用户纠正后的 Cue、Dots 及随后讨论的 OpenMausBot；不要沿用误识别的 Coze/Dify。不要把声转文字中的“绘画/对话”“CodeDesk/Codex”直接推断成新增产品要求。 | [M783](conversation-evidence.md#m-783)、[M862](conversation-evidence.md#m-862)、[M900](conversation-evidence.md#m-900)、[M905](conversation-evidence.md#m-905)、[M679](conversation-evidence.md#m-679) |
| W04 | 已确认的内容先读文档再继续；用户已经多次指出后台运行、模型、记忆等问题被重复询问，不能因为摘要简短就重启访谈。 | [M8652](conversation-evidence.md#m-8652)、[M8833](conversation-evidence.md#m-8833)、[M8875](conversation-evidence.md#m-8875)、[M9057](conversation-evidence.md#m-9057) |

## 12. 尚未定案：不能从历史建议补成用户决定

| 事项 | 原记录与状态 |
| --- | --- |
| 全局的分阶段交付顺序 | [M1683](conversation-evidence.md#m-1683) 提出 A/B/C，用户 [M1690](conversation-evidence.md#m-1690) 明确说第一个问题没懂；没有整体选择 A。之后明确说首版纳入的功能按各条记录；Q31/P08 明确全部已确认功能均须验收。实施先后不构成缩减范围，不把助手建议的全局阶段表当作用户批准。 |
| 技能编辑器/其他导入方式、连接市场及服务器软件安装 | T01 资源共享、逐 Bot 分配，T07 应用内新增直连 MCP 和授权，T08 本地技能文件夹导入、T09 聊天保存/更新技能均已确认。完整市场、任意 MCP 服务器软件安装、图形技能编辑器、ZIP/GitHub 导入及后台自动技能学习仍未定案。 |
| 附件剩余细节和文件夹授权 | 文件上下文范围见 F01，副本与去重/清理见 F02，Bot 文件入口与成果操作见 F03。[M5463](conversation-evidence.md#m-5463) 的每 Bot 工作区和额外目录选择器授权细节未获单独确认；Full Access 不是路径沙箱。预览范围已由 F05 确认；大小上限、清理交互和具体页面仍待设计。 |
| 数值配置 | 每 Bot 三个并发线程、1.5 秒路由超时、0.6 置信度、上次报告 2,000 字符、一小时内任务保活等是参考实现细节；这些数值未逐项选定。另已确认 G08 最多连续转派 4 次、C07 全应用默认 3 个普通任务并行、V10 空闲 5 分钟退出；30 分钟等待、7 份备份、早期 12 小时补跑门槛按对应条目保留。 |
| 记忆后台维护与存储细节 | 已按 Q56 改为 Bot 自动整理保存、可手动管理，整理节奏见 M06；变更历史和撤销已按 M08 排除首版。具体静默时长/轮次、Markdown/数据库选型等仍待技术设计。 |
| 额外语音/图像服务密钥 | 首选复用 Codex；没有同意为了这些功能强制另配 API Key。 |
| 唤醒入口细节 | Q11 已选择先做本机关键词唤醒，接入既定 Live；手机远程呼叫暂不做。Q12 已定统一唤醒词与指定默认语音 Bot；唤醒称呼及带问候语说法已按 V12 更新为 Rambo / 你好，Rambo，识别与运行实现待验证；启用与恢复状态已定 V11，开关集中到应用设置，合盖目标见 V05/V06。不把手机、电话号码、跨网服务或系统睡眠唤醒默认纳入已批准架构。 |
| 具体视觉稿与快捷键 | 已定 Grok 视觉方向，最新应用/项目名 Rambo、图标原图见 Q37；最终系统图标适配及各页面视觉仍待验收。 |
| Webhook 与时间细节 | 本机/局域网范围已定；接口认证、重复事件去重及外部可达方式未最终选型。用户在 Q28 明确暂不考虑时区变化，不继续追问该边界，也不追认固定时区建议。 |

## 13. 技术验证清单：产品已选定，完成状态未验证

2026-10-20 补充：已形成 [技术设计草案](technical-design.md)，并用当前本机 Codex 0.163.0 重新生成实验协议 schema，摘要见 [App Server 本机核对](app-server-evidence.md)。本轮只核对 CLI/协议，没有启动对话、录音、邮箱连接或电脑操作；不改变下表中仍待运行证明的状态，不将技术建议追认为用户产品选择。

同日进一步只读调查见 [可行性状态](feasibility-status.md)：Voice 已追到 WebRTC 复用认证的源码分支；Computer Use 另有原生服务及专用宿主依赖；匹配版本的现成 App Server 新线程使用 VSCode 来源，因此原“共用 home 并只改标签”的 A04 实现方案不成立。保留 A03/A04/O03 产品目标，历史隔离与完整会话恢复继续作为技术阻塞，不回写成用户接受了降低要求。

第二轮补充：[历史隔离方案收敛](history-isolation-plan.md) 已区分 CLI 的 `codex app-server` 与上游独立 `codex-app-server`。后者支持 `--session-source app-server`，且公开 release 有独立 package；当前桌面默认列表及其自带后台 0.153.4 的过滤也已静态核对。推荐先用上游现成参数，不先修改核心；尚未进行来源持久化、双客户端或运行验收，不修改 A03/A04 的要求或通过状态。

以下来自历史调查和接口核对，本次文档整理未重新运行这些链路。版本与服务能力可能变化；实现时按打包版本复核。

| 技术项 | 会话中已知证据 | 后续需要证明 |
| --- | --- | --- |
| Computer Use | 当时 Codex 0.163.0 App Server 成功发现了 10 个 Computer Use 工具；尚未实际执行完整电脑操作。 | 独立应用能建立服务连接、获得权限、真实截图/操作、正确停止/排队/接管；关掉其他客户端后可用性及所需组件可分发性。 |
| Codex Voice | 当时生成的 App Server 实验协议有启动、停止、收音频/文本、转写和音频等接口。 | 现有账号授权能实际通话、持续聆听、打断、静音、播放、共享线程上下文；协议兼容和失败回退。 |
| 关键词唤醒 | 用户提出需求；当前没有唤醒引擎或监听实现的验证。参考产品官方文档介绍按钮发起通话，未找到内置唤醒词说明。 | 本机监听、误唤醒控制、麦克风切换、从唤醒进入 Live 的完整链路，以及锁屏/系统睡眠的实际边界。 |
| 图片生成、编辑、头像 | 找到参考产品对 `imageGeneration` 的处理，以及参考图输入线索。 | 打包运行时/账号实际支持生成和编辑；最近生成图可作为参考重传；头像可预览、保存。 |
| Bot 工具范围 | App 层目录和逐 Bot 分配已选定；个人 `config.toml` 中的 MCP 可能额外继承。 | 枚举接口、实际工具过滤及边界；不可把 UI 开关声称为 Full Access 下的完整安全隔离。 |
| App Server 打包和会话来源 | 历史源码调查称独立 App Server 可设置 `--session-source`，普通 `codex app-server` 使用默认来源。 | 固定版本程序构建/配套文件/签名、认证复用、thread 恢复，以及普通 Codex 历史列表不会混入 Bot 线程。 |
| 资源等待与恢复 | 电脑互斥、等待、停放、人工接管及 Routine 恢复规则已经确认。 | 工具级等待与任务级中断分开实现；资源释放、进程崩溃、排队与任务去重不会导致多 Bot 同时操作或重复外部动作。 |
| Grok 功能覆盖 | 已做安装包静态清单；REA 分析受到 SwiftBridging 和完整性问题限制，Grok 私有服务端未拿到。 | 各用户可见入口与实际行为按证据复核；包内存在的教学录制、语音备忘等线索不能自动算已确认需求。 |

## 14. 前后变化与本次纠正

1. 从错误的深色编码工作台，改为干净新项目、Grok 风格 Bot 产品（P02/P05）。
2. 从把会话当主对象，改为 Bot 主对象、聊天/任务归属 Bot（B01/B02）。
3. 从考虑共享 daemon/本机 Codex 可执行程序，最终选择应用随包提供独立 App Server（A01/A02）。
4. 从“所有数据都隔离”的模糊说法，明确为复用认证配置、分开常规会话列表；不承诺文件级保密（A03/A04）。
5. 群聊曾采用隐藏 Codex 回合集中选人；2026-10-21 用户在 Q55 改为各 Bot 自行判断、允许多人回复，明确 @ 时直接指定（G02–G04）。
6. 忙线程新消息从助手建议排队，改为用户要求的 Grok 式转向当前任务（B09）。
7. 从考虑虚拟桌面隔离电脑争用，改为真实 Mac 桌面互斥等待（C01–C05）。
8. 权限以明确的 Full Access 选择为准，不重新加入助手早期建议的通用执行审批门槛（T05/T06）。
9. 记忆管理、模型、通知、登录启动和关窗行为曾被重复提问；合并为同一决定，不当成多个未决问题。
10. 之前口头总结将附件/文件夹授权当成已批准、把四层深度等参考数值当成已选数值，证据不足；本记录当时退回到“未单独确认”；后续已批准的附件规则见 F01–F05，委派深度见 G08，其余未定项继续保留。
11. 补跑规则曾多次被简化重述。本记录保留所有明确条件并列出来源，避免静默丢掉已同意的 12 小时门槛和一次性任务例外。
12. Bot 的长期职责、记忆和 Routine 曾按用户确认或仅由用户设置管理；2026-10-22 通过 Q64 改为 Bot 可通过应用 Tools 自主管理自身，同时排除自我归档、永久删除和清空聊天。具体能力见 B13，技术工具仍待实现和验收。

## 15. 原始资料入口

- [会话原文及确认回复索引](conversation-evidence.md)：本次 396 条可见消息，140 条用户、256 条助手；包括进度消息和后来纠正，方便复核上下文。
- [后续决策补充问答](decision-followups.md)：上述历史归档后的新增问题、用户原话和对应生效规则。
- [Cue / Dots 与开源项目研究](../../docs/grok-bot/research/manus-cue-chatgpt-dots-open-source-landscape.md)：原报告保留在项目外的上级 docs 目录，属于历史研究，不等于本产品已定需求。
- 原始 JSONL：`/Users/yuanjiawei/.codex/sessions/2026/10/18/rollout-2026-10-18T12-20-18-01a14d3d-318c-7e40-b947-cf9ab867faa5.jsonl`。原记录保持不变。

## 16. 访谈进度

### Q01：附件在后续聊天中的使用范围

状态：用户已答“可以”，已收录为 F01。提出及确认日期：2026-10-19。完整新增问答见 [Q01](decision-followups.md#q01)。

此前 M5463 的附件提案没有被单独确认，属于第 12 节已有未决项。此次只确认哪些资料自动提供给后续会话，不改变 Full Access，也不承诺文件权限隔离。

已采用：输入框上传的文件默认作为当前 Bot 唯一私聊的附件；用户可主动选择“保存为 Bot 长期资料”，之后该 Bot 的私聊和定时任务可以按需查阅。临时任务附件不自动变成长期资料。

子 Agent 核对：Grok 官方说明 Bot 共用电脑文件、对话和记忆分开；OpenMausBot 说明线程上下文独立、共享 Bot 记忆/Skills。两者公开材料不足以证明附件的精确注入和保存规则，上述两层管理是本产品已确认设计。

参考：[Grok Bot 概述](https://prod.cursor.com/docs/grok-bot)、[Grok Bot 工作说明](https://prod.cursor.com/docs/grok-bot/work)、[OpenMausBot 线程说明](https://docs.openmausbot.com/docs/features/bots-and-tasks)。

### Q02：上传文件保存副本还是引用原文件

状态：用户在询问空间代价并听取细化建议后答“可以的”，已收录为 F02；本机备份方式也补充到 O03。采用上传副本、同内容去重、占用查看及清理、增量备份。问题、用户追问、实现参考和版本依据见 [补充问答 Q02](decision-followups.md#q02)。

### Q03：首版应用连接是否引入第三方托管连接平台

状态：用户已答“好”，收录为 T07。首版应用内复用已有连接并添加可直连 MCP，按服务支持完成 OAuth 或凭据配置；暂不引入 Composio 等额外托管连接平台。取舍是现成可连接应用目录可能少于 Grok。详见 [补充问答 Q03](decision-followups.md#q03)。

### Q04：同一项目的独立文件修改任务是否排队

状态：用户已答“可以的”，收录为 C06。同一项目的独立修改任务排队，读取/分析与不同项目任务可并行；同一主任务内部的委派由负责人协调。这是项目任务调度，不是 Full Access 下的文件沙箱。研究依据和实现边界见 [补充问答 Q04](decision-followups.md#q04)。

### Q05：Bot 资料和交付成果的文件入口

状态：用户已答“ok”，收录为 F03。聊天保留产物卡片，Bot 详情“文件”入口分别汇总长期资料与明确交付成果，支持按格式预览、保存/Finder 定位和回到来源记录。研究依据见 [补充问答 Q05](decision-followups.md#q05)。

### Q06：用户全局搜索的范围

状态：用户已答“ok”，收录为 B10。跨 Bot/群聊搜索消息正文、任务结果摘要、附件/成果文件名，支持 Bot/时间/类型筛选并跳转来源。此为用户检索界面，不改变 Bot 上下文共享规则。原文与依据见 [补充问答 Q06](decision-followups.md#q06)。

### Q07：普通聊天任务的执行过程如何展示

状态：用户纠正独立电脑画面提案后，对修订方案答“好”，已收录为 B11 并补充 C01。聊天内简短进度、可展开操作记录，接管/停止沿用既定入口；用户直接查看真实桌面。具体原话与依据见 [补充问答 Q07](decision-followups.md#q07)。

### Q08：首版 Skills 是否支持本地文件夹导入

状态：用户已答“好”，收录为 T08。应用内选择包含 `SKILL.md` 的技能文件夹及配套内容，导入共享库，默认关闭，再由用户给 Bot 启用。具体依据见 [补充问答 Q08](decision-followups.md#q08)。

### Q09：通过聊天保存或更新可复用技能

状态：用户已答“可以”，收录为 T09。用户明确要求时，由 Codex 将流程整理为技能保存到共享库；Bot 主动新增或修改技能先获同意，启用范围沿用逐 Bot 分配。依据和范围见 [补充问答 Q09](decision-followups.md#q09)。

### Q10：首个可用 Bot 的真实验收任务

状态：用户补充核心目标为生活、工作小助手，已收录 P07/V03；后续 Q31 明确要求全部已确认功能可逐项验收，按 P08 建立全量矩阵，不再等待用户选单一任务作为交付标准。当前工作阶段仍按 P06。依据见 [补充问答 Q10](decision-followups.md#q10)。

### Q11：“打电话”的使用入口

状态：用户答“先做唤醒吧”。已更新 P07/V03：先做本机关键词唤醒，接入既定 Live；手机远程呼叫暂不做。当前仍按 P06 讨论设计，未开始应用代码实现。依据见 [补充问答 Q11](decision-followups.md#q11)。

### Q12：唤醒后由哪个 Bot 接听

状态：用户答“可以的”，已收录 V04。统一唤醒词呼叫用户指定的默认语音 Bot，不随当前查看页面改变。具体词语后续已按 V12 确定。依据见 [补充问答 Q12](decision-followups.md#q12)。

### Q13：是否默认在后台等待唤醒

状态：用户明确合盖可用、监听开关集中在设置，并说明已有外接显示器与耳机麦克风的合盖模式，已记录 V05/V06。以此环境验证唤醒与 Live 全链路；启用/重启恢复规则已在 Q29 确认为 V11，不把硬件说明单独视作批准所有先前监听技术建议。依据见 [补充问答 Q13](decision-followups.md#q13)。


### Q14：语音对话何时结束并恢复等待唤醒

状态：用户明确语义结束要求，并在调查 Grok 静态实现后答“可以”，确认采用 Bot 理解意图、调用专用工具、应用实际关闭 Live 的方案，已更新 V07。用户随后答“ok”，确认连续 5 分钟无人说话且无执行中任务时自动结束 Live，时长可修改或关闭，收录 V10；具体 Codex 工具/停止接口及音频收尾仍待验证。依据见 [补充问答 Q14](decision-followups.md#q14) 和 [方案](voice-end-proposal.md)。

### Q15：Live 之外的主动语音播报

状态：用户答“ok”，已收录 V08。默认沿用既定通知，逐 Bot 可在设置开启简短语音播报；不重开麦克风或 Live，Routine 仍按 R09。语音输出路径需验证。依据见 [补充问答 Q15](decision-followups.md#q15)。

### Q16：后台唤醒后的聊天选择

状态：早先方案已被 Q58 更新。后台唤醒恢复默认语音 Bot 的唯一私聊 thread，不新建另一条私聊；语音与文字共用该 thread，后台任务不改变选择。当前依据见 [补充问答 Q58](decision-followups.md#q58)。

### Q17：语音对话中的屏幕上下文

状态：用户指出底层就是 Codex 会话，应由 Codex 自行按任务需要调用工具；撤回本题，不再作为等待确认的独立产品选择。沿用 C01/T05/V01/V02，应用负责正确接通语音和工具，不重复设计截图时机规则。持续视频共享未因本题而纳入范围。依据见 [补充问答 Q17](decision-followups.md#q17)。

### Q18：记忆候选在什么时候提出

状态：整理节奏沿用原 Q18；2026-10-21 [Q56](decision-followups.md#q56) 已将待确认候选改为 Bot 自行整理保存，无需批准。具体触发参数待设计；[Q18](decision-followups.md#q18) 保留历史依据。

### Q19：合盖语音中的记忆确认

状态：原语音批准流程已由 2026-10-21 [Q56](decision-followups.md#q56) 替代；Live 沿用自动整理保存，用户可通过语音要求记住或修订。[Q19](decision-followups.md#q19) 保留历史依据。

### Q20：记忆修改历史与撤销

状态：用户认为“不需要这功能吧？”，首版不做，已收录 M08。记错时直接编辑或删除，不再将变更历史/撤销视为待确认功能；O03 应用备份保持原决定。依据见 [补充问答 Q20](decision-followups.md#q20)。

### Q21：未指定位置时的成果默认保存目录

状态：用户答“ok”，已收录 F04。未指定位置时成果默认放 Bot 独立工作文件夹，明确指定目录时按要求保存；仅作组织，不改变 Full Access。依据见 [补充问答 Q21](decision-followups.md#q21)。

### Q22：首版文件预览格式范围

状态：用户答“好”，已收录 F05。应用内预览常见图片、PDF、文本/Markdown、CSV 表格和常见音视频，其他格式用本机应用打开及 Finder 定位；不限制 Codex 文件处理能力。依据见 [补充问答 Q22](decision-followups.md#q22)。

### Q23：查看其他 Bot 时是否仍发系统通知

状态：用户答“可以的”，已细化 O05。窗口有焦点且正在看的同一会话不额外弹系统通知；看其他 Bot/任务时仍照常按既定通知范围和逐 Bot 开关提醒。依据见 [补充问答 Q23](decision-followups.md#q23)。

### Q24：应用任务并发上限

状态：用户答“ok”，已收录 C07。全应用默认最多同时执行 3 个任务，其余排队，设置可调；电脑一次一任务，已知同项目独立修改串行。只管理本应用任务，具体等待与协作调度待验证。依据见 [补充问答 Q24](decision-followups.md#q24)。

### Q25：应用内 Bot 协作的连续转派上限

状态：用户答“好”，已细化 G08：最多连续转派 4 次，A→B→C→D→E，超限不继续转派；应用内规则与 Codex 原生子 Agent 限制分开。依据见 [补充问答 Q25](decision-followups.md#q25)。

### Q26：停止协作主任务时的子任务处理

状态：用户答“好”，已收录 G10。停止主任务时连同委派子任务一起停止，不影响其他独立任务；不自动回滚已完成动作。结束 Live 不取消任务。依据见 [补充问答 Q26](decision-followups.md#q26)。

### Q27：协作子任务失败时是否继续其他分支

状态：用户答“好”，已收录 G11。单个分支失败后其他独立子任务继续，由负责人处理失败与后续依赖并汇总；人工停止仍按 G10。依据见 [补充问答 Q27](decision-followups.md#q27)。

### Q28：定时任务时区是否随设备变化

状态：用户答“不考虑这个问题”，本分支暂缓，不再追问。此前固定创建时区的建议未获批准，不默认写成产品规则；时区实现细节待后续必要时处理。依据见 [补充问答 Q28](decision-followups.md#q28)。

### Q29：应用重启后是否恢复唤醒监听状态

状态：用户答“可以”，已收录 V11，补齐 Q13 的监听启用与恢复规则。首次手动开启并授权，之后恢复上次开关状态，关闭后保持关闭。依据见 [补充问答 Q29](decision-followups.md#q29)。

### Q30：默认唤醒词的称呼

状态：历史称呼先为“伟哥”再改为 cobo；Q37 用户最新将名称和唤醒词都改为 Rambo，当前按 V12。带问候语对应“你好，Rambo”，历史原话保留，实际读法与识别实现需验证。依据见 [补充问答 Q30](decision-followups.md#q30)。

### Q31：首条完整验收场景

状态：用户明确要求聊到的所有功能都能验收，已记录 P08。撤回以单条语音链路作为本轮收口目标的提问，改为建立全量验收矩阵；天气语音流程仅是其中一个跨功能用例。当前不开始应用代码或执行测试。依据见 [补充问答 Q31](decision-followups.md#q31) 和 [全量验收矩阵](acceptance-matrix.md)。

### Q32：正式应用名称

状态：本题当时确认 cobo，后续 Q37 用户明确改为 Rambo，并提供 Logo；P02/V12 已更新，项目目录同步改名为 Rambo。此处保留先前命名依据。依据见 [补充问答 Q32](decision-followups.md#q32)。

### Q33：实际需要连接的日常应用

状态：用户明确“qq邮箱跟gmail”，已收录 T10，二者均纳入连接及验收。T01/T03/T07 的复用/分配机制不变；邮件范围已按 T11 确认，接入及授权由技术调查核实，其他已定功能验收范围保持原决定。依据见 [补充问答 Q33](decision-followups.md#q33)。

### Q34：QQ 邮箱与 Gmail 的邮件操作范围

状态：用户答“ok”，已收录 T11：QQ/Gmail 均支持查收、搜索、读信总结、附件处理、起草、回复和发送。语音和文字共用 Codex 会话与邮件工具，沿用 V01/V02，不单列语音邮件功能。发送沿既定权限体系，不重新引入通用执行审批；当前讨论不构成实际发信指令。具体 QQ/Gmail 兼容与授权按 [接入核对](email-integration-research.md) 验证。依据见 [补充问答 Q34](decision-followups.md#q34)。

### Q35：同时连接两家邮箱时的发件账号

状态：用户答“可以 继续”，已收录 T12。逐 Bot 默认发件账号、回复原邮件所属账号、明确指定优先，配置交给底层 Codex 会话/工具。依据见 [补充问答 Q35](decision-followups.md#q35)。

### Q36：同一邮箱服务的多账号连接

状态：用户答“先做一个就好了。”，按同一服务单账号记录为 T13，即 QQ 一个加 Gmail 一个；不把此回复误解为只做其中一家。暂不做同服务多账号，原逐 Bot 分配及发件规则继续适用。依据见 [补充问答 Q36](decision-followups.md#q36)。

### Q37：应用 Logo 与最新 Rambo 命名

状态：用户提供并指定使用图片 Logo，同时将项目/应用名及唤醒词改为 Rambo，已更新 P02/V12。图片原样保存到 assets/branding/app-logo-source.png，项目目录同步改为 Rambo；不采用此前 c 字母机器人脸提案，Bot 头像仍按 I03 独立。依据见 [补充问答 Q37](decision-followups.md#q37)。

### Q38：群聊默认回退 Bot 的设置范围

状态：历史确认，已由 2026-10-21 [Q55](decision-followups.md#q55) 和 2026-10-22 [Q63](decision-followups.md#q63) 替代。原每群默认回退 Bot 方案不再作为现行群聊要求，任何群消息结果都不自动交给默认、第一个加入或群主 Bot；全局默认语音 Bot 继续按语音规则。历史依据见 [Q38](decision-followups.md#q38)。

### Q39：新加入群的 Bot 是否可读加入前的群历史

状态：用户答“ok”，已细化 G01 及验收条件：新加入的 Bot 可读取加入前的该群历史，首次提供近期上下文，更早记录按需查找；不自动带入其他 Bot 私聊。具体上下文窗口大小未选定。参考与确认见 [补充问答 Q39](decision-followups.md#q39)。

### Q40：定时任务的聊天与管理页入口

状态：用户答“ok”，已记录 R11 并加入验收清单：文字和 Live 管理定时任务，任务列表共用同一份配置。Live 工具接入仍需技术验证。见 [补充问答 Q40](decision-followups.md#q40)。

### Q41：Bot 主动提出长期自动化

状态：用户答“ok”，已记录 R12 并同步验收条件：明确要求定期执行直接创建，Bot 主动提出的周期任务须用户同意后创建；不改变默认 Full Access。见 [补充问答 Q41](decision-followups.md#q41)。

### Q42：暂停定时计划时如何处理已有执行

状态：用户答“ok”，已记录 R13 并同步验收条件：暂停后停止后续触发、取消尚未开始的排队执行，已经开始的本次任务继续；用户明确要求时也停止本次。见 [补充问答 Q42](decision-followups.md#q42)。

### Q43：删除定时计划后是否保留运行历史

状态：用户答“ok”，已记录 R14 并同步验收条件：删除计划保留过去的运行记录、聊天简报和成果，并可回查；不改变 B08/F02。见 [补充问答 Q43](decision-followups.md#q43)。

### Q44：Live 中通过语音切换 Bot

状态：用户答“不加”，明确排除口头切换 Bot，已同步 V01 及验收范围；原唤醒默认 Bot 与单 Bot 聊天语音规则继续适用。见 [补充问答 Q44](decision-followups.md#q44)。

### Q45：修改定时计划对已有执行的影响

状态：用户答“可以”，已记录 R15 并同步验收条件：修改只影响后续新触发，已有排队及执行中任务保留原指令，不自动中断或重跑；R13/B06 仍适用。见 [补充问答 Q45](decision-followups.md#q45)。

### Q46：一次性定时任务结束后的列表状态

状态：用户答“可以”，已记录 R16 及验收条件：一次性任务执行后保留，展示真实结果，可手动立即运行；不再按原时间自动重复，错过按 R02。见 [补充问答 Q46](decision-followups.md#q46)。

### Q47：Live 原始录音是否长期保存在本机

状态：用户答“可以”，已记录 V13 和验收条件：本机保留文字转写及任务结果，不长期保存完整 Live 录音；主动上传音频仍按附件规则。仅约定本应用本地存储，不推定服务端政策。见 [补充问答 Q47](decision-followups.md#q47)。

### Q48：语音输入输出设备选择

状态：用户答“可以”，已记录 V14 及验收条件：默认跟随系统，可固定选择设备，固定设备断开不自动切换；真实设备与合盖环境仍需实测。见 [补充问答 Q48](decision-followups.md#q48)。

### Q49：消息编辑与回复重新生成

状态：明确不做。用户先答“可以”，随后立即改为“不要了这个功能”，按最新决定排除消息编辑、回复重新生成及其对话分支切换；不列为已承诺功能、待实现事项或验收阻塞。见 [补充问答 Q49](decision-followups.md#q49)。

### Q50：语音插话与执行任务停止的区别

状态：已撤回。用户指出此题重复，插话和语音理解沿用 Codex Voice；应用只负责接通及必要的生命周期控制，不另造语音业务规则。原推荐未获批准，不新增规则或验收要求。具体接通仍属于技术验证。见 [补充问答 Q50](decision-followups.md#q50)。

### Q51：开发 Agent 的组织方式

状态：原方案已按用户额度要求修订。开发团队保留一个较强模型角色，其余主要消耗使用 Luna；用户明确子 Agent 可用 max，默认按 Luna / max 安排。推荐主 Agent 用 Sol、子 Agent 按需一个，具体主模型和强度仍为建议。角色职责与完整验收继续保留，工具允许的最大并发不作为常驻配置。见 [开发组织方案](agent-development-plan.md)、[Q51](decision-followups.md#q51) 及 [用户额度约束 Q52](decision-followups.md#q52)。本项不改变产品内 Bot 模型规则 B06，也不撤销 P06 的编码限制。

### Q52–Q64：后续决策入口

状态：新问题与确认记录保存在 [决策补充问答](decision-followups.md)，不再复制一份容易冲突的摘要。当前最新为 [Q64：Bot 通过应用 Tools 自主管理自身](decision-followups.md#q64)，已收录为 B05/B08/B13/M05/T05/T06/R13/R14 并同步验收矩阵。Q53–Q54 为验收工具与独立测试环境；Q55/Q57/Q63 为群聊判断与统一 UI；Q56 为记忆自主保存；Q58 为单 Bot 单聊；Q59–Q61 为对话生成 Routine 及其展示；Q62 为 Electron 独立 Playwright 调试端口。逐条原话、状态与历史替代关系以补充问答为准。
