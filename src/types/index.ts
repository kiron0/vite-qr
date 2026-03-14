export interface QRCodeLogger {
  log: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

export type NetworkHostFamily = 'ipv4' | 'ipv6' | 'all';

export interface NetworkOptions {
  excludeHosts?: string[];
  hostFamily?: NetworkHostFamily;
  includeHosts?: string[];
  path?: string;
  preferInterface?: string;
  protocol?: 'http' | 'https';
}

export interface PluginOptions extends NetworkOptions {
  enabled?: boolean;
  filter?: (url: string) => boolean;
  logger?: QRCodeLogger;
}

export interface ViteQRCodeOptions extends PluginOptions {
  once?: boolean;
}
