import { randomUUID } from 'node:crypto';
import type { Credential, PlatformAdapter } from '../ports/adapter.js';
import type { ActivityStore, EventSink, SyncItemInput } from '../ports/repository.js';
import type { FileStore } from '../ports/file-store.js';
import { PlatformError, normalizeError } from './errors.js';
import { relogin } from '../domain/credential.js';
import { normalize } from './pipeline.js';

/**
 * 同步引擎。
 *
 * 一次运行的完整流程：
 *
 *   for each 来源平台:
 *     ① 取凭证 + 风控闸门
 *     ② Discover（增量：用本地游标 + 回看窗口）
 *     ③ Dedupe（幂等键：user + platform + activityId）
 *     ④ Fetch（下载文件 → 内容寻址落盘）
 *     ⑤ Normalize（时区 / 坐标系标注 / FIT 摘要）
 *     ⑥ Upsert（活动账本 + 文件记录）
 *
 *   for each 已处理的活动:
 *     for each 目标平台:
 *       ⑦ Upload（必要时格式转换）
 *
 * 引擎不认识任何具体平台 —— 全部差异都在 PlatformAdapter 内。
 */

/** 风控闸门结果（由 server 层提供） */
export interface GateResult {
  allowed: boolean;
  retryAfterMinutes?: number;
  reason?: string;
}

export interface SyncTaskSpec {
  sourcePlatforms: string[];
  targetPlatforms: string[];
  filters: {
    since?: string;
    until?: string;
    sportTypes?: string[];
    keyword?: string;
  };
  policy: {
    incremental: boolean;
    lookbackHours: number;
    maxItemsPerRun: number;
    convertCoordinates: 'auto' | 'always' | 'never';
    adjustTimezone: 'auto' | 'never';
    skipFailedTargets: boolean;
    forceResync: boolean;
  };
}

export interface SyncRunDeps {
  adapters: Map<string, PlatformAdapter>;
  /** 取平台凭证（已解密） */
  credentials: (platformId: string) => Promise<Credential | undefined>;
  files: FileStore;
  store: ActivityStore;
  events: EventSink;
  /** 风控闸门：返回 undefined 表示放行 */
  gate?: (platformId: string, account?: string) => Promise<GateResult | undefined>;
  now?: () => Date;
}

export interface PlatformStat {
  discovered: number;
  downloaded: number;
  skipped: number;
  failed: number;
  uploaded: number;
  uploadFailed: number;
  error?: string;
}

export interface SyncRunSummary {
  runId: string;
  discovered: number;
  downloaded: number;
  skipped: number;
  failed: number;
  uploaded: number;
  uploadFailed: number;
  perPlatform: Record<string, PlatformStat>;
  errors: string[];
}

export const DEFAULT_SYNC_POLICY: SyncTaskSpec['policy'] = {
  incremental: true,
  lookbackHours: 24,
  maxItemsPerRun: 100,
  convertCoordinates: 'auto',
  adjustTimezone: 'auto',
  skipFailedTargets: true,
  forceResync: false,
};

export interface RunSyncOptions {
  task: SyncTaskSpec;
  userId: string;
  deps: SyncRunDeps;
  /** dryRun：只做发现与去重预览，不下载不落库不上传 */
  dryRun?: boolean;
  onProgress?: (p: {
    phase: 'discover' | 'download' | 'upload' | 'done';
    platformId?: string;
    message: string;
    current?: number;
    total?: number;
  }) => void;
}

export async function runSync(opts: RunSyncOptions): Promise<SyncRunSummary> {
  const { task, userId, deps } = opts;
  const now = deps.now?.() ?? new Date();
  const runId = randomUUID();
  const policy = { ...DEFAULT_SYNC_POLICY, ...task.policy };

  const summary: SyncRunSummary = {
    runId,
    discovered: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    uploaded: 0,
    uploadFailed: 0,
    perPlatform: {},
    errors: [],
  };

  /** 本次处理过的活动（用于上传阶段） */
  const processed: { activityId: string; sourcePlatform: string; kind: 'fit' | 'gpx' | 'tcx'; blobKey: string; name: string; startTime?: string; sportType: string; timezoneOffsetMin?: number }[] = [];

  for (const platformId of task.sourcePlatforms) {
    const stat: PlatformStat = {
      discovered: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      uploaded: 0,
      uploadFailed: 0,
    };
    summary.perPlatform[platformId] = stat;

    const adapter = deps.adapters.get(platformId);
    if (!adapter) {
      stat.error = '未知平台: ' + platformId;
      summary.errors.push(platformId + ': ' + stat.error);
      continue;
    }

    const cred = await deps.credentials(platformId);
    if (!cred) {
      stat.error = '平台未连接或凭证已失效';
      summary.errors.push(platformId + ': ' + stat.error);
      await deps.events.emit(userId, {
        level: 'error',
        category: 'auth',
        platformId,
        runId,
        message: platformId + ' 未连接，跳过',
      });
      continue;
    }

    // ① 风控闸门
    const gate = await deps.gate?.(platformId, cred.credentials?.account);
    if (gate && !gate.allowed) {
      stat.error = gate.reason ?? '处于冷却/节流期';
      summary.errors.push(platformId + ': ' + stat.error);
      await deps.events.emit(userId, {
        level: 'warn',
        category: 'platform',
        platformId,
        runId,
        message: platformId + ' 处于冷却/节流期，跳过：' + stat.error,
        data: { retryAfterMinutes: gate.retryAfterMinutes },
      });
      continue;
    }

    // ② Discover
    let cursor: string | undefined;
    if (policy.incremental) {
      const state = await deps.store.getSyncState(userId, platformId);
      cursor = state?.lastCursor;
    }

    let remotes;
    try {
      remotes = await withAuthRetry(
        adapter,
        cred,
        () => adapter.listActivities(cred, { cursor, limit: policy.maxItemsPerRun }),
        deps,
        platformId,
      );
    } catch (err) {
      const e = normalizeError(err, platformId);
      stat.error = e.message;
      summary.errors.push(platformId + ': ' + e.message);
      await deps.events.emit(userId, {
        level: 'error',
        category: 'platform',
        platformId,
        runId,
        message: platformId + ' 拉取活动列表失败：' + e.message,
        data: { code: e.code },
      });
      continue;
    }

    stat.discovered = remotes.items.length;
    summary.discovered += remotes.items.length;
    opts.onProgress?.({
      phase: 'discover',
      platformId,
      message: platformId + ' 发现 ' + remotes.items.length + ' 条活动',
      current: remotes.items.length,
      total: remotes.items.length,
    });

    // ③④⑤⑥ 逐条处理
    for (const remote of remotes.items) {
      if (!passFilters(remote, task.filters)) {
        stat.skipped++;
        summary.skipped++;
        continue;
      }

      const source = {
        platformId,
        activityId: remote.remoteId,
        shortCode: adapter.manifest.shortCode,
      };

      // 去重（幂等键）
      if (!policy.forceResync) {
        const existing = await deps.store.getBySource(userId, source);
        if (existing) {
          stat.skipped++;
          summary.skipped++;
          continue;
        }
      }

      if (opts.dryRun) {
        stat.skipped++;
        summary.skipped++;
        continue;
      }

      try {
        const detail = await withAuthRetry(
          adapter,
          cred,
          async () =>
            adapter.getActivityDetail
              ? adapter.getActivityDetail(cred, remote.remoteId)
              : { ...remote },
          deps,
          platformId,
        );

        const payload = await withAuthRetry(
          adapter,
          cred,
          () => adapter.downloadFile(cred, detail),
          deps,
          platformId,
        );

        const normalized = await normalize(adapter, detail, payload);

        // 文件落盘（内容寻址）
        const stored = await deps.files.put(payload.content);

        const { id } = await deps.store.upsert(userId, {
          source,
          name: normalized.name,
          sportType: normalized.sportType,
          rawSportType: normalized.rawSportType,
          startTime: normalized.startTime,
          timezoneOffsetMin: normalized.timezoneOffsetMin,
          timezoneSource: normalized.timezoneSource,
          durationSec: normalized.durationSec,
          distanceMeters: normalized.distanceMeters,
          elevationGainMeters: normalized.elevationGainMeters,
          metrics: normalized.metrics,
          flags: normalized.flags as never,
          raw: detail.raw,
        });

        await deps.store.addFile(userId, {
          activityId: id,
          kind: payload.sourceKind,
          originalKind: payload.sourceKind,
          blobKey: stored.blobKey,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          coordinateSystem: payload.coordinateSystem ?? adapter.manifest.coordinateSystem,
          derived: false,
        });

        stat.downloaded++;
        summary.downloaded++;
        processed.push({
          activityId: id,
          sourcePlatform: platformId,
          kind: payload.sourceKind,
          blobKey: stored.blobKey,
          name: normalized.name,
          startTime: normalized.startTime,
          sportType: normalized.sportType,
          timezoneOffsetMin: normalized.timezoneOffsetMin,
        });

        opts.onProgress?.({
          phase: 'download',
          platformId,
          message: '已下载 ' + normalized.name,
        });

        await deps.events.emit(userId, {
          level: 'info',
          category: 'sync',
          platformId,
          activityId: id,
          runId,
          message: '已拉取：' + normalized.name,
        });
      } catch (err) {
        const e = normalizeError(err, platformId);
        stat.failed++;
        summary.failed++;
        summary.errors.push(platformId + '/' + remote.remoteId + ': ' + e.message);

        await deps.events.emit(userId, {
          level: e.code === 'RATE_LIMITED' ? 'warn' : 'error',
          category: 'platform',
          platformId,
          runId,
          message: '处理失败：' + e.message,
          data: { code: e.code, remoteId: remote.remoteId },
        });

        if (e.code === 'RATE_LIMITED' || e.code === 'AUTH_EXPIRED') {
          // 触发闸门后该平台不再继续
          break;
        }
      }
    }

    // 更新增量游标
    if (!opts.dryRun && policy.incremental && remotes.cursor) {
      await deps.store.setSyncState(userId, platformId, {
        lastCursor: remotes.cursor,
        lastSyncAt: now.toISOString(),
        lastSuccessAt: stat.failed === 0 ? now.toISOString() : undefined,
        lookbackSec: policy.lookbackHours * 3600,
      });
    }
  }

  // ⑦ 上传阶段
  for (const targetId of task.targetPlatforms) {
    const adapter = deps.adapters.get(targetId);
    if (!adapter) {
      summary.errors.push(targetId + ': 未知平台');
      continue;
    }
    if (!adapter.manifest.capabilities.upload) {
      summary.errors.push(targetId + ': 该平台不支持上传（仅数据源）');
      continue;
    }

    const targetCred = await deps.credentials(targetId);
    if (!targetCred) {
      summary.errors.push(targetId + ': 目标平台未连接');
      continue;
    }

    for (const item of processed) {
      const external = externalIdFor(item);

      if (opts.dryRun) continue;

      try {
        // 目标平台要什么格式
        if (!adapter.manifest.capabilities.uploadFormats.includes(item.kind)) {
          const need = item.kind === 'gpx' ? 'fit' : item.kind;
          const convertible = need === 'fit';
          throw new PlatformError(
            'VALIDATION_FAILED',
            convertible
              ? '目标平台只接受 FIT，源文件是 ' + item.kind.toUpperCase() +
                '，需要 GPX→FIT 转换（M1 能力，尚未实现）'
              : '目标平台不接受 ' + item.kind.toUpperCase() + ' 格式',
            { platformId: targetId },
          );
        }

        const content = await deps.files.get(item.blobKey);
        const result = await withAuthRetry(
          adapter,
          targetCred,
          () =>
            adapter.uploadFile!(
              targetCred,
              { content, kind: item.kind, filename: fileName(item) },
              {
                name: item.name,
                startTime: item.startTime,
                timezoneOffsetMin: item.timezoneOffsetMin,
                sportType: item.sportType,
                externalId: external,
              },
            ),
          deps,
          targetId,
        );

        if (result.status === 'rejected') {
          throw new PlatformError(
            'VALIDATION_FAILED',
            result.message ?? '目标平台拒绝了该文件',
            { platformId: targetId },
          );
        }

        await deps.store.markSynced(userId, item.activityId, targetId, result.remoteId);
        const st = summary.perPlatform[targetId] ??
          (summary.perPlatform[targetId] = {
            discovered: 0, downloaded: 0, skipped: 0, failed: 0, uploaded: 0, uploadFailed: 0,
          });
        st.uploaded++;
        summary.uploaded++;

        await deps.events.emit(userId, {
          level: 'info',
          category: 'sync',
          platformId: targetId,
          activityId: item.activityId,
          runId,
          message: '已上传到 ' + adapter.manifest.displayName + '：' + item.name,
        });
      } catch (err) {
        const e = normalizeError(err, targetId);
        const st = summary.perPlatform[targetId] ??
          (summary.perPlatform[targetId] = {
            discovered: 0, downloaded: 0, skipped: 0, failed: 0, uploaded: 0, uploadFailed: 0,
          });
        st.uploadFailed++;
        summary.uploadFailed++;
        summary.errors.push(targetId + '/' + item.activityId + ': ' + e.message);

        await deps.events.emit(userId, {
          level: 'error',
          category: 'sync',
          platformId: targetId,
          activityId: item.activityId,
          runId,
          message: '上传失败：' + e.message,
          data: { code: e.code },
        });

        if (!policy.skipFailedTargets) break;
      }
    }
  }

  opts.onProgress?.({ phase: 'done', message: '同步完成' });
  return summary;
}

/** 同步明细落库（由 server 层调用） */
export function toSyncItemInput(
  runId: string,
  activityId: string,
  sourcePlatform: string,
  targetPlatform: string,
  status: SyncItemInput['status'],
  extra: Partial<SyncItemInput> = {},
): SyncItemInput {
  return {
    runId,
    activityId,
    sourcePlatform,
    targetPlatform,
    status,
    ...extra,
  };
}

/** 过滤器 */
function passFilters(
  remote: { startTime?: string; sportType?: string; name?: string },
  filters: SyncTaskSpec['filters'],
): boolean {
  if (filters.since && remote.startTime && remote.startTime < filters.since) {
    return false;
  }
  if (filters.until && remote.startTime && remote.startTime > filters.until) {
    return false;
  }
  if (filters.sportTypes?.length) {
    const s = (remote.sportType ?? '').toLowerCase();
    if (!filters.sportTypes.some((f) => s.includes(f.toLowerCase()))) {
      return false;
    }
  }
  if (filters.keyword) {
    const k = filters.keyword.toLowerCase();
    const hay = (remote.name ?? '') + ' ' + (remote.sportType ?? '');
    if (!hay.toLowerCase().includes(k)) return false;
  }
  return true;
}

function externalIdFor(item: {
  sourcePlatform: string;
  activityId: string;
}): string {
  const SHORT: Record<string, string> = {
    otm: 'mg',
    mywhoosh: 'mw',
    strava: 'st',
  };
  return (SHORT[item.sourcePlatform] ?? item.sourcePlatform.slice(0, 2)) +
    item.activityId;
}

function fileName(item: { name: string; kind: string; activityId: string }): string {
  const safe = item.name.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 60);
  return (safe || item.activityId) + '.' + item.kind;
}

/**
 * 带自动重登的调用包装。
 *
 * token 过期（401）→ 用保存的账号密码重新登录 → 重试一次。
 * ★ 绝不无限重试：只重试一次，重登失败就直接抛。
 */
async function withAuthRetry<T>(
  adapter: PlatformAdapter,
  cred: Credential,
  fn: () => Promise<T>,
  deps: SyncRunDeps,
  platformId: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = normalizeError(err, platformId);
    if (e.code !== 'AUTH_EXPIRED') throw e;

    if (!cred.credentials?.account || !cred.credentials?.password) {
      throw e;
    }

    const fresh = await relogin(adapter, cred);
    Object.assign(cred.secret, fresh.secret);
    if (fresh.meta) Object.assign(cred.meta ?? {}, fresh.meta);

    // 只重试一次
    try {
      return await fn();
    } catch (err2) {
      throw normalizeError(err2, platformId);
    }
  }
}
