import type {
  Credential,
  UploadHint,
  UploadResult,
} from '@fitbridge/core';
import { OtmClient } from './client.js';

/**
 * 迈金上传：POST /api/otm/ride_record/upload/fit
 *
 * ★ 关键：multipart 字段名必须是 jilu0
 *   官方网页 JS 用的是 jilu，但程序化上传需要 jilu0（参考项目踩过的坑）。
 *
 * 成功判定：code == 200 且 data.success_count >= 1
 * 注意：上传是异步入库，约 15-20 秒后才在活动列表可见。
 */
export async function uploadFile(
  client: OtmClient,
  cred: Credential,
  file: { content: Buffer; kind: 'fit' | 'gpx' | 'tcx'; filename: string },
  hint: UploadHint,
): Promise<UploadResult> {
  if (file.kind !== 'fit') {
    return {
      status: 'rejected',
      message: '迈金上传仅接受 FIT（GPX 需先转换）',
    };
  }

  const token = String(cred.secret.token ?? '');
  const form = new FormData();
  form.append('jilu0', new Blob([file.content]), file.filename);

  const res = await client.request<{ success_count?: number }>(
    '/api/otm/ride_record/upload/fit',
    token,
    {
      method: 'POST',
      form,
      timeoutMs: 120_000,
    },
  );

  const env = OtmClient.assertOk<{ success_count?: number }>(res, '迈金上传');
  const successCount = env.data?.success_count ?? 0;

  if (successCount >= 1) {
    return {
      status: 'pending',
      message:
        '上传已受理，约 15-20 秒后入库（external_id=' + hint.externalId + '）',
      raw: env.data,
    };
  }

  return {
    status: 'rejected',
    message:
      '迈金未接受该文件（success_count=' + successCount + '）',
    raw: env.data,
  };
}
