import type { AddressInfo } from 'node:net';
import type { Plugin, ViteDevServer } from 'vite';
import type { ViteQRCodeOptions } from '../types';
import { getLocalNetworkUrls, printQRCodes, printResolvedQRCodes } from '../utils';

const RETRY_DELAY_MS = 2000;
const WATCHER_EVENTS = new Set(['add', 'addDir', 'change', 'unlink', 'unlinkDir']);

function getServerPort(server: ViteDevServer): number | null {
  const address = server.httpServer?.address();

  if (!address || typeof address === 'string') {
    return null;
  }

  return (address as AddressInfo).port;
}

function inferProtocol(server: ViteDevServer, options: ViteQRCodeOptions): 'http' | 'https' {
  if (options.protocol) {
    return options.protocol;
  }

  return server.config.server.https ? 'https' : 'http';
}

function getResolvedNetworkUrls(server: ViteDevServer): string[] {
  return server.resolvedUrls?.network ?? [];
}

function getUrlHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function orderResolvedUrlsByLocalUrls(resolvedUrls: string[], localUrls: string[]): string[] {
  if (localUrls.length === 0) {
    return resolvedUrls;
  }

  const hostOrder = new Map<string, number>();
  for (const [index, localUrl] of localUrls.entries()) {
    const hostname = getUrlHostname(localUrl);
    if (hostname !== null && !hostOrder.has(hostname)) {
      hostOrder.set(hostname, index);
    }
  }

  return [...resolvedUrls].sort((left, right) => {
    const leftRank = hostOrder.get(getUrlHostname(left) ?? '');
    const rightRank = hostOrder.get(getUrlHostname(right) ?? '');

    if (leftRank !== undefined && rightRank !== undefined) {
      return leftRank - rightRank;
    }

    if (leftRank !== undefined) {
      return -1;
    }

    if (rightRank !== undefined) {
      return 1;
    }

    return left.localeCompare(right);
  });
}

function printForServer(server: ViteDevServer, options: ViteQRCodeOptions): boolean {
  const port = getServerPort(server);
  if (!port) {
    options.logger?.warn?.('[vite-qr] Could not determine the Vite dev server port.');
    return false;
  }

  try {
    const normalizedOptions = {
      ...options,
      protocol: inferProtocol(server, options),
    } satisfies ViteQRCodeOptions;
    const localUrls = getLocalNetworkUrls(port, normalizedOptions);
    const resolvedUrls = getResolvedNetworkUrls(server);

    if (resolvedUrls.length > 0) {
      return (
        printResolvedQRCodes(
          orderResolvedUrlsByLocalUrls(resolvedUrls, localUrls),
          normalizedOptions
        ).length > 0
      );
    }

    return printQRCodes(port, normalizedOptions).length > 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.logger?.warn) {
      options.logger.warn(`[vite-qr] Failed to print Vite QR codes: ${message}`);
      return false;
    }

    process.stderr.write(`[vite-qr] Failed to print Vite QR codes: ${message}\n`);
    return false;
  }
}

function attachOnce(server: ViteDevServer, callback: () => void): void {
  if (server.httpServer?.listening) {
    callback();
    return;
  }

  server.httpServer?.once('listening', callback);
}

export function viteQRCode(options: ViteQRCodeOptions = {}): Plugin {
  return {
    name: 'vite-qr',
    apply: 'serve',
    configureServer(server) {
      if (options.enabled === false) {
        return;
      }

      let hasPrinted = false;
      let printTimer: ReturnType<typeof setTimeout> | null = null;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;

      const clearPrintTimer = () => {
        if (printTimer === null) {
          return;
        }

        clearTimeout(printTimer);
        printTimer = null;
      };

      const clearRetryTimer = () => {
        if (retryTimer === null) {
          return;
        }

        clearTimeout(retryTimer);
        retryTimer = null;
      };

      const clearTimers = () => {
        clearPrintTimer();
        clearRetryTimer();
      };

      const scheduleRetry = () => {
        if (hasPrinted || retryTimer !== null) {
          return;
        }

        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (server.httpServer?.listening && !hasPrinted) {
            print();
          }
        }, RETRY_DELAY_MS);
      };

      const print = () => {
        clearPrintTimer();

        if (options.once !== false && hasPrinted) {
          return;
        }

        const printed = printForServer(server, options);
        hasPrinted = printed || hasPrinted;

        if (printed) {
          clearRetryTimer();
          return;
        }

        scheduleRetry();
      };

      attachOnce(server, print);

      const schedulePrint = () => {
        if (!server.httpServer?.listening || printTimer !== null) {
          return;
        }

        printTimer = setTimeout(() => {
          printTimer = null;
          print();
        }, 50);
      };

      const handleWatcherEvent = (event: string) => {
        if (WATCHER_EVENTS.has(event)) {
          schedulePrint();
        }
      };

      server.httpServer?.once('close', () => {
        clearTimers();
        server.watcher.off?.('all', handleWatcherEvent);
      });
      server.watcher.on('all', handleWatcherEvent);
    },
  };
}
