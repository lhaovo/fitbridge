import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildSyntheticFit } from '@fitbridge/fitkit/testing';
import { MyWhooshAdapter } from '../src/index.js';
import { extractList } from '../src/activities.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockJson(body: unknown, status = 200) {
  vi.stubGlobal('fetch', async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('MyWhoosh 响应容器兼容', () => {
  it('兼容多种响应容器形态', () => {
    expect(extractList({ data: { results: [{ id: 1 }] } })).toHaveLength(1);
    expect(extractList({ data: [{ id: 1 }] })).toHaveLength(1);
    expect(extractList({ activities: [{ id: 1 }] })).toHaveLength(1);
    expect(extractList({ results: [{ id: 1 }] })).toHaveLength(1);
    expect(extractList({ rides: [{ id: 1 }] })).toHaveLength(1);
    expect(extractList({ rideHistory: [{ id: 1 }] })).toHaveLength(1);
    expect(extractList({ foo: 1 })).toEqual([]);
    expect(extractList(null)).toEqual([]);
  });
});

describe('MyWhoosh 登录与列表', () => {
  it('登录请求体形状正确', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          Success: true,
          AccessToken: 'mw-token',
          WhooshId: 'whoosh-1',
          RefreshToken: 'mw-refresh',
        }),
        { status: 200 },
      );
    });

    const adapter = new MyWhooshAdapter();
    const out = await adapter.auth({ account: 'demo', password: 'pw' });

    expect(out.secret.accessToken).toBe('mw-token');
    expect(out.meta?.whooshId).toBe('whoosh-1');

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.Username).toBe('demo');
    expect(body.Password).toBe('pw');
    expect(body.Platform).toBe('Android');
    expect(body.Action).toBe(1001);
    expect(body.CorrelationId).toBeTruthy();
    expect(body.DeviceId).toBeTruthy();
  });

  it('Success=false 时抛错', async () => {
    mockJson({ Success: false, Message: '账号不存在' });
    const adapter = new MyWhooshAdapter();
    await expect(adapter.auth({ account: 'a', password: 'b' })).rejects.toThrow(
      /账号不存在/,
    );
  });

  it('列表把 distanceKm 换算成米', async () => {
    mockJson({
      data: {
        results: [
          {
            id: 'abc',
            name: 'Morning ride',
            activityFileId: 'file-1',
            date: '2026-03-15T06:30:00Z',
            distanceKm: 12.5,
            duration: 1800,
          },
        ],
      },
    });

    const adapter = new MyWhooshAdapter();
    const page = await adapter.listActivities({
      id: 'c1',
      userId: 'u1',
      platformId: 'mywhoosh',
      secret: { accessToken: 'mw-token' },
      meta: { whooshId: 'whoosh-1' },
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.remoteId).toBe('abc');
    expect(page.items[0]!.distanceMeters).toBe(12500);
    expect(page.items[0]!.durationSec).toBe(1800);
    expect(page.items[0]!.name).toBe('Morning ride');
  });

  it('401 时抛错', async () => {
    mockJson({ message: 'expired' }, 401);
    const adapter = new MyWhooshAdapter();
    await expect(
      adapter.listActivities({
        id: 'c1',
        userId: 'u1',
        platformId: 'mywhoosh',
        secret: { accessToken: 'bad' },
      }),
    ).rejects.toThrow(/401/);
  });
});

describe('MyWhoosh 下载路径（回归锁定）', () => {
  it('必须是 /v2/rider/profile/download-activity-file，不能多一段 /activities', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('download-activity-file')) {
        return new Response(
          JSON.stringify({
            error: false,
            code: 200,
            data: 'https://mywhooshprod.s3.eu-west-1.amazonaws.com/ride/x/activity.fit',
          }),
          { status: 200 },
        );
      }
      if (u.includes('/activities')) {
        return new Response(
          JSON.stringify({
            data: {
              results: [
                {
                  id: 'abc',
                  name: 'Morning ride',
                  activityFileId: 'file-123',
                  date: '2026-11-21T05:03:35.000Z',
                  distance: 36.91,
                  rideDuration: '02:35:30.000',
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      // 第二步：返回真实的 FIT 字节
      return new Response(
        buildSyntheticFit({
          start: new Date('2026-11-21T05:03:35.000Z'),
          recordCount: 10,
        }) as unknown as BodyInit,
        { status: 200 },
      );
    });

    const adapter = new MyWhooshAdapter();
    const listed = await adapter.listActivities({
      id: 'c1',
      userId: 'u1',
      platformId: 'mywhoosh',
      secret: { accessToken: 'mw-token' },
      meta: { whooshId: 'whoosh-1' },
    });
    const raw = listed.items[0]?.raw as { activityFileId?: string } | undefined;

    const payload = await adapter.downloadFile(
      {
        id: 'c1',
        userId: 'u1',
        platformId: 'mywhoosh',
        secret: { accessToken: 'mw-token' },
        meta: { whooshId: 'whoosh-1' },
      },
      {
        remoteId: 'abc',
        fileId: raw?.activityFileId,
        raw: listed.items[0]?.raw,
      },
    );

    const dlCall = calls.find((c) => c.includes('download-activity-file'));
    expect(dlCall).toBe(
      'https://service14.mywhoosh.com/v2/rider/profile/download-activity-file',
    );
    expect(dlCall).not.toContain('/activities/download-activity-file');
    expect(payload.sourceKind).toBe('fit');
  });
});
