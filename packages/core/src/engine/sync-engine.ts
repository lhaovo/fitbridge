import { randomUUID } from 'node:crypto';
import type {
  Credential,
  PlatformAdapter,
  RemoteActivity,
} from '../ports/adapter.js';
import type {
  ActivityStore,
  EventSink,
  StoredActivity,
  SyncItemInput,
} from '../ports/repository.js';
import type { FileStore } from '../ports/file-store.js';
import { PlatformError, normalizeError } from './errors.js';
import { relogin } from '../domain/credential.js';
import { detail as detailOf, normalize } from './pipeline.js';

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

/**
 * 上传候选（本地库 → 目标平台）。
 *
 * ★ 与「下载去重」是两回事：
 *   下载阶段判的是「本地库有没有这条来源活动」（幂等键 user+platform+activityId）
 *   上传阶段判的是「目标平台有没有这条活动」
 * 两者依据不同，必须分开，否则「本地已有」会把上传整个卡死。
 */
interface UploadCandidate {
  /** 本地库活动 id */
  activityId: string;
  sourcePlatform: string;
  /** 来源平台上的活动 id（用于生成 external_id 幂等键） */
  sourceActivityId: string;
  kind: 'fit' | 'gpx' | 'tcx';
  blobKey: string;
  name: string;
  startTime?: string;
  sportType: string;
  timezoneOffsetMin?: number;
  distanceMeters: number;
  /** 本地记录：这条活动已经同步到过哪些目标平台 */
  syncedTargets: string[];
}

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
    /** 上传后回查目标平台，确认真的入库了（默认开） */
    verifyUpload: boolean;
    /** 回查等待上限（秒） */
    verifyTimeoutSec: number;
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
  /** 网络重试的退避间隔（测试里可以调小，避免等好几秒） */
  retryDelaysMs?: number[];
}

export interface PlatformStat {
  discovered: number;
  downloaded: number;
  /** 下载阶段被跳过（本地库已有该来源活动） */
  skipped: number;
  failed: number;
  uploaded: number;
  /** 上传阶段被跳过（目标平台已经有这条活动） */
  uploadSkipped: number;
  /** 计划上传（dryRun 时 = 预览出来的条数） */
  uploadPlanned: number;
  /** 因条数上限本轮没轮到（下一轮继续） */
  uploadDeferred: number;
  uploadFailed: number;
  error?: string;
}

export interface SyncRunSummary {
  runId: string;
  discovered: number;
  downloaded: number;
  /** 下载阶段跳过 */
  skipped: number;
  failed: number;
  uploaded: number;
  /** 上传阶段跳过 */
  uploadSkipped: number;
  /** 计划上传（dryRun 时 = 预览条数） */
  uploadPlanned: number;
  /** 因条数上限本轮没轮到（下一轮继续） */
  uploadDeferred: number;
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
  // ★ 默认开启上传回查。
  //   有些平台（如迈金）上传接口会返回「成功」但后台其实把文件丢了，
  //   不回查就会出现「显示上传成功、目标平台里啥也没有」的假象。
  verifyUpload: true,
  verifyTimeoutSec: 90,
};

export interface RunSyncOptions {
  task: SyncTaskSpec;
  userId: string;
  deps: SyncRunDeps;
  /** 触发来源 */
  trigger?: 'manual' | 'schedule' | 'webhook' | 'api';
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
    uploadSkipped: 0,
    uploadPlanned: 0,
    uploadDeferred: 0,
    uploadFailed: 0,
    perPlatform: {},
    errors: [],
  };

  // 登记本次运行（sync_items.run_id 有外键，必须先有 run 行）
  await deps.store.createRun({
    runId,
    userId,
    trigger: opts.trigger ?? 'manual',
  });

  /**
   * 网络重试预算（整轮共享）。
   * 没有预算的话，「平台每个活动都 500」会把一轮同步拖成十几分钟。
   */
  const transientBudget = { left: TRANSIENT_RETRY_BUDGET };
  const retryDelays = deps.retryDelaysMs ?? TRANSIENT_RETRY_DELAYS_MS;

  /**
   * 上传候选集。
   *
   * 包含两部分：
   *   ① 本轮新下载的活动
   *   ② 本地库已有、但本轮没有重新下载的活动（★ 上传的关键）
   */
  const candidates: UploadCandidate[] = [];
  /** 已经进候选集的活动 id，避免重复 */
  const candidateIds = new Set<string>();

  for (const platformId of task.sourcePlatforms) {
    const stat: PlatformStat = {
      discovered: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      uploaded: 0,
      uploadSkipped: 0,
      uploadPlanned: 0,
      uploadDeferred: 0,
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
    //
    // 增量方式：**时间回看窗口**，不用页码游标。
    //   since = 上次成功时间 - lookbackHours
    // 平台列表是时间倒序的，适配器遇到早于 since 的就停止翻页。
    // 回看窗口用来覆盖「平台延迟入库」和「上次同步中途失败」。
    let since: string | undefined;
    // 全量重拉：连列表窗口也不限制，否则「全量」只是把窗口内的活动重下一遍
    if (policy.incremental && !policy.forceResync) {
      const state = await deps.store.getSyncState(userId, platformId);
      if (state?.lastSuccessAt) {
        const lookbackMs = policy.lookbackHours * 3600 * 1000;
        since = new Date(
          Date.parse(state.lastSuccessAt) - lookbackMs,
        ).toISOString();
      }
    }

    let remotes;
    try {
      remotes = await withAuthRetry(
        adapter,
        cred,
        () =>
          adapter.listActivities(cred, {
            since,
            limit: policy.maxItemsPerRun,
          }),
        deps,
        platformId,
        userId,
        transientBudget,
        retryDelays,
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

      // 去重（幂等键）—— **只针对下载这一段**
      //
      // ★ 本地库已有 ≠ 不该上传。
      //   「下载」是 源平台 → 本地库，幂等键是 user+platform+activityId；
      //   「上传」是 本地库 → 目标平台，判重依据是**目标平台有没有这条活动**。
      //   早先把两者混在一起：本地已有 → 直接 skip → 上传阶段永远收不到这条，
      //   于是「同时上传到目标平台」在本地库有数据时一条也传不出去。
      //   现在：跳过下载，但把它收进上传候选集，交给上传阶段按目标侧判重。
      if (!policy.forceResync) {
        const existing = await deps.store.getBySource(userId, source);
        if (existing) {
          stat.skipped++;
          summary.skipped++;
          if (task.targetPlatforms.length > 0) {
            const c = await candidateFromStored(deps.store, existing);
            if (c && !candidateIds.has(c.activityId)) {
              candidates.push(c);
              candidateIds.add(c.activityId);
            }
          }
          continue;
        }
      }

      if (opts.dryRun) {
        stat.skipped++;
        summary.skipped++;
        // 预览：还没进本地库的活动也算进上传候选，
        // 否则「预览」会低估「会传多少条到目标平台」。
        // 预览阶段不下载，用列表里的时间/距离做判重即可。
        if (task.targetPlatforms.length > 0) {
          const key = 'remote:' + platformId + ':' + remote.remoteId;
          if (!candidateIds.has(key)) {
            candidates.push({
              activityId: key,
              sourcePlatform: platformId,
              sourceActivityId: remote.remoteId,
              kind: 'fit',
              blobKey: '',
              name: remote.name ?? adapter.manifest.displayName,
              startTime: remote.startTime,
              sportType: remote.sportType ?? 'other',
              timezoneOffsetMin: remote.timezoneOffset,
              distanceMeters: remote.distanceMeters ?? 0,
              syncedTargets: [],
            });
            candidateIds.add(key);
          }
        }
        continue;
      }

      try {
        // ★ 用 pipeline 的 detail()，它会把列表项与详情合并（保留 raw）
        //   直接调 adapter.getActivityDetail 会丢掉列表项里的 raw，
        //   导致 MyWhoosh 的 activityFileId 丢失。
        const detail = await withAuthRetry(
          adapter,
          cred,
          async () => detailOf(adapter, cred, remote),
          deps,
          platformId,
          userId,
          transientBudget,
          retryDelays,
        );

        const payload = await withAuthRetry(
          adapter,
          cred,
          () => adapter.downloadFile(cred, detail),
          deps,
          platformId,
          userId,
          transientBudget,
          retryDelays,
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
          localStartTime: normalized.localStartTime,
          timezoneOffsetMin: normalized.timezoneOffsetMin,
          timezoneSource: normalized.timezoneSource,
          durationSec: normalized.durationSec,
          movingTimeSec: normalized.movingTimeSec,
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
        if (!candidateIds.has(id)) {
          candidates.push({
            activityId: id,
            sourcePlatform: platformId,
            sourceActivityId: remote.remoteId,
            kind: payload.sourceKind,
            blobKey: stored.blobKey,
            name: normalized.name,
            startTime: normalized.startTime,
            sportType: normalized.sportType,
            timezoneOffsetMin: normalized.timezoneOffsetMin,
            distanceMeters: normalized.distanceMeters,
            syncedTargets: [],
          });
          candidateIds.add(id);
        }

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

    // 更新增量状态（时间为准；lastCursor 保留给未来支持真游标的平台）
    if (!opts.dryRun) {
      await deps.store.setSyncState(userId, platformId, {
        lastSyncAt: now.toISOString(),
        lastSuccessAt: stat.failed === 0 ? now.toISOString() : undefined,
        lookbackSec: policy.lookbackHours * 3600,
        ...(remotes.cursor ? { lastCursor: remotes.cursor } : {}),
      });
    }
  }

  // ★ 把「本地库已有、但本轮没有重新下载」的活动也纳入上传候选。
  //
  //   这是「同时上传到目标平台」能真正跑起来的关键：
  //   候选集 = 本地库中「来源平台 ∈ 本次选择」的活动（受过滤器约束）
  //   否则本地库里已有的活动永远进不了上传阶段。
  if (task.targetPlatforms.length > 0) {
    for (const platformId of task.sourcePlatforms) {
      const local = await deps.store.list(userId, {
        userId,
        sourcePlatform: [platformId],
        limit: Math.max(policy.maxItemsPerRun * 4, 200),
        offset: 0,
        sort: 'start_time',
        order: 'desc',
      });
      for (const a of local.items) {
        if (candidateIds.has(a.id)) continue;
        if (!passFilters(a, task.filters)) continue;
        const c = await candidateFromStored(deps.store, a);
        if (c) {
          candidates.push(c);
          candidateIds.add(c.activityId);
        }
      }
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

    // ★ 目标平台现有活动：用于判重。每个目标只拉一次。
    //   拉不到就把判重关掉继续上传（宁可重复，也不要漏传）。
    let targetRemotes: RemoteActivity[] = [];
    if (!policy.forceResync) {
      try {
        const page = await withAuthRetry(
          adapter,
          targetCred,
          () =>
            adapter.listActivities(targetCred, {
              limit: TARGET_EXISTENCE_LIMIT,
            }),
          deps,
          targetId,
          userId,
          transientBudget,
          retryDelays,
        );
        targetRemotes = page.items;
      } catch (err) {
        const e = normalizeError(err, targetId);
        summary.errors.push(
          targetId + ': 读取目标平台活动列表失败，无法判重：' + e.message,
        );
        await deps.events.emit(userId, {
          level: 'warn',
          category: 'platform',
          platformId: targetId,
          runId,
          message: '无法读取目标平台活动列表，本次上传不做重复检查：' + e.message,
          data: { code: e.code },
        });
      }
    }

    const st = summary.perPlatform[targetId] ??
      (summary.perPlatform[targetId] = {
        discovered: 0, downloaded: 0, skipped: 0, failed: 0,
        uploaded: 0, uploadSkipped: 0, uploadPlanned: 0,
        uploadDeferred: 0, uploadFailed: 0,
      });

    // ── 上传判重（两层）────────────────────────────────────
    //   ① 本地记录：这条活动已经同步到过该目标 → 跳过
    //   ② 目标平台列表：软匹配到同一条（时间 + 距离）→ 跳过
    //
    // ★ 判重依据是「目标平台有没有」，与本地库存不存在无关。
    //   这正是把下载去重和上传去重分开的关键。
    const pending: UploadCandidate[] = [];
    for (const item of candidates) {
      if (!policy.forceResync) {
        if (item.syncedTargets.includes(targetId)) {
          st.uploadSkipped++;
          summary.uploadSkipped++;
          continue;
        }
        const dup = targetRemotes.find((r) => isSameActivity(item, r));
        if (dup) {
          st.uploadSkipped++;
          summary.uploadSkipped++;
          await deps.events.emit(userId, {
            level: 'info',
            category: 'sync',
            platformId: targetId,
            activityId: item.activityId,
            runId,
            message: '跳过（目标平台已有相同活动）：' + item.name,
            data: { targetRemoteId: dup.remoteId },
          });
          continue;
        }
      }
      pending.push(item);
    }

    // 条数上限：**在判重之后**才截断。
    //   否则「已被目标判定为重复」和「已同步过」的老活动会一直占着名额，
    //   真正没传过的新活动反而永远轮不到（每轮都在同一批里打转）。
    //   判重在前 → 每轮都会往前推进一批。
    pending.sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''));
    const batch = pending.slice(0, Math.max(policy.maxItemsPerRun, 0));
    const deferred = pending.length - batch.length;
    if (deferred > 0) {
      st.uploadDeferred += deferred;
      summary.uploadDeferred += deferred;
    }
    st.uploadPlanned += batch.length;
    summary.uploadPlanned += batch.length;

    /** 本轮提交成功、等待回查确认入库的 */
    const uploaded: { item: UploadCandidate; result: { remoteId?: string } }[] = [];

    for (const item of batch) {
      const external = externalIdFor({
        sourcePlatform: item.sourcePlatform,
        activityId: item.sourceActivityId,
      });

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
              {
                content,
                kind: item.kind,
                filename: fileName({
                  name: item.name,
                  kind: item.kind,
                  activityId: item.sourceActivityId,
                }),
              },
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

        // ★ 先记下来，等回查确认入库后再 markSynced。
        //   有些平台上传接口返回成功但后台把文件丢了（迈金实测如此），
        //   先 markSynced 会把「没传成功」记成「已同步」，后面再也不会重传。
        uploaded.push({ item, result });

        await deps.events.emit(userId, {
          level: 'info',
          category: 'sync',
          platformId: targetId,
          activityId: item.activityId,
          runId,
          message:
            '已提交到 ' + adapter.manifest.displayName + '（待回查确认入库）：' + item.name,
        });
      } catch (err) {
        const e = normalizeError(err, targetId);
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

    // ── 回查确认入库 ─────────────────────────────────────
    //
    // ★ 上传接口返回「成功」不代表数据真的进了目标平台。
    //   实测：迈金 upload/fit 返回 {"success_count":1}、HTTP 200，
    //   但十几分钟后活动列表里依然没有这条活动（平台后台把文件丢了）。
    //   所以这里回查目标平台的列表，逐条确认；
    //   没出现的记为上传失败（而不是假装成功），下一轮还能重传。
    if (uploaded.length > 0) {
      const appeared = policy.verifyUpload
        ? await verifyUploaded(
            adapter,
            targetCred,
            uploaded.map((u) => u.item),
            deps,
            targetId,
            userId,
            transientBudget,
            retryDelays,
            policy.verifyTimeoutSec,
          )
        : new Set(uploaded.map((u) => u.item.activityId));

      for (const u of uploaded) {
        if (appeared.has(u.item.activityId)) {
          await deps.store.markSynced(
            userId,
            u.item.activityId,
            targetId,
            u.result.remoteId,
            runId,
          );
          st.uploaded++;
          summary.uploaded++;
          await deps.events.emit(userId, {
            level: 'info',
            category: 'sync',
            platformId: targetId,
            activityId: u.item.activityId,
            runId,
            message:
              '已上传到 ' + adapter.manifest.displayName + '（已确认入库）：' + u.item.name,
          });
        } else {
          st.uploadFailed++;
          summary.uploadFailed++;
          const msg =
            '上传未确认入库：上传接口已受理，但等待 ' + policy.verifyTimeoutSec +
            ' 秒后目标平台列表里仍没有这条活动 —— ' +
            '该平台会静默丢弃这类文件（迈金实测如此），可稍后重试或换个目标平台';
          summary.errors.push(targetId + '/' + u.item.activityId + ': ' + msg);
          await deps.events.emit(userId, {
            level: 'error',
            category: 'sync',
            platformId: targetId,
            activityId: u.item.activityId,
            runId,
            message: '上传未确认入库：' + u.item.name + ' —— ' + msg,
          });
        }
      }
    }
  }

  // 结束运行记录
  const runStatus =
    summary.failed === 0 && summary.uploadFailed === 0
      ? 'success'
      : summary.downloaded > 0 || summary.uploaded > 0
        ? 'partial'
        : 'failed';
  await deps.store.finishRun({
    runId,
    status: runStatus,
    stats: {
      discovered: summary.discovered,
      downloaded: summary.downloaded,
      skipped: summary.skipped,
      failed: summary.failed,
      uploaded: summary.uploaded,
      uploadSkipped: summary.uploadSkipped,
      uploadPlanned: summary.uploadPlanned,
      uploadDeferred: summary.uploadDeferred,
      uploadFailed: summary.uploadFailed,
    },
    error: summary.errors.length ? summary.errors.join('; ') : undefined,
  });

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

/**
 * 把本地库里的一条活动转成上传候选。
 *
 * 找不到可用文件（比如文件已过期被清理）时返回 undefined —— 那样这条活动
 * 就没法上传了，但**不应该**让它把整轮同步带崩。
 */
async function candidateFromStored(
  store: ActivityStore,
  a: StoredActivity,
): Promise<UploadCandidate | undefined> {
  const files = await store.listFiles(a.id);
  const alive = files.filter((f) => !f.expired);
  const f = alive.find((x) => !x.derived) ?? alive[0];
  if (!f) return undefined;
  return {
    activityId: a.id,
    sourcePlatform: a.source.platformId,
    sourceActivityId: a.source.activityId,
    kind: f.kind === 'converted-fit' ? 'fit' : f.kind,
    blobKey: f.blobKey,
    name: a.name,
    startTime: a.startTime,
    sportType: a.sportType,
    timezoneOffsetMin: a.timezoneOffsetMin,
    distanceMeters: a.distanceMeters,
    syncedTargets: a.syncedTargets ?? [],
  };
}

/**
 * 回查目标平台，确认这批活动真的入库了。
 *
 * 轮询目标平台的活动列表，按「时间 + 距离」软匹配逐条确认。
 * 返回已确认入库的活动 id 集合。
 */
async function verifyUploaded(
  adapter: PlatformAdapter,
  cred: Credential,
  items: UploadCandidate[],
  deps: SyncRunDeps,
  platformId: string,
  userId: string,
  budget?: { left: number },
  delaysMs?: number[],
  timeoutSec = 90,
): Promise<Set<string>> {
  const appeared = new Set<string>();
  const pending = [...items];
  const deadline = Date.now() + timeoutSec * 1000;
  const intervalMs = 10_000;

  while (pending.length > 0) {
    let remotes: RemoteActivity[] = [];
    try {
      const page = await withAuthRetry(
        adapter,
        cred,
        () => adapter.listActivities(cred, { limit: TARGET_EXISTENCE_LIMIT }),
        deps,
        platformId,
        userId,
        budget,
        delaysMs,
      );
      remotes = page.items;
    } catch (err) {
      const e = normalizeError(err, platformId);
      // 回查失败 ≠ 上传失败：平台可能只是暂时查不到。
      // 这里保守处理：查不到就认为还没入库，但不清空已确认的。
      await deps.events.emit(userId, {
        level: 'warn',
        category: 'platform',
        platformId,
        message: '回查目标平台列表失败（暂无法确认入库）：' + e.message,
        data: { code: e.code },
      });
      break;
    }

    for (let i = pending.length - 1; i >= 0; i--) {
      const it = pending[i]!;
      if (remotes.some((r) => isSameActivity(it, r))) {
        appeared.add(it.activityId);
        pending.splice(i, 1);
      }
    }

    if (pending.length === 0) break;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }

  return appeared;
}

/**
 * 判断「目标平台上这条」是不是就是「本地库这条」。
 *
 * 软匹配：开始时间 + 距离。
 *   - 时间容差 10 分钟：平台入库时间可能有几十秒到几分钟的偏差
 *   - 距离容差 max(2%, 100m)：两边距离精度不一样
 *
 * ★ 缺时间 → 一律判为「不是同一条」（宁可重复上传，也不要漏传）。
 *   重复上传目标平台一般能接受（用户可删），漏传则数据永远少一条。
 */
export function isSameActivity(
  a: { startTime?: string; distanceMeters?: number },
  b: { startTime?: string; distanceMeters?: number },
): boolean {
  if (!a.startTime || !b.startTime) return false;
  const ta = Date.parse(a.startTime);
  const tb = Date.parse(b.startTime);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  if (Math.abs(ta - tb) > MATCH_TIME_TOLERANCE_MS) return false;

  if (a.distanceMeters && b.distanceMeters) {
    const tol = Math.max(a.distanceMeters * 0.02, MATCH_DISTANCE_TOLERANCE_M);
    if (Math.abs(a.distanceMeters - b.distanceMeters) > tol) return false;
  }
  return true;
}

/** 判重时拉取目标平台多少条活动 */
const TARGET_EXISTENCE_LIMIT = 200;

/** 判重时间容差（毫秒） */
const MATCH_TIME_TOLERANCE_MS = 10 * 60 * 1000;

/** 判重距离容差（米） */
const MATCH_DISTANCE_TOLERANCE_M = 100;

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
 * 网络抖动重试的退避间隔（毫秒）。
 *
 * 实测遇到过平台 API 域名被出口网络/代理间歇性拦截（TCP 连不上），
 * 立刻重试大概率还是失败，等一下再试成功率明显更高。
 */
const TRANSIENT_RETRY_DELAYS_MS = [1500, 4000, 8000];

/** 一轮同步里最多允许多少次网络重试 */
const TRANSIENT_RETRY_BUDGET = 12;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带自动重登的调用包装。
 *
 * - token 过期（401）→ 用保存的账号密码重新登录 → 重试一次
 *   （★ 绝不无限重试：只重登一次，重登失败就直接抛）
 * - 网络抖动 / 5xx → 退避后重试（整轮共享预算，避免拖死整轮同步）
 */
async function withAuthRetry<T>(
  adapter: PlatformAdapter,
  cred: Credential,
  fn: () => Promise<T>,
  deps: SyncRunDeps,
  platformId: string,
  userId?: string,
  budget?: { left: number },
  delaysMs?: number[],
): Promise<T> {
  let transientAttempt = 0;
  let reloginUsed = false;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const e = normalizeError(err, platformId);

      // ① 网络抖动 / 5xx：退避后重试
      const delays = delaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
      if (
        e.code === 'TRANSIENT' &&
        transientAttempt < delays.length &&
        (budget ? budget.left > 0 : true)
      ) {
        const delay = delays[transientAttempt]!;
        transientAttempt++;
        if (budget) budget.left--;
        if (userId) {
          await deps.events.emit(userId, {
            level: 'warn',
            category: 'platform',
            platformId,
            message:
              `${platformId} 请求失败，${Math.round(delay / 1000)} 秒后重试 ` +
              `(${transientAttempt}/${delays.length})：${e.message}`,
            data: { code: e.code, delayMs: delay },
          });
        }
        await sleep(delay);
        continue;
      }

      // ② token 过期：重新登录后重试一次
      if (e.code !== 'AUTH_EXPIRED' || reloginUsed) throw e;

      if (!cred.credentials?.account || !cred.credentials?.password) {
        throw e;
      }
      reloginUsed = true;

      const fresh = await relogin(adapter, cred);
      Object.assign(cred.secret, fresh.secret);
      if (fresh.meta) Object.assign(cred.meta ?? {}, fresh.meta);
      // 重新登录后继续循环（这次 fn 会用新 token 再跑一遍）
    }
  }
}
