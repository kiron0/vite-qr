import net from 'node:net';
import os from 'os';
import { encode } from 'uqr';
import { printThanksMessage } from '../messages';
import type { NetworkOptions, PluginOptions, QRCodeLogger } from '../types';

const DEFAULT_LOGGER: QRCodeLogger = console;
const LINK_LOCAL_PREFIX = '169.254.';
const IPV6_LINK_LOCAL_PREFIX = 'fe80:';
const MARGIN = 0;

type NetworkInterfaceFamily = 'IPv4' | 'IPv6';

type NetworkUrlEntry = {
  address: string;
  family: NetworkInterfaceFamily;
  interfaceName: string;
  url: string;
};

function normalizePath(pathname?: string): string {
  if (!pathname || pathname === '/') return '';
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

function normalizeHostFamily(
  hostFamily?: NetworkOptions['hostFamily']
): NetworkOptions['hostFamily'] {
  return hostFamily ?? 'ipv4';
}

function getLogger(logger?: QRCodeLogger): QRCodeLogger {
  return logger ?? DEFAULT_LOGGER;
}

function normalizeInterfaceFamily(family: string | number): NetworkInterfaceFamily | null {
  if (family === 'IPv4' || family === 'ipv4' || family === 4) {
    return 'IPv4';
  }

  if (family === 'IPv6' || family === 'ipv6' || family === 6) {
    return 'IPv6';
  }

  return null;
}

function normalizeAddress(address: string): string {
  let normalized = address.trim();
  const slashIndex = normalized.indexOf('/');
  if (slashIndex !== -1) {
    normalized = normalized.slice(0, slashIndex);
  }

  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex !== -1) {
    normalized = normalized.slice(0, zoneIndex);
  }

  return normalized;
}

function detectInterfaceFamily(
  family: string | number,
  address: string
): NetworkInterfaceFamily | null {
  const normalizedFamily = normalizeInterfaceFamily(family);
  if (normalizedFamily) {
    return normalizedFamily;
  }

  const ipFamily = net.isIP(normalizeAddress(address));
  if (ipFamily === 4) {
    return 'IPv4';
  }

  if (ipFamily === 6) {
    return 'IPv6';
  }

  return null;
}

function formatAddressForUrl(address: string, family: NetworkInterfaceFamily): string {
  return family === 'IPv6' ? `[${address}]` : address;
}

function isReachableAddress(address: string, family: NetworkInterfaceFamily): boolean {
  const normalizedAddress = normalizeAddress(address);

  if (!normalizedAddress) {
    return false;
  }

  if (family === 'IPv4') {
    return (
      normalizedAddress !== '0.0.0.0' &&
      normalizedAddress !== '127.0.0.1' &&
      !normalizedAddress.startsWith('127.') &&
      !normalizedAddress.startsWith(LINK_LOCAL_PREFIX)
    );
  }

  const lowercaseAddress = normalizedAddress.toLowerCase();
  return (
    lowercaseAddress !== '::' &&
    lowercaseAddress !== '::1' &&
    !lowercaseAddress.startsWith(IPV6_LINK_LOCAL_PREFIX)
  );
}

function shouldIncludeFamily(
  family: NetworkInterfaceFamily,
  hostFamily: NetworkOptions['hostFamily']
): boolean {
  if (hostFamily === 'all') return true;
  if (hostFamily === 'ipv6') return family === 'IPv6';
  return family === 'IPv4';
}

function isIncludedHost(address: string, options: NetworkOptions): boolean {
  if (options.includeHosts?.length) {
    return options.includeHosts.includes(address);
  }

  return true;
}

function isExcludedHost(address: string, options: NetworkOptions): boolean {
  return options.excludeHosts?.includes(address) ?? false;
}

function getPreferredInterfaceScore(interfaceName: string, preferInterface?: string): number {
  if (!preferInterface) return 0;

  const normalizedInterface = interfaceName.toLowerCase();
  const normalizedPreference = preferInterface.toLowerCase();

  if (normalizedInterface === normalizedPreference) return 3;
  if (normalizedInterface.startsWith(normalizedPreference)) return 2;
  if (normalizedInterface.includes(normalizedPreference)) return 1;

  return 0;
}

function compareEntries(
  left: NetworkUrlEntry,
  right: NetworkUrlEntry,
  options: NetworkOptions
): number {
  const preferredDelta =
    getPreferredInterfaceScore(right.interfaceName, options.preferInterface) -
    getPreferredInterfaceScore(left.interfaceName, options.preferInterface);

  if (preferredDelta !== 0) {
    return preferredDelta;
  }

  const interfaceDelta = left.interfaceName.localeCompare(right.interfaceName);
  if (interfaceDelta !== 0) {
    return interfaceDelta;
  }

  const familyDelta = left.family.localeCompare(right.family);
  if (familyDelta !== 0) {
    return familyDelta;
  }

  return left.url.localeCompare(right.url);
}

function normalizePrintableUrls(urls: string[], options: NetworkOptions = {}): string[] {
  const normalizedUrls = new Set<string>();
  const pathname = options.path === undefined ? null : normalizePath(options.path);

  for (const candidate of urls) {
    if (!candidate.trim()) {
      continue;
    }

    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }

    if (options.protocol) {
      parsed.protocol = `${options.protocol}:`;
    }

    if (pathname !== null) {
      parsed.pathname = pathname || '/';
    }

    const normalizedHref =
      parsed.pathname === '/' ? parsed.toString().replace(/\/$/, '') : parsed.toString();
    normalizedUrls.add(normalizedHref);
  }

  return Array.from(normalizedUrls).sort((left, right) => left.localeCompare(right));
}

function printUrls(
  urls: string[],
  options: PluginOptions,
  preferredUrl: string | null = null
): string[] {
  const logger = getLogger(options.logger);
  let finalUrls = urls;

  if (options.filter) {
    finalUrls = finalUrls.filter((url) => options.filter?.(url) ?? true);
  }

  if (finalUrls.length === 0) {
    logger.warn?.('[vite-qr] No usable local network addresses found.');
    return [];
  }

  logger.log('');
  logger.log('Visit your Vite app on mobile:');
  for (const url of finalUrls) {
    const preferredLabel =
      options.preferInterface &&
      preferredUrl !== null &&
      finalUrls.length > 1 &&
      url === preferredUrl
        ? ' (recommended)'
        : '';
    logger.log(`${url}${preferredLabel}`);
    logger.log(renderQR(url));
  }
  printThanksMessage((...args: unknown[]) => logger.log(...args));
  logger.log('');

  return finalUrls;
}

function getLocalNetworkEntries(port: number, options: NetworkOptions = {}): NetworkUrlEntry[] {
  const interfaces = os.networkInterfaces();
  const urls = new Map<string, NetworkUrlEntry>();
  const protocol = options.protocol ?? 'http';
  const pathname = normalizePath(options.path);
  const hostFamily = normalizeHostFamily(options.hostFamily);

  for (const interfaceName of Object.keys(interfaces)) {
    for (const iface of interfaces[interfaceName] || []) {
      const address = normalizeAddress(iface.address);
      const family = detectInterfaceFamily(iface.family as string | number, address);

      if (iface.internal) continue;
      if (!family) continue;
      if (!shouldIncludeFamily(family, hostFamily)) continue;
      if (!isReachableAddress(address, family)) continue;
      if (!isIncludedHost(address, options) || isExcludedHost(address, options)) {
        continue;
      }

      const url = `${protocol}://${formatAddressForUrl(address, family)}:${port}${pathname}`;

      if (!urls.has(url)) {
        urls.set(url, {
          address,
          family,
          interfaceName,
          url,
        });
      }
    }
  }

  return Array.from(urls.values()).sort((left, right) => compareEntries(left, right, options));
}

export function renderQR(url: string): string {
  const { data, size } = encode(url);

  const isDark = (row: number, col: number): boolean => {
    if (row < 0 || row >= size || col < 0 || col >= size) return false;
    return data[row]?.[col] === true;
  };

  const lines: string[] = [];
  const width = size + MARGIN * 2;
  const blank = ' '.repeat(width);
  lines.push(blank);
  for (let row = -MARGIN; row < size + MARGIN; row += 2) {
    let line = '';
    for (let col = -MARGIN; col < size + MARGIN; col++) {
      const top = isDark(row, col);
      const bottom = isDark(row + 1, col);
      if (top && bottom) line += '\u2588';
      else if (top) line += '\u2580';
      else if (bottom) line += '\u2584';
      else line += ' ';
    }
    lines.push(line);
  }
  lines.push(blank);
  return lines.join('\n');
}

export function getLocalNetworkUrls(port: number, options: NetworkOptions = {}): string[] {
  return getLocalNetworkEntries(port, options).map((entry) => entry.url);
}

export function getPreferredNetworkUrl(port: number, options: NetworkOptions = {}): string | null {
  return getLocalNetworkEntries(port, options)[0]?.url ?? null;
}

export function printQRCodes(port: number, options: PluginOptions = {}): string[] {
  if (options.enabled === false) {
    return [];
  }

  const entries = getLocalNetworkEntries(port, options);
  return printUrls(
    entries.map((entry) => entry.url),
    options,
    entries[0]?.url ?? null
  );
}

export function printResolvedQRCodes(urls: string[], options: PluginOptions = {}): string[] {
  if (options.enabled === false) {
    return [];
  }

  return printUrls(normalizePrintableUrls(urls, options), options, null);
}
