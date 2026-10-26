# 2026-10-22：当前全量验收续跑与候选包复验

## 2026-10-24 当前模型与权限规则（Q97）

系统设置提供唯一应用全局模型和权限；Bot 设置只为该 Bot 的唯一私聊设置会话级覆盖，空值继承全局。群聊和 Routine 使用全局配置；不再要求 Bot 默认模型/权限或“应用到全部聊天”。下文旧 run、旧问题单与旧 Agent 分工均保留为历史记录，凡与 Q97 冲突的待办按 Q97 更新，不修改已冻结 run。

## 2026-10-24 当前 Bot Routine 可见性规则（Q104）

Bot 设置恢复“定时任务”Tab，只读展示当前 Bot 的 Routine 清单、计划、执行内容、状态、下次执行时间和最近结果；不显示其他 Bot 的任务，也不提供运行控制。全部 Routine 仍由系统设置统一管理并提供控制。旧冻结 run 不覆盖这项 B12 修订，按现行验收流程重新验证时须纳入 Bot 设置隔离与系统设置管理断言；不修改历史 run。

## 当前状态

截至 2026-10-24，产品决策与验收矩阵当前为 **126 条规则**、4 条用户旅程和 7 个发布套件。下列已登记 run 均早于当前基线，只能作为各自构建的历史证据，不再代表当前规则基线。目前没有已冻结且覆盖 126 条规则的完整验收 run，因此当前全量验收状态为“尚无现行基线”，不能报告全量通过。

最近一次冻结的开发模式 run 为 [`20261022-acceptance-final-01`](../acceptance-runs/20261022-acceptance-final-01/REPORT.md)，当时冻结 113 条规则、113 个完整规则场景、4 条核心旅程、6 个发布套件和 173 个局部案例。开发构建 epoch 1，源码指纹 `1913207f0c5fb826486956c8812509cc06056e46d46bcd0eac60d001196a0ae8`；其自身冻结 hash 保持不变，但当前产品决策、验收矩阵和测试目录已经超出该基线。

- 该历史 run 已规划并机器复验的特征门禁局部案例为 **80/80**，原始结果见 [feature-all-80](../acceptance-runs/20261022-acceptance-final-01/evidence/feature-all-80/result.json)。
- 当时的测试目录为 **173** 个局部案例，其中 **84** 个 implemented、**89** 个 not implemented；已规划集合只覆盖目录可自动执行部分，不是全部 84 个案例，也不能替代完整规则场景。
- 当时规则级结果为 **0/113**；J1–J4 与当时的六个发布套件均为 0 通过。该历史结果不能作为当前 126 条规则的通过证据。

独立 app 模式 run 为 [`20261022-package-final-01`](../acceptance-runs/20261022-package-final-01/REPORT.md)，构建为 `dist/mac-arm64/Rambo.app`，`app.asar` SHA-256 为 `ac1035326baefcddcc7ba61f7943b4e16477ca79bcbe851552dd11bc816e46b6`。该包已通过 `codesign --verify --deep --strict`，但未公证。A02-PACKAGE-01、A02-PACKAGE-02、A05-PACKAGE-01、A05-PACKAGE-02 四个局部案例为 **4/4** 有效通过；A02/A05 规则仍因隔离安装、真实授权任务、Computer Use 分发、升级隔离等条件未验证而保持 incomplete。

发布门禁已实际运行，退出码为 **1**，在测试执行前报告 76 条规则无已实现测试和 89 个未实现案例，日志见 [release-gate.log](../acceptance-runs/20261022-acceptance-final-01/evidence/release-gate.log)。主要剩余缺口包括 R07–R09/R12/R15、G05–G11、C01–C07、T01/T03–T13、I01–I05、F01–F05、O02–O04/A06、J4 V01–V14，以及 R13 的 G10 协作树级联停止。旧 run 和旧包 hash 仅保留历史，不改写、不计入当前通过。

## 前一批实现层补充（历史，非当前 run）

以下数字属于该 run 冻结时的历史快照，已被上方当前状态替代。当时完成了不依赖 Computer Use 的 J1 快速证据闭环：验收执行器的 Playwright 规则筛选已修通；Runtime、Host、SQLite 与真实源码 Electron 的局部案例已运行；候选 `.app` 的资源、签名和包内 App Server 启动也已由自动测试验证。当时目录为 113 条规则、168 个局部案例（71 个有实现证据、97 个明确缺口），规则级仍为 0/113。B06/B13/G01 增强及既有群添加成员后，当时记录为类型检查通过、后端 67/67、目录与门禁 16/16、台账 18/18、真实 Electron 12/12。详见 [实施进度](implementation-progress.md#2026-10-22b06b13-闭环增强与-g01-群历史工具)。

上述证据尚未写入 `20261022-full-q64-01` 的冻结 case 与 epoch；正式 run 需在下一批源码修改后重新登记 build，再按现有 case/证据流程机器复验。候选包已签名但未公证，且仍缺无外部 Codex 的隔离安装、真实登录任务、真实原生 Codex 并行及两套运行时升级隔离。

用户通过 [Q55](decision-followups.md#q55) 修改 G02–G04/G06，通过 [Q56](decision-followups.md#q56) 将记忆改为 Bot 自行整理保存、无需确认；通过 [Q57](decision-followups.md#q57) 明确群聊与单聊统一样式及组合头像；通过 [Q63](decision-followups.md#q63) 取消任何固定默认 Bot 兜底；并在 [Q64](decision-followups.md#q64) 开放 Bot 通过应用 Tools 自主管理自身资料、配置、记忆和 Routine，同时禁止自我归档、永久删除与清空聊天。产品决策和验收矩阵已更新，`20261022-full-q63-01` 的冻结基准现已失效，更早 run 同样只保留历史。恢复全量验收须按现有 Skill 创建冻结更新后基准的新 run，引用旧问题和历史证据；不得改写旧 run hash，也不得把旧的集中路由、默认兜底、记忆批准或长期指令批准结果用于新规则通过。

历史 run [`20261022-full-q68-01`](../acceptance-runs/20261022-full-q68-01/REPORT.md) 冻结 113 条规则、4 条核心旅程与当时的 6 个发布套件，开发构建 epoch 1，源码指纹 `561371321d5a74d1502233c3f2912c3277f0f14b276a05bcbe57693833d875ad`。该 run 已规划并机器验证 B06-ELECTRON-01、B13-ELECTRON-01、G01-HOST-02、G01-HOST-03、G01-ELECTRON-02 五个局部案例；当时规则 0/113，全量未通过。该 run 不覆盖新增 G12/S01、P09 与运行时获取规则。下一步需按现行 126 条规则创建新的冻结基线后再执行全量验收，不能把局部案例或旧 run 通过写成规则通过。旧 run `20261022-full-q66-01`、`20261022-full-q64-01`、`20261022-full-q63-01` 只保留历史，不改写其冻结 hash。

# 2026-10-21 epoch 7 最新续验状态（Q55 变更前历史）

以下状态来自 `acceptance-runs/20261021-resume-02` 最新台账，优先于下方 epoch 6、epoch 5 及更早历史。产品决策和验收矩阵基线未变。

- 当前开发构建 epoch 7：`99283f2bbb33a7cb7fed3830d549e001069308b88a7b742fd0538aa6e0f5e5fe`。最新报告时间 2026-10-21 11:59:18 UTC：coordinator 在当前构建复验通过 8/62 子案例；规则 0/111 通过，跨功能流程 0/10 通过；全量通过仍为否。
- `P03-DB-PERSISTENCE-RESTART-E7-02` 由 tester 和 coordinator 独立通过：按修正计划读取完整 36 字符 Bot UUID，确认夹具 Bot、chat.botId 关联一致；本 run 同 profile 重启前后，Bot/chat 的 ID、关系、标题、归档状态、0 条消息及 Bots/Chats=5/7 均一致。只覆盖指定本机数据库记录持久性，不代表 UI 恢复或 P03 完整。
- `P03-DB-PERSISTENCE-RESTART-E7-01` 保留 tester 原始观察，但 coordinator 按登记计划将其复验记为 blocked：计划 Bot UUID 少一个字符，精确查询没有该行；没有据此重启或判通过。tester 随后说明执行脚本手动用了正确 UUID；该案例计划/证据文本不一致，修正后的 E7-02 单独留证，不覆盖旧文件。
- `A01-OWNED-SERVER-LIFECYCLE-E7-01` 由 tester 与 coordinator 在 epoch7 独立通过：只对精确匹配本 run 的 Electron 发 SIGTERM，其项目 App Server 随之退出；同 run/profile/hash 重启后建立新的 Electron 与直接管理的 App Server，外部 Codex PID 保持。未执行原生 Codex 任务比较，A01 整体仍 incomplete。
- `P08-GATE-E7-01` 由 tester 与 coordinator 通过：Q31/P08 要求全部已确认功能逐项验收；当前报告仍是 0/111 规则、0/10 流程，全量通过为否。该项只验证门槛记录与报告，不覆盖所有规则，P08 整体仍未完成。
- `ISSUE-0012` 的 epoch7 源码修复已登记：新建单 Bot 文字线程可通过动态工具保存例程定义并在列表查询，同一工具调用按 callId 去重；旧线程和群聊不开放该工具，界面明确标注当前不会自动触发或执行。`node --test tests/backend/*.test.mjs` 28 项通过，`npx tsc --noEmit` 和 `npm run build` 通过。这些是实现检查，尚未完成 `R11-TEXT-CREATE-01` 的产品 UI/运行时复验；没有 scheduler、Live 或计划执行证据，R11 仍不完整。
- P05/P06 本轮文档窄案例由 tester 与 coordinator 分别通过：P05 只确认当前 checkout 的 Rambo 身份和 Electron/React/TypeScript 源码组织，未现场验证旧目录去向或最终视觉，P05 仍 incomplete；P06 确认“开始吧”是实现授权，不是功能或全量验收通过。W01/W03/W04 文档抽查通过；W02 因缺少可复核的原始子 Agent 调用/返回 artifact 和 F01 运行证据受阻。
- 当前 epoch7 实例使用 run 独立 profile，coordinator 最近一次受控启动为 Electron PID `60021`、项目 App Server PID `60026`；启动器会话 `1032` 仍运行。2026-10-21 11:54–11:57 UTC 再取 CUA 新鲜状态仍只有应用清单、无窗口/AX/tab，`getApp("Electron")` 超时 120 秒；已停止 UI 操作链，详见 [CUA epoch7 状态记录](../acceptance-runs/20261021-resume-02/evidence/CUA-EPOCH7-INSTANCE-60021-ATTACH-TIMEOUT.md)。进程启动不代表 UI 就绪。G01 消息入口及 `ISSUE-0011` 仍待有效运行时复验。
- 当前结论和逐项证据见 [REPORT](../acceptance-runs/20261021-resume-02/REPORT.md)、[cases.json](../acceptance-runs/20261021-resume-02/cases.json) 及对应 `evidence/` 文件。继续执行不依赖桌面的案例；只有 CUA 工具或可记录的窗口状态发生变化后再恢复 UI 验收。

## 2026-10-21 epoch 6 续验状态（历史）

以下状态来自 `acceptance-runs/20261021-resume-02` 最新台账，优先于本文件下方保留的 epoch 5 及更早历史。产品决策和验收矩阵基线未变。

- 当前开发构建 epoch 6：`031afab9270f6142cfbed8a2cf75169598c23197ecc3399f7ecac5ed63302255`。最新报告时间 2026-10-21 11:03 UTC：coordinator 在当前构建复验通过 9/52 子案例；规则 4/111 通过，跨功能流程 0/10 通过；全量通过仍为否。
- 本轮补验：W01、W03、W04 的文档/工作流程抽查由 coordinator 复验通过；W02 因缺少可复核的历史子 Agent 原始调用/返回 artifact 和 F01 运行证据而受阻。以上是文档抽查，不是产品运行结果。
- `A01-OWNED-SERVER-LIFECYCLE-E6-01` 由 tester 与 coordinator 独立复验通过：对精确匹配本 run 的 Electron 进程发 SIGTERM 后，其项目内 App Server 子进程退出；启动器重开后出现新的 Electron/App Server PID。A01 要求的原生 Codex 同时启停及任务隔离尚未覆盖，因此 A01 规则仍未完成。
- `A01-CLIENT-PROCESS-ISOLATION-E6-01` 由 tester 与 coordinator 独立复验通过：在 9 个外部 Codex PID 同时存在时，分别停止并重启精确匹配本 run 的 Electron；Rambo 自带 App Server 随其退出并由重启进程重新建立，外部 PID 与命令身份保持不变。没有启动或比较原生 Codex 任务，A01 仍未完整。
- `P03-DB-PERSISTENCE-RESTART-E6-01` 由 tester 与 coordinator 独立复验通过：同一 run/profile 重启前后，预登记测试 Bot/chat 的精确 ID、关系、标题、归档状态、0 条消息及 5/7 Bot/Chat 总数一致。只验证本机数据库记录持久性；不代表 UI 恢复、登录入口、任务/设置/记忆或 P03 完整通过。tester 原证据中的一处 chat UUID 转录错误已通过附加 correction 留证，原文件未改。
- `G01-MESSAGE-ENTRY-E6-01` 最新 CUA 复验发生于 10:50–10:52 UTC 的 Electron PID `8841` / App Server PID `8846`：新鲜 state 未提供窗口标题；`getApp("Electron")` 等待 120 秒超时，没有 AX/截图。tester 和 coordinator 已在多次真实 app 重启后的新实例上遇到同一超时，见 `evidence/G01-MESSAGE-ENTRY-E6-01-coordinator-final-timeout-epoch6-20261021.md`。按 skill 停止该 UI 链；等待 CUA 服务重新提供窗口/AX 状态，不因普通 app 进程重启重复尝试。没有创建群聊、消息或 turn，也没有修改产品数据。`ISSUE-0011` 仍待有效运行时复验。
- 本轮未修改产品源码或冻结决策；没有重建 epoch。当前结论和逐项证据见 [REPORT](../acceptance-runs/20261021-resume-02/REPORT.md)、[cases.json](../acceptance-runs/20261021-resume-02/cases.json) 及相应 `evidence/` 文件。后续继续拆解和执行不依赖桌面的案例；只有 Computer Use 状态有新的、可记录变化时才恢复群聊 UI 验收。

# 2026-10-21 本轮续验（进行中）

- 当前 run 为 `acceptance-runs/20261021-resume-02`，承接 `20261021-full-01`，使用独立 profile/fixtures；冻结的 `docs/product-decisions.md` 与 `docs/acceptance-matrix.md` hash 未变。
- 当前验收固定使用 Electron Vite 开发模式，epoch 5 源码指纹为 `1148211e3e3270ecb00d2598f0d97361745a45c784f4f0852097244aa9ac4034`。PID 93076 因意外模型 turn 于 06:55 UTC 停止；PID 3658 随后用 `RAMBO_ACCEPTANCE_RUN` 指向本轮目录重启，07:02 UTC 进程仍在运行。Computer Use 已确认窗口标题 `Rambo · 验收 20261021-resume-02`、页面地址 `localhost:5173/`。Electron、Codex/App Server 与 macOS 运行信息见 `evidence/dev-runtime-epoch5.json`。epoch4 打包版仅作为历史；当前不打包。
- epoch5 登记使之前的验收复核不再算当前构建通过。最新报告（2026-10-21 07:18 UTC）为 2/32 子案例由 coordinator 复验通过、规则 1/111、流程 0/10；`P06-DOC-01` 与仅覆盖源码身份的 `P05-SOURCE-01` 通过，P05 仍 incomplete，全量通过仍为否。epoch4 最后报告曾记录 22 个子案例中 5 个复验通过、4 个失败、1 个受阻。
- epoch4 coordinator 已独立复验 `G01-ENTRY-01`、`G01-CANCEL-01`、`G01-CREATE-01`、`G01-PERSIST-01`：真实群聊入口/候选、取消无写入、成员 B→A 且 B 为默认、本机持久化和同 profile 正常重启后重开均有 CUA 与只读 DB 证据。修复 Agent 核实原修复仍在 epoch4 包内并补记后，coordinator 在该记录之后重新复验入口，`ISSUE-0004` 已复验通过。G01 拆解仍不完整：共享上下文、加入前群历史、群聊消息、路由、多 Bot 回复和委派未实现，不能判整个 G01 通过。
- `R11-ENTRY-01` 在 epoch4 通过 coordinator 复验：侧栏任务列表显示空态，并明确说明创建/执行尚未接入；没有创建或触发任务。`ISSUE-0005` 状态为复验通过，但这只覆盖入口/空态，不代表 R11 完整。
- R11 的文字/Live 创建、修改、暂停/恢复、列表手动调整、跨入口同步及含糊指令澄清已拆成 7 个后续 case，并已追加到本轮台账；尚未执行。任务创建/触发先核实产品安全的 no-op/dry-run 路径；若任务页仍明确说明未接入，创建案记 fail，依赖案例按计划记录 blocked，不发可能触发外部副作用的任务。
- `V06-ENTRY-01` 与 `F03-ENTRY-01` 在 epoch4 由 tester 和主 Agent分别复核失败：设置缺唤醒/监听入口，Bot A 资料缺文件入口；`ISSUE-0006/0007` 仍开放。未申请麦克风/辅助功能权限、未修改监听、未打开文件或读取聊天正文。
- B07/B08 的 epoch4 失败已由修复 Agent 完成实现并登记 epoch5 指纹：聊天改名/归档/恢复与 Bot 归档/恢复入口，以及相关 SQLite 持久化。实现测试和 TypeScript 检查通过。epoch5 tester 将较宽的 `B07-01` 与 `B08-01` 记为 blocked；coordinator 对 B07 独立确认仍受阻。此后 coordinator 在 Bot A（readOnly）上实际完成新增窄案例所需的聊天改名、聊天归档/恢复、Bot 归档/恢复，并用只读 SQLite 确认原 ID 关联及无消息变化；证据见 `evidence/B07-B08-lifecycle-coordinator-epoch5.md`。独立 tester 后续获取了正式 CUA 方法签名，但同一 `getAXStateAndScreenshot` 中 AX 从全局设置切到 Bot A/聊天视图时，截图持续停留在全局设置页；两窄案因此在当前 epoch 仍为受阻，coordinator 已复验 blocked。见 `evidence/B07-CHAT-LIFECYCLE-01-epoch5-ax-screenshot-mismatch-20261021.md`、`evidence/B08-BOT-LIFECYCLE-01-epoch5-ax-screenshot-mismatch-20261021.md` 与 `evidence/B07-B08-coordinator-ax-screenshot-mismatch-epoch5.json`。测试员补充首次分歧后误点一次空聊天行；没有触碰 composer/发送/输入，Bot A 数据前后未变；该偏差已记录，后续停止 UI 操作。主 Agent早先的成功观察保留，但不替代此次独立测试。B07-02 仍须先具备两条本轮有内容聊天及记忆标记；不得执行永久删除。B08 的周期执行器和创建安全 no-op 仍未实现，不能宣称例程暂停/调度通过。
- epoch5 启动前只读 profile 基线为 2 Bots、3 空聊天、0 消息、0 记忆、0 例程。随后 SQLite 发现 Bot B 的既有聊天 `nih` 新增一条 user 消息和 assistant 回复；turn 在 `2026-10-21T06:53:21Z` 开始，权限快照为 Full Access/`approvalPolicy=never`/`dangerFullAccess`，服务端解析模型为空。tester 表示未输入或发送 `nih`，当时 AX 与截图映射有偏差，具体来源未知；当前证据不能确认或排除工具调用。详见 `evidence/B07-01-epoch5-coordinator-incidental-turn.md`。原 Bot B 数据保留且未再触碰；后续仅在重新读取精确 AX/页面状态后对 Bot A 执行可逆生命周期检查，没有聊天输入或模型请求。
- 验收技能、台账与启动器现已默认开发模式；开发指纹排除 profile 和生成目录，源码变更后需登记新 epoch 并重启。技能台账测试 15 项通过，启动器语法检查与台账脚本编译检查通过。包专属矩阵案例仍可单独选择 `.app`。
- 07:24 UTC 协调者尝试只读重连时，CUA 按 Electron bundle 路径误选了 Electron 自带 `default_app.asar`，而不是 Rambo；fresh AX 与截图一致显示默认演示页。该页没有产品交互。协调者终止由此次选择启动的 PID 24576，未检查或清理 Electron 默认用户数据；原 dev PID 3658 和 5173 listener 当时已不存在。事件详见 `evidence/coordinator-cua-default-electron-misselect-epoch5.md`。修复 Agent 对 ISSUE-0001 的只读源码诊断未确认根因、未改源码；需取得正确验收窗口的新鲜运行时证据。
- dev 实例通过验收启动器以 PID 26305 重启后，tester 确认窗口标题、`localhost:5173/` 与 AX/截图一致，并独立重测 B07/B08 两条窄生命周期案例。主 Agent 随后重新执行改名、聊天归档/恢复、Bot 归档/恢复，并对同 ID/归属及消息、turn、记忆、例程等作只读 SQLite 复核。coordinator 证据见 `evidence/B07-CHAT-LIFECYCLE-01-coordinator-epoch5.md`、`evidence/B08-BOT-LIFECYCLE-01-coordinator-epoch5.md`；待脚本 verify 登记。唯一标记为 `RBO-R02-B07-COORD-E5-01`，目标 chatId `a338787e-8471-42ba-be48-bd7b027db493`；Bot A 最终已恢复活动状态。
- `B06-01` 的全局继承模型前置仍不满足：epoch5 意外 turn 的请求模型为 `gpt-6-luna`、来源为 global，服务端解析模型为空；该轮不是 B06 测试，不能作为验证或模型路由证据。`B06-01` 保持未执行/受阻，逐轮模型解析仍缺。
- `B04-01` 在 epoch2 记录为 blocked：AX 与截图显示创建表单、云朵/蓝色选择对应蓝色预览，取消后无新增数据；Bot A/B 已是本轮样本，未据部分观察宣称完整创建通过。`ISSUE-0001`、`ISSUE-0002`、`ISSUE-0003` 仍开放；epoch2 相关通过在 epoch4 不计入当前构建。`T06-01` 仍需真实权限和文件操作闭环。
- R11 全量仍包含文字与 Live 创建、修改、暂停/恢复及列表共用同一配置；当前入口子案例不代表通过完整 R11。其余规则和 E01–E10 仍待拆解或执行，不以局部通过缩减范围。

下文为之前阶段历史，冲突时以本节和当前 run 台账为准。

---

# 2026-10-21 最新续作状态（以下为最新事实）

- 三个 Luna/max 子 Agent（foundation_review、grok_ui_baseline、acceptance_forward_check）均因 usage limit 中断；Goal 接口当前返回 **usageLimited**，并非 complete 或用户暂停。没有自动换用更贵模型。
- 已登记 **13** 个案例；epoch1 tester 观察为 10 pass、2 fail，P02-02 尚无 tester 正式记录。tester 观察不等于主 Agent 最终验收。
- 主 Agent 本次用 Computer Use 独立确认并登记 **T06-01 fail**：聊天输入区仍缺权限显示/切换。设置点击未产生 AX 导航，不当作进入设置成功。
- 真实截图可见指定战士头像，三个导航按钮仍位于整窗右上；本次没有取得同尺寸 Grok 截图，不将局部头像观察当完整 P02 通过。
- epoch1 app.asar SHA-256 本次重算仍为 `1007b049dbe995b01fac1584ee592e2fceb6982dc279018111498876fb9edcf8`。没有构建覆盖现有包。
- 当前 Computer Use 目标标题为 `Rambo · 验收 20261021-full-01`。桌面操作权已收回主 Agent，当前没有子 Agent 操作 UI。
- profile 出现首批测试以外的新 Bot 与用户消息，保留原样；不得当可删除夹具。模型自报身份和聊天中“提醒已设置”均不是底层实际模型/调度执行证明。

## 未完成修改及恢复顺序

1. foundation_review 的 contracts/store/host 改动只部分落盘。`npx tsc --noEmit` 失败：host.ts:389 UUID 推导类型不匹配，preload 缺 `applyBotPermissionToChats`、`turns`。IPC/preload/renderer 未接完；host 通知分支也未完成逐轮元数据与重路由处理。不能只修类型就宣称完工。
2. grok_ui_baseline 的 renderer 修复尚未完成；继续聊天权限/模型入口、显式应用全部、运行详情及导航位置，保留指定头像。
3. acceptance_forward_check 的 `plan-docs-chat.json` 尚未产出；421 条机械条件只保留为 coverage-index，不能充当可执行或完整覆盖计划。
4. 额度恢复后沿原 Luna/max 线程继续，核对 API 并完成必要测试；主 Agent 审查后统一构建 epoch2、登记 build，tester 复测、主 Agent独立复验。不得把本次主 Agent 检查冒记为 fixer 完成。
5. 先由 tester 根据已有 P02-02 证据补 record/issue；不能由主 Agent冒用 tester 身份。ISSUE-0001 尚欠完整关闭/重开独立复验，ISSUE-0002/0003 均未修复关闭。
6. 继续其他全量功能与具体案例拆解；不改活跃 run 已冻结决策/矩阵，不因额度限制缩减范围。

本次证据：`acceptance-runs/20261021-full-01/evidence/coordinator-ui-review-20261021.json`、`evidence/interrupted-source-review-20261021.md`。Skill 台账 12 项单元测试本次再次通过，不代表产品全量通过。

---

# 以下保留上一阶段记录，冲突处以上述最新状态为准

# 当前持续验收任务

用户已设持续目标：Skill 完成后直接执行，启动声明的 Agent 测试、另一 Agent 修复、主 Agent 验收；用户休息期间继续。Goal 状态 active，未完成全部验收前不要标 complete。

## 当前真相

- 项目 `/Users/yuanjiawei/ai-coding/Rambo`，所有回复中文。
- Skill `.agents/skills/rambo-acceptance/SKILL.md` 已实现；结构验证通过，台账 12 项单测通过，独立前向复测通过。修过证据改写/删除仍误报通过的真实漏洞。
- 正式 run `acceptance-runs/20261021-full-01`：111 条规则 + 10 个 E 流程。当前已登记首批 12 case，完整 Fxx 提案仍在编写。
- 当前构建 epoch1，app.asar SHA-256 `1007b049dbe995b01fac1584ee592e2fceb6982dc279018111498876fb9edcf8`。使用独立 profile/fixtures/evidence，复用认证但不复制或修改日常认证。
- ISSUE-0001 是真实打包启动 bug：运行时 `app.dock.setIcon(ICNS)` 抛错中断 whenReady，根因 stderr 已留证。另一 Agent 已改成仅 dev 加载 PNG，打包沿原生 bundle ICNS，并补启动 catch；新包已构建、fixer 记账、主 Agent 登记 epoch1。
- 新包测试 PID21896，CUA 可读精确标题 `Rambo · 验收 20261021-full-01`，Store 在本 run 下实际生成数据库。主 Agent 已独立读取 UI 并实际查看截图，确认左下是指定战士头像。证据 `evidence/coordinator-startup-avatar-epoch1.json`，截图保留工具历史、没有伪造落盘图片路径。
- ISSUE-0001 尚未由主 Agent 完成原登记 P01 全部关闭/重开步骤复验，不能提前关闭。首批一些新观测已通过，但不是最终验收通过。
- tester 新报 ISSUE-0002：缺少聊天权限显示/当前聊天覆盖/应用全部；ISSUE-0003：缺每轮模型可核验记录。当前真实可选的测试模型为 `gpt-5.6-luna`，不要为了符合工具别名擅自切更贵模型。

## Agent 分工与操作权

- `rambo_acceptance_tester`（Luna/max）：当前独占 Computer Use，按已登记12case继续实际测试；先空搜索，再创建两Bot/模型设Luna，两次无副作用标记请求共用于B02/B06，再关闭/重开与恢复。只写测试证据/问题，不改产品代码或verify。
- `foundation_review`（Luna/max）：正在修 ISSUE-0002/0003 后端，独占 contracts/store/host/index/preload，可新增必要后端测试；禁止改 renderer/打包/进程干扰，先发API契约，后续由另一Luna接UI。每轮requested/threadResolved/rerouted分清，不伪造实际模型；Chat model/permission null继承，提供显式apply-all。
- `acceptance_forward_check`（Luna/max）：初稿421个Fxx大多机械按分号分条件，主Agent已拒绝将其当可执行计划/complete。该Agent正保留成 `coverage-index.json`（complete=false）、修正summary，并只细化P05/P06/W01-W04文档审核与B07/B08具体chat管理case到 `plan-docs-chat.json`；不自行登记、不操作桌面。
- `acceptance_ledger`（Luna/max）：Skill脚本作者与修复者，12单测通过，当前空闲。
- 主 Agent：规划审查、登记新构建、复验、最终报告。桌面由测试者明确交回后才能使用，复验后明确交还。

## 继续顺序

1. 先收取当前测试/规划 Agent 消息，不重新做全量反编译。
2. 检查 tester 当前epoch真实结果与新问题；交另一Luna修复。修改按批次构建并由主Agent `ledger build` 登记，旧结果自动失效；测试者新观测后主Agent再真实复验。
3. 审查完整Fxx提案的逐规则覆盖，登记计划；不要只看case数量就确认拆解完整。
4. 已缺失的产品功能仍是失败/待实现，缺账号、组件、真实合盖等条件记受阻；不因用户休息自行改范围，也不向未知邮箱发信。
5. 继续到全部已定条件真实通过，或只剩反复确认的外部阻塞且无法做有用工作。Goal blocked 需同一阻塞连续至少三轮；有可继续的实现/验证就保持 active。

当前已登记 case 以 `cases.json` 为准。tester 的后续 plan-batch-ui.json 微调发生在登记后，不能覆盖旧case；旧blocked历史有效。新完整计划用 Fxx ID 避免冲突。
