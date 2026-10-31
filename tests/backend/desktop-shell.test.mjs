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

test('Windows uses a hidden title bar with native overlay controls', () => {
  const base = { width: 1100, height: 760 };
  const mac = shell.browserWindowOptions('darwin', base);
  assert.equal(mac.titleBarStyle, 'hiddenInset');
  assert.deepEqual(mac.trafficLightPosition, { x: 16, y: 16 });

  const windows = shell.browserWindowOptions('win32', base);
  assert.equal(windows.titleBarStyle, 'hidden');
  assert.equal(windows.autoHideMenuBar, true);
  assert.deepEqual(windows.titleBarOverlay, {
    color: '#fcfcfc',
    symbolColor: '#1c1c1c',
    height: 44
  });
  assert.equal('trafficLightPosition' in windows, false);

  const darkWindows = shell.browserWindowOptions('win32', base, true);
  assert.deepEqual(darkWindows.titleBarOverlay, {
    color: '#121212',
    symbolColor: '#f5f5f5',
    height: 44
  });
});

test('Windows has no application menu because its title bar is application-owned', () => {
  assert.deepEqual(shell.applicationMenuTemplate('win32', () => {}), []);
});

test('macOS application menu keeps the standard app menu', () => {
  const template = shell.applicationMenuTemplate('darwin', () => {});
  assert.equal(template[0].label, 'Rambo');
  assert.equal(template[0].submenu[0].role, 'about');
  assert.equal(template[2].submenu[2].role, 'front');
});
