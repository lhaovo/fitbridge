import { describe, expect, it } from 'vitest';
import {
  convertTrack,
  gcj02ToWgs84,
  outOfChina,
  wgs84ToGcj02,
} from '../src/index.js';

describe('GCJ-02 / WGS-84 转换', () => {
  it('中国境内往返转换误差在厘米级', () => {
    const wgs = { lat: 39.90868, lon: 116.39749 }; // 北京天安门
    const gcj = wgs84ToGcj02(wgs.lat, wgs.lon);

    // GCJ-02 相对 WGS-84 在北京大约偏移 500m+（经纬度）
    expect(Math.abs(gcj.lat - wgs.lat)).toBeGreaterThan(0.001);
    expect(Math.abs(gcj.lon - wgs.lon)).toBeGreaterThan(0.001);

    const back = gcj02ToWgs84(gcj.lat, gcj.lon);
    expect(back.lat).toBeCloseTo(wgs.lat, 6);
    expect(back.lon).toBeCloseTo(wgs.lon, 6);
  });

  it('中国境外不做偏移', () => {
    const paris = { lat: 48.8566, lon: 2.3522 };
    const r = wgs84ToGcj02(paris.lat, paris.lon);
    expect(r.lat).toBe(paris.lat);
    expect(r.lon).toBe(paris.lon);
    expect(outOfChina(paris.lat, paris.lon)).toBe(true);
  });

  it('批量转换轨迹不修改入参', () => {
    const input = [{ lat: 31.2304, lon: 121.4737 }];
    const out = convertTrack(input, 'to-gcj02');
    expect(out[0]!.lat).not.toBe(input[0]!.lat);
    expect(input[0]!.lat).toBe(31.2304);
  });
});
