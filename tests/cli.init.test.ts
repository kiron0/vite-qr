import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  confirm,
  intro,
  isCancel,
  outro,
  spinner,
  logInfo,
  logStep,
  logSuccess,
  logWarn,
  execSync,
} = vi.hoisted(() => ({
  confirm: vi.fn(),
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  outro: vi.fn(),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  logInfo: vi.fn(),
  logStep: vi.fn(),
  logSuccess: vi.fn(),
  logWarn: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  confirm,
  intro,
  isCancel,
  outro,
  spinner,
  log: {
    info: logInfo,
    step: logStep,
    success: logSuccess,
    warn: logWarn,
  },
}));

vi.mock('node:child_process', () => ({
  execSync,
}));

import { runInit } from '../src/cli/init';

const tempDirs: string[] = [];
const basePackageJson = {
  devDependencies: {
    vite: '^8.0.0',
    'vite-qr': '^1.0.0',
  },
};

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-qr-init-test-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = undefined;

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (!tempDir) continue;
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe('runInit', () => {
  const supportedEndToEndScenarios = [
    {
      configSource: 'export default {};\n',
      devScript: 'vite',
      expectedConfig: 'plugins: [viteQRCode()],',
      expectedDevScript: 'vite --host',
      title: 'injects into a config without plugins and patches a direct vite script',
    },
    {
      configSource: [
        "import react from '@vitejs/plugin-react';",
        '',
        'export default {',
        '  plugins: [react()],',
        '};',
        '',
      ].join('\n'),
      devScript: 'vite --port 3000',
      expectedConfig: 'plugins: [react(), viteQRCode()]',
      expectedDevScript: 'vite --host --port 3000',
      title: 'appends to a plain single-item plugins array',
    },
    {
      configSource: [
        "import react from '@vitejs/plugin-react';",
        "import legacy from '@vitejs/plugin-legacy';",
        '',
        'export default {',
        '  plugins: [react(), legacy()],',
        '};',
        '',
      ].join('\n'),
      devScript: 'cross-env NODE_ENV=development vite --open',
      expectedConfig: 'plugins: [react(), legacy(), viteQRCode()]',
      expectedDevScript: 'cross-env NODE_ENV=development vite --host --open',
      title: 'appends to a plain multi-item plugins array',
    },
    {
      configSource: [
        "import react from '@vitejs/plugin-react';",
        '',
        'export default {',
        '  plugins: [react()].filter(Boolean),',
        '};',
        '',
      ].join('\n'),
      devScript: 'cross-env-shell "vite --open"',
      expectedConfig: 'plugins: [react(), viteQRCode()].filter(Boolean)',
      expectedDevScript: 'cross-env-shell "vite --host --open"',
      title: 'appends to a filtered single-item plugins array',
    },
    {
      configSource: [
        "import react from '@vitejs/plugin-react';",
        "import legacy from '@vitejs/plugin-legacy';",
        '',
        'export default {',
        '  plugins: [react(), legacy()].filter(Boolean),',
        '};',
        '',
      ].join('\n'),
      devScript: 'concurrently "vite" "npm:api"',
      expectedConfig: 'plugins: [react(), legacy(), viteQRCode()].filter(Boolean)',
      expectedDevScript: 'concurrently "vite --host" "npm:api"',
      title: 'appends to a filtered multi-item plugins array',
    },
    {
      configSource: [
        'const plugins = getPlugins();',
        '',
        'export default {',
        '  plugins,',
        '};',
        '',
      ].join('\n'),
      devScript: 'npm run predev && vite --open',
      expectedConfig: 'plugins: [plugins, viteQRCode()].filter(Boolean)',
      expectedDevScript: 'npm run predev && vite --host --open',
      title: 'wraps a shorthand non-array plugins expression',
    },
    {
      configSource: [
        'export default {',
        '  plugins: getPlugins(),',
        '};',
        '',
      ].join('\n'),
      devScript: 'vite --open "/foo bar"',
      expectedConfig: 'plugins: [getPlugins(), viteQRCode()].filter(Boolean)',
      expectedDevScript: 'vite --host --open "/foo bar"',
      title: 'wraps a property-style non-array plugins expression',
    },
  ] as const;

  for (const scenario of supportedEndToEndScenarios) {
    it(scenario.title, async () => {
      const root = makeTempDir();
      writeJson(path.join(root, 'package.json'), {
        ...basePackageJson,
        scripts: {
          dev: scenario.devScript,
        },
      });
      fs.writeFileSync(path.join(root, 'vite.config.ts'), scenario.configSource, 'utf-8');

      vi.spyOn(process, 'cwd').mockReturnValue(root);

      await runInit({ quiet: true, skip: true });

      const config = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf-8');
      const pkg = readJson<{ scripts: { dev: string } }>(path.join(root, 'package.json'));

      expect(config).toContain("import viteQRCode from 'vite-qr';");
      expect(config).toContain(scenario.expectedConfig);
      expect(pkg.scripts.dev).toBe(scenario.expectedDevScript);
      expect(execSync).not.toHaveBeenCalled();
    });
  }

  it('updates the package dev script with --host when injecting vite-qr', async () => {
    const root = makeTempDir();
    writeJson(path.join(root, 'package.json'), {
      ...basePackageJson,
      scripts: {
        dev: 'vite',
      },
    });
    fs.writeFileSync(path.join(root, 'vite.config.ts'), 'export default {};\n', 'utf-8');

    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await runInit({ quiet: true, skip: true });

    expect(fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf-8')).toContain(
      "import viteQRCode from 'vite-qr';"
    );
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).scripts.dev).toBe(
      'vite --host'
    );
    expect(execSync).not.toHaveBeenCalled();
  });

  it('still patches the dev script when viteQRCode is already present', async () => {
    const root = makeTempDir();
    writeJson(path.join(root, 'package.json'), {
      ...basePackageJson,
      scripts: {
        dev: 'vite',
      },
    });
    fs.writeFileSync(
      path.join(root, 'vite.config.ts'),
      [
        "import viteQRCode from 'vite-qr';",
        '',
        'export default {',
        '  plugins: [viteQRCode()],',
        '};',
        '',
      ].join('\n'),
      'utf-8'
    );

    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await runInit({ quiet: true, skip: true });

    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).scripts.dev).toBe(
      'vite --host'
    );
    expect(fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf-8')).toContain(
      'plugins: [viteQRCode()]'
    );
    expect(execSync).not.toHaveBeenCalled();
  });

  it('still installs vite-qr when config and dev script are already configured', async () => {
    const root = makeTempDir();
    writeJson(path.join(root, 'package.json'), {
      devDependencies: {
        vite: '^8.0.0',
      },
      scripts: {
        dev: 'vite --host',
      },
    });
    fs.writeFileSync(
      path.join(root, 'vite.config.ts'),
      [
        "import viteQRCode from 'vite-qr';",
        '',
        'export default {',
        '  plugins: [viteQRCode()],',
        '};',
        '',
      ].join('\n'),
      'utf-8'
    );

    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await runInit({ quiet: true, skip: true });

    expect(execSync).toHaveBeenCalledWith('npm install -D vite-qr', {
      cwd: root,
      stdio: 'pipe',
    });
  });

  it('updates the nearest ancestor package.json for hoisted workspace apps', async () => {
    const root = makeTempDir();
    const app = path.join(root, 'apps', 'web');
    fs.mkdirSync(app, { recursive: true });
    writeJson(path.join(root, 'package.json'), {
      devDependencies: {
        vite: '^8.0.0',
      },
      packageManager: 'pnpm@10.0.0',
      scripts: {
        dev: 'vite',
      },
    });
    fs.writeFileSync(path.join(app, 'vite.config.ts'), 'export default {};\n', 'utf-8');

    vi.spyOn(process, 'cwd').mockReturnValue(app);

    await runInit({ quiet: true, skip: true });

    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).scripts.dev).toBe(
      'vite --host'
    );
    expect(fs.readFileSync(path.join(app, 'vite.config.ts'), 'utf-8')).toContain(
      "import viteQRCode from 'vite-qr';"
    );
    expect(execSync).toHaveBeenCalledWith('pnpm add -D vite-qr', {
      cwd: root,
      stdio: 'pipe',
    });
  });

  it('updates config but leaves unsupported backtick scripts untouched and reports the manual step', async () => {
    const root = makeTempDir();
    writeJson(path.join(root, 'package.json'), {
      ...basePackageJson,
      scripts: {
        dev: 'echo `vite`',
      },
    });
    fs.writeFileSync(path.join(root, 'vite.config.ts'), 'export default {};\n', 'utf-8');

    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await runInit({ quiet: true, skip: true });

    expect(fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf-8')).toContain(
      'plugins: [viteQRCode()],'
    );
    expect(readJson<{ scripts: { dev: string } }>(path.join(root, 'package.json')).scripts.dev).toBe(
      'echo `vite`'
    );
    expect(outro).toHaveBeenLastCalledWith(
      expect.stringContaining('Add --host to the Vite command manually.')
    );
    expect(execSync).not.toHaveBeenCalled();
  });

  it('shows all planned end-to-end changes in check mode without writing files', async () => {
    const root = makeTempDir();
    writeJson(path.join(root, 'package.json'), {
      devDependencies: {
        vite: '^8.0.0',
      },
      scripts: {
        dev: 'vite --port 3000',
      },
    });
    const originalConfig = [
      "import react from '@vitejs/plugin-react';",
      '',
      'export default {',
      '  plugins: [react()].filter(Boolean),',
      '};',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'vite.config.ts'), originalConfig, 'utf-8');
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await runInit({ check: true, quiet: true, skip: true });

    expect(fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf-8')).toBe(originalConfig);
    expect(readJson<{ scripts: { dev: string } }>(path.join(root, 'package.json')).scripts.dev).toBe(
      'vite --port 3000'
    );
    expect(logStep).toHaveBeenCalledWith('--- vite.config.ts original ---');
    expect(logStep).toHaveBeenCalledWith('--- vite.config.ts new ---');
    expect(logStep).toHaveBeenCalledWith('--- package.json original ---');
    expect(logStep).toHaveBeenCalledWith('--- package.json new ---');
    expect(logStep).toHaveBeenCalledWith('--- install ---');
    expect(consoleLogSpy.mock.calls.map(([chunk]) => String(chunk)).join('\n')).toContain(
      'npm install -D vite-qr'
    );
    expect(execSync).not.toHaveBeenCalled();
  });
});
