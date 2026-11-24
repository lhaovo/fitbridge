import type {
  Credential,
  FilePayload,
  RemoteActivityDetail,
} from '@fitbridge/core';
import { detectFileKind } from '@fitbridge/fitkit';
import { MyWhooshClient } from './client.js';

/**
 * 下载分两步：
 * 1. POST /v2/rider/profile/activities/download-activity-file
 *    body {key: WhooshId, fileId: activityFileId}
 *    → data 是 S3 预签名 URL
 * 2. GET 该 URL 下载
 *
 * 预签名地址有时效，必须立即使用，不能缓存到下次运行。
 */
export async function downloadFile(
  client: MyWhooshClient,
  cred: Credential,
  activity: RemoteActivityDetail,
): Promise<FilePayload> {
  const token = String(cred.secret.accessToken ?? '');
  const whooshId = String(cred.meta?.whooshId ?? '');
  const raw = (activity.raw ?? {}) as { activityFileId?: string };
  // 列表项里就带了 activityFileId，detail 接口不返回时兜底取
  const fileId = activity.fileId ?? raw.activityFileId;

  if (!fileId) {
    throw new Error(
      'MyWhoosh 活动 ' + activity.remoteId + ' 没有 activityFileId，无法下载',
    );
  }

  // ★ 路径必须是 /v2/rider/profile/download-activity-file
  //   误写成 /v2/rider/profile/activities/download-activity-file 会 404
  //   （实测确认；已加回归测试锁定）
  const res = await client.api<{ data?: string; error?: unknown; message?: string }>(
    '/download-activity-file',
    token,
    { key: whooshId, fileId },
  );

  if (res.status === 401) {
    throw new Error('MyWhoosh token 过期（401）');
  }
  if (!res.ok) {
    throw new Error('MyWhoosh 获取下载地址 HTTP ' + res.status);
  }

  const url = res.json?.data;
  if (!url || !url.startsWith('http')) {
    throw new Error(
      'MyWhoosh 下载地址无效: ' +
        String(res.json?.message ?? url ?? '空').slice(0, 120),
    );
  }

  const fileRes = await client.http.requestBytes(url, { timeoutMs: 120_000 });
  if (!fileRes.ok || !fileRes.bytes || fileRes.bytes.length === 0) {
    throw new Error('MyWhoosh 文件下载失败 HTTP ' + fileRes.status);
  }

  const bytes = fileRes.bytes;
  const kind = detectFileKind(bytes);
  const sourceKind = kind === 'gpx' || kind === 'tcx' ? kind : 'fit';

  return {
    content: bytes,
    contentType: 'application/octet-stream',
    filename: sourceKind === 'fit' ? 'activity.fit' : 'activity.' + sourceKind,
    sourceKind,
    coordinateSystem: 'wgs84',
    remoteFileId: fileId,
  };
}
