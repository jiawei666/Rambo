import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

function copyProjectForValidator() {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-catalog-test-'));
  for (const path of [
    'docs/product-decisions.md',
    'docs/acceptance-matrix.md',
    'tests/acceptance/catalog.json',
    'tests/acceptance/rule-plans.mjs',
    'tests/acceptance/validate-catalog.mjs',
    'tests/backend/bot-data.test.mjs',
    'tests/backend/chat-list-model.test.mjs',
    'tests/backend/host.test.mjs',
    'tests/backend/management-actions.test.mjs',
    'tests/backend/store.test.mjs',
    'tests/e2e/media-preview.spec.mjs',
    'tests/e2e/private-chat.spec.mjs',
    'tests/e2e/group-chat.spec.mjs'
  ]) {
    cpSync(join(root, path), join(directory, path), { recursive: true });
  }
  return directory;
}

function validate(rootDirectory) {
  return spawnSync(process.execPath, [join(rootDirectory, 'tests/acceptance/validate-catalog.mjs')], {
    cwd: rootDirectory,
    encoding: 'utf8'
  });
}

test('the catalog covers every confirmed rule without treating unimplemented gaps as passing tests', () => {
  const catalog = JSON.parse(readFileSync(join(root, 'tests/acceptance/catalog.json'), 'utf8'));
  const ruleCount = catalog.ruleAcceptance.length;
  const result = validate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`"rules": ${ruleCount}`));
  assert.match(result.stdout, new RegExp(`"acceptancePlans": ${ruleCount}`));
  assert.match(result.stdout, new RegExp(`"acceptanceScenarios": ${ruleCount}`));
  assert.match(result.stdout, new RegExp(`"mappedRules": ${ruleCount}`));
  assert.ok(catalog.ruleAcceptance.every(item =>
    item.scenarios.length > 0 &&
    item.scenarios.every(scenario => scenario.steps.length >= 2) &&
    item.remaining.trim().length > 0
  ));
  assert.ok(catalog.cases.some(item => item.status === 'not_implemented'));
  assert.ok(catalog.cases.filter(item => item.status === 'not_implemented').every(item =>
    item.testName === null && item.limitations.length > 0
  ));
});

test('every acceptance plan keeps concrete steps for every matrix rule', () => {
  const catalog = JSON.parse(readFileSync(join(root, 'tests/acceptance/catalog.json'), 'utf8'));
  const accepted = new Set(catalog.ruleAcceptance.map(item => item.rule));
  assert.equal(accepted.size, catalog.ruleAcceptance.length);
  for (const item of catalog.ruleAcceptance) {
    const scenario = item.scenarios[0];
    assert.ok(scenario.steps.length >= 2, `${item.rule} 只有泛化步骤`);
    assert.notEqual(scenario.steps[0], item.matrix.steps, `${item.rule} 的步骤被矩阵整行覆盖`);
    assert.notEqual(scenario.expected[0], item.matrix.expected, `${item.rule} 的断言被矩阵整行覆盖`);
  }
});

test('a rule assigned to multiple journeys keeps every grouping in its acceptance plan', () => {
  const catalog = JSON.parse(readFileSync(join(root, 'tests/acceptance/catalog.json'), 'utf8'));
  const b02 = catalog.ruleAcceptance.find(item => item.rule === 'B02');
  assert.deepEqual(b02.journeyIds, ['J1', 'J2']);
});

test('a generic acceptance scenario cannot pass catalog validation', () => {
  const directory = copyProjectForValidator();
  try {
    const catalogPath = join(directory, 'tests/acceptance/catalog.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const acceptance = catalog.ruleAcceptance.find(item => item.rule === 'V14');
    acceptance.scenarios[0].steps = [acceptance.matrix.steps];
    writeFileSync(catalogPath, JSON.stringify(catalog));
    const result = validate(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /V14-01 至少需要两个具体操作/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a rule acceptance plan cannot use a generic missing-capability placeholder', () => {
  const directory = copyProjectForValidator();
  try {
    const catalogPath = join(directory, 'tests/acceptance/catalog.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const acceptance = catalog.ruleAcceptance.find(item => item.rule === 'R01');
    acceptance.remaining = '当前产品实现或可重复验收入口尚未完成。';
    writeFileSync(catalogPath, JSON.stringify(catalog));
    const result = validate(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /remaining|当前产品实现/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a local evidence gap cannot use a generic missing-capability placeholder', () => {
  const directory = copyProjectForValidator();
  try {
    const catalogPath = join(directory, 'tests/acceptance/catalog.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const gap = catalog.cases.find(item => item.status === 'not_implemented');
    gap.limitations = ['当前产品实现或可重复验收入口尚未完成。验收标准：不知道。'];
    writeFileSync(catalogPath, JSON.stringify(catalog));
    const result = validate(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /泛化占位|当前产品实现/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a rule without a test case or explicit gap makes catalog validation fail', () => {
  const directory = copyProjectForValidator();
  try {
    const catalogPath = join(directory, 'tests/acceptance/catalog.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    catalog.cases = catalog.cases.filter(item => !item.rules.includes('V14'));
    writeFileSync(catalogPath, JSON.stringify(catalog));
    const result = validate(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /V14 尚无局部测试证据或明确缺口/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a not_implemented gap cannot claim a test name', () => {
  const directory = copyProjectForValidator();
  try {
    const catalogPath = join(directory, 'tests/acceptance/catalog.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const gap = catalog.cases.find(item => item.status === 'not_implemented');
    gap.testName = 'fake deterministic test';
    writeFileSync(catalogPath, JSON.stringify(catalog));
    const result = validate(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /未实现的案例不能声明测试名/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an implemented case with a missing target file makes catalog validation fail', () => {
  const directory = copyProjectForValidator();
  try {
    const catalogPath = join(directory, 'tests/acceptance/catalog.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const implemented = catalog.cases.find(item => item.status === 'implemented');
    implemented.target = 'tests/backend/does-not-exist.test.mjs';
    writeFileSync(catalogPath, JSON.stringify(catalog));
    const result = validate(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /测试目标不存在/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an implemented case with a missing test name makes catalog validation fail', () => {
  const directory = copyProjectForValidator();
  try {
    const catalogPath = join(directory, 'tests/acceptance/catalog.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const implemented = catalog.cases.find(item => item.status === 'implemented');
    implemented.testName = 'a test name that is not registered';
    writeFileSync(catalogPath, JSON.stringify(catalog));
    const result = validate(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /测试名未在/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the catalog keeps the current implementation boundary explicit', () => {
  const catalog = JSON.parse(readFileSync(join(root, 'tests/acceptance/catalog.json'), 'utf8'));
  const implementedRules = new Set(catalog.cases
    .filter(item => item.status === 'implemented')
    .flatMap(item => item.rules));
  const anyGapRules = new Set(catalog.cases
    .filter(item => item.status === 'not_implemented')
    .flatMap(item => item.rules));
  const uncoveredRules = new Set(catalog.journeys.flatMap(item => item.rules)
    .concat(catalog.releaseSuites.flatMap(item => item.rules))
    .filter(rule => !implementedRules.has(rule)));

  assert.equal(catalog.cases.filter(item => item.status === 'implemented').length, 109);
  assert.ok(catalog.cases.filter(item => item.status === 'not_implemented').length >=
    new Set(catalog.cases.filter(item => item.status === 'not_implemented').flatMap(item => item.rules)).size);
  assert.equal(implementedRules.size, 49);
  assert.ok([...uncoveredRules].every(rule => anyGapRules.has(rule)),
    'Every rule without implemented evidence must have an explicit gap case');
  assert.deepEqual(
    [...implementedRules].filter(rule => anyGapRules.has(rule)).sort(),
    ['A01', 'A02', 'A04', 'A05', 'B05', 'B06', 'B08', 'B09', 'B10', 'B12', 'B13', 'G01', 'O01', 'P03', 'R11', 'R13', 'R16', 'R17', 'S02', 'V01', 'V07'].sort(),
    '只有部分证据的规则必须同时保留显式缺口'
  );
  assert.deepEqual(
    [...implementedRules].filter(rule => !anyGapRules.has(rule)).sort(),
    [
      'B01', 'B02', 'B03', 'B04', 'B07', 'F05', 'G02', 'G03', 'G04', 'G13',
      'M01', 'M02', 'M03', 'M04', 'M05', 'P01',
      'O04', 'R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R14', 'T02', 'T19', 'T20', 'T35'
    ].sort(),
    '当前已有实现证据但没有显式缺口的规则范围必须明确'
  );
});
