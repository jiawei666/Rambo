# 运行手册

下列命令从 Rambo 项目根目录执行。`RUN_ID` 替换为本轮唯一标识，例如 `20261021-full-01`；命令中的 run 路径保持一致。输入 JSON 先写文件再传 `--input`，不要把长 JSON 拼进 shell。

## 0. 先选测试层级

日常开发优先使用自动化，不为每个改动建立完整验收 run：

```sh
npm run verify:fast
npm run verify:feature -- --rules B13,G02
npm run verify:regression -- --issue ISSUE-0012
npm run verify:candidate
```

`tests/acceptance/catalog.json` 的 `ruleAcceptance` 保存当前全部规则的完整场景，`cases` 保存可执行的局部证据，`npm run test:catalog` 会同时核对规则归属、具体步骤和测试入口。规则数量以当前决策与矩阵编号集合为准（本轮为 117 条）。`npm run test:plan` 生成 [规则级测试计划](../../../../docs/acceptance-test-plan.md)。单测与 Host/SQLite 集成用于日常和功能完成；Playwright `_electron.launch` 用于高价值真实页面旅程；Playwright MCP 只用于探索和排障；Computer Use 只用于真实系统、设备和跨应用。

同一功能域完成后可建立发布级 run 并登记功能证据，但报告必须写“功能当前可用”，不能写“全量发布通过”。准备长期交付时才运行 `verify:candidate` 和发布验收。

## 1. 选择模式并建立台账

常规功能验收使用开发模式，不做 macOS 打包和代码签名。开发指纹覆盖 `src`、`assets`、随项目运行时、依赖锁定文件和 Electron Vite 配置；验收 profile、`out`、`dist` 不纳入指纹。需要验证独立安装、签名、包内资源或更新的矩阵案例，再选择 `app` 模式。

新建开发模式 run：

```sh
python3 .agents/skills/rambo-acceptance/scripts/ledger.py init-run --project . --mode dev --out acceptance-runs/RUN_ID
node .agents/skills/rambo-acceptance/scripts/launch.mjs --run acceptance-runs/RUN_ID --mode dev
```

开发启动器执行 `npm run dev`，把 `RAMBO_ACCEPTANCE_RUN` 设为当前 run，保留终端直到停止；另行记录独立 Electron PID、profile 路径、源码指纹和 `http://127.0.0.1:19222` CDP 页面。它只在 run 专用 profile 中为验收实例开启回环调试端口；端口已占用时拒绝启动。确认 `launch.json` 的 run、PID、profile、build hash 与 CDP target 后，使用已配置的 Playwright MCP 操作应用内 UI。请求启动、PID 和编译成功均不单独证明页面就绪。连接失败时按 [UI 调试手册](ui-debugging.md)处理，不自动退回普通浏览器。

打包专项案例才使用以下流程：

```sh
npm run package:mac
python3 .agents/skills/rambo-acceptance/scripts/ledger.py init-run --project . --mode app --app dist/mac-arm64/Rambo.app --out acceptance-runs/RUN_ID
node .agents/skills/rambo-acceptance/scripts/launch.mjs --run acceptance-runs/RUN_ID --mode app
```

已有 run 不能再 init 覆盖。脚本解析当前决策/矩阵并冻结 hash，生成逐规则待拆解义务、空 cases、问题和审计台账。开发源码改变后，先完成一批修改和实现测试，再登记一次新 dev epoch 并重启应用；不要逐个编辑就打包或逐次登记。

主 Agent 建立桌面占用约定；派测试任务时只提供该批规则、案例、run 路径与最低必要前置，不重复完整会话。

## 2. 规划与拆解

创建 `acceptance-runs/RUN_ID/plan-batch-01.json`。结构如下（示例只覆盖 B04，不代表该项目只需这个案例）：

```json
{
  "cases": [{
    "id": "B04-01",
    "ruleIds": ["B04"],
    "coverage": {"B04": "填写名称与预置头像创建后，确认直接进入空白聊天，无欢迎卡或强制设置向导"},
    "kind": "ui",
    "preconditions": ["本轮独立测试窗口已就绪"],
    "steps": ["点击新建 Bot，填写本轮唯一名称并选择头像", "创建后观察聊天与导航"],
    "expected": ["名称和头像正确", "直接进入空白聊天，未插入示例或强制向导"]
  }],
  "coverageReview": {
    "B04": {
      "complete": true,
      "scenarioIds": ["B04-01"],
      "reason": "此子案例包含 B04-01 的全部创建与无强制内容条件"
    }
  }
}
```

```sh
python3 .agents/skills/rambo-acceptance/scripts/ledger.py plan --run acceptance-runs/RUN_ID --input acceptance-runs/RUN_ID/plan-batch-01.json --actor coordinator
```

`coverageReview` 由主 Agent 审核。`scenarioIds` 必须逐项列出该规则在 `ruleAcceptance` 中声明的全部场景；确认任务覆盖时只选实际执行的范围。只有全部规则场景均有执行或审核证据、且目录中已实现的局部案例都已纳入 run，才能把该规则标为 complete。只测 Logo 不能把整个 P02 标完整；尚待其余页面时用 `complete:false`。case 只能新增，不覆盖已有 ID。追加细化案例并重新审查时保留旧历史。

规划时按功能域、共享前置和操作方式把案例组成批次。一个测试任务尽量覆盖同批多个案例，并在同一安全的 run 窗口中复用准备好的夹具；每个案例仍单独记录结果、构建和证据。纯文档与互不争用数据的源码/后端检查可以并行；Playwright MCP、Computer Use 和其他共享桌面操作必须串行。批次交接时一次性交还当前实例和状态，避免逐案例启动/关闭应用或反复交接。

批次执行中，失败案例先各自登记证据和问题；只要不会污染共享夹具或使后续预期失效，就继续完成其余独立案例，再集中修复同一代码区域的问题。若失败会改变后续案例的前置条件，停止受影响的后续项并说明依赖。修复后一次登记新开发 epoch，并将受影响回归与尚待当前构建验证的案例排入批次。旧 epoch 通过记录继续保留，但不计入目标构建通过数；全量交付前仍须让所有适用案例在目标 epoch 上有有效结果。

UI 受阻时，先用 Playwright MCP 读取当前 target、页面结构、截图和控制台，确认连接的是本轮 Electron 实例。若页面 target 不符、CDP 不通或 MCP 未加载，按 [UI 调试手册](ui-debugging.md)记录工具受阻；不要换普通浏览器继续操作。只有连接状态、页面状态或明确前置条件发生可记录的变化后，才恢复该 UI 链；受阻期间继续跑不依赖桌面的案例。原生对话框等 Computer Use 案例沿入口 Skill 的焦点/AX 安全规则执行。

给用户汇报进度时分别报告：规则场景定义、J1–J4/发布套件、局部测试案例、当前 epoch 规则结果、受阻/未执行项、旧 epoch 待重验项。不要把规则场景数当作可执行测试数，也不要用局部案例或旧 epoch 通过数冒充当前构建规则通过数。

## 3. 测试 Agent 记录真实观测

工具实际保存的截图、AX 摘录或其他产物放 `evidence/`，夹具放 `fixtures/`。用相对 run 的路径，不传不存在的文件或外部路径。先准备实际证据，再记录：

```sh
python3 .agents/skills/rambo-acceptance/scripts/ledger.py record --run acceptance-runs/RUN_ID --case B04-01 --result fail --actual '创建后出现了不应有的欢迎卡；详见AX摘录' --evidence evidence/B04-01-actual.txt --actor tester
```

`--result` 为 `not_run/pass/fail/blocked/clarify`。tester 的 pass 仍是待主 Agent 复验，不能直接作为最终通过。截图隐私、真正操作方式与无可用导出接口时的边界见 cases-and-evidence.md。

## 4. 建问题并交给另一位 Agent

问题 JSON 存入 run，字段：

```json
{
  "title": "创建后插入未批准的欢迎内容",
  "severity": "medium",
  "reproduction": ["在本轮测试窗口新建 Bot", "创建后查看消息区"],
  "expected": "空白聊天，无强制欢迎卡",
  "actual": "出现了欢迎卡",
  "evidence": ["evidence/B04-01-actual.txt"]
}
```

```sh
python3 .agents/skills/rambo-acceptance/scripts/ledger.py issue --run acceptance-runs/RUN_ID --case B04-01 --input acceptance-runs/RUN_ID/issue-B04.json --actor tester
```

读取生成的 ISSUE ID，再分派给修复 Agent。测试 Agent 不改产品代码；主 Agent 复验发现新问题时交回测试角色建单，不伪称另一个人已经验证。问题描述使用真实观测，示例文案不能直接当执行结果。

## 5. 登记修复与新构建

修复 Agent 返回修改、原因和回归范围。开发模式的 `newBuildHash` 使用台账生成的源码与运行时指纹；包模式使用真实 `app.asar` SHA-256。修复 JSON：

```json
{
  "modifiedFiles": ["src/renderer/App.tsx"],
  "explanation": "移除创建后的未批准插入，其他消息路径保持原实现",
  "newBuildHash": "填写本次构建实际64位SHA256"
}
```

```sh
python3 .agents/skills/rambo-acceptance/scripts/ledger.py fix --run acceptance-runs/RUN_ID --issue ISSUE-0001 --input acceptance-runs/RUN_ID/fix-B04.json --actor fixer
python3 .agents/skills/rambo-acceptance/scripts/ledger.py build --run acceptance-runs/RUN_ID --mode dev --actor coordinator
node .agents/skills/rambo-acceptance/scripts/launch.mjs --run acceptance-runs/RUN_ID --mode dev
```

新 build epoch 使旧记录不再计为当前通过，历史仍保留。`check-build`、record、verify 和 report 都会核对当前模式指纹。开发源码在验收中途变化时停止本轮、登记新 epoch 并重新启动；不要把 HMR 后的新代码记到旧 hash。集中一批修复后登记与回归，避免单个小修改就重复全套。基准文档变更时创建新 run 并重新审查案例，不把旧 run 静默改成新标准。

## 6. 证据判定与报告

人工界面、真实设备和外部副作用由测试者记录实际观测，主 Agent 再独立复现：

```sh
python3 .agents/skills/rambo-acceptance/scripts/ledger.py verify --run acceptance-runs/RUN_ID --case B04-01 --result pass --actual '在当前构建重做创建，进入空白聊天且名称头像正确' --evidence evidence/B04-01-recheck.txt --actor coordinator
```

确定性自动测试已保存完整结果、脚本 hash 和构建 hash 时，主 Agent 审核断言来源后可直接登记单次机器证据：

```sh
python3 .agents/skills/rambo-acceptance/scripts/ledger.py machine-verify --run acceptance-runs/RUN_ID --case G02-INT-01 --result pass --actual '断言执行两个成员判断回合，无router、无默认Bot且仅相关回复进入群聊' --evidence evidence/G02-INT-01.result.txt --test-id G02-INT-01 --test-command 'npm run verify:feature -- --rules G02' --suite-hash REPLACE_WITH_SHA256 --actor coordinator
```

`machine-verify` 只用于确定性、可重复、只读且结果可自动断言的 pass；失败和不确定副作用仍用 `verify` 保留现场。脚本 hash、构建 epoch 或证据 hash 变化会使结果失效。自动结果不要求再人工执行同一测试。

生成报告：

```sh
python3 .agents/skills/rambo-acceptance/scripts/ledger.py report --run acceptance-runs/RUN_ID
```

阅读 `REPORT.md`：所有规则场景及 J1–J4/发布套件是否完整、每个局部案例是否真实测试和复验、规则级结论是否由完整场景证据支持、基准/构建/证据是否有效、问题是否已在新构建复验关闭。脚本不能辨别一份人为捏造的证据是否真实，主 Agent 必须读实际产物与工具记录。

报告里的“全量通过”要求所有条件满足；否则给出实际部分结果和未通过编号。没有实际执行时报告未执行，不将本手册、脚本单测或初始覆盖表叫作产品验收完成。
