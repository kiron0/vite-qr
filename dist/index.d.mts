import { Plugin } from 'vite';

interface QRCodeLogger {
    log: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
}
type NetworkHostFamily = 'ipv4' | 'ipv6' | 'all';
interface NetworkOptions {
    excludeHosts?: string[];
    hostFamily?: NetworkHostFamily;
    includeHosts?: string[];
    path?: string;
    preferInterface?: string;
    protocol?: 'http' | 'https';
}
interface PluginOptions extends NetworkOptions {
    enabled?: boolean;
    filter?: (url: string) => boolean;
    logger?: QRCodeLogger;
}
interface ViteQRCodeOptions extends PluginOptions {
    once?: boolean;
}

declare function viteQRCode(options?: ViteQRCodeOptions): Plugin;

declare function getLocalNetworkUrls(port: number, options?: NetworkOptions): string[];
declare function getPreferredNetworkUrl(port: number, options?: NetworkOptions): string | null;
declare function printQRCodes(port: number, options?: PluginOptions): string[];

export { type NetworkHostFamily, type NetworkOptions, type PluginOptions, type QRCodeLogger, type ViteQRCodeOptions, viteQRCode as default, getLocalNetworkUrls, getPreferredNetworkUrl, printQRCodes, viteQRCode };
