import FitParser from 'fit-file-parser';

/**
 * FIT 文件结构检查 —— 排平台兼容性问题用。
 *
 * 背景：迈金这类严格平台会**静默丢弃**不合规的 FIT
 * （上传接口返回 success_count=1，但活动列表里永远不出现）。
 * 定位这类问题第一步就是对比「能入库的文件」和「被丢弃的文件」的结构差异。
 *
 * 实测对比（2026-11）：
 *   能入库：laps×21（每 5km 一个）、device_info×4、sport 消息、sub_sport=252
 *   被丢弃：laps×1、无 device_info、无 sport 消息、sub_sport=virtual_activity
 */

export interface FitStructure {
  /** 各类消息的条数，如 { sessions: 1, laps: 21, records: 16139 } */
  counts: Record<string, number>;
  fileId?: {
    type?: string;
    manufacturer?: string;
    product?: number;
    productName?: string;
    serialNumber?: number;
  };
  session?: {
    sport?: string;
    subSport?: string;
    totalDistance?: number;
    totalElapsedSec?: number;
    totalTimerSec?: number;
    avgSpeed?: number;
    avgHeartRate?: number;
    avgPower?: number;
    startTime?: string;
  };
  laps?: {
    count: number;
    firstDistance?: number;
    lastDistance?: number;
    trigger?: string;
  };
  deviceInfos?: {
    manufacturer?: string;
    product?: number;
    deviceType?: string;
    name?: string;
  }[];
  /** 解析告警 */
  warnings: string[];
}

/** 解析 FIT 文件的消息结构（不抛异常，失败时返回 warnings） */
export async function inspectFit(content: Buffer | Uint8Array): Promise<FitStructure> {
  const parser = new FitParser({ mode: 'both', includeUnmappedMessages: true });
  let p: Record<string, unknown>;
  try {
    p = (await parser.parseAsync(
      content as ArrayBuffer | Buffer<ArrayBuffer>,
    )) as unknown as Record<string, unknown>;
  } catch (err) {
    return {
      counts: {},
      deviceInfos: [],
      warnings: ['解析失败: ' + (err instanceof Error ? err.message : String(err))],
    };
  }

  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) {
    if (Array.isArray(v) && v.length) counts[k] = v.length;
  }

  const row = (v: unknown) => (v ?? {}) as Record<string, unknown>;
  const fileId = (p.file_ids as unknown[] | undefined)?.[0];
  const session = (p.sessions as unknown[] | undefined)?.[0];
  const laps = (p.laps as unknown[] | undefined) ?? [];
  const firstLap = row(laps[0]);
  const lastLap = row(laps[laps.length - 1]);

  const out: FitStructure = {
    counts,
    deviceInfos: ((p.device_infos as unknown[] | undefined) ?? []).map((d) => {
      const r = row(d);
      return {
        manufacturer: r.manufacturer as string | undefined,
        product: r.product as number | undefined,
        deviceType: r.device_type as string | undefined,
        name: (r.product_name ?? r.descriptor) as string | undefined,
      };
    }),
    warnings: [],
  };

  if (fileId) {
    const r = row(fileId);
    out.fileId = {
      type: r.type as string | undefined,
      manufacturer: r.manufacturer as string | undefined,
      product: r.product as number | undefined,
      productName: r.product_name as string | undefined,
      serialNumber: r.serial_number as number | undefined,
    };
  }
  if (session) {
    const r = row(session);
    out.session = {
      sport: r.sport as string | undefined,
      subSport: r.sub_sport as string | undefined,
      totalDistance: r.total_distance as number | undefined,
      totalElapsedSec: r.total_elapsed_time as number | undefined,
      totalTimerSec: r.total_timer_time as number | undefined,
      avgSpeed: r.avg_speed as number | undefined,
      avgHeartRate: r.avg_heart_rate as number | undefined,
      avgPower: r.avg_power as number | undefined,
      startTime: r.start_time as string | undefined,
    };
  }
  if (laps.length) {
    out.laps = {
      count: laps.length,
      firstDistance: firstLap.total_distance as number | undefined,
      lastDistance: lastLap.total_distance as number | undefined,
      trigger: firstLap.lap_trigger as string | undefined,
    };
  }

  return out;
}
