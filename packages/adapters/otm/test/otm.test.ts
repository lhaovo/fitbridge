import { describe, expect, it, vi, afterEach } from 'vitest';
import { OtmAdapter } from '../src/index.js';
import { md5 } from '../src/auth.js';

const BASE = 'https://otm.onelap.cn';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function mockJson(
  body: unknown,
  status = 200,
  calls?: FetchCall[],
) {
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
    calls?.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('迈金登录', () => {
  it('密码用 MD5 传输', () => {
    expect(md5('123456')).toBe('e10adc3949ba59abbe56e057f20f883e');
  });

  it('请求体形状正确：account + MD5(password)', async () => {
    const calls: FetchCall[] = [];
    mockJson(
      { code: 200, data: [{ token: 'jwt-token', refresh_token: 'refresh-1' }] },
      200,
      calls,
    );

    const adapter = new OtmAdapter();
    const out = await adapter.auth({ account: 'demo', password: '123456' });

    expect(out.secret.token).toBe('jwt-token');
    expect(out.secret.refreshToken).toBe('refresh-1');

    const call = calls[0]!;
    expect(call.url).toBe(BASE + '/api/login');
    const body = JSON.parse(String(call.init.body));
    expect(body.account).toBe('demo');
    expect(body.password).toBe(md5('123456'));
    expect(body.password).not.toBe('123456');
  });

  it('登录失败时抛错', async () => {
    mockJson({ code: 401, message: '账号或密码错误' });
    const adapter = new OtmAdapter();
    await expect(adapter.auth({ account: 'a', password: 'b' })).rejects.toThrow();
  });
});

describe('迈金活动列表', () => {
  it('解析 list 与 pagination.has_more', async () => {
    mockJson({
      code: 200,
      data: {
        list: [
          {
            id: 101,
            title: '晨骑',
            distance: 25000,
            ridingTime: 3600,
            startTime: 1773553800000,
          },
          { id: 102, title: '午骑', distance: 30000, ridingTime: 4200 },
        ],
        pagination: { has_more: true },
      },
    });

    const adapter = new OtmAdapter();
    const page = await adapter.listActivities(
      {
        id: 'c1',
        userId: 'u1',
        platformId: 'otm',
        secret: { token: 'jwt-token' },
      },
      { limit: 2 },
    );

    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.remoteId).toBe('101');
    expect(page.items[0]!.name).toBe('晨骑');
    expect(page.items[0]!.distanceMeters).toBe(25000);
    expect(page.items[0]!.durationSec).toBe(3600);
    expect(page.hasMore).toBe(true);
    // ★ 不再返回页码游标（页码含义会随 limit 漂移），增量改用时间回看窗口
    expect(page.cursor).toBeUndefined();
  });

  it('增量：since 之后遇到更早的活动就停止翻页', async () => {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      const body = JSON.parse(String(init.body));
      // 第 1 页：一条新的 + 一条旧的（早于 since）
      const list =
        body.page === 1
          ? [
              { id: 900, title: '新', distance_km: 10, time_seconds: 600, start_riding_time: '2026-11-21 10:00:00' },
              { id: 800, title: '旧', distance_km: 20, time_seconds: 900, start_riding_time: '2026-01-01 10:00:00' },
            ]
          : [];
      return new Response(
        JSON.stringify({ code: 200, data: { list, pagination: { has_more: true } } }),
        { status: 200 },
      );
    });

    const adapter = new OtmAdapter();
    const page = await adapter.listActivities(
      {
        id: 'c1',
        userId: 'u1',
        platformId: 'otm',
        secret: { token: 'jwt-token' },
      },
      { limit: 50, since: '2026-11-01T00:00:00.000Z' },
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.remoteId).toBe('900');
    // 只请求了第 1 页，没有继续翻页
    expect(calls.length).toBe(1);
    expect(page.hasMore).toBe(false);
  });

  it('距离是公里不是米', async () => {
    mockJson({
      code: 200,
      data: {
        list: [{ id: 1, distance_km: 36.91, time_seconds: 9330, start_riding_time: '2026-11-21 13:03:35' }],
        pagination: {},
      },
    });
    const adapter = new OtmAdapter();
    const page = await adapter.listActivities(
      { id: 'c1', userId: 'u1', platformId: 'otm', secret: { token: 't' } },
      { limit: 10 },
    );
    expect(page.items[0]!.distanceMeters).toBeCloseTo(36910, 0);
    expect(page.items[0]!.durationSec).toBe(9330);
    expect(page.items[0]!.startTime).toBe('2026-11-21T05:03:35.000Z');
  });

  it('带 Authorization 头', async () => {
    const calls: FetchCall[] = [];
    mockJson({ code: 200, data: { list: [], pagination: {} } }, 200, calls);

    const adapter = new OtmAdapter();
    await adapter.listActivities({
      id: 'c1',
      userId: 'u1',
      platformId: 'otm',
      secret: { token: 'jwt-token' },
    });

    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('Authorization')).toBe('jwt-token');
  });
});

describe('迈金上传', () => {
  it('multipart 字段名必须是 jilu0（网页 JS 用的是 jilu）', async () => {
    const calls: FetchCall[] = [];
    mockJson({ code: 200, data: { success_count: 1 } }, 200, calls);

    const adapter = new OtmAdapter();
    const result = await adapter.uploadFile!(
      {
        id: 'c1',
        userId: 'u1',
        platformId: 'otm',
        secret: { token: 'jwt-token' },
      },
      { content: Buffer.from([1, 2, 3]), kind: 'fit', filename: 'a.fit' },
      { name: '晨骑', sportType: 'ride', externalId: 'mg101' },
    );

    expect(result.status).toBe('pending');

    const call = calls[0]!;
    expect(call.url).toBe(BASE + '/api/otm/ride_record/upload/fit');

    const form = call.init.body as FormData;
    const names = [...form.keys()];
    expect(names).toContain('jilu0');
    expect(names).not.toContain('jilu');

    const headers = new Headers(call.init.headers);
    expect(headers.get('Authorization')).toBe('jwt-token');
    expect(headers.get('Origin')).toBe(BASE);
  });

  it('GPX 被拒绝（迈金只接受 FIT）', async () => {
    const adapter = new OtmAdapter();
    const result = await adapter.uploadFile!(
      {
        id: 'c1',
        userId: 'u1',
        platformId: 'otm',
        secret: { token: 'jwt-token' },
      },
      { content: Buffer.from('gpx'), kind: 'gpx', filename: 'a.gpx' },
      { name: 'x', sportType: 'ride', externalId: 'mg101' },
    );
    expect(result.status).toBe('rejected');
  });

  it('success_count 为 0 时视为拒绝', async () => {
    mockJson({ code: 200, data: { success_count: 0 } });
    const adapter = new OtmAdapter();
    const result = await adapter.uploadFile!(
      {
        id: 'c1',
        userId: 'u1',
        platformId: 'otm',
        secret: { token: 'jwt-token' },
      },
      { content: Buffer.from([1]), kind: 'fit', filename: 'a.fit' },
      { name: 'x', sportType: 'ride', externalId: 'mg101' },
    );
    expect(result.status).toBe('rejected');
  });
});
