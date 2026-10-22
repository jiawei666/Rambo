# Rambo 验收 Skill 前向演练

日期：2026-10-21

## 范围与准备

本次只验证 `.agents/skills/rambo-acceptance/SKILL.md` 和 `scripts/ledger.py` 的台账流程，不是 Rambo 产品验收。测试项目、两条伪决策（`P01`、`B01`）、一个 E 流程（`E01`）、各个假 `.app/Contents/Resources/app.asar` 和小型文本证据均创建在系统临时目录：

`/var/folders/b8/73n11rf52qd7qyfhlcgwb9_r0000gn/T/rambo-acceptance-forward-l5bx1ayr`

演练未启动应用、未操作桌面或账号。CLI 的 `--actor` 参数模拟流程角色；它不验证真实 Agent 身份或彼此独立性。

开始时 `references/workflow.md` 不存在，因此先运行 `python3 .../scripts/ledger.py --help` 获取 CLI 命令，并读取 `references/cases-and-evidence.md`。未改动脚本。

## 完整问题闭环

对 `full-closure` run 执行了以下实际 CLI 阶段：

```sh
T=/var/folders/b8/73n11rf52qd7qyfhlcgwb9_r0000gn/T/rambo-acceptance-forward-l5bx1ayr
LEDGER=/Users/yuanjiawei/ai-coding/Rambo/.agents/skills/rambo-acceptance/scripts/ledger.py
PROJECT="$T/pseudo-project"
RUN="$PROJECT/acceptance-runs/full-closure"
APP="$T/fake-apps/full-closure/Rambo.app"

python3 "$LEDGER" init-run --project "$PROJECT" --app "$APP" --out "$RUN"
python3 "$LEDGER" plan --run "$RUN" --input "$T/full-closure-plan.json" --actor coordinator
python3 "$LEDGER" record --run "$RUN" --case P01-01 --result fail --actual '启动后主面板标题不可见' --evidence "$RUN/evidence/P01-failure.txt" --actor tester
python3 "$LEDGER" issue --run "$RUN" --case P01-01 --input "$T/issue.json" --actor tester
python3 "$LEDGER" fix --run "$RUN" --issue ISSUE-0001 --input "$T/fix.json" --actor fixer
python3 "$LEDGER" build --run "$RUN" --app "$APP" --actor coordinator
# 新构建上，对 P01-01、B01-01、E01-01 各执行 record --result pass 和 verify --result pass
python3 "$LEDGER" report --run "$RUN"
```

`init-run` 识别到 2 条规则和 1 个跨功能流程；初次 tester 失败建立 `ISSUE-0001`，未修复报告为“全量通过：否”。未登记 `.app` 变化时，`record` 以退出码 2 拒绝写入。fixer 追加修复记录，coordinator 登记 epoch 1 新构建；tester 为三个子 case 在新构建重新记录，coordinator 分别复验后，报告为 3/3 个子 case、2/2 条规则、1/1 个流程通过，问题状态“复验通过”。

## 边界场景

| 场景 | 操作 | 实际结果 |
| --- | --- | --- |
| 只有 tester pass | 完成拆解，只记录 `P01-01` pass 后 report | 全量通过：否；等待 coordinator 复验 |
| 拆解不完整 | 只规划 `P01-01` 并将 `P01` 标记 incomplete，另两行不拆解 | 即使该子 case 被复验为 pass，报告仍为否 |
| 未关闭问题 | 创建失败记录和问题后 report | 全量通过：否；问题为“未修复” |
| 新构建尚未登记 | 修改假 `app.asar` 后立即 record/verify | 退出码 2，要求先由 coordinator 登记构建 |
| 新构建已登记 | 对旧 epoch 先有通过复验，再改写并登记新构建 | report 全量通过：否；旧复验不再计入当前构建 |
| 决策/矩阵基准变化 | 完整通过后改写矩阵再 report/record | report 全量通过：否；record 退出码 2，要求按新基准建 run |
| 已登记证据被改写 | 完整通过后改写 `evidence/P01-01.txt` 再 report | **报告仍为“全量通过：是”** |
| 已登记证据被删除 | 在上述 run 删除该证据后再 report | **报告仍为“全量通过：是”**；仍展示登记时保存的路径和 hash |

## 缺陷

**高优先级：报告不复核已登记证据文件。** `record`/`verify` 会在当时解析证据并保存路径、SHA-256 和大小，但 `report` 的完整通过推导只校验当前决策/矩阵基准和 `app.asar`，不检查事件证据现在是否仍存在、是否为普通文件、SHA-256 是否仍相同。因此对已全通过的 run，改写或删除一份已登记证据后仍能得到“全量通过：是”，与报告“没有真实、可读取证据时不能通过”的说明冲突。

建议在报告派生状态时复核所有构成当前通过的 tester observation、coordinator verification 及未关闭问题证据；任何缺失、不可读或 hash 不一致都应使相应 case/问题失效并阻止全量通过，同时报告具体证据路径。

除该项外，本次指定的边界场景未发现误报完整通过。伪项目演练结果不能证明 Rambo 产品功能通过。

## 作者修复后的独立复测

在同一系统临时夹具 `/var/folders/b8/73n11rf52qd7qyfhlcgwb9_r0000gn/T/rambo-acceptance-forward-l5bx1ayr` 上使用更新后的 `ledger.py` 重跑；本轮未改脚本、未启动应用，也未操作电脑或账号。

| 检查 | 实际命令/步骤 | 结果 |
| --- | --- | --- |
| 改写已登记 case 证据 | `python3 .../ledger.py report --run "$T/pseudo-project/acceptance-runs/evidence-change"`；将 `evidence/P01-01.txt` 改成不同内容后再次 report | 初始证据还原时全量通过：是；改写后全量通过：否，case 变为受阻并报告 SHA-256 不匹配 |
| 删除已登记 case 证据 | 删除同一 `P01-01.txt` 后再次 report | 全量通过：否；报告“证据文件不存在” |
| 用符号链接替代证据 | 将同一路径链接到本 run 的 `B01-01.txt` 后再次 report | 全量通过：否；报告证据路径经过符号链接 |
| 只改 tester 证据，保持 coordinator 证据不变 | 新建 `role-split` 临时 run；所有三个伪 case 均用不同文件分别执行 `record` 和 `verify`。完整通过后仅改写 `P01-F01-tester.txt`，保留 `P01-F01-verify.txt` 原样，再 report | 改写前全量通过：是；只改 tester 文件后全量通过：否。报告定位 tester 文件的 hash 不匹配，case 受阻；复验文件 hash 未变 |
| 闭环问题证据失效 | 新建 `issue-evidence` 临时 run，登记失败与 `ISSUE-0001`，模拟修复、登记新构建，再为全部 case 记录并复验 | 问题已闭环时全量通过：是、问题状态“复验通过”；随后只改写 `evidence/P01-issue.txt`，report 全量通过：否，问题状态为证据无效 |

以上通过实际 `init-run`、`plan`、`record`、`issue`、`fix`、`build`、`verify`、`report` CLI 运行验证，没有调用主项目 coordinator 台账。由这些独立前向检查看，原先发现的“登记证据改写/删除仍可完整通过”问题已修复；本次还确认了 symlink、tester-only 证据失效及已关闭问题证据失效都会阻止全量通过。
