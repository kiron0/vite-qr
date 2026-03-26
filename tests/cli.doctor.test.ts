import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../src/cli/doctor';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-qr-doctor-test-'));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (!tempDir) continue;
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe('runDoctor', () => {
  it('reports an existing config file even when the vite dependency is missing', () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, 'package.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(root, 'vite.config.ts'), 'export default {};\n', 'utf-8');

    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    runDoctor();

    const output = consoleLogSpy.mock.calls.map(([chunk]) => String(chunk)).join('\n');
    expect(output).toContain('vite.config.* file found');
    expect(output).toContain('        vite.config.ts');
    expect(output).toContain('viteQRCode present in config');
    expect(output).toContain('        Run: vite-qr init');
    expect(output).not.toContain('Could not find vite.config.ts / .mts / .cts / .js / .mjs / .cjs');
    expect(output).not.toContain('        No config file found');
    expect(process.exitCode).toBe(1);
  });

  it('treats hoisted vite and vite-qr dependencies as installed', () => {
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
        packageManager: 'bun@1.2.0',
      }),
      'utf-8'
    );
    fs.writeFileSync(path.join(app, 'package.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(app, 'vite.config.ts'), 'export default {};\n', 'utf-8');

    vi.spyOn(process, 'cwd').mockReturnValue(app);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    runDoctor();

    const output = consoleLogSpy.mock.calls.map(([chunk]) => String(chunk)).join('\n');
    expect(output).toContain('✅  Vite version >= 5');
    expect(output).toContain('        Found: ^8.0.0');
    expect(output).toContain('✅  vite-qr installed');
    expect(output).not.toContain('Run: bun add -D vite-qr');
  });
});
