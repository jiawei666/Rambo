# 实施进度

## 2026-10-22：当前 dev 局部案例与候选包复验

- 当前开发模式验收 run 为 `acceptance-runs/20261022-acceptance-final-01`，冻结产品决策、验收矩阵和测试目录基线；dev epoch 1 源码指纹为 `1913207f0c5fb826486956c8812509cc06056e46d46bcd0eac60d001196a0ae8`。
- `npm run verify:fast` 在目录描述修正后通过：类型检查通过、后端 **79/79**、验收脚本 **16/16**、目录边界 **173/84/89**、台账 **18/18**。完整功能门禁执行 **80** 个局部案例并通过，原始结果与输出分别位于 `acceptance-runs/20261022-acceptance-final-01/evidence/feature-all-80/result.json` 和 `output.log`。
- 局部案例通过不等于规则通过。当前规则仍为 **0/113**，113 个完整规则场景尚未逐条完成；J1–J4 和六个发布套件也未通过。89 个 not implemented 案例继续作为发布阻塞。
- 从当前源码重建 `dist/mac-arm64/Rambo.app`，`app.asar` SHA-256 为 `ac1035326baefcddcc7ba61f7943b4e16477ca79bcbe851552dd11bc816e46b6`，应用签名严格验证通过但未公证。独立 app run `acceptance-runs/20261022-package-final-01` 已机器验证 A02-PACKAGE-01/02 与 A05-PACKAGE-01/02 四个局部包案例；A02/A05 的隔离安装、真实授权与模型任务、Computer Use 分发和升级隔离仍未验证。
- `npm run verify:release -- --sections J1,J2,J3,J4,connections,files,recovery,scheduling,interface,workflow` 退出码为 **1**，在测试前因 76 条规则无已实现测试及 89 个未实现案例被拦截；日志见 `acceptance-runs/20261022-acceptance-final-01/evidence/release-gate.log`。这不是发布验收通过。

## 2026-10-22：B06/B13 闭环增强与 G01 群历史工具

- `B06` 的真实 Electron 案例现在从当前 App Server 模型目录选择一个实际存在的模型，验证 Bot 默认模型、默认权限、唯一私聊模型与权限覆盖、A/B 范围隔离以及同 profile 重启持久化。尚未启动真实推理轮次，因此执行中快照、全局默认解析和实际 thread 模型仍未证明。
- `B13` 的真实 Electron 案例扩展为资料和配置写入、私有记忆新增与删除、Routine 创建/修改/暂停/恢复/删除、详情和全 Bot 总览回读、重启后回读。所有写入经验收专用事件进入真实 Host 处理器，未直接写数据库；仍未证明真实 Codex 自主选择工具、下一轮真实模型行为、群聊身份同步和 R14 删除历史。
- `G01` 的 Host 案例证明群成员会话仅获得 `rambo_group_history.read_history`，近期上下文默认有界，更早的当前群消息可按需查询，Bot 私聊和其他群不可读，跨群游标被拒绝。产品内添加既有群新成员的界面流程、真实模型自主调用历史工具和真实群聊旧事实旅程仍保留为缺口。
- 既有群添加成员已补齐：群聊标题新增“成员”入口，通过真实 Store/IPC/renderer 路径追加 Bot，保持成员顺序和已有消息；真实 Electron 验证组合头像及重启持久化。新成员的 Host 案例进一步证明其使用独立群成员会话，不读取自己的私聊，并能从当前群历史工具按需查到加入前事实。
- 当前目录为 **168** 个局部案例（**71** 个有实现证据、**97** 个明确缺口），有局部证据的规则 30 条，规则级通过仍为 **0/113**。最新完整校验结果：类型检查通过，后端 **67/67**，目录与门禁 **16/16**，台账 **18/18**，真实 Electron **12/12（55.8 秒）**，定向门禁 19 个局部案例通过。这些是当前源码构建的局部测试结果，不是发布验收通过。

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
- `npm run runtime:prepare`：固定 App Server **0.163.0**，归档 SHA-256 匹配后解包；未复制用户认证文件。
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
- P03 的只读数据库持久性窄案例由 tester 与 coordinator 独立通过：本 run 中预登记 Bot 和空白 chat 在同 epoch6 profile 重启前后保持相同 ID、归属、标题、状态、消息数及 Bot/Chat 总数。此项不证明 UI、任务、设置、记忆或登录条件。
