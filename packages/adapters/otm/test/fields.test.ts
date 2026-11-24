import { describe, expect, it } from 'vitest';
import { parseLocalRidingTime } from '../src/activities.js';

describe('迈金真实字段解析（2026-11 实测锁定）', () => {
  it('start_riding_time（本地时间无时区）按 UTC+8 解释', () => {
    // 实测样本：2026-11-21 13:03:35 == 05:03:35Z
    expect(parseLocalRidingTime('2026-11-21 13:03:35')).toBe(
      '2026-11-21T05:03:35.000Z',
    );
  });

  it('带毫秒/带 T 的变体也能解析', () => {
    expect(parseLocalRidingTime('2026-11-21T13:03:35')).toBe(
      '2026-11-21T05:03:35.000Z',
    );
    expect(parseLocalRidingTime('2026-11-21 13:03:35.500')).toBe(
      '2026-11-21T05:03:35.500Z',
    );
  });

  it('无法解析时返回 undefined', () => {
    expect(parseLocalRidingTime(undefined)).toBeUndefined();
    expect(parseLocalRidingTime('not-a-date')).toBeUndefined();
  });
});
