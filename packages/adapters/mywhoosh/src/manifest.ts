import type { PlatformManifest } from '@fitbridge/core';

export const mywhooshManifest: PlatformManifest = {
  id: 'mywhoosh',
  displayName: 'MyWhoosh',
  shortCode: 'mw',
  vendor: 'MyWhoosh',
  homepage: 'https://www.mywhoosh.com',

  authType: 'password',
  access: 'reverse-engineered',

  capabilities: {
    download: true,
    // MyWhoosh 没有面向第三方的上传 API，只能作数据源
    upload: false,
    uploadFormats: [],
    deleteRemote: false,
    webhook: false,
    incremental: false,
  },

  coordinateSystem: 'wgs84',

  rateLimit: {
    requestsPerMinute: 30,
    minLoginIntervalSec: 120,
  },

  uploadAsync: false,

  riskLevel: 'medium',
  notes:
    '非官方接口（分析自官方 App 协议）。MyWhoosh 无公开上传 API，仅作数据源。' +
    '下载分两步：先换 S3 预签名地址再立即下载，地址有时效不可缓存。',
};
