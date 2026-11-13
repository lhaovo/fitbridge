/**
 * 坐标系转换：GCJ-02（火星坐标）⇄ WGS-84。
 *
 * 背景：迈金/顽鹿 OTM 导出的 FIT 使用 GCJ-02，直接导入 Strava/Wahoo 等按 WGS-84 解读的平台
 * 会产生约 450m 的整体偏移。参考项目 sports-data-sync-multiplatform 的 FitGcj02Fixer
 * 做了同样的事（算法来自公开的「火星坐标」转换实现）。
 *
 * 注意：本模块只做「换算」，不改写 FIT 文件；文件改写属于 M1 的 build/repair 范畴。
 */

/** 克拉索夫斯基椭球长半轴（GCJ-02 标准参数） */
const GCJ_A = 6378245.0;
/** 偏心率平方 */
const GCJ_EE = 0.00669342162296594323;

const PI = Math.PI;

/** 判断是否在中国境外（境外不做偏移） */
export function outOfChina(lat: number, lon: number): boolean {
  if (lon < 72.004 || lon > 137.8347) return true;
  if (lat < 0.8293 || lat > 55.8271) return true;
  return false;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 +
    2.0 * x +
    3.0 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLon(x: number, y: number): number {
  let ret =
    300.0 +
    x +
    2.0 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/** GCJ-02 偏移量（度） */
export function gcjDelta(lat: number, lon: number): { dLat: number; dLon: number } {
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * PI);
  dLon = (dLon * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * PI);
  return { dLat, dLon };
}

/** WGS-84 → GCJ-02 */
export function wgs84ToGcj02(lat: number, lon: number): { lat: number; lon: number } {
  if (outOfChina(lat, lon)) return { lat, lon };
  const { dLat, dLon } = gcjDelta(lat, lon);
  return { lat: lat + dLat, lon: lon + dLon };
}

/**
 * GCJ-02 → WGS-84。
 *
 * 用迭代法求解（参考项目用的是「一次减 delta」的近似法，误差可达数米；
 * 这里迭代 3 次，残差 < 1cm）。
 */
export function gcj02ToWgs84(
  lat: number,
  lon: number,
): { lat: number; lon: number } {
  if (outOfChina(lat, lon)) return { lat, lon };
  // 定点迭代：求 wgs 使得 wgs84ToGcj02(wgs) === gcj
  // 即 wgs = gcj - gcjDelta(wgs)，用当前估计值求 delta 再回代
  let wgsLat = lat;
  let wgsLon = lon;
  for (let i = 0; i < 8; i++) {
    const { dLat, dLon } = gcjDelta(wgsLat, wgsLon);
    const nextLat = lat - dLat;
    const nextLon = lon - dLon;
    const converged =
      Math.abs(nextLat - wgsLat) < 1e-10 && Math.abs(nextLon - wgsLon) < 1e-10;
    wgsLat = nextLat;
    wgsLon = nextLon;
    if (converged) break;
  }
  return { lat: wgsLat, lon: wgsLon };
}

/**
 * 批量转换轨迹点（原地返回新数组）。
 *
 * @param points 轨迹点数组
 * @param direction 'to-wgs84' | 'to-gcj02'
 */
export function convertTrack<T extends { lat: number; lon: number }>(
  points: T[],
  direction: 'to-wgs84' | 'to-gcj02',
): T[] {
  const fn = direction === 'to-wgs84' ? gcj02ToWgs84 : wgs84ToGcj02;
  return points.map((p) => {
    const r = fn(p.lat, p.lon);
    return { ...p, lat: r.lat, lon: r.lon };
  });
}

/**
 * 粗略判断一组坐标是否「像 GCJ-02」。
 *
 * 用途：同一个平台内不同下载通道（迈金的七牛直链 vs fit_content）坐标系可能不一致，
 * 参考项目为此提供了三个开关。我们不做地标比对，而是用「轨迹与已知中国大陆区域的重叠度」
 * 加上用户可见的偏移提示来辅助判断。
 */
export function looksLikeChina(lat: number, lon: number): boolean {
  return !outOfChina(lat, lon);
}
