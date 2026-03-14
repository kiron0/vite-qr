import { getLocalNetworkUrls, getPreferredNetworkUrl, printQRCodes, viteQRCode } from './index';

const exported = Object.assign(viteQRCode, {
  default: viteQRCode,
  viteQRCode,
  getLocalNetworkUrls,
  getPreferredNetworkUrl,
  printQRCodes,
});

export = exported;
