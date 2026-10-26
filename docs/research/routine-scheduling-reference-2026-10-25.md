# Routine 调度成熟做法与 Rambo 功能缺口

日期：2026-10-25。范围：对照消费级 AI 任务产品、通用调度器和 macOS 本机生命周期，审查 Rambo 已确认的 Routine 规则与当前实现。本文是调研资料，不新增、修改或追认产品决策。

## 结论

1. 用户最终选择在同一条每日 Routine 内配置多个任意 `HH:mm`，而不是新增通用分钟 interval；例如一天内可设置 `00:00`、`01:30`、`04:50`。用户说“每 30 分钟”时，应表达为同一条任务的全部离散时刻或明确拒绝，不能拆成多条 Routine，也不能静默按 `daily` 保存成一天一次。
2. 最大缺口不是再多几种触发器，而是缺少成熟调度器都具备的执行治理：持久化的 occurrence、attempt 和幂等键，超时，可恢复错误的重试，启动/唤醒恢复，完整运行历史，以及通知与去重。
3. R06 的 Skip 策略、R02/R03 的 12 小时补跑、独立执行上下文和结果回交，本身已经比不少消费产品的公开说明更完整，应保留，不应为了“对齐大厂”改成无界排队或并发执行。
4. 事件触发和 Webhook 已在 T22、T04、R10 及 Q140 中明确从首版移除，不属于当前实现遗漏。若未来重启，必须另立产品决策并同时设计认证、事件 ID、幂等、重放、存储与不可达边界。
5. 当前已有数据核验证据：本机 `routines` 中一条真实任务的 `schedule` 为“每天每 30 分钟 09:00”，但结构化定义为 `frequency=daily`、`time=09:00`，实际是每天 09:00 一次；另一条 2026-10-22 的一次性运行至今仍为 `running`，说明启动恢复没有完成对应闭环。

## 2026-10-25 实现更新

以下更新覆盖本文后续“当前实现核对”与 P0 清单中 R17、O04 的实现前状态；其余缺口仍按原调研结论保留。

- **R17 已实现核心路径**：同一条每日 Routine 持久化有序去重的 `times`，覆盖创建、更新、调度、运行快照和列表展示；occurrence 按 Routine 与计划时刻抢占，更新时不改已开始运行的快照；旧 interval/未知周期 fail-closed。真实 Electron 用例覆盖一条任务展示以及两个离散时刻分别触发。macOS 睡眠/唤醒和设备时区变化仍需系统级复验。
- **O04 已实现 Host/SQLite 路径**：普通 turn 在重启后核对并中断，明确仍排队的聊天消息持久化后继续派发，派发中而结果未知的消息停放等待用户。Routine 只在可证明尚未提交时自动恢复，并以 SQLite 计数限制最多一次；可对应到服务端仍运行的 turn 会继续跟踪，已中断但无法证明外部结果的 run 进入 `needs_user` 并暂停整条计划。
- **人工处理入口**：用户在任务页明确选择“已检查，恢复计划”后，计划才重新启用；旧 run 留为 `interrupted`，原错误原因和未确认结果保留在运行记录中，不会自动重放该次动作。Bot 不能绕过此用户确认直接恢复。
- **本轮定向证据**：类型检查通过；Host、Scheduler、Store 三个后端文件 141/141；验收结构 16/16；目录校验覆盖 146 条规则、223 个案例；Electron 构建通过；真实 Electron 多时刻关窗触发用例 1/1。此结果是局部实现验证，不是发布验收。
- **验证边界**：Host/SQLite 使用 FakeRuntime 验证进程重建、服务端历史分支、一次恢复上限和确认恢复；这不等同真实 App Server 被强制终止、macOS 睡眠/唤醒或连接器外部副作用回执验收。

## 一、成熟产品与调度系统对照

### 工程级调度器

| 系统 | 调度表达 | 重叠/错过/超时/重试 | 时区与恢复 | 管理与运行审计 |
| --- | --- | --- | --- | --- |
| GitHub Actions | POSIX cron；最短每 5 分钟；默认 UTC，可指定 IANA 时区 | 并发组可限制或取消；调度本身无通用补跑；高负载可延迟甚至丢队列；Job 有超时，失败通常手动重跑 | DST spring-forward 跳过的时刻顺延到下一有效时间 | 可停用 Workflow；保留 run/job/step 状态和日志 |
| Make | 固定间隔、一次、每日、工作日、每周、每月、指定日期、按需；每日可配置多个时刻 | 可选择顺序或并行；失败可保存 Incomplete Execution；部分错误使用指数退避；支持手动重试 | 组织时区决定执行，用户时区主要影响显示 | 有执行历史、日志、未完成执行和手动/自动重试 |
| Temporal Schedule | Interval、Calendar、Cron 可组合；可设 phase、起止时间、排除日期、最大次数 | 默认 Skip；还有 BufferOne、BufferAll、CancelOther、TerminateOther、AllowAll；Catch-up Window 和 Backfill 显式分开 | 默认 UTC，可选 IANA | Pause/Unpause、Trigger、Backfill、Schedule 状态、Action 结果、last success 和指标 |
| Kubernetes CronJob | 五段 cron；可指定 IANA `timeZone` | `concurrencyPolicy` 为 Allow/Forbid/Replace；`startingDeadlineSeconds` 决定迟到多久仍运行；超时和重试交由 Job | 未指定时区时使用控制器本地时区；非法时区停止创建并产生明确事件 | `suspend` 暂停；成功/失败历史分别有保留上限；`active`、`lastScheduleTime`、`lastSuccessfulTime` 可查 |
| launchd | `StartInterval` 固定秒间隔；`StartCalendarInterval` 日历字段 | 没有业务级统一重叠策略；`StartInterval` 在睡眠期间错过的触发跳过；`StartCalendarInterval` 睡眠错过可在唤醒后补一次，关机期间不补 | 使用系统本地时间；唤醒后的行为受硬件和电源状态影响 | 以 stdout/stderr 和系统日志为主，没有业务级运行历史 |
| n8n Schedule Trigger | 秒/分/时等单位间隔，或自定义 cron | Workflow 可设超时；失败执行可按原版本或当前版本手动重试；停机期间调度器会合并，但不是产品级补跑设置 | Workflow 时区；官方调度器按本地墙钟解释 cron | Workflow 可启用/停用；执行列表和状态可查 |

### 消费级 AI 任务产品

| 产品 | 公开调度能力 | 管理、历史与边界 | 对 Rambo 有价值的点 |
| --- | --- | --- | --- |
| ChatGPT Scheduled Tasks | 一次性、周期、监控和部分事件任务；免费/Go 每天最多一次，合格付费方案每小时一次 | 独立 Scheduled 页；可暂停、恢复、编辑、删除；通知可选推送/邮件；活跃任务有数量上限；不活跃或关联聊天删除可能自动暂停 | Task、Schedule 和“本次运行”分层；结束条件；通知偏好；缺数据策略 |
| Microsoft Copilot | Scheduled prompts 可设时间、频率和运行次数，最多 10 个；Tasks/Cowork 可暂停、停止、编辑和删除 | Run now；结果显示在聊天区；敏感动作可能等待审批；Workflows 是独立编排层 | 最大运行次数；Run now 与周期计划分开；审批边界 |
| Google Gemini Tasks | 一次性、每小时、每天、每周、每月、每年；部分 Gmail/主题监控 | Active/Paused/Completed 分组；最多 50 个 active、同时运行 15 个 tasks；受 usage limit 影响时到点任务可能不运行 | 状态分组、并发上限、额度和延迟的可见性；时区固定为创建时位置 |
| Apple Shortcuts Personal Automation | 每天/每周/每月、日出日落和多种设备事件；没有公开的任意每 N 分钟 interval | 可启用/停用、编辑、删除；可按锁定状态和运行前询问控制；没有统一业务级运行历史 | “自动运行”与“运行前询问”边界；本机事件能力强，但不能替代可靠调度器 |
| Grok Bot Routines | schedule 或受支持事件；同一 Bot 的不同 Routine 计划至少间隔 5 分钟 | 每个 Bot 最多 50 个 Routine，每个保留最近 20 条运行；支持暂停、恢复、测试、编辑、删除；时区可设；无人值守审批约 10 分钟后过期 | Skill（怎么做）与 Routine（何时跑）分离；测试运行；运行历史上限；审批过期 |

公开文档没有统一承诺消费级产品的重叠、补跑、自动重试、DST 和历史保留规则。文档没有说明不等于产品已经妥善实现，也不能据此推断 Rambo 应照抄。

## 二、macOS 本机可执行边界

- `setInterval` 只能作为检查节拍，不能作为可靠时钟。正确做法是持久化下一次绝对执行时间，在应用存活、启动和唤醒后重新对账。
- Electron 的 `powerSaveBlocker`/电源断言只能阻止空闲睡眠，不能阻止合盖、手动睡眠、低电量或过热导致的睡眠。应只在接电且确实有任务运行时短暂持有，任务结束或切换到电池时释放。
- launchd 的 `StartCalendarInterval` 可以在睡眠后唤醒时补跑一次，但关机期间不会补；`StartInterval` 的睡眠错过会直接跳过。两种语义不同，不能混用。
- 用户明确选择 `⌘Q` 会停止 Rambo 服务。在不修改 O01 的前提下，不应偷偷用常驻 helper 在退出后拉起应用。
- 首次发送系统通知前要取得 `UNUserNotificationCenter` 授权；用户拒绝后仍应保留应用内记录，并如实显示“系统通知已关闭”。通知到达并不等于 Routine 被调度或成功执行。

## 三、Rambo 当前实现核对

### 调度与数据模型

- `RoutineFrequency` 只有 `daily | weekdays | weekly | monthly`，见 `src/shared/contracts.ts:96`。
- 创建工具强制要求 `triggerTime: HH:mm`，见 `src/main/host.ts:140-167`，没有分钟或小时间隔字段。
- 无法识别的周期表达最终默认成 `daily`，见 `src/main/routine-schedule.ts:67-74`。
- 更新已有 Routine 时，旧 `frequency/weekday/dayOfMonth` 被再次作为覆盖参数传给解析器，见 `src/main/store.ts:870-879`；修改周期可能显示成功但保留旧周期。
- 调度器每 15 秒轮询一次，见 `src/main/routine-scheduler.ts:37`；适合作为检查节拍，但没有持久化 timer、创建 date 边界或预约槽位的精确触发保证。
- `dedupeKey` 列存在，但调度器创建 run 时没有传入，见 `src/main/store.ts:285`、`src/main/routine-scheduler.ts:129-135`。
- 调度器先推进 `nextRunAt` 再创建 run，见 `src/main/routine-scheduler.ts:129-130`；中间崩溃可能漏触发。
- `markRoutineScheduled` 直接覆写下一次执行时间，没有用“routineId + scheduledFor”唯一约束抢占槽位，见 `src/main/store.ts:962-969`。

### 恢复、重入与状态

- 调度器启动只恢复 turn 映射，见 `src/main/routine-scheduler.ts:39-43`；没有对遗留 `running` run 做 reconcile。
- 启动只把未完成普通 turn 标成 `unknown`，见 `src/main/store.ts:508-510`，没有实现 O04 的“Routine 最多恢复一次/结果不明暂停”。
- `activeRunFor` 把任何 `pending/running` 直接视为活跃运行，见 `src/main/routine-scheduler.ts:72-75`；遗留 `running` 会永久导致新触发被 skip。
- 本机数据库存在一条 2026-10-22 的一次性运行，仍为 `running`，`completedAt` 和 `error` 均为空；这是当前恢复缺口的数据证据。
- 重试与超时状态机缺失：执行异常后直接失败，见 `src/main/routine-scheduler.ts:158-172`；R07 的延迟一次重试、副作用核对和人工处理状态没有实现。

### 通知、错误与可观测性

- `successNotification` 只被持久化，见 `src/shared/contracts.ts:117`；主进程没有 Electron `Notification` 使用路径。
- R08 的连续失败次数、错误指纹、同因通知去重均不存在。
- 运行历史 UI 只展示最近 3 条，见 `src/renderer/App.tsx:2640-2645`；任务列表由现存定义驱动，删除定义后数据库 run 虽保留，却没有独立历史入口。
- 运行记录只有单个 `process/summary/error` 字段，见 `src/shared/contracts.ts:124-133`；缺少尝试次数、计划版本、超时原因、结束原因、执行耗时和独立执行会话入口。
- 测试运行与立即运行没有清晰区分；当前“立即运行”会创建真实 run 并产生外部副作用。

### 时区与 DST

- 时区字段虽然存在，创建时总是使用 Host 当前系统时区，见 `src/main/host.ts:1454`。
- `zonedLocalToIso` 只做一次 UTC offset 修正，见 `src/main/routine-schedule.ts:21-25`，没有 spring-forward gap 和 fall-back fold 策略。
- 缺省时区回落到 `Asia/Shanghai`，见 `src/main/routine-schedule.ts:79`，与系统时区语义不一致。
- 月度任务未指定日期时默认使用“当前日”，见 `src/main/routine-schedule.ts:88`，可能产生用户未明确选择的日期。
- Q28 已明确暂不讨论设备换时区；但固定的 IANA 时区、DST 不存在/重复时刻以及无效时区至少应结构化 fail-closed，并补测试。
- 本机规则文档已明确“时区变化按 Q28 暂缓”，所以本轮不能把设备换时区自动追踪追认成新的产品决定；可以列为未来确认项。

### macOS 生命周期

- 主进程没有 `powerMonitor` 或 `powerSaveBlocker` 使用路径，见 `src/main/index.ts:1`；O02 未实现。
- 关闭最后一个窗口继续运行、显式退出才停止已由 `src/main/index.ts:975-988` 实现；这不应被“分钟级任务”改成偷偷常驻。
- 启动时没有幂等抢占和唤醒对账，单纯把轮询间隔缩短到 5 秒不能解决睡眠、崩溃和重复触发。

## 四、功能遗漏清单

### P0：R17 结构化多时刻与执行恢复

1. 用 `RoutineDefinition.times: HH:mm[]` 表达同一条每日 Routine 的多个有序、去重时刻；不新增 `intervalMinutes`，也不批量创建 Routine。
2. 扩展创建/更新工具、Host 校验、Store 迁移、调度器计算、UI 展示和测试；创建/修改响应必须回读并展示真实结构化计划。
3. 对未知或无法表达的周期 fail-closed，禁止回落到 daily；明确拒绝“每 N 分钟/小时”并引导用户提供离散时刻。
4. 修复更新时旧频率或旧时刻覆盖新值的 bug，并保留修改前后的执行快照。
5. 用 `routineId + scheduledFor` 唯一约束先创建 occurrence/run，再推进 `nextRunAt`；多个时刻各形成独立 occurrence，但一次对账最多补一个错过运行。
6. 启动、唤醒后立即对账；遗留 `pending/running` 按 O04 转为可解释状态，不能永久占住活跃运行。

### P1：把执行可靠性做成产品能力

1. 增加运行超时、尝试次数、lease/heartbeat、错误分类、错误指纹和人工处理终态；重试是同一 occurrence 的新 attempt，补跑是新的 occurrence。
2. R07 的最多一次短暂错误重试、幂等检查和“副作用不确定时暂停”需要真实状态机与测试；不能只停留在规则文档。
3. 实现 R08/R09：连续失败计数、同因通知去重、单条成功通知、逐 Bot 通知开关和系统授权状态。
4. 实现 O02：接电且实际有 Routine 运行时短暂防闲置睡眠；任务终态、断线或切电池立即释放。
5. 增加完整运行历史页和独立执行会话入口；至少保留条数可配置，删除定义后仍可回查历史、简报和成果。
6. 把“立即运行”与“测试运行”分开：测试运行默认不产生外部副作用、不推进正式计划，并显示测试标识；真实立即运行继续产生副作用。

### P2：生命周期与表达增强

1. 开始日期、结束日期、最大运行次数和自动失活；避免“每 5 分钟永久运行”无限消耗。
2. 每小时/每 N 小时、每年；每日多个任意时刻已定为 R17。是否引入 cron 作为高级入口需单独确认，不应让用户直接手写 cron 作为主界面。
3. 固定 IANA 时区、DST gap/fold、无效时区诊断；Q28 的设备换时区行为仍需用户另行确认，不能自行追认。
4. 活跃 Routine 上限、调度并发上限、错过槽位的单次重放（不做批量 backfill）、调度健康状态与最近成功时间。
5. 单次失败/跳过的可解释诊断和“下一次为什么没执行”；成熟系统都不会只给一个绿色“已启用”状态。

## 五、建议的内部模型

不需要把 Rambo 做成通用工作流引擎，但应把当前混在一起的字段拆成三层：

```text
RoutineDefinition
  scheduleSpec: daily | weekdays | weekly | monthly | interval | once
  timezone + anchor + optional start/end/maxRuns
  instruction + execution mode/template + policy

RoutineOccurrence
  id = routineId + scheduledFor (unique)
  scheduledFor + state (due/missed/skipped/...)
  scheduleSnapshot + definitionVersion

RoutineAttempt
  occurrenceId + attemptNumber + status
  startedAt + completedAt + errorClass + errorFingerprint
  idempotencyKey + executionChatId + handoffState
```

这能让 R02/R06/R07/O04 互不冲突：补跑改变 occurrence，重试改变 attempt，运行超时和通知去重有稳定归属，删除定义后历史也不会失去查询主键。

## 六、明确不是当前遗漏

- T22、T04、R10 和 Q140 已明确：首版只有本机定时触发，不支持被动事件、Trigger Source、Slack/GitHub/邮件事件唤醒、本机/LAN Webhook 或托管事件队列。
- 未来若要支持 Webhook，至少需要 token/HMAC、请求大小限制、时间戳、重放保护、事件持久化和“至少一次触发不等于恰好一次执行”的明确语义；这些不能在没有新决策时顺手加入。
- Rambo 已有自然语言创建、按 Bot 隔离、独立执行上下文和结果回到来源私聊等优势，不应因补 interval 而丢掉。

## 七、建议的验证顺序

1. 纯逻辑测试：每日多时刻排序去重与最近触发、DST gap/fold、未知表达式拒绝、更新周期和时刻不继承旧值。
2. Store/调度器集成：`routineId + scheduledFor` 去重、崩溃点重放、遗留 running 对账、R02/R03/R06/R07 状态转换。
3. 定向 Electron：创建同一条多时刻 Routine 后真实回读计划和列表单条、两个时刻分别触发、立即/测试运行区分、失败通知授权、历史入口和任务删除后的回查。
4. macOS 实机：短间隔触发、窗口关闭、应用重启、手动睡眠/唤醒、接电/电池和系统通知授权拒绝；必须区分逻辑通过、Electron 通过和真机通过。

## 八、一手来源

- [GitHub Actions workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)（cron、最短 5 分钟、IANA、DST spring-forward）
- [GitHub Actions concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)（并发组、取消运行）
- [Kubernetes CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)（时区、concurrencyPolicy、startingDeadlineSeconds、历史保留、suspend）
- [Make schedule](https://help.make.com/schedule-a-scenario)（固定间隔、每日多个时刻、下次执行）
- [Make incomplete executions](https://help.make.com/incomplete-executions)（失败保存和重试）
- [Make exponential backoff](https://help.make.com/exponential-backoff)
- [Temporal Schedule](https://docs.temporal.io/encyclopedia/workflow/schedule)（overlap、catch-up、pause、backfill）
- [Temporal CLI schedule](https://docs.temporal.io/cli/schedule)（重叠策略和 backfill）
- [n8n Schedule Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger/)
- [n8n executions](https://docs.n8n.io/workflows/executions/all-executions/)
- [Apple launchd timed jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html)
- [Apple WillSleep](https://developer.apple.com/documentation/appkit/nsworkspace/willsleepnotification)
- [Apple DidWake](https://developer.apple.com/documentation/appkit/nsworkspace/didwakenotification)
- [Apple Notification authorization](https://developer.apple.com/documentation/usernotifications/requesting-authorization-to-use-notifications)
- [ChatGPT Scheduled Tasks](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt)
- [ChatGPT scheduled tasks / Codex automations](https://openai.com/academy/codex-automations)
- [Microsoft Copilot scheduled prompts](https://support.microsoft.com/en-us/microsoft-365-copilot/schedule-your-most-used-copilot-prompts)
- [Gemini task schedules](https://support.google.com/gemini/answer/17094710?hl=en)
- [Grok Bot Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)

访问日期均为 2026-10-25。公开文档未说明的行为只记为“未说明”，不作为产品已经实现的事实。
