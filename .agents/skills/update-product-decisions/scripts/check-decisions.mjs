import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const decisionsPath = resolve(root, 'docs/product-decisions.md');
const matrixPath = resolve(root, 'docs/acceptance-matrix.md');
const followupsPath = resolve(root, 'docs/decision-followups.md');
const plansPath = resolve(root, 'tests/acceptance/rule-plans.mjs');
const catalogPath = resolve(root, 'tests/acceptance/catalog.json');

for (const path of [decisionsPath, matrixPath, followupsPath, plansPath, catalogPath]) {
  if (!existsSync(path)) throw new Error(`缺少决策同步文件：${path}`);
}

const decisions = readFileSync(decisionsPath, 'utf8');
const matrix = readFileSync(matrixPath, 'utf8');
const followups = readFileSync(followupsPath, 'utf8');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

const decisionRows = [...decisions.matchAll(/^\|\s*([A-Z]\d{2})\s*\|/gm)].map(match => match[1]);
const decisionIds = new Set(decisionRows);
if (decisionIds.size !== decisionRows.length) throw new Error('产品决策存在重复编号');

const matrixIds = new Set([...matrix.matchAll(/^\|\s*([A-Z]\d{2})\s*\|/gm)].map(match => match[1]));
const missingMatrix = [...decisionIds].filter(id => !matrixIds.has(id));
const staleMatrix = [...matrixIds].filter(id => !decisionIds.has(id));
if (missingMatrix.length || staleMatrix.length) {
  throw new Error(`决策与矩阵编号不一致：缺少矩阵 ${missingMatrix.join(', ') || '无'}；矩阵多出 ${staleMatrix.join(', ') || '无'}`);
}

for (const match of decisions.matchAll(/\]\(([^)#]+\.md)#([^)]+)\)/g)) {
  const target = resolve(root, 'docs', match[1]);
  if (!existsSync(target)) throw new Error(`产品决策链接目标不存在：${match[1]}`);
  const text = readFileSync(target, 'utf8');
  const escaped = match[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`<a\\s+(?:id|name)=["']${escaped}["']`, 'i').test(text)) {
    throw new Error(`产品决策链接锚点不存在：${match[1]}#${match[2]}`);
  }
}

const planRules = new Set([...readFileSync(plansPath, 'utf8').matchAll(/plan\('([A-Z]\d{2})'/g)].map(match => match[1]));
const missingPlan = [...decisionIds].filter(id => !planRules.has(id));
const stalePlan = [...planRules].filter(id => !decisionIds.has(id));
if (missingPlan.length || stalePlan.length) {
  throw new Error(`决策与规则计划不一致：缺少计划 ${missingPlan.join(', ') || '无'}；计划多出 ${stalePlan.join(', ') || '无'}`);
}

const acceptanceRules = new Set(catalog.ruleAcceptance?.map(item => item.rule) ?? []);
const missingAcceptance = [...decisionIds].filter(id => !acceptanceRules.has(id));
if (missingAcceptance.length) throw new Error(`规则目录缺少验收：${missingAcceptance.join(', ')}`);

const currentSection = decisions.split('## 12. 尚未定案')[0];
const currentText = currentSection.slice(Math.max(0, currentSection.indexOf('## 1.')));
const undecidedSection = decisions.split('## 12. 尚未定案')[1]?.split('## 13.')[0] ?? '';
const contradictory = [...decisionIds].filter(id =>
  new RegExp(`\\b${id}\\b`).test(undecidedSection) &&
  new RegExp(`^\\|\\s*${id}\\s*\\|`, 'm').test(currentText)
);
if (contradictory.length) {
  console.warn(`注意：以下现行编号仍出现在“尚未定案”区，人工核对是否为同一冲突语义：${contradictory.join(', ')}`);
}

console.log(JSON.stringify({
  rules: decisionIds.size,
  rulePlans: planRules.size,
  ruleAcceptance: acceptanceRules.size,
  followupAnchors: [...followups.matchAll(/<a\s+id="([^"]+)"/g)].length,
  status: 'consistent'
}, null, 2));
