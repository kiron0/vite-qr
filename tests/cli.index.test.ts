import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('runCli', () => {
  it('shows help and exits cleanly when no command is provided', async () => {
    const stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const exitCode = await runCli(['node', 'vite-qr']);

    expect(exitCode).toBe(0);
    expect(stderrWriteSpy).not.toHaveBeenCalled();
    expect(stdoutWriteSpy).toHaveBeenCalled();
    expect(stdoutWriteSpy.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
      'Usage: vite-qr [options] [command]'
    );
  });
});
