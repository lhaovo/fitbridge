import { describe, expect, it, beforeEach } from 'vitest';
import { buildSyntheticFit } from '@fitbridge/fitkit/testing';
import {
  PlatformHttpError,
  runSync,
  DEFAULT_SYNC_POLICY,
  type ActivityFileRow,
  type ActivityQuery,
  type ActivityStore,
  type Credential,
  type EventSink,
  type FileStore,
  type PlatformAdapter,
  type SyncEvent,
  type SyncState,
  type UpsertActivityInput,
  type StoredActivity,
} from '../src/index.js';

/* ── 测试替身 ──────────────────────────────────────────── */

class MemStore implements ActivityStore {
  activities = new Map<string, StoredActivity>();
  files: ActivityFileRow[] = [];
  states = new Map<string, SyncState>();
  items: unknown[] = [];

  private key(userId: string, s: { platformId: string; activityId: string }) {
    return userId + '|' + s.platformId + '|' + s.activityId;
  }

  async upsert(userId: string, input: UpsertActivityInput) {
    const k = this.key(userId, input.source);
    const existing = this.activities.get(k);
    if (existing) {
      Object.assign(existing, {
        name: input.name,
        sportType: input.sportType,
        distanceMeters: input.distanceMeters,
        durationSec: input.durationSec,
      });
      return { id: existing.id, created: false };
    }
    const id = 'act-' + (this.activities.size + 1);
    this.activities.set(k, {
      id,
      source: input.source,
      name: input.name,
      sportType: input.sportType,
      rawSportType: input.rawSportType,
      startTime: input.startTime,
      localStartTime: input.localStartTime,
      timezoneOffsetMin: input.timezoneOffsetMin,
      timezoneSource: input.timezoneSource,
      durationSec: input.durationSec,
      distanceMeters: input.distanceMeters,
      elevationGainMeters: input.elevationGainMeters,
      movingTimeSec: input.movingTimeSec,
      metrics: input.metrics,
      flags: input.flags,
      syncState: 'pending',
      syncedTargets: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { id, created: true };
  }

  async getBySource(userId: string, source: { platformId: string; activityId: string; shortCode: string }) {
    return this.activities.get(this.key(userId, source));
  }
  async get(_u: string, id: string) {
    return [...this.activities.values()].find((a) => a.id === id);
  }
  async list(_u: string, _q: ActivityQuery) {
    return { items: [...this.activities.values()], total: this.activities.size };
  }
  async addFile(_u: string, f: { activityId: string; kind: string; blobKey: string; byteSize: number; sha256: string; coordinateSystem: string; derived: boolean }) {
    this.files.push({ ...f, id: 'f' + this.files.length, expired: false, createdAt: new Date().toISOString() } as ActivityFileRow);
  }
  async listFiles(activityId: string) {
    return this.files.filter((f) => f.activityId === activityId);
  }
  runs: Array<{ runId: string; status: string }> = [];

  async createRun(input: { runId: string }) {
    this.runs.push({ runId: input.runId, status: 'running' });
  }
  async finishRun(input: { runId: string; status: string }) {
    const r = this.runs.find((x) => x.runId === input.runId);
    if (r) r.status = input.status;
  }
  async markSynced(
    _u: string,
    activityId: string,
    target: string,
    remoteId?: string,
    runId?: string,
  ) {
    const a = [...this.activities.values()].find((x) => x.id === activityId);
    if (a && !a.syncedTargets.includes(target)) a.syncedTargets.push(target);
    this.items.push({ activityId, target, remoteId, runId });
  }
  async getSyncState(_u: string, platformId: string) {
    return this.states.get(platformId);
  }
  async setSyncState(_u: string, platformId: string, s: Partial<SyncState>) {
    this.states.set(platformId, { platformId, lookbackSec: 86400, ...s });
  }
  async recordSyncItem(i: unknown) {
    this.items.push(i);
  }
  async expireFiles() {
    return [];
  }
}

class MemFiles implements FileStore {
  readonly kind = 'mem';
  blobs = new Map<string, Buffer>();
  async put(content: Buffer) {
    const sha256 = 'sha' + content.length + '-' + this.blobs.size;
    const blobKey = 'sha256/' + sha256;
    this.blobs.set(blobKey, content);
    return { blobKey, sha256, byteSize: content.length };
  }
  async get(k: string) {
    return this.blobs.get(k)!;
  }
  async exists(k: string) {
    return this.blobs.has(k);
  }
  async delete(k: string) {
    this.blobs.delete(k);
  }
}

class MemEvents implements EventSink {
  events: SyncEvent[] = [];
  async emit(_u: string, e: SyncEvent) {
    this.events.push(e);
  }
}

/* ── 假适配器 ──────────────────────────────────────────── */

function manifest(id: string, upload: boolean, formats: Array<'fit' | 'gpx' | 'tcx'>) {
  return {
    id,
    displayName: id.toUpperCase(),
    shortCode: id.slice(0, 2),
    vendor: 'test',
    authType: 'password' as const,
    access: 'reverse-engineered' as const,
    capabilities: {
      download: true,
      upload,
      uploadFormats: formats,
      deleteRemote: false,
      webhook: false,
      incremental: false,
    },
    coordinateSystem: 'wgs84' as const,
    rateLimit: { requestsPerMinute: 60 },
    uploadAsync: false,
    riskLevel: 'low' as const,
  };
}

function makeSource(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    manifest: manifest('src', false, []),
    async auth() {
      return { secret: { token: 't' } };
    },
    async validate() {
      return { ok: true, checkedAt: new Date().toISOString() };
    },
    async listActivities() {
      return {
        items: [
          { remoteId: 'r1', name: '晨骑', startTime: '2026-03-01T02:00:00.000Z', distanceMeters: 25000, durationSec: 3600, sportType: 'cycling' },
          { remoteId: 'r2', name: '午骑', startTime: '2026-03-02T02:00:00.000Z', distanceMeters: 30000, durationSec: 4200, sportType: 'cycling' },
        ],
        hasMore: false,
      };
    },
    async getActivityDetail(_c: Credential, id: string) {
      return { remoteId: id, name: 'act-' + id, startTime: '2026-03-01T02:00:00.000Z' };
    },
    async downloadFile() {
      return {
        content: buildSyntheticFit({
          start: new Date('2026-03-01T02:00:00.000Z'),
          recordCount: 20,
        }),
        contentType: 'application/octet-stream',
        filename: 'a.fit',
        sourceKind: 'fit' as const,
        coordinateSystem: 'wgs84' as const,
      };
    },
    ...overrides,
  } as PlatformAdapter;
}

function makeTarget(uploadFormats: Array<'fit' | 'gpx' | 'tcx'>, result: { status: 'accepted' | 'pending' | 'rejected'; message?: string } = { status: 'accepted' }) {
  const calls: unknown[] = [];
  const adapter: PlatformAdapter = {
    manifest: manifest('dst', true, uploadFormats),
    async auth() {
      return { secret: { token: 't' } };
    },
    async validate() {
      return { ok: true, checkedAt: new Date().toISOString() };
    },
    async listActivities() {
      return { items: [], hasMore: false };
    },
    async downloadFile() {
      throw new Error('not used');
    },
    async uploadFile(_c, file, hint) {
      calls.push({ file, hint });
      return { status: result.status, remoteId: 'remote-1', message: result.message };
    },
  };
  return { adapter, calls };
}

/* ── 测试 ──────────────────────────────────────────────── */

describe('同步引擎', () => {
  let store: MemStore;
  let files: MemFiles;
  let events: MemEvents;

  beforeEach(() => {
    store = new MemStore();
    files = new MemFiles();
    events = new MemEvents();
  });

  const cred: Credential = {
    id: 'c1',
    userId: 'default',
    platformId: 'src',
    secret: { token: 't' },
    credentials: { account: 'demo', password: 'pw' },
  };

  const deps = (adapters: PlatformAdapter[], extra: Partial<Parameters<typeof runSync>[0]['deps']> = {}) => ({
    adapters: new Map(adapters.map((a) => [a.manifest.id, a])),
    credentials: async () => cred,
    files,
    store,
    events,
    ...extra,
  });

  it('发现并落库：下载 → 存 blob → upsert 活动', async () => {
    const src = makeSource();
    const r = await runSync({
      task: { sourcePlatforms: ['src'], targetPlatforms: [], filters: {}, policy: DEFAULT_SYNC_POLICY },
      userId: 'default',
      deps: deps([src]),
    });

    expect(r.discovered).toBe(2);
    expect(r.downloaded).toBe(2);
    expect(r.failed).toBe(0);
    expect(store.activities.size).toBe(2);
    expect(files.blobs.size).toBe(2);
    expect(store.files.length).toBe(2);
  });

  it('幂等：第二次运行全部跳过', async () => {
    const src = makeSource();
    const task = { sourcePlatforms: ['src'], targetPlatforms: [], filters: {}, policy: DEFAULT_SYNC_POLICY };
    await runSync({ task, userId: 'default', deps: deps([src]) });
    const r2 = await runSync({ task, userId: 'default', deps: deps([src]) });

    expect(r2.downloaded).toBe(0);
    expect(r2.skipped).toBe(2);
    expect(store.activities.size).toBe(2);
  });

  it('forceResync 强制重拉', async () => {
    const src = makeSource();
    const task = { sourcePlatforms: ['src'], targetPlatforms: [], filters: {}, policy: { ...DEFAULT_SYNC_POLICY, forceResync: true } };
    await runSync({ task, userId: 'default', deps: deps([src]) });
    const r2 = await runSync({ task, userId: 'default', deps: deps([src]) });
    expect(r2.downloaded).toBe(2);
  });

  it('dryRun 不下载不落库', async () => {
    const src = makeSource();
    const r = await runSync({
      task: { sourcePlatforms: ['src'], targetPlatforms: [], filters: {}, policy: DEFAULT_SYNC_POLICY },
      userId: 'default',
      deps: deps([src]),
      dryRun: true,
    });
    expect(r.discovered).toBe(2);
    expect(r.downloaded).toBe(0);
    expect(store.activities.size).toBe(0);
    expect(files.blobs.size).toBe(0);
  });

  it('上传到目标平台并标记已同步', async () => {
    const src = makeSource();
    const { adapter: dst, calls } = makeTarget(['fit']);
    const r = await runSync({
      task: { sourcePlatforms: ['src'], targetPlatforms: ['dst'], filters: {}, policy: DEFAULT_SYNC_POLICY },
      userId: 'default',
      deps: deps([src, dst]),
    });

    expect(r.uploaded).toBe(2);
    expect(calls.length).toBe(2);
    const a = [...store.activities.values()][0]!;
    expect(a.syncedTargets).toContain('dst');
  });

  it('目标只接受 FIT 而源是 GPX → 明确报错（需 M1 转换）', async () => {
    const src = makeSource({
      async downloadFile() {
        return {
          content: Buffer.from('<?xml version="1.0"?><gpx/>'),
          contentType: 'application/xml',
          filename: 'a.gpx',
          sourceKind: 'gpx' as const,
        };
      },
    } as Partial<PlatformAdapter>);
    const { adapter: dst } = makeTarget(['fit']);
    const r = await runSync({
      task: { sourcePlatforms: ['src'], targetPlatforms: ['dst'], filters: {}, policy: DEFAULT_SYNC_POLICY },
      userId: 'default',
      deps: deps([src, dst]),
    });

    expect(r.uploadFailed).toBe(2);
    expect(r.errors.join(' ')).toContain('GPX→FIT');
  });

  it('目标平台拒绝文件 → 记为失败', async () => {
    const src = makeSource();
    const { adapter: dst } = makeTarget(['fit'], { status: 'rejected', message: '格式不合法' });
    const r = await runSync({
      task: { sourcePlatforms: ['src'], targetPlatforms: ['dst'], filters: {}, policy: DEFAULT_SYNC_POLICY },
      userId: 'default',
      deps: deps([src, dst]),
    });
    expect(r.uploadFailed).toBe(2);
    expect(r.uploaded).toBe(0);
  });

  it('目标平台不支持上传 → 记入 errors 但不影响来源处理', async () => {
    const src = makeSource();
    const noUpload = makeSource();
    noUpload.manifest = manifest('dst2', false, []);
    const r = await runSync({
      task: { sourcePlatforms: ['src'], targetPlatforms: ['dst2'], filters: {}, policy: DEFAULT_SYNC_POLICY },
      userId: 'default',
      deps: deps([src, noUpload]),
    });
    expect(r.downloaded).toBe(2);
    expect(r.errors.join(' ')).toContain('不支持上传');
  });

  it('未连接的平台 → 记入 errors 并跳过', async () => {
    const src = makeSource();
    const r = await runSync({
      task: { sourcePlatforms: ['src'], targetPlatforms: [], filters: {}, policy: DEFAULT_SYNC_POLICY },
      userId: 'default',
      deps: deps([src], { credentials: async () => undefined }),
    });
    expect(r.errors.join(' ')).toContain('未连接');
    expect(r.discovered).toBe(0);
  });

  it('风控闸门拒绝 → 跳过该平台', async () => {
    const src = makeSource();
    const r = await runSync({
      task: { sourcePlatforms: ['src'], targetPlatforms: [], filters: {}, policy: DEFAULT_SYNC_POLICY },
      userId: 'default',
      deps: deps([src], {
        gate: async () => ({ allowed: false, reason: '冷却中', retryAfterMinutes: 30 }),
      }),
    });
    expect(r.discovered).toBe(0);
    expect(r.errors.join(' ')).toContain('冷却');
    expect(events.events.some((e) => e.level === 'warn')).toBe(true);
  });

  it('token 过期 → 自动重新登录并重试一次', async () => {
    let listCalls = 0;
    let authCalls = 0;
    const src: PlatformAdapter = {
      ...makeSource(),
      async auth() {
        authCalls++;
        return { secret: { token: 'fresh' } };
      },
      async listActivities() {
        listCalls++;
        if (listCalls === 1) {
          throw new PlatformHttpError(401, 'HTTP 401 Unauthorized');
        }
        return { items: [{ remoteId: 'r1', name: '晨骑' }], hasMore: false };
      },
    } as PlatformAdapter;

    const r = await runSync({
      task: { sourcePlatforms: ['src'], targetPlatforms: [], filters: {}, policy: DEFAULT_SYNC_POLICY },
      userId: 'default',
      deps: deps([src]),
    });

    expect(authCalls).toBe(1);
    expect(listCalls).toBe(2);
    expect(r.downloaded).toBe(1);
  });

  it('限流 → 该平台停止处理（不继续下一条）', async () => {
    let calls = 0;
    const src: PlatformAdapter = {
      ...makeSource(),
      async listActivities() {
        return {
          items: [
            { remoteId: 'a', name: 'a' },
            { remoteId: 'b', name: 'b' },
            { remoteId: 'c', name: 'c' },
          ],
          hasMore: false,
        };
      },
      async downloadFile() {
        calls++;
        throw new Error('HTTP 429 rate limit exceeded');
      },
    } as PlatformAdapter;

    const r = await runSync({
      task: { sourcePlatforms: ['src'], targetPlatforms: [], filters: {}, policy: DEFAULT_SYNC_POLICY },
      userId: 'default',
      deps: deps([src]),
    });

    expect(calls).toBe(1); // 触发限流后立即停止
    expect(r.failed).toBe(1);
  });

  it('增量游标被记录', async () => {
    const src: PlatformAdapter = {
      ...makeSource(),
      async listActivities() {
        return { items: [{ remoteId: 'r1', name: 'x' }], hasMore: true, cursor: '2' };
      },
    } as PlatformAdapter;
    await runSync({
      task: { sourcePlatforms: ['src'], targetPlatforms: [], filters: {}, policy: DEFAULT_SYNC_POLICY },
      userId: 'default',
      deps: deps([src]),
    });
    expect(store.states.get('src')?.lastCursor).toBe('2');
  });

  it('创建并结束运行记录（sync_items.run_id 外键需要）', async () => {
    const src = makeSource();
    const r = await runSync({
      task: { sourcePlatforms: ['src'], targetPlatforms: [], filters: {}, policy: DEFAULT_SYNC_POLICY },
      userId: 'default',
      deps: deps([src]),
    });
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.runId).toBe(r.runId);
    expect(store.runs[0]!.status).toBe('success');
  });

  it('过滤器：日期范围与关键词', async () => {
    const src = makeSource();
    const r = await runSync({
      task: {
        sourcePlatforms: ['src'],
        targetPlatforms: [],
        filters: { since: '2026-03-02T00:00:00.000Z' },
        policy: DEFAULT_SYNC_POLICY,
      },
      userId: 'default',
      deps: deps([src]),
    });
    expect(r.downloaded).toBe(1);
  });
});

describe('网络抖动重试', () => {
  it('列表请求遇到临时网络错误会自动重试并最终成功', async () => {
    let calls = 0;
    const src: PlatformAdapter = {
      ...makeSource(),
      async listActivities() {
        calls++;
        if (calls < 3) {
          // undici 的典型网络报错：cause.code = ECONNRESET
          const err = new Error('fetch failed') as Error & {
            cause?: { code: string };
          };
          err.cause = { code: 'ECONNRESET' };
          throw err;
        }
        return { items: [], hasMore: false };
      },
    } as PlatformAdapter;

    const summary = await runSync({
      task: {
        sourcePlatforms: ['src'],
        targetPlatforms: [],
        filters: {},
        policy: { ...DEFAULT_SYNC_POLICY },
      },
      userId: 'default',
      deps: {
        adapters: new Map([['src', src]]),
        credentials: async () => ({
          id: 'c1',
          userId: 'default',
          platformId: 'src',
          secret: { token: 't' },
        }),
        files: new MemFiles(),
        store: new MemStore(),
        events: new MemEvents(),
        retryDelaysMs: [1, 1, 1],
      },
    });

    expect(calls).toBe(3);
    expect(summary.errors).toEqual([]);
  }, 20000);

  it('一直失败时不会无限重试（有重试预算）', async () => {
    let calls = 0;
    const src: PlatformAdapter = {
      ...makeSource(),
      async listActivities() {
        calls++;
        const err = new Error('fetch failed') as Error & {
          cause?: { code: string };
        };
        err.cause = { code: 'ECONNRESET' };
        throw err;
      },
    } as PlatformAdapter;

    const summary = await runSync({
      task: {
        sourcePlatforms: ['src'],
        targetPlatforms: [],
        filters: {},
        policy: { ...DEFAULT_SYNC_POLICY },
      },
      userId: 'default',
      deps: {
        adapters: new Map([['src', src]]),
        credentials: async () => ({
          id: 'c1',
          userId: 'default',
          platformId: 'src',
          secret: { token: 't' },
        }),
        files: new MemFiles(),
        store: new MemStore(),
        events: new MemEvents(),
        retryDelaysMs: [1, 1, 1],
      },
    });

    // 首次 + 3 次退避重试
    expect(calls).toBe(4);
    expect(summary.errors.length).toBe(1);
    expect(summary.errors[0]).toContain('src');
  }, 30000);
});

describe('增量：时间回看窗口（不用页码游标）', () => {
  it('把 since 传给适配器（= 上次成功时间 - 回看窗口）', async () => {
    const seen: Array<string | undefined> = [];
    const src: PlatformAdapter = {
      ...makeSource(),
      async listActivities(_c, opts) {
        seen.push(opts?.since);
        return { items: [], hasMore: false };
      },
    } as PlatformAdapter;

    const store2 = new MemStore();
    await store2.setSyncState('default', 'src', {
      lastSuccessAt: '2026-11-20T00:00:00.000Z',
      lookbackSec: 86400,
    });

    await runSync({
      task: {
        sourcePlatforms: ['src'],
        targetPlatforms: [],
        filters: {},
        policy: { ...DEFAULT_SYNC_POLICY, incremental: true, lookbackHours: 24 },
      },
      userId: 'default',
      deps: {
        adapters: new Map([['src', src]]),
        credentials: async () => ({
          id: 'c1',
          userId: 'default',
          platformId: 'src',
          secret: { token: 't' },
        }),
        files: new MemFiles(),
        store: store2,
        events: new MemEvents(),
      },
    });

    expect(seen[0]).toBe('2026-11-19T00:00:00.000Z');
  });

  it('全量重拉（forceResync）时不带 since，拉全量历史', async () => {
    const seen: Array<string | undefined> = [];
    const src: PlatformAdapter = {
      ...makeSource(),
      async listActivities(_c, opts) {
        seen.push(opts?.since);
        return { items: [], hasMore: false };
      },
    } as PlatformAdapter;

    const store2 = new MemStore();
    await store2.setSyncState('default', 'src', {
      lastSuccessAt: '2026-11-20T00:00:00.000Z',
      lookbackSec: 86400,
    });

    await runSync({
      task: {
        sourcePlatforms: ['src'],
        targetPlatforms: [],
        filters: {},
        policy: {
          ...DEFAULT_SYNC_POLICY,
          incremental: true,
          lookbackHours: 24,
          forceResync: true,
        },
      },
      userId: 'default',
      deps: {
        adapters: new Map([['src', src]]),
        credentials: async () => ({
          id: 'c1',
          userId: 'default',
          platformId: 'src',
          secret: { token: 't' },
        }),
        files: new MemFiles(),
        store: store2,
        events: new MemEvents(),
      },
    });

    expect(seen[0]).toBeUndefined();
  });

  it('没有上次同步记录时不传 since（全量）', async () => {
    const seen: Array<string | undefined> = [];
    const src: PlatformAdapter = {
      ...makeSource(),
      async listActivities(_c, opts) {
        seen.push(opts?.since);
        return { items: [], hasMore: false };
      },
    } as PlatformAdapter;

    await runSync({
      task: {
        sourcePlatforms: ['src'],
        targetPlatforms: [],
        filters: {},
        policy: { ...DEFAULT_SYNC_POLICY, incremental: true },
      },
      userId: 'default',
      deps: {
        adapters: new Map([['src', src]]),
        credentials: async () => ({
          id: 'c1',
          userId: 'default',
          platformId: 'src',
          secret: { token: 't' },
        }),
        files: new MemFiles(),
        store: new MemStore(),
        events: new MemEvents(),
      },
    });

    expect(seen[0]).toBeUndefined();
  });
});
