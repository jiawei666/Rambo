import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(
  new URL('../../src/main/platform/desktop-shell.ts', import.meta.url),
  'utf8'
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const shell = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('macOS window chrome is not applied to Windows', () => {
  const base = { width: 1100, height: 760 };
  const mac = shell.browserWindowOptions('darwin', base);
  assert.equal(mac.titleBarStyle, 'hiddenInset');
  assert.deepEqual(mac.trafficLightPosition, { x: 16, y: 16 });

  const windows = shell.browserWindowOptions('win32', base);
  assert.deepEqual(windows, base);
  assert.equal('titleBarStyle' in windows, false);
  assert.equal('trafficLightPosition' in windows, false);
});

test('only macOS uses a template tray image', () => {
  assert.equal(shell.trayImageIsTemplate('darwin'), true);
  assert.equal(shell.trayImageIsTemplate('win32'), false);
});

test('Windows application menu uses Windows roles and labels', () => {
  const shown = [];
  const template = shell.applicationMenuTemplate('win32', () => shown.push(true));
  assert.deepEqual(template.map(item => item.label), ['文件', '编辑', '窗口']);
  assert.equal(template[0].submenu[2].role, 'quit');
  assert.equal(template[1].submenu[5].role, 'paste');
  assert.equal(template[1].submenu[5].label, '粘贴');
  template[0].submenu[0].click();
  assert.deepEqual(shown, [true]);
});

test('macOS application menu keeps the standard app menu', () => {
  const template = shell.applicationMenuTemplate('darwin', () => {});
  assert.equal(template[0].label, 'Rambo');
  assert.equal(template[0].submenu[0].role, 'about');
  assert.equal(template[2].submenu[2].role, 'front');
});
