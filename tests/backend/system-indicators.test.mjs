import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import ts from 'typescript';

const sourcePath = new URL('../../src/main/system-indicators.ts', import.meta.url);
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;

async function loadClass() {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-system-indicators-'));
  const path = join(directory, 'system-indicators.mjs');
  writeFileSync(path, compiled, { mode: 0o600 });
  const { SystemIndicators } = await import(`${pathToFileURL(path).href}?${Date.now()}-${Math.random()}`);
  return { SystemIndicators, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-tray-fixture-'));
  writeFileSync(join(directory, 'brand.png'), 'brand');
  writeFileSync(join(directory, 'brand-dark.png'), 'brand-dark');
  return directory;
}

function createTheme(initialDark) {
  let dark = initialDark;
  const listeners = new Set();
  return {
    isDark: () => dark,
    onChange: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDark(value) {
      dark = value;
      for (const listener of listeners) listener();
    }
  };
}

function createTray() {
  return {
    imageUpdates: 0,
    tooltip: '',
    menu: null,
    ignored: false,
    setImage() { this.imageUpdates += 1; },
    setToolTip(value) { this.tooltip = value; },
    setContextMenu(value) { this.menu = value; },
    setIgnoreDoubleClickEvents(value) { this.ignored = value; },
    destroy() {}
  };
}

test('macOS uses a static template tray logo that follows the menu bar tint', async () => {
  const { SystemIndicators, cleanup } = await loadClass();
  const assetsDirectory = fixture();
  const loaded = [];
  const menus = [];
  const tray = createTray();
  const indicators = new SystemIndicators({
    platform: 'darwin',
    assetsDirectory,
    loadImage: (path, template) => {
      loaded.push({ path, template });
      return path;
    },
    theme: createTheme(true),
    createTray: image => {
      assert.equal(image, join(assetsDirectory, 'brand.png'));
      return tray;
    },
    createMenu: items => {
      menus.push(items);
      return items;
    },
    showApp() {},
    openBot() {},
    quit() {}
  });
  try {
    indicators.start();
    assert.deepEqual(loaded, [
      { path: join(assetsDirectory, 'brand.png'), template: true }
    ]);
    assert.equal(tray.tooltip, 'Rambo');
    assert.equal(tray.ignored, true);
    assert.equal(tray.imageUpdates, 0);
    assert.equal(menus.length, 1);

    indicators.update([{ botId: 'bot-1', name: 'Pilot', running: true }]);
    assert.equal(tray.imageUpdates, 0);
    assert.equal(menus.length, 2);
    assert.equal(
      menus.at(-1).find(item => item.label === '● Pilot').icon,
      join(assetsDirectory, 'brand.png')
    );

    indicators.update([{ botId: 'bot-1', name: 'Pilot', running: false }]);
    assert.equal(tray.imageUpdates, 0);
    assert.equal(menus.at(-1).find(item => item.label === 'Pilot').icon, undefined);
  } finally {
    indicators.dispose();
    cleanup();
    rmSync(assetsDirectory, { recursive: true, force: true });
  }
});

test('Windows switches its static silhouette when the system theme changes', async () => {
  const { SystemIndicators, cleanup } = await loadClass();
  const assetsDirectory = fixture();
  const loaded = [];
  const theme = createTheme(false);
  const tray = createTray();
  const indicators = new SystemIndicators({
    platform: 'win32',
    assetsDirectory,
    loadImage: (path, template) => {
      loaded.push({ path, template });
      return path;
    },
    theme,
    createTray: () => tray,
    createMenu: items => items,
    showApp() {},
    openBot() {},
    quit() {}
  });
  try {
    indicators.start();
    indicators.update([{ botId: 'bot-1', name: 'Pilot', running: true }]);
    indicators.update([]);
    assert.deepEqual(loaded, [{ path: join(assetsDirectory, 'brand.png'), template: false }]);
    assert.equal(tray.ignored, false);
    assert.equal(tray.imageUpdates, 0);

    theme.setDark(true);
    assert.deepEqual(loaded.at(-1), { path: join(assetsDirectory, 'brand-dark.png'), template: false });
    assert.equal(tray.imageUpdates, 1);

    theme.setDark(true);
    assert.equal(tray.imageUpdates, 1);
    indicators.update([{ botId: 'bot-1', name: 'Pilot', running: true }]);
    assert.equal(tray.imageUpdates, 1);
    assert.equal(
      tray.menu.find(item => item.label === '● Pilot').icon,
      join(assetsDirectory, 'brand-dark.png')
    );
  } finally {
    indicators.dispose();
    cleanup();
    rmSync(assetsDirectory, { recursive: true, force: true });
  }
});

test('the packaged tray assets carry the new logo at 1x and 2x sizes', () => {
  const png = name => {
    const png = readFileSync(new URL(`../../assets/branding/tray-frames/${name}`, import.meta.url));
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
    return png;
  };
  const dimensions = name => {
    const image = png(name);
    return [image.readUInt32BE(16), image.readUInt32BE(20)];
  };
  const alphaAt = (name, x, y) => {
    const image = png(name);
    assert.equal(image[24], 8, 'expected 8-bit channels');
    assert.equal(image[25], 6, 'expected RGBA');
    assert.equal(image[28], 0, 'expected non-interlaced PNG');

    const width = image.readUInt32BE(16);
    const height = image.readUInt32BE(20);
    const idat = [];
    for (let offset = 8; offset < image.length;) {
      const length = image.readUInt32BE(offset);
      const type = image.subarray(offset + 4, offset + 8).toString('ascii');
      if (type === 'IDAT') idat.push(image.subarray(offset + 8, offset + 8 + length));
      offset += 12 + length;
    }

    const bytesPerPixel = 4;
    const stride = width * bytesPerPixel;
    const raw = inflateSync(Buffer.concat(idat));
    const rows = [];
    for (let row = 0; row < height; row += 1) {
      const filter = raw[row * (stride + 1)];
      const source = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
      const previous = rows[row - 1];
      const decoded = Buffer.alloc(stride);
      for (let index = 0; index < stride; index += 1) {
        const left = index >= bytesPerPixel ? decoded[index - bytesPerPixel] : 0;
        const above = previous ? previous[index] : 0;
        const upperLeft = previous && index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
        const predictor =
          filter === 0
            ? 0
            : filter === 1
              ? left
              : filter === 2
                ? above
                : filter === 3
                  ? Math.floor((left + above) / 2)
                  : filter === 4
                    ? paeth(left, above, upperLeft)
                    : assert.fail(`unsupported PNG filter ${filter}`);
        decoded[index] = (source[index] + predictor) & 0xff;
      }
      rows.push(decoded);
    }
    return rows[y][x * bytesPerPixel + 3];
  };
  const paeth = (left, above, upperLeft) => {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
    return aboveDistance <= upperLeftDistance ? above : upperLeft;
  };
  assert.deepEqual(dimensions('brand.png'), [18, 18]);
  assert.deepEqual(dimensions('brand@2x.png'), [36, 36]);
  assert.deepEqual(dimensions('brand-dark.png'), [18, 18]);
  assert.deepEqual(dimensions('brand-dark@2x.png'), [36, 36]);
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  );
  for (const name of [
    'brand.png',
    'brand@2x.png',
    'brand-dark.png',
    'brand-dark@2x.png'
  ]) {
    assert.ok(packageJson.build.files.includes(`assets/branding/tray-frames/${name}`));
  }
  for (const name of ['brand.png', 'brand@2x.png', 'brand-dark.png', 'brand-dark@2x.png']) {
    const size = dimensions(name)[0];
    assert.equal(alphaAt(name, 0, 0), 0);
    assert.equal(alphaAt(name, size - 1, 0), 0);
    assert.equal(alphaAt(name, 0, size - 1), 0);
    assert.equal(alphaAt(name, size - 1, size - 1), 0);
    assert.ok(alphaAt(name, Math.floor(size / 2), Math.floor(size / 2)) > 0);
  }
  const source = readFileSync(new URL('../../assets/branding/tray-logo-source.png', import.meta.url));
  assert.deepEqual([source.readUInt32BE(16), source.readUInt32BE(20)], [1254, 1254]);
});
