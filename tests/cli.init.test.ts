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

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-qr-init-test-'));
  tempDirs.push(tempDir);
  return tempDir;
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
  it('updates the package dev script with --host when injecting vite-qr', async () => {
    const root = makeTempDir();
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          dev: 'vite',
        },
        devDependencies: {
          vite: '^8.0.0',
          'vite-qr': '^1.0.0',
        },
      }),
      'utf-8'
    );
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
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          dev: 'vite',
        },
        devDependencies: {
          vite: '^8.0.0',
          'vite-qr': '^1.0.0',
        },
      }),
      'utf-8'
    );
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
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          dev: 'vite --host',
        },
        devDependencies: {
          vite: '^8.0.0',
        },
      }),
      'utf-8'
    );
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
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@10.0.0',
        scripts: {
          dev: 'vite',
        },
        devDependencies: {
          vite: '^8.0.0',
        },
      }),
      'utf-8'
    );
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
});
