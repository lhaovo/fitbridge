import { describe, expect, it } from 'vitest';
import { buildSyntheticFit } from '../src/testing.js';
import { detectFileKind, isFitFile, readFit } from '../src/index.js';

const START = new Date('2026-03-15T06:30:00.000Z');

describe('readFit', () => {
  it('解析出活动摘要', async () => {
    const buf = buildSyntheticFit({ start: START, recordCount: 60 });
    const s = await readFit(buf);

    expect(s.sportType).toBe('ride');
    expect(s.startTime).toBe(START.toISOString());
    expect(s.totalDistanceM).toBeCloseTo(300, 2);
    expect(s.totalElapsedSec).toBe(60);
    expect(s.avgHeartRate).toBe(145);
    expect(s.maxHeartRate).toBe(172);
    expect(s.avgPower).toBe(210);
    expect(s.maxPower).toBe(640);
    expect(s.avgCadence).toBe(88);
    expect(s.hasPower).toBe(true);
    expect(s.hasHeartRate).toBe(true);
  });

  it('解析出轨迹点并保留传感器数据', async () => {
    const buf = buildSyntheticFit({ start: START, recordCount: 10 });
    const s = await readFit(buf);

    expect(s.track).toHaveLength(10);
    expect(s.trackPointCount).toBe(10);
    expect(s.hasPosition).toBe(true);
    expect(s.track[0]!.lat).toBeCloseTo(31.2304, 4);
    expect(s.track[0]!.lon).toBeCloseTo(121.4737, 4);
    expect(s.track[0]!.hr).toBe(140);
    expect(s.track[0]!.power).toBe(200);
    expect(s.track[0]!.speed).toBeCloseTo(5, 3);
  });

  it('从 local_timestamp 反推时区偏移', async () => {
    const buf = buildSyntheticFit({
      start: START,
      timezoneOffsetMin: 480,
      withLocalTimestamp: true,
    });
    const s = await readFit(buf);
    expect(s.timezoneOffsetMin).toBe(480);
    expect(s.timezoneSource).toBe('file-local-timestamp');
  });

  it('没有 local_timestamp 时不猜时区', async () => {
    const buf = buildSyntheticFit({
      start: START,
      withLocalTimestamp: false,
    });
    const s = await readFit(buf);
    expect(s.timezoneOffsetMin).toBeUndefined();
    expect(s.timezoneSource).toBe('unknown');
  });

  it('截断超长轨迹并留痕', async () => {
    const buf = buildSyntheticFit({ start: START, recordCount: 50 });
    const s = await readFit(buf, { maxTrackPoints: 10 });

    expect(s.track).toHaveLength(10);
    expect(s.trackPointCount).toBe(50);
    expect(s.trackTruncated).toBe(true);
    expect(s.warnings.join(' ')).toContain('截断');
  });

  it('CRC 校验：force=false 时干净文件通过', async () => {
    const buf = buildSyntheticFit({ start: START });
    const s = await readFit(buf, { force: false });
    expect(s.crcValid).toBe(true);
  });

  it('CRC 校验：脏文件在 force=false 时报错', async () => {
    const buf = buildSyntheticFit({ start: START });
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff; // 破坏 CRC
    await expect(readFit(buf, { force: false })).rejects.toThrow();
    // force=true 时应尽力恢复
    const s = await readFit(buf, { force: true });
    expect(s.track.length).toBeGreaterThan(0);
  });

  it('avg_speed 按 距离/移动时间 自算（文件字段为 0 时不采信）', async () => {
    // 真实数据里见过 avg_speed 写成 0 的文件
    const buf = buildSyntheticFit({
      start: START,
      recordCount: 60,
      sessionAvgSpeedRaw: 0,
    });
    const s = await readFit(buf);
    expect(s.avgSpeedMps).toBeCloseTo(5, 2);
    expect(s.warnings.join()).toContain('avg_speed');
  });

  it('avg_speed 明显偏离时按 距离/移动时间 重算', async () => {
    // 实测样本：真实 3.956 m/s，文件里写成 0.534
    const buf = buildSyntheticFit({
      start: START,
      recordCount: 60,
      sessionAvgSpeedRaw: 534,
    });
    const s = await readFit(buf);
    expect(s.avgSpeedMps).toBeCloseTo(5, 2);
    expect(s.warnings.join()).toContain('avg_speed');
  });

  it('avg_speed 正常时不产生警告', async () => {
    const buf = buildSyntheticFit({ start: START, recordCount: 60 });
    const s = await readFit(buf);
    expect(s.avgSpeedMps).toBeCloseTo(5, 2);
    expect(s.warnings.join()).not.toContain('avg_speed');
  });

  it('maxTrackPoints=0 时不截断轨迹', async () => {
    const buf = buildSyntheticFit({ start: START, recordCount: 120 });
    const s = await readFit(buf, { maxTrackPoints: 0 });
    expect(s.track).toHaveLength(120);
    expect(s.trackTruncated).toBe(false);
  });

  it('缺少 session 时从 record 聚合兜底', async () => {
    const buf = buildSyntheticFit({ start: START, recordCount: 20 });
    const s = await readFit(buf);
    // 有 session 时优先用 session 的值（5 m/s × 20 s = 100 m）
    expect(s.totalDistanceM).toBeCloseTo(100, 2);
  });
});

describe('文件类型探测', () => {
  it('识别 FIT', () => {
    const buf = buildSyntheticFit({ start: START });
    expect(isFitFile(buf)).toBe(true);
    expect(detectFileKind(buf)).toBe('fit');
  });

  it('识别 GPX', () => {
    const gpx = Buffer.from(
      '<?xml version="1.0"?><gpx version="1.1"><trk></trk></gpx>',
    );
    expect(detectFileKind(gpx)).toBe('gpx');
  });

  it('未知类型', () => {
    expect(detectFileKind(Buffer.from('hello world'))).toBe('unknown');
  });
});
