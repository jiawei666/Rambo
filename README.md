# Rambo

自用 macOS Bot 应用，既定范围内的已有界面和交互按 Grok Bot 原版证据完全复刻，底层采用由应用管理的 Codex App Server。

用户已授权开始开发，当前处于分批实现阶段。先阅读 [产品决策记录](docs/product-decisions.md)；需要核对原话、确认回复或方案变化时，查阅 [完整问答摘录](docs/conversation-evidence.md)。当前实际进度见 [实施记录](docs/implementation-progress.md)。


全部已确认功能的操作步骤、预期结果与交付判定见 [全量验收矩阵](docs/acceptance-matrix.md)。当前正在按冻结基线逐项验收；已完成的 80 个特征门禁局部案例与 4 个候选包案例不代表 113 条规则或发布套件通过。最新进度、缺口和证据入口见[当前验收任务](docs/active-acceptance-run.md)。

技术方案见 [技术设计](docs/technical-design.md)，Codex 0.163.0 协议与证据边界见 [App Server 本机核对](docs/app-server-evidence.md)。采用 Electron / React / TypeScript 和本机 SQLite 开始实现；Voice、Computer Use、历史隔离等仍待实际验证。

第一轮只读调查结论见 [独立运行可行性](docs/feasibility-status.md)，包含 Voice 的 WebRTC 认证路径、Computer Use 组件依赖，以及现成 App Server 历史来源方案的反证。

第二轮已找到上游独立 App Server 的来源参数及 macOS 发行物条目，当前推荐见 [历史隔离方案收敛](docs/history-isolation-plan.md)；与 CLI 子命令的默认来源问题分开，尚未运行验证。

正式应用/项目名称与唤醒称呼均为 **Rambo**（用户指定《第一滴血》主角名字）。Logo 使用[用户提供的原图](assets/branding/app-logo-source.png)，来源与当前命名见[品牌素材记录](docs/branding.md)。

## 本机开发

当前固定的运行时为 macOS arm64 Codex App Server 0.163.0，保留完整发行物相对布局。下载和解包不会复制认证文件或修改原生 Codex 安装。

```sh
npm install
npm run runtime:prepare
npm run dev
```

`npm run build` 生成桌面代码，`npm run package:mac` 生成本机未签名应用目录。首次未准备运行时时界面如实显示错误；不退回公用 CLI 进程。认证沿本机 Codex 配置，产品数据保存在 Electron 的 Rambo 用户数据目录。

当前实现不等于完整交付；当前规则通过为 0/113，J1–J4 和六个发布套件均未通过。尚未接通的功能和验收状态见实施记录，不使用演示回复代替真实 Codex。

## 全量验收 Skill

使用项目内的 [$rambo-acceptance](.agents/skills/rambo-acceptance/SKILL.md)：日常先跑单测、Host/SQLite 集成和 Playwright Electron 脚本；真实模型、设备、邮件与 macOS 原生能力只在候选和发布阶段验证。`tests/acceptance/catalog.json` 将全部产品规则映射到测试层级与证据类型。

```sh
npm run verify:fast
npm run verify:feature -- --rules B13,G02
npm run verify:candidate
npm run accept:release
```

确定性自动测试可登记单次机器证据；人工界面、真实设备和外部副作用仍独立复验。使用独立测试数据，不在日常产品数据中做删除/故障注入。完整运行记录保存到 `acceptance-runs/<run-id>/`，默认不入库。
