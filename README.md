# vite-qr

Print QR codes for your local Vite dev server so phones and tablets on the same network can open it instantly.

## Install

```bash
npm install -D vite-qr
```

`vite >= 5` is required.

## Quick Start

`vite.config.ts`

```ts
import { defineConfig } from 'vite';
import viteQRCode from 'vite-qr';

export default defineConfig({
  plugins: [viteQRCode()],
});
```

`vite.config.js` / `vite.config.cjs`

```js
const viteQRCode = require('vite-qr');

module.exports = {
  plugins: [viteQRCode()],
};
```

Run your dev server as usual:

```bash
npm run dev
```

When the dev server is reachable, `vite-qr` prints LAN URLs and QR codes in the terminal.

## CLI

```bash
vite-qr init
vite-qr doctor
```

`init` can run from the app directory, a nested folder inside the app, or a workspace root when exactly one Vite app is found.
It injects `viteQRCode()` and, when possible, updates the detected `dev` script to include `--host`.

Flags:

- `--skip` skips the confirmation prompt
- `--force` re-injects `viteQRCode()`
- `--check` shows planned changes without writing files
- `--quiet` reduces non-essential output

## Plugin Behavior

`viteQRCode()` runs only in dev server mode.

By default it prints once when the Vite dev server starts listening.

When `once: false` is passed, it also prints again on file changes while the dev server is still running.

When Vite exposes canonical resolved network URLs, `vite-qr` prefers those so printed QR targets keep the effective dev-server base path and origin.

The plugin resolves the effective protocol in this order:

- `options.protocol`
- Vite HTTPS server config
- `"http"`

## Options

```ts
type ViteQRCodeOptions = {
  enabled?: boolean;
  once?: boolean;
  path?: string;
  protocol?: 'http' | 'https';
  filter?: (url: string) => boolean;
  logger?: {
    log: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
  };
  hostFamily?: 'ipv4' | 'ipv6' | 'all';
  includeHosts?: string[];
  excludeHosts?: string[];
  preferInterface?: string;
};
```

Notes:

- `enabled` disables the integration
- `once` defaults to `true`
- `path` is optional and usually stays at the root; when set, it overrides the printed URL path
- `protocol` defaults to the Vite server protocol, then `"http"`
- `hostFamily` defaults to `"ipv4"` and affects local interface discovery
- `includeHosts` and `excludeHosts` match raw interface addresses discovered from local network interfaces
- `preferInterface` influences local interface ordering and helps order resolved Vite URLs when available
- `filter` runs on the final printed URLs

## Examples

Print again on file changes:

```ts
import { defineConfig } from 'vite';
import viteQRCode from 'vite-qr';

export default defineConfig({
  plugins: [viteQRCode({ once: false })],
});
```

Filter printed URLs:

```ts
import { defineConfig } from 'vite';
import viteQRCode from 'vite-qr';

export default defineConfig({
  plugins: [viteQRCode({ filter: (url) => url.includes('192.168.') })],
});
```

Prefer an interface:

```ts
import { defineConfig } from 'vite';
import viteQRCode from 'vite-qr';

export default defineConfig({
  plugins: [viteQRCode({ preferInterface: 'wlan' })],
});
```

## API

### `viteQRCode(options?)`

Creates a Vite dev-server plugin and prints QR codes when the server is listening.

### `printQRCodes(port, options?)`

Prints URLs and QR codes immediately from local interface discovery and returns the generated URLs.

### `getLocalNetworkUrls(port, options?)`

Returns LAN URLs without printing anything.

### `getPreferredNetworkUrl(port, options?)`

Returns the first URL after network preference ordering, or `null` when nothing is reachable.
