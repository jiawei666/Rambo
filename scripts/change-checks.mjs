import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    staged: { type: 'boolean', default: false },
    run: { type: 'boolean', default: false },
    paths: { type: 'string' }
  }
});

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) return '';
  return result.stdout;
}

function changedPaths() {
  if (values.paths) return values.paths.split(',').map(value => value.trim()).filter(Boolean);
  const flags = values.staged ? ['diff', '--cached', '--name-only'] : ['status', '--short'];
  const raw = git(flags);
  if (!raw) return [];
  return raw.split('\n').map(line => {
    if (values.staged) return line.trim();
    const path = line.slice(3).trim();
    return path.includes(' -> ') ? path.split(' -> ').pop() : path;
  }).filter(Boolean);
}

const matrix = JSON.parse(readFileSync(join(root, 'tests/change-checks.json'), 'utf8'));
const paths = [...new Set([...changedPaths(), ...positionals])];
if (!paths.length) {
  console.error('没有检测到改动。请先修改文件，或用 --paths 指定范围。');
  process.exit(2);
}

function globToRegex(glob) {
  const pattern = glob
    .split('**')
    .map(segment => segment
      .split('*')
      .map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*'))
    .join('.*');
  return new RegExp(`^${pattern}$`);
}

const selected = [];
const matchedAreas = new Set();
for (const path of paths) {
  for (const area of matrix.areas) {
    if (!area.paths.some(glob => globToRegex(glob).test(path))) continue;
    matchedAreas.add(area.id);
    for (const check of area.checks) {
      selected.push({
        check,
        area: area.id,
        reason: area.reason,
        path,
        targets: check === 'backend-unit'
          ? (area.backendTargets ?? []).map(target =>
            target
              .replace('{path}', path)
              .replace('{stem}', path.split('/').pop().replace(/\.[^.]+$/, ''))
          ).filter(target => existsSync(join(root, target)))
          : check === 'electron-e2e'
            ? (area.e2eTargets ?? []).filter(target => existsSync(join(root, target)))
            : []
      });
    }
  }
}
const unmatched = paths.filter(path =>
  !matrix.areas.some(area => area.paths.some(glob => globToRegex(glob).test(path)))
);
if (paths.includes('package.json')) {
  const packageDiff = git(['diff', '--unified=0', '--', 'package.json']);
  if (/^[+-]\s*"(?:dependencies|devDependencies|build|main)"\s*:/m.test(packageDiff) ||
      /^[+-]\s*"[^"]+"\s*:\s*"[^"]+"\s*,?$/m.test(packageDiff) && git(['diff', '--name-only', '--', 'package-lock.json'])) {
    selected.push({
      check: 'typecheck',
      area: 'package-manifest',
      reason: 'package 依赖或构建配置变化',
      path: 'package.json',
      targets: []
    }, {
      check: 'build',
      area: 'package-manifest',
      reason: 'package 依赖或构建配置变化',
      path: 'package.json',
      targets: []
    });
  }
}

const filtered = selected.filter(item => {
  if (item.area === 'unregistered-main' && matchedAreas.has('main-host-runtime')) return false;
  if (item.area === 'unregistered-renderer' && matchedAreas.has('renderer')) return false;
  return true;
});

const byCheck = new Map();
for (const item of filtered) {
  const current = byCheck.get(item.check) ?? { ...item, targets: new Set(), paths: new Set(), areas: new Set() };
  current.paths.add(item.path);
  current.areas.add(item.area);
  for (const target of item.targets) current.targets.add(target);
  byCheck.set(item.check, current);
}

for (const item of [...byCheck.values()]) {
  setArray(item, 'targets');
  setArray(item, 'paths');
  setArray(item, 'areas');
}

// Explicit user-visible flow changes can opt into the related Electron spec.
const e2eMapping = [
  { areas: ['electron-avatar-picker'], target: 'tests/e2e/avatar-picker.spec.mjs', trigger: /avatar/ },
  { areas: ['electron-file-preview'], target: 'tests/e2e/media-preview.spec.mjs', trigger: /file preview/i },
  { areas: ['renderer'], target: 'tests/e2e/private-chat.spec.mjs', trigger: /private-chat|唯一私聊|消息流/ },
  { areas: ['renderer'], target: 'tests/e2e/group-chat.spec.mjs', trigger: /群聊|group/i }
];
const matchedE2eAreas = new Set(e2eMapping.flatMap(mapping =>
  mapping.areas.some(area => matchedAreas.has(area)) ? mapping.areas : []
));
const diffCache = {};
const changedDiff = paths.map(path => Object.hasOwn(diffCache, path)
  ? diffCache[path]
  : (diffCache[path] = git(['diff', '--unified=0', '--', path]))).join('\n');
const explicitE2e = paths.includes('src/renderer/robot-avatar.tsx') ||
  paths.includes('tests/e2e/avatar-picker.spec.mjs');
const needsE2E = explicitE2e || matchedAreas.has('electron-file-preview') ||
  matchedAreas.has('electron-test-harness') || (paths.includes('src/renderer/App.tsx') &&
  e2eMapping.some(mapping => mapping.areas.some(area => matchedE2eAreas.has(area)) &&
    mapping.trigger.test(changedDiff)));
if (needsE2E) {
  const targets = e2eMapping
    .filter(mapping =>
      (explicitE2e && mapping.areas.includes('electron-avatar-picker')) ||
      mapping.areas.includes('electron-file-preview') && matchedAreas.has('electron-file-preview') ||
      mapping.trigger.test(changedDiff)
    )
    .map(mapping => mapping.target);
  byCheck.set('electron-e2e', {
    check: 'electron-e2e',
    area: 'escalation',
    reason: '改动涉及真实 Electron 用户流程',
    paths: [...paths],
    targets,
    areas: ['renderer']
  });
}

const checks = [...byCheck.values()]
  .map(item => ({ ...item, ...matrix.checks[item.check] }))
  .sort((a, b) => a.cost - b.cost);

if (!checks.length) {
  console.log(JSON.stringify({
    changedPaths: paths,
    checks: [],
    unmatched,
    note: '没有命中的自动检查；请在完成后说明改动与未运行检查的原因。'
  }, null, 2));
  process.exit(0);
}

console.log(JSON.stringify({
  changedPaths: paths,
  unmatched,
  plan: checks.map(item => ({
    check: item.check,
    label: item.label,
    areas: item.areas,
    reason: item.reason,
    targets: item.targets
  })),
  skipped: matrix.areas
    .filter(area => !matchedAreas.has(area.id))
    .map(area => ({ area: area.id, label: area.label, reason: '本轮路径未命中该模块' }))
}, null, 2));

if (values.run) {
  for (const item of checks) {
    const command = item.command.map(value =>
      value === '{targets}' ? item.targets.join(' ') : value
    );
    const [bin, ...args] = command;
    const result = spawnSync(bin, args, { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

function setArray(object, key) {
  object[key] = [...object[key]];
}
