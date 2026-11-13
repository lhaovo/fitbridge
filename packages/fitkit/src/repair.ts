/**
 * FIT 合规性扫描与修复（M1 实现，M0 留契约桩）。
 *
 * 需要覆盖的问题（来自参考项目 sports-data-sync-multiplatform 的已知问题）：
 * 1. 时间戳溢出 2^32 → Wahoo 解析失败
 * 2. 非法 ASCII 控制字符混入字符串字段 → MySQL 报错
 * 3. data_size 与实际数据不符 → CRC 校验失败
 * 4. 缺少 activity / session / lap 消息 → 严格平台（迈金/黑鸟）拒收
 */
export interface ComplianceIssue {
  code:
    | 'crc-invalid'
    | 'timestamp-overflow'
    | 'illegal-ascii'
    | 'data-size-mismatch'
    | 'missing-session'
    | 'missing-activity'
    | 'missing-lap'
    | 'empty-records';
  severity: 'error' | 'warning';
  message: string;
  /** 可自动修复的问题 */
  autoFixable: boolean;
}

export interface ComplianceReport {
  issues: ComplianceIssue[];
  /** 综合判定 */
  verdict: 'ok' | 'repairable' | 'rejected';
}

/** M1 实现 */
export function scanCompliance(_content: Buffer): ComplianceReport {
  throw new Error('scanCompliance 尚未实现（M1）。');
}

/** M1 实现 */
export function repairFit(
  _content: Buffer,
  _report: ComplianceReport,
): { content: Buffer; applied: string[] } {
  throw new Error('repairFit 尚未实现（M1）。');
}
