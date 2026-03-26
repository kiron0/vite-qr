import * as clack from '@clack/prompts';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { printThanksMessage } from './messages';
import {
  ensureDevScriptHasHost,
  type PackageManager,
  detectPackageManager,
  findViteConfigFile,
  hasPackageDependency,
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

async function ensurePackageInstalled(
  pm: PackageManager,
  cwd: string,
  quiet: boolean
): Promise<void> {
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

function getHostManualStep(
  status: ReturnType<typeof ensureDevScriptHasHost>['status'] | 'missing-package-json',
  relPackageJson: string | null
): string | null {
  const packageLabel = relPackageJson ?? 'package.json';

  switch (status) {
    case 'already-hosted':
    case 'updated':
      return null;
    case 'missing-package-json':
      return 'No package.json was found in the Vite app directory, so add --host to your Vite dev command manually.';
    case 'invalid-package-json':
      return `Could not parse ${packageLabel}, so add --host to the dev script manually.`;
    case 'missing-dev-script':
      return `No dev script was found in ${packageLabel}, so add --host to your Vite dev command manually.`;
    case 'unsupported-dev-script':
      return `Could not update the dev script in ${packageLabel} automatically. Add --host to the Vite command manually.`;
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
          ...resolution.candidates.map(
            (candidate) => `  - ${path.relative(cwd, candidate) || '.'}`
          ),
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
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const packageJsonExists = fs.existsSync(packageJsonPath);
  const relPackageJson = packageJsonExists ? path.relative(cwd, packageJsonPath) || 'package.json' : null;
  const packageJsonSource = packageJsonExists ? fs.readFileSync(packageJsonPath, 'utf-8') : null;
  const devScriptUpdate = packageJsonSource ? ensureDevScriptHasHost(packageJsonSource) : null;
  const hostManualStep = getHostManualStep(
    devScriptUpdate?.status ?? 'missing-package-json',
    relPackageJson
  );
  const originalSource = fs.readFileSync(configPath, 'utf-8');
  const newSource = injectViteQRCode(originalSource, configPath, opts.force ?? false);

  if (!opts.quiet) {
    if (relProjectRoot && relProjectRoot !== '.') {
      clack.log.info(`Using project: ${relProjectRoot}`);
    }
    clack.log.info(`Found config: ${relConfig}`);
  }

  if (newSource === null) {
    clack.outro(
      `Could not update ${relConfig}. Unsupported config export format; use export default, export =, or a module.exports assignment with an object config or config factory function.`
    );
    process.exitCode = 1;
    return;
  }

  const configChanged = newSource !== originalSource;
  const packageJsonChanged = devScriptUpdate?.status === 'updated';

  if (!configChanged && !packageJsonChanged) {
    const lines = ['vite-qr is already configured in the Vite config.'];

    if (hostManualStep) {
      lines.push('', hostManualStep);
    } else {
      lines.push('', 'The dev script already includes --host.');
    }

    clack.outro(lines.join('\n'));
    return;
  }

  if (!opts.skip && !opts.check) {
    const plannedChanges: string[] = [];
    if (configChanged) {
      plannedChanges.push(`inject viteQRCode() into ${relConfig}`);
    }
    if (packageJsonChanged && relPackageJson) {
      plannedChanges.push(`add --host to the dev script in ${relPackageJson}`);
    }

    const confirmed = await clack.confirm({
      message: plannedChanges.length === 1 ? `${plannedChanges[0]}?` : `${plannedChanges.join(' and ')}?`,
      initialValue: true,
    });
    if (clack.isCancel(confirmed) || !confirmed) {
      printThanksMessage();
      process.exit(0);
    }
  }

  if (opts.check) {
    if (configChanged) {
      clack.log.step(`--- ${relConfig} original ---`);
      console.log(originalSource);
      clack.log.step(`--- ${relConfig} new ---`);
      console.log(newSource);
    }
    if (packageJsonChanged && packageJsonSource && devScriptUpdate && relPackageJson) {
      clack.log.step(`--- ${relPackageJson} original ---`);
      console.log(packageJsonSource);
      clack.log.step(`--- ${relPackageJson} new ---`);
      console.log(devScriptUpdate.source);
    }
    clack.outro('Dry-run complete. No files were changed.');
    return;
  }

  if (configChanged) {
    fs.writeFileSync(configPath, newSource, 'utf-8');
    if (!opts.quiet) {
      clack.log.success(`Updated ${relConfig}`);
    }
  }

  if (packageJsonChanged && devScriptUpdate) {
    fs.writeFileSync(packageJsonPath, devScriptUpdate.source, 'utf-8');
    if (!opts.quiet && relPackageJson) {
      clack.log.success(`Updated ${relPackageJson}`);
    }
  }

  await ensurePackageInstalled(pm, projectRoot, opts.quiet ?? false);

  const outroLines = [
    'vite-qr is configured.',
    '',
    'Run your dev server as usual:',
    `  ${pm} run dev`,
    '',
    'QR codes will be printed automatically when the server is ready.',
  ];

  if (hostManualStep) {
    outroLines.push('', hostManualStep);
  }

  clack.outro(outroLines.join('\n'));
}
