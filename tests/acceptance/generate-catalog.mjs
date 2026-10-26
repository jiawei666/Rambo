import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RULE_PLANS } from './rule-plans.mjs';

const root = resolve(import.meta.dirname, '../..');
const matrix = readFileSync(resolve(root, 'docs/acceptance-matrix.md'), 'utf8');
const catalogPath = resolve(root, 'tests/acceptance/catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

const rows = new Map();
for (const line of matrix.split('\n')) {
  const match = line.match(
    /^\|\s*([A-Z]\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/
  );
  if (!match) continue;
  rows.set(match[1], {
    id: match[1],
    title: match[2].trim(),
    steps: match[3].trim(),
    expected: match[4].trim()
  });
}

const activeRules = new Set(rows.keys());
for (const group of [...catalog.journeys, ...catalog.releaseSuites]) {
  group.rules = group.rules.filter(rule => activeRules.has(rule));
}
catalog.ruleAcceptance = (catalog.ruleAcceptance ?? [])
  .filter(item => activeRules.has(item.rule));
catalog.cases = catalog.cases.flatMap(item => {
  item.rules = item.rules.filter(rule => activeRules.has(rule));
  return item.rules.length ? [item] : [];
});

const plans = new Map(RULE_PLANS.map(item => [item.rule, item]));
const fullAcceptanceIds = new Set(RULE_PLANS.flatMap(item =>
  item.scenarios.map(scenario => scenario.id)
));

// Full acceptance scenarios live in ruleAcceptance. A same-named placeholder
// in cases would make coverage look complete before any executable evidence
// exists, so reject stale generated rows rather than silently preserving them.
catalog.cases = catalog.cases.filter(item => !fullAcceptanceIds.has(item.id));
const groupsByRule = new Map();
for (const group of [...catalog.journeys, ...catalog.releaseSuites]) {
  for (const rule of group.rules) {
    const groups = groupsByRule.get(rule) ?? [];
    if (!groups.includes(group.id)) groups.push(group.id);
    groupsByRule.set(rule, groups);
  }
}

for (const item of catalog.cases) {
  if (item.status === 'implemented') {
    const target = resolve(root, item.target);
    if (existsSync(target)) {
      const source = readFileSync(target, 'utf8');
      if (!source.includes(`test('${item.testName}'`)) {
        throw new Error(`${item.id} 的已实现测试名不在目标文件中：${item.testName}`);
      }
    }
  }
  item.journeyIds = [...new Set(item.rules.flatMap(rule => groupsByRule.get(rule) ?? []))];
  const row = rows.get(item.rules[0]);
  if (row) {
    item.title = row.title;
    item.matrix = {
      steps: row.steps,
      expected: row.expected
    };
  }
}

if (!Array.isArray(catalog.ruleAcceptance)) {
  throw new Error('catalog.json 缺少 ruleAcceptance；本版要求把完整规则场景与局部测试证据分开');
}
const existingRuleIds = new Set(catalog.ruleAcceptance.map(item => item.rule));
for (const item of RULE_PLANS) {
  const row = rows.get(item.rule);
  if (!row) throw new Error(`${item.rule} 在验收矩阵中不存在`);
  const groups = groupsByRule.get(item.rule);
  if (!groups?.length) throw new Error(`${item.rule} 没有旅程或发布套件归属`);
  const acceptance = {
    rule: item.rule,
    title: row.title,
    matrix: { steps: row.steps, expected: row.expected },
    layer: item.layer,
    scenarios: item.scenarios,
    evidence: [...new Set(item.scenarios.flatMap(scenario => scenario.evidence))],
    remaining: item.remaining,
    journeyIds: [
      ...new Set([
        ...groups,
        ...catalog.cases
          .filter(testCase => testCase.rules.includes(item.rule))
          .flatMap(testCase => testCase.journeyIds ?? [])
      ])
    ].filter(groupId =>
      [...catalog.journeys, ...catalog.releaseSuites]
        .find(group => group.id === groupId)?.rules.includes(item.rule)
    )
  };
  const index = catalog.ruleAcceptance.findIndex(value => value.rule === item.rule);
  if (index >= 0) catalog.ruleAcceptance[index] = acceptance;
  else catalog.ruleAcceptance.push(acceptance);
  existingRuleIds.add(item.rule);
}

// Old placeholder cases predate the per-rule acceptance scenarios. Replace
// only broad stock wording with the concrete remaining gap for the associated
// rule. Case-specific limitations are intentionally preserved.
const acceptanceByRule = new Map(catalog.ruleAcceptance.map(item => [item.rule, item]));
const isGenericLimitation = value =>
  /当前产品实现或可重复验收入口尚未完成|验收标准：|现有后端测试只覆盖局部持久化或模型行为/u.test(value);
for (const item of catalog.cases) {
  if (item.status !== 'not_implemented') continue;
  const current = Array.isArray(item.limitations) ? item.limitations : [];
  if (!current.length || !current.every(isGenericLimitation)) continue;
  const concrete = [...new Set(item.rules
    .map(rule => acceptanceByRule.get(rule)?.remaining)
    .filter(Boolean))];
  if (concrete.length) item.limitations = concrete;
}

writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

const missingRules = [...rows.keys()].filter(rule =>
  !catalog.ruleAcceptance.some(testCase => testCase.rule === rule)
);
if (missingRules.length) {
  throw new Error(`以下规则还没有测试案例或明确缺口：${missingRules.join(', ')}`);
}

console.log(`已同步 ${catalog.cases.length} 个测试案例与验收矩阵`);
