import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const catalog = JSON.parse(readFileSync(resolve(root, 'tests/acceptance/catalog.json'), 'utf8'));
const outputPath = resolve(root, 'docs/acceptance-test-plan.md');
const layers = new Map([
  ['unit', '单元'],
  ['integration', 'Host/SQLite 集成'],
  ['electron-e2e', 'Playwright Electron'],
  ['visual', '视觉复刻'],
  ['native', 'macOS/真实设备'],
  ['real-service', '真实外部服务'],
  ['model-smoke', '真实模型冒烟'],
  ['document', '文档/工程门禁']
]);
const evidenceByRule = new Map();
for (const testCase of catalog.cases) {
  for (const rule of testCase.rules) {
    const items = evidenceByRule.get(rule) ?? [];
    items.push(testCase);
    evidenceByRule.set(rule, items);
  }
}

const escapeCell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
const lines = [
  '# Rambo 规则级测试计划',
  '',
  '生成日期：2026-10-22。来源：`tests/acceptance/rule-plans.mjs`、`tests/acceptance/catalog.json` 与 `docs/acceptance-matrix.md`。',
  '',
  `本文件回答“每条已确认规则究竟怎么验”。113 条规则各有完整场景、通过条件、适用测试层和证据要求；现有 ${catalog.cases.length} 个测试案例只是局部证据入口，不能用来说明整条规则已通过。可执行状态与证据状态分别记录。`,
  '',
  '## 判定口径',
  '',
  '- **计划已定义**：已有具体操作、可观察断言和证据要求。',
  '- **局部证据已实现**：至少有一个运行测试覆盖规则的某一部分，不代表整条规则通过。',
  '- **规则已验收**：完整场景在目标构建上有当前证据，所有断言通过且无开放缺陷。',
  '- **产品缺口**：当前路径尚未实现，或真实设备/外部账号等前提无法满足；必须在交付前关闭或如实受阻。',
  '- 现有模型、语音、Computer Use 和外部服务场景可以在快速反馈阶段使用替身覆盖逻辑，但最终发布必须有真实链路证据。',
  '- “主要测试层”表示每条规则验证完整义务时最强的必要证据层，不代表仓库只有这些层的测试；日常低成本回归仍由“现有局部证据”列中的具体测试承担。',
  '',
  '## 汇总',
  ''
];

const layerCounts = new Map();
for (const item of catalog.ruleAcceptance) layerCounts.set(item.layer, (layerCounts.get(item.layer) ?? 0) + 1);
const implementedRules = new Set(catalog.cases
  .filter(item => item.status !== 'not_implemented')
  .flatMap(item => item.rules));
lines.push(
  `- 规则验收计划：**${catalog.ruleAcceptance.length}** 条`,
  `- 完整场景：**${catalog.ruleAcceptance.reduce((count, item) => count + item.scenarios.length, 0)}** 个`,
  `- 局部测试案例：**${catalog.cases.length}** 个，其中可执行 **${catalog.cases.filter(item => item.status !== 'not_implemented').length}** 个`,
  `- 已有局部证据的规则：**${implementedRules.size}** 条；规则级当前通过：**0** 条`,
  `- 当前发布判定：**未通过，产品功能与验收证据尚未覆盖全部 113 条**`,
  ''
);

lines.push('', '### 主要测试层', '');
for (const [layer, label] of layers) lines.push(`- ${label}：${layerCounts.get(layer) ?? 0} 条`);

lines.push(
  '',
  '## 规则清单',
  '',
  '| 规则 | 验收对象 | 适用层 | 完整场景 | 现有局部证据 | 当前剩余工作 |',
  '| --- | --- | --- | --- | --- | --- |'
);

for (const item of catalog.ruleAcceptance) {
  const related = evidenceByRule.get(item.rule) ?? [];
  const executable = related.filter(testCase => testCase.status !== 'not_implemented');
  const caseSummary = related.length
    ? `${executable.length}/${related.length} 可执行${executable.length ? `：${executable.map(testCase => testCase.id).join('、')}` : ''}`
    : '无';
  const scenario = item.scenarios[0];
  const scenarioSummary = [
    `编号：${scenario.id}`,
    ...scenario.steps.map((step, index) => `${index + 1}. ${step}`),
    `断言：${scenario.expected.join('；')}`,
    `证据：${scenario.evidence.join('、')}`
  ].join('<br>');
  lines.push(`| ${item.rule} | ${escapeCell(item.title)} | ${layers.get(item.layer)} | ${escapeCell(scenarioSummary)} | ${escapeCell(caseSummary)} | ${escapeCell(item.remaining)} |`);
}

lines.push(
  '',
  '## 建议执行批次',
  '',
  '| 批次 | 包含规则 | 默认执行时机 | 说明 |',
  '| --- | --- | --- | --- |',
  '| 快速回归 | 单元与 Host/SQLite 集成测试 | 每次相关源码修改 | 验证确定性逻辑、持久化、权限和跨 Bot 边界；不登记整条产品规则通过 |',
  '| 功能用户路径 | J1–J4 中受影响规则 | 功能完成时 | 用一条真实 Electron 路径连接页面动作与持久化结果 |',
  '| 连接与文件 | connections、files | 对应功能完成时 | MCP/Skills/邮件、生图、附件及文件预览；外部账号按真实服务验证 |',
  '| 调度与恢复 | scheduling、recovery | 调度/备份实现稳定后 | 受控时钟覆盖时间分支，再用真实后台执行和候选包验证关键结果 |',
  '| 语音与系统 | J4、interface | 候选版本和发布前 | 真实麦克风、合盖环境、登录启动、通知和电源行为只在合适环境执行 |',
  '| 发布验收 | 113 条规则、J1–J4、6 个发布套件 | 准备长期使用/交付前 | 审核完整场景在目标构建上的当前证据；任一缺口阻止通过 |',
  '',
  '## 更新方式',
  '',
  '1. 产品功能变化时，先修改 `docs/product-decisions.md` 与 `docs/acceptance-matrix.md`。',
  '2. 在 `tests/acceptance/rule-plans.mjs` 中更新该规则的具体操作、断言、证据和剩余说明。',
  '3. 运行 `npm run test:catalog:sync` 更新目录，再运行 `npm run test:plan` 重新生成本文件。',
  '4. 局部测试通过后，在 `catalog.json` 将该案例标为 `implemented` 并登记真实测试名；不要因此把整条规则改成通过。',
  '5. 只有完整场景在目标构建上通过后，才登记规则级验收结果。',
  ''
);

writeFileSync(outputPath, lines.join('\n'));
console.log(`已生成 ${outputPath}：${catalog.ruleAcceptance.length} 条规则、${catalog.ruleAcceptance.reduce((count, item) => count + item.scenarios.length, 0)} 个完整场景`);
