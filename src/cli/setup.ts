import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export type ConfigFormat = 'ts' | 'esm' | 'cjs';
export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

export interface ViteProjectResolution {
  candidates: string[];
  projectRoot: string | null;
}

type PackageJsonData = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  type?: string;
};

const MAX_PROJECT_SEARCH_DEPTH = 4;
const VITE_CONFIG_CANDIDATES = [
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
] as const;
const IGNORED_DIRS = new Set([
  '.git',
  '.idea',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

type BindingValue = ts.Expression | ts.FunctionDeclaration;
type ExpressionBindings = Map<string, BindingValue>;

type ObjectTarget = {
  objectLiteral: ts.ObjectLiteralExpression;
  sourceFile: ts.SourceFile;
  bindings: ExpressionBindings;
};

type PluginsProperty = ts.PropertyAssignment | ts.ShorthandPropertyAssignment;

type ViteQRCodeBinding = {
  callee: string;
  detectionCallees: string[];
  hasKnownSource: boolean;
  importLineNeeded: boolean;
};

function readPackageJson(packageJsonPath: string): PackageJsonData | null {
  if (!fs.existsSync(packageJsonPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as PackageJsonData;
  } catch {
    return null;
  }
}

function getDependencyVersionFromPackageJson(pkg: PackageJsonData | null, dependencyName: string): string | null {
  return pkg?.dependencies?.[dependencyName] ?? pkg?.devDependencies?.[dependencyName] ?? null;
}

function hasViteDependencyInDir(dir: string): boolean {
  const pkg = readPackageJson(path.join(dir, 'package.json'));
  return getDependencyVersionFromPackageJson(pkg, 'vite') !== null;
}

function hasViteDependencyInDirOrAncestor(dir: string): boolean {
  return getPackageDependencyVersion(dir, 'vite') !== null;
}

function hasViteConfigInDir(dir: string): boolean {
  return findViteConfigFile(dir) !== null;
}

function isViteProjectDir(dir: string): boolean {
  return hasViteDependencyInDirOrAncestor(dir) && hasViteConfigInDir(dir);
}

function getScriptKind(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath);
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function createSourceFile(filePath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
}

function isNamedAccess(node: ts.Node, name: string): boolean {
  return (
    (ts.isPropertyAccessExpression(node) && node.name.text === name) ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === name)
  );
}

function isViteQrRequireCall(expression: ts.Expression | undefined): expression is ts.CallExpression {
  return (
    expression !== undefined &&
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'require' &&
    expression.arguments.length === 1 &&
    ts.isStringLiteral(expression.arguments[0]) &&
    expression.arguments[0].text === 'vite-qr'
  );
}

function getViteQrRequireMemberName(expression: ts.Expression | undefined): string | null {
  if (!expression) {
    return null;
  }

  if (isViteQrRequireCall(expression)) {
    return null;
  }

  if (
    (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
    isViteQrRequireCall(expression.expression)
  ) {
    if (isNamedAccess(expression, 'default')) {
      return 'default';
    }

    if (isNamedAccess(expression, 'viteQRCode')) {
      return 'viteQRCode';
    }
  }

  return null;
}

function isModuleExports(node: ts.Node): boolean {
  return (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'module' &&
    isNamedAccess(node, 'exports')
  );
}

function isExportsDefault(node: ts.Node): boolean {
  return (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'exports' &&
    isNamedAccess(node, 'default')
  );
}

function isModuleExportsDefault(node: ts.Node): boolean {
  return (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    isModuleExports(node.expression) &&
    isNamedAccess(node, 'default')
  );
}

function unwrapExpression(expression: BindingValue): BindingValue {
  let current = expression;

  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }

    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }

    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }

    if (ts.isAwaitExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }

    if (ts.isPartiallyEmittedExpression(current)) {
      current = current.expression;
      continue;
    }

    return current;
  }
}

function getExpressionBindings(sourceFile: ts.SourceFile): ExpressionBindings {
  const bindings = new Map<string, BindingValue>();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      bindings.set(statement.name.text, statement);
      continue;
    }

    if (!ts.isVariableStatement(statement)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
      bindings.set(declaration.name.text, declaration.initializer);
    }
  }

  return bindings;
}

function resolveExpression(
  expression: BindingValue,
  bindings: ExpressionBindings,
  visited = new Set<string>()
) : BindingValue {
  expression = unwrapExpression(expression);

  if (!ts.isIdentifier(expression)) {
    return expression;
  }

  if (visited.has(expression.text)) {
    return expression;
  }

  const binding = bindings.get(expression.text);
  if (binding === undefined) {
    return expression;
  }

  visited.add(expression.text);
  return resolveExpression(binding, bindings, visited);
}

function isDefineConfigCall(expression: ts.Expression): expression is ts.CallExpression {
  return (
    ts.isCallExpression(expression) &&
    ((ts.isIdentifier(expression.expression) && expression.expression.text === 'defineConfig') ||
      (ts.isPropertyAccessExpression(expression.expression) &&
        ts.isIdentifier(expression.expression.expression) &&
        expression.expression.expression.text === 'vite' &&
        expression.expression.name.text === 'defineConfig'))
  );
}

function isMergeConfigCall(expression: ts.Expression): expression is ts.CallExpression {
  return (
    ts.isCallExpression(expression) &&
    ((ts.isIdentifier(expression.expression) && expression.expression.text === 'mergeConfig') ||
      (ts.isPropertyAccessExpression(expression.expression) &&
        ts.isIdentifier(expression.expression.expression) &&
        expression.expression.expression.text === 'vite' &&
        expression.expression.name.text === 'mergeConfig'))
  );
}

function extractObjectLiteralFromFunction(
  fn: ts.FunctionLikeDeclaration,
  bindings: ExpressionBindings
): ts.ObjectLiteralExpression | null {
  if (fn.body === undefined) {
    return null;
  }

  if (!ts.isBlock(fn.body)) {
    return extractConfigObjectFromExpression(fn.body, bindings);
  }

  for (const statement of fn.body.statements) {
    if (!ts.isReturnStatement(statement) || statement.expression === undefined) {
      continue;
    }

    return extractConfigObjectFromExpression(statement.expression, bindings);
  }

  return null;
}

function extractConfigObjectFromExpression(
  expression: ts.Expression,
  bindings: ExpressionBindings
): ts.ObjectLiteralExpression | null {
  const resolved = unwrapExpression(resolveExpression(expression, bindings));

  if (ts.isObjectLiteralExpression(resolved)) {
    return resolved;
  }

  if (ts.isArrowFunction(resolved) || ts.isFunctionExpression(resolved) || ts.isFunctionDeclaration(resolved)) {
    return extractObjectLiteralFromFunction(resolved, bindings);
  }

  if (isDefineConfigCall(resolved) && resolved.arguments.length > 0) {
    const firstArg = resolved.arguments[0];
    if (!firstArg) {
      return null;
    }

    if (ts.isArrowFunction(firstArg) || ts.isFunctionExpression(firstArg)) {
      return extractObjectLiteralFromFunction(firstArg, bindings);
    }

    return extractConfigObjectFromExpression(firstArg, bindings);
  }

  if (isMergeConfigCall(resolved)) {
    for (let index = resolved.arguments.length - 1; index >= 0; index -= 1) {
      const argument = resolved.arguments[index];
      if (!argument) {
        continue;
      }

      const objectLiteral = extractConfigObjectFromExpression(argument, bindings);
      if (objectLiteral) {
        return objectLiteral;
      }
    }
  }

  return null;
}

function getConfigObjectTarget(source: string, filePath: string): ObjectTarget | null {
  const sourceFile = createSourceFile(filePath, source);
  const bindings = getExpressionBindings(sourceFile);

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      const objectLiteral = extractConfigObjectFromExpression(statement.expression, bindings);
      if (objectLiteral) {
        return { objectLiteral, sourceFile, bindings };
      }
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      const defaultSpecifier = statement.exportClause.elements.find(
        (element) => element.name.text === 'default'
      );

      if (
        defaultSpecifier &&
        (defaultSpecifier.propertyName === undefined ||
          ts.isIdentifier(defaultSpecifier.propertyName))
      ) {
        const localExpression = defaultSpecifier.propertyName ?? defaultSpecifier.name;
        const objectLiteral = extractConfigObjectFromExpression(localExpression, bindings);
        if (objectLiteral) {
          return { objectLiteral, sourceFile, bindings };
        }
      }
    }

    if (!ts.isExpressionStatement(statement)) continue;
    const expression = statement.expression;
    if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
      continue;
    }

    const left = expression.left;
    const isCjsExport = isModuleExports(left) || isExportsDefault(left) || isModuleExportsDefault(left);

    if (!isCjsExport) continue;

    const objectLiteral = extractConfigObjectFromExpression(expression.right, bindings);
    if (objectLiteral) {
      return { objectLiteral, sourceFile, bindings };
    }
  }

  return null;
}

function detectExistingBinding(sourceFile: ts.SourceFile): ViteQRCodeBinding {
  let defaultImport: string | null = null;
  let namespaceImport: string | null = null;
  let namedImport: string | null = null;
  let namespaceRequire: string | null = null;
  let destructuredRequire: string | null = null;

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'vite-qr') {
        continue;
      }

      const importClause = statement.importClause;
      if (importClause?.name) {
        defaultImport = importClause.name.text;
      }

      if (importClause?.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
        namespaceImport = importClause.namedBindings.name.text;
      }

      if (importClause?.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
        for (const element of importClause.namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (importedName === 'default') {
            defaultImport = element.name.text;
          } else if (importedName === 'viteQRCode') {
            namedImport = element.name.text;
          }
        }
      }

      continue;
    }

    if (!ts.isVariableStatement(statement)) continue;

    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      const requireMemberName = getViteQrRequireMemberName(initializer);
      if (
        ts.isIdentifier(declaration.name) &&
        (isViteQrRequireCall(initializer) || requireMemberName !== null)
      ) {
        if (requireMemberName === 'default') {
          defaultImport = declaration.name.text;
        } else if (requireMemberName === 'viteQRCode') {
          destructuredRequire = declaration.name.text;
        } else {
          namespaceRequire = declaration.name.text;
        }
      }

      if (
        ts.isObjectBindingPattern(declaration.name) &&
        isViteQrRequireCall(initializer)
      ) {
        for (const element of declaration.name.elements) {
          const propertyName = element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile);
          if ((propertyName === 'default' || propertyName === 'viteQRCode') && ts.isIdentifier(element.name)) {
            if (propertyName === 'default') {
              defaultImport = element.name.text;
              continue;
            }
            destructuredRequire = element.name.text;
          }
        }
      }
    }
  }

  if (defaultImport) {
    return {
      callee: defaultImport,
      detectionCallees: [defaultImport, `${defaultImport}.viteQRCode`],
      hasKnownSource: true,
      importLineNeeded: false,
    };
  }
  if (namedImport) {
    return {
      callee: namedImport,
      detectionCallees: [namedImport],
      hasKnownSource: true,
      importLineNeeded: false,
    };
  }
  if (namespaceImport) {
    return {
      callee: `${namespaceImport}.viteQRCode`,
      detectionCallees: [`${namespaceImport}.viteQRCode`],
      hasKnownSource: true,
      importLineNeeded: false,
    };
  }
  if (destructuredRequire) {
    return {
      callee: destructuredRequire,
      detectionCallees: [destructuredRequire],
      hasKnownSource: true,
      importLineNeeded: false,
    };
  }
  if (namespaceRequire) {
    return {
      callee: namespaceRequire,
      detectionCallees: [namespaceRequire, `${namespaceRequire}.viteQRCode`],
      hasKnownSource: true,
      importLineNeeded: false,
    };
  }

  const fallbackCallee = getAvailableBindingName(sourceFile, 'viteQRCode');
  return {
    callee: fallbackCallee,
    detectionCallees: [],
    hasKnownSource: false,
    importLineNeeded: true,
  };
}

function collectBindingNamesFromName(name: ts.BindingName, names: Set<string>) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    collectBindingNamesFromName(element.name, names);
  }
}

function getDeclaredTopLevelNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
      continue;
    }

    if (ts.isImportDeclaration(statement)) {
      const importClause = statement.importClause;
      if (importClause?.name) {
        names.add(importClause.name.text);
      }

      if (importClause?.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
        names.add(importClause.namedBindings.name.text);
      }

      if (importClause?.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
        for (const element of importClause.namedBindings.elements) {
          names.add(element.name.text);
        }
      }

      continue;
    }

    if (!ts.isVariableStatement(statement)) continue;

    for (const declaration of statement.declarationList.declarations) {
      collectBindingNamesFromName(declaration.name, names);
    }
  }

  return names;
}

function getAvailableBindingName(sourceFile: ts.SourceFile, preferred: string): string {
  const declaredNames = getDeclaredTopLevelNames(sourceFile);
  if (!declaredNames.has(preferred)) {
    return preferred;
  }

  const fallbackBase = `${preferred}Plugin`;
  if (!declaredNames.has(fallbackBase)) {
    return fallbackBase;
  }

  let suffix = 2;
  while (declaredNames.has(`${fallbackBase}${suffix}`)) {
    suffix += 1;
  }

  return `${fallbackBase}${suffix}`;
}

function getPluginsProperty(objectLiteral: ts.ObjectLiteralExpression): PluginsProperty | null {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    const name = property.name;
    if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'plugins') {
      return property;
    }
  }
  return null;
}

function getPluginsInitializer(property: PluginsProperty): ts.Expression {
  return ts.isPropertyAssignment(property) ? property.initializer : property.name;
}

function expressionContainsPluginCall(
  expression: ts.Expression,
  callees: string[],
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings
): boolean {
  return findPluginCallExpression(expression, callees, sourceFile, bindings) !== null;
}

function matchesPluginCallee(
  expression: ts.Expression,
  allowed: Set<string>,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings
): boolean {
  const originalText = expression.getText(sourceFile);
  if (allowed.has(originalText)) {
    return true;
  }

  const resolved = resolveExpression(expression, bindings);
  const text = resolved.getText(sourceFile);
  return allowed.has(text);
}

function findPluginCallExpression(
  expression: ts.Expression,
  callees: string[],
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings
): ts.CallExpression | null {
  const allowed = new Set<string>();
  for (const callee of callees) {
    allowed.add(callee);
  }
  let found: ts.CallExpression | null = null;

  const visit = (node: ts.Node) => {
    if (found) return;

    if (ts.isCallExpression(node)) {
      if (matchesPluginCallee(node.expression, allowed, sourceFile, bindings)) {
        found = node;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(expression);
  return found;
}

function buildImportLine(callee: string, format: ConfigFormat): string {
  if (format === 'cjs') return `const ${callee} = require('vite-qr');`;
  return `import ${callee} from 'vite-qr';`;
}

function prependImport(source: string, filePath: string, importLine: string): string {
  const sourceFile = createSourceFile(filePath, source);
  let insertPos = 0;

  for (const statement of sourceFile.statements) {
    const isDirective = ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression);
    const isRequireVar =
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((declaration) => {
        const init = declaration.initializer;
        return (
          init !== undefined &&
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === 'require'
        );
      });

    if (isDirective || ts.isImportDeclaration(statement) || isRequireVar) {
      insertPos = statement.end;
      continue;
    }

    break;
  }

  if (insertPos === 0) {
    return `${importLine}\n${source}`;
  }

  return `${source.slice(0, insertPos)}\n${importLine}${source.slice(insertPos)}`;
}

function detectInnerIndent(objectLiteral: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile): string {
  for (const property of objectLiteral.properties) {
    const text = sourceFile.text;
    let lineStart = property.getFullStart();
    while (lineStart > 0 && text[lineStart - 1] !== '\n') {
      lineStart -= 1;
    }

    const match = text.slice(lineStart, property.getStart(sourceFile)).match(/[ \t]*$/);
    if (match) {
      return match[0];
    }
  }

  return '  ';
}

function findNearestPackageJson(dir: string): string | null {
  let current = path.resolve(dir);

  while (true) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function getPackageDependencyVersion(cwd: string, dependencyName: string): string | null {
  let current = path.resolve(cwd);

  while (true) {
    const pkg = readPackageJson(path.join(current, 'package.json'));
    const version = getDependencyVersionFromPackageJson(pkg, dependencyName);
    if (version !== null) {
      return version;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

export function hasPackageDependency(cwd: string, dependencyName: string): boolean {
  return getPackageDependencyVersion(cwd, dependencyName) !== null;
}

export function detectConfigFormat(filePath: string): ConfigFormat {
  const ext = path.extname(filePath);
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'ts';
  if (ext === '.mjs') return 'esm';
  if (ext === '.cjs') return 'cjs';

  const pkgPath = findNearestPackageJson(path.dirname(filePath));
  const pkg = pkgPath ? readPackageJson(pkgPath) : null;
  if (pkg?.type === 'module') return 'esm';
  return 'cjs';
}

function findAncestorViteProject(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    if (isViteProjectDir(current)) return current;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findDescendantViteProjects(startDir: string, maxDepth = MAX_PROJECT_SEARCH_DEPTH): string[] {
  const results = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ depth: number; dir: string }> = [{ depth: 0, dir: path.resolve(startDir) }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (visited.has(current.dir)) continue;
    visited.add(current.dir);

    if (current.depth > 0 && isViteProjectDir(current.dir)) {
      results.add(current.dir);
      continue;
    }

    if (current.depth >= maxDepth) continue;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      queue.push({ depth: current.depth + 1, dir: path.join(current.dir, entry.name) });
    }
  }

  return Array.from(results).sort((a, b) => a.localeCompare(b));
}

export function resolveViteProject(cwd: string): ViteProjectResolution {
  const projectRoot = findAncestorViteProject(cwd);
  if (projectRoot) {
    return { candidates: [projectRoot], projectRoot };
  }

  const candidates = findDescendantViteProjects(cwd);
  if (candidates.length === 1) {
    return { candidates, projectRoot: candidates[0] ?? null };
  }

  return { candidates, projectRoot: null };
}

export function findViteConfigFile(cwd: string): string | null {
  for (const name of VITE_CONFIG_CANDIDATES) {
    const full = path.join(cwd, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

export function detectPackageManager(cwd: string): PackageManager {
  let current = path.resolve(cwd);

  while (true) {
    const pkg = readPackageJson(path.join(current, 'package.json'));
    if (typeof pkg?.packageManager === 'string') {
      const name = pkg.packageManager.split('@')[0]?.trim();
      if (name === 'bun') return 'bun';
      if (name === 'pnpm') return 'pnpm';
      if (name === 'yarn') return 'yarn';
      if (name === 'npm') return 'npm';
    }

    if (fs.existsSync(path.join(current, 'bun.lock')) || fs.existsSync(path.join(current, 'bun.lockb'))) return 'bun';
    if (fs.existsSync(path.join(current, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(current, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(current, 'package-lock.json'))) return 'npm';

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return 'npm';
}

export function hasViteQRCodeSource(source: string, filePath: string): boolean {
  const target = getConfigObjectTarget(source, filePath);
  if (!target) return false;

  const binding = detectExistingBinding(target.sourceFile);
  if (!binding.hasKnownSource) {
    return false;
  }

  const pluginsProperty = getPluginsProperty(target.objectLiteral);
  if (!pluginsProperty) {
    return false;
  }

  return expressionContainsPluginCall(
    getPluginsInitializer(pluginsProperty),
    binding.detectionCallees,
    target.sourceFile,
    target.bindings
  );
}

export function hasViteQRCode(filePath: string): boolean {
  try {
    return hasViteQRCodeSource(fs.readFileSync(filePath, 'utf-8'), filePath);
  } catch {
    return false;
  }
}

export function injectViteQRCode(source: string, filePath: string, force = false): string | null {
  const target = getConfigObjectTarget(source, filePath);
  if (!target) return null;

  const { objectLiteral, sourceFile, bindings } = target;
  const binding = detectExistingBinding(sourceFile);
  const pluginCall = `${binding.callee}()`;
  let updated = source;

  const pluginsProperty = getPluginsProperty(objectLiteral);
  if (pluginsProperty) {
    const initializer = getPluginsInitializer(pluginsProperty);
    const existingPluginCall = binding.hasKnownSource
      ? findPluginCallExpression(initializer, binding.detectionCallees, sourceFile, bindings)
      : null;
    const alreadyPresent = existingPluginCall !== null;
    if (alreadyPresent && !force) {
      return source;
    }

    if (existingPluginCall && force) {
      updated = `${source.slice(0, existingPluginCall.getStart(sourceFile))}${pluginCall}${source.slice(existingPluginCall.getEnd())}`;
    } else if (!alreadyPresent) {
      if (ts.isPropertyAssignment(pluginsProperty) && ts.isArrayLiteralExpression(initializer)) {
        if (initializer.elements.length === 0) {
          updated = `${source.slice(0, initializer.getStart(sourceFile) + 1)}${pluginCall}${source.slice(initializer.getEnd() - 1)}`;
        } else {
          updated = `${source.slice(0, initializer.getEnd() - 1)}, ${pluginCall}${source.slice(initializer.getEnd() - 1)}`;
        }
      } else {
        const initializerText = source.slice(initializer.getStart(sourceFile), initializer.getEnd());
        const replacement = `plugins: [${initializerText}, ${pluginCall}].flat()`;
        updated = `${source.slice(0, pluginsProperty.getStart(sourceFile))}${replacement}${source.slice(pluginsProperty.getEnd())}`;
      }
    }
  } else {
    const innerIndent = detectInnerIndent(objectLiteral, sourceFile);
    const insertion =
      objectLiteral.properties.length === 0
        ? `\n${innerIndent}plugins: [${pluginCall}],\n`
        : `\n${innerIndent}plugins: [${pluginCall}],`;
    updated = `${source.slice(0, objectLiteral.getStart(sourceFile) + 1)}${insertion}${source.slice(objectLiteral.getStart(sourceFile) + 1)}`;
  }

  if (binding.importLineNeeded) {
    updated = prependImport(updated, filePath, buildImportLine(binding.callee, detectConfigFormat(filePath)));
  }

  return updated;
}

export function isViteProject(cwd: string): boolean {
  return isViteProjectDir(cwd);
}
