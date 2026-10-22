import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  allowPositionals: true,
  options: {
    gate: { type: 'string', default: 'feature' },
    rules: { type: 'string' },
    sections: { type: 'string' },
    issue: { type: 'string' }
  }
});

if (!['feature', 'regression', 'candidate', 'release'].includes(values.gate)) {
  throw new Error('--gate 必须是 feature、regression、candidate 或 release');
}

const catalog = JSON.parse(readFileSync(join(root, 'tests/acceptance/catalog.json'), 'utf8'));
const acceptanceByRule = new Map(catalog.ruleAcceptance.map(item => [item.rule, item]));
const knownRules = new Set([
  ...catalog.ruleAcceptance.map(item => item.rule)
]);
const requestedRules = values.rules
  ? values.rules.split(',').map(value => value.trim()).filter(Boolean)
  : [];
const requestedSections = values.sections
  ? values.sections.split(',').map(value => value.trim()).filter(Boolean)
  : [];
for (const rule of requestedRules) {
  if (!knownRules.has(rule)) throw new Error(`未知规则：${rule}`);
}
const knownSections = new Set([
  ...catalog.journeys.map(item => item.id),
  ...catalog.releaseSuites.map(item => item.id)
]);
for (const section of requestedSections) {
  if (!knownSections.has(section)) throw new Error(`未知旅程或发布套件：${section}`);
}
if (values.issue && !requestedRules.length) {
  throw new Error('--issue 回归目前要求同时提供 --rules，避免把未映射问题误报为已覆盖');
}
if (['feature', 'regression'].includes(values.gate) && !requestedRules.length) {
  throw new Error(`${values.gate} 运行必须提供 --rules，例如 --rules B13,G02`);
}
if (['feature', 'regression'].includes(values.gate) && requestedSections.length) {
  throw new Error(`${values.gate} 运行不接受 --sections；请用 verify:release 验证旅程或发布套件`);
}
if (values.gate === 'candidate' && (requestedRules.length || requestedSections.length)) {
  throw new Error('candidate 会执行全部自动案例，不接受 --rules 或 --sections');
}
if (values.gate === 'release' && !requestedSections.length) {
  throw new Error('release 必须提供 --sections，例如 --sections J1,J2,J3,J4');
}

const output = [];
function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  output.push(`\n## ${label}\n\n$ ${command} ${args.join(' ')}\n\n${result.stdout}${result.stderr}`);
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${label} 失败（exit ${result.status}）`);
  }
  process.stdout.write(`✓ ${label}\n`);
  return result;
}

function sectionRules(section) {
  const item = [...catalog.journeys, ...catalog.releaseSuites].find(value => value.id === section);
  return item ? item.rules : [];
}

function selectedFor(gate) {
  const implemented = catalog.cases.filter(item => item.status !== 'not_implemented');
  if (gate === 'candidate') return implemented;
  if (gate === 'release') {
    const rules = new Set(requestedSections.flatMap(sectionRules));
    return implemented.filter(item => item.rules.some(rule => rules.has(rule)));
  }
  return implemented.filter(item =>
    item.gate === 'feature' && item.rules.some(rule => requestedRules.includes(rule))
  );
}

const selectedCases = selectedFor(values.gate);
const selectedRules = values.gate === 'release'
  ? requestedSections.flatMap(sectionRules)
  : values.gate === 'candidate'
    ? [...knownRules]
    : requestedRules;
const selectedAcceptance = selectedRules.map(rule => acceptanceByRule.get(rule)).filter(Boolean);
const uncovered = selectedRules.filter(rule =>
  !selectedCases.some(item => item.rules.includes(rule))
);
const missingCases = catalog.cases.filter(item =>
  item.status === 'not_implemented' &&
  item.rules.some(rule => selectedRules.includes(rule))
);

if (values.gate === 'feature' && uncovered.length) {
  throw new Error(`所选规则尚无已实现测试：${uncovered.join(', ')}`);
}
if (values.gate === 'candidate') {
  const missingRuleCoverage = [...knownRules].filter(rule => !acceptanceByRule.has(rule));
  if (missingRuleCoverage.length) {
    throw new Error(`规则目录缺少完整验收场景：${missingRuleCoverage.join(', ')}`);
  }
  const candidateGaps = catalog.cases.filter(item => item.status === 'not_implemented');
  if (candidateGaps.length) {
    const byRule = new Map();
    for (const item of candidateGaps) {
      for (const rule of item.rules) byRule.set(rule, item.id);
    }
    throw new Error(
      `候选版本被未实现案例阻止：${candidateGaps.length} 个案例，涉及规则 ${[...byRule.keys()].join(', ')}`
    );
  }
}
if (values.gate === 'release' && (uncovered.length || missingCases.length)) {
  const parts = [];
  if (uncovered.length) parts.push(`无已实现测试：${uncovered.join(', ')}`);
  if (missingCases.length) parts.push(`未实现案例：${missingCases.map(item => item.id).join(', ')}`);
  throw new Error(`发布验收被缺口阻止；${parts.join('；')}`);
}
if (values.gate === 'candidate' && !selectedCases.length) {
  throw new Error('候选版本没有任何已实现自动案例');
}
if (!selectedCases.length) {
  throw new Error('所选规则没有可执行测试案例');
}

run(process.execPath, ['tests/acceptance/validate-catalog.mjs'], '规则目录', output);

const candidateCases = selectedCases.filter(item =>
  item.target.startsWith('tests/candidate/')
);
const nodeCases = selectedCases.filter(item =>
  ['unit', 'integration'].includes(item.layer) &&
  !candidateCases.includes(item)
);
const nodePatterns = [...new Set(nodeCases.map(item => item.testName))];
if (nodePatterns.length) {
  const pattern = nodePatterns.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  run(process.execPath, [
    '--test',
    `--test-name-pattern=^(${pattern})$`,
    ...new Set(nodeCases.map(item => item.target))
  ], '规则关联单元与集成测试', output);
}

if (candidateCases.length) {
  const patterns = [...new Set(candidateCases.map(item => item.testName))];
  const pattern = patterns.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  run(process.execPath, [
    '--test',
    `--test-name-pattern=^(${pattern})$`,
    ...new Set(candidateCases.map(item => item.target))
  ], '候选工件', output);
}

const e2eCases = selectedCases.filter(item => item.layer === 'electron-e2e');
if (e2eCases.length) {
  if (e2eCases.some(item => !item.target.startsWith('tests/e2e/packaged-'))) {
    run('npm', ['run', 'build'], 'Electron 构建', output);
  }
  const patterns = e2eCases.map(item => item.testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  run('npx', [
    'playwright', 'test', '--workers=1',
    ...(patterns.length ? [`--grep=(${patterns.join('|')})`] : []),
    '--',
    ...new Set(e2eCases.map(item => item.target))
  ], 'Electron E2E', output);
}

const executedCaseCount =
  nodeCases.reduce((count, item) => count + (item.testName ? 1 : 0), 0) +
  candidateCases.reduce((count, item) => count + (item.testName ? 1 : 0), 0) +
  e2eCases.reduce((count, item) => count + (item.testName ? 1 : 0), 0);
if (executedCaseCount !== selectedCases.length) {
  throw new Error(
    `测试执行计划不完整：选中 ${selectedCases.length} 个案例，但只调度了 ${executedCaseCount} 个`
  );
}

const unsupportedLayers = [...new Set(selectedCases
  .map(item => item.layer)
  .filter(layer => !['unit', 'integration', 'electron-e2e'].includes(layer)))];
if (unsupportedLayers.length) {
  throw new Error(`所选案例包含自动化执行器尚未支持的证据层：${unsupportedLayers.join(', ')}`);
}

function walk(directory) {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const info = statSync(path);
    if (info.isDirectory()) files.push(...walk(path));
    else if (info.isFile()) files.push(path);
  }
  return files;
}

const hash = createHash('sha256');
const targetFiles = [...new Set(selectedCases
  .map(item => resolve(root, item.target))
  .filter(path => existsSync(path) && statSync(path).isFile()))];
const sourceFiles = targetFiles.length
  ? targetFiles
  : walk(join(root, 'tests')).filter(path => /\.(?:mjs|js|json)$/.test(path));
for (const path of sourceFiles) {
  hash.update(relative(root, path));
  hash.update('\0');
  hash.update(readFileSync(path));
  hash.update('\0');
}

const resultDirectory = join(root, 'test-results', `${values.gate}-${Date.now()}`);
mkdirSync(resultDirectory, { recursive: true });
const report = {
  schema: 'rambo.test.result.v1',
  gate: values.gate,
  rules: selectedRules,
  sections: requestedSections,
  issue: values.issue ?? null,
  suiteHash: hash.digest('hex'),
  executedCases: selectedCases.map(item => item.id),
  acceptanceScenarios: selectedAcceptance.flatMap(item => item.scenarios.map(scenario => scenario.id)),
  summary: {
    selectedCases: selectedCases.length,
    selectedRules: selectedRules.length,
    selectedAcceptanceScenarios: selectedAcceptance.reduce((count, item) => count + item.scenarios.length, 0),
    rulesWithImplementedCases: selectedRules.filter(rule =>
      selectedCases.some(item => item.rules.includes(rule))
    ).length,
    rulesWithoutImplementedCases: selectedRules.filter(rule =>
      !selectedCases.some(item => item.rules.includes(rule))
    ).length
  },
  rulesWithoutImplementedCases: selectedRules.filter(rule =>
    !selectedCases.some(item => item.rules.includes(rule))
  ),
  remainingUnimplementedCases: catalog.cases
    .filter(item => item.status === 'not_implemented')
    .map(item => item.id),
  startedAt: new Date().toISOString(),
  status: 'pass'
};
writeFileSync(join(resultDirectory, 'result.json'), JSON.stringify(report, null, 2));
writeFileSync(join(resultDirectory, 'output.log'), output.join('\n'));
console.log(JSON.stringify({ result: resultDirectory, ...report }, null, 2));
