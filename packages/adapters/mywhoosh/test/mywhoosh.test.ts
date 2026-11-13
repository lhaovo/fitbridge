import { describe, expect, it, vi, afterEach } from 'vitest';
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
