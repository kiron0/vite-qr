import * as clack from '@clack/prompts';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { printThanksMessage } from './messages';
import {
  type PackageManager,
  detectPackageManager,
  findViteConfigFile,
  hasPackageDependency,
  hasViteQRCode,
  injectViteQRCode,
  resolveViteProject,
} from './setup';

export interface InitOptions {
  check?: boolean;
  skip?: boolean;
  force?: boolean;
  quiet?: boolean;
}

function isPackageInstalled(cwd: string): boolean {
  return hasPackageDependency(cwd, 'vite-qr');
}

function buildInstallCmd(pm: PackageManager): string {
  switch (pm) {
    case 'bun':
      return 'bun add -D vite-qr';
    case 'pnpm':
      return 'pnpm add -D vite-qr';
    case 'yarn':
      return 'yarn add -D vite-qr';
    default:
      return 'npm install -D vite-qr';
  }
}

async function ensurePackageInstalled(pm: PackageManager, cwd: string, quiet: boolean): Promise<void> {
  if (isPackageInstalled(cwd)) {
    if (!quiet) clack.log.info('vite-qr is already installed.');
    return;
  }

  const installCmd = buildInstallCmd(pm);
  const spinner = clack.spinner();
  spinner.start(`Installing vite-qr (${installCmd})…`);

  try {
    execSync(installCmd, { cwd, stdio: 'pipe' });
    spinner.stop('vite-qr installed successfully.');
  } catch {
    spinner.stop('Installation failed. Run manually:');
    clack.log.warn(`  ${installCmd}`);
  }
}

export async function runInit(opts: InitOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const resolution = resolveViteProject(cwd);
  const projectRoot = resolution.projectRoot;

  clack.intro('vite-qr init');

  if (!projectRoot) {
    if (resolution.candidates.length > 1) {
      clack.outro(
        [
          'Multiple Vite projects detected. Run this command from the app you want to modify.',
          '',
          ...resolution.candidates.map((candidate) => `  - ${path.relative(cwd, candidate) || '.'}`),
        ].join('\n')
      );
    } else {
      clack.outro('No Vite project detected. Run this command inside a Vite app directory.');
    }
    process.exitCode = 1;
    return;
  }

  const configPath = findViteConfigFile(projectRoot);
  if (!configPath) {
    clack.outro(
      `Could not find a Vite config file in ${path.relative(cwd, projectRoot) || '.'} (vite.config.ts / .mts / .cts / .js / .mjs / .cjs).`
    );
    process.exitCode = 1;
    return;
  }

  const pm = detectPackageManager(projectRoot);
  const relConfig = path.relative(cwd, configPath);
  const relProjectRoot = path.relative(cwd, projectRoot);

  if (!opts.quiet) {
    if (relProjectRoot && relProjectRoot !== '.') {
      clack.log.info(`Using project: ${relProjectRoot}`);
    }
    clack.log.info(`Found config: ${relConfig}`);
  }

  if (hasViteQRCode(configPath) && !opts.force) {
    clack.outro(`viteQRCode() is already present in ${relConfig}. Use --force to re-inject.`);
    return;
  }

  if (!opts.skip && !opts.check) {
    const confirmed = await clack.confirm({
      message: `Inject viteQRCode() into ${relConfig}?`,
      initialValue: true,
    });
    if (clack.isCancel(confirmed) || !confirmed) {
      printThanksMessage();
      process.exit(0);
    }
  }

  const originalSource = fs.readFileSync(configPath, 'utf-8');
  const newSource = injectViteQRCode(originalSource, configPath, opts.force ?? false);

  if (newSource === null) {
    clack.outro(
      `Could not update ${relConfig}. Unsupported config export format; use export default, export =, or a module.exports assignment with an object config or config factory function.`
    );
    process.exitCode = 1;
    return;
  }

  if (opts.check) {
    clack.log.step('--- original ---');
    console.log(originalSource);
    clack.log.step('--- new ---');
    console.log(newSource);
    clack.outro('Dry-run complete. No files were changed.');
    return;
  }

  fs.writeFileSync(configPath, newSource, 'utf-8');

  if (!opts.quiet) {
    clack.log.success(`Updated ${relConfig}`);
  }

  await ensurePackageInstalled(pm, projectRoot, opts.quiet ?? false);

  clack.outro(
    [
      'vite-qr is configured.',
      '',
      'Run your dev server as usual:',
      `  ${pm} run dev`,
      '',
      'QR codes will be printed automatically when the server is ready.',
    ].join('\n')
  );
}
