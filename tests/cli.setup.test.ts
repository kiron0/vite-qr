import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectPackageManager,
  getPackageDependencyVersion,
  hasViteQRCodeSource,
  hasPackageDependency,
  injectViteQRCode,
  resolveViteProject,
} from '../src/cli/setup';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-qr-test-'));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (!tempDir) continue;
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe('injectViteQRCode', () => {
  it('injects into export default defineConfig object configs', () => {
    const source = [
      "import { defineConfig } from 'vite';",
      '',
      'export default defineConfig({',
      '  server: { host: true },',
      '});',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts');

    expect(transformed).toContain("import viteQRCode from 'vite-qr';");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('injects into defineConfig function configs', () => {
    const source = [
      "import { defineConfig } from 'vite';",
      '',
      'export default defineConfig(({ mode }) => ({',
      '  server: { host: true },',
      '}));',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts');

    expect(transformed).toContain("import viteQRCode from 'vite-qr';");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('injects into async defineConfig function configs', () => {
    const source = [
      "import { defineConfig } from 'vite';",
      '',
      'export default defineConfig(async () => ({',
      '  server: { host: true },',
      '}));',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts');

    expect(transformed).toContain("import viteQRCode from 'vite-qr';");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('injects into mergeConfig override objects', () => {
    const source = [
      "import { defineConfig, mergeConfig } from 'vite';",
      '',
      'const base = defineConfig({',
      '  server: { host: true },',
      '});',
      '',
      'export default mergeConfig(base, {',
      '  preview: { port: 4173 },',
      '});',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts');

    expect(transformed).toContain("import viteQRCode from 'vite-qr';");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('injects into defineConfig wrappers nested inside mergeConfig', () => {
    const source = [
      "import { defineConfig, mergeConfig } from 'vite';",
      '',
      'const base = defineConfig({',
      '  server: { host: true },',
      '});',
      '',
      'export default mergeConfig(base, defineConfig(async () => ({',
      '  preview: { port: 4173 },',
      '})));',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts');

    expect(transformed).toContain("import viteQRCode from 'vite-qr';");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('injects into defineConfig function declaration configs', () => {
    const source = [
      "import { defineConfig } from 'vite';",
      '',
      'function createConfig() {',
      '  return {',
      '    server: { host: true },',
      '  };',
      '}',
      '',
      'export default defineConfig(createConfig);',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts');

    expect(transformed).toContain("import viteQRCode from 'vite-qr';");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('injects through exported variable indirection to defineConfig factories', () => {
    const source = [
      "import { defineConfig } from 'vite';",
      '',
      'const config = defineConfig(async () => ({',
      '  server: { host: true },',
      '}));',
      '',
      'export default config;',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts');

    expect(transformed).toContain("import viteQRCode from 'vite-qr';");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('injects through local export-specifier default configs', () => {
    const source = [
      'const viteConfig = {',
      '  server: { host: true },',
      '};',
      '',
      'export { viteConfig as default };',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts');

    expect(transformed).toContain("import viteQRCode from 'vite-qr';");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('injects into satisfies-wrapped export default object configs', () => {
    const source = [
      'export default {',
      '  server: { host: true },',
      '} satisfies UserConfig;',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts');

    expect(transformed).toContain("import viteQRCode from 'vite-qr';");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('injects into plain export default object configs', () => {
    const source = ['export default {', '  server: { host: true },', '};', ''].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts');

    expect(transformed).toContain("import viteQRCode from 'vite-qr';");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('appends to an existing plugins array', () => {
    const source = [
      "import react from '@vitejs/plugin-react';",
      '',
      'export default {',
      '  plugins: [react()],',
      '};',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts');

    expect(transformed).toContain('plugins: [react(), viteQRCode()]');
  });

  it('wraps a non-array plugins expression instead of duplicating the key', () => {
    const source = [
      'const plugins = getPlugins();',
      '',
      'export default {',
      '  plugins,',
      '  server: { host: true },',
      '};',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts');

    expect(transformed).toContain('plugins: [plugins, viteQRCode()].flat()');
    expect(transformed?.match(/plugins:/g)).toHaveLength(1);
  });

  it('wraps a property-style non-array plugins expression', () => {
    const source = [
      'export default {',
      '  plugins: getPlugins(),',
      '  server: { host: true },',
      '};',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts');

    expect(transformed).toContain('plugins: [getPlugins(), viteQRCode()].flat()');
    expect(transformed?.match(/plugins:/g)).toHaveLength(1);
  });

  it('detects aliased default imports from vite-qr', () => {
    const source = [
      "import qr from 'vite-qr';",
      '',
      'export default {',
      '  plugins: [qr()],',
      '};',
      '',
    ].join('\n');

    expect(hasViteQRCodeSource(source, '/tmp/vite.config.ts')).toBe(true);
    expect(injectViteQRCode(source, '/tmp/vite.config.ts')).toBe(source);
  });

  it('detects default-via-named imports from vite-qr', () => {
    const source = [
      "import { default as qr } from 'vite-qr';",
      '',
      'export default {',
      '  plugins: [qr()],',
      '};',
      '',
    ].join('\n');

    expect(hasViteQRCodeSource(source, '/tmp/vite.config.ts')).toBe(true);
    expect(injectViteQRCode(source, '/tmp/vite.config.ts')).toBe(source);
  });

  it('does not false-positive on unrelated local viteQRCode helpers', () => {
    const source = [
      'function viteQRCode() {',
      '  return other();',
      '}',
      '',
      'export default {',
      '  plugins: [viteQRCode()],',
      '};',
      '',
    ].join('\n');

    expect(hasViteQRCodeSource(source, '/tmp/vite.config.ts')).toBe(false);
  });

  it('reuses an aliased default import when injecting a fresh plugin entry', () => {
    const source = [
      "import qr from 'vite-qr';",
      '',
      'export default {',
      '  server: { host: true },',
      '};',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts');

    expect(transformed).not.toContain("import viteQRCode from 'vite-qr';");
    expect(transformed).toContain('plugins: [qr()],');
  });

  it('avoids fallback import-name collisions with local viteQRCode declarations', () => {
    const source = [
      'function viteQRCode() {',
      '  return other();',
      '}',
      '',
      'export default {',
      '  plugins: [viteQRCode()],',
      '};',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts');

    expect(transformed).toContain("import viteQRCodePlugin from 'vite-qr';");
    expect(transformed).toContain('plugins: [viteQRCode(), viteQRCodePlugin()]');
  });

  it('detects namespace imports from vite-qr', () => {
    const source = [
      "import * as qr from 'vite-qr';",
      '',
      'export default {',
      '  plugins: [qr.viteQRCode()],',
      '};',
      '',
    ].join('\n');

    expect(hasViteQRCodeSource(source, '/tmp/vite.config.ts')).toBe(true);
    expect(injectViteQRCode(source, '/tmp/vite.config.ts')).toBe(source);
  });

  it('detects callable CommonJS require aliases from vite-qr', () => {
    const source = [
      "const qr = require('vite-qr');",
      '',
      'module.exports = {',
      '  plugins: [qr()],',
      '};',
      '',
    ].join('\n');

    expect(hasViteQRCodeSource(source, '/tmp/vite.config.cjs')).toBe(true);
    expect(injectViteQRCode(source, '/tmp/vite.config.cjs')).toBe(source);
  });

  it('detects property-based CommonJS require aliases from vite-qr', () => {
    const source = [
      "const qr = require('vite-qr');",
      '',
      'module.exports = {',
      '  plugins: [qr.viteQRCode()],',
      '};',
      '',
    ].join('\n');

    expect(hasViteQRCodeSource(source, '/tmp/vite.config.cjs')).toBe(true);
    expect(injectViteQRCode(source, '/tmp/vite.config.cjs')).toBe(source);
  });

  it('reuses a callable CommonJS require alias when injecting a fresh plugin entry', () => {
    const source = [
      "const qr = require('vite-qr');",
      '',
      'module.exports = {',
      '  server: { host: true },',
      '};',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.cjs');

    expect(transformed).toContain('plugins: [qr()],');
    expect(transformed).not.toContain('qr.viteQRCode()');
  });

  it('re-injects an existing plugin call in force mode', () => {
    const source = [
      "import qr from 'vite-qr';",
      '',
      'export default {',
      '  plugins: [qr({ once: false })],',
      '};',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.ts', true);

    expect(transformed).toContain('plugins: [qr()]');
    expect(transformed).not.toContain('{ once: false }');
  });

  it('detects destructured CommonJS require aliases from vite-qr', () => {
    const source = [
      "const { viteQRCode: qr } = require('vite-qr');",
      '',
      'module.exports = {',
      '  plugins: [qr()],',
      '};',
      '',
    ].join('\n');

    expect(hasViteQRCodeSource(source, '/tmp/vite.config.cjs')).toBe(true);
    expect(injectViteQRCode(source, '/tmp/vite.config.cjs')).toBe(source);
  });

  it('detects default-destructured CommonJS require aliases from vite-qr', () => {
    const source = [
      "const { default: qr } = require('vite-qr');",
      '',
      'module.exports = {',
      '  plugins: [qr()],',
      '};',
      '',
    ].join('\n');

    expect(hasViteQRCodeSource(source, '/tmp/vite.config.cjs')).toBe(true);
    expect(injectViteQRCode(source, '/tmp/vite.config.cjs')).toBe(source);
  });

  it('detects CommonJS default property aliases from vite-qr', () => {
    const source = [
      "const qr = require('vite-qr').default;",
      '',
      'module.exports = {',
      '  plugins: [qr()],',
      '};',
      '',
    ].join('\n');

    expect(hasViteQRCodeSource(source, '/tmp/vite.config.cjs')).toBe(true);
    expect(injectViteQRCode(source, '/tmp/vite.config.cjs')).toBe(source);
  });

  it('detects CommonJS named property aliases from vite-qr', () => {
    const source = [
      "const qr = require('vite-qr').viteQRCode;",
      '',
      'module.exports = {',
      '  plugins: [qr()],',
      '};',
      '',
    ].join('\n');

    expect(hasViteQRCodeSource(source, '/tmp/vite.config.cjs')).toBe(true);
    expect(injectViteQRCode(source, '/tmp/vite.config.cjs')).toBe(source);
  });

  it('supports CommonJS config exports', () => {
    const source = ['module.exports = {', '  server: { host: true },', '};', ''].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.cjs');

    expect(transformed).toContain("const viteQRCode = require('vite-qr');");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('supports exports.default config exports', () => {
    const source = ['exports.default = {', '  server: { host: true },', '};', ''].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.cjs');

    expect(transformed).toContain("const viteQRCode = require('vite-qr');");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('supports exports.default defineConfig factory configs', () => {
    const source = [
      "const { defineConfig } = require('vite');",
      '',
      'exports.default = defineConfig(() => ({',
      '  server: { host: true },',
      '}));',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.cjs');

    expect(transformed).toContain("const viteQRCode = require('vite-qr');");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('supports module.exports.default config exports', () => {
    const source = ['module.exports.default = {', '  server: { host: true },', '};', ''].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.cjs');

    expect(transformed).toContain("const viteQRCode = require('vite-qr');");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('supports computed exports default config exports', () => {
    const source = ["exports['default'] = {", '  server: { host: true },', '};', ''].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.cjs');

    expect(transformed).toContain("const viteQRCode = require('vite-qr');");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('supports computed module.exports default config exports', () => {
    const source = ["module.exports['default'] = {", '  server: { host: true },', '};', ''].join(
      '\n'
    );

    const transformed = injectViteQRCode(source, '/tmp/vite.config.cjs');

    expect(transformed).toContain("const viteQRCode = require('vite-qr');");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('supports TypeScript export-equals configs', () => {
    const source = [
      'const viteConfig = {',
      '  server: { host: true },',
      '};',
      '',
      'export = viteConfig;',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.cts');

    expect(transformed).toContain("import viteQRCode from 'vite-qr';");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });

  it('supports TypeScript export-equals defineConfig function configs', () => {
    const source = [
      "import { defineConfig } from 'vite';",
      '',
      'export = defineConfig(() => ({',
      '  server: { host: true },',
      '}));',
      '',
    ].join('\n');

    const transformed = injectViteQRCode(source, '/tmp/vite.config.cts');

    expect(transformed).toContain("import viteQRCode from 'vite-qr';");
    expect(transformed).toContain('plugins: [viteQRCode()],');
  });
});

describe('resolveViteProject', () => {
  it('finds a direct vite project when both dependency and config are present', () => {
    const root = makeTempDir();
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^8.0.0' } }),
      'utf-8'
    );
    fs.writeFileSync(path.join(root, 'vite.config.ts'), 'export default {};\n', 'utf-8');

    expect(resolveViteProject(root)).toEqual({
      candidates: [root],
      projectRoot: root,
    });
  });

  it('accepts vite.config.cts as a valid project config file', () => {
    const root = makeTempDir();
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^8.0.0' } }),
      'utf-8'
    );
    fs.writeFileSync(path.join(root, 'vite.config.cts'), 'module.exports = {};\n', 'utf-8');

    expect(resolveViteProject(root)).toEqual({
      candidates: [root],
      projectRoot: root,
    });
  });

  it('does not treat a package with only a vite dependency as a full vite project', () => {
    const root = makeTempDir();
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^8.0.0' } }),
      'utf-8'
    );

    expect(resolveViteProject(root)).toEqual({
      candidates: [],
      projectRoot: null,
    });
  });

  it('finds a single descendant vite project from a workspace root', () => {
    const root = makeTempDir();
    const app = path.join(root, 'apps', 'web');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{}', 'utf-8');
    fs.writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^8.0.0' } }),
      'utf-8'
    );
    fs.writeFileSync(path.join(app, 'vite.config.ts'), 'export default {};\n', 'utf-8');

    expect(resolveViteProject(root)).toEqual({
      candidates: [app],
      projectRoot: app,
    });
  });

  it('finds a vite project when the vite dependency is hoisted to an ancestor', () => {
    const root = makeTempDir();
    const app = path.join(root, 'apps', 'web');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^8.0.0' } }),
      'utf-8'
    );
    fs.writeFileSync(path.join(app, 'package.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(app, 'vite.config.ts'), 'export default {};\n', 'utf-8');

    expect(resolveViteProject(app)).toEqual({
      candidates: [app],
      projectRoot: app,
    });
  });
});

describe('detectPackageManager', () => {
  it('detects bun from bun.lock', () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, 'package.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(root, 'bun.lock'), '', 'utf-8');

    expect(detectPackageManager(root)).toBe('bun');
  });
});

describe('package dependency lookup', () => {
  it('finds hoisted dependency versions in ancestor package.json files', () => {
    const root = makeTempDir();
    const app = path.join(root, 'apps', 'web');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        devDependencies: {
          vite: '^8.0.0',
          'vite-qr': '^1.0.0',
        },
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(app, 'package.json'), '{}', 'utf-8');

    expect(getPackageDependencyVersion(app, 'vite')).toBe('^8.0.0');
    expect(getPackageDependencyVersion(app, 'vite-qr')).toBe('^1.0.0');
    expect(hasPackageDependency(app, 'vite')).toBe(true);
    expect(hasPackageDependency(app, 'vite-qr')).toBe(true);
    expect(hasPackageDependency(app, 'react')).toBe(false);
  });
});
