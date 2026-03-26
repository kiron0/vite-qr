import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getLocalNetworkUrls, printQRCodes, printResolvedQRCodes } = vi.hoisted(() => ({
  getLocalNetworkUrls: vi.fn(),
  printQRCodes: vi.fn(),
  printResolvedQRCodes: vi.fn(),
}));

vi.mock('../src/utils', () => ({
  getLocalNetworkUrls,
  printQRCodes,
  printResolvedQRCodes,
}));

import { viteQRCode } from '../src/plugin';

type Handler = () => void;

type ServerLike = {
  config: { server: { https?: boolean } };
  httpServer: {
    listening: boolean;
    once: ReturnType<typeof vi.fn>;
    address: () => { port: number } | string | null;
    emit: (event: string) => void;
  };
  resolvedUrls?: { network: string[] };
  watcher: {
    off: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    emit: (event: string) => void;
  };
};

function createServer(port = 5173, https = false, resolvedNetworkUrls: string[] = []): ServerLike {
  const httpHandlers = new Map<string, Handler[]>();
  const watcherHandlers = new Map<string, Array<(event: string) => void>>();

  return {
    config: { server: { https } },
    resolvedUrls: { network: resolvedNetworkUrls },
    httpServer: {
      listening: false,
      once: vi.fn((event: string, handler: Handler) => {
        httpHandlers.set(event, [...(httpHandlers.get(event) ?? []), handler]);
      }),
      address: () => ({ port }),
      emit(event: string) {
        if (event === 'listening') {
          this.listening = true;
        }

        const handlers = httpHandlers.get(event) ?? [];
        httpHandlers.set(event, []);
        for (const handler of handlers) {
          handler();
        }
      },
    },
    watcher: {
      off: vi.fn((event: string, handler: (event: string) => void) => {
        watcherHandlers.set(
          event,
          (watcherHandlers.get(event) ?? []).filter(
            (registeredHandler) => registeredHandler !== handler
          )
        );
      }),
      on: vi.fn((event: string, handler: (event: string) => void) => {
        watcherHandlers.set(event, [...(watcherHandlers.get(event) ?? []), handler]);
      }),
      emit(event: string) {
        for (const handler of watcherHandlers.get('all') ?? []) {
          handler(event);
        }
      },
    },
  };
}

describe('viteQRCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    getLocalNetworkUrls.mockReturnValue(['http://192.168.1.20:5173']);
    printQRCodes.mockReturnValue(['http://192.168.1.20:5173']);
    printResolvedQRCodes.mockReturnValue(['http://192.168.1.20:5173']);
  });

  it('does not print when disabled', () => {
    const server = createServer();
    const plugin = viteQRCode({ enabled: false });

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');

    expect(printQRCodes).not.toHaveBeenCalled();
  });

  it('prints once on server startup by default', () => {
    const server = createServer(4173);
    const plugin = viteQRCode();

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');
    server.httpServer.emit('listening');

    expect(printQRCodes).toHaveBeenCalledTimes(1);
    expect(printQRCodes).toHaveBeenCalledWith(4173, { protocol: 'http' });
  });

  it('prints again on file changes when once is false', () => {
    vi.useFakeTimers();
    const server = createServer(5173);
    const plugin = viteQRCode({ once: false });

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');
    server.watcher.emit('change');
    vi.advanceTimersByTime(50);

    expect(printQRCodes).toHaveBeenCalledTimes(2);
    expect(printQRCodes).toHaveBeenNthCalledWith(1, 5173, {
      once: false,
      protocol: 'http',
    });
    expect(printQRCodes).toHaveBeenNthCalledWith(2, 5173, {
      once: false,
      protocol: 'http',
    });
  });

  it('treats add and unlink as file changes when once is false', () => {
    vi.useFakeTimers();
    const server = createServer(5173);
    const plugin = viteQRCode({ once: false });

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');
    server.watcher.emit('add');
    server.watcher.emit('unlink');
    vi.advanceTimersByTime(50);

    expect(printQRCodes).toHaveBeenCalledTimes(2);
  });

  it('treats addDir and unlinkDir as file changes when once is false', () => {
    vi.useFakeTimers();
    const server = createServer(5173);
    const plugin = viteQRCode({ once: false });

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');
    server.watcher.emit('addDir');
    server.watcher.emit('unlinkDir');
    vi.advanceTimersByTime(50);

    expect(printQRCodes).toHaveBeenCalledTimes(2);
  });

  it('debounces bursts of watcher events into a single reprint', () => {
    vi.useFakeTimers();
    const server = createServer(5173);
    const plugin = viteQRCode({ once: false });

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');
    server.watcher.emit('change');
    server.watcher.emit('add');
    server.watcher.emit('unlinkDir');
    vi.advanceTimersByTime(50);

    expect(printQRCodes).toHaveBeenCalledTimes(2);
  });

  it('retries after an initial print failure before the first successful print', () => {
    vi.useFakeTimers();
    const server = createServer(5173);
    printQRCodes.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const plugin = viteQRCode();

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');
    vi.advanceTimersByTime(2000);

    expect(printQRCodes).toHaveBeenCalledTimes(2);
    expect(printQRCodes).toHaveBeenNthCalledWith(2, 5173, { protocol: 'http' });
  });

  it('retries when no URLs were printed yet', () => {
    vi.useFakeTimers();
    const server = createServer(5173);
    printQRCodes.mockReturnValueOnce([]);
    const plugin = viteQRCode();

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');
    vi.advanceTimersByTime(2000);

    expect(printQRCodes).toHaveBeenCalledTimes(2);
    expect(printQRCodes).toHaveBeenNthCalledWith(2, 5173, { protocol: 'http' });
  });

  it('clears the retry timer when the server closes', () => {
    vi.useFakeTimers();
    const server = createServer(5173);
    printQRCodes.mockReturnValue([]);
    const plugin = viteQRCode();

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');
    server.httpServer.emit('close');
    vi.advanceTimersByTime(2000);

    expect(printQRCodes).toHaveBeenCalledTimes(1);
  });

  it('removes watcher listeners when the server closes', () => {
    const server = createServer(5173);
    const plugin = viteQRCode({ once: false });

    plugin.configureServer?.(server as never);
    server.httpServer.emit('close');

    expect(server.watcher.off).toHaveBeenCalledTimes(1);
    expect(server.watcher.off).toHaveBeenCalledWith('all', expect.any(Function));
  });

  it('respects path, protocol, and filter options', () => {
    const server = createServer(5173, true);
    const filter = vi.fn((url: string) => url.includes('192.168.'));
    const plugin = viteQRCode({
      filter,
      path: '/preview',
    });

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');

    expect(printQRCodes).toHaveBeenCalledWith(5173, {
      filter,
      path: '/preview',
      protocol: 'https',
    });
  });

  it('uses the provided logger', () => {
    const server = createServer();
    const logger = { log: vi.fn(), warn: vi.fn() };
    const plugin = viteQRCode({ logger });

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');

    expect(printQRCodes).toHaveBeenCalledWith(5173, {
      logger,
      protocol: 'http',
    });
  });

  it('routes plugin print failures through the provided logger', () => {
    const server = createServer();
    const logger = { log: vi.fn(), warn: vi.fn() };
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    printQRCodes.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const plugin = viteQRCode({ logger });

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');

    expect(logger.warn).toHaveBeenCalledWith('[vite-qr] Failed to print Vite QR codes: boom');
    expect(stderrWriteSpy).not.toHaveBeenCalled();
  });

  it('falls back to Vite resolved network URLs when adapter discovery finds none', () => {
    const server = createServer(5173, false, [
      'http://10.0.0.4:5173/',
      'http://192.168.1.20:5173/',
    ]);
    getLocalNetworkUrls.mockReturnValueOnce([]);
    const plugin = viteQRCode({ path: '/preview' });

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');

    expect(printQRCodes).not.toHaveBeenCalled();
    expect(printResolvedQRCodes).toHaveBeenCalledWith(
      ['http://10.0.0.4:5173/', 'http://192.168.1.20:5173/'],
      {
        path: '/preview',
        protocol: 'http',
      }
    );
  });

  it('prefers Vite resolved network URLs over synthesized local URLs when available', () => {
    const server = createServer(5173, false, ['http://192.168.1.20:5173/base/']);
    getLocalNetworkUrls.mockReturnValueOnce(['http://192.168.1.20:5173']);
    const plugin = viteQRCode();

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');

    expect(printResolvedQRCodes).toHaveBeenCalledWith(['http://192.168.1.20:5173/base/'], {
      protocol: 'http',
    });
    expect(printQRCodes).not.toHaveBeenCalled();
  });

  it('orders resolved network URLs by local interface preference when both sources exist', () => {
    const server = createServer(5173, false, [
      'http://192.168.1.20:5173/base/',
      'http://10.0.0.4:5173/base/',
    ]);
    getLocalNetworkUrls.mockReturnValueOnce(['http://10.0.0.4:5173', 'http://192.168.1.20:5173']);
    const plugin = viteQRCode({ preferInterface: 'wlan' });

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');

    expect(printResolvedQRCodes).toHaveBeenCalledWith(
      ['http://10.0.0.4:5173/base/', 'http://192.168.1.20:5173/base/'],
      {
        preferInterface: 'wlan',
        protocol: 'http',
      }
    );
  });

  it('does not warn through the empty-network path when resolved fallback succeeds', () => {
    const server = createServer(5173, false, ['http://192.168.1.20:5173/base/']);
    const logger = { log: vi.fn(), warn: vi.fn() };
    getLocalNetworkUrls.mockReturnValueOnce([]);
    const plugin = viteQRCode({ logger });

    plugin.configureServer?.(server as never);
    server.httpServer.emit('listening');

    expect(printQRCodes).not.toHaveBeenCalled();
    expect(printResolvedQRCodes).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
