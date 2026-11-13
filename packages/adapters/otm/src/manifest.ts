import type { PlatformManifest } from '@fitbridge/core';

export const otmManifest: PlatformManifest = {
  id: 'otm',
  displayName: '迈金 / 顽鹿 OTM',
  shortCode: 'mg',
  vendor: '顽鹿运动',
  homepage: 'https://otm.onelap.cn',

  authType: 'password',
  access: 'reverse-engineered',

  capabilities: {
    download: true,
    upload: true,
    // 上传只接受 FIT；GPX 必须先转 FIT
    uploadFormats: ['fit'],
    deleteRemote: false,
    webhook: false,
    // 平台按页码分页，没有时间游标；增量靠本地账本去重
    incremental: false,
  },

  // 迈金同一个平台内两个下载通道的坐标系不一致：
  //   durl（七牛直链）→ WGS-84
  //   fit_content      → GCJ-02
  // manifest 给默认值，实际以文件级探测为准
  coordinateSystem: 'gcj02',

  rateLimit: {
    requestsPerMinute: 20,
    // 迈金对频繁登录敏感，登录最小间隔 5 分钟
    minLoginIntervalSec: 300,
    uploadBatchSize: 20,
  },

  // 上传后异步入库，约 15-20 秒
  uploadAsync: true,
  uploadVerifyDelaySec: 20,

  riskLevel: 'medium',
  notes:
    '非官方接口（分析自官方 Web 端），上传仅接受 FIT 且约 15-20 秒后入库；' +
    '导出文件可能为 GCJ-02 坐标系，导入国际平台会偏移约 450m。',
};
