import path from 'node:path';
import {
  detectPackageManager,
  findViteConfigFile,
  getPackageDependencyVersion,
  hasPackageDependency,
  hasViteQRCode,
  resolveViteProject,
} from './setup';

const PASS_ICON = String.fromCodePoint(0x2705);
const FAIL_ICON = String.fromCodePoint(0x274c);

interface Check {
  label: string;
  pass: boolean;
  detail?: string;
}

function getConfigCheckRoot(
  resolution: ReturnType<typeof resolveViteProject>,
  cwd: string
): string | null {
  if (resolution.projectRoot) {
    return resolution.projectRoot;
  }

  return findViteConfigFile(cwd) ? cwd : null;
}

function checkIsViteProject(resolution: ReturnType<typeof resolveViteProject>, cwd: string): Check {
  if (resolution.projectRoot === null && resolution.candidates.length > 1) {
    return {
      label: 'Vite project',
      pass: false,
      detail: `Multiple projects found: ${resolution.candidates.map((candidate) => path.relative(cwd, candidate) || '.').join(', ')}`,
    };
  }

  if (resolution.projectRoot !== null) {
    return {
      label: 'Vite project',
      pass: true,
    };
  }

  const hasViteDependency = hasPackageDependency(cwd, 'vite');
  const hasConfig = findViteConfigFile(cwd) !== null;

  let detail = 'Missing Vite dependency and vite.config.* file';
  if (hasViteDependency && !hasConfig) {
    detail = 'Found a Vite dependency but no vite.config.* file';
  } else if (!hasViteDependency && hasConfig) {
    detail = "Found a vite.config.* file but no 'vite' dependency in package.json";
  } else if (!hasViteDependency) {
    detail = "No 'vite' dependency found in package.json";
  }

  return {
    label: 'Vite project',
    pass: false,
    detail,
  };
}

function checkViteVersion(cwd: string): Check {
  const version = getPackageDependencyVersion(cwd, 'vite') ?? '';
  const match = version.match(/\d+/);
  const major = match ? parseInt(match[0], 10) : null;
  const pass = major !== null && major >= 5;
  return {
    label: 'Vite version >= 5',
    pass,
    detail: version
      ? `Found: ${version}${!pass ? ' (minimum supported is 5)' : ''}`
      : 'Could not determine Vite version',
  };
}

function checkViteQrInstalled(cwd: string): Check {
  const pm = detectPackageManager(cwd);
  const pass = hasPackageDependency(cwd, 'vite-qr');
  const installCommand =
    pm === 'bun'
      ? 'bun add -D vite-qr'
      : pm === 'pnpm'
        ? 'pnpm add -D vite-qr'
        : pm === 'yarn'
          ? 'yarn add -D vite-qr'
          : 'npm install -D vite-qr';

  return {
    label: 'vite-qr installed',
    pass,
    detail: pass ? undefined : `Run: ${installCommand}`,
  };
}

function checkConfigExists(projectRoot: string | null, cwd: string): Check {
  const configPath = projectRoot ? findViteConfigFile(projectRoot) : null;
  return {
    label: 'vite.config.* file found',
    pass: configPath !== null,
    detail: configPath
      ? path.relative(cwd, configPath) || '.'
      : 'Could not find vite.config.ts / .mts / .cts / .js / .mjs / .cjs',
  };
}

function checkViteQRCodePresent(projectRoot: string | null): Check {
  const configPath = projectRoot ? findViteConfigFile(projectRoot) : null;
  if (!configPath) {
    return {
      label: 'viteQRCode present in config',
      pass: false,
      detail: 'No config file found',
    };
  }

  const pass = hasViteQRCode(configPath);
  return {
    label: 'viteQRCode present in config',
    pass,
    detail: pass ? undefined : 'Run: vite-qr init',
  };
}

export function runDoctor(): void {
  const cwd = process.cwd();
  const resolution = resolveViteProject(cwd);
  const projectRoot = resolution.projectRoot ?? cwd;
  const configCheckRoot = getConfigCheckRoot(resolution, cwd);

  const checks: Check[] = [
    checkIsViteProject(resolution, cwd),
    checkViteVersion(projectRoot),
    checkViteQrInstalled(projectRoot),
    checkConfigExists(configCheckRoot, cwd),
    checkViteQRCodePresent(configCheckRoot),
  ];

  console.log('\nvite-qr doctor\n');

  let allPassed = true;
  for (const check of checks) {
    const icon = check.pass ? PASS_ICON : FAIL_ICON;
    console.log(`  ${icon}  ${check.label}`);
    if (check.detail) {
      console.log(`        ${check.detail}`);
    }
    if (!check.pass) allPassed = false;
  }

  console.log();
  if (allPassed) {
    console.log('  All checks passed. vite-qr is ready to use.\n');
  } else {
    console.log('  Some checks failed. Follow the suggestions above to fix them.\n');
    process.exitCode = 1;
  }
}
