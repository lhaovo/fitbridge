import type {
  Credential,
  UploadHint,
  UploadResult,
} from '@fitbridge/core';
import { needsRebuild, readFit, rebuildFit } from '@fitbridge/fitkit';
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

  // ★ 上传前先把 FIT 规范化。
  //   迈金的异步入库对文件结构有要求：
  //   整个活动只有 1 个 lap、或 sub_sport=virtual_activity 的文件会被静默丢弃
  //   （接口照样返回 success_count=1，但列表里永远不出现）。
  //   重建后是「每 5km 一个 lap + device_info + sport 消息 + generic sub_sport」，
  //   和迈金自己的设备导出结构一致。
  let content = file.content;
  let filename = file.filename;
  if (file.kind === 'fit') {
    try {
      const summary = await readFit(file.content, { maxTrackPoints: 0 });
      if (needsRebuild(summary)) {
        const rebuilt = rebuildFit({
          summary,
          manufacturer: 255,
          product: 1,
          serialNumber: 1,
          productName: 'FitBridge',
          timezoneOffsetMin: summary.timezoneOffsetMin,
        });
        content = rebuilt.content;
        filename = filename.replace(/\.fit$/i, '') + '-norm.fit';
      }
    } catch {
      // 解析失败就按原样传，让平台自己报错（不要因为重建失败而挡住上传）
    }
  }

  const form = new FormData();
  form.append('jilu0', new Blob([content]), filename);

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
