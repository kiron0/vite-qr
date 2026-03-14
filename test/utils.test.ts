import { beforeEach, describe, expect, it, vi } from 'vitest';

const { uqrEncode, networkInterfaces } = vi.hoisted(() => ({
  uqrEncode: vi.fn(),
  networkInterfaces: vi.fn(),
}));

vi.mock('os', () => ({
  default: { networkInterfaces },
  networkInterfaces,
}));

vi.mock('uqr', () => ({
  encode: uqrEncode,
}));

import {
  getLocalNetworkUrls,
  getPreferredNetworkUrl,
  printQRCodes,
  printResolvedQRCodes,
  renderQR,
} from '../src/utils';

function fakeUqr(size: number, dark = true) {
  const row = Array.from<boolean>({ length: size }).fill(dark);
  return {
    size,
    version: 1,
    maskPattern: 0,
    data: Array.from<boolean[]>({ length: size }).fill(row),
  };
}

describe('getLocalNetworkUrls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns sorted reachable IPv4 LAN URLs with protocol and path', () => {
    networkInterfaces.mockReturnValue({
      en0: [
        { family: 'IPv4', internal: false, address: '192.168.0.15' },
        { family: 'IPv4', internal: false, address: '10.0.0.8' },
        { family: 'IPv4', internal: false, address: '169.254.10.2' },
        { family: 'IPv6', internal: false, address: 'fe80::1' },
      ],
      lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      bridge0: [{ family: 'IPv4', internal: false, address: '10.0.0.8' }],
    });

    expect(getLocalNetworkUrls(3000, { path: 'preview', protocol: 'https' })).toEqual([
      'https://10.0.0.8:3000/preview',
      'https://192.168.0.15:3000/preview',
    ]);
  });

  it('supports IPv6 and interface preference ordering', () => {
    networkInterfaces.mockReturnValue({
      wlan0: [
        { family: 'IPv6', internal: false, address: '2001:db8::20' },
        { family: 'IPv4', internal: false, address: '192.168.1.20' },
      ],
      en0: [{ family: 'IPv6', internal: false, address: '2001:db8::10' }],
      bridge0: [{ family: 'IPv6', internal: false, address: 'fe80::1' }],
    });

    expect(
      getLocalNetworkUrls(3000, {
        hostFamily: 'all',
        preferInterface: 'wl',
      })
    ).toEqual([
      'http://192.168.1.20:3000',
      'http://[2001:db8::20]:3000',
      'http://[2001:db8::10]:3000',
    ]);
  });

  it('filters uppercase IPv6 link-local addresses and honors include/exclude hosts', () => {
    networkInterfaces.mockReturnValue({
      wlan0: [
        { family: 'IPv6', internal: false, address: 'FE80::1' },
        { family: 'IPv4', internal: false, address: '192.168.1.20' },
        { family: 'IPv4', internal: false, address: '10.0.0.8' },
      ],
    });

    expect(
      getLocalNetworkUrls(3000, {
        includeHosts: ['192.168.1.20', '10.0.0.8'],
        excludeHosts: ['10.0.0.8'],
      })
    ).toEqual(['http://192.168.1.20:3000']);
  });

  it('normalizes numeric and lowercase interface family values', () => {
    networkInterfaces.mockReturnValue({
      wlan0: [
        { family: 4, internal: false, address: '192.168.1.20' },
        { family: 'ipv6', internal: false, address: '2001:db8::20' },
      ],
    });

    expect(getLocalNetworkUrls(3000, { hostFamily: 'all' })).toEqual([
      'http://192.168.1.20:3000',
      'http://[2001:db8::20]:3000',
    ]);
  });

  it('normalizes scoped or CIDR-style addresses and ignores unusable adapters', () => {
    networkInterfaces.mockReturnValue({
      en0: [
        { family: 'weird', internal: false, address: '192.168.1.20/24' },
        { family: 'mystery', internal: false, address: '2001:db8::20%en0' },
        { family: 'IPv4', internal: false, address: '0.0.0.0' },
        { family: 'IPv6', internal: false, address: '::1' },
      ],
    });

    expect(getLocalNetworkUrls(3000, { hostFamily: 'all' })).toEqual([
      'http://192.168.1.20:3000',
      'http://[2001:db8::20]:3000',
    ]);
  });
});

describe('getPreferredNetworkUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the first preferred URL or null when none are available', () => {
    networkInterfaces.mockReturnValue({
      en0: [{ family: 'IPv4', internal: false, address: '192.168.0.15' }],
      wlan0: [{ family: 'IPv4', internal: false, address: '10.0.0.8' }],
    });

    expect(getPreferredNetworkUrl(3000, { preferInterface: 'wlan' })).toBe('http://10.0.0.8:3000');

    networkInterfaces.mockReturnValue({
      lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    });

    expect(getPreferredNetworkUrl(3000)).toBeNull();
  });
});

describe('renderQR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('produces compact half-block output of correct height', () => {
    const size = 21;
    uqrEncode.mockReturnValue(fakeUqr(size));
    const output = renderQR('http://example.com');
    const lines = output.split('\n');
    const expected = 2 + Math.ceil(size / 2);
    expect(lines).toHaveLength(expected);
  });

  it('dark cells produce half-block characters', () => {
    const size = 1;
    uqrEncode.mockReturnValue(fakeUqr(size, true));
    const output = renderQR('http://example.com');
    const lines = output.split('\n');
    const dataLine = lines[1]!;
    expect(dataLine).toMatch(/[\u2580\u2584\u2588]/);
  });
});

describe('printQRCodes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uqrEncode.mockReturnValue(fakeUqr(21));
  });

  it('returns early when disabled', () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    expect(printQRCodes(3000, { enabled: false, logger })).toEqual([]);
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(uqrEncode).not.toHaveBeenCalled();
  });

  it('filters URLs, prints QR codes, and returns the final URL list', () => {
    networkInterfaces.mockReturnValue({
      en0: [
        { family: 'IPv4', internal: false, address: '192.168.1.20' },
        { family: 'IPv4', internal: false, address: '10.0.0.4' },
      ],
    });

    const logger = { log: vi.fn(), warn: vi.fn() };

    const urls = printQRCodes(3000, {
      filter: (url) => url.includes('192.168.'),
      logger,
      path: '/demo',
    });

    expect(urls).toEqual(['http://192.168.1.20:3000/demo']);
    expect(uqrEncode).toHaveBeenCalledTimes(1);
    expect(uqrEncode).toHaveBeenNthCalledWith(1, 'http://192.168.1.20:3000/demo');
    expect(logger.log).toHaveBeenNthCalledWith(1, '');
    expect(logger.log).toHaveBeenNthCalledWith(2, 'Visit your Vite app on mobile:');
    expect(logger.log).toHaveBeenNthCalledWith(3, 'http://192.168.1.20:3000/demo');
    expect(logger.log).toHaveBeenNthCalledWith(4, renderQR('http://192.168.1.20:3000/demo'));
    expect(logger.log).toHaveBeenNthCalledWith(5, '');
    expect(logger.log).toHaveBeenNthCalledWith(6, 'Thanks for using vite-qr!');
    expect(logger.log).toHaveBeenNthCalledWith(7, '');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('marks the preferred interface when multiple URLs are available', () => {
    networkInterfaces.mockReturnValue({
      eth0: [{ family: 'IPv4', internal: false, address: '10.0.0.4' }],
      wlan0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }],
    });

    const logger = { log: vi.fn(), warn: vi.fn() };

    const urls = printQRCodes(3000, {
      logger,
      preferInterface: 'wlan',
    });

    expect(urls).toEqual(['http://192.168.1.20:3000', 'http://10.0.0.4:3000']);
    expect(logger.log).toHaveBeenNthCalledWith(3, 'http://192.168.1.20:3000 (recommended)');
    expect(logger.log).toHaveBeenNthCalledWith(5, 'http://10.0.0.4:3000');
  });

  it('keeps all output on the provided logger', () => {
    networkInterfaces.mockReturnValue({
      en0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }],
    });

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const logger = { log: vi.fn(), warn: vi.fn() };

    printQRCodes(3000, { logger });

    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith('Thanks for using vite-qr!');
    consoleLogSpy.mockRestore();
  });

  it('warns when no usable LAN address exists', () => {
    networkInterfaces.mockReturnValue({
      lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      en0: [{ family: 'IPv4', internal: false, address: '169.254.1.5' }],
    });

    const logger = { log: vi.fn(), warn: vi.fn() };

    expect(printQRCodes(3000, { logger })).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain(
      'No usable local network addresses found.'
    );
    expect(uqrEncode).not.toHaveBeenCalled();
  });
});

describe('printResolvedQRCodes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uqrEncode.mockReturnValue(fakeUqr(21));
  });

  it('preserves resolved base paths when no custom path override is provided', () => {
    const logger = { log: vi.fn(), warn: vi.fn() };

    const urls = printResolvedQRCodes(['http://192.168.1.20:5173/base/'], { logger });

    expect(urls).toEqual(['http://192.168.1.20:5173/base/']);
    expect(logger.log).toHaveBeenNthCalledWith(3, 'http://192.168.1.20:5173/base/');
  });

  it('normalizes resolved URLs and respects protocol, path, and filter', () => {
    const logger = { log: vi.fn(), warn: vi.fn() };

    const urls = printResolvedQRCodes(
      ['http://192.168.1.20:5173/', 'http://10.0.0.4:5173/base/', 'not-a-url'],
      {
        filter: (url) => url.includes('192.168.'),
        logger,
        path: '/preview',
        protocol: 'https',
      }
    );

    expect(urls).toEqual(['https://192.168.1.20:5173/preview']);
    expect(logger.log).toHaveBeenNthCalledWith(3, 'https://192.168.1.20:5173/preview');
  });
});
