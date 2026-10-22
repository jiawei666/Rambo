import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../..');
const decisions = readFileSync(resolve(root, 'docs/product-decisions.md'), 'utf8');
const matrix = readFileSync(resolve(root, 'docs/acceptance-matrix.md'), 'utf8');
const catalog = JSON.parse(readFileSync(resolve(root, 'tests/acceptance/catalog.json'), 'utf8'));

const decisionIds = new Set([...decisions.matchAll(/^\|\s*([A-Z]\d{2})\s*\|/gm)].map(match => match[1]));
const matrixRuleIds = new Set([...matrix.matchAll(/^\|\s*([A-PR-Z]\d{2})\s*\|/gm)].map(match => match[1]));
const matrixRows = new Map([...matrix.matchAll(
  /^\|\s*([A-PR-Z]\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm
)].map(match => [match[1], {
  title: match[2].trim(),
  steps: match[3].trim(),
  expected: match[4].trim()
}]));

assert.equal(catalog.schema, 'rambo.test.catalog.v1');
assert.deepEqual([...decisionIds].sort(), [...matrixRuleIds].sort(), '产品决策与验收矩阵规则编号必须一致');
assert.equal(matrixRows.size, matrixRuleIds.size, '验收矩阵规则行必须都能解析出标题、步骤和通过条件');

const categorized = new Set();
for (const item of [...catalog.journeys, ...catalog.releaseSuites]) {
  assert.ok(item.id && item.title && Array.isArray(item.rules));
  for (const rule of item.rules) {
    assert.ok(decisionIds.has(rule), `${item.id} 引用了未知规则 ${rule}`);
    categorized.add(rule);
  }
}

const missing = [...decisionIds].filter(id => !categorized.has(id));
assert.deepEqual(missing, [], `规则目录缺少：${missing.join(', ')}`);
assert.ok(Array.isArray(catalog.ruleAcceptance), '规则目录缺少 ruleAcceptance');

const acceptanceByRule = new Map();
for (const acceptance of catalog.ruleAcceptance) {
  assert.ok(decisionIds.has(acceptance.rule), `规则验收引用未知规则 ${acceptance.rule}`);
  assert.equal(acceptanceByRule.has(acceptance.rule), false, `规则验收重复：${acceptance.rule}`);
  acceptanceByRule.set(acceptance.rule, acceptance);
  assert.equal(typeof acceptance.title, 'string', `${acceptance.rule} 缺少标题`);
  assert.ok(typeof acceptance.remaining === 'string' && acceptance.remaining.trim(), `${acceptance.rule} 缺少具体剩余缺口说明`);
  assert.doesNotMatch(
    acceptance.remaining,
    /当前产品实现或可重复验收入口尚未完成|验收标准：/u,
    `${acceptance.rule} 的 remaining 仍是泛化占位，必须说明具体缺失能力`
  );
  assert.ok(['unit', 'integration', 'electron-e2e', 'visual', 'native', 'real-service', 'model-smoke', 'document'].includes(acceptance.layer), `${acceptance.rule} 验收层无效`);
  assert.ok(Array.isArray(acceptance.scenarios) && acceptance.scenarios.length > 0, `${acceptance.rule} 缺少完整验收场景`);
  assert.ok(Array.isArray(acceptance.evidence) && acceptance.evidence.length > 0, `${acceptance.rule} 缺少证据要求`);
  assert.ok(Array.isArray(acceptance.journeyIds) && acceptance.journeyIds.length > 0, `${acceptance.rule} 缺少旅程或发布套件归属`);
  const row = matrixRows.get(acceptance.rule);
  assert.ok(row, `${acceptance.rule} 不在验收矩阵`);
  assert.equal(acceptance.title, row.title, `${acceptance.rule} 验收标题与矩阵不一致`);
  assert.equal(acceptance.matrix.steps, row.steps, `${acceptance.rule} 矩阵步骤不一致`);
  assert.equal(acceptance.matrix.expected, row.expected, `${acceptance.rule} 矩阵条件不一致`);
  for (const scenario of acceptance.scenarios) {
    assert.match(scenario.id, new RegExp(`^${acceptance.rule}-\\d{2}$`), `${acceptance.rule} 场景编号无效`);
    assert.ok(Array.isArray(scenario.steps) && scenario.steps.length >= 2, `${scenario.id} 至少需要两个具体操作`);
    assert.ok(Array.isArray(scenario.expected) && scenario.expected.length >= 1, `${scenario.id} 缺少可观察断言`);
    assert.ok(Array.isArray(scenario.evidence) && scenario.evidence.length > 0, `${scenario.id} 缺少证据要求`);
    assert.equal(
      scenario.steps.length === 1 && scenario.steps[0] === row.steps,
      false,
      `${scenario.id} 不能把矩阵整行原样当作执行步骤`
    );
    assert.equal(
      scenario.expected.length === 1 && scenario.expected[0] === row.expected,
      false,
      `${scenario.id} 不能把矩阵整行原样当作通过条件`
    );
  }
}
assert.deepEqual(
  [...decisionIds].filter(rule => !acceptanceByRule.has(rule)),
  [],
  '每条规则必须有独立的完整验收场景'
);

for (const [rule, row] of matrixRows) {
  assert.ok(acceptanceByRule.has(rule), `${rule} 尚无完整验收场景`);
  const cases = catalog.cases.filter(testCase => testCase.rules.includes(rule));
  assert.ok(cases.length > 0, `${rule} 尚无局部测试证据或明确缺口`);
}

const assignedRules = new Map();
for (const item of [...catalog.journeys, ...catalog.releaseSuites]) {
  for (const rule of item.rules) {
    const sections = assignedRules.get(rule) ?? [];
    sections.push(item.id);
    assignedRules.set(rule, sections);
  }
}
for (const acceptance of catalog.ruleAcceptance) {
  assert.deepEqual(
    acceptance.journeyIds,
    assignedRules.get(acceptance.rule),
    `${acceptance.rule} 的旅程或发布套件归属与分组定义不一致`
  );
}

const caseIds = new Set();
const referencedRules = new Set();
for (const item of catalog.cases) {
  assert.match(item.id, /^[A-Z0-9][A-Za-z0-9._-]+$/);
  assert.equal(caseIds.has(item.id), false, `测试案例编号重复：${item.id}`);
  caseIds.add(item.id);
  assert.ok(Array.isArray(item.rules) && item.rules.length > 0, `${item.id} 缺少规则映射`);
  for (const rule of item.rules) {
    assert.ok(decisionIds.has(rule), `${item.id} 引用了未知规则 ${rule}`);
    referencedRules.add(rule);
  }
  assert.ok(['feature', 'candidate', 'release'].includes(item.gate), `${item.id} gate 无效`);
  assert.ok(['unit', 'integration', 'electron-e2e', 'visual', 'native', 'real-service', 'model-smoke', 'document'].includes(item.layer), `${item.id} layer 无效`);
  assert.ok(typeof item.target === 'string' && item.target.length > 0, `${item.id} 缺少测试入口`);
  assert.ok(Array.isArray(item.journeyIds) && item.journeyIds.length > 0, `${item.id} 缺少旅程或发布套件归属`);
  for (const section of item.journeyIds) {
    assert.ok(
      assignedRules.get(item.rules[0])?.includes(section),
      `${item.id} 的归属 ${section} 未包含 ${item.rules[0]}`
    );
  }
  assert.ok(Array.isArray(item.steps) && item.steps.length > 0, `${item.id} 缺少验收步骤`);
  assert.ok(Array.isArray(item.expected) && item.expected.length > 0, `${item.id} 缺少通过条件`);
  assert.ok(Array.isArray(item.invalidates) && item.invalidates.length > 0, `${item.id} 缺少失效范围`);
  assert.ok(Array.isArray(item.evidence) && item.evidence.length > 0, `${item.id} 缺少证据类型`);
  assert.ok(item.status === undefined || ['implemented', 'not_implemented'].includes(item.status), `${item.id} status 无效`);
  if (item.status === 'not_implemented') {
    assert.equal(item.testName, null, `${item.id} 未实现的案例不能声明测试名`);
    assert.ok(Array.isArray(item.limitations) && item.limitations.length > 0, `${item.id} 未实现案例必须说明缺口`);
    assert.doesNotMatch(
      item.limitations.join('\n'),
      /当前产品实现或可重复验收入口尚未完成|验收标准：|现有后端测试只覆盖局部持久化或模型行为/u,
      `${item.id} 的未实现说明仍是泛化占位，必须写明具体缺失能力`
    );
  } else {
    assert.ok(typeof item.testName === 'string' && item.testName.length > 0, `${item.id} 缺少测试名`);
    const target = resolve(root, item.target);
    assert.ok(existsSync(target), `${item.id} 的测试目标不存在：${item.target}`);
    const targetSource = readFileSync(target, 'utf8');
    const quotedNames = [
      `test('${item.testName}'`,
      `test("${item.testName}"`,
      `test(\`${item.testName}\``
    ];
    assert.ok(
      quotedNames.some(value => targetSource.includes(value)),
      `${item.id} 的测试名未在 ${item.target} 中注册：${item.testName}`
    );
  }
}

for (const rule of decisionIds) {
  const cases = catalog.cases.filter(item => item.rules.includes(rule));
  assert.ok(cases.length > 0, `${rule} 尚无测试案例或明确缺口`);
}

const implementedCases = catalog.cases.filter(item => item.status !== 'not_implemented');
console.log(JSON.stringify({
  rules: decisionIds.size,
  acceptancePlans: catalog.ruleAcceptance.length,
  acceptanceScenarios: catalog.ruleAcceptance.reduce((count, item) => count + item.scenarios.length, 0),
  journeys: catalog.journeys.length,
  releaseSuites: catalog.releaseSuites.length,
  testCases: catalog.cases.length,
  implementedCases: implementedCases.length,
  notImplementedCases: catalog.cases.length - implementedCases.length,
  mappedRules: referencedRules.size
}, null, 2));
