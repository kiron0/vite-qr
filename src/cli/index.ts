#!/usr/bin/env node
import { Command } from 'commander';
import { runDoctor } from './doctor';
import { runInit } from './init';
import { printThanksMessage } from './messages';

function getVersion(): string {
  try {
    return (require('../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export function createProgram(): Command {
  const program = new Command();

  program.name('vite-qr').description('CLI helper for the vite-qr package').version(getVersion());

  program
    .command('init')
    .description('Inject viteQRCode() into your Vite config and install the package')
    .option('--skip', 'Skip interactive prompts and use defaults')
    .option('--force', 'Re-inject even if viteQRCode is already present')
    .option('--check', 'Dry-run: report planned changes without writing any files')
    .option('--quiet', 'Suppress non-essential output')
    .action(async (opts: { skip?: boolean; force?: boolean; check?: boolean; quiet?: boolean }) => {
      try {
        await runInit(opts);
      } catch (err) {
        console.error('[vite-qr]', err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  program
    .command('doctor')
    .description('Check vite-qr setup in the current Vite project')
    .action(() => {
      try {
        runDoctor();
      } catch (err) {
        console.error('[vite-qr]', err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<number> {
  const program = createProgram();

  if (argv.slice(2).length === 0) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync(argv);
  } catch (err) {
    console.error('[vite-qr]', err instanceof Error ? err.message : String(err));
    return 1;
  }

  return Number(process.exitCode ?? 0);
}

if (require.main === module) {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      printThanksMessage();
      process.exit(0);
    });
  }

  void runCli().then((code) => {
    process.exitCode = code;
  });
}
