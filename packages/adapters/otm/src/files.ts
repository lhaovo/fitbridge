import type {
  Credential,
  FilePayload,
  RemoteActivityDetail,
} from '@fitbridge/core';
import { detectFileKind } from '@fitbridge/fitkit';
import { OtmClient } from './client.js';

/**
 * 迈金文件下载有两条通道：
 *
 * 1. durl —— 七牛云签名直链，坐标系 WGS-84，直接 GET
 * 2. fitUrl —— 走 /api/otm/ride_record/analysis/fit_content/{base64(fitUrl)}，
 *    坐标系 GCJ-02，需要做坐标转换
 *
 * 两条通道的坐标系不一致，是参考项目踩过的坑（它为此提供了三个独立开关）。
 * 我们用「文件级坐标系标注」统一处理：优先用 durl，durl 不可用时回退 fit_content。
 */
export async function downloadFile(
  client: OtmClient,
  cred: Credential,
  activity: RemoteActivityDetail,
): Promise<FilePayload> {
  const token = String(cred.secret.token ?? '');
  const rec = (activity.raw ?? {}) as {
    durl?: string;
    fitUrl?: string;
  };

  // ① 优先七牛直链（WGS-84，无需转换）
  if (rec.durl) {
    const res = await client.http.requestBytes(rec.durl, {
      timeoutMs: 60_000,
    });
    if (res.ok && res.bytes && res.bytes.length > 0) {
      return toPayload(res.bytes, 'wgs84');
    }
  }

  // ② 回退 fit_content（GCJ-02）
  if (rec.fitUrl) {
    const encoded = Buffer.from(rec.fitUrl, 'utf8').toString('base64');
    const res = await client.http.requestBytes(
      '/api/otm/ride_record/analysis/fit_content/' + encoded,
      {
        timeoutMs: 60_000,
        headers: { Authorization: token },
      },
    );
    if (!res.ok || !res.bytes || res.bytes.length === 0) {
      throw new Error(
        '迈金 FIT 下载失败 HTTP ' + res.status + '（durl 与 fit_content 均不可用）',
      );
    }
    return toPayload(res.bytes, 'gcj02');
  }

  throw new Error('迈金活动详情里没有 durl / fitUrl，无法下载');
}

function toPayload(bytes: Buffer, coordinateSystem: 'wgs84' | 'gcj02'): FilePayload {
  const kind = detectFileKind(bytes);
  const sourceKind = kind === 'gpx' || kind === 'tcx' ? kind : 'fit';
  return {
    content: bytes,
    contentType: 'application/octet-stream',
    filename:
      sourceKind === 'fit' ? 'activity.fit' : 'activity.' + sourceKind,
    sourceKind,
    coordinateSystem,
  };
}
