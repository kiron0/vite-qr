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
  scripts?: Record<string, string>;
  type?: string;
};

export type DevScriptHostStatus =
  | 'already-hosted'
  | 'invalid-package-json'
  | 'missing-dev-script'
  | 'unsupported-dev-script'
  | 'updated';

export interface DevScriptHostUpdate {
  source: string;
  status: DevScriptHostStatus;
}

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
const SHELL_OPERATORS = new Set(['&&', '||', ';', '|']);
const CONCURRENTLY_OPTIONS_WITH_VALUE = new Set([
  '--default-input-target',
  '--handle-input',
  '--max-processes',
  '--name-separator',
  '--names',
  '--prefix',
  '--prefix-colors',
  '--prefix-length',
  '--restart-after',
  '--restart-tries',
  '--success',
  '--timestamp-format',
  '-c',
  '-m',
  '-n',
  '-p',
  '-s',
  '-t',
]);

type BindingValue = ts.Expression | ts.FunctionDeclaration;
type ExpressionBindings = Map<string, BindingValue>;

type ObjectTarget = {
  objectLiteral: ts.ObjectLiteralExpression;
  sourceFile: ts.SourceFile;
  bindings: ExpressionBindings;
};

type PluginsProperty = ts.PropertyAssignment | ts.ShorthandPropertyAssignment;
type CommandToken = {
  end: number;
  raw: string;
  start: number;
  value: string;
};

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

function getViteCommandIndex(tokens: string[], startIndex: number): number | null {
  if (tokens[startIndex] === 'vite') {
    return startIndex;
  }

  if ((tokens[startIndex] === 'npx' || tokens[startIndex] === 'bunx') && tokens[startIndex + 1] === 'vite') {
    return startIndex + 1;
  }

  if (tokens[startIndex] === 'pnpm') {
    if (tokens[startIndex + 1] === 'vite') {
      return startIndex + 1;
    }

    if (tokens[startIndex + 1] === 'exec' && tokens[startIndex + 2] === 'vite') {
      return startIndex + 2;
    }
  }

  if (tokens[startIndex] === 'yarn' && tokens[startIndex + 1] === 'vite') {
    return startIndex + 1;
  }

  if (tokens[startIndex] === 'npm' && tokens[startIndex + 1] === 'exec') {
    if (tokens[startIndex + 2] === 'vite') {
      return startIndex + 2;
    }

    if (tokens[startIndex + 2] === '--' && tokens[startIndex + 3] === 'vite') {
      return startIndex + 3;
    }
  }

  return null;
}

function tokenizeCommand(command: string): CommandToken[] | null {
  const tokens: CommandToken[] = [];
  let cursor = 0;

  while (cursor < command.length) {
    while (cursor < command.length && /\s/.test(command[cursor] ?? '')) {
      cursor += 1;
    }

    if (cursor >= command.length) {
      break;
    }

    const start = cursor;
    let value = '';

    while (cursor < command.length && !/\s/.test(command[cursor] ?? '')) {
      const char = command[cursor];

      if (char === '"' || char === "'") {
        const quote = char;
        cursor += 1;

        while (cursor < command.length && command[cursor] !== quote) {
          value += command[cursor];
          cursor += 1;
        }

        if (cursor >= command.length) {
          return null;
        }

        cursor += 1;
        continue;
      }

      value += char;
      cursor += 1;
    }

    tokens.push({
      end: cursor,
      raw: command.slice(start, cursor),
      start,
      value,
    });
  }

  return tokens;
}

function getWrappedQuote(rawToken: string): '"' | "'" | null {
  const first = rawToken[0];
  const last = rawToken[rawToken.length - 1];

  if ((first === '"' || first === "'") && first === last) {
    return first;
  }

  return null;
}

function isShellOperatorToken(token: CommandToken): boolean {
  return token.raw === token.value && SHELL_OPERATORS.has(token.value);
}

function insertCommandToken(
  command: string,
  tokens: CommandToken[],
  insertIndex: number,
  insertedToken: string
): string {
  if (insertIndex >= tokens.length) {
    const last = tokens.at(-1);
    if (!last) {
      return insertedToken;
    }

    return `${command.slice(0, last.end)} ${insertedToken}${command.slice(last.end)}`;
  }

  return `${command.slice(0, tokens[insertIndex].start)}${insertedToken} ${command.slice(tokens[insertIndex].start)}`;
}

function addHostToSimpleCommand(devScript: string, tokens: CommandToken[] | null = null): string | null {
  const parsedTokens = tokens ?? tokenizeCommand(devScript);
  if (!parsedTokens || parsedTokens.length === 0) {
    return null;
  }

  let startIndex = 0;
  if (parsedTokens[startIndex]?.value === 'cross-env') {
    startIndex += 1;
  }

  while (
    startIndex < parsedTokens.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(parsedTokens[startIndex]?.value ?? '')
  ) {
    startIndex += 1;
  }

  const viteIndex = getViteCommandIndex(
    parsedTokens.map((token) => token.value),
    startIndex
  );
  if (viteIndex === null) {
    return null;
  }

  if (
    parsedTokens
      .slice(viteIndex + 1)
      .some((token) => token.value === '--host' || token.value.startsWith('--host='))
  ) {
    return devScript;
  }

  const subcommand = parsedTokens[viteIndex + 1]?.value;
  if (subcommand === 'build' || subcommand === 'preview') {
    return null;
  }

  const insertIndex = subcommand === 'dev' ? viteIndex + 2 : viteIndex + 1;
  return insertCommandToken(devScript, parsedTokens, insertIndex, '--host');
}

function addHostToCrossEnvShellCommand(
  devScript: string,
  tokens: CommandToken[]
): string | null {
  let startIndex = 1;

  while (
    startIndex < tokens.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[startIndex]?.value ?? '')
  ) {
    startIndex += 1;
  }

  if (tokens.length !== startIndex + 1) {
    return null;
  }

  const commandToken = tokens[startIndex];
  if (!commandToken) {
    return null;
  }

  const updatedInnerCommand = addHostToSimpleCommand(commandToken.value);
  if (updatedInnerCommand === null) {
    return null;
  }

  const quote = getWrappedQuote(commandToken.raw);
  if (!quote && /\s/.test(updatedInnerCommand)) {
    return null;
  }

  const replacement = quote ? `${quote}${updatedInnerCommand}${quote}` : updatedInnerCommand;
  return `${devScript.slice(0, commandToken.start)}${replacement}${devScript.slice(commandToken.end)}`;
}

function addHostToConcurrentlyCommand(devScript: string, tokens: CommandToken[]): string | null {
  let commandStartIndex = 1;

  while (commandStartIndex < tokens.length) {
    const token = tokens[commandStartIndex];
    if (!token) {
      break;
    }

    if (token.value === '--') {
      commandStartIndex += 1;
      break;
    }

    if (!token.value.startsWith('-')) {
      break;
    }

    const [flag] = token.value.split('=', 1);
    commandStartIndex += 1;

    if (
      !token.value.includes('=') &&
      CONCURRENTLY_OPTIONS_WITH_VALUE.has(flag) &&
      commandStartIndex < tokens.length
    ) {
      commandStartIndex += 1;
    }
  }

  let updated = devScript;
  let matched = false;
  let changed = false;

  for (let index = tokens.length - 1; index >= commandStartIndex; index -= 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    const quote = getWrappedQuote(token.raw);
    if (!quote) {
      continue;
    }

    const updatedCommand = addHostToSimpleCommand(token.value);
    if (updatedCommand === null) {
      continue;
    }

    matched = true;
    if (updatedCommand === token.value) {
      continue;
    }

    const replacement = `${quote}${updatedCommand}${quote}`;
    updated = `${updated.slice(0, token.start)}${replacement}${updated.slice(token.end)}`;
    changed = true;
  }

  if (!matched) {
    return null;
  }

  return changed ? updated : devScript;
}

function addHostToCommandGroup(devScript: string, tokens: CommandToken[]): string | null {
  if (tokens.length === 0) {
    return null;
  }

  if (tokens[0]?.value === 'cross-env-shell') {
    return addHostToCrossEnvShellCommand(devScript, tokens);
  }

  if (tokens[0]?.value === 'concurrently') {
    return addHostToConcurrentlyCommand(devScript, tokens);
  }

  return addHostToSimpleCommand(devScript, tokens);
}

function addHostToDevScript(devScript: string): string | null {
  if (/`/.test(devScript)) {
    return null;
  }

  const tokens = tokenizeCommand(devScript);
  if (!tokens || tokens.length === 0) {
    return null;
  }

  const groups: Array<{ start: number; end: number }> = [];
  let groupStart = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || !isShellOperatorToken(token)) {
      continue;
    }

    if (groupStart < index) {
      groups.push({
        end: index,
        start: groupStart,
      });
    }
    groupStart = index + 1;
  }

  if (groupStart < tokens.length) {
    groups.push({
      end: tokens.length,
      start: groupStart,
    });
  }

  let updated = devScript;
  let matched = false;
  let changed = false;

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (!group) {
      continue;
    }

    const currentTokens = tokenizeCommand(updated);
    if (!currentTokens) {
      return null;
    }

    const groupTokens = currentTokens.slice(group.start, group.end);
    if (groupTokens.length === 0) {
      continue;
    }

    const groupScript = updated.slice(groupTokens[0].start, groupTokens[groupTokens.length - 1].end);
    const updatedGroupScript = addHostToCommandGroup(groupScript, groupTokens.map((token) => ({
      ...token,
      end: token.end - groupTokens[0].start,
      start: token.start - groupTokens[0].start,
    })));

    if (updatedGroupScript === null) {
      continue;
    }

    matched = true;
    if (updatedGroupScript === groupScript) {
      continue;
    }

    updated = `${updated.slice(0, groupTokens[0].start)}${updatedGroupScript}${updated.slice(groupTokens[groupTokens.length - 1].end)}`;
    changed = true;
  }

  if (!matched) {
    return null;
  }

  return changed ? updated : devScript;
}

export function ensureDevScriptHasHost(packageJsonSource: string): DevScriptHostUpdate {
  let parsed: PackageJsonData | null = null;

  try {
    parsed = JSON.parse(packageJsonSource) as PackageJsonData;
  } catch {
    return {
      source: packageJsonSource,
      status: 'invalid-package-json',
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      source: packageJsonSource,
      status: 'invalid-package-json',
    };
  }

  const scripts = parsed.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts) || typeof scripts.dev !== 'string') {
    return {
      source: packageJsonSource,
      status: 'missing-dev-script',
    };
  }

  const updatedDevScript = addHostToDevScript(scripts.dev);
  if (updatedDevScript === scripts.dev) {
    return {
      source: packageJsonSource,
      status: 'already-hosted',
    };
  }

  if (updatedDevScript === null) {
    return {
      source: packageJsonSource,
      status: 'unsupported-dev-script',
    };
  }

  return {
    source: `${JSON.stringify(
      {
        ...parsed,
        scripts: {
          ...scripts,
          dev: updatedDevScript,
        },
      },
      null,
      2
    )}\n`,
    status: 'updated',
  };
}

function getDependencyVersionFromPackageJson(
  pkg: PackageJsonData | null,
  dependencyName: string
): string | null {
  return pkg?.dependencies?.[dependencyName] ?? pkg?.devDependencies?.[dependencyName] ?? null;
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
  return ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath)
  );
}

function isNamedAccess(node: ts.Node, name: string): boolean {
  return (
    (ts.isPropertyAccessExpression(node) && node.name.text === name) ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === name)
  );
}

function isViteQrRequireCall(
  expression: ts.Expression | undefined
): expression is ts.CallExpression {
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
): BindingValue {
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

  if (
    ts.isArrowFunction(resolved) ||
    ts.isFunctionExpression(resolved) ||
    ts.isFunctionDeclaration(resolved)
  ) {
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
    if (
      !ts.isBinaryExpression(expression) ||
      expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
      continue;
    }

    const left = expression.left;
    const isCjsExport =
      isModuleExports(left) || isExportsDefault(left) || isModuleExportsDefault(left);

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
      if (
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== 'vite-qr'
      ) {
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

      if (ts.isObjectBindingPattern(declaration.name) && isViteQrRequireCall(initializer)) {
        for (const element of declaration.name.elements) {
          const propertyName =
            element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile);
          if (
            (propertyName === 'default' || propertyName === 'viteQRCode') &&
            ts.isIdentifier(element.name)
          ) {
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

function getPluginsArrayInitializer(
  expression: ts.Expression,
  sourceFile: ts.SourceFile
): { array: ts.ArrayLiteralExpression; filtered: boolean } | null {
  if (ts.isArrayLiteralExpression(expression)) {
    return {
      array: expression,
      filtered: false,
    };
  }

  if (!ts.isCallExpression(expression)) {
    return null;
  }

  if (!ts.isPropertyAccessExpression(expression.expression) || expression.expression.name.text !== 'filter') {
    return null;
  }

  if (expression.arguments.length !== 1 || expression.arguments[0]?.getText(sourceFile) !== 'Boolean') {
    return null;
  }

  const target = expression.expression.expression;
  return ts.isArrayLiteralExpression(target)
    ? {
        array: target,
        filtered: true,
      }
    : null;
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
    const isDirective =
      ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression);
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

function detectInnerIndent(
  objectLiteral: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile
): string {
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

export function findNearestPackageJsonPath(cwd: string): string | null {
  return findNearestPackageJson(cwd);
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

function findDescendantViteProjects(
  startDir: string,
  maxDepth = MAX_PROJECT_SEARCH_DEPTH
): string[] {
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

    if (
      fs.existsSync(path.join(current, 'bun.lock')) ||
      fs.existsSync(path.join(current, 'bun.lockb'))
    )
      return 'bun';
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
      const arrayInitializer = getPluginsArrayInitializer(initializer, sourceFile);
      if (ts.isPropertyAssignment(pluginsProperty) && arrayInitializer) {
        const suffix = arrayInitializer.filtered ? '.filter(Boolean)' : '';
        if (arrayInitializer.array.elements.length === 0) {
          updated = `${source.slice(0, arrayInitializer.array.getStart(sourceFile))}[${pluginCall}]${suffix}${source.slice(initializer.getEnd())}`;
        } else {
          updated = `${source.slice(0, arrayInitializer.array.getEnd() - 1)}, ${pluginCall}]${suffix}${source.slice(initializer.getEnd())}`;
        }
      } else {
        const initializerText = source.slice(
          initializer.getStart(sourceFile),
          initializer.getEnd()
        );
        const replacement = `plugins: [${initializerText}, ${pluginCall}].filter(Boolean)`;
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
    updated = prependImport(
      updated,
      filePath,
      buildImportLine(binding.callee, detectConfigFormat(filePath))
    );
  }

  return updated;
}

export function isViteProject(cwd: string): boolean {
  return isViteProjectDir(cwd);
}
