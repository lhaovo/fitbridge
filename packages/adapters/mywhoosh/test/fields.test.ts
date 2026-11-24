import { describe, expect, it } from 'vitest';
import { extractList } from '../src/activities.js';
import { MyWhooshAdapter } from '../src/index.js';
import { vi, afterEach } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('MyWhoosh 真实字段（2026-11 实测锁定）', () => {
  it('startDatetime 优先；date 是 unix 秒需要转换', async () => {
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/activities')) {
        return new Response(
          JSON.stringify({
            data: {
              results: [
                {
                  id: '6b014aafce0ddf62c2e024f0',
                  title: 'MyWhoosh - Noboru',
                  sportType: 'cycling',
                  routeName: 'Noboru',
                  distance: 36.91,
                  elevation: 787,
                  watt: 114,
                  heartrate: 146,
                  rideDuration: '02:35:30.000',
                  date: 1795237415,
                  startDatetime: '2026-11-21T05:03:35.000Z',
                  createdAt: '2026-11-21T07:39:27.004Z',
                  activityFileId: '6b014aa0da04b46b6409b785',
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const adapter = new MyWhooshAdapter();
    const page = await adapter.listActivities({
      id: 'c1',
      userId: 'u1',
      platformId: 'mywhoosh',
      secret: { accessToken: 't' },
      meta: { whooshId: 'w' },
    });

    const a = page.items[0]!;
    expect(a.name).toBe('MyWhoosh - Noboru');
    expect(a.startTime).toBe('2026-11-21T05:03:35.000Z');
    expect(a.distanceMeters).toBeCloseTo(36910, 0);
    expect(a.durationSec).toBe(2 * 3600 + 35 * 60 + 30);
    expect(a.avgHeartRate).toBe(146);
    expect(a.avgPower).toBe(114);
    // 文件 ID 必须在 raw 里（下载要用）
    expect((a.raw as { activityFileId: string }).activityFileId).toBe(
      '6b014aa0da04b46b6409b785',
    );
  });

  it('缺 startDatetime 时用 unix 秒的 date', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          data: { results: [{ id: 'x', date: 1795237415, activityFileId: 'f' }] },
        }),
        { status: 200 },
      ),
    );
    const adapter = new MyWhooshAdapter();
    const page = await adapter.listActivities({
      id: 'c1',
      userId: 'u1',
      platformId: 'mywhoosh',
      secret: { accessToken: 't' },
      meta: { whooshId: 'w' },
    });
    expect(page.items[0]!.startTime).toBe('2026-11-21T05:03:35.000Z');
    // 没标题时生成一个可读的名字（不能是 "cycling"）
    expect(page.items[0]!.name).toContain('MyWhoosh');
  });

  it('响应容器兼容仍有效', () => {
    expect(extractList({ data: { results: [{ id: 1 }] } })).toHaveLength(1);
  });
});
